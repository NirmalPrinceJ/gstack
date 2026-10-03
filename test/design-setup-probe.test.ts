/**
 * F3: the rendered taste-profile fence, executed with stub binaries.
 * The taste-profile probe double-quoted `~/.claude/...`, so it never found
 * gstack-slug and always printed NO_TASTE_PROFILE; a failed slug lookup is now
 * reported as TASTE_PROFILE_UNAVAILABLE instead of "no profile".
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runGeneration } from '../scripts/gen-skill-docs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-design-probe-'));
const out = path.join(tmp, 'render');
const HOSTS = [{ name: 'claude', dir: (s: string) => path.join(out, s), root: '.claude/skills/gstack' },
  { name: 'codex', dir: (s: string) => path.join(out, '.agents', 'skills', `gstack-${s}`), root: '.codex/skills/gstack' }];

function fenceAfter(file: string, heading: string): string {
  const text = fs.readFileSync(file, 'utf8');
  return text.slice(text.indexOf(heading)).match(/```bash\n([\s\S]*?)\n```/)![1];
}

/** A HOME with a gstack install whose design binary runs `body`. */
function world(root: string, body: string | null) {
  const home = fs.mkdtempSync(path.join(tmp, 'home-'));
  const install = path.join(home, root);
  const state = path.join(home, 'state');
  for (const dir of ['bin', 'lib', 'design/dist']) fs.mkdirSync(path.join(install, dir), { recursive: true });
  fs.mkdirSync(state);
  fs.writeFileSync(path.join(install, 'bin', 'gstack-paths'), `#!/bin/sh\necho "${state}"\n`, { mode: 0o755 });
  if (body !== null) fs.writeFileSync(path.join(install, 'design/dist/design'), `#!/bin/sh\necho launched >> "${home}/launches"\n${body}\n`, { mode: 0o755 });
  const cwd = fs.mkdtempSync(path.join(tmp, 'cwd-'));
  return { home, install, state, cwd, launches: () => (fs.existsSync(path.join(home, 'launches')) ? fs.readFileSync(path.join(home, 'launches'), 'utf8').split('\n').filter(Boolean).length : 0) };
}

function run(script: string, w: { home: string; cwd: string }, PATH = '/usr/bin:/bin') {
  return spawnSync('env', ['-i', `HOME=${w.home}`, `PATH=${PATH}`, 'bash', '-c', script], { cwd: w.cwd, encoding: 'utf8', timeout: 30_000 });
}

beforeAll(async () => {
  const r = await runGeneration({ host: 'all', outputRoot: out });
  if (r.exitCode !== 0) throw new Error(r.diagnostics.filter(d => d.kind === 'error').map(d => d.message).join('\n'));
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('F3: the taste profile loads, and a failed slug lookup is not "no profile"', () => {
  for (const skill of ['design-shotgun', 'design-consultation']) {
    for (const host of HOSTS) {
      test(`${host.name} ${skill}`, () => {
        const w = world(host.root, 'exit 0');
        const fence = fenceAfter(path.join(host.dir(skill), 'SKILL.md'), "Read this project's taste profile:");
        fs.mkdirSync(path.join(w.state, 'projects', 'acme'), { recursive: true });
        fs.writeFileSync(path.join(w.state, 'projects', 'acme', 'taste-profile.json'), '{"dimensions":{}}');
        fs.writeFileSync(path.join(w.install, 'bin', 'gstack-slug'), '#!/bin/sh\necho acme\n', { mode: 0o755 });
        const found = run(fence, w);
        expect(found.stdout, found.stderr).toContain('TASTE_PROFILE_FOUND');
        expect(found.stdout).toContain('{"dimensions":{}}');

        fs.writeFileSync(path.join(w.install, 'bin', 'gstack-slug'), '#!/bin/sh\necho "gstack-slug: cannot read state" >&2\nexit 1\n');
        const failed = run(fence, w);
        expect(failed.stdout.trim()).toBe('TASTE_PROFILE_UNAVAILABLE: could not resolve the project slug (gstack-slug failed). Fix: run ./setup.');
        expect(failed.stderr).toContain('gstack-slug: cannot read state');
      });
    }
  }
});
