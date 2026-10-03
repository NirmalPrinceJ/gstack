import { describe, expect, spyOn, test } from 'bun:test';
import Anthropic from '@anthropic-ai/sdk';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { callJudge, JudgeRefusalError, type CallJudgeOptions, type JudgeResponseMeta } from './helpers/llm-judge';
import {
  analyze, classifyError, loadCorpus, PANEL_SAMPLES, PHASES, planCalls, priceManifest, runCalls, runSample,
  type CalibrationConfig, type CorpusItem, type JudgeCall, type SampleRecord,
} from '../scripts/judge-calibration';

const item = (id: string, expected: 'pass' | 'fail', split: 'dev' | 'heldout' = 'dev'): CorpusItem =>
  ({ id, category: expected, expected, split, rationale: 'fixture', inputs: { text: `doc ${id}` } });

const config: CalibrationConfig = {
  id: 'stub', priority: 1, cases: ['a', 'b'], model: 'claude-fable-5-1',
  build: inputs => `grade: ${inputs.text}`,
  oldOptions: {},
  newOptions: { jsonSchema: { type: 'object' } },
  validate: value => { if (typeof (value as { score?: unknown })?.score !== 'number') throw new Error('score missing'); },
  verdict: samples => samples.filter(sample => (sample as { score: number }).score >= 4).length * 2 > samples.length ? 'pass' : 'fail',
  estimatedOutputTokens: 1000,
};

/** Stub provider keyed by prompt and phase; usage is reported through the real onResponse seam. */
function stub(score: (prompt: string, opts: CallJudgeOptions, n: number) => unknown): { call: JudgeCall; calls: Array<{ prompt: string; opts: CallJudgeOptions }> } {
  const calls: Array<{ prompt: string; opts: CallJudgeOptions }> = [];
  return {
    calls,
    call: async (prompt, _model, opts) => {
      calls.push({ prompt, opts });
      opts.onResponse?.({ id: 'msg', model: 'claude-fable-5-1', stop_reason: 'end_turn', usage: { input_tokens: 1000, output_tokens: 1000 } });
      const value = score(prompt, opts, calls.length);
      if (value instanceof Error) throw value;
      return value;
    },
  };
}

const records = async (items: CorpusItem[], call: JudgeCall) => {
  const out: SampleRecord[] = [];
  for (const split of ['dev', 'heldout'] as const) out.push(...(await runCalls(config, planCalls(items, split), { budgetUsd: 1000, call })).records);
  return out;
};

