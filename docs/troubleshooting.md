# Troubleshooting gstack messages

Find the message you saw, then follow its fix. Every check gstack runs ends in
one of three states:

- **ran**: the check executed. It may still have found problems.
- **not run**: gstack chose not to run it (you turned it off, or nothing applied).
- **unavailable**: gstack tried and could not run it. This is missing coverage,
  never a pass.

A message that is not `ran` has this shape:

```
<check>: not run (<reason>). Fix: <command>
<check> unavailable: <reason> (<detail>). No review ran; this is missing coverage, not a pass. Fix: <command>
<check>: ran, verdict unverified (<reason>). Fix: read the output above
```

Search this page for the words after `unavailable:` or `not run (`. Each
section has a stable link anchor; the reason codes and anchors come from
`lib/gate-outcomes.ts`, and a free test fails if a code has no section here.

---

## Outside reviews (Codex and Claude Code)

Outside reviews send your diff, plan or question to a second AI provider. Their
verdict comes from `lib/outside-review-result.ts`, which prints
`VERDICT: clean|findings|unverified|unavailable`. A `findings` verdict with a
P0 or P1 finding blocks exactly like a native P0/P1. `unverified` and
`unavailable` are missing coverage: /ship and /review continue, show the gap in
the readiness dashboard and the PR body, and never count it as a pass.

<a id="codex-sandbox-unavailable"></a>
### `Codex outside review unavailable: Codex's sandbox could not start here (...)`

**Meaning.** Codex runs every command inside a Linux sandbox (bubblewrap). In
many containers and devcontainers the kernel does not allow unprivileged user
namespaces, so the sandbox cannot start and every command Codex tries fails.
gstack reports this instead of trusting a review that read nothing.
`CODEX_MODE: sandbox_unavailable` is the same condition found by the free
preflight before any paid call.

**What is kept.** Nothing was sent for review, or the review was discarded. Your
code and files are unchanged.

**Fix.** Enable unprivileged user namespaces for the container (for Docker, a
seccomp profile that allows them), or, inside a container you trust, run
Codex without its sandbox for this shell:

```bash
export GSTACK_CODEX_NO_SANDBOX=1
```

**Expected result.** With namespaces enabled, the next review prints
`OUTSIDE_STATUS: completed`. With `GSTACK_CODEX_NO_SANDBOX=1`, every review
prints `WARNING: GSTACK_CODEX_NO_SANDBOX=1: ...` because Codex can then read
and write anything your user can. Only the exact value `1` works, and only from
your shell environment.

<a id="outside-review-commands-failed"></a>
### `... outside review unavailable: the reviewer could not run commands or read the diff (...)`

**Meaning.** The reviewer tried to run commands but none succeeded, or its
answer says it could not run commands or read the diff. A "no issues found"
written after that is not a review.

**What is kept.** Nothing; the answer is shown above but not counted.

**Fix.** Read the reviewer's stderr above, repair what it names, and re-run.

**Expected result.** `OUTSIDE_STATUS: completed` with a `VERDICT:` line.

<a id="outside-review-execution-failed"></a>
### `... outside review unavailable: the reviewer process failed (exit N: ...)`

**Meaning.** The provider CLI exited non-zero. The first stderr line is in the
parentheses.

**What is kept.** Partial output is shown above; it is not counted.

**Fix.** Repair the cause in the provider diagnosis (log in again, fix the
model, check the network), then re-run.

**Expected result.** `OUTSIDE_STATUS: completed`.

<a id="outside-review-timeout"></a>
### `... outside review unavailable: the reviewer hit its time limit and was stopped (exit 124)`

**Meaning.** The provider did not finish within its deadline and was stopped.

**What is kept.** Partial output is shown above; it is not counted.

**Fix.** Re-run with a smaller scope, or check the provider's status and your
network.

**Expected result.** `OUTSIDE_STATUS: completed`.

<a id="outside-review-empty-response"></a>
### `... outside review unavailable: the reviewer returned no response`

**Meaning.** The provider exited successfully but returned nothing.

**Fix.** Read the stderr above, then re-run.

**Expected result.** `OUTSIDE_STATUS: completed`.

<a id="outside-review-refused"></a>
### `... outside review unavailable: the reviewer declined to review`

**Meaning.** The provider answered with a refusal instead of a review.

**Fix.** Re-run; if it declines again, rely on the native review.

**Expected result.** `OUTSIDE_STATUS: completed`.

<a id="outside-review-missing-markers"></a>
### `... outside review unavailable: the response lacks the markers this gate requires (...)`

**Meaning.** The answer did not contain what the gate checks: a
`Recommendation: ... because ...` line, a `SCORE:`/`AMBIGUITIES:` pair, or
severity tags.

**Fix.** Re-run the review.

**Expected result.** `OUTSIDE_STATUS: completed`.

<a id="outside-review-unverified"></a>
### `... outside review: ran, verdict unverified (...)` / `OUTSIDE_STATUS: unverified` / `GATE: UNVERIFIED`

**Meaning.** The review completed but tagged nothing and gave no explicit
no-findings conclusion, so no pass or fail can be read from it.

**What is kept.** The full answer is shown above.

**Fix.** Read the output above and decide. It is not a pass, and /ship and
/review list it as missing coverage.

<a id="codex-model-unusable"></a>
### `CODEX_MODE: model_unusable` / `MODEL_UNUSABLE`

**Meaning.** Codex rejected the selected model: the account cannot use it
(HTTP 400), the model is retired, or a custom provider's `base_url` is wrong
(HTTP 404). The `CODEX_MODEL:` line names the model and where it came from.

**Fix.** Choose a model your account can use, or correct the provider:

```bash
export GSTACK_CODEX_MODEL=<supported-model>
# or edit model / base_url in ${CODEX_HOME:-~/.codex}/config.toml
```

**Expected result.** `CODEX_MODE: ready`.

<a id="codex-mode-unverified"></a>
### `CODEX_MODE: unverified` / `MODEL_PROBE_INCONCLUSIVE`

**Meaning.** The short model check timed out or hit a network error, so gstack
could not confirm the model works. The review still runs and its own result is
checked.

**Fix.** Nothing now. If the review then fails, its message says why.

<a id="codex-auth-failed"></a>
### `CODEX_MODE: not_authed` / `AUTH_FAILED`

**Meaning.** No Codex credentials were found: no `CODEX_API_KEY`, no
`OPENAI_API_KEY`, no `auth.json`, and no set environment variable named by a
custom provider's `env_key` in `config.toml`.

**Fix.**

```bash
codex login
```

or export the variable your provider's `env_key` names.

**Expected result.** `CODEX_MODE: ready`.

<a id="outside-review-disabled"></a>
### `Codex review skipped (codex_reviews disabled)` / `CODEX_MODE: disabled`

**Meaning.** You turned outside reviews off. This is `not run`, never a pass and
never an outage.

**Fix.** To turn them back on:

```bash
gstack-config set codex_reviews enabled
```

<a id="codex-review-notice"></a>
### `NOTICE: gstack outside reviews send the review prompt and code to Codex (...) using ...`

**Meaning.** Outside reviews are on by default. The first one on a machine
says which provider receives your prompt and code and which login or key pays
for it. It shows once (gstack records `.codex-review-notice-shown` in its state
directory) and never blocks the review.

**Fix.** Nothing, if that is what you want. To stop sending code to Codex:

```bash
gstack-config set codex_reviews disabled
```

**Expected result.** Later reviews print `Codex review skipped (codex_reviews disabled)`
or `CODEX_MODE: disabled`, and /ship and /review show the outside review as not run.
