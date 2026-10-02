/**
 * Host conformance kit (docs/ADDING_A_HOST.md "Certify your host").
 *
 * Runs the real ./setup into a clean temp HOME for every installable host in
 * hosts/index.ts and checks the install contract: the host's discovery
 * directory gets its skills, no other host's directory is created or changed,
 * no skill name is duplicated, the registry row is published, and
 * ./setup --status reports it. Upgrade cases start from the previous
 * release's on-disk layout (the same links, no registry, the marker in
 * ~/.gstack) and from a project-vendored copy that captured the global Codex
 * namespace (#2879). Instruction-only hosts must change nothing.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ALL_HOST_CONFIGS } from '../hosts/index';
import { cleanupFixtures, makeFixture, makeSource, put, registryRows, runSetup, setVersion, tree } from './helpers/install-fixture';

afterEach(cleanupFixtures);

/** Skills directory each installable host discovers (global scope). */
const DISCOVERY: Record<string, string> = {
  claude: '.claude/skills',
  codex: '.codex/skills',
  kiro: '.kiro/skills',
  factory: '.factory/skills',
  opencode: '.config/opencode/skills',
  cursor: '.cursor/skills',
  copilot: '.copilot/skills',
};
/** Every directory any host (or a shared agents layout) reads. */
const ALL_DISCOVERY_DIRS = [...Object.values(DISCOVERY), '.agents/skills', '.copilot/skills', '.hermes/skills'];

const installable = ALL_HOST_CONFIGS.filter(c => c.tier !== 'instruction-only').map(c => c.name);
const instructionOnly = ALL_HOST_CONFIGS.filter(c => c.tier === 'instruction-only').map(c => c.name);

function skillNames(dir: string): string[] {
  const names: string[] = [];
  for (const entry of readdirSync(dir)) {
    const md = join(dir, entry, 'SKILL.md');
    if (!existsSync(md)) continue;
    const m = readFileSync(md, 'utf8').match(/^name:\s*(\S+)/m);
    if (m) names.push(m[1]);
  }
  return names;
}

