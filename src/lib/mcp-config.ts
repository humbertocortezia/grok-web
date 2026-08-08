import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import { parse } from "smol-toml";
import { configPath } from "./paths";

const execFileAsync = promisify(execFile);

export type McpServerView = {
  name: string;
  enabled: boolean;
  type: "stdio" | "http" | "sse" | "unknown";
  command?: string;
  args?: string[];
  url?: string;
  scope?: string;
  source?: string;
  raw: Record<string, unknown>;
};

export type McpDoctorCheck = {
  label: string;
  passed: boolean;
  detail?: string;
};

export type McpDoctorResult = {
  name: string;
  transport?: string;
  target?: string;
  source?: string;
  healthy: boolean;
  checks: McpDoctorCheck[];
};

function grokBin(): string {
  return process.env.GROK_BIN || "grok";
}

async function runGrok(
  args: string[],
  opts: { timeoutMs?: number } = {}
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync(grokBin(), args, {
      timeout: opts.timeoutMs ?? 60_000,
      maxBuffer: 4 * 1024 * 1024,
      env: process.env,
    });
    return { stdout: String(stdout || ""), stderr: String(stderr || ""), code: 0 };
  } catch (e) {
    const err = e as {
      code?: number | string;
      stdout?: string;
      stderr?: string;
      message?: string;
      killed?: boolean;
    };
    return {
      stdout: String(err.stdout || ""),
      stderr: String(err.stderr || err.message || "grok failed"),
      code: typeof err.code === "number" ? err.code : 1,
    };
  }
}

/** Parse config.toml for a detailed local view (command/url/args). */
export async function listMcpServersFromToml(): Promise<McpServerView[]> {
  let raw: string;
  try {
    raw = await fs.readFile(configPath(), "utf8");
  } catch {
    return [];
  }

  const config = parse(raw) as Record<string, unknown>;
  const servers = (config.mcp_servers || {}) as Record<
    string,
    Record<string, unknown>
  >;
  const plugins = (config.plugins as { enabled?: string[] } | undefined)?.enabled || [];

  const out: McpServerView[] = [];

  for (const [name, cfg] of Object.entries(servers)) {
    const enabled = cfg.enabled !== false;
    if (typeof cfg.url === "string") {
      out.push({
        name,
        enabled,
        type: "http",
        url: cfg.url,
        scope: "user",
        source: "config.toml",
        raw: cfg,
      });
    } else if (typeof cfg.command === "string") {
      out.push({
        name,
        enabled,
        type: "stdio",
        command: cfg.command,
        args: Array.isArray(cfg.args) ? (cfg.args as string[]) : [],
        scope: "user",
        source: "config.toml",
        raw: cfg,
      });
    } else {
      out.push({
        name,
        enabled,
        type: "unknown",
        scope: "user",
        source: "config.toml",
        raw: cfg,
      });
    }
  }

  for (const plugin of plugins) {
    if (!out.some((s) => s.name === plugin)) {
      out.push({
        name: plugin,
        enabled: true,
        type: "unknown",
        scope: "plugin",
        source: "plugins.enabled",
        raw: { source: "plugins.enabled" },
      });
    }
  }

  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Prefer CLI list (includes scopes) and merge with TOML detail. */
export async function listMcpServers(): Promise<McpServerView[]> {
  const fromToml = await listMcpServersFromToml();
  const byName = new Map(fromToml.map((s) => [s.name, s]));

  const { stdout, code } = await runGrok(["mcp", "list", "--json"], {
    timeoutMs: 15_000,
  });
  if (code === 0 && stdout.trim()) {
    try {
      const list = JSON.parse(stdout) as Array<{
        name?: string;
        url?: string;
        command?: string;
        enabled?: boolean;
        scope?: string;
        transport?: string;
      }>;
      if (Array.isArray(list)) {
        for (const row of list) {
          if (!row?.name) continue;
          const existing = byName.get(row.name);
          if (existing) {
            byName.set(row.name, {
              ...existing,
              enabled: row.enabled ?? existing.enabled,
              scope: row.scope || existing.scope,
              url: row.url || existing.url,
              command: row.command || existing.command,
              type:
                row.transport === "stdio"
                  ? "stdio"
                  : row.transport === "sse"
                    ? "sse"
                    : row.transport === "http" || row.url
                      ? "http"
                      : existing.type,
            });
          } else {
            byName.set(row.name, {
              name: row.name,
              enabled: row.enabled !== false,
              type:
                row.transport === "stdio"
                  ? "stdio"
                  : row.transport === "sse"
                    ? "sse"
                    : row.url
                      ? "http"
                      : "unknown",
              url: row.url,
              command: row.command,
              scope: row.scope,
              source: row.scope || "cli",
              raw: row as Record<string, unknown>,
            });
          }
        }
      }
    } catch {
      /* keep toml list */
    }
  }

  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export type AddMcpInput = {
  name: string;
  transport: "stdio" | "http" | "sse";
  /** HTTP/SSE URL */
  url?: string;
  /** stdio command + args as argv after -- */
  command?: string;
  args?: string[];
  /** KEY=value pairs */
  env?: string[];
  /** "Header: value" pairs for HTTP */
  headers?: string[];
  scope?: "user" | "project";
};

function assertName(name: string) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
    throw new Error(
      "Nome inválido: use letras, números, hífen ou underscore (máx. 64)."
    );
  }
}

