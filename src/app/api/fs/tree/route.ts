import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { resolveAllowedPath } from "@/lib/fs-sandbox";

export const runtime = "nodejs";

const IGNORE = new Set([
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

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const dirPath = url.searchParams.get("path") || "";
    const check = resolveAllowedPath(dirPath);
    if (!check.ok) {
      return NextResponse.json({ error: check.error }, { status: 403 });
    }

    const st = await fs.stat(check.resolved);
    if (!st.isDirectory()) {
      return NextResponse.json({ error: "not a directory" }, { status: 400 });
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
      if (IGNORE.has(ent.name)) continue;
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

    return NextResponse.json({
      path: check.resolved,
      entries: out,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "tree failed" },
      { status: 500 }
    );
  }
}
