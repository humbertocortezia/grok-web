import { NextResponse } from "next/server";
import {
  addMcpServer,
  listMcpServers,
  removeMcpServer,
  setMcpEnabled,
  type AddMcpInput,
  MCP_PRESETS,
} from "@/lib/mcp-config";
import { configPath } from "@/lib/paths";

export const runtime = "nodejs";

export async function GET() {
  try {
    const servers = await listMcpServers();
    return NextResponse.json({
      servers,
      configPath: configPath(),
      presets: MCP_PRESETS,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "list failed" },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as AddMcpInput;
    if (!body?.name || !body?.transport) {
      return NextResponse.json(
        { error: "name e transport obrigatórios" },
        { status: 400 }
      );
    }
    await addMcpServer(body);
    const servers = await listMcpServers();
    return NextResponse.json({ ok: true, servers });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "add failed" },
      { status: 400 }
    );
  }
}

export async function PATCH(req: Request) {
  try {
    const body = (await req.json()) as { name?: string; enabled?: boolean };
    if (!body?.name || typeof body.enabled !== "boolean") {
      return NextResponse.json(
        { error: "name e enabled obrigatórios" },
        { status: 400 }
      );
    }
    await setMcpEnabled(body.name, body.enabled);
    const servers = await listMcpServers();
    return NextResponse.json({ ok: true, servers });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "patch failed" },
      { status: 400 }
    );
  }
}

export async function DELETE(req: Request) {
  try {
    const url = new URL(req.url);
    const name = url.searchParams.get("name") || "";
    const scope = url.searchParams.get("scope") as "user" | "project" | null;
    if (!name) {
      return NextResponse.json({ error: "name obrigatório" }, { status: 400 });
    }
    await removeMcpServer(name, scope || undefined);
    const servers = await listMcpServers();
    return NextResponse.json({ ok: true, servers });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "delete failed" },
      { status: 400 }
    );
  }
}
