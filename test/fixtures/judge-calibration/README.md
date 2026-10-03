# W2 judge calibration corpus

Preregistered corpora for the W2 judge schema migration (comparison 1: JSON schema
transport, prompt prose unchanged). One directory per distinct request
configuration, keyed by prompt builder, model, max_tokens, stream, effort and
thresholds rather than by test case.

Each `<config>/corpus.json` holds 24 items: 8 clearly passing, 8 clearly failing and
8 threshold-adjacent, with ids `p01-p08`, `f01-f08` and `a01-a08`. The held-out third
(`p06-p08`, `f06-f08`, `a07`, `a08`) is dispatched only after every development item
has been sampled, with the same frozen requests. `expected` is the verdict a careful
grader would reach under the eval's pass rule (`pass_rule`). The author labeled every
item; a separate agent run then labeled every item blind (shuffled ids, no author
labels) before any schema was written. `second_review` records that verdict, and each
disagreement carries `author_expected` and the third reviewer's `adjudication`.

`scripts/judge-calibration.ts` runs the comparison and `scripts/judge-calibration-configs.ts`
defines each configuration. Run outputs land in `<config>/runs/`:
`comparison-1.samples.jsonl` holds every sample with its value or error kind, latency
and priced usage, and `comparison-1.result.json` holds the flip rates, agreement,
false passes, error rates, p95 latency, landing decision and the UC3 prose-step
trigger. `manifest.json` prices every planned call before dispatch.
