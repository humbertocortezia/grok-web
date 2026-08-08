import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { resolveAllowedPath } from "@/lib/fs-sandbox";

export const runtime = "nodejs";

const MAX_WRITE_BYTES = 2_000_000;

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { path?: string; content?: string };
    const filePath = body.path;
    if (!filePath || typeof filePath !== "string") {
      return NextResponse.json({ error: "path required" }, { status: 400 });
    }
    if (typeof body.content !== "string") {
      return NextResponse.json({ error: "content required" }, { status: 400 });
    }
    if (Buffer.byteLength(body.content, "utf8") > MAX_WRITE_BYTES) {
      return NextResponse.json(
        { error: `content too large (max ${MAX_WRITE_BYTES} bytes)` },
        { status: 413 }
      );
    }

    const check = resolveAllowedPath(filePath, { write: true });
    if (!check.ok) {
      return NextResponse.json({ error: check.error }, { status: 403 });
    }

    const resolved = check.resolved;
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, body.content, "utf8");
    const st = await fs.stat(resolved);
    return NextResponse.json({
      ok: true,
      path: resolved,
      size: st.size,
      mtimeMs: st.mtimeMs,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "write failed" },
      { status: 500 }
    );
  }
}
