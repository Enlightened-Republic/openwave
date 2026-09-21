// Host memory corpus (research/emotional-memory-openclaw-integration.md §5.6).
//
// OpenClaw's memory-core owns MEMORY.md as a single-writer file (dreaming rewrites it with
// optimistic concurrency), so openwave NEVER writes to it. This module only READS it and mirrors
// each durable fact into the agent's own graph, tagged `memory-core:MEMORY.md#L<a>-L<b>`.
//
// Why it is worth doing: OpenClaw injects MEMORY.md into the bootstrap under a per-file cap of
// `agents.defaults.bootstrapMaxChars` (default 20000; docs/concepts/context.md:132), and cron,
// group and channel sessions omit root memory entirely (docs/concepts/user-model.md:162). A large
// MEMORY.md is therefore partly invisible to the model on every turn. Graph recall can still
// reach those facts.
//
// DREAMS.md (a prose diary) and the raw daily notes are deliberately not ingested: the diary is
// narrative, and dreaming already promotes durable facts from the daily notes into MEMORY.md.
//
// Idempotent: unchanged files are skipped by (mtime,size); unchanged facts keep their node; an
// edited or deleted fact retires its old node (`valid_until`), but only nodes this module wrote
// (source prefix check), never a conversation-derived node that writeNode's near-duplicate gate
// happened to return.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import * as core from "sharpwave-core";

export type MemoryUnit = {
  key: string;
  heading: string;
  text: string;
  startLine: number;
  endLine: number;
};

export type HostMemoryLogger = { info: (msg: string) => void; warn: (msg: string) => void };

export type HostMemoryResult =
  | { status: "skipped"; reason: "no_file" | "read_error" }
  | { status: "unchanged" }
  | { status: "ingested"; units: number; written: number; retired: number; kept: number };

const MIN_UNIT_CHARS = 25;
const MAX_UNIT_CHARS = 1500;
const MAX_UNITS_PER_RUN = 400;
const SOURCE_PREFIX = "memory-core:MEMORY.md";
const IMPORTANCE = 0.55;
const META_SIG = "host_memory:MEMORY.md:sig";
const META_MAP = "host_memory:MEMORY.md:units";

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const BULLET = /^( *)[-*+]\s+(.*)$/;
const FENCE = /^\s*(```|~~~)/;

function blankHtmlComments(markdown: string): string {
  // Replace comment bodies with nothing but keep newlines so line numbers stay true.
  return markdown.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ""));
}

function hashKey(heading: string, text: string): string {
  return createHash("sha256").update(heading).update("\n").update(text).digest("hex").slice(0, 16);
}

/**
 * Splits MEMORY.md into one unit per top-level bullet (nested bullets and continuation lines fold
 * into their parent) or per paragraph, each carrying its heading path.
 */
export function parseMemoryUnits(markdown: string): MemoryUnit[] {
  const lines = blankHtmlComments(markdown).split(/\r?\n/);
  const headingStack: Array<{ level: number; title: string }> = [];
  const units: MemoryUnit[] = [];

  type Open = { start: number; end: number; parts: string[]; heading: string };
  // Held in an object so TypeScript does not narrow it to `null` across the flush() closure.
  const state: { cur: Open | null } = { cur: null };
  let inFence = false;

  const flush = () => {
    const open = state.cur;
    state.cur = null;
    if (!open) return;
    let text = open.parts.join(" ").replace(/\s+/g, " ").trim();
    // Measure the readable text: a bare `[Identity file](./IDENTITY.md)` link line carries no fact.
    if (text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").length < MIN_UNIT_CHARS) return;
    if (text.length > MAX_UNIT_CHARS) text = text.slice(0, MAX_UNIT_CHARS);
    units.push({ key: hashKey(open.heading, text), heading: open.heading, text, startLine: open.start, endLine: open.end });
  };

  const headingPath = () => headingStack.map((h) => h.title).join(" › ");
  // Adds a line to the open unit, opening one first when none is open (e.g. a fenced block that
  // follows a blank line).
  const extend = (line: string, lineNo: number) => {
    if (!state.cur) state.cur = { start: lineNo, end: lineNo, parts: [], heading: headingPath() };
    state.cur.parts.push(line.trim());
    state.cur.end = lineNo;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;

    if (FENCE.test(line)) {
      inFence = !inFence;
      extend(line, lineNo);
      continue;
    }
    if (inFence) {
      extend(line, lineNo);
      continue;
    }

    const h = HEADING.exec(line);
    if (h) {
      flush();
      const level = h[1].length;
      while (headingStack.length > 0 && headingStack[headingStack.length - 1].level >= level) headingStack.pop();
      headingStack.push({ level, title: h[2].trim() });
      continue;
    }

    if (line.trim() === "") { flush(); continue; }

    const bullet = BULLET.exec(line);
    // A bullet indented 2+ spaces under an open unit is a nested item and folds into its parent.
    if (bullet && !(bullet[1].length >= 2 && state.cur)) {
      flush();
      state.cur = { start: lineNo, end: lineNo, parts: [bullet[2]], heading: headingPath() };
      continue;
    }

    extend(line, lineNo);
  }
  flush();
  return units;
}

function labelFor(unit: MemoryUnit): string {
  const bold = /^\*\*(.{3,70}?)\*\*/.exec(unit.text);
  const raw = (bold ? bold[1] : unit.text).replace(/[*_`]/g, "").trim();
  const base = raw.length > 80 ? `${raw.slice(0, 77)}...` : raw;
  return base || unit.heading || "MEMORY.md";
}

