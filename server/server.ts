import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listSessions, getSessionDetail } from "./lib/sessions";
import { getGitStatus } from "./lib/git-diff";
import { isTextLike, resolveAllowedPath } from "./lib/fs-sandbox";
import {
  addMcpServer,
  doctorMcp,
  listMcpServers,
  MCP_PRESETS,
  removeMcpServer,
  setMcpEnabled,
  type AddMcpInput,
} from "./lib/mcp-config";
import { configPath } from "./lib/paths";
import { listModels } from "./lib/models";
import { listProjects } from "./lib/projects";
import { createSkill, deleteSkill, listSkills, type CreateSkillInput } from "./lib/skills";
import { getUsageSnapshot } from "./lib/usage";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const host = process.env.GROK_WEB_HOST || "127.0.0.1";
const port = Number(process.env.GROK_WEB_UI_PORT || 3847);
// Dev (tsx from <root>/server) and prod bundle (<root>/dist-server) both resolve to <root>/dist
const staticDir =
  process.env.GROK_WEB_STATIC_DIR || path.resolve(__dirname, "..", "dist");

/* ─── helpers ─────────────────────────────────────────────────────── */

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    ...headers,
  });
  res.end(payload);
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function parseIntParam(v: string | null): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.floor(n) : null;
}

/* ─── API handlers (1:1 port of the Next route handlers) ──────────── */

/** Public bootstrap info for the browser ACP client (secret only on localhost). */
function handleAgentEnv(res: http.ServerResponse) {
  const secret = process.env.GROK_AGENT_SECRET || "";
  const agentHost = process.env.GROK_AGENT_HOST || "127.0.0.1";
  const agentPort = process.env.GROK_AGENT_PORT || "2419";
  const wsUrl =
    process.env.GROK_AGENT_WS_URL ||
    `ws://${agentHost}:${agentPort}/ws?server-key=${encodeURIComponent(secret)}`;

  sendJson(res, 200, {
    ready: Boolean(secret),
    wsUrl: secret ? wsUrl : null,
    host: agentHost,
    port: Number(agentPort),
    defaultCwd: process.env.GROK_WEB_DEFAULT_CWD || process.cwd(),
  });
}

async function handleSessionsList(res: http.ServerResponse) {
  const sessions = await listSessions(120);
  sendJson(res, 200, { sessions });
}

async function handleSessionDetail(
  res: http.ServerResponse,
  url: URL,
  id: string
) {
  const ifRev = url.searchParams.get("rev");
  const limit = parseIntParam(url.searchParams.get("limit")) ?? 24;
  const before = parseIntParam(url.searchParams.get("before"));
  const after = parseIntParam(url.searchParams.get("after"));
  const light = url.searchParams.get("light") === "1";

  const detail = await getSessionDetail(id, { ifRev, limit, before, after, light });
  if (!detail) {
    sendJson(res, 404, { error: "Session not found" });
    return;
  }

  if (detail.unchanged) {
    sendJson(
      res,
      200,
      { unchanged: true, rev: detail.rev, meta: detail.meta },
      { "Cache-Control": "no-store" }
    );
    return;
  }

  sendJson(res, 200, detail, { "Cache-Control": "no-store" });
}

async function handleProjects(res: http.ServerResponse) {
  const projects = await listProjects();
  sendJson(res, 200, { projects });
}

async function handleModels(res: http.ServerResponse) {
  try {
    const catalog = await listModels();
    sendJson(res, 200, catalog);
  } catch (e) {
    sendJson(res, 500, { error: e instanceof Error ? e.message : "models failed" });
  }
}

async function handleUsage(res: http.ServerResponse, url: URL) {
  const sessionId = url.searchParams.get("sessionId");
  const full = url.searchParams.get("full") === "1";
  const snapshot = await getUsageSnapshot({
    sessionId: sessionId || undefined,
    // full=1 also expands recent sessions with turn cost (slower)
    lightRecent: !full,
  });
  sendJson(res, 200, snapshot, { "Cache-Control": "no-store" });
}

async function handleDiffs(res: http.ServerResponse, url: URL) {
  const cwd = url.searchParams.get("cwd");
  const light = url.searchParams.get("light") === "1";
  const filePath = url.searchParams.get("path") || undefined;

  if (!cwd) {
    sendJson(res, 400, { error: "cwd required" });
    return;
  }

  const check = resolveAllowedPath(cwd);
  if (!check.ok) {
    sendJson(res, 403, { error: check.error });
    return;
  }

  const result = await getGitStatus(check.resolved, { light, path: filePath || undefined });
  sendJson(res, 200, result, { "Cache-Control": "no-store" });
}

