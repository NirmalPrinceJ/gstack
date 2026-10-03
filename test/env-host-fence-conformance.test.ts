/**
 * INV-3 render-level conformance for env-var hosts (C1, #1159).
 *
 * Codex and every `usesEnvVars` host run each fenced bash block in a fresh
 * shell, so a block that uses `$GSTACK_*`, `$B` or `$D` must resolve them
 * itself. Renders every host once into a temp dir and checks every fence of
 * every SKILL.md and section file; executes the shared prelude under `env -i`
 * and `set -u` against temp install layouts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ALL_HOST_CONFIGS } from '../hosts';
import { runGeneration } from '../scripts/gen-skill-docs';
import { binaryAssignment, fencePrelude, insertRuntimePreludes, PRELUDE_BYTE_BUDGET, runtimeRootPrelude } from '../scripts/resolvers/runtime-root';
import { HOST_PATHS, type TemplateContext } from '../scripts/resolvers/types';

const ENV_HOSTS = ALL_HOST_CONFIGS.filter(h => h.usesEnvVars);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-env-fences-'));
const renderDir = path.join(tmp, 'render');

interface Fence { file: string; line: number; body: string }

/** Top-level ```bash fences (CommonMark: a longer outer fence hides inner ones). */
function bashFences(text: string, file = ''): Fence[] {
  const lines = text.split('\n');
  const out: Fence[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].match(/^(\s*)(`{3,})(.*)$/);
    if (!open) continue;
    let end = i + 1;
    const close = new RegExp(`^\\s*\`{${open[2].length},}\\s*$`);
    while (end < lines.length && !close.test(lines[end])) end++;
    if (open[2].length === 3 && open[3].trim() === 'bash') {
      out.push({ file, line: i + 1, body: lines.slice(i + 1, end).map(l => l.startsWith(open[1]) ? l.slice(open[1].length) : l).join('\n') });
    }
    i = end;
  }
  return out;
}

function renderedDocs(root: string, hostSubdir: string | null): string[] {
  const base = hostSubdir ? path.join(root, hostSubdir, 'skills') : root;
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!hostSubdir && depth === 0 && (e.name.startsWith('.') || e.name === 'node_modules')) continue;
        walk(p, depth + 1);
      } else if (e.name === 'SKILL.md' || (e.name.endsWith('.md') && path.basename(dir) === 'sections')) out.push(p);
    }
  };
  walk(base, 0);
  return out;
}

const ctx = (host: string, installRoot: string | null = null): TemplateContext => ({ host, skillName: 'review', tmplPath: '', paths: HOST_PATHS[host], installRoot });

function sh(script: string, cwd: string, env: Record<string, string>) {
  return spawnSync('bash', ['-uc', script], { cwd, encoding: 'utf8', timeout: 10_000, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env } });
}
function mkroot(dir: string) {
  for (const sub of ['bin', 'lib', 'browse/dist', 'design/dist']) fs.mkdirSync(path.join(dir, sub), { recursive: true });
  return dir;
}

