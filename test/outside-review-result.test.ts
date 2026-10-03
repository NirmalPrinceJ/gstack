/**
 * INV-1 outside-review contract: classifyOutsideReview() separates execution,
 * findings and verdict; validateOutsideReview() and the two-argument CLI keep
 * their old shape for importers and installed skills that predate a re-render.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { classifyOutsideReview, validateOutsideReview, type OutsideGate } from '../lib/outside-review-result';

const ROOT = path.resolve(import.meta.dir, '..');
const LIB = path.join(ROOT, 'lib', 'outside-review-result.ts');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-review-result-'));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

let n = 0;
function file(content: string): string {
  const p = path.join(TMP, `f${n++}.txt`);
  fs.writeFileSync(p, content);
  return p;
}
function cli(args: string[]) {
  const r = spawnSync(process.execPath, [LIB, ...args], { encoding: 'utf8', timeout: 10000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const RECOMMEND = 'Recommendation: fix the guard because changed.ts loses data.';

describe('classifyOutsideReview: separate execution, findings and verdict', () => {
  const cases: Array<[string, { text: string; gate: OutsideGate; stderr?: string; exit?: number }, string, string | null, string | undefined]> = [
    ['clean review', { text: RECOMMEND, gate: 'review' }, 'clean', null, undefined],
    ['review with P1', { text: `[P1] data loss\n${RECOMMEND}`, gate: 'review' }, 'findings', 'P1', undefined],
    ['review with only P2', { text: `[P2] naming\n${RECOMMEND}`, gate: 'review' }, 'clean', 'P2', undefined],
    ['review missing recommendation', { text: 'A few observations.', gate: 'review' }, 'unavailable', null, 'missing_markers'],
    ['structured untagged prose', { text: 'The change looks reasonable overall.', gate: 'structured' }, 'unverified', null, 'untagged_review'],
    ['structured explicit clear', { text: 'NO_FINDINGS', gate: 'structured' }, 'clean', null, undefined],
    ['structured native P1 label', { text: 'P1: race in cleanup', gate: 'structured' }, 'findings', 'P1', undefined],
    ['spec passing score', { text: 'SCORE: 8\nAMBIGUITIES: NONE', gate: 'spec' }, 'clean', null, undefined],
    ['spec failing score', { text: 'SCORE: 4\nAMBIGUITIES: scope', gate: 'spec' }, 'findings', null, undefined],
    ['nonzero exit', { text: RECOMMEND, gate: 'review', exit: 1, stderr: '\nerror: 401 Unauthorized\n' }, 'unavailable', null, 'execution_failed'],
    ['timeout', { text: 'Partial', gate: 'review', exit: 124 }, 'unavailable', null, 'timeout'],
    ['empty', { text: ' \n', gate: 'structured' }, 'unavailable', null, 'empty_response'],
    ['refusal', { text: `I cannot review this request. ${RECOMMEND}`, gate: 'review' }, 'unavailable', null, 'review_refused'],
    ['consult answer without review markers', { text: 'Use a queue here; the writer pool blocks.', gate: 'execution', stderr: '' }, 'clean', null, undefined],
  ];
  for (const [label, input, verdict, highest, reason] of cases) {
    test(label, () => {
      const result = classifyOutsideReview(input);
      expect(result.verdict).toBe(verdict as any);
      expect(result.findings.highest).toBe(highest as any);
      expect(result.reason).toBe(reason as any);
      expect(result.execution.state).toBe(['execution_failed', 'timeout', 'empty_response', 'review_refused'].includes(reason ?? '') ? 'unavailable' : 'ran');
    });
  }

  test('a non-zero exit names the exit code and the first stderr line', () => {
    const result = classifyOutsideReview({ text: '', gate: 'review', exit: 1, stderr: '\nerror: 401 Unauthorized\nmore' });
    expect(result.detail).toBe('exit 1: error: 401 Unauthorized');
  });
});

describe('validateOutsideReview keeps the text-only shape for direct importers', () => {
  test('existing shapes are unchanged', () => {
    expect(validateOutsideReview('', 'review')).toEqual({ completed: false, reason: 'empty response' });
    expect(validateOutsideReview('I must refuse.', 'review')).toEqual({ completed: false, reason: 'review refused' });
    expect(validateOutsideReview('notes', 'review')).toEqual({ completed: false, reason: 'missing review completion recommendation' });
    expect(validateOutsideReview('notes', 'structured')).toEqual({ completed: false, reason: 'missing severity or explicit no-findings conclusion' });
    expect(validateOutsideReview('SCORE: 8', 'spec')).toEqual({ completed: false, reason: 'missing or invalid SCORE/AMBIGUITIES markers' });
    expect(validateOutsideReview('SCORE: 6\nAMBIGUITIES: NONE', 'spec')).toEqual({ completed: true, score: 6, gate: 'fail' });
    expect(validateOutsideReview(RECOMMEND, 'review')).toEqual({ completed: true });
    expect(validateOutsideReview('[P2] nit', 'structured')).toEqual({ completed: true, gate: 'pass' });
    expect(validateOutsideReview('[P1] bug', 'structured')).toEqual({ completed: true, gate: 'fail' });
  });
});

describe('outside-review-result CLI', () => {
  test('two-argument form keeps exit 0 completed / 1 unavailable / 2 usage, findings included', () => {
    expect(cli(['structured', file('[P1] data loss')]).status).toBe(0);
    expect(cli(['review', file(`[P0] data loss\n${RECOMMEND}`)]).status).toBe(0);
    const untagged = cli(['structured', file('looks fine')]);
    expect(untagged.status).toBe(1);
    expect(untagged.stderr).toBe('Outside review unavailable: missing severity or explicit no-findings conclusion; missing coverage.\n');
    expect(cli(['structured', path.join(TMP, 'missing-file')]).status).toBe(1);
    expect(cli(['bogus', file('x')]).status).toBe(2);
    expect(cli(['execution', file('x')]).status).toBe(2);
    expect(cli(['review']).status).toBe(2);
    // No VERDICT line: stale callers only read the status.
    expect(cli(['structured', file('[P1] data loss')]).stdout).toBe('');
  });

  test('verdict form prints VERDICT and exits 0 clean / 3 findings / 4 unverified / 1 unavailable', () => {
    const clean = cli(['--verdict', 'review', file(RECOMMEND)]);
    expect([clean.status, clean.stdout]).toEqual([0, 'VERDICT: clean\nFINDINGS: none\n']);
    const findings = cli(['--verdict', 'structured', file('[P0] corrupts data')]);
    expect([findings.status, findings.stdout]).toEqual([3, 'VERDICT: findings\nFINDINGS: P0\n']);
    const unverified = cli(['--verdict', 'structured', file('looks fine')]);
    expect(unverified.status).toBe(4);
    expect(unverified.stdout).toContain('VERDICT: unverified\n');
    expect(unverified.stderr).toContain('Outside review: ran, verdict unverified');
    const unavailable = cli(['--verdict', '--label', 'Codex outside review', 'review', file('')]);
    expect(unavailable.status).toBe(1);
    expect(unavailable.stdout).toContain('VERDICT: unavailable\nFINDINGS: none\nREASON: empty_response\n');
    expect(unavailable.stderr).toMatch(/^Codex outside review unavailable: the reviewer returned no response\. .*Fix: /);
  });

  test('--stderr and --exit imply the verdict form; a missing stderr file reads as empty', () => {
    const failed = cli(['--exit', '7', '--stderr', file('fatal: provider exploded\n'), 'review', file(RECOMMEND)]);
    expect(failed.status).toBe(1);
    expect(failed.stdout).toContain('REASON: execution_failed');
    expect(failed.stderr).toContain('(exit 7: fatal: provider exploded)');
    const missing = cli(['--stderr', path.join(TMP, 'never-written'), 'review', file(RECOMMEND)]);
    expect([missing.status, missing.stdout]).toEqual([0, 'VERDICT: clean\nFINDINGS: none\n']);
    expect(cli(['--exit', 'x', 'review', file(RECOMMEND)]).status).toBe(2);
  });

  test('an old rendered caller (pre-verdict skill text) still records findings as completed', () => {
    // The tail every generated outside-review fence carried before the verdict
    // form; bin/ and lib/ run live from the checkout, rendered text may lag.
    const response = file('[P1] Seeded data-loss bug\nREVIEW_COMPLETE');
    const old = `bun "$LIB" structured "$RESPONSE" || exit 1\necho 'OUTSIDE_STATUS: completed provider=codex host=claude'`;
    const r = spawnSync('bash', ['-c', old], { encoding: 'utf8', timeout: 10000,
      env: { ...process.env, LIB, RESPONSE: response } });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('OUTSIDE_STATUS: completed provider=codex host=claude\n');
  });
});
