import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import net from "node:net";

const x = promisify(execFile);
const BIN = path.resolve(__dirname, "..", "bin", "grok-web.mjs");

let tmp: string;
let stubBinDir: string;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
    s.on("error", reject);
  });
}

function runLauncher(
  args: string[],
  env: NodeJS.ProcessEnv = {}
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "gw-launch-"));
  stubBinDir = path.join(tmp, "bin");
  await fs.mkdir(stubBinDir, { recursive: true });
  // Stub `grok`: parses --bind host:port and holds the port open (mimics agent serve).
  const stub = `#!/usr/bin/env node
const args = process.argv.slice(2);
const i = args.indexOf("--bind");
const [host, port] = (args[i + 1] || "127.0.0.1:2419").split(":");
require("net").createServer(() => {}).listen(Number(port), host, () => {
  console.log("[stub-grok] listening on " + host + ":" + port);
});
`;
  await fs.writeFile(path.join(stubBinDir, "grok"), stub, { mode: 0o755 });
});

afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("launcher CLI", () => {
  it("--version prints the package version and exits 0", async () => {
    const r = await runLauncher(["--version"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^grok-web \d+\.\d+\.\d+/);
  });

  it("--help prints usage with flags and env vars, exits 0", async () => {
    const r = await runLauncher(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("--port");
    expect(r.stdout).toContain("--cwd");
    expect(r.stdout).toContain("GROK_AGENT_PORT");
  });

  it("fails with a friendly message when the grok CLI is missing", async () => {
    const r = await runLauncher(["--no-open"], { GROK_BIN: "definitely-not-a-real-cli-xyz" });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("não encontrado");
  });

  it("fails when the UI port is already in use", async () => {
    const busy = await freePort();
    const holder = net.createServer();
    await new Promise<void>((r) => holder.listen(busy, "127.0.0.1", () => r()));
    try {
      const r = await runLauncher(["--port", String(busy), "--no-open"], {
        PATH: `${stubBinDir}:${process.env.PATH}`,
      });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("já em uso");
    } finally {
      await new Promise<void>((r) => holder.close(() => r()));
    }
  });

  it("fails when the agent port is already in use", async () => {
    const busy = await freePort();
    const holder = net.createServer();
    await new Promise<void>((r) => holder.listen(busy, "127.0.0.1", () => r()));
    try {
      const r = await runLauncher(["--no-open"], {
        PATH: `${stubBinDir}:${process.env.PATH}`,
        GROK_AGENT_PORT: String(busy),
      });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("porta do agent");
    } finally {
      await new Promise<void>((r) => holder.close(() => r()));
    }
  });
});

describe("launcher end-to-end (stub grok)", () => {
  it("spawns agent + server, serves the UI, and cleans up on SIGTERM", async () => {
    const uiPort = await freePort();
    const agentPort = await freePort();

    const child = spawn(process.execPath, [BIN, "--port", String(uiPort), "--no-open"], {
      env: {
        ...process.env,
        PATH: `${stubBinDir}:${process.env.PATH}`,
        GROK_AGENT_PORT: String(agentPort),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));

    // wait for "[grok-web] ready" (up to 30s)
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timeout waiting for ready:\n" + stdout)), 30000);
      const tick = setInterval(() => {
        if (stdout.includes("ready")) {
          clearTimeout(t);
          clearInterval(tick);
          resolve();
        }
      }, 100);
    });

    try {
      // UI responds
      const res = await fetch(`http://127.0.0.1:${uiPort}/api/agent/env`);
      expect(res.status).toBe(200);
      const j = await res.json();
      expect(j.ready).toBe(true);
      expect(j.wsUrl).toContain(String(agentPort));

      // static UI (only when built)
      let hasDist = true;
      try {
        await fs.access(path.resolve(__dirname, "..", "dist", "index.html"));
      } catch {
        hasDist = false;
      }
      if (hasDist) {
        const ui = await fetch(`http://127.0.0.1:${uiPort}/`);
        expect(ui.status).toBe(200);
        expect((await ui.text()).toLowerCase()).toContain("<html");
      }

      // agent (stub) port is open
      const agentOpen = await new Promise<boolean>((resolve) => {
        const s = net.createConnection({ host: "127.0.0.1", port: agentPort }, () => {
          s.end();
          resolve(true);
        });
        s.on("error", () => resolve(false));
      });
      expect(agentOpen).toBe(true);
    } finally {
      // SIGTERM → launcher must kill children and exit
      child.kill("SIGTERM");
      const code = await new Promise<number | null>((resolve) => {
        const t = setTimeout(() => resolve(null), 10000);
        child.on("close", (c) => {
          clearTimeout(t);
          resolve(c);
        });
      });
      expect(code).toBe(0);

      // agent stub was cleaned up (port closed)
      await new Promise((r) => setTimeout(r, 300));
      const stillOpen = await new Promise<boolean>((resolve) => {
        const s = net.createConnection({ host: "127.0.0.1", port: agentPort }, () => {
          s.end();
          resolve(true);
        });
        s.on("error", () => resolve(false));
      });
      expect(stillOpen).toBe(false);
    }
  }, 60000);
});
