import { NextResponse } from "next/server";
import { listModels } from "@/lib/models";

export const runtime = "nodejs";

export async function GET() {
  try {
    const catalog = await listModels();
    return NextResponse.json(catalog);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "models failed" },
      { status: 500 }
    );
  }
}
