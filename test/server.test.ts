import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const x = promisify(execFile);

// ── isolated environment (must be set BEFORE importing the server) ──
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "gw-srv-"));
const fakeHome = path.join(tmp, "home");
process.env.GROK_HOME = path.join(tmp, ".grok");
process.env.GROK_WEB_PROJECTS_ROOT = path.join(tmp, "projects");
process.env.GROK_AGENT_SECRET = "test-secret";
process.env.GROK_AGENT_HOST = "127.0.0.1";
process.env.GROK_AGENT_PORT = "2419";
process.env.GROK_WEB_STATIC_DIR = path.join(tmp, "static");
vi.spyOn(os, "homedir").mockReturnValue(fakeHome);

const { createServer } = await import("../server/server");

let server: http.Server;
let base: string;
const gitRepo = path.join(tmp, "gitrepo");

function rawGet(
  p: string
): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port: Number(new URL(base).port), path: p }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode!, body, headers: res.headers }));
    });
    req.on("error", reject);
  });
}

beforeAll(async () => {
  // static fixture + a sensitive file one level ABOVE the static dir (leak target)
  await fs.mkdir(path.join(tmp, "static", "assets"), { recursive: true });
  await fs.writeFile(path.join(tmp, "static", "index.html"), "<html><body>fixture-ui</body></html>");
  await fs.writeFile(path.join(tmp, "static", "assets", "app.js"), "console.log('app')");
  await fs.writeFile(path.join(tmp, "secret-above.txt"), "TOP-SECRET-ABOVE-STATIC-DIR");

  // fake home with files for FS endpoints
  await fs.mkdir(fakeHome, { recursive: true });
  await fs.writeFile(path.join(fakeHome, "readme.txt"), "hello home\n");
  await fs.writeFile(path.join(fakeHome, "img.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 13, 10]));
  await fs.mkdir(path.join(fakeHome, "node_modules", "junk"), { recursive: true });
  await fs.mkdir(path.join(fakeHome, ".git"), { recursive: true });

  // projects root fixture
  await fs.mkdir(path.join(tmp, "projects", "proj-a", ".git"), { recursive: true });
  await fs.mkdir(path.join(tmp, "projects", "proj-b"), { recursive: true });
  await fs.writeFile(path.join(tmp, "projects", "notes.txt"), "not a dir");

  // git repo fixture with one committed + one modified file
  await fs.mkdir(gitRepo, { recursive: true });
  await fs.writeFile(path.join(gitRepo, "a.txt"), "v1\n");
  await x("git", ["init", "-q"], { cwd: gitRepo });
  await x("git", ["add", "."], { cwd: gitRepo });
  await x(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t.t", "commit", "-qm", "init"],
    { cwd: gitRepo }
  );
  await fs.writeFile(path.join(gitRepo, "a.txt"), "v2\n");

  server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address() as net.AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  vi.restoreAllMocks();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("API", () => {
  it("GET /api/agent/env returns wsUrl with the secret", async () => {
    const res = await fetch(`${base}/api/agent/env`);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ready).toBe(true);
    expect(j.wsUrl).toContain("test-secret");
    expect(j.host).toBe("127.0.0.1");
    expect(j.port).toBe(2419);
  });

  it("GET /api/projects lists directories only, with git flag", async () => {
    const res = await fetch(`${base}/api/projects`);
    expect(res.status).toBe(200);
    const j = await res.json();
    const names = j.projects.map((p: { name: string }) => p.name);
    expect(names).toContain("proj-a");
    expect(names).toContain("proj-b");
    expect(names).not.toContain("notes.txt");
    const a = j.projects.find((p: { name: string }) => p.name === "proj-a");
    expect(a.hasGit).toBe(true);
  });

  it("POST /api/fs/write + POST /api/fs/read round-trip under $HOME", async () => {
    const target = path.join(fakeHome, "sub", "out.txt");
    const w = await fetch(`${base}/api/fs/write`, {
      method: "POST",
      body: JSON.stringify({ path: target, content: "hello from test" }),
    });
    expect(w.status).toBe(200);
    const wj = await w.json();
    expect(wj.ok).toBe(true);

    const r = await fetch(`${base}/api/fs/read`, {
      method: "POST",
      body: JSON.stringify({ path: target, raw: true }),
    });
    expect(r.status).toBe(200);
    const rj = await r.json();
    expect(rj.content).toBe("hello from test");
    expect(rj.truncated).toBe(false);
  });

  it("POST /api/fs/read rejects binary files with 415", async () => {
    const res = await fetch(`${base}/api/fs/read`, {
      method: "POST",
      body: JSON.stringify({ path: path.join(fakeHome, "img.png"), raw: true }),
    });
    expect(res.status).toBe(415);
    const j = await res.json();
    expect(j.binary).toBe(true);
  });

  it("POST /api/fs/read rejects paths outside the sandbox with 403", async () => {
    const res = await fetch(`${base}/api/fs/read`, {
      method: "POST",
      body: JSON.stringify({ path: "/etc/hostname" }),
    });
    expect(res.status).toBe(403);
  });

  it("POST /api/fs/write rejects writes outside $HOME with 403", async () => {
    const res = await fetch(`${base}/api/fs/write`, {
      method: "POST",
      body: JSON.stringify({ path: "/tmp/gw-should-not-exist.txt", content: "x" }),
    });
    expect(res.status).toBe(403);
    await fs.rm("/tmp/gw-should-not-exist.txt", { force: true });
  });

  it("POST /api/fs/write validates the body (400)", async () => {
    const res = await fetch(`${base}/api/fs/write`, {
      method: "POST",
      body: JSON.stringify({ path: path.join(fakeHome, "x.txt") }),
    });
    expect(res.status).toBe(400);
  });

  it("GET /api/fs/tree lists entries, filters node_modules/.git, dirs first", async () => {
    const res = await fetch(`${base}/api/fs/tree?path=${encodeURIComponent(fakeHome)}`);
    expect(res.status).toBe(200);
    const j = await res.json();
    const names = j.entries.map((e: { name: string }) => e.name);
    expect(names).toContain("readme.txt");
    expect(names).not.toContain("node_modules");
    expect(names).not.toContain(".git");
  });

  it("GET /api/diffs requires cwd (400)", async () => {
    const res = await fetch(`${base}/api/diffs`);
    expect(res.status).toBe(400);
  });

  it("GET /api/diffs rejects cwd outside sandbox (403)", async () => {
    const res = await fetch(`${base}/api/diffs?cwd=${encodeURIComponent("/etc")}`);
    expect(res.status).toBe(403);
  });

  it("GET /api/diffs returns git status for a real repo", async () => {
    const res = await fetch(
      `${base}/api/diffs?cwd=${encodeURIComponent(gitRepo)}&light=1`
    );
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    const f = j.files.find((x: { path: string }) => x.path === "a.txt");
    expect(f).toBeDefined();
    expect(f.code).toBe("M");
  });

  it("unknown API route → 404 JSON", async () => {
    const res = await fetch(`${base}/api/definitely-not-real`);
    expect(res.status).toBe(404);
    const j = await res.json();
    expect(j.error).toMatch(/no handler/);
  });
});

describe("static serving", () => {
  it("serves index.html at /", async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("fixture-ui");
  });

  it("serves /assets/* with immutable cache", async () => {
    const res = await fetch(`${base}/assets/app.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    expect(res.headers.get("cache-control")).toContain("immutable");
  });

  it("SPA fallback: unknown route returns index.html", async () => {
    const res = await fetch(`${base}/some/unknown/route`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("fixture-ui");
  });

  // The WHATWG URL parser strips dot segments before the handler runs, so these
  // resolve to in-tree misses (SPA fallback) — or hit the 403 guard. Either way,
  // files above the static dir must never be served.
  it("raw .. traversal does not leak files above the static dir", async () => {
    const r = await rawGet("/../secret-above.txt");
    expect([200, 403, 404]).toContain(r.status);
    expect(r.body).not.toContain("TOP-SECRET-ABOVE-STATIC-DIR");
    if (r.status === 200) expect(r.body).toContain("fixture-ui"); // SPA fallback
  });

  it("encoded %2e%2e traversal does not leak files above the static dir", async () => {
    const r = await rawGet("/%2e%2e/secret-above.txt");
    expect([200, 403, 404]).toContain(r.status);
    expect(r.body).not.toContain("TOP-SECRET-ABOVE-STATIC-DIR");
    if (r.status === 200) expect(r.body).toContain("fixture-ui"); // SPA fallback
  });

  it("non-GET on static → 405", async () => {
    const res = await fetch(`${base}/assets/app.js`, { method: "POST" });
    expect(res.status).toBe(405);
  });
});
