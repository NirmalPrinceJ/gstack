/**
 * Free-suite home-write tripwire (#2895).
 *
 * Snapshots path + mtime + size of the gstack install and config surfaces under
 * the real home before and after each free shard, and names the shard's files
 * when one of those entries changed. It watches only these surfaces; it is not
 * a universal write-containment check. Live agent-session logs that a
 * concurrently running host keeps writing are excluded, and directory mtimes
 * are ignored, so only file, link and directory-set changes count. Concurrent
 * shards whose windows overlap a change all report it.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const FREE_HOME_SURFACES = ['.gstack', '.claude', '.codex', '.agents', '.config/gstack'] as const;

export const FREE_HOME_VOLATILE = [
  '.claude/projects', '.claude/todos', '.claude/shell-snapshots', '.claude/statsig', '.claude/ide',
  '.claude/session-env', '.claude/file-history', '.claude/debug', '.claude/telemetry', '.claude/history.jsonl',
  '.claude/.credentials.json', '.codex/sessions', '.codex/archived_sessions', '.codex/log', '.codex/history.jsonl',
  '.codex/auth.json',
] as const;

const MAX_DEPTH = 4;
const MAX_REPORTED = 10;

export type FreeHomeSnapshot = Map<string, string>;

export function freeHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.HOME || env.USERPROFILE || os.homedir();
}

export function snapshotFreeHome(home: string): FreeHomeSnapshot {
  const entries: FreeHomeSnapshot = new Map();
  const volatile = new Set<string>(FREE_HOME_VOLATILE);
  const visit = (relative: string, depth: number) => {
    if (volatile.has(relative)) return;
    const absolute = path.join(home, relative);
    let stat: fs.BigIntStats;
    try {
      stat = fs.lstatSync(absolute, { bigint: true });
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      entries.set(relative, `link:${fs.readlinkSync(absolute)}:${stat.mtimeNs}`);
      return;
    }
    if (!stat.isDirectory()) {
      entries.set(relative, `file:${stat.size}:${stat.mtimeNs}`);
      return;
    }
    entries.set(relative, 'dir');
    if (depth >= MAX_DEPTH) return;
    let names: string[];
    try {
      names = fs.readdirSync(absolute);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (['EACCES', 'EPERM'].includes(code)) entries.set(relative, 'dir:unreadable');
      if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(code)) return;
      throw error;
    }
    for (const name of names.sort()) visit(path.join(relative, name), depth + 1);
  };
  for (const surface of FREE_HOME_SURFACES) visit(path.normalize(surface), 0);
  return entries;
}

export function diffFreeHome(before: FreeHomeSnapshot, after: FreeHomeSnapshot): string[] {
  const changed = new Set<string>();
  for (const [entry, value] of before) if (after.get(entry) !== value) changed.add(entry);
  for (const entry of after.keys()) if (!before.has(entry)) changed.add(entry);
  return [...changed].sort();
}

export function formatFreeHomeChange(changed: string[], files: string[]): string {
  const shown = changed.slice(0, MAX_REPORTED).map(entry => `~/${entry.split(path.sep).join('/')}`);
  const more = changed.length > MAX_REPORTED ? ` (+${changed.length - MAX_REPORTED} more)` : '';
  return `real home changed while this shard ran (watches ${FREE_HOME_SURFACES.map(s => `~/${s}`).join(', ')} only): `
    + `${shown.join(', ')}${more}. Give the writer a private HOME/GSTACK_HOME. Shard files: ${files.join(', ')}`;
}

/** Take the baseline now; verify() returns null or the failure to report. */
export function guardFreeHome(files: string[], env: NodeJS.ProcessEnv = process.env): { verify(): string | null } {
  const home = freeHomeDir(env);
  const unreadable = (error: unknown) => `real home surfaces could not be snapshotted (${(error as NodeJS.ErrnoException).code ?? 'error'}); shard files: ${files.join(', ')}`;
  let before: FreeHomeSnapshot | undefined;
  let baselineError: string | undefined;
  try { before = snapshotFreeHome(home); } catch (error) { baselineError = unreadable(error); }
  return {
    verify() {
      if (!before) return baselineError!;
      try {
        const changed = diffFreeHome(before, snapshotFreeHome(home));
        return changed.length ? formatFreeHomeChange(changed, files) : null;
      } catch (error) { return unreadable(error); }
    },
  };
}
