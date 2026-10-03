/**
 * Model taxonomy — neutral module with no imports from hosts/ or resolvers/.
 *
 * Model families supported by model overlays in model-overlays/{family}.md.
 * Host configs reference these as `defaultModel` strings (validated at
 * generation time), but the model axis is independent of the host axis.
 *
 * IMPORTANT: host ≠ model. Claude Code can run any Claude model (Opus, Sonnet,
 * Haiku, future). Codex CLI runs GPT/o-series models. Cursor and OpenCode can
 * front multiple providers. The generator does NOT auto-detect the model from
 * the host — users can pass --model explicitly, otherwise each host supplies
 * its own generation default. Exception outside this module: ./setup detects
 * the Codex model from ${CODEX_HOME:-~/.codex}/config.toml
 * (scripts/resolve-codex-generation-model.ts) and passes it as an explicit
 * --model.
 */

export const ALL_MODEL_NAMES = [
  'claude',
  'opus-4-7',
  'fable-5',
  'opus-4-8',
  'sonnet-5',
  'gpt',
  'gpt-5.4',
  'gpt-5.6-sol',
  'gpt-6-astra',
  'gemini',
  'o-series',
] as const;

export type Model = (typeof ALL_MODEL_NAMES)[number];

/**
 * Resolve a model argument from CLI input to a known Model family.
 *
 * Input is trimmed and lowercased, and one trailing `[...]` context marker
 * (for example `claude-sonnet-5[1m]`) is stripped before matching.
 *
 * Precedence rules:
 * 1. Exact match against ALL_MODEL_NAMES → return as-is. This is the ONLY
 *    path that selects `gpt-5.6-sol` — Sol is intentionally exact-only.
 *    It is also how to force a model-pinned profile: `--model opus-4-7`,
 *    `--model sonnet-5`, and so on.
 * 2. Family heuristics for common variants:
 *    - `gpt-5.4-mini`, `gpt-5.4-turbo`, `gpt-5.4-*` → `gpt-5.4`
 *    - `gpt-*` (anything else GPT, including other 5.6 variants) → `gpt`
 *    - `o3`, `o4`, `o4-mini`, `o1`, `o1-mini`, `o1-pro` → `o-series`
 *    - Model-pinned Claude families (Opus 4.7, Opus 4.8, Sonnet 5) use an
 *      allowlist: the bare ID (`claude-<family>-<major>`), the bare ID plus
 *      an 8-digit date snapshot (`-YYYYMMDD`), and the bare ID plus `-latest`
 *      keep the pinned profile. Any other suffix, including a point release
 *      with or without a date (`claude-opus-4-7-1`, `claude-sonnet-5-5`,
 *      `claude-sonnet-5-5-20261001`), falls to `claude`: a newer model should
 *      not read nudges written for an older one.
 *    - Fable is the exception: any `claude-fable-5-*` ID keeps `fable-5`,
 *      because `claude-fable-5-1` is CLAUDE_FRONTIER_EVAL_MODEL
 *      (lib/eval-model.ts) and moving it would shift every eval baseline.
 *      The exception ends when CLAUDE_FRONTIER_EVAL_MODEL changes.
 *    - Any other `claude-*` (including `claude-opus-5-5`) → `claude`
 *    - `gemini-*` (2.5-pro, flash, etc.) → `gemini`
 * 3. Unknown input → returns null (caller decides: error, or fall back).
 *
 * The resolver file in model-overlays/{model}.md applies further fallback
 * (e.g., missing gpt-5.4.md falls back to gpt.md). This function only
 * normalizes CLI input to a family name.
 */
export function resolveModel(input: string): Model | null {
  const s = input.trim().toLowerCase().replace(/\[[^\]]*\]$/, '').trim();
  if (!s) return null;

  // Exact match first
  if ((ALL_MODEL_NAMES as readonly string[]).includes(s)) {
    return s as Model;
  }

  // Family heuristics
  // Sol never reaches here — the exact match above already returned it. Do
  // not add a Sol family pattern: Terra, Luna, future 5.6 variants, and
  // suffixed model IDs must NOT inherit Sol's behavioral profile; they fall
  // through to the generic `gpt` family below.
  if (/^gpt-6-astra(-|$)/.test(s)) return 'gpt-6-astra';
  if (/^gpt-5\.4(-|$)/.test(s)) return 'gpt-5.4';
  if (/^gpt(-|$)/.test(s)) return 'gpt';
  if (/^o[0-9]+(-|$)/.test(s)) return 'o-series';
  const pinned = /^claude-(opus-4-7|opus-4-8|sonnet-5)(-\d{8}|-latest)?$/.exec(s);
  if (pinned) return pinned[1] as Model;
  if (/^claude-fable-5(-|$)/.test(s)) return 'fable-5';
  if (/^claude(-|$)/.test(s)) return 'claude';
  if (/^gemini(-|$)/.test(s)) return 'gemini';

  return null;
}

/**
 * Validate a string against ALL_MODEL_NAMES. Used by host-config validators
 * when a HostConfig declares `defaultModel`. Returns an error message or null
 * if valid.
 */
export function validateModel(input: string): string | null {
  if ((ALL_MODEL_NAMES as readonly string[]).includes(input)) return null;
  return `'${input}' is not a known model. Use ${ALL_MODEL_NAMES.join(', ')}.`;
}
