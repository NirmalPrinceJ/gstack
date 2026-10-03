/**
 * Generate N design variants from a brief.
 * Uses staggered parallel: 1s delay between API calls to avoid rate limits.
 * Falls back to exponential backoff on 429s.
 *
 * Every run writes into its own round directory (<output-dir>/round-<N>/,
 * reserved atomically) with a manifest.json of what was saved, so a
 * regenerate round never overwrites the images an earlier round paid for
 * (#1529). The paid request and the local write retry separately: a disk
 * error retries the write, never the purchase.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { requireApiKey } from "./auth";
import { receiptedFetch } from "./receipted-fetch";
import { imageRequestBody, modelRejectionHint } from "./models";
import { parseBrief } from "./brief";
import { normalizeIntFlag } from "./flag-utils";

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

/**
 * Generate a single variant with retry on 429.
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
  const maxRetries = 3;
  const MAX_RETRY_AFTER_MS = 60_000; // cap honored Retry-After to bound stalls
  let lastError = "";
  let skipLeadingDelay = false;
  let body: string;
  try {
    body = imageRequestBody(prompt, { size, quality });
  } catch (err: any) {
    return { path: outputPath, success: false, error: err.message };
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

    try {
      const response = await receiptedFetch("variants-image-request", "https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body,
        signal: controller.signal,
      }, fetchFn);

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
          return { path: outputPath, success: false, error: "OpenAI organization verification required. Go to https://platform.openai.com/settings/organization to verify." };
        }
        return { path: outputPath, success: false, error: `API error (${response.status}): ${error.slice(0, 200)}${modelRejectionHint(response.status, error, "image")}` };
      }

      const data = await response.json() as any;
      const imageItem = data.output?.find((item: any) => item.type === "image_generation_call");

      if (!imageItem?.result) {
        return { path: outputPath, success: false, error: "No image data in response" };
      }

      return saveVariantImage(outputPath, Buffer.from(imageItem.result, "base64"));
    } catch (err: any) {
      clearTimeout(timeout);
      if (err.name === "AbortError") {
        return { path: outputPath, success: false, error: "Timeout (240s)" };
      }
      lastError = err.message;
    }
  }

  return { path: outputPath, success: false, error: lastError };
}

export interface VariantResult {
  path: string;
  success: boolean;
  error?: string;
  /** Where a paid image was kept when the output path could not be written. */
  rescuedPath?: string;
}

/**
 * Write an image that was already paid for. Retries the local write (temp
 * file + rename) and, if the output path stays unwritable, keeps the bytes in
 * the system temp dir instead of dropping them. Never re-requests the image.
 */
export function saveVariantImage(outputPath: string, bytes: Buffer, attempts = 3): VariantResult {
  let lastError = "";
  for (let i = 0; i < attempts; i++) {
    const tmp = `${outputPath}.${process.pid}.${i}.tmp`;
    try {
      fs.writeFileSync(tmp, bytes);
      fs.renameSync(tmp, outputPath);
      return { path: outputPath, success: true };
    } catch (err: any) {
      lastError = err.message;
      try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    }
  }
  const error = `image was generated but could not be saved to ${outputPath} (${lastError})`;
  try {
    const rescueDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-variant-rescue-"));
    const rescuedPath = path.join(rescueDir, path.basename(outputPath));
    fs.writeFileSync(rescuedPath, bytes);
    return { path: outputPath, success: false, error: `${error}; kept at ${rescuedPath}`, rescuedPath };
  } catch {
    return { path: outputPath, success: false, error };
  }
}

export interface RoundManifestEntry {
  label: string;
  file: string;
  status: "saved" | "failed";
  error?: string;
  rescuedPath?: string;
}

/**
 * Reserve the next free round-<N> directory under outputDir. mkdir without
 * `recursive` fails with EEXIST when the name is taken, so two runs (or two
 * sessions) can never be handed the same directory.
 */
export function reserveRoundDir(outputDir: string): { round: number; dir: string } {
  fs.mkdirSync(outputDir, { recursive: true });
  const taken = fs.readdirSync(outputDir)
    .map(name => /^round-(\d+)$/.exec(name))
    .filter((m): m is RegExpExecArray => m !== null)
    .map(m => Number(m[1]));
  for (let round = taken.length ? Math.max(...taken) + 1 : 1; ; round++) {
    const dir = path.join(outputDir, `round-${round}`);
    try {
      fs.mkdirSync(dir);
      return { round, dir };
    } catch (err: any) {
      if (err.code !== "EEXIST") throw err;
    }
  }
}

