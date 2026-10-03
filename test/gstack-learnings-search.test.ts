import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync, spawnSync } from 'child_process';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin', 'gstack-learnings-search');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-search-test-'));
const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-search-cwd-'));
// gstack-slug derives slug from git remote (none here) → falls back to basename of cwd.
const slug = path.basename(tmpCwd).replace(/[^a-zA-Z0-9._-]/g, '');
const projDir = path.join(tmpHome, 'projects', slug);
const otherProjDir = path.join(tmpHome, 'projects', 'other-project');

function run(args: string[]): string {
  return execFileSync(BIN, args, {
    timeout: 30_000,
    env: { ...process.env, GSTACK_HOME: tmpHome },
    cwd: tmpCwd,
    encoding: 'utf-8',
  });
}

beforeAll(() => {
  fs.mkdirSync(projDir, { recursive: true });
  fs.mkdirSync(otherProjDir, { recursive: true });
  const entries = [
    { ts: '2026-05-01T00:00:00Z', skill: 'test', type: 'pattern', key: 'foo-pattern', insight: 'A foo-related insight', confidence: 8, source: 'observed', trusted: false, files: [] },
    { ts: '2026-05-02T00:00:00Z', skill: 'test', type: 'pitfall', key: 'bar-pitfall', insight: 'A bar-related insight', confidence: 8, source: 'observed', trusted: false, files: [] },
    { ts: '2026-05-03T00:00:00Z', skill: 'test', type: 'pattern', key: 'baz-pattern', insight: 'A baz-related insight', confidence: 8, source: 'observed', trusted: false, files: [] },
  ];
  const otherEntries = [
    { ts: '2026-05-04T00:00:00Z', skill: 'test', type: 'pattern', key: 'foreign-observed', insight: 'A foreign observed insight', confidence: 8, source: 'observed', trusted: false, files: [] },
    { ts: '2026-05-05T00:00:00Z', skill: 'test', type: 'pattern', key: 'foreign-user', insight: 'A foreign user-stated insight', confidence: 8, source: 'user-stated', trusted: true, files: [] },
    // #1745: legacy row with NO `trusted` field at all (written before the field
    // existed). The old `=== false` denylist admitted these; the allowlist must exclude.
    { ts: '2026-05-06T00:00:00Z', skill: 'test', type: 'pattern', key: 'foreign-legacy', insight: 'A foreign legacy insight with no trusted field', confidence: 8, source: 'observed', files: [] },
  ];
  fs.writeFileSync(path.join(projDir, 'learnings.jsonl'), entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  fs.writeFileSync(path.join(otherProjDir, 'learnings.jsonl'), otherEntries.map(e => JSON.stringify(e)).join('\n') + '\n');
});

afterAll(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpCwd, { recursive: true, force: true });
});

describe('gstack-learnings-search token-OR query semantics', () => {
  test('multi-token query returns entries matching ANY token', () => {
    const out = run(['--query', 'foo bar']);
    expect(out).toContain('foo-pattern');
    expect(out).toContain('bar-pitfall');
    expect(out).not.toContain('baz-pattern');
  });

  test('single-token query returns only entries matching that token', () => {
    const out = run(['--query', 'foo']);
    expect(out).toContain('foo-pattern');
    expect(out).not.toContain('bar-pitfall');
    expect(out).not.toContain('baz-pattern');
  });

  test('no --query flag returns all entries (backwards-compat)', () => {
    const out = run(['--limit', '10']);
    expect(out).toContain('foo-pattern');
    expect(out).toContain('bar-pitfall');
    expect(out).toContain('baz-pattern');
  });
});

describe('gstack-learnings-search cross-project trust gating', () => {
  test('cross-project mode still includes observed entries from the current project', () => {
    const out = run(['--cross-project', '--query', 'foo']);
    expect(out).toContain('foo-pattern');
    expect(out).not.toContain('[cross-project]');
  });

  test('cross-project mode only imports trusted entries from other projects', () => {
    const out = run(['--cross-project', '--query', 'foreign']);
    expect(out).toContain('foreign-user');
    expect(out).toContain('[cross-project]');
    expect(out).not.toContain('foreign-observed');
  });

  // #1745: the gate is an allowlist, not a denylist. A cross-project row with no
  // `trusted` field (legacy / hand-edited / other-tool) must NOT be imported.
  test('cross-project mode excludes foreign rows missing the trusted field (#1745)', () => {
    const out = run(['--cross-project', '--query', 'foreign']);
    expect(out).not.toContain('foreign-legacy');
  });
});

// B5 (#2790): both query scripts ended in `2>/dev/null || exit 0`, so a
// missing bun or a crashed embedded script printed nothing and exited 0,
// exactly like "nothing recorded".
describe('B5: query scripts never report a failed read as an empty result', () => {
  const TOOLS = ['bash', 'sh', 'env', 'dirname', 'basename', 'git', 'tr', 'sed', 'cat', 'head', 'tail', 'grep', 'find',
    'ls', 'mkdir', 'mktemp', 'mv', 'rm', 'cp', 'awk', 'wc', 'sort', 'uname', 'date', 'cut', 'readlink', 'realpath', 'stat', 'touch', 'id', 'printf'];
  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-nobun-'));
  const failDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-failbun-'));
  for (const tool of TOOLS) {
    const r = spawnSync('bash', ['-c', `command -v ${tool}`], { encoding: 'utf-8', timeout: 5000 });
    const where = (r.stdout || '').trim();
    if (where.startsWith('/')) fs.symlinkSync(where, path.join(shimDir, tool));
  }
  fs.writeFileSync(path.join(failDir, 'bun'), '#!/bin/sh\necho "embedded script exploded" >&2\nexit 3\n', { mode: 0o755 });
  const timelineDir = path.join(tmpHome, 'projects', slug);
  afterAll(() => {
    fs.rmSync(shimDir, { recursive: true, force: true });
    fs.rmSync(failDir, { recursive: true, force: true });
  });

  function runWith(script: string, pathValue: string, args: string[] = []) {
    return spawnSync('bash', [path.join(ROOT, 'bin', script), ...args], {
      timeout: 30_000, env: { ...process.env, GSTACK_HOME: tmpHome, PATH: pathValue }, cwd: tmpCwd, encoding: 'utf-8',
    });
  }

  for (const script of ['gstack-learnings-search', 'gstack-timeline-read']) {
    test(`${script}: bun missing exits 127 with the fix line`, () => {
      fs.writeFileSync(path.join(timelineDir, 'timeline.jsonl'), JSON.stringify({ ts: '2026-05-01T00:00:00Z', skill: 'ship', event: 'started', branch: 'main' }) + '\n');
      const r = runWith(script, shimDir);
      expect(r.status).toBe(127);
      expect(r.stdout).toBe('');
      expect(r.stderr).toContain(`${script}: bun not found on PATH`);
      expect(r.stderr).toContain('Fix: install Bun (https://bun.sh), then re-run ./setup.');
    });

    test(`${script}: a failing embedded script exits non-zero and keeps its stderr`, () => {
      const r = runWith(script, `${failDir}:${process.env.PATH}`);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('embedded script exploded');
    });
  }

  test('a successful search with no matches still exits 0 with empty output', () => {
    const r = runWith('gstack-learnings-search', process.env.PATH!, ['--query', 'zzz-no-such-token']);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });
});