function contentFor(unit: MemoryUnit): string {
  return unit.heading ? `${unit.heading} — ${unit.text}` : unit.text;
}

function readMap(agentId: string): Record<string, string> {
  try {
    const raw = core.getMeta(agentId, META_MAP);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** True when the node still exists, is not retired, and was written by this module. */
function isLiveHostNode(agentId: string, nodeId: string): boolean {
  const row = core.getDb(agentId)
    .prepare("SELECT source, valid_until FROM nodes WHERE id = ?")
    .get(nodeId) as { source: string | null; valid_until: number | null } | undefined;
  if (!row) return false;
  if (row.valid_until !== null && row.valid_until <= Date.now()) return false;
  return (row.source ?? "").startsWith(SOURCE_PREFIX);
}

/** Mirrors the agent's MEMORY.md into its graph. Read-only with respect to the workspace. */
export function ingestHostMemory(agentId: string, workspaceDir: string, log?: HostMemoryLogger): HostMemoryResult {
  const path = join(workspaceDir, "MEMORY.md");
  if (!existsSync(path)) return { status: "skipped", reason: "no_file" };

  let markdown: string;
  let sig: string;
  try {
    const st = statSync(path);
    sig = `${Math.floor(st.mtimeMs)}:${st.size}`;
    if (core.getMeta(agentId, META_SIG) === sig) return { status: "unchanged" };
    markdown = readFileSync(path, "utf8");
  } catch (err) {
    log?.warn(`[openwave] ${JSON.stringify({ agentId, op: "host_memory.ingest", outcome: "error", error: String(err) })}`);
    return { status: "skipped", reason: "read_error" };
  }

  const units = parseMemoryUnits(markdown).slice(0, MAX_UNITS_PER_RUN);
  const prev = readMap(agentId);
  const next: Record<string, string> = {};
  let written = 0;
  let kept = 0;

  for (const unit of units) {
    const known = prev[unit.key];
    if (known && isLiveHostNode(agentId, known)) {
      next[unit.key] = known;
      kept++;
      continue;
    }
    const id = core.writeNode(agentId, "semantic", labelFor(unit), contentFor(unit), {
      importance: IMPORTANCE,
      source: `${SOURCE_PREFIX}#L${unit.startLine}-L${unit.endLine}`,
      // The near-duplicate gate would match this fact's own previous version (an edit) and hand
      // back the old node with the old text, so an edited fact would never update or retire.
      deduplicate: false,
    });
    next[unit.key] = id;
    written++;
    try { core.queueEmbedding(agentId, id); } catch { /* the 10-minute sweep requeues orphans */ }
  }

  // Retire facts that were edited or removed. Only nodes this module wrote may be retired: writeNode's
  // near-duplicate gate can hand back a conversation-derived node's id, which must stay untouched.
  let retired = 0;
  const now = Date.now();
  const db = core.getDb(agentId);
  const retire = db.prepare("UPDATE nodes SET valid_until = ? WHERE id = ? AND source LIKE ? AND valid_until IS NULL");
  const stillReferenced = new Set(Object.values(next));
  for (const [key, id] of Object.entries(prev)) {
    if (key in next || stillReferenced.has(id)) continue;
    retired += retire.run(now, id, `${SOURCE_PREFIX}%`).changes;
  }

  core.setMeta(agentId, META_MAP, JSON.stringify(next));
  core.setMeta(agentId, META_SIG, sig);
  log?.info(`[openwave] ${JSON.stringify({ agentId, op: "host_memory.ingest", outcome: "ok", units: units.length, written, kept, retired })}`);
  return { status: "ingested", units: units.length, written, retired, kept };
}
