import { NextResponse } from "next/server";
import {
  createSkill,
  deleteSkill,
  listSkills,
  type CreateSkillInput,
} from "@/lib/skills";

export const runtime = "nodejs";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const cwd = url.searchParams.get("cwd") || undefined;
    const skills = await listSkills({ cwd: cwd || undefined });
    return NextResponse.json({
      skills,
      count: skills.length,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "list skills failed" },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as CreateSkillInput;
    if (!body?.name || !body?.description) {
      return NextResponse.json(
        { error: "name e description obrigatórios" },
        { status: 400 }
      );
    }
    const skill = await createSkill(body);
    const skills = await listSkills({ cwd: body.cwd });
    return NextResponse.json({ ok: true, skill, skills });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "create skill failed" },
      { status: 400 }
    );
  }
}

export async function DELETE(req: Request) {
  try {
    const url = new URL(req.url);
    const skillPath = url.searchParams.get("path") || "";
    const cwd = url.searchParams.get("cwd") || undefined;
    if (!skillPath) {
      return NextResponse.json({ error: "path obrigatório" }, { status: 400 });
    }
    await deleteSkill({ path: skillPath, cwd: cwd || undefined });
    const skills = await listSkills({ cwd: cwd || undefined });
    return NextResponse.json({ ok: true, skills });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "delete skill failed" },
      { status: 400 }
    );
  }
}
