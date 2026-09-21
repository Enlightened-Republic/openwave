import { afterAll, afterEach, describe, expect, test, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import * as core from "sharpwave-core";
import { ingestHostMemory, parseMemoryUnits } from "../src/host-memory.js";
import { armSchedulers, disarmSchedulers } from "../src/scheduler.js";

// Research §5.6: mirror MEMORY.md into the graph, read-only. See src/host-memory.ts.

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
afterEach(() => { vi.useRealTimers(); });

function workspace(memory: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), "ow-hm-"));
  dirs.push(dir);
  if (memory !== null) writeFileSync(join(dir, "MEMORY.md"), memory);
  return dir;
}

let n = 0;
const freshAgent = () => `hostmem${++n}`;

const SAMPLE = `# MEMORY.md - Durable Facts

<!-- openclaw:dreaming:managed:start -->
## Company

- **Domains:** the .online site is the flagship and the .tech site is the lab, both deployed on Vercel.
- Short.
- Multi-line fact that keeps going
  on an indented continuation line and
  - a nested bullet that folds into the parent

### Local Source Code Locations

Path of the site source: C:\\Users\\wubbu\\Desktop\\Projects\\enlightened-republic-tech and its sibling.

\`\`\`
- this bullet is inside a code fence and must not split the unit
\`\`\`

## Rules
- Always run the deploy from the project folder, never from the home directory.
<!-- openclaw:dreaming:managed:end -->
`;

describe("parseMemoryUnits", () => {
  const units = parseMemoryUnits(SAMPLE);

  test("one unit per top-level bullet or paragraph, with heading path", () => {
    const texts = units.map((u) => u.text);
    expect(texts.some((t) => t.startsWith("**Domains:**"))).toBe(true);
    const domains = units.find((u) => u.text.startsWith("**Domains:**"))!;
    expect(domains.heading).toBe("MEMORY.md - Durable Facts › Company");
    const path = units.find((u) => u.text.startsWith("Path of the site source"))!;
    expect(path.heading).toBe("MEMORY.md - Durable Facts › Company › Local Source Code Locations");
    const rule = units.find((u) => u.text.startsWith("Always run the deploy"))!;
    expect(rule.heading).toBe("MEMORY.md - Durable Facts › Rules");
  });

  test("tiny bullets and bare link lines are dropped", () => {
    expect(units.some((u) => u.text === "Short.")).toBe(false);
    const withLinks = parseMemoryUnits("## Related\n\n- [Identity file](./IDENTITY.md)\n- [User directives](./USER.md)\n");
    expect(withLinks).toEqual([]);
    const real = parseMemoryUnits("- See [the deploy doc](./deploy.md) before every production release of the site.\n");
    expect(real.length).toBe(1);
  });

  test("nested bullets and continuation lines fold into the parent", () => {
    const multi = units.find((u) => u.text.startsWith("Multi-line fact"))!;
    expect(multi.text).toContain("indented continuation line");
    expect(multi.text).toContain("a nested bullet that folds into the parent");
  });

  test("html comment markers never become units, and line numbers stay true", () => {
    expect(units.some((u) => u.text.includes("openclaw:dreaming"))).toBe(false);
    const lines = SAMPLE.split("\n");
    for (const u of units) {
      expect(lines[u.startLine - 1]).toContain(u.text.split(" ")[0].replace(/^\*\*/, "").slice(0, 4));
    }
  });

  test("a fenced block does not split a unit", () => {
    const fenced = units.find((u) => u.text.includes("inside a code fence"));
    expect(fenced).toBeDefined();
  });

  test("keys are stable across parses and change with the text", () => {
    const again = parseMemoryUnits(SAMPLE);
    expect(again.map((u) => u.key)).toEqual(units.map((u) => u.key));
    const edited = parseMemoryUnits(SAMPLE.replace("flagship", "primary"));
    expect(edited.find((u) => u.text.startsWith("**Domains:**"))!.key)
      .not.toBe(units.find((u) => u.text.startsWith("**Domains:**"))!.key);
  });
});

function hostNodes(agent: string) {
  return core.getDb(agent)
    .prepare("SELECT id, label, source, valid_until FROM nodes WHERE source LIKE 'memory-core:MEMORY.md%'")
    .all() as Array<{ id: string; label: string; source: string; valid_until: number | null }>;
}