export async function addMcpServer(input: AddMcpInput): Promise<void> {
  const name = input.name.trim();
  assertName(name);

  const args = ["mcp", "add"];
  if (input.scope === "project") args.push("--scope", "project");

  if (input.transport === "http" || input.transport === "sse") {
    if (!input.url?.trim()) throw new Error("URL obrigatória para HTTP/SSE");
    args.push("--transport", input.transport, name, input.url.trim());
    for (const h of input.headers || []) {
      if (h.trim()) args.push("--header", h.trim());
    }
  } else {
    const cmd = (input.command || "").trim();
    if (!cmd) throw new Error("Command obrigatório para stdio");
    for (const e of input.env || []) {
      if (e.trim()) args.push("-e", e.trim());
    }
    args.push(name, "--", cmd, ...(input.args || []).map(String));
  }

  const { stdout, stderr, code } = await runGrok(args, { timeoutMs: 30_000 });
  if (code !== 0) {
    throw new Error((stderr || stdout || "falha ao adicionar MCP").trim());
  }
}

export async function removeMcpServer(
  name: string,
  scope?: "user" | "project"
): Promise<void> {
  assertName(name);
  const args = ["mcp", "remove", name];
  if (scope) args.push("--scope", scope);
  const { stdout, stderr, code } = await runGrok(args, { timeoutMs: 20_000 });
  if (code !== 0) {
    throw new Error((stderr || stdout || `não removido: ${name}`).trim());
  }
}

export async function setMcpEnabled(
  name: string,
  enabled: boolean
): Promise<void> {
  assertName(name);
  const args = ["mcp", enabled ? "enable" : "disable", name];
  const { stdout, stderr, code } = await runGrok(args, { timeoutMs: 20_000 });
  if (code !== 0) {
    throw new Error(
      (stderr || stdout || `falha ao ${enabled ? "enable" : "disable"} ${name}`).trim()
    );
  }
}

export async function doctorMcp(
  name?: string
): Promise<{ results: McpDoctorResult[]; raw: unknown }> {
  const args = ["mcp", "doctor", "--json"];
  if (name?.trim()) {
    assertName(name.trim());
    args.splice(2, 0, name.trim()); // doctor <name> --json
  }
  // doctor can be slow (npx cold start)
  const { stdout, stderr, code } = await runGrok(args, { timeoutMs: 120_000 });
  if (!stdout.trim()) {
    throw new Error((stderr || `doctor failed (code ${code})`).trim());
  }
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    throw new Error("doctor retornou JSON inválido");
  }
  const obj = raw as {
    servers?: Array<{
      name: string;
      transport?: string;
      target?: string;
      source?: string;
      healthy?: boolean;
      checks?: McpDoctorCheck[];
    }>;
  };
  const results: McpDoctorResult[] = (obj.servers || []).map((s) => ({
    name: s.name,
    transport: s.transport,
    target: s.target,
    source: s.source,
    healthy: Boolean(s.healthy),
    checks: s.checks || [],
  }));
  return { results, raw };
}

/** Catalog of common Grok-compatible MCP presets (add form). */
export const MCP_PRESETS: Array<{
  id: string;
  label: string;
  transport: "stdio" | "http" | "sse";
  name: string;
  url?: string;
  command?: string;
  args?: string[];
  note?: string;
}> = [
  {
    id: "linear",
    label: "Linear (HTTP)",
    transport: "http",
    name: "linear",
    url: "https://mcp.linear.app/mcp",
    note: "OAuth no primeiro uso no Grok",
  },
  {
    id: "sentry",
    label: "Sentry (HTTP)",
    transport: "http",
    name: "sentry",
    url: "https://mcp.sentry.dev/mcp",
  },
  {
    id: "filesystem",
    label: "Filesystem (stdio)",
    transport: "stdio",
    name: "filesystem",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/home/humberto/projetos"],
    note: "Ajuste o path no formulário",
  },
  {
    id: "github",
    label: "GitHub (stdio)",
    transport: "stdio",
    name: "github",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    note: "Requer GITHUB_TOKEN no env",
  },
  {
    id: "postgres",
    label: "PostgreSQL (stdio)",
    transport: "stdio",
    name: "postgres",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-postgres", "postgresql://localhost/db"],
  },
  {
    id: "custom-http",
    label: "HTTP custom…",
    transport: "http",
    name: "",
    url: "http://127.0.0.1:PORT/mcp",
  },
  {
    id: "custom-stdio",
    label: "stdio custom…",
    transport: "stdio",
    name: "",
    command: "npx",
    args: ["-y", "package"],
  },
];
