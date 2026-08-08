import { NextResponse } from "next/server";
import { getGitStatus } from "@/lib/git-diff";
import { resolveAllowedPath } from "@/lib/fs-sandbox";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const cwd = searchParams.get("cwd");
  const light = searchParams.get("light") === "1";
  const filePath = searchParams.get("path") || undefined;

  if (!cwd) {
    return NextResponse.json({ error: "cwd required" }, { status: 400 });
  }

  const check = resolveAllowedPath(cwd);
  if (!check.ok) {
    return NextResponse.json({ error: check.error }, { status: 403 });
  }

  const result = await getGitStatus(check.resolved, {
    light,
    path: filePath || undefined,
  });
  return NextResponse.json(result, {
    headers: { "Cache-Control": "no-store" },
  });
}
