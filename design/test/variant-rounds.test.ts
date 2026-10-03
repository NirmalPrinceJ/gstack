/**
 * F4 (#1529): paid design variants survive regenerate rounds.
 *
 * Before: every `$D variants` run wrote <output-dir>/variant-A.png ..., so
 * round 2 overwrote round 1's images, and a local write failure was caught
 * by the request retry loop, which bought the same image again.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { generateVariant, variants } from "../src/variants";

let calls = 0;
let tmpDir: string;
const saved = { fetch: globalThis.fetch, key: process.env.OPENAI_API_KEY, home: process.env.GSTACK_HOME, log: console.log, err: console.error };
let stdout: string[] = [];

/** Each paid call returns distinct bytes, so a later round overwriting an earlier file is visible. */
function stubFetch(): typeof globalThis.fetch {
  return (async (_input: unknown, _init?: unknown) => {
    calls++;
    const bytes = Buffer.from(`image-${calls}`).toString("base64");
    return new Response(JSON.stringify({ output: [{ type: "image_generation_call", result: bytes }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof globalThis.fetch;
}

beforeEach(() => {
  calls = 0;
  stdout = [];
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "variant-rounds-"));
  process.env.GSTACK_HOME = tmpDir;
  process.env.OPENAI_API_KEY = "sk-test-not-real";
  globalThis.fetch = stubFetch();
  console.log = (s: string) => { stdout.push(String(s)); };
  console.error = () => {};
});

afterEach(() => {
  globalThis.fetch = saved.fetch;
  if (saved.key === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = saved.key;
  if (saved.home === undefined) delete process.env.GSTACK_HOME; else process.env.GSTACK_HOME = saved.home;
  console.log = saved.log;
  console.error = saved.err;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function lastResult(): any {
  return JSON.parse(stdout[stdout.length - 1]);
}

describe("F4: collision-safe variant rounds", () => {
  test("round 2 writes a new directory; round 1's paid files and manifest stay intact", async () => {
    const outputDir = path.join(tmpDir, "designs", "mockup");
    await variants({ brief: "a pricing page", count: 2, outputDir });
    const r1 = lastResult();
    const round1B = fs.readFileSync(path.join(r1.roundDir, "variant-B.png"));

    await variants({ brief: "a pricing page, warmer", count: 2, outputDir });
    const r2 = lastResult();

    expect(r1.round).toBe(1);
    expect(r2.round).toBe(2);
    expect(r2.roundDir).not.toBe(r1.roundDir);
    expect(r2.paths.every((p: string) => p.startsWith(r2.roundDir + path.sep))).toBe(true);
    expect(fs.readFileSync(path.join(r1.roundDir, "variant-B.png"))).toEqual(round1B);

    // Choosing a round-1 variant after round 2: the round-1 manifest still
    // resolves label B to a saved file holding round 1's image.
    const m1 = JSON.parse(fs.readFileSync(r1.manifest, "utf-8"));
    const chosen = m1.variants.find((v: any) => v.label === "B");
    expect(chosen.status).toBe("saved");
    expect(fs.readFileSync(path.join(r1.roundDir, chosen.file))).toEqual(round1B);
    expect(fs.readFileSync(path.join(r2.roundDir, "variant-B.png"))).not.toEqual(round1B);
  }, 30_000);

  test("responsive rounds get their own names per round", async () => {
    const outputDir = path.join(tmpDir, "designs", "responsive");
    await variants({ brief: "a dashboard", outputDir, viewports: "desktop" });
    const first = lastResult().paths[0];
    const firstBytes = fs.readFileSync(first);
    await variants({ brief: "a dashboard", outputDir, viewports: "desktop" });
    const second = lastResult().paths[0];
    expect(second).not.toBe(first);
    expect(fs.readFileSync(first)).toEqual(firstBytes);
  }, 30_000);

  test("a reserved round directory is never handed out twice", async () => {
    const outputDir = path.join(tmpDir, "designs", "race");
    fs.mkdirSync(path.join(outputDir, "round-1"), { recursive: true });
    await variants({ brief: "x", count: 1, outputDir });
    expect(lastResult().round).toBe(2);
  }, 30_000);

  test("a local write failure retries the write, never the paid request, and keeps the bytes", async () => {
    const outputPath = path.join(tmpDir, "missing-dir", "variant-A.png");
    const r = await generateVariant("sk-test-not-real", "p", outputPath, "1536x1024", "high", stubFetch());
    expect(calls).toBe(1);
    expect(r.success).toBe(false);
    expect(r.error).toContain("could not be saved");
    expect(r.rescuedPath).toBeDefined();
    expect(fs.readFileSync(r.rescuedPath!, "utf-8")).toBe("image-1");
    fs.rmSync(path.dirname(r.rescuedPath!), { recursive: true, force: true });
  }, 30_000);
});
