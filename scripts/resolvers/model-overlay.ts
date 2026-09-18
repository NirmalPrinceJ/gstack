/**
 * Model overlay resolver — reads model-overlays/{model}.md and returns it
 * wrapped in a subordinate behavioral-patch section.
 *
 * Precedence:
 *   1. Exact match: ctx.model === '@cf/meta/llama-3.3-70b-instruct-fp8-fast'
 *      → reads model-overlays/llama.md
 *   2. Family resolution: ctx.model === '@cf/qwen/qwen2.5-coder-32b-instruct'
 *      → resolveModel() → 'qwen' → reads model-overlays/qwen.md
 *   3. INHERIT directive: if the file's first non-whitespace line is
 *      `{{INHERIT:cloudflare}}`, the resolver reads model-overlays/cloudflare.md first
 *      and concatenates it ahead of the rest of this file's content.
 *   4. Missing file: returns empty string (graceful degradation, no error).
 *   5. No ctx.model set: returns empty string.
 *
 * The returned block is subordinate to skill workflow, safety gates, and
 * AskUserQuestion instructions. The subordination language is part of the
 * wrapper heading so it appears with every overlay regardless of file content.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { TemplateContext } from './types';
import { resolveModel } from '../models';

const OVERLAY_DIR = path.resolve(import.meta.dir, '../../model-overlays');

const INHERIT_RE = /^\s*\{\{INHERIT:([a-z0-9-]+(?:\.[0-9]+)*)\}\}\s*\n/;

export function readOverlay(model: string, seen: Set<string> = new Set()): string {
  if (seen.has(model)) return ''; // cycle guard
  seen.add(model);

  const filePath = path.join(OVERLAY_DIR, `${model}.md`);
  if (!fs.existsSync(filePath)) return '';

  const raw = fs.readFileSync(filePath, 'utf-8');
  const match = raw.match(INHERIT_RE);
  if (!match) return raw.trim();

  const baseModel = match[1];
  const base = readOverlay(baseModel, seen);
  const rest = raw.replace(INHERIT_RE, '').trim();

  if (!base) return rest;
  return `${base}\n\n${rest}`;
}

/**
 * Resolve a model name to its overlay file name.
 * Handles both exact matches and provider/model format
 * (@cf/meta/llama-* → llama).
 */
function resolveOverlayName(model: string): string {
  // Try exact match first
  if (fs.existsSync(path.join(OVERLAY_DIR, `${model}.md`))) {
    return model;
  }

  // Try resolving via model family
  const resolved = resolveModel(model);
  if (resolved && fs.existsSync(path.join(OVERLAY_DIR, `${resolved}.md`))) {
    return resolved;
  }

  // Try provider prefix (e.g., @cf/meta/llama-* → cloudflare)
  if (model.startsWith('@cf/')) {
    if (fs.existsSync(path.join(OVERLAY_DIR, 'cloudflare.md'))) {
      return 'cloudflare';
    }
  }

  return model;
}

export function generateModelOverlay(ctx: TemplateContext): string {
  if (!ctx.model) return '';

  const overlayName = resolveOverlayName(ctx.model);
  const content = readOverlay(overlayName);
  if (!content) return '';

  const precedence = ctx.model === 'gpt-5.6-sol'
    ? `The following instructions disambiguate scope for the ${ctx.model} model.
They govern ambiguous completeness words such as \`complete\`, \`full\`, \`every\`,
\`exhaustive\`, \`100%\`, and \`Boil the Ocean\`, and when to stop iterating on
work the user did not ask for. Concrete skill workflow steps, STOP points,
AskUserQuestion gates, plan-mode safety, required tests, skill-mandated
re-verification and re-review loops, and /ship review gates still win.
Never use this patch to skip a concrete requirement.`
    : `The following nudges are tuned for the ${ctx.model} model family. They are
**subordinate** to skill workflow, STOP points, AskUserQuestion gates, plan-mode
safety, and /ship review gates. If a nudge below conflicts with skill instructions,
the skill wins. Treat these as preferences, not rules.`;

  return `## Model-Specific Behavioral Patch (${ctx.model})

${precedence}

${content}`;
}