describe("ingestHostMemory", () => {
  test("writes one tagged node per fact and never modifies MEMORY.md", () => {
    const agent = freshAgent();
    const dir = workspace(SAMPLE);
    const before = { body: readFileSync(join(dir, "MEMORY.md"), "utf8"), mtime: statSync(join(dir, "MEMORY.md")).mtimeMs };

    const res = ingestHostMemory(agent, dir);
    expect(res.status).toBe("ingested");
    const nodes = hostNodes(agent);
    expect(nodes.length).toBe(parseMemoryUnits(SAMPLE).length);
    for (const node of nodes) expect(node.source).toMatch(/^memory-core:MEMORY\.md#L\d+-L\d+$/);
    expect(nodes.some((x) => x.label === "Domains:")).toBe(true);

    expect(readFileSync(join(dir, "MEMORY.md"), "utf8")).toBe(before.body);
    expect(statSync(join(dir, "MEMORY.md")).mtimeMs).toBe(before.mtime);
  });

  test("an unchanged file is skipped, and re-ingest with a touched mtime keeps every node", () => {
    const agent = freshAgent();
    const dir = workspace(SAMPLE);
    const first = ingestHostMemory(agent, dir);
    expect(ingestHostMemory(agent, dir).status).toBe("unchanged");

    const future = new Date(Date.now() + 60_000);
    utimesSync(join(dir, "MEMORY.md"), future, future);
    const again = ingestHostMemory(agent, dir);
    expect(again.status).toBe("ingested");
    if (again.status === "ingested" && first.status === "ingested") {
      expect(again.written).toBe(0);
      expect(again.kept).toBe(first.units);
      expect(again.retired).toBe(0);
    }
    expect(hostNodes(agent).length).toBe(first.status === "ingested" ? first.units : -1);
  });

  test("an edited fact retires its old node and writes a new one", () => {
    const agent = freshAgent();
    const dir = workspace(SAMPLE);
    ingestHostMemory(agent, dir);
    const oldNode = hostNodes(agent).find((x) => x.label === "Domains:")!;

    writeFileSync(join(dir, "MEMORY.md"), SAMPLE.replace("the flagship", "the main storefront and flagship"));
    const res = ingestHostMemory(agent, dir);
    expect(res.status).toBe("ingested");
    if (res.status === "ingested") { expect(res.written).toBe(1); expect(res.retired).toBe(1); }

    const rows = hostNodes(agent);
    expect(rows.find((x) => x.id === oldNode.id)!.valid_until).not.toBeNull();
    expect(rows.filter((x) => x.valid_until === null).length).toBe(parseMemoryUnits(SAMPLE).length);
  });

  test("a removed fact is retired", () => {
    const agent = freshAgent();
    const dir = workspace(SAMPLE);
    ingestHostMemory(agent, dir);
    writeFileSync(join(dir, "MEMORY.md"), SAMPLE.replace(/- Always run the deploy[^\n]*\n/, ""));
    const res = ingestHostMemory(agent, dir);
    if (res.status === "ingested") expect(res.retired).toBe(1);
    expect(hostNodes(agent).filter((x) => x.valid_until === null).length).toBe(parseMemoryUnits(SAMPLE).length - 1);
  });

  test("never retires a node it did not write (near-duplicate gate can return a conversation node)", () => {
    const agent = freshAgent();
    const dir = workspace(SAMPLE);
    // A conversation-derived node whose text is a near-duplicate of a MEMORY.md fact.
    const convoId = core.writeNode(agent, "semantic", "convo fact",
      "MEMORY.md - Durable Facts › Rules — Always run the deploy from the project folder, never from the home directory.",
      { importance: 0.7, source: "conversation" });
    ingestHostMemory(agent, dir);

    // Force the retire path to see that id: pretend the ingest map points at the conversation node.
    const key = createHash("sha256")
      .update("MEMORY.md - Durable Facts › Rules").update("\n")
      .update("Always run the deploy from the project folder, never from the home directory.")
      .digest("hex").slice(0, 16);
    core.setMeta(agent, "host_memory:MEMORY.md:units", JSON.stringify({ [key]: convoId, deadbeefdeadbeef: convoId }));
    core.setMeta(agent, "host_memory:MEMORY.md:sig", "stale");

    writeFileSync(join(dir, "MEMORY.md"), "# MEMORY.md - Durable Facts\n\n- A completely different fact that replaces everything that was here before.\n");
    ingestHostMemory(agent, dir);

    const row = core.getDb(agent).prepare("SELECT valid_until FROM nodes WHERE id = ?").get(convoId) as { valid_until: number | null };
    expect(row.valid_until).toBeNull();
  });

  test("no MEMORY.md is a quiet skip", () => {
    expect(ingestHostMemory(freshAgent(), workspace(null))).toEqual({ status: "skipped", reason: "no_file" });
  });
});

describe("scheduler hook", () => {
  test("beforeMaintenance runs for each agent on the initial tick, and a throwing hook does not stop the tick", async () => {
    vi.useFakeTimers();
    const a = freshAgent();
    const b = freshAgent();
    const seen: string[] = [];
    const warns: string[] = [];
    const log = { info: () => {}, warn: (m: string) => { warns.push(m); } };
    const handles = armSchedulers([a, b], { ...core.DEFAULT_CONFIG }, log, {
      beforeMaintenance: (id) => { seen.push(id); if (id === a) throw new Error("boom"); },
    });
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 50);
    disarmSchedulers(handles);
    expect(seen.sort()).toEqual([a, b].sort());
    expect(warns.some((w) => w.includes("before_maintenance") && w.includes("boom"))).toBe(true);
  });

  test("no hooks argument behaves as before", async () => {
    vi.useFakeTimers();
    const handles = armSchedulers([freshAgent()], { ...core.DEFAULT_CONFIG }, { info: () => {}, warn: () => {} });
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 50);
    disarmSchedulers(handles);
    expect(true).toBe(true);
  });
});