async function handleMcpGet(res: http.ServerResponse) {
  try {
    const servers = await listMcpServers();
    sendJson(res, 200, {
      servers,
      configPath: configPath(),
      presets: MCP_PRESETS,
    });
  } catch (e) {
    sendJson(res, 500, { error: e instanceof Error ? e.message : "list failed" });
  }
}

async function handleMcpPost(req: http.IncomingMessage, res: http.ServerResponse) {
  try {
    const body = (await readJsonBody(req)) as AddMcpInput;
    if (!body?.name || !body?.transport) {
      sendJson(res, 400, { error: "name e transport obrigatórios" });
      return;
    }
    await addMcpServer(body);
    const servers = await listMcpServers();
    sendJson(res, 200, { ok: true, servers });
  } catch (e) {
    sendJson(res, 400, { error: e instanceof Error ? e.message : "add failed" });
  }
}

async function handleMcpPatch(req: http.IncomingMessage, res: http.ServerResponse) {
  try {
    const body = (await readJsonBody(req)) as { name?: string; enabled?: boolean };
    if (!body?.name || typeof body.enabled !== "boolean") {
      sendJson(res, 400, { error: "name e enabled obrigatórios" });
      return;
    }
    await setMcpEnabled(body.name, body.enabled);
    const servers = await listMcpServers();
    sendJson(res, 200, { ok: true, servers });
  } catch (e) {
    sendJson(res, 400, { error: e instanceof Error ? e.message : "patch failed" });
  }
}

async function handleMcpDelete(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  try {
    const name = url.searchParams.get("name") || "";
    const scope = url.searchParams.get("scope") as "user" | "project" | null;
    if (!name) {
      sendJson(res, 400, { error: "name obrigatório" });
      return;
    }
    await removeMcpServer(name, scope || undefined);
    const servers = await listMcpServers();
    sendJson(res, 200, { ok: true, servers });
  } catch (e) {
    sendJson(res, 400, { error: e instanceof Error ? e.message : "delete failed" });
  }
}

async function handleMcpTest(req: http.IncomingMessage, res: http.ServerResponse) {
  try {
    const body = (await readJsonBody(req).catch(() => ({}))) as { name?: string };
    const { results, raw } = await doctorMcp(body?.name);
    sendJson(res, 200, { results, raw });
  } catch (e) {
    sendJson(res, 500, { error: e instanceof Error ? e.message : "doctor failed" });
  }
}

async function handleSkillsGet(res: http.ServerResponse, url: URL) {
  try {
    const cwd = url.searchParams.get("cwd") || undefined;
    const skills = await listSkills({ cwd: cwd || undefined });
    sendJson(res, 200, { skills, count: skills.length });
  } catch (e) {
    sendJson(res, 500, { error: e instanceof Error ? e.message : "list skills failed" });
  }
}

async function handleSkillsPost(req: http.IncomingMessage, res: http.ServerResponse) {
  try {
    const body = (await readJsonBody(req)) as CreateSkillInput;
    if (!body?.name || !body?.description) {
      sendJson(res, 400, { error: "name e description obrigatórios" });
      return;
    }
    const skill = await createSkill(body);
    const skills = await listSkills({ cwd: body.cwd });
    sendJson(res, 200, { ok: true, skill, skills });
  } catch (e) {
    sendJson(res, 400, { error: e instanceof Error ? e.message : "create skill failed" });
  }
}

async function handleSkillsDelete(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  try {
    const skillPath = url.searchParams.get("path") || "";
    const cwd = url.searchParams.get("cwd") || undefined;
    if (!skillPath) {
      sendJson(res, 400, { error: "path obrigatório" });
      return;
    }
    await deleteSkill({ path: skillPath, cwd: cwd || undefined });
    const skills = await listSkills({ cwd: cwd || undefined });
    sendJson(res, 200, { ok: true, skills });
  } catch (e) {
    sendJson(res, 400, { error: e instanceof Error ? e.message : "delete skill failed" });
  }
}

/** Max bytes returned for editor view (full file otherwise truncated). */
const MAX_EDITOR_BYTES = 1_500_000;

