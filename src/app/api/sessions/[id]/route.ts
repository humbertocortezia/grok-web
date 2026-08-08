import { NextResponse } from "next/server";
import { getSessionDetail } from "@/lib/sessions";

export const runtime = "nodejs";

function parseIntParam(v: string | null): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.floor(n) : null;
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const ifRev = url.searchParams.get("rev");
  const limit = parseIntParam(url.searchParams.get("limit")) ?? 24;
  const before = parseIntParam(url.searchParams.get("before"));
  const after = parseIntParam(url.searchParams.get("after"));
  const light = url.searchParams.get("light") === "1";

  const detail = await getSessionDetail(id, {
    ifRev,
    limit,
    before,
    after,
    light,
  });
  if (!detail) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  if (detail.unchanged) {
    return NextResponse.json(
      { unchanged: true, rev: detail.rev, meta: detail.meta },
      { headers: { "Cache-Control": "no-store" } }
    );
  }

  return NextResponse.json(detail, {
    headers: { "Cache-Control": "no-store" },
  });
}
