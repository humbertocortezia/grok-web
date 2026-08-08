import { NextResponse } from "next/server";
import { getUsageSnapshot } from "@/lib/usage";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const sessionId = url.searchParams.get("sessionId");
  const full = url.searchParams.get("full") === "1";
  const snapshot = await getUsageSnapshot({
    sessionId: sessionId || undefined,
    // full=1 also expands recent sessions with turn cost (slower)
    lightRecent: !full,
  });
  return NextResponse.json(snapshot, {
    headers: { "Cache-Control": "no-store" },
  });
}
