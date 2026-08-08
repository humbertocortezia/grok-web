import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { isTextLike, resolveAllowedPath } from "@/lib/fs-sandbox";

export const runtime = "nodejs";

/** Max bytes returned for editor view (full file otherwise truncated). */
const MAX_EDITOR_BYTES = 1_500_000;

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      path?: string;
      line?: number;
      limit?: number;
      /** raw text for editor (no line prefixes) */
      raw?: boolean;
    };
    const filePath = body.path;
    if (!filePath || typeof filePath !== "string") {
      return NextResponse.json({ error: "path required" }, { status: 400 });
    }
    const check = resolveAllowedPath(filePath);
    if (!check.ok) {
      return NextResponse.json({ error: check.error }, { status: 403 });
    }

    const resolved = check.resolved;
    const st = await fs.stat(resolved);
    if (!st.isFile()) {
      return NextResponse.json({ error: "not a file" }, { status: 400 });
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
      return NextResponse.json(
        {
          error: "binary file",
          binary: true,
          path: resolved,
          size: st.size,
        },
        { status: 415 }
      );
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
        return NextResponse.json({
          content: buf.toString("utf8"),
          path: resolved,
          size: st.size,
          truncated: true,
          mtimeMs: st.mtimeMs,
        });
      }
      const content = await fs.readFile(resolved, "utf8");
      return NextResponse.json({
        content,
        path: resolved,
        size: st.size,
        truncated: false,
        mtimeMs: st.mtimeMs,
      });
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

    return NextResponse.json({
      content,
      path: resolved,
      size: st.size,
      mtimeMs: st.mtimeMs,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "read failed" },
      { status: 500 }
    );
  }
}
