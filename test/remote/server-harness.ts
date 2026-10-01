// Starts a REAL sharpwave-server (the SharpWave brain service, built from
// sharpwave main: packages/server/dist/cli.js) as a child process on a random
// port with a temp root, and mints per-agent tokens with its own CLI.
//
// Locate the built server with SHARPWAVE_SERVER_CLI=/path/to/packages/server/dist/cli.js
// (default: ../sharpwave/packages/server/dist/cli.js next to this repo).
// The server is unpublished, so when it can't be found the remote suites are
// SKIPPED with a warning (set OPENWAVE_REQUIRE_REMOTE_TESTS=1 to make that a failure).

import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

export const SERVER_CLI = resolve(process.env["SHARPWAVE_SERVER_CLI"] ?? join(HERE, "..", "..", "..", "sharpwave", "packages", "server", "dist", "cli.js"));
export const HAVE_SERVER = existsSync(SERVER_CLI);
if (!HAVE_SERVER) {
  const msg = `[openwave tests] sharpwave-server not found at ${SERVER_CLI}; remote-mode suites skipped. Build sharpwave main packages/server and set SHARPWAVE_SERVER_CLI.`;
  if (process.env["OPENWAVE_REQUIRE_REMOTE_TESTS"] === "1") throw new Error(msg);
  console.warn(msg);
}

export async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => res(port));
    });
  });
}

export type Scope = "read" | "write" | "shared-write" | "admin";

export type RunningServer = {
  url: string;
  root: string;
  mint: (agentId: string, scopes?: Scope[]) => string;
  /** Write a token to <dir>/<agentId>.token and return the dir. */
  tokenDir: string;
  writeTokenFile: (agentId: string, token: string) => string;
  logs: () => string;
  stop: () => Promise<void>;
};

/** Optional second build (e.g. sharpwave main without brain_episode_append) to exercise the fallback path. */
export const LEGACY_SERVER_CLI = process.env["SHARPWAVE_SERVER_CLI_LEGACY"] ? resolve(process.env["SHARPWAVE_SERVER_CLI_LEGACY"]) : null;

export async function startServer(cli: string = SERVER_CLI): Promise<RunningServer> {
  const root = mkdtempSync(join(tmpdir(), "ow-remote-svc-"));
  const tokenDir = mkdtempSync(join(tmpdir(), "ow-remote-tok-"));
  const port = await freePort();
  const env = { ...process.env, OLLAMA_BASE_URL: "http://127.0.0.1:59999", SHARPWAVE_DATA_DIR: join(root, "unused-core-data") };
  delete (env as Record<string, string | undefined>)["OPENROUTER_API_KEY"];
  const mint = (agentId: string, scopes: Scope[] = ["read", "write"]) => {
    const out = execFileSync(process.execPath, [cli, "token", "mint", "--root", root, "--agent", agentId, "--scopes", scopes.join(","), "--json"], { env, encoding: "utf8" });
    return (JSON.parse(out) as { token: string }).token;
  };
  let output = "";
  const child: ChildProcess = spawn(process.execPath, [cli, "serve", "--root", root, "--port", String(port), "--tailnet-ip", "none", "--no-sleep", "--no-backup"], { env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout!.on("data", (d) => { output += String(d); });
  child.stderr!.on("data", (d) => { output += String(d); });
  const url = `http://127.0.0.1:${port}`;
  const t0 = Date.now();
  for (;;) {
    if (child.exitCode !== null) throw new Error(`sharpwave-server exited early (${child.exitCode}):\n${output}`);
    try {
      const r = await fetch(`${url}/health`);
      if (r.ok) break;
    } catch { /* not up yet */ }
    if (Date.now() - t0 > 15_000) { child.kill(); throw new Error(`sharpwave-server did not become healthy:\n${output}`); }
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    url, root, mint, tokenDir,
    writeTokenFile: (agentId, token) => { writeFileSync(join(tokenDir, `${agentId}.token`), token + "\n"); return tokenDir; },
    logs: () => output,
    stop: async () => {
      if (child.exitCode === null) {
        await new Promise<void>((res) => { child.once("exit", () => res()); child.kill("SIGTERM"); setTimeout(() => { child.kill("SIGKILL"); res(); }, 3000).unref(); });
      }
      rmSync(root, { recursive: true, force: true });
      rmSync(tokenDir, { recursive: true, force: true });
    },
  };
}

/** A TCP server that accepts connections and never answers (black hole). */
export async function startBlackHole(): Promise<{ url: string; stop: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const srv: Server = createServer((s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    stop: () => new Promise<void>((r) => { for (const s of sockets) s.destroy(); srv.close(() => r()); }),
  };
}