beforeAll(async () => {
  const result = await runGeneration({ host: 'all', outputRoot: renderDir });
  if (result.exitCode !== 0) throw new Error(result.diagnostics.filter(d => d.kind === 'error').map(d => d.message).join('\n'));
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('C1: every env-var host fence resolves its own runtime paths', () => {
  test('each fence that uses $GSTACK_*, $B or $D assigns them in the same fence, within the byte budget', () => {
    const problems: string[] = [];
    let checked = 0;
    for (const host of ENV_HOSTS) {
      for (const file of renderedDocs(renderDir, host.hostSubdir)) {
        for (const fence of bashFences(fs.readFileSync(file, 'utf8'), path.relative(renderDir, file))) {
          const usesRoot = /\$\{?GSTACK_(?:ROOT|BIN|BROWSE|DESIGN|MAKE_PDF)\b/.test(fence.body);
          const usesB = /\$\{?B\b/.test(fence.body);
          const usesD = /\$\{?D\b/.test(fence.body);
          if (!usesRoot && !usesB && !usesD) continue;
          checked++;
          const assigned = (name: string) => new RegExp(`(?:^|[\\s;&|(])${name}=`, 'm').test(fence.body);
          if (usesRoot && !assigned('GSTACK_ROOT')) problems.push(`${fence.file}:${fence.line} uses GSTACK_* without resolving GSTACK_ROOT`);
          if (usesB && !assigned('B')) problems.push(`${fence.file}:${fence.line} uses $B without deriving it`);
          if (usesD && !assigned('D')) problems.push(`${fence.file}:${fence.line} uses $D without deriving it`);
          if (fence.body.includes('gstack: no install found')) {
            const prelude = fence.body.split('\n').filter(l => /^\[ -d "\$\{GSTACK_ROOT:-\/-\}\/bin" \]|^(?:GSTACK_(?:BIN|BROWSE|DESIGN|MAKE_PDF)=\$GSTACK_ROOT\/\S+ ?)+$|^[BD]=\$GSTACK_ROOT\//.test(l));
            const bytes = Buffer.byteLength(prelude.join('\n') + '\n');
            if (bytes > PRELUDE_BYTE_BUDGET) problems.push(`${fence.file}:${fence.line} prelude is ${bytes} bytes (budget ${PRELUDE_BYTE_BUDGET})`);
            if (fence.body.split('gstack: no install found').length !== 2) problems.push(`${fence.file}:${fence.line} carries the prelude more than once`);
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(1000);
    expect(problems.slice(0, 40)).toEqual([]);
  });

  test('Claude output is untouched by the pass', () => {
    const claude = renderedDocs(renderDir, null);
    expect(claude.length).toBeGreaterThan(50);
    for (const file of claude) {
      const text = fs.readFileSync(file, 'utf8');
      expect(insertRuntimePreludes(text, ctx('claude'))).toBe(text);
      expect(text).not.toContain('gstack: no install found');
    }
    expect(runtimeRootPrelude(ctx('claude'))).toBe('');
  });

  test('a fence that already assigns GSTACK_ROOT gets no prelude; a $B-only fence derives B from the BROWSE SETUP helper', () => {
    expect(fencePrelude(ctx('codex'), 'GSTACK_ROOT=/x\n"$GSTACK_BIN/gstack-slug"')).toBe('');
    const b = fencePrelude(ctx('codex'), '$B goto https://example.com');
    expect(b.split('\n').at(-1)).toBe(binaryAssignment(ctx('codex'), 'browse'));
    expect(b).toContain('gstack: no install found');
    expect(fencePrelude(ctx('codex'), 'echo plain')).toBe('');
    expect(fencePrelude(ctx('codex'), 'B=x; $B goto y')).toBe('');
  });
});

describe('C1: the prelude resolves the right root in a fresh shell (env -i, set -u)', () => {
  const echo = '\necho "ROOT=$GSTACK_ROOT BIN=$GSTACK_BIN"';
  for (const host of ENV_HOSTS) {
    test(`${host.name}: exported, repo-local, global and missing roots`, () => {
      const w = fs.mkdtempSync(path.join(tmp, `${host.name}-`));
      const home = path.join(w, 'home');
      const prelude = runtimeRootPrelude(ctx(host.name));
      const global = mkroot(path.join(home, host.name === 'codex' ? '.codex/skills/gstack' : host.globalRoot));
      const repo = path.join(w, 'repo');
      fs.mkdirSync(repo);
      expect(spawnSync('git', ['init', '-q'], { cwd: repo, timeout: 10_000 }).status).toBe(0);
      const outside = fs.mkdtempSync(path.join(w, 'outside-'));

      let r = sh(prelude + echo, outside, { HOME: home });
      expect(r.stdout.trim(), r.stderr).toBe(`ROOT=${global} BIN=${global}/bin`);

      const local = mkroot(path.join(repo, host.localSkillRoot));
      r = sh(prelude + echo, repo, { HOME: home });
      expect(r.stdout.trim(), r.stderr).toBe(`ROOT=${local} BIN=${local}/bin`);

      const exported = mkroot(path.join(w, 'exported'));
      r = sh(prelude + echo, repo, { HOME: home, GSTACK_ROOT: exported });
      expect(r.stdout.trim(), r.stderr).toBe(`ROOT=${exported} BIN=${exported}/bin`);

      const noLib = path.join(w, 'nolib');
      fs.mkdirSync(path.join(noLib, 'bin'), { recursive: true });
      r = sh(prelude + echo, repo, { HOME: home, GSTACK_ROOT: noLib });
      expect(r.stdout.trim(), r.stderr).toBe(`ROOT=${local} BIN=${local}/bin`);

      if (host.name === 'codex') {
        const codexHome = mkroot(path.join(w, 'codex-home', 'skills', 'gstack'));
        r = sh(prelude + echo, outside, { HOME: home, CODEX_HOME: path.join(w, 'codex-home') });
        expect(r.stdout.trim(), r.stderr).toBe(`ROOT=${codexHome} BIN=${codexHome}/bin`);
      }

      r = sh(prelude + echo, outside, { HOME: path.join(w, 'empty-home') });
      expect(r.status).not.toBe(0);
      expect(r.stdout).not.toContain('ROOT=');
      expect(r.stderr).toContain('gstack: no install found (tried ');
      expect(r.stderr).toContain(`Fix: ./setup --host ${host.name} from your gstack checkout; ./setup --status shows it.`);
    });
  }

  test('a per-install render uses the literal root with no git call', () => {
    const w = fs.mkdtempSync(path.join(tmp, 'literal-'));
    const root = mkroot(path.join(w, 'install'));
    const stub = path.join(w, 'stub');
    fs.mkdirSync(stub);
    fs.writeFileSync(path.join(stub, 'git'), `#!/bin/sh\necho called >> "${path.join(w, 'git.log')}"\n`, { mode: 0o755 });
    const prelude = runtimeRootPrelude(ctx('codex', root));
    expect(prelude).not.toContain('git ');
    const r = sh(prelude + echo, w, { HOME: path.join(w, 'home'), PATH: `${stub}:/usr/bin:/bin` });
    expect(r.stdout.trim(), r.stderr).toBe(`ROOT=${root} BIN=${root}/bin`);
    expect(fs.existsSync(path.join(w, 'git.log'))).toBe(false);
    fs.rmSync(path.join(root, 'bin'), { recursive: true });
    const missing = sh(prelude + echo, w, { HOME: path.join(w, 'home'), PATH: `${stub}:/usr/bin:/bin` });
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain(`gstack: no install found (tried ${root})`);
  });
});
