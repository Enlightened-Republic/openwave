import { expect, test } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { hasExternalMemoryCoreWorkspace } from "../src/memory-detection.js";

// Minimal stand-in for the slice of the plugin API this helper needs.
function apiWithWorkspaceDir(dir: string | undefined) {
  return {
    runtime: {
      agent: {
        resolveAgentWorkspaceDir: (_cfg: unknown, _agentId: string) => dir,
      },
    },
  };
}

test("returns false when the host does not expose runtime.agent.resolveAgentWorkspaceDir (older host)", () => {
  const api = {}; // no `runtime` at all
  expect(hasExternalMemoryCoreWorkspace(api, {}, "main")).toBe(false);
});

test("returns false when resolveAgentWorkspaceDir returns no directory", () => {
  const api = apiWithWorkspaceDir(undefined);
  expect(hasExternalMemoryCoreWorkspace(api, {}, "main")).toBe(false);
});

test("returns false when neither MEMORY.md nor USER.md exist at the resolved workspace, via the injected checker", () => {
  const api = apiWithWorkspaceDir("/some/workspace");
  const result = hasExternalMemoryCoreWorkspace(api, {}, "main", () => false);
  expect(result).toBe(false);
});

test("returns true when the injected checker reports MEMORY.md as present and non-trivial", () => {
  const api = apiWithWorkspaceDir("/some/workspace");
  const seen: string[] = [];
  const result = hasExternalMemoryCoreWorkspace(api, {}, "main", (path) => {
    seen.push(path);
    return path.endsWith("MEMORY.md");
  });
  expect(result).toBe(true);
  expect(seen).toContain(join("/some/workspace", "MEMORY.md"));
});

test("returns true when only USER.md is present and non-trivial", () => {
  const api = apiWithWorkspaceDir("/some/workspace");
  const result = hasExternalMemoryCoreWorkspace(api, {}, "main", (path) => path.endsWith("USER.md"));
  expect(result).toBe(true);
});

test("real filesystem default: detects a non-empty MEMORY.md on disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "openwave-memdetect-"));
  try {
    writeFileSync(join(dir, "MEMORY.md"), "- Keep the gateway on loopback.\n");
    const api = apiWithWorkspaceDir(dir);
    expect(hasExternalMemoryCoreWorkspace(api, {}, "main")).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real filesystem default: an empty/whitespace-only MEMORY.md does not count (fresh scaffold, not a curated host)", () => {
  const dir = mkdtempSync(join(tmpdir(), "openwave-memdetect-"));
  try {
    writeFileSync(join(dir, "MEMORY.md"), "   \n\n");
    const api = apiWithWorkspaceDir(dir);
    expect(hasExternalMemoryCoreWorkspace(api, {}, "main")).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real filesystem default: no MEMORY.md or USER.md at all returns false", () => {
  const dir = mkdtempSync(join(tmpdir(), "openwave-memdetect-"));
  try {
    const api = apiWithWorkspaceDir(dir);
    expect(hasExternalMemoryCoreWorkspace(api, {}, "main")).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
