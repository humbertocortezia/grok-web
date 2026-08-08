#!/usr/bin/env node
/**
 * grok-web — launches `grok agent serve` + Next.js UI.
 * Usage: node bin/grok-web.mjs [--port 3847] [--cwd /path] [--no-open]
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const args = process.argv.slice(2);
const noOpen = args.includes("--no-open");
const portIdx = args.indexOf("--port");
const cwdIdx = args.indexOf("--cwd");
const uiPort = portIdx >= 0 ? Number(args[portIdx + 1]) : 3847;
const defaultCwd =
  cwdIdx >= 0 ? path.resolve(args[cwdIdx + 1]) : process.cwd();

const secret = process.env.GROK_AGENT_SECRET || randomBytes(24).toString("hex");
const agentPort = Number(process.env.GROK_AGENT_PORT || 2419);
const agentHost = process.env.GROK_AGENT_HOST || "127.0.0.1";

const children = [];

function spawnLogged(cmd, cmdArgs, env = {}) {
  const child = spawn(cmd, cmdArgs, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  const tag = path.basename(cmd);
  child.stdout.on("data", (d) => process.stdout.write(`[${tag}] ${d}`));
  child.stderr.on("data", (d) => process.stderr.write(`[${tag}] ${d}`));
  child.on("exit", (code, signal) => {
    console.log(
      `[grok-web] exited: ${cmd} ${cmdArgs.join(" ")} code=${code} signal=${signal}`
    );
  });
  return child;
}

async function portOpen(host, port) {
  const net = await import("node:net");
  return new Promise((resolve) => {
    const s = net.createConnection({ host, port }, () => {
      s.end();
      resolve(true);
    });
    s.on("error", () => resolve(false));
  });
}

async function waitUntil(host, port, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await portOpen(host, port)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timeout waiting for ${host}:${port}`);
}

function shutdown() {
  for (const c of children) {
    try {
      c.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log(`
╭──────────────────────────────────────────────╮
│  grok-web  ·  interface gráfica do Grok      │
╰──────────────────────────────────────────────╯
  Agent : ws://${agentHost}:${agentPort}/ws
  UI    : http://127.0.0.1:${uiPort}
  CWD   : ${defaultCwd}
`);

spawnLogged(
  "grok",
  [
    "agent",
    "--always-approve",
    "serve",
    "--bind",
    `${agentHost}:${agentPort}`,
    "--secret",
    secret,
  ],
  { GROK_AGENT_SECRET: secret }
);

const nextBin = path.join(root, "node_modules", "next", "dist", "bin", "next");
spawnLogged(
  process.execPath,
  [nextBin, "dev", "-p", String(uiPort), "-H", "127.0.0.1"],
  {
    GROK_AGENT_SECRET: secret,
    GROK_AGENT_HOST: agentHost,
    GROK_AGENT_PORT: String(agentPort),
    GROK_WEB_DEFAULT_CWD: defaultCwd,
    GROK_AGENT_WS_URL: `ws://${agentHost}:${agentPort}/ws?server-key=${secret}`,
  }
);

try {
  await waitUntil(agentHost, agentPort);
  await waitUntil("127.0.0.1", uiPort);
  console.log(`[grok-web] ready → http://127.0.0.1:${uiPort}`);
  if (!noOpen) {
    const openCmd =
      process.platform === "darwin"
        ? "open"
        : process.platform === "win32"
          ? "cmd"
          : "xdg-open";
    const openArgs =
      process.platform === "win32"
        ? ["/c", "start", `http://127.0.0.1:${uiPort}`]
        : [`http://127.0.0.1:${uiPort}`];
    spawn(openCmd, openArgs, { stdio: "ignore", detached: true }).unref();
  }
} catch (e) {
  console.error("[grok-web] failed to start:", e.message);
}

await new Promise(() => {});