describe('judge calibration harness (free, stubbed provider)', () => {
  test('every item gets two independent old panels and one new panel, each sample a direct call', async () => {
    const items = [item('p1', 'pass'), item('f1', 'fail'), item('h1', 'pass', 'heldout')];
    const provider = stub(() => ({ score: 5 }));
    const out = await records(items, provider.call);
    expect(provider.calls).toHaveLength(items.length * PHASES.length * PANEL_SAMPLES);
    for (const entry of items) {
      for (const phase of PHASES) expect(out.filter(record => record.item === entry.id && record.phase === phase)).toHaveLength(PANEL_SAMPLES);
    }
    expect(provider.calls.filter(call => call.opts.jsonSchema)).toHaveLength(items.length * PANEL_SAMPLES);
    expect(new Set(provider.calls.map(call => call.prompt))).toEqual(new Set(items.map(entry => `grade: ${entry.inputs.text}`)));
    // Held-out samples are dispatched only after every development sample.
    const firstHeldout = out.findIndex(record => record.split === 'heldout');
    expect(out.slice(firstHeldout).every(record => record.split === 'heldout')).toBe(true);
  });

  test('the harness never routes through judgePanel or the workflow passing-panel cache', () => {
    const scripts = path.join(import.meta.dir, '..', 'scripts');
    for (const file of ['judge-calibration.ts', 'judge-calibration-configs.ts'].filter(name => fs.existsSync(path.join(scripts, name)))) {
      const source = fs.readFileSync(path.join(scripts, file), 'utf8');
      const imports = source.match(/^import[\s\S]*?from '[^']+';$/gm) ?? [];
      expect(imports.length).toBeGreaterThan(0);
      expect(imports.join('\n')).not.toMatch(/\bjudgePanel\b|workflow-judge-cache|eval-input-cache/);
      expect(source.replace(/^\s*(?:\/\*\*|\*|\/\/).*$/gm, '')).not.toMatch(/\bjudgePanel\(|prepareWorkflowJudgeCache|lookupEvalInputCache/);
    }
  });

  test('a second old panel is sampled, not replayed: old-vs-old flips are counted', async () => {
    const items = [item('p1', 'pass')];
    const provider = stub((_prompt, opts, n) => ({ score: opts.jsonSchema ? 5 : n <= 3 ? 5 : 2 }));
    // Force the old panels apart: the first three old calls pass, the next three fail.
    let oldCalls = 0;
    const call: JudgeCall = (prompt, model, opts) => provider.call(prompt, model, opts).then(value =>
      opts.jsonSchema ? value : ({ score: ++oldCalls <= 3 ? 5 : 2 }));
    const result = analyze(config, items, await records(items, call));
    expect(result.all.old_flips).toEqual({ flips: 1, compared: 1 });
  });

  test('error kinds are recorded per sample and never count as verdicts', async () => {
    expect(classifyError(new JudgeRefusalError({ content: [] }))).toBe('refusal');
    expect(classifyError(new Error('Judge response truncated at max_tokens=8192 (model=m)'))).toBe('truncation');
    expect(classifyError(new SyntaxError('Unexpected token'))).toBe('parse');
    expect(classifyError(new Error('Judge returned non-JSON: hi'))).toBe('parse');
    expect(classifyError(new Error('Structured judge did not complete: stop_reason=pause_turn'))).toBe('parse');
    expect(classifyError(Object.assign(new Error('Overloaded'), { status: 529 }))).toBe('transport');

    const planned = { item: item('p1', 'pass'), phase: 'new' as const, sample: 0 };
    const schema = await runSample(config, planned, stub(() => ({ verdict: 'yes' })).call);
    expect(schema).toMatchObject({ status: 'error', error_kind: 'schema', cost_usd: 0.06 });
    expect(schema).not.toHaveProperty('value');
    const refusal = await runSample(config, planned, stub(() => new JudgeRefusalError({ content: [] })).call);
    expect(refusal).toMatchObject({ status: 'error', error_kind: 'refusal' });

    // One errored new sample leaves that panel incomplete: excluded from flips, counted as an error.
    const items = [item('p1', 'pass'), item('p2', 'pass')];
    let newCalls = 0;
    const result = analyze(config, items, await records(items, stub((_prompt, opts) =>
      opts.jsonSchema && ++newCalls === 1 ? new SyntaxError('bad json') : { score: 5 }).call));
    expect(result.errors.new).toMatchObject({ parse: 1, samples: 6 });
    expect(result.errors.old).toMatchObject({ parse: 0, samples: 12, rate: 0 });
    expect(result.all.new_flips.compared).toBe(1);
    expect(result.all.old_flips.compared).toBe(2);
    expect(result.prose_step_triggered.triggered).toBe(true);
    expect(result.prose_step_triggered.reasons).toContain('new prompt has errored samples');
  });

  test('latency is measured per sample and the p95 gate holds the schema back', async () => {
    let now = 0;
    const clock = () => now;
    const slow: JudgeCall = async (_prompt, _model, opts) => { now += opts.jsonSchema ? 100_000 : 10_000; return { score: 5 }; };
    const items = [item('p1', 'pass')];
    const out: SampleRecord[] = (await runCalls(config, planCalls(items, 'dev'), { budgetUsd: 1000, call: slow, clock, concurrency: 1 })).records;
    expect(out.filter(record => record.phase === 'new').every(record => record.latency_ms === 100_000)).toBe(true);
    const result = analyze(config, items, out);
    expect(result.latency_p95_ms).toEqual({ old: 10_000, new: 100_000 });
    expect(result.landing.lands).toBe(false);
    expect(result.landing.reasons.join(' ')).toContain('p95 latency');
  });

  test('landing: flips at most old+1, agreement does not drop, zero new false passes', async () => {
    const items = [item('p1', 'pass'), item('f1', 'fail'), item('f2', 'fail')];
    const same = analyze(config, items, await records(items, stub(prompt => ({ score: prompt.includes('p1') ? 5 : 1 })).call));
    expect(same.landing).toEqual({ lands: true, reasons: [], strict_no_flip_increase: true });
    expect(same.all.agreement).toEqual({ 'old-a': 3, 'old-b': 3, new: 3 });

    const leaky = analyze(config, items, await records(items, stub((prompt, opts) =>
      ({ score: prompt.includes('p1') || (opts.jsonSchema && prompt.includes('f1')) ? 5 : 1 })).call));
    expect(leaky.all.new_false_passes).toEqual(['f1']);
    expect(leaky.landing.lands).toBe(false);
    expect(leaky.landing.reasons.join(' ')).toContain('new false passes: f1');
    expect(leaky.landing.reasons.join(' ')).toContain('agreement dropped');
  });

  test('two consecutive transport failures stop the study; the budget stops dispatch before it is passed', async () => {
    const items = [item('p1', 'pass'), item('p2', 'pass')];
    const down = await runCalls(config, planCalls(items, 'dev'), { budgetUsd: 1000, concurrency: 1,
      call: stub(() => Object.assign(new Error('socket hang up'), { status: 500 })).call });
    expect(down.records).toHaveLength(2);
    expect(down.stopped).toContain('infrastructure');

    const capped = await runCalls(config, planCalls(items, 'dev'), { budgetUsd: 0.5, concurrency: 1, call: stub(() => ({ score: 5 })).call });
    expect(capped.stopped).toContain('budget');
    expect(capped.records.reduce((sum, record) => sum + record.cost_usd, 0)).toBeLessThanOrEqual(0.5);
    const result = analyze(config, items, capped.records, capped.stopped);
    expect(result.complete).toBe(false);
    expect(result.landing.lands).toBe(false);
  });

  test('callJudge reports usage and stop reason through onResponse without sending it', async () => {
    const key = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'test-only-key';
    const create = spyOn(Anthropic.Messages.prototype, 'create').mockResolvedValue({ id: 'msg_1', model: 'claude-fable-5-1',
      stop_reason: 'end_turn', content: [{ type: 'text', text: '{"score":4}' }], usage: { input_tokens: 12, output_tokens: 34 } } as never);
    try {
      const seen: JudgeResponseMeta[] = [];
      expect(await callJudge<{ score: number }>('grade', 'claude-fable-5-1', { onResponse: meta => seen.push(meta) })).toEqual({ score: 4 });
      expect(seen).toEqual([{ id: 'msg_1', model: 'claude-fable-5-1', stop_reason: 'end_turn', usage: { input_tokens: 12, output_tokens: 34 } }]);
      expect(create.mock.calls[0]![0]).toEqual({ model: 'claude-fable-5-1', max_tokens: 8192, messages: [{ role: 'user', content: 'grade' }] });
    } finally {
      create.mockRestore();
      if (key === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = key;
    }
  });

  test('the manifest prices every call in priority order from a committed corpus', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'judge-cal-'));
    try {
      for (const id of ['second', 'first']) {
        fs.mkdirSync(path.join(root, id, 'inputs'), { recursive: true });
        fs.writeFileSync(path.join(root, id, 'inputs', 'p1.text.md'), 'from file');
        fs.writeFileSync(path.join(root, id, 'corpus.json'), JSON.stringify({ items: [
          { ...item('p1', 'pass'), inputs: { text: { file: 'inputs/p1.text.md' } } }, item('f1', 'fail', 'heldout')] }));
      }
      expect(loadCorpus('first', root)[0]!.inputs.text).toBe('from file');
      const entries = await priceManifest([{ ...config, id: 'second', priority: 2 }, { ...config, id: 'first', priority: 1 }, { ...config, id: 'absent', priority: 0 }],
        async () => 2000, root);
      expect(entries.map(entry => entry.config)).toEqual(['first', 'second']);
      expect(entries[0]).toMatchObject({ items: 2, calls: 18, input_tokens: 36_000, estimated_cost_usd: 1.26 });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
