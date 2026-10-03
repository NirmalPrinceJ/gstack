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
import {
  emitResult,
  exitCodeFor,
  newAccounting,
  persistImage,
  type ExitCode,
  type Recovery,
  type RunAccounting,
} from "./persist";

export interface VariantsOptions {
  brief?: string;
  briefFile?: string;
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
  requested: string;
  path: string;
  success: boolean;
  error?: string;
  recovered?: Recovery;
}

/**
 * Request one variant image, retrying only the API call on 429. Returns the
 * base64 image or the final error; nothing here touches the filesystem.
 */
export async function requestVariantImage(
  apiKey: string,
  prompt: string,
  size: string,
  quality: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<{ imageData: string } | { error: string }> {
  const maxRetries = 3;
  const MAX_RETRY_AFTER_MS = 60_000; // cap honored Retry-After to bound stalls
  let lastError = "";
  let skipLeadingDelay = false;
  let body: string;
  try {
    body = imageRequestBody(prompt, { size, quality });
  } catch (err: any) {
    return { error: err.message };
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0 && !skipLeadingDelay) {
      // Exponential backoff: 2s, 4s, 8s
      const delay = Math.pow(2, attempt) * 1000;
      console.error(`  Rate limited, retrying in ${delay / 1000}s...`);
      await new Promise(r => setTimeout(r, delay));
    }
    skipLeadingDelay = false;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 240_000);

    let response: Response;
    try {
      response = await receiptedFetch("variants-image-request", "https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body,
        signal: controller.signal,
      }, fetchFn);
    } catch (err: any) {
      clearTimeout(timeout);
      if (err.name === "AbortError") return { error: "Timeout (240s)" };
      lastError = err.message;
      continue;
    }
    clearTimeout(timeout);

    if (response.status === 429) {
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
            await new Promise(resolve => setTimeout(resolve, waitMs));
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
      if (response.status === 403 && error.includes("organization must be verified")) {
        return { error: "OpenAI organization verification required. Go to https://platform.openai.com/settings/organization to verify." };
      }
      return { error: `API error (${response.status}): ${error.slice(0, 200)}${modelRejectionHint(response.status, error, "image")}` };
    }

    try {
      const data = await response.json() as any;
      const imageItem = data.output?.find((item: any) => item.type === "image_generation_call");
      if (!imageItem?.result) return { error: "No image data in response" };
      return { imageData: imageItem.result };
    } catch (err: any) {
      return { error: `Unreadable API response: ${err.message}` };
    }
  }

  return { error: lastError };
}

/**
 * Generate a single variant: one API request (with 429 retry), then exactly
 * one persistence attempt on the received bytes. A save failure is reported
 * with its path and never triggers another request.
 *
 * Exported for testability. Pass `fetchFn` to inject a stubbed fetch in tests;
 * production code uses the global fetch by default.
 */
