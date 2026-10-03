/**
 * v1.91.17.0 migration (placeholder name; the release queue may rename it):
 * step 1 records a pending memory-ingest reconcile (A1) without calling gbrain.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";

const ROOT = path.resolve(import.meta.dir, "..");
const MIGRATION = path.join(ROOT, "gstack-upgrade", "migrations", "v1.91.17.0.sh");

let home: string;
let gstackHome: string;
let bin: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "mig-v1.91.17-"));
  gstackHome = path.join(home, ".gstack");
  bin = path.join(home, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "gbrain"), `#!/bin/sh\necho "$@" >> "${home}/gbrain-calls.log"\nexit 1\n`, { mode: 0o755 });
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

function run() {
  const r = spawnSync("bash", [MIGRATION], {
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, GSTACK_HOME: gstackHome },
    encoding: "utf-8",
    cwd: home,
    timeout: 30_000,
  });
  return { code: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
}

describe("v1.91.17.0 migration: memory reconcile pending (A1)", () => {
  test("marks a reconcile pending on an existing ingest state and never calls gbrain", () => {
    fs.mkdirSync(gstackHome, { recursive: true });
    const statePath = path.join(gstackHome, ".transcript-ingest-state.json");
    fs.writeFileSync(statePath, JSON.stringify({
      schema_version: 1, last_writer: "gstack-memory-ingest",
      sessions: { "/t/a.jsonl": { mtime_ns: 1, sha256: "h", ingested_at: "2026-09-01T00:00:00Z", page_slug: "transcripts/x/a" } },
    }));
    const first = run();
    expect(first.code).toBe(0);
    expect(first.stdout).toContain("reconcile pending");
    const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    expect(state.schema_version).toBe(2);
    expect(state.reconcile.pending).toBe(true);
    expect(state.sessions["/t/a.jsonl"]).toMatchObject({ status: "ingested", source_id: "default" });
    expect(run().code).toBe(0);
    expect(fs.existsSync(path.join(home, "gbrain-calls.log"))).toBe(false);
  });

  test("is a no-op without an ingest state", () => {
    expect(run().code).toBe(0);
    expect(fs.existsSync(path.join(gstackHome, ".transcript-ingest-state.json"))).toBe(false);
  });
});
