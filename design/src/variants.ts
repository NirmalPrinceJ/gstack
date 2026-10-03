/**
 * Generate N design variants from a brief.
 * Uses staggered parallel: 1s delay between API calls to avoid rate limits.
 * Falls back to exponential backoff on 429s.
 */

import fs from "fs";
import path from "path";
import { requireApiKey } from "./auth";
import { receiptedFetch } from "./receipted-fetch";
import { imageRequestBody, modelRejectionHint } from "./models";
import { parseBrief } from "./brief";
import { normalizeIntFlag } from "./flag-utils";
import { checkMockup, type CheckResult } from "./check";
import { analyzeScreenshot, evolvePrompt } from "./evolve";

export interface VariantsOptions {
  brief?: string;
  briefFile?: string;
  /** JSON array of { brief, screenshot? }, one entry per variant. */
  briefsFile?: string;
  /**
   * Raw CLI flag value or a number. Normalized inside variants() (#2032):
   * nonsense errors loudly; above STYLE_VARIATIONS.length clamps with a
   * warning — past that index variants degrade to duplicate base-brief runs.
   */
  count?: number | string | boolean;
  outputDir: string;
  size?: string;
  quality?: string;
  viewports?: string; // "desktop,tablet,mobile" — generates at multiple sizes
}

const STYLE_VARIATIONS = [
  "", // First variant uses the brief as-is
  "Use a bolder, more dramatic visual style with stronger contrast and larger typography.",
  "Use a calmer, more minimal style with generous whitespace and subtle colors.",
  "Use a warmer, more approachable style with rounded corners and friendly typography.",
  "Use a more professional, corporate style with sharp edges and structured grid layout.",
  "Commit to one saturated hue across large surfaces (drenched color) with restrained decoration and texture from the product's material world.",
  "Use a playful, modern style with asymmetric layout and unexpected color accents.",
];

export interface VariantResult {
  path: string;
  success: boolean;
  error?: string;
  /** Exhausted its 429 retries. */
  rateLimited?: boolean;
  /** A rerun of the same operation could succeed (rate limit, timeout, deadline, 5xx, empty output). */
  retryable?: boolean;
}

const DEADLINE_ERROR = "Batch deadline reached";

/** Resolves after `ms`, or as soon as `signal` aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal?.aborted) return resolve();
    const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * Generate a single variant with retry on 429.
 *
 * Exported for testability. Pass `fetchFn` to inject a stubbed fetch in tests;
 * production code uses the global fetch by default. `signal` (the batch
 * deadline) stops backoff waits, the request and its body read; once it has
 * aborted no new attempt starts.
 */