export async function generateVariant(
  apiKey: string,
  prompt: string,
  outputPath: string,
  size: string,
  quality: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<VariantResult> {
  const received = await requestVariantImage(apiKey, prompt, size, quality, fetchFn);
  if ("error" in received) {
    return { requested: outputPath, path: outputPath, success: false, error: received.error };
  }
  const outcome = persistImage(received.imageData, outputPath);
  if (outcome.ok) return { requested: outputPath, path: outcome.path, success: true };
  return {
    requested: outputPath,
    path: outputPath,
    success: false,
    error: outcome.failure.reason,
    ...(outcome.recovered ? { recovered: outcome.recovered } : {}),
  };
}

interface VariantJob {
  outputPath: string;
  prompt: string;
  size: string;
  label: string;
}

/** Launch jobs 1.5s apart, wait for all, and fold them into run accounting. */
async function runVariantJobs(apiKey: string, quality: string, jobs: VariantJob[]): Promise<{
  acct: RunAccounting;
  errors: string[];
}> {
  const promises = jobs.map((job, i) =>
    new Promise(resolve => setTimeout(resolve, i * 1500)).then(() => {
      console.error(`  Starting ${job.label}...`);
      return generateVariant(apiKey, job.prompt, job.outputPath, job.size, quality);
    })
  );
  const results = await Promise.allSettled(promises);

  const acct = newAccounting(jobs.length);
  const errors: string[] = [];
  results.forEach((result, i) => {
    const requested = jobs[i].outputPath;
    if (result.status === "fulfilled" && result.value.success) {
      const size = fs.statSync(result.value.path).size;
      console.error(`  ✓ ${path.basename(result.value.path)} (${(size / 1024).toFixed(0)}KB)`);
      acct.saved.push(result.value.path);
      return;
    }
    const reason = result.status === "fulfilled" ? result.value.error || "unknown error" : (result.reason as Error).message;
    console.error(`  ✗ ${path.basename(requested)}: ${reason}`);
    errors.push(path.basename(requested));
    acct.failures.push({ file: requested, reason });
    if (result.status === "fulfilled" && result.value.recovered) acct.recovered.push(result.value.recovered);
  });
  return { acct, errors };
}

function emitVariantsResult(outputDir: string, acct: RunAccounting, errors: string[], extra: Record<string, unknown> = {}): ExitCode {
  return emitResult({
    outputDir,
    ...extra,
    count: acct.requested,
    succeeded: acct.saved.length,
    failed: errors.length,
    paths: acct.saved,
    errors,
    requested: acct.requested,
    saved: acct.saved,
    selected: acct.saved,
    failures: acct.failures,
    recovered: acct.recovered,
  }, exitCodeFor(acct.saved.length > 0, acct.saved.length));
}

/**
 * Generate N variants with staggered parallel execution.
 */
export async function variants(options: VariantsOptions): Promise<ExitCode> {
  let apiKey: string;
  let baseBrief: string;
  try {
    apiKey = requireApiKey();
    baseBrief = options.briefFile
      ? parseBrief(options.briefFile, true)
      : parseBrief(options.brief!, false);
  } catch (err: any) {
    const reason = err?.message || String(err);
    console.error(reason);
    const acct = newAccounting(0);
    acct.failures.push({ file: options.outputDir, reason });
    return emitVariantsResult(options.outputDir, acct, []);
  }

  const quality = options.quality || "high";

  // If viewports specified, generate responsive variants instead of style variants
  if (options.viewports) {
    return generateResponsiveVariants(apiKey, baseBrief, options.outputDir, options.viewports, quality);
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

  const jobs: VariantJob[] = [];
  for (let i = 0; i < count; i++) {
    const variation = STYLE_VARIATIONS[i] || "";
    const letter = String.fromCharCode(65 + i);
    jobs.push({
      outputPath: path.join(options.outputDir, `variant-${letter}.png`),
      prompt: variation ? `${baseBrief}\n\nStyle direction: ${variation}` : baseBrief,
      size,
      label: `variant ${letter}`,
    });
  }

  const { acct, errors } = await runVariantJobs(apiKey, quality, jobs);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.error(`\n${acct.saved.length}/${count} variants generated (${elapsed}s)`);
  return emitVariantsResult(options.outputDir, acct, errors);
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
): Promise<ExitCode> {
  const viewportList = viewports.split(",").map(v => v.trim().toLowerCase());
  const configs = viewportList.map(v => VIEWPORT_CONFIGS[v]).filter(Boolean);

  if (configs.length === 0) {
    const reason = `No valid viewports. Use: desktop, tablet, mobile`;
    console.error(reason);
    const acct = newAccounting(viewportList.length);
    acct.failures.push({ file: outputDir, reason });
    return emitVariantsResult(outputDir, acct, [], { viewports: viewportList });
  }

  console.error(`Generating responsive variants: ${configs.map(c => c.desc).join(", ")}...`);
  const startTime = Date.now();

  const jobs: VariantJob[] = configs.map(config => ({
    outputPath: path.join(outputDir, `responsive-${config.suffix}.png`),
    prompt: `${baseBrief}\n\nViewport: ${config.desc}. Adapt the layout for this screen size. ${
      config.suffix === "mobile" ? "Use a single-column layout, larger touch targets, and mobile navigation patterns." :
      config.suffix === "tablet" ? "Use a responsive layout that works for medium screens." :
      ""
    }`,
    size: config.size,
    label: config.desc,
  }));

  const { acct, errors } = await runVariantJobs(apiKey, quality, jobs);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.error(`\n${acct.saved.length}/${configs.length} responsive variants generated (${elapsed}s)`);
  return emitVariantsResult(outputDir, acct, errors, { viewports: viewportList });
}