async function handleFsRead(req: http.IncomingMessage, res: http.ServerResponse) {
  try {
    const body = (await readJsonBody(req)) as {
      path?: string;
      line?: number;
      limit?: number;
      /** raw text for editor (no line prefixes) */
      raw?: boolean;
    };
    const filePath = body.path;
    if (!filePath || typeof filePath !== "string") {
      sendJson(res, 400, { error: "path required" });
      return;
    }
    const check = resolveAllowedPath(filePath);
    if (!check.ok) {
      sendJson(res, 403, { error: check.error });
      return;
    }

    const resolved = check.resolved;
    const st = await fs.stat(resolved);
    if (!st.isFile()) {
      sendJson(res, 400, { error: "not a file" });
      return;
    }

    // Binary guard
    const fh = await fs.open(resolved, "r");
    let sample: Buffer;
    try {
      sample = Buffer.alloc(Math.min(4096, st.size));
      await fh.read(sample, 0, sample.length, 0);
    } finally {
      await fh.close();
    }
    if (!isTextLike(resolved, sample)) {
      sendJson(res, 415, {
        error: "binary file",
        binary: true,
        path: resolved,
        size: st.size,
      });
      return;
    }

    if (body.raw) {
      if (st.size > MAX_EDITOR_BYTES) {
        const buf = Buffer.alloc(MAX_EDITOR_BYTES);
        const fh2 = await fs.open(resolved, "r");
        try {
          await fh2.read(buf, 0, MAX_EDITOR_BYTES, 0);
        } finally {
          await fh2.close();
        }
        sendJson(res, 200, {
          content: buf.toString("utf8"),
          path: resolved,
          size: st.size,
          truncated: true,
          mtimeMs: st.mtimeMs,
        });
        return;
      }
      const content = await fs.readFile(resolved, "utf8");
      sendJson(res, 200, {
        content,
        path: resolved,
        size: st.size,
        truncated: false,
        mtimeMs: st.mtimeMs,
      });
      return;
    }

    // ACP-style line window (legacy)
    const raw = await fs.readFile(resolved, "utf8");
    const lines = raw.split("\n");
    const start = Math.max(0, (body.line || 1) - 1);
    const limit = body.limit && body.limit > 0 ? body.limit : undefined;
    const slice =
      limit != null ? lines.slice(start, start + limit) : lines.slice(start);
    const content =
      limit != null || start > 0
        ? slice
            .map((line, i) => {
              const n = start + i + 1;
              return `${n}→${line}`;
            })
            .join("\n")
        : raw;

    sendJson(res, 200, { content, path: resolved, size: st.size, mtimeMs: st.mtimeMs });
  } catch (e) {
    sendJson(res, 500, { error: e instanceof Error ? e.message : "read failed" });
  }
}

const MAX_WRITE_BYTES = 2_000_000;

async function handleFsWrite(req: http.IncomingMessage, res: http.ServerResponse) {
  try {
    const body = (await readJsonBody(req)) as { path?: string; content?: string };
    const filePath = body.path;
    if (!filePath || typeof filePath !== "string") {
      sendJson(res, 400, { error: "path required" });
      return;
    }
    if (typeof body.content !== "string") {
      sendJson(res, 400, { error: "content required" });
      return;
    }
    if (Buffer.byteLength(body.content, "utf8") > MAX_WRITE_BYTES) {
      sendJson(res, 413, {
        error: `content too large (max ${MAX_WRITE_BYTES} bytes)`,
      });
      return;
    }

    const check = resolveAllowedPath(filePath, { write: true });
    if (!check.ok) {
      sendJson(res, 403, { error: check.error });
      return;
    }

    const resolved = check.resolved;
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, body.content, "utf8");
    const st = await fs.stat(resolved);
    sendJson(res, 200, { ok: true, path: resolved, size: st.size, mtimeMs: st.mtimeMs });
  } catch (e) {
    sendJson(res, 500, { error: e instanceof Error ? e.message : "write failed" });
  }
}

const TREE_IGNORE = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "coverage",
  ".turbo",
  ".cache",
  "__pycache__",
  ".venv",
  "venv",
  "target",
  ".DS_Store",
]);

