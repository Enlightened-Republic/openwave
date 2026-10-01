import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

import {
  HEARTBEAT_TOKEN, INTERNAL_WAKE_MARKERS, NoisePairTracker, SILENT_REPLY_TOKEN, SYSTEM_RUN_TRIGGERS,
  classifySystemTurn, compileSystemTurnPatterns, isInternalWakeText, isSystemNoiseTurn, resolveSystemNoiseSettings,
} from "../src/system-noise.js";
import { HEARTBEAT_PROMPT_9_7, KEEP, NOISE } from "./fixtures/system-noise-fixtures.js";

describe("isSystemNoiseTurn — fixtures", () => {
  test.each(NOISE)("skips: %s", (_name, turn, reason) => {
    const v = classifySystemTurn(turn);
    expect(v.skip).toBe(true);
    if (v.skip) expect(v.reason).toBe(reason);
  });
  test.each(KEEP)("keeps: %s", (_name, turn) => {
    expect(isSystemNoiseTurn(turn)).toBe(false);
  });
  test("structured flags win over text (reason is the structured one)", () => {
    const v = classifySystemTurn({ role: "assistant", content: "NO_REPLY", trigger: "heartbeat" });
    expect(v).toMatchObject({ skip: true, via: "structured", reason: "trigger:heartbeat" });
  });
  test("skipSystemTurns=false disables everything", () => {
    for (const [, t] of NOISE) expect(isSystemNoiseTurn(t, { enabled: false })).toBe(false);
  });
});

describe("extra patterns (systemTurnPatterns)", () => {
  test("compiles valid patterns case-insensitively and reports invalid ones", () => {
    const { patterns, invalid } = compileSystemTurnPatterns(["^\\[cron triage\\]", "(", 42, ""]);
    expect(patterns).toHaveLength(1);
    expect(invalid).toEqual(["(", "42", ""]);
    expect(isSystemNoiseTurn({ role: "user", content: "[CRON TRIAGE] queue length 4" }, { extraPatterns: patterns })).toBe(true);
    expect(isSystemNoiseTurn({ role: "user", content: "please triage the cron queue" }, { extraPatterns: patterns })).toBe(false);
  });
  test("resolveSystemNoiseSettings defaults to enabled", () => {
    expect(resolveSystemNoiseSettings({}).enabled).toBe(true);
    expect(resolveSystemNoiseSettings({ skipSystemTurns: false }).enabled).toBe(false);
    expect(resolveSystemNoiseSettings({ systemTurnPatterns: ["^x$"] }).extraPatterns).toHaveLength(1);
  });
});

describe("NoisePairTracker", () => {
  test("pairs a skipped user turn with the next reply in the same session only, once", () => {
    let now = 1_000;
    const p = new NoisePairTracker(() => now);
    p.markUserSkipped("s1");
    expect(p.takeReplySkip("s2")).toBe(false);
    expect(p.takeReplySkip("s1")).toBe(true);
    expect(p.takeReplySkip("s1")).toBe(false);
    p.markUserSkipped("s1");
    p.clear("s1"); // a real user turn arrived
    expect(p.takeReplySkip("s1")).toBe(false);
    p.markUserSkipped("s1");
    now += 11 * 60_000; // window expired
    expect(p.takeReplySkip("s1")).toBe(false);
  });
});

// Pin the classifier to the markers the installed OpenClaw dev dependency
// actually emits (2026.9.7): if OpenClaw renames a marker, this fails.
describe("markers match the installed openclaw package", () => {
  // openclaw's exports map hides package.json; walk up from the repo root instead.
  const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules", "openclaw");
  const dist = join(pkgDir, "dist");
  const files = readdirSync(dist).filter((f) => f.endsWith(".mjs"));
  const read = (pred: (s: string) => boolean): string => {
    for (const f of files) {
      if (!/^(heartbeat|tokens)-/.test(f)) continue;
      const s = readFileSync(join(dist, f), "utf8");
      if (pred(s)) return s;
    }
    throw new Error("marker source not found in openclaw dist");
  };
  test("openclaw dev dependency is >= 2026.9.7", () => {
    const v = (JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as { version: string }).version;
    const [y, m, d] = v.split(".").map(Number);
    expect(y! * 10_000 + m! * 100 + d!).toBeGreaterThanOrEqual(2026_09_07);
  });
  test("every INTERNAL_WAKE_TRANSCRIPT_PROMPTS value is classified as a wake", () => {
    const src = read((s) => s.includes("const INTERNAL_WAKE_TRANSCRIPT_PROMPTS = {"));
    const block = src.slice(src.indexOf("const INTERNAL_WAKE_TRANSCRIPT_PROMPTS = {"));
    const body = block.slice(0, block.indexOf("};"));
    const values = [...body.matchAll(/:\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`) as string);
    expect(values.length).toBeGreaterThanOrEqual(4);
    for (const v of values) {
      expect(isInternalWakeText(v)).toBe(true);
      expect(INTERNAL_WAKE_MARKERS.some((mk) => v.startsWith(mk))).toBe(true);
    }
  });
  test("silent / heartbeat tokens and the default heartbeat prompt", () => {
    const tokens = read((s) => s.includes("const SILENT_REPLY_TOKEN = "));
    expect(tokens).toContain(`const SILENT_REPLY_TOKEN = "${SILENT_REPLY_TOKEN}"`);
    expect(tokens).toContain(`const HEARTBEAT_TOKEN = "${HEARTBEAT_TOKEN}"`);
    const hb = read((s) => s.includes("const HEARTBEAT_CONTEXT_PROMPT = "));
    const ctx = /const HEARTBEAT_CONTEXT_PROMPT = `([^`]*)`/.exec(hb)?.[1];
    expect(ctx).toBeTruthy();
    expect(HEARTBEAT_PROMPT_9_7.startsWith(ctx!)).toBe(true);
    expect(isInternalWakeText(`${ctx} If nothing needs attention, reply NO_REPLY.`)).toBe(true);
  });
  test("EmbeddedRunTrigger still contains the system triggers we skip", () => {
    const dts = readdirSync(dist).filter((f) => f.startsWith("plugin-entry-") && f.endsWith(".d.ts"));
    const src = dts.map((f) => readFileSync(join(dist, f), "utf8")).join("\n");
    const m = /type EmbeddedRunTrigger = ([^;]+);/.exec(src);
    expect(m).toBeTruthy();
    for (const t of SYSTEM_RUN_TRIGGERS) expect(m![1]).toContain(`"${t}"`);
    expect(src).toMatch(/INPUT_PROVENANCE_KIND_VALUES: readonly \[[^\]]*"internal_system"/);
  });
});
