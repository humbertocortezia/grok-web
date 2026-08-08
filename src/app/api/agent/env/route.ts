import { NextResponse } from "next/server";

export const runtime = "nodejs";

/** Public bootstrap info for the browser ACP client (secret only on localhost). */
export async function GET() {
  const secret = process.env.GROK_AGENT_SECRET || "";
  const host = process.env.GROK_AGENT_HOST || "127.0.0.1";
  const port = process.env.GROK_AGENT_PORT || "2419";
  const wsUrl =
    process.env.GROK_AGENT_WS_URL ||
    `ws://${host}:${port}/ws?server-key=${encodeURIComponent(secret)}`;

  return NextResponse.json({
    ready: Boolean(secret),
    wsUrl: secret ? wsUrl : null,
    host,
    port: Number(port),
    defaultCwd: process.env.GROK_WEB_DEFAULT_CWD || process.cwd(),
  });
}