export async function generateVariant(
  apiKey: string,
  prompt: string,
  outputPath: string,
  size: string,
  quality: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
  signal?: AbortSignal,
): Promise<VariantResult> {
  const maxRetries = 3;
  const MAX_RETRY_AFTER_MS = 60_000; // cap honored Retry-After to bound stalls
  let lastError = "";
  let skipLeadingDelay = false;
  let body: string;
  try {
    body = imageRequestBody(prompt, { size, quality });
  } catch (err: any) {
    return { path: outputPath, success: false, error: err.message, retryable: false };
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0 && !skipLeadingDelay) {
      // Exponential backoff: 2s, 4s, 8s
      const delay = Math.pow(2, attempt) * 1000;
      console.error(`  Rate limited, retrying in ${delay / 1000}s...`);
      await sleep(delay, signal);
    }
    skipLeadingDelay = false;
    if (signal?.aborted) return { path: outputPath, success: false, error: DEADLINE_ERROR, retryable: true };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 240_000);

    try {
      const response = await receiptedFetch("variants-image-request", "https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body,
        signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal,
      }, fetchFn);

      if (response.status === 429) {
        clearTimeout(timeout);
        lastError = "Rate limited (429)";
        const retryAfter = response.headers.get("retry-after");
        if (retryAfter) {
          const trimmed = retryAfter.trim();
          let waitMs: number | null = null;
          if (/^\d+$/.test(trimmed)) {
            // delta-seconds (RFC 7231)
            waitMs = Math.min(Number.parseInt(trimmed, 10) * 1000, MAX_RETRY_AFTER_MS);
          } else {
            // HTTP-date (RFC 7231)
            const dateMs = Date.parse(trimmed);
            if (!Number.isNaN(dateMs)) {
              waitMs = Math.min(Math.max(0, dateMs - Date.now()), MAX_RETRY_AFTER_MS);
            }
          }
          if (waitMs !== null) {
            if (waitMs > 0) {
              await sleep(waitMs, signal);
            }
            // Honored Retry-After (incl. 0 / past date "retry now") — skip the
            // next iteration's leading exponential sleep so we don't double-wait.
            skipLeadingDelay = true;
          }
        }
        continue;
      }

      if (!response.ok) {
        const error = await response.text();
        clearTimeout(timeout);
        if (response.status === 403 && error.includes("organization must be verified")) {
          return { path: outputPath, success: false, error: "OpenAI organization verification required. Go to https://platform.openai.com/settings/organization to verify.", retryable: false };
        }
        return { path: outputPath, success: false, error: `API error (${response.status}): ${error.slice(0, 200)}${modelRejectionHint(response.status, error, "image")}`, retryable: response.status >= 500 };
      }

      const data = await response.json() as any;
      clearTimeout(timeout);
      const imageItem = data.output?.find((item: any) => item.type === "image_generation_call");

      if (!imageItem?.result) {
        return { path: outputPath, success: false, error: "No image data in response", retryable: true };
      }

      fs.writeFileSync(outputPath, Buffer.from(imageItem.result, "base64"));
      return { path: outputPath, success: true };
    } catch (err: any) {
      clearTimeout(timeout);
      if (err.name === "AbortError") {
        return { path: outputPath, success: false, error: signal?.aborted ? DEADLINE_ERROR : "Timeout (240s)", retryable: true };
      }
      lastError = err.message;
    }
  }

  return { path: outputPath, success: false, error: lastError, rateLimited: lastError === "Rate limited (429)", retryable: true };
}

export interface BriefEntry {
  brief: string;
  screenshot?: string;
}

/** One entry per variant; the ceiling matches the built-in style directions. */
export const MAX_BRIEFS = STYLE_VARIATIONS.length;
/** Whole-batch deadline; the skill's Bash call allows 600s. */
export const BATCH_DEADLINE_MS = 540_000;
const STAGGER_MS = 1500;

/**
 * Read and validate a --briefs-file before any billable call. Errors name the
 * file, the entry index and the field.
 */
export function readBriefsFile(file: string): BriefEntry[] {
  const fail = (problem: string): never => { throw new Error(`--briefs-file ${file}: ${problem}`); };
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (err: any) {
    return fail(`cannot read a JSON array (${err.message})`);
  }
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_BRIEFS) {
    return fail(`expected a JSON array of 1 to ${MAX_BRIEFS} entries like [{"brief": "...", "screenshot": "optional.png"}]`);
  }
  return raw.map((entry: any, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) fail(`entry ${index}: expected an object with a "brief" field`);
    const unknown = Object.keys(entry).find(key => key !== "brief" && key !== "screenshot");
    if (unknown) fail(`entry ${index}: unknown field "${unknown}" (allowed: brief, screenshot)`);
    if (typeof entry.brief !== "string" || !entry.brief.trim()) fail(`entry ${index}: field "brief" must be a non-empty string`);
    if (entry.screenshot === undefined) return { brief: entry.brief };
    if (typeof entry.screenshot !== "string" || !entry.screenshot) fail(`entry ${index}: field "screenshot" must be a non-empty string`);
    let readable = false;
    try {
      fs.accessSync(entry.screenshot, fs.constants.R_OK);
      readable = fs.statSync(entry.screenshot).isFile();
    } catch {}
    if (!readable) fail(`entry ${index}: field "screenshot" is not a readable file: ${entry.screenshot}`);
    return { brief: entry.brief, screenshot: entry.screenshot };
  });
}

