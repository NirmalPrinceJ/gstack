/**
 * INV-1 gate outcome contract: every gate or outside review ends as
 * `ran` (with findings or a verdict), `not_run` (gstack chose not to run it) or
 * `unavailable` (it tried and could not). Each reason code maps to one state,
 * one stable anchor in docs/troubleshooting.md and one fix action; the
 * validator prints these lines and test/troubleshooting-anchors.test.ts checks
 * every anchor exists. Add a row here before printing a new reason anywhere.
 */
export type GateState = 'ran' | 'not_run' | 'unavailable';

export interface GateOutcome {
  state: GateState;
  /** Stable `<a id>` in docs/troubleshooting.md. */
  anchor: string;
  /** What happened, in plain words; `<detail>` adds the real value (exit code, stderr line). */
  summary: string;
  fix: string;
}

export const GATE_OUTCOMES = {
  sandbox_unavailable: {
    state: 'unavailable', anchor: 'codex-sandbox-unavailable',
    summary: "Codex's sandbox could not start here",
    fix: 'enable unprivileged user namespaces for this container, or set GSTACK_CODEX_NO_SANDBOX=1',
  },
  commands_failed: {
    state: 'unavailable', anchor: 'outside-review-commands-failed',
    summary: 'the reviewer could not run commands or read the diff',
    fix: 'read the reviewer stderr above, repair the environment it names, then re-run the review',
  },
  execution_failed: {
    state: 'unavailable', anchor: 'outside-review-execution-failed',
    summary: 'the reviewer process failed',
    fix: 'read the provider diagnosis above (auth, model, network), repair it, then re-run the review',
  },
  timeout: {
    state: 'unavailable', anchor: 'outside-review-timeout',
    summary: 'the reviewer hit its time limit and was stopped',
    fix: 're-run the review with a smaller scope, or check the provider status and network',
  },
  empty_response: {
    state: 'unavailable', anchor: 'outside-review-empty-response',
    summary: 'the reviewer returned no response',
    fix: 'read the reviewer stderr above, then re-run the review',
  },
  review_refused: {
    state: 'unavailable', anchor: 'outside-review-refused',
    summary: 'the reviewer declined to review',
    fix: 're-run the review; if it declines again, review the change natively',
  },
  missing_markers: {
    state: 'unavailable', anchor: 'outside-review-missing-markers',
    summary: 'the response lacks the markers this gate requires',
    fix: 're-run the review; a response without its required markers never counts as a pass',
  },
  untagged_review: {
    state: 'ran', anchor: 'outside-review-unverified',
    summary: 'the review completed without severity tags or an explicit no-findings line',
    fix: 'read the output above and decide; it is not a pass',
  },
  model_unusable: {
    state: 'unavailable', anchor: 'codex-model-unusable',
    summary: 'Codex could not use the selected model',
    fix: 'set GSTACK_CODEX_MODEL=<supported-model> or fix model (and base_url for a custom provider) in your Codex config.toml',
  },
  probe_inconclusive: {
    state: 'ran', anchor: 'codex-mode-unverified',
    summary: 'the Codex model check timed out or hit a network error, so readiness is unverified',
    fix: 'nothing to do now; the review itself is still checked, and a failure there is reported',
  },
  auth_failed: {
    state: 'unavailable', anchor: 'codex-auth-failed',
    summary: 'no Codex credentials were found',
    fix: 'run codex login, or set the API key your Codex config.toml provider names in env_key',
  },
  disabled: {
    state: 'not_run', anchor: 'outside-review-disabled',
    summary: 'outside reviews are turned off (codex_reviews=disabled)',
    fix: 'gstack-config set codex_reviews enabled',
  },
} as const satisfies Record<string, GateOutcome>;

export type GateReason = keyof typeof GATE_OUTCOMES;

/** One user-facing line for an outcome that is not a clean `ran`. */
export function gateOutcomeLine(gate: string, reason: GateReason, detail?: string): string {
  const outcome: GateOutcome = GATE_OUTCOMES[reason];
  const what = detail ? `${outcome.summary} (${detail})` : outcome.summary;
  if (outcome.state === 'not_run') return `${gate}: not run (${what}). Fix: ${outcome.fix}.`;
  if (outcome.state === 'ran') return `${gate}: ran, verdict unverified (${what}). Fix: ${outcome.fix}.`;
  return `${gate} unavailable: ${what}. No review ran; this is missing coverage, not a pass. Fix: ${outcome.fix}.`;
}