describe.skipIf(process.platform === 'win32')('host conformance kit', () => {
  test('the kit covers every installable host', () => {
    expect(Object.keys(DISCOVERY).sort()).toEqual([...installable].sort());
  });

  for (const host of installable) {
    test(`${host}: installs only into its own discovery directory, registers, and reports`, () => {
      const f = makeFixture();
      const src = makeSource(f, join(f.dir, 'gstack'));
      const r = runSetup(f, join(src, 'setup'), ['--host', host]);
      expect(r.status, r.stdout + r.stderr).toBe(0);

      const dest = join(f.home, DISCOVERY[host]);
      const names = skillNames(dest);
      expect(names.length, `${host} skills in ${dest}`).toBeGreaterThan(20);
      expect(new Set(names).size, `duplicate skill names in ${dest}`).toBe(names.length);
      for (const other of ALL_DISCOVERY_DIRS.filter(d => d !== DISCOVERY[host])) {
        expect(existsSync(join(f.home, other)), `${host} install created ${other}`).toBe(false);
      }
      if (host !== 'claude') {
        for (const name of readdirSync(dest).filter(n => n.startsWith('gstack-'))) {
          const md = join(dest, name, 'SKILL.md');
          if (existsSync(md)) expect(readFileSync(md, 'utf8'), `${host}/${name} carries Claude paths`).not.toContain('~/.claude/skills/gstack');
        }
      }
      const rows = registryRows(f);
      expect(rows.map(row => [row[0], row[1], row[3], row[5], row[6]])).toEqual([[host, 'global', dest, realpathSync(src), readFileSync(join(src, 'VERSION'), 'utf8').trim()]]);
      expect(r.stdout + r.stderr).toMatch(new RegExp(`Install summary:[\\s\\S]*\\b${host}\\s+\\S+\\s+global\\s+installed`));

      const status = runSetup(f, join(src, 'setup'), ['--status']);
      expect(status.status).toBe(0);
      expect(status.stdout).toMatch(new RegExp(`\\b${host}\\s+${ALL_HOST_CONFIGS.find(c => c.name === host)!.tier}\\s+global\\s+current`));
    }, 60_000);
  }

  test('opencode: every skill gets a managed /gstack-* command on the build agent; user commands survive (#2629)', () => {
    const f = makeFixture();
    const src = makeSource(f, join(f.dir, 'gstack'));
    const commands = join(f.home, '.config/opencode/commands');
    put(join(commands, 'gstack-review.md'), 'my own review command\n');
    put(join(commands, 'gstack-retired.md'), '---\n---\n<!-- gstack-managed command (./setup --host opencode): edits are overwritten -->\nold\n');
    expect(runSetup(f, join(src, 'setup'), ['--host', 'opencode']).status).toBe(0);
    const ship = readFileSync(join(commands, 'gstack-ship.md'), 'utf8');
    expect(ship).toMatch(/^---\ndescription: "[^"]+"\nagent: build\nsubtask: false\n---\n/);
    expect(ship).toContain('Load the `gstack-ship` skill with the skill tool');
    expect(ship).toContain('$ARGUMENTS');
    expect(readFileSync(join(commands, 'gstack-review.md'), 'utf8')).toBe('my own review command\n');
    expect(existsSync(join(commands, 'gstack-retired.md'))).toBe(false);
    const un = Bun.spawnSync(['bash', join(src, 'bin/gstack-uninstall'), '--force', '--keep-state'], { cwd: f.home, env: f.env, timeout: 30_000 });
    expect(un.exitCode).toBe(0);
    expect(readdirSync(commands)).toEqual(['gstack-review.md']);
  }, 60_000);

  test.each(instructionOnly)('%s (instruction-only): truthful instructions, nothing written', (host) => {
    const f = makeFixture();
    const src = makeSource(f, join(f.dir, 'gstack'));
    const before = tree(f.home);
    const r = runSetup(f, join(src, 'setup'), ['--host', host]);
    expect(r.status).toBe(0);
    expect(tree(f.home)).toEqual(before);
    expect(r.stdout).not.toMatch(/gstack ready|Install summary/);
  }, 30_000);

  test('--status is read-only and lists unregistered installs from before the registry', () => {
    const f = makeFixture();
    const src = makeSource(f, join(f.dir, 'gstack'));
    expect(runSetup(f, join(src, 'setup'), ['--host', 'codex']).status).toBe(0);
    rmSync(join(f.home, '.gstack/installs.tsv'));
    const before = tree(f.dir);
    const status = runSetup(f, join(src, 'setup'), ['--status']);
    expect(status.status).toBe(0);
    expect(tree(f.dir)).toEqual(before);
    expect(status.stdout).toMatch(/codex\s+experimental\s+global\s+unregistered/);
    expect(status.stdout).toContain(`register it: cd ${realpathSync(src)} && ./setup --host codex`);
  }, 60_000);

  test('upgrade from the previous release layout refreshes every installed host (#1925)', () => {
    const f = makeFixture();
    const src = makeSource(f, join(f.home, '.claude/skills/gstack'), '1.91.12.0');
    for (const host of ['claude', 'codex']) expect(runSetup(f, join(src, 'setup'), ['--host', host]).status).toBe(0);
    // v1.91.13.0 and earlier: same links, no registry, marker in ~/.gstack.
    rmSync(join(f.home, '.gstack/installs.tsv'));
    setVersion(src, '1.91.14.0');

    const oldUpgrade = runSetup(f, join(src, 'setup'), []);
    expect(oldUpgrade.status).toBe(0);
    expect(registryRows(f).map(r => r[0])).toEqual(['claude']);

    const upgrade = runSetup(f, join(src, 'setup'), ['--refresh-registered']);
    expect(upgrade.status, upgrade.stdout + upgrade.stderr).toBe(0);
    expect(upgrade.stdout).toContain(`Refreshing registered gstack installs from source: ${realpathSync(src)}`);
    expect(upgrade.stdout).toMatch(/Upgrade summary:\n[\s\S]*claude\s+full\s+global\s+unchanged\s+1\.91\.14\.0[\s\S]*codex\s+experimental\s+global\s+installed\s+1\.91\.14\.0/);
    expect(registryRows(f).map(r => [r[0], r[6]]).sort()).toEqual([['claude', '1.91.14.0'], ['codex', '1.91.14.0']]);
    // The refreshed Codex install runs the new checkout's render.
    expect(realpathSync(join(f.home, '.codex/skills/gstack-review/SKILL.md'))).toBe(join(realpathSync(src), '.agents/skills/gstack-review/SKILL.md'));
  }, 90_000);

  test('a Codex namespace captured by a vendored project copy is reported, never repointed (#2879)', () => {
    const f = makeFixture();
    const global = makeSource(f, join(f.home, '.claude/skills/gstack'));
    const project = join(f.dir, 'proj');
    mkdirSync(join(project, '.git'), { recursive: true });
    const vendored = makeSource(f, join(project, '.claude/skills/gstack'), '1.80.0.0');
    // Pre-fix capture: the vendored copy registered itself globally.
    expect(runSetup(f, join(vendored, 'setup'), ['--host', 'codex', '--global']).status).toBe(0);
    rmSync(join(f.home, '.gstack/installs.tsv'));
    const codexBefore = tree(join(f.home, '.codex'));

    const status = runSetup(f, join(global, 'setup'), ['--status']);
    expect(status.stdout).toContain(`captured by the project-vendored copy at ${realpathSync(vendored)} (#2879)`);
    const upgrade = runSetup(f, join(global, 'setup'), ['--refresh-registered']);
    expect(upgrade.status, upgrade.stdout + upgrade.stderr).toBe(0);
    expect(upgrade.stdout).toMatch(/codex\s+experimental\s+global\s+skipped/);
    expect(upgrade.stdout).toContain('choose: refresh it there');
    expect(tree(join(f.home, '.codex'))).toEqual(codexBefore);
  }, 90_000);

  test('a host that fails mid-upgrade keeps its last install and gets a retry command', () => {
    const f = makeFixture();
    const src = makeSource(f, join(f.home, '.claude/skills/gstack'), '1.91.12.0');
    for (const host of ['claude', 'codex']) expect(runSetup(f, join(src, 'setup'), ['--host', host]).status).toBe(0);
    setVersion(src, '1.91.14.0');
    const codexBefore = tree(join(f.home, '.codex'));
    // Break only the Codex arm: its skills directory refuses writes.
    chmodSync(join(f.home, '.codex/skills'), 0o555);
    let upgrade;
    try {
      upgrade = runSetup(f, join(src, 'setup'), ['--refresh-registered']);
    } finally {
      chmodSync(join(f.home, '.codex/skills'), 0o755);
    }
    expect(upgrade.status).toBe(1);
    expect(upgrade.stdout).toContain('NOT every install was refreshed');
    expect(upgrade.stdout).toMatch(/claude\s+full\s+global\s+updated\s+1\.91\.12\.0 -> 1\.91\.14\.0/);
    expect(upgrade.stdout).toMatch(/codex\s+experimental\s+global\s+failed/);
    expect(upgrade.stdout).toContain(`Retry: cd ${realpathSync(src)} && ./setup --host codex`);
    expect(tree(join(f.home, '.codex'))).toEqual(codexBefore);
    expect(registryRows(f).find(r => r[0] === 'codex')![6]).toBe('1.91.12.0');
  }, 90_000);

  test('first run from the published instructions ends in a skill that starts', () => {
    const f = makeFixture();
    // README: git clone … ~/.claude/skills/gstack && cd ~/.claude/skills/gstack && ./setup
    const src = makeSource(f, join(f.home, '.claude/skills/gstack'));
    const r = runSetup(f, join(src, 'setup'), [], { cwd: src });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('Chromium install skipped by request');
    const skill = readFileSync(join(f.home, '.claude/skills/office-hours/SKILL.md'), 'utf8');
    const fence = skill.slice(skill.indexOf('## Preamble')).match(/```bash\n([\s\S]*?)\n```/)![1];
    const work = join(f.dir, 'repo');
    mkdirSync(work);
    const start = Bun.spawnSync(['bash', '-c', fence], { cwd: work, env: { ...f.env }, timeout: 30_000 });
    const out = start.stdout.toString();
    expect(out, start.stderr.toString()).toContain('SKILL_START_PROTO: 1');
    expect(out).not.toContain('SKILL_START: unavailable');
    expect(readdirSync(work)).toEqual([]);
  }, 90_000);
});
