import fs from "fs/promises";
import type { Dirent } from "fs";
import path from "path";
import { defaultProjectsRoot } from "./paths";

export type ProjectEntry = {
  name: string;
  path: string;
  hasGit: boolean;
  mtimeMs: number;
};

export async function listProjects(root = defaultProjectsRoot()): Promise<ProjectEntry[]> {
  let entries: Dirent[] = [];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const out: ProjectEntry[] = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (ent.name.startsWith(".")) continue;
    const full = path.join(root, ent.name);
    let hasGit = false;
    let mtimeMs = 0;
    try {
      const st = await fs.stat(full);
      mtimeMs = st.mtimeMs;
      await fs.access(path.join(full, ".git"));
      hasGit = true;
    } catch {
      // ignore
    }
    out.push({ name: ent.name, path: full, hasGit, mtimeMs });
  }

  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}
