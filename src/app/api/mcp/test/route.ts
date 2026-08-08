import { NextResponse } from "next/server";
import { doctorMcp } from "@/lib/mcp-config";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { name?: string };
    const { results, raw } = await doctorMcp(body?.name);
    return NextResponse.json({ results, raw });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "doctor failed" },
      { status: 500 }
    );
  }
}
