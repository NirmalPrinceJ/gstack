import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { assertNoPlanFileDecisions, seededPlanTargeted } from './helpers/plan-mode-evidence';
import { planFileHasDecisionsSection } from './helpers/claude-pty-runner';
import type { PlanSkillObservation } from './helpers/claude-pty-runner';

const TOKENS = ['ShardManager', 'ResultMerger'];
const base = { outcome: 'asked', summary: '', evidence: '', elapsedMs: 1 } as unknown as PlanSkillObservation;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-mode-targeting-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
const plan = (name: string, body: string) => { const file = path.join(dir, name); fs.writeFileSync(file, body); return file; };

describe('seeded plan targeting', () => {
  test.each([
    ['exact announcement observed', { scopeGateAutoSelectObserved: true }],
    ['paraphrased announcement with seed content in the review', { scopeGateAutoSelectObserved: false, tokensObserved: { ShardManager: true, ResultMerger: false } }],
  ])('known-good: %s', (_name, fields) => {
    expect(seededPlanTargeted({ ...base, ...fields } as PlanSkillObservation, TOKENS)).toBe(true);
  });
  test.each([
    ['no announcement and no seed content', { scopeGateAutoSelectObserved: false, tokensObserved: { ShardManager: false, ResultMerger: false } }],
    ['an untracked token cannot stand in for the seed', { scopeGateAutoSelectObserved: false, tokensObserved: { 'draft-plan': true } }],
  ])('known-bad: %s', (_name, fields) => {
    expect(seededPlanTargeted({ ...base, ...fields } as PlanSkillObservation, TOKENS)).toBe(false);
  });
});

describe('plan-file decision substitute', () => {
  test('a plan_ready plan file with ## Decisions fails', () => {
    const planFile = plan('decisions.md', '# Plan\n\n## Decisions to confirm\n- A or B?\n\n## GSTACK REVIEW REPORT\n');
    expect(() => assertNoPlanFileDecisions({ ...base, outcome: 'plan_ready', planFile } as PlanSkillObservation, planFileHasDecisionsSection))
      .toThrow('not written to the plan as a substitute');
  });
  test('a plan_ready plan file without ## Decisions passes, and asked runs are not checked', () => {
    const planFile = plan('clean.md', '# Plan\n\n## Approach\nShip it.\n\n## GSTACK REVIEW REPORT\n');
    expect(() => assertNoPlanFileDecisions({ ...base, outcome: 'plan_ready', planFile } as PlanSkillObservation, planFileHasDecisionsSection)).not.toThrow();
    expect(() => assertNoPlanFileDecisions({ ...base, outcome: 'asked' } as PlanSkillObservation, planFileHasDecisionsSection)).not.toThrow();
  });
});