export interface BatchVariant {
  variant: string;
  path: string;
  operation: "generate" | "evolve";
  status: "done" | "failed" | "rate_limited";
  error: string | null;
  retryable: boolean;
  check: { status: CheckResult["status"]; issues: string } | null;
}

export interface BatchOptions {
  apiKey: string;
  outputDir: string;
  size: string;
  quality: string;
  fetchFn?: typeof globalThis.fetch;
  deadlineMs?: number;
  staggerMs?: number;
}

const hasImage = (file: string) => fs.existsSync(file) && fs.statSync(file).size > 0;

/**
 * Generate one variant per brief with staggered parallel launches under one
 * batch deadline. Each variant repeats its own operation (generate, or evolve
 * when it has a screenshot) for one missing/empty output and for one failed
 * check, and always ends with a terminal status.
 */
export async function runBriefsBatch(entries: BriefEntry[], opts: BatchOptions): Promise<BatchVariant[]> {
  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), opts.deadlineMs ?? BATCH_DEADLINE_MS);
  const signal = controller.signal;

  const runOne = async (entry: BriefEntry, index: number): Promise<BatchVariant> => {
    const variant = String.fromCharCode(65 + index);
    const outputPath = path.join(opts.outputDir, `variant-${variant}.png`);
    const operation = entry.screenshot ? "evolve" : "generate";
    const finish = (status: BatchVariant["status"], error: string | null, retryable: boolean, check: BatchVariant["check"]): BatchVariant => {
      const detail = status === "done"
        ? `${(fs.statSync(outputPath).size / 1024).toFixed(0)}KB, check ${check!.status}`
        : error;
      console.error(`VARIANT_${variant}_${status.toUpperCase()}: ${detail}`);
      return { variant, path: outputPath, operation, status, error, retryable, check };
    };
    const attempt = async (): Promise<VariantResult> => {
      if (!entry.screenshot) return generateVariant(opts.apiKey, entry.brief, outputPath, opts.size, opts.quality, fetchFn, signal);
      let analysis: string;
      try {
        analysis = await analyzeScreenshot(opts.apiKey, fs.readFileSync(entry.screenshot).toString("base64"), fetchFn, signal);
      } catch (err: any) {
        return { path: outputPath, success: false, error: signal.aborted ? DEADLINE_ERROR : `Screenshot analysis failed: ${err.message}`, retryable: true };
      }
      return generateVariant(opts.apiKey, evolvePrompt(analysis, entry.brief), outputPath, opts.size, opts.quality, fetchFn, signal);
    };
    const check = async (): Promise<NonNullable<BatchVariant["check"]>> => {
      if (signal.aborted) return { status: "skipped", issues: `${DEADLINE_ERROR} before the check` };
      try {
        const result = await checkMockup(outputPath, entry.brief, { apiKey: opts.apiKey, fetchFn, signal });
        return { status: result.status, issues: result.issues };
      } catch (err: any) {
        return { status: "skipped", issues: signal.aborted ? `${DEADLINE_ERROR} during the check` : `Check failed to run: ${err.message}` };
      }
    };

    await sleep(index * (opts.staggerMs ?? STAGGER_MS), signal);
    if (signal.aborted) return finish("failed", `${DEADLINE_ERROR} before start`, true, null);
    console.error(`  Starting variant ${variant} (${operation})...`);

    let result = await attempt();
    if (result.success && !hasImage(outputPath)) result = await attempt();
    if (result.success && !hasImage(outputPath)) result = { path: outputPath, success: false, error: "Output file missing or empty", retryable: true };
    if (!result.success) return finish(result.rateLimited ? "rate_limited" : "failed", result.error ?? "unknown error", result.retryable ?? true, null);

    let checked = await check();
    if (checked.status === "fail" && !signal.aborted) {
      const regenerated = await attempt();
      if (regenerated.success && hasImage(outputPath)) checked = await check();
    }
    return finish("done", null, false, checked);
  };

  try {
    return await Promise.all(entries.map(runOne));
  } finally {
    clearTimeout(deadline);
  }
}

