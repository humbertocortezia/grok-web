import fs from "fs/promises";
import path from "path";
import os from "os";
import { grokHome } from "./paths";

export type SkillView = {
  name: string;
  description: string;
  shortDescription?: string;
  path: string;
  /** user | bundled | project | agents | other */
  source: string;
  scope: string;
  /** Safe to delete from disk via grok-web (user/project only). */
  removable: boolean;
  /** Appears as /name slash command. */
  userInvocable: boolean;
};

function expandHome(p: string): string {
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function parseFrontmatter(raw: string): {
  name?: string;
  description?: string;
  shortDescription?: string;
  userInvocable?: boolean;
} {
  if (!raw.startsWith("---")) return {};
  const end = raw.indexOf("\n---", 3);
  if (end < 0) return {};
  const block = raw.slice(3, end).trim();
  const out: {
    name?: string;
    description?: string;
    shortDescription?: string;
    userInvocable?: boolean;
  } = {};

  // Lightweight YAML-ish: name, description (block or inline), metadata.short-description
  let key = "";
  let buf = "";
  let inBlock = false;

  const flush = () => {
    if (!key) return;
    const v = buf.trim();
    if (key === "name") out.name = v.replace(/^["']|["']$/g, "");
    else if (key === "description") out.description = v.replace(/^["']|["']$/g, "");
    else if (key === "short-description" || key === "metadata.short-description") {
      out.shortDescription = v.replace(/^["']|["']$/g, "");
    } else if (key === "user-invocable") {
      out.userInvocable = !/^(false|no|0)$/i.test(v);
    }
    key = "";
    buf = "";
    inBlock = false;
  };

  for (const line of block.split("\n")) {
    if (inBlock) {
      if (/^\s{2,}\S/.test(line) || line.trim() === ">") {
        buf += (buf ? " " : "") + line.trim().replace(/^>\s?/, "");
        continue;
      }
      flush();
    }
    const m = line.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (!m) {
      // nested metadata.short-description under metadata:
      const nested = line.match(/^\s+(short-description):\s*(.*)$/);
      if (nested) {
        flush();
        key = "short-description";
        const rest = nested[2];
        if (rest === ">" || rest === "|") {
          inBlock = true;
          buf = "";
        } else {
          buf = rest;
          flush();
        }
      }
      continue;
    }
    flush();
    key = m[1];
    const rest = m[2];
    if (rest === ">" || rest === "|") {
      inBlock = true;
      buf = "";
    } else {
      buf = rest;
      flush();
    }
  }
  flush();
  return out;
}

async function readSkillDir(
  dir: string,
  source: string,
  scope: string
): Promise<SkillView | null> {
  const skillMd = path.join(dir, "SKILL.md");
  try {
    const raw = await fs.readFile(skillMd, "utf8");
    const fm = parseFrontmatter(raw);
    const base = path.basename(dir);
    const name = (fm.name || base).trim();
    const description = (fm.description || "").trim() || "(sem description)";
    const removable =
      scope === "user" ||
      scope === "project" ||
      source === "user" ||
      source === "project" ||
      source === "project-agents" ||
      source === "agents";
    return {
      name,
      description,
      shortDescription: fm.shortDescription,
      path: skillMd,
      source,
      scope,
      removable,
      userInvocable: fm.userInvocable !== false,
    };
  } catch {
    return null;
  }
}

async function scanSkillsRoot(
  root: string,
  source: string,
  scope: string
): Promise<SkillView[]> {
  const abs = expandHome(root);
  let entries: { name: string; isDirectory: () => boolean }[];
  try {
    entries = await fs.readdir(abs, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: SkillView[] = [];
  await Promise.all(
    entries.map(async (ent) => {
      if (!ent.isDirectory()) return;
      if (ent.name.startsWith(".")) return;
      const skill = await readSkillDir(path.join(abs, ent.name), source, scope);
      if (skill) out.push(skill);
    })
  );
  return out;
}

/**
 * Discover skills the same places Grok looks (user, bundled, agents, project).
 * Higher-priority sources override by name.
 */
export async function listSkills(opts: {
  cwd?: string;
} = {}): Promise<SkillView[]> {
  const cwd = opts.cwd || process.cwd();
  const home = grokHome();

  // Priority low → high so later overwrites
  const roots: Array<{ path: string; source: string; scope: string }> = [
    { path: path.join(home, "bundled", "skills"), source: "bundled", scope: "bundled" },
    { path: path.join(os.homedir(), ".agents", "skills"), source: "agents", scope: "user" },
    { path: path.join(home, "skills"), source: "user", scope: "user" },
    { path: path.join(os.homedir(), ".claude", "skills"), source: "claude", scope: "user" },
    { path: path.join(os.homedir(), ".cursor", "skills"), source: "cursor", scope: "user" },
  ];

  // Project / walk up a few levels for .grok/skills and .agents/skills
  let dir = cwd;
  for (let i = 0; i < 6; i++) {
    roots.push(
      {
        path: path.join(dir, ".agents", "skills"),
        source: "project-agents",
        scope: "project",
      },
      {
        path: path.join(dir, ".grok", "skills"),
        source: "project",
        scope: "project",
      },
      {
        path: path.join(dir, ".claude", "skills"),
        source: "project-claude",
        scope: "project",
      }
    );
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  const byName = new Map<string, SkillView>();
  for (const r of roots) {
    const found = await scanSkillsRoot(r.path, r.source, r.scope);
    for (const s of found) {
      byName.set(s.name, s); // higher priority overwrites
    }
  }

  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function assertSkillName(name: string) {
  if (!/^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/.test(name)) {
    throw new Error(
      "Nome inválido: 2–64 chars, minúsculas, dígitos e hífen; começa/termina em letra ou dígito."
    );
  }
}

export type CreateSkillInput = {
  name: string;
  description: string;
  body?: string;
  /** user → ~/.grok/skills · project → <cwd>/.grok/skills */
  scope?: "user" | "project";
  cwd?: string;
};

/** Create ~/.grok/skills/<name>/SKILL.md (or project .grok/skills). */
export async function createSkill(input: CreateSkillInput): Promise<SkillView> {
  const name = input.name.trim().toLowerCase();
  assertSkillName(name);
  const description = (input.description || "").trim();
  if (!description) throw new Error("description obrigatória");

  const scope = input.scope === "project" ? "project" : "user";
  const root =
    scope === "project"
      ? path.join(input.cwd || process.cwd(), ".grok", "skills", name)
      : path.join(grokHome(), "skills", name);

  const skillMd = path.join(root, "SKILL.md");
  try {
    await fs.access(skillMd);
    throw new Error(`Skill “${name}” já existe em ${root}`);
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("Skill")) throw e;
  }

  await fs.mkdir(root, { recursive: true });
  const descLines = description
    .split(/\n/)
    .map((l) => `  ${l}`)
    .join("\n");
  const body =
    (input.body || "").trim() ||
    `# ${name}\n\nInstruções para o Grok quando esta skill for invocada.\n\n## Passos\n\n1. …\n`;
  const content = `---
name: ${name}
description: >
${descLines}
user-invocable: true
---

${body.endsWith("\n") ? body : body + "\n"}`;
  await fs.writeFile(skillMd, content, "utf8");

  return {
    name,
    description,
    path: skillMd,
    source: scope === "project" ? "project" : "user",
    scope,
    removable: true,
    userInvocable: true,
  };
}

/**
 * Remove a skill directory. Only paths under user/project skill roots.
 */
export async function deleteSkill(opts: {
  path: string;
  cwd?: string;
}): Promise<void> {
  const skillMd = path.resolve(opts.path);
  if (!skillMd.endsWith(`${path.sep}SKILL.md`) && !skillMd.endsWith("/SKILL.md")) {
    throw new Error("path deve apontar para SKILL.md");
  }
  const dir = path.dirname(skillMd);
  const allowed = [
    path.join(grokHome(), "skills"),
    path.join(os.homedir(), ".agents", "skills"),
  ];
  if (opts.cwd) {
    allowed.push(path.join(path.resolve(opts.cwd), ".grok", "skills"));
    allowed.push(path.join(path.resolve(opts.cwd), ".agents", "skills"));
  }
  // also allow under any parent .grok/skills from cwd walk
  let walk = opts.cwd ? path.resolve(opts.cwd) : process.cwd();
  for (let i = 0; i < 6; i++) {
    allowed.push(path.join(walk, ".grok", "skills"));
    allowed.push(path.join(walk, ".agents", "skills"));
    const parent = path.dirname(walk);
    if (parent === walk) break;
    walk = parent;
  }

  const ok = allowed.some(
    (root) => dir === root || dir.startsWith(root + path.sep)
  );
  if (!ok) {
    throw new Error(
      "Só é possível remover skills em ~/.grok/skills, ~/.agents/skills ou .grok/skills do projeto (não bundled)."
    );
  }

  // Never delete bundled
  const bundled = path.join(grokHome(), "bundled", "skills");
  if (dir === bundled || dir.startsWith(bundled + path.sep)) {
    throw new Error("Skills bundled não podem ser removidas");
  }

  await fs.rm(dir, { recursive: true, force: true });
}
