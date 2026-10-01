import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { loadToken, redact, resolveRemoteSettings, tokenIsSingleAgent, resolveBrainMode } from "../../src/remote/settings.js";
import { WarnLimiter, formatRecallBlock } from "../../src/remote/register.js";

test("defaults: local mode, 127.0.0.1:18790, sharedRecall on", () => {
  expect(resolveBrainMode({})).toBe("local");
  expect(resolveBrainMode({ brainMode: "nonsense" as never })).toBe("local");
  const s = resolveRemoteSettings({});
  expect(s).toMatchObject({ mode: "local", url: "http://127.0.0.1:18790", sharedRecall: true, timeoutMs: 2500 });
  expect(resolveRemoteSettings({ brainUrl: "http://h:1/", remoteTimeoutMs: 5, sharedRecall: false })).toMatchObject({ url: "http://h:1", timeoutMs: 100, sharedRecall: false });
});

test("token precedence: file > env > inline; unreadable file does not fall through", () => {
  const dir = mkdtempSync(join(tmpdir(), "ow-tok-"));
  writeFileSync(join(dir, "main.token"), "swt_fromfile\n");
  const env = { OPENWAVE_BRAIN_TOKEN: "swt_fromenv" };
  expect(loadToken({ brainTokenFile: join(dir, "{agentId}.token"), brainToken: "swt_inline" }, "main", env)).toEqual({ ok: true, token: "swt_fromfile", source: "file" });
  expect(loadToken({ brainToken: "swt_inline" }, "main", env)).toEqual({ ok: true, token: "swt_fromenv", source: "env" });
  expect(loadToken({ brainToken: "swt_inline" }, "main", {})).toEqual({ ok: true, token: "swt_inline", source: "inline" });
  const missing = loadToken({ brainTokenFile: join(dir, "nope.token") }, "main", env);
  expect(missing.ok).toBe(false);
  expect(missing.source).toBe("file");
  expect(loadToken({}, "main", {})).toMatchObject({ ok: false, source: "none" });
  expect(tokenIsSingleAgent({ brainTokenFile: "/x/{agentId}.token" })).toBe(false);
  expect(tokenIsSingleAgent({ brainToken: "a" })).toBe(true);
});

test("redact scrubs tokens and bearer headers", () => {
  expect(redact("Authorization: Bearer swt_abc and swt_def", "swt_abc")).not.toMatch(/swt_abc|swt_def/);
});

test("WarnLimiter emits once per window and counts suppressed", () => {
  let now = 0;
  const w = new WarnLimiter(1000, () => now);
  expect(w.take("k")).toBe(0);
  expect(w.take("k")).toBeNull();
  expect(w.take("k")).toBeNull();
  now = 1500;
  expect(w.take("k")).toBe(2);
});

test("formatRecallBlock keeps the local line format and tags shared hits", () => {
  const hits = [
    { brain: "private" as const, id: "1", type: "semantic", label: "A", content: "aaa", score: 1, writer: "x" },
    { brain: "shared" as const, id: "2", type: "goal", label: "G", content: "ggg", score: 1, writer: "x" },
  ];
  expect(formatRecallBlock(hits, "chat", false).split("\n").slice(1)).toEqual(["[semantic] A: aaa", "[goal·shared] G: ggg"]);
  expect(formatRecallBlock(hits, "chat", true)).not.toContain("G: ggg");
  expect(formatRecallBlock([], "chat", false)).toBe("");
});
