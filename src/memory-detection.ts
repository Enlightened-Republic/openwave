// Detects whether a host memory system (OpenClaw's bundled memory-core, or
// any other plugin curating MEMORY.md/USER.md) is already active for an
// agent's workspace, so openwave can avoid injecting content that duplicates
// that curated tier's purpose (see buildBootstrapContext/buildSelfModelHeader
// `externalMemoryActive` option in sharpwave-core's context-assembly.ts).
//
// openwave never reads these files' content or writes to them — memory-core
// owns MEMORY.md as a single-writer file with its own optimistic-concurrency
// rewrite (docs/concepts/memory-architecture.md "The write path"). This is a
// presence check only.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const CURATED_MEMORY_FILES = ["MEMORY.md", "USER.md"] as const;

/**
 * Default "exists and has real content" check: the file exists and has at
 * least one non-whitespace character. A fresh agent's scaffolded-but-empty
 * MEMORY.md should not count as "a host memory system is active" — an empty
 * file means nothing has been curated into it yet.
 */
function defaultIsNonTrivialFile(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    return readFileSync(path, "utf8").trim().length > 0;
  } catch {
    return false;
  }
}

type WorkspaceCapableApi = {
  runtime?: {
    agent?: {
      resolveAgentWorkspaceDir?: (cfg: unknown, agentId: string) => string | undefined;
    };
  };
};

/**
 * True when the agent's resolved OpenClaw workspace has a non-empty
 * MEMORY.md or USER.md — i.e. a curated host memory tier already exists for
 * this agent, per docs/plugins/sdk-runtime/agent.md:54
 * (`api.runtime.agent.resolveAgentWorkspaceDir(cfg, agentId)`).
 *
 * Fails closed (`false`) on an older host that does not expose
 * `runtime.agent.resolveAgentWorkspaceDir`, on an agent with no resolvable
 * workspace, or on any filesystem error — openwave's own injection behavior
 * is unaffected either way, so failing closed just means "assume no host
 * memory tier, inject as usual" rather than blocking anything.
 */
export function hasExternalMemoryCoreWorkspace(
  api: WorkspaceCapableApi,
  cfg: unknown,
  agentId: string,
  isNonTrivialFile: (path: string) => boolean = defaultIsNonTrivialFile,
): boolean {
  const resolve = api.runtime?.agent?.resolveAgentWorkspaceDir;
  if (!resolve) return false;

  let dir: string | undefined;
  try {
    dir = resolve(cfg, agentId);
  } catch {
    return false;
  }
  if (!dir) return false;

  return CURATED_MEMORY_FILES.some((file) => isNonTrivialFile(join(dir!, file)));
}
