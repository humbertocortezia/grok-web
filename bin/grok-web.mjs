#!/usr/bin/env node
/**
 * grok-web — launches `grok agent serve` + the local web UI.
 * Usage: grok-web [--port 3847] [--cwd /path] [--no-open] [--version] [--help]
 */
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const args = process.argv.slice(2);

function flagValue(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

if (args.includes("--version") || args.includes("-v")) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  console.log(`grok-web ${pkg.version}`);
  process.exit(0);
}

if (args.includes("--help") || args.includes("-h")) {
  console.log(`
grok-web — interface gráfica local para o Grok Build

uso: grok-web [opções]

opções:
  --port <n>     porta da UI (default 3847)
  --cwd <path>   projeto/CWD inicial das sessões (default: diretório atual)
  --no-open      não abrir o browser automaticamente
  --version      mostrar versão
  --help         esta ajuda

variáveis de ambiente:
  GROK_AGENT_HOST (127.0.0.1) · GROK_AGENT_PORT (2419) · GROK_AGENT_SECRET
  GROK_HOME (~/.grok) · GROK_WEB_PROJECTS_ROOT (~/projetos) · GROK_BIN (grok)
`);
  process.exit(0);
}

const noOpen = args.includes("--no-open");
const uiPort = Number(flagValue("--port") || 3847);
const defaultCwd = flagValue("--cwd")
  ? path.resolve(flagValue("--cwd"))
  : process.cwd();

const secret = process.env.GROK_AGENT_SECRET || randomBytes(24).toString("hex");
const agentPort = Number(process.env.GROK_AGENT_PORT || 2419);
const agentHost = process.env.GROK_AGENT_HOST || "127.0.0.1";
const grokBin = process.env.GROK_BIN || "grok";

function fail(msg) {
  console.error(`[grok-web] ${msg}`);
  process.exit(1);
}

// ── preflight: grok CLI available? ─────────────────────────────────
{
  const probe = spawnSync(process.platform === "win32" ? "where" : "which", [grokBin], {
    stdio: "ignore",
  });
  if (probe.error || probe.status !== 0) {
    fail(
      `CLI "${grokBin}" não encontrado no PATH.\n` +
        `Instale o Grok Build CLI e rode "${grokBin} login" uma vez. ` +
        `(ou aponte GROK_BIN para o binário)`
    );
  }
}

// ── preflight: ports free? ─────────────────────────────────────────
function portOpen(host, port) {
  return new Promise((resolve) => {
    const s = net.createConnection({ host, port }, () => {
      s.end();
      resolve(true);
    });
    s.on("error", () => resolve(false));
  });
}

const busyUi = await portOpen("127.0.0.1", uiPort);
if (busyUi) {
  fail(`porta ${uiPort} já em uso — mate o processo ou use --port <outra>`);
}
const busyAgent = await portOpen(agentHost, agentPort);
if (busyAgent) {
  fail(
    `porta do agent ${agentHost}:${agentPort} já em uso — ` +
      `mate o grok-web/agent anterior ou use GROK_AGENT_PORT=<outra>`
  );
}

// ── locate the server entry ────────────────────────────────────────
const prodServer = path.join(root, "dist-server", "server.mjs");
const devServerTs = path.join(root, "server", "server.ts");
let serverCmd;
let serverArgs;
if (fs.existsSync(prodServer)) {
  serverCmd = process.execPath;
  serverArgs = [prodServer];
} else if (fs.existsSync(devServerTs)) {
  // repo mode — run TS directly (requires dev deps installed)
  serverCmd = "npx";
  serverArgs = ["tsx", devServerTs];
} else {
  fail("servidor não encontrado — rode npm install && npm run build");
}

const children = [];

function spawnLogged(cmd, cmdArgs, env = {}, cwd = root) {
  const child = spawn(cmd, cmdArgs, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  const tag = path.basename(cmd).replace(/\.mjs$/, "");
  child.stdout.on("data", (d) => process.stdout.write(`[${tag}] ${d}`));
  child.stderr.on("data", (d) => process.stderr.write(`[${tag}] ${d}`));
  child.on("exit", (code, signal) => {
    console.log(
      `[grok-web] exited: ${cmd} ${cmdArgs.join(" ")} code=${code} signal=${signal}`
    );
    if (!shuttingDown) shutdown();
  });
  return child;
}

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) {
    try {
      c.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }
  setTimeout(() => process.exit(0), 1500).unref();
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

spawnLogged(grokBin, [
  "agent",
  "--always-approve",
  "serve",
  "--bind",
  `${agentHost}:${agentPort}`,
  "--secret",
  secret,
], { GROK_AGENT_SECRET: secret });

spawnLogged(serverCmd, serverArgs, {
  GROK_AGENT_SECRET: secret,
  GROK_AGENT_HOST: agentHost,
  GROK_AGENT_PORT: String(agentPort),
  GROK_WEB_UI_PORT: String(uiPort),
  GROK_WEB_DEFAULT_CWD: defaultCwd,
  GROK_WEB_STATIC_DIR: path.join(root, "dist"),
  GROK_AGENT_WS_URL: `ws://${agentHost}:${agentPort}/ws?server-key=${secret}`,
});

async function waitUntil(host, port, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await portOpen(host, port)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timeout waiting for ${host}:${port}`);
}

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
        ? ["/c", "start", "", `http://127.0.0.1:${uiPort}`]
        : [`http://127.0.0.1:${uiPort}`];
    spawn(openCmd, openArgs, { stdio: "ignore", detached: true }).unref();
  }
} catch (e) {
  console.error("[grok-web] failed to start:", e.message);
  shutdown();
}

await new Promise(() => {});