/** Exit code for a finished batch: 0 all generated, 3 some failed, 1 none generated. */
export function batchExitCode(results: BatchVariant[]): number {
  const done = results.filter(r => r.status === "done").length;
  if (done === results.length) return 0;
  return done === 0 ? 1 : 3;
}

async function variantsFromBriefsFile(options: VariantsOptions): Promise<number> {
  if (typeof options.briefsFile !== "string") throw new Error("--briefs-file needs the path of a JSON file");
  if (options.brief !== undefined || options.briefFile !== undefined || options.viewports !== undefined) {
    throw new Error("--briefs-file cannot be combined with --brief, --brief-file or --viewports; put each variant's brief in the file.");
  }
  const entries = readBriefsFile(options.briefsFile);
  if (options.count !== undefined) console.error(`warning: --count is ignored with --briefs-file; generating ${entries.length} variants, one per entry.`);
  const apiKey = requireApiKey();
  fs.mkdirSync(options.outputDir, { recursive: true });

  console.error(`Generating ${entries.length} variants from ${options.briefsFile}...`);
  const startTime = Date.now();
  const results = await runBriefsBatch(entries, {
    apiKey, outputDir: options.outputDir, size: options.size || "1536x1024", quality: options.quality || "high",
  });
  const done = results.filter(r => r.status === "done");
  console.error(`\n${done.length}/${results.length} variants generated (${((Date.now() - startTime) / 1000).toFixed(1)}s)`);
  console.log(JSON.stringify({
    outputDir: options.outputDir,
    count: results.length,
    succeeded: done.length,
    failed: results.length - done.length,
    validated: done.filter(r => r.check?.status === "pass").length,
    variants: results,
  }, null, 2));
  return batchExitCode(results);
}

/**
 * Generate N variants with staggered parallel execution. Returns the process
 * exit code (always 0 outside --briefs-file).
 */
export async function variants(options: VariantsOptions): Promise<number> {
  if (options.briefsFile !== undefined) return variantsFromBriefsFile(options);
  const apiKey = requireApiKey();
  const baseBrief = options.briefFile
    ? parseBrief(options.briefFile, true)
    : parseBrief(options.brief!, false);

  const quality = options.quality || "high";

  fs.mkdirSync(options.outputDir, { recursive: true });

  // If viewports specified, generate responsive variants instead of style variants
  if (options.viewports) {
    await generateResponsiveVariants(apiKey, baseBrief, options.outputDir, options.viewports, quality);
    return 0;
  }

  // #2032: normalize at the consumption site so every caller (CLI or
  // programmatic) gets the loud-on-nonsense contract; the ceiling derives
  // from STYLE_VARIATIONS so it self-adjusts when styles are added.
  const count = normalizeIntFlag(options.count, {
    name: "count",
    def: 3,
    min: 1,
    max: STYLE_VARIATIONS.length,
  });
  const size = options.size || "1536x1024";

  console.error(`Generating ${count} variants...`);
  const startTime = Date.now();

  // Staggered parallel: start each call 1.5s apart
  const promises: Promise<{ path: string; success: boolean; error?: string }>[] = [];

  for (let i = 0; i < count; i++) {
    const variation = STYLE_VARIATIONS[i] || "";
    const prompt = variation
      ? `${baseBrief}\n\nStyle direction: ${variation}`
      : baseBrief;

    const outputPath = path.join(options.outputDir, `variant-${String.fromCharCode(65 + i)}.png`);

    // Stagger: wait 1.5s between launches
    const delay = i * 1500;
    promises.push(
      new Promise(resolve => setTimeout(resolve, delay))
        .then(() => {
          console.error(`  Starting variant ${String.fromCharCode(65 + i)}...`);
          return generateVariant(apiKey, prompt, outputPath, size, quality);
        })
    );
  }

  const results = await Promise.allSettled(promises);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  const succeeded: string[] = [];
  const failed: string[] = [];

  for (const result of results) {
    if (result.status === "fulfilled" && result.value.success) {
      const size = fs.statSync(result.value.path).size;
      console.error(`  ✓ ${path.basename(result.value.path)} (${(size / 1024).toFixed(0)}KB)`);
      succeeded.push(result.value.path);
    } else {
      const error = result.status === "fulfilled" ? result.value.error : (result.reason as Error).message;
      const filePath = result.status === "fulfilled" ? result.value.path : "unknown";
      console.error(`  ✗ ${path.basename(filePath)}: ${error}`);
      failed.push(path.basename(filePath));
    }
  }

  console.error(`\n${succeeded.length}/${count} variants generated (${elapsed}s)`);

  // Output structured result to stdout
  console.log(JSON.stringify({
    outputDir: options.outputDir,
    count,
    succeeded: succeeded.length,
    failed: failed.length,
    paths: succeeded,
    errors: failed,
  }, null, 2));
  return 0;
}