/** Write the round's manifest last, atomically, from the results actually on disk. */
function writeRoundManifest(dir: string, round: number, kind: "style" | "responsive", entries: RoundManifestEntry[]): string {
  const manifestPath = path.join(dir, "manifest.json");
  const tmp = `${manifestPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ schema: 1, round, kind, created_at: new Date().toISOString(), variants: entries }, null, 2) + "\n");
  fs.renameSync(tmp, manifestPath);
  return manifestPath;
}

function manifestEntries(labels: string[], results: PromiseSettledResult<VariantResult>[]): RoundManifestEntry[] {
  return results.map((result, i) => {
    const file = result.status === "fulfilled" ? path.basename(result.value.path) : `${labels[i]}.png`;
    if (result.status === "fulfilled" && result.value.success && fs.existsSync(result.value.path)) {
      return { label: labels[i], file, status: "saved" };
    }
    const error = result.status === "fulfilled" ? result.value.error : (result.reason as Error).message;
    const rescuedPath = result.status === "fulfilled" ? result.value.rescuedPath : undefined;
    return { label: labels[i], file, status: "failed", error, ...(rescuedPath ? { rescuedPath } : {}) };
  });
}

/**
 * Generate N variants with staggered parallel execution.
 */
export async function variants(options: VariantsOptions): Promise<void> {
  const apiKey = requireApiKey();
  const baseBrief = options.briefFile
    ? parseBrief(options.briefFile, true)
    : parseBrief(options.brief!, false);

  const quality = options.quality || "high";

  const { round, dir: roundDir } = reserveRoundDir(options.outputDir);

  // If viewports specified, generate responsive variants instead of style variants
  if (options.viewports) {
    await generateResponsiveVariants(apiKey, baseBrief, roundDir, round, options.viewports, quality);
    return;
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

  console.error(`Generating ${count} variants into ${roundDir}...`);
  const startTime = Date.now();

  // Staggered parallel: start each call 1.5s apart
  const promises: Promise<VariantResult>[] = [];
  const labels: string[] = [];

  for (let i = 0; i < count; i++) {
    const variation = STYLE_VARIATIONS[i] || "";
    const prompt = variation
      ? `${baseBrief}\n\nStyle direction: ${variation}`
      : baseBrief;

    labels.push(String.fromCharCode(65 + i));
    const outputPath = path.join(roundDir, `variant-${labels[i]}.png`);

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
  const entries = manifestEntries(labels, results);
  const manifest = writeRoundManifest(roundDir, round, "style", entries);
  const succeeded = entries.filter(e => e.status === "saved").map(e => path.join(roundDir, e.file));

  for (const e of entries) {
    if (e.status === "saved") {
      const size = fs.statSync(path.join(roundDir, e.file)).size;
      console.error(`  ✓ ${e.file} (${(size / 1024).toFixed(0)}KB)`);
    } else {
      console.error(`  ✗ ${e.file}: ${e.error}`);
    }
  }

  console.error(`\n${succeeded.length}/${count} variants generated in round ${round} (${elapsed}s)`);

  // Output structured result to stdout
  console.log(JSON.stringify({
    outputDir: options.outputDir,
    round,
    roundDir,
    manifest,
    count,
    succeeded: succeeded.length,
    failed: entries.length - succeeded.length,
    paths: succeeded,
    errors: entries.filter(e => e.status === "failed").map(e => e.file),
  }, null, 2));
}

const VIEWPORT_CONFIGS: Record<string, { size: string; suffix: string; desc: string }> = {
  desktop: { size: "1536x1024", suffix: "desktop", desc: "Desktop (1536x1024)" },
  tablet: { size: "1024x1024", suffix: "tablet", desc: "Tablet (1024x1024)" },
  mobile: { size: "1024x1536", suffix: "mobile", desc: "Mobile (1024x1536, portrait)" },
};

async function generateResponsiveVariants(
  apiKey: string,
  baseBrief: string,
  roundDir: string,
  round: number,
  viewports: string,
  quality: string,
): Promise<void> {
  const viewportList = viewports.split(",").map(v => v.trim().toLowerCase());
  const configs = viewportList.map(v => VIEWPORT_CONFIGS[v]).filter(Boolean);

  if (configs.length === 0) {
    console.error(`No valid viewports. Use: desktop, tablet, mobile`);
    fs.rmdirSync(roundDir);
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
    const outputPath = path.join(roundDir, `responsive-${config.suffix}.png`);
    const delay = i * 1500;

    return new Promise<VariantResult>(resolve =>
      setTimeout(resolve, delay)
    ).then(() => {
      console.error(`  Starting ${config.desc}...`);
      return generateVariant(apiKey, prompt, outputPath, config.size, quality);
    });
  });

  const results = await Promise.allSettled(promises);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const entries = manifestEntries(configs.map(c => c.suffix), results);
  const manifest = writeRoundManifest(roundDir, round, "responsive", entries);
  const succeeded = entries.filter(e => e.status === "saved").map(e => path.join(roundDir, e.file));

  for (const e of entries) {
    if (e.status === "saved") {
      const sz = fs.statSync(path.join(roundDir, e.file)).size;
      console.error(`  ✓ ${e.file} (${(sz / 1024).toFixed(0)}KB)`);
    } else {
      console.error(`  ✗ ${e.file}: ${e.error}`);
    }
  }

  console.error(`\n${succeeded.length}/${configs.length} responsive variants generated in round ${round} (${elapsed}s)`);
  console.log(JSON.stringify({
    outputDir: path.dirname(roundDir),
    round,
    roundDir,
    manifest,
    viewports: viewportList,
    succeeded: succeeded.length,
    paths: succeeded,
  }, null, 2));
}