async function handleFsTree(res: http.ServerResponse, url: URL) {
  try {
    const dirPath = url.searchParams.get("path") || "";
    const check = resolveAllowedPath(dirPath);
    if (!check.ok) {
      sendJson(res, 403, { error: check.error });
      return;
    }

    const st = await fs.stat(check.resolved);
    if (!st.isDirectory()) {
      sendJson(res, 400, { error: "not a directory" });
      return;
    }

    const entries = await fs.readdir(check.resolved, { withFileTypes: true });
    const out: Array<{
      name: string;
      path: string;
      type: "file" | "dir";
      size?: number;
    }> = [];

    const allowDot = (name: string) =>
      name === ".gitignore" ||
      name === ".env" ||
      name.startsWith(".env.") ||
      name.startsWith(".eslint") ||
      name.startsWith(".prettier") ||
      name === ".editorconfig";

    for (const ent of entries) {
      if (TREE_IGNORE.has(ent.name)) continue;
      if (ent.name.startsWith(".") && !allowDot(ent.name)) {
        // skip hidden dirs always; skip hidden files except allowlist
        if (ent.isDirectory() || !allowDot(ent.name)) continue;
      }

      const full = path.join(check.resolved, ent.name);
      if (ent.isDirectory()) {
        out.push({ name: ent.name, path: full, type: "dir" });
      } else if (ent.isFile()) {
        let size: number | undefined;
        try {
          size = (await fs.stat(full)).size;
        } catch {
          /* ignore */
        }
        out.push({ name: ent.name, path: full, type: "file", size });
      }
    }

    out.sort((a, b) => {
      if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    sendJson(res, 200, { path: check.resolved, entries: out });
  } catch (e) {
    sendJson(res, 500, { error: e instanceof Error ? e.message : "tree failed" });
  }
}

/* ─── router ──────────────────────────────────────────────────────── */

async function routeApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL
) {
  const p = url.pathname;
  const method = req.method || "GET";

  if (p === "/api/agent/env" && method === "GET") return handleAgentEnv(res);
  if (p === "/api/sessions" && method === "GET")
    return await handleSessionsList(res);
  if (p === "/api/projects" && method === "GET") return await handleProjects(res);
  if (p === "/api/models" && method === "GET") return await handleModels(res);
  if (p === "/api/usage" && method === "GET") return await handleUsage(res, url);
  if (p === "/api/diffs" && method === "GET") return await handleDiffs(res, url);

  const sessionMatch = p.match(/^\/api\/sessions\/([^/]+)$/);
  if (sessionMatch && method === "GET") {
    return await handleSessionDetail(res, url, decodeURIComponent(sessionMatch[1]));
  }

  if (p === "/api/mcp") {
    if (method === "GET") return await handleMcpGet(res);
    if (method === "POST") return await handleMcpPost(req, res);
    if (method === "PATCH") return await handleMcpPatch(req, res);
    if (method === "DELETE") return await handleMcpDelete(req, res, url);
  }
  if (p === "/api/mcp/test" && method === "POST")
    return await handleMcpTest(req, res);

  if (p === "/api/skills") {
    if (method === "GET") return await handleSkillsGet(res, url);
    if (method === "POST") return await handleSkillsPost(req, res);
    if (method === "DELETE") return await handleSkillsDelete(req, res, url);
  }

  if (p === "/api/fs/read" && method === "POST")
    return await handleFsRead(req, res);
  if (p === "/api/fs/write" && method === "POST")
    return await handleFsWrite(req, res);
  if (p === "/api/fs/tree" && method === "GET") return await handleFsTree(res, url);

  sendJson(res, 404, { error: `no handler for ${method} ${p}` });
}

/* ─── static files (production) ───────────────────────────────────── */

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

async function serveStatic(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL
) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    sendJson(res, 405, { error: "method not allowed" });
    return;
  }

  let filePath = path.normalize(
    path.join(staticDir, decodeURIComponent(url.pathname))
  );
  if (filePath !== staticDir && !filePath.startsWith(staticDir + path.sep)) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }

  try {
    const st = await fs.stat(filePath);
    if (st.isDirectory()) filePath = path.join(filePath, "index.html");
  } catch {
    // SPA fallback — unknown paths render the app shell
    filePath = path.join(staticDir, "index.html");
  }

  try {
    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control":
        url.pathname.startsWith("/assets/") || ext === ".woff2"
          ? "public, max-age=31536000, immutable"
          : "no-cache",
    });
    res.end(req.method === "HEAD" ? undefined : data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("not found");
  }
}

/* ─── server ──────────────────────────────────────────────────────── */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${host}:${port}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      await routeApi(req, res, url);
    } else {
      await serveStatic(req, res, url);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : "internal error";
    if (!res.headersSent) sendJson(res, 500, { error: msg });
    else res.end();
  }
});

server.listen(port, host, () => {
  console.log(`[grok-web] UI + API → http://${host}:${port}`);
  fs.access(staticDir).catch(() => {
    console.log(
      `[grok-web] aviso: ${staticDir} não existe — só APIs (rode "npm run build" p/ servir a UI)`
    );
  });
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