const VIEWPORT_CONFIGS: Record<string, { size: string; suffix: string; desc: string }> = {
  desktop: { size: "1536x1024", suffix: "desktop", desc: "Desktop (1536x1024)" },
  tablet: { size: "1024x1024", suffix: "tablet", desc: "Tablet (1024x1024)" },
  mobile: { size: "1024x1536", suffix: "mobile", desc: "Mobile (1024x1536, portrait)" },
};

async function generateResponsiveVariants(
  apiKey: string,
  baseBrief: string,
  outputDir: string,
  viewports: string,
  quality: string,
): Promise<void> {
  const viewportList = viewports.split(",").map(v => v.trim().toLowerCase());
  const configs = viewportList.map(v => VIEWPORT_CONFIGS[v]).filter(Boolean);

  if (configs.length === 0) {
    console.error(`No valid viewports. Use: desktop, tablet, mobile`);
    process.exit(1);
  }

  console.error(`Generating responsive variants: ${configs.map(c => c.desc).join(", ")}...`);
  const startTime = Date.now();

  const promises = configs.map((config, i) => {
    const prompt = `${baseBrief}\n\nViewport: ${config.desc}. Adapt the layout for this screen size. ${
      config.suffix === "mobile" ? "Use a single-column layout, larger touch targets, and mobile navigation patterns." :
      config.suffix === "tablet" ? "Use a responsive layout that works for medium screens." :
      ""
    }`;
    const outputPath = path.join(outputDir, `responsive-${config.suffix}.png`);
    const delay = i * 1500;

    return new Promise<{ path: string; success: boolean; error?: string }>(resolve =>
      setTimeout(resolve, delay)
    ).then(() => {
      console.error(`  Starting ${config.desc}...`);
      return generateVariant(apiKey, prompt, outputPath, config.size, quality);
    });
  });

  const results = await Promise.allSettled(promises);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  const succeeded: string[] = [];
  for (const result of results) {
    if (result.status === "fulfilled" && result.value.success) {
      const sz = fs.statSync(result.value.path).size;
      console.error(`  ✓ ${path.basename(result.value.path)} (${(sz / 1024).toFixed(0)}KB)`);
      succeeded.push(result.value.path);
    } else {
      const error = result.status === "fulfilled" ? result.value.error : (result.reason as Error).message;
      console.error(`  ✗ ${error}`);
    }
  }

  console.error(`\n${succeeded.length}/${configs.length} responsive variants generated (${elapsed}s)`);
  console.log(JSON.stringify({
    outputDir,
    viewports: viewportList,
    succeeded: succeeded.length,
    paths: succeeded,
  }, null, 2));
}
