import { expect, test } from 'bun:test';
import type { AskUserQuestionFingerprint } from './helpers/claude-pty-runner';
import type { NativeQuestion } from './helpers/plan-skill-questions';
import { CEO_SCOPE_CANDIDATES } from './helpers/plan-review-cases';
import { CEO_SPLIT_CALL_FLOOR } from './helpers/ceo-split-question-policy';
import { validatePlanReviewDecisionResponse, type PlanReviewDecision, type PlanReviewDecisionInput } from './helpers/plan-review-decisions';

const PLATFORMS = ['Slack', 'Discord', 'Microsoft Teams', 'Telegram', 'Mattermost'];
const question = (platform: string, n: number): NativeQuestion => ({
  header: platform, multiSelect: false,
  question: `D3.${n} — ${platform} integration\nELI10: Decide this integration independently. Recommendation: Include.`,
  options: ['Include', 'Defer', 'Cut', 'Hold'].map(label => ({ label, description: `Choose ${label} for ${platform}.` })),
});
type NativeCall = AskUserQuestionFingerprint & { toolUseId: string; questions: NativeQuestion[] };
const call = (id: string, questions: NativeQuestion[]) => ({
  toolUseId: id, questions, selectedOptions: questions.map(() => 1), signature: id,
  promptSnippet: 'diagnostic', options: [], observedAtMs: 1, preReview: true,
}) as unknown as NativeCall;
const row = (fp: NativeCall, tab: number, target: string): PlanReviewDecision => ({
  toolUseId: fp.toolUseId, questionIndex: tab, kind: 'scope', targetIds: [target], independentDecisions: 1,
  evidence: [{ field: 'question', optionIndex: null, quote: fp.questions[tab - 1]!.question.split('\n')[0]! }],
  reason: 'This acknowledged question presents the independent decision described by this target.',
  optionActions: (['include', 'defer', 'cut', 'hold'] as const).map((action, i) => ({ optionIndex: i + 1, action })),
});
/** Stored shapes: each inner array is one AskUserQuestion call; numbers index PLATFORMS. */
function run(groups: number[][]) {
  const fingerprints = groups.map((group, i) => call(`native-${i}`, group.map(p => question(PLATFORMS[p]!, p + 1))));
  const input: PlanReviewDecisionInput = { plan: 'Review the five independent integrations in this plan.', kind: 'scope',
    targets: CEO_SCOPE_CANDIDATES, fingerprints, floor: CEO_SPLIT_CALL_FLOOR, deadlineAt: Date.now() + 60_000 };
  const questions = groups.flatMap((group, i) => group.map((p, tab) => row(fingerprints[i]!, tab + 1, `E${p + 1}`)));
  return () => validatePlanReviewDecisionResponse(input, { questions });
}

test('the split floor is the minimum number of calls for five options at four per call', () => {
  expect(CEO_SPLIT_CALL_FLOOR).toBe(Math.ceil(PLATFORMS.length / 4));
});
test.each([
  ['five sequential calls', [[0], [1], [2], [3], [4]]],
  ['two batched calls', [[0, 1, 2, 3], [4]]],
  ['three batched calls', [[0, 1], [2, 3], [4]]],
])('known-good split passes: %s', (_name, groups) => {
  expect(run(groups)().coveredTargetIds).toEqual(CEO_SCOPE_CANDIDATES.map(c => c.id));
});
test.each([
  ['a candidate silently dropped', [[0, 1, 2, 3]], 'missing target decisions'],
  ['one call for a dropped fifth candidate', [[0, 1, 2], [3]], 'missing target decisions'],
])('known-bad split fails: %s', (_name, groups, message) => {
  expect(run(groups)).toThrow(message);
});
