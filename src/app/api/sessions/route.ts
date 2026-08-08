import { NextResponse } from "next/server";
import { listSessions } from "@/lib/sessions";

export const runtime = "nodejs";

export async function GET() {
  const sessions = await listSessions(120);
  return NextResponse.json({ sessions });
}
