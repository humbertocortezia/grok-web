import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export type DiffFile = {
  code: string;
  path: string;
};

export type ParsedDiffFile = {
  path: string;
  lines: Array<{
    type: "ctx" | "add" | "del" | "hunk" | "meta";
    text: string;
    oldNo?: number;
    newNo?: number;
  }>;
};

function parseUnifiedPatch(patch: string): ParsedDiffFile[] {
  const files: ParsedDiffFile[] = [];
  let current: ParsedDiffFile | null = null;
  let oldNo = 0;
  let newNo = 0;

  for (const raw of patch.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      const m = raw.match(/diff --git a\/(.+?) b\/(.+)$/);
      const path = m ? m[2] : raw.slice(11);
      current = { path, lines: [] };
      files.push(current);
      continue;
    }
    if (!current) continue;

    if (
      raw.startsWith("index ") ||
      raw.startsWith("--- ") ||
      raw.startsWith("+++ ") ||
      raw.startsWith("new file") ||
      raw.startsWith("deleted file") ||
      raw.startsWith("similarity ") ||
      raw.startsWith("rename ")
    ) {
      current.lines.push({ type: "meta", text: raw });
      continue;
    }

    if (raw.startsWith("@@")) {
      const m = raw.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) {
        oldNo = parseInt(m[1], 10);
        newNo = parseInt(m[2], 10);
      }
      current.lines.push({ type: "hunk", text: raw });
      continue;
    }

    if (raw.startsWith("+")) {
      current.lines.push({ type: "add", text: raw.slice(1), newNo });
      newNo += 1;
      continue;
    }
    if (raw.startsWith("-")) {
      current.lines.push({ type: "del", text: raw.slice(1), oldNo });
      oldNo += 1;
      continue;
    }
    if (raw.startsWith("\\")) {
      current.lines.push({ type: "meta", text: raw });
      continue;
    }
    // context
    current.lines.push({
      type: "ctx",
      text: raw.startsWith(" ") ? raw.slice(1) : raw,
      oldNo,
      newNo,
    });
    oldNo += 1;
    newNo += 1;
  }

  return files;
}

export type GitStatusResult =
  | {
      ok: true;
      branchLine: string;
      files: DiffFile[];
      stat: string;
      patch: string;
      fileDiffs: ParsedDiffFile[];
    }
  | { ok: false; error: string };

/**
 * @param opts.light  status + branch only (fast)
 * @param opts.path   single-file patch (relative to repo root)
 */
export async function getGitStatus(
  cwd: string,
  opts: { light?: boolean; path?: string } = {}
): Promise<GitStatusResult> {
  try {
    const { stdout: status } = await execFileAsync(
      "git",
      ["status", "--porcelain=v1", "-b"],
      { cwd, maxBuffer: 2 * 1024 * 1024 }
    );

    const files = status
      .split("\n")
      .slice(1)
      .filter(Boolean)
      .map((line) => {
        // rename: "R  old -> new" or "RM old -> new"
        const code = line.slice(0, 2).trim();
        let p = line.slice(3);
        if (p.includes(" -> ")) p = p.split(" -> ").pop() || p;
        // quoted paths
        if (p.startsWith('"') && p.endsWith('"')) {
          p = p.slice(1, -1).replace(/\\"/g, '"');
        }
        return { code, path: p };
      }) as DiffFile[];

    const branchLine = status.split("\n")[0] || "";

    if (opts.light && !opts.path) {
      return {
        ok: true as const,
        branchLine,
        files,
        stat: "",
        patch: "",
        fileDiffs: [],
      };
    }

    const pathArgs = opts.path ? ["--", opts.path] : [];

    let stat = "";
    if (!opts.path) {
      try {
        const { stdout } = await execFileAsync("git", ["diff", "--stat"], {
          cwd,
          maxBuffer: 2 * 1024 * 1024,
        });
        stat = stdout.trim();
      } catch {
        /* ignore */
      }
    }

    const { stdout: diffFull } = await execFileAsync(
      "git",
      ["diff", "--no-color", "--unified=3", ...pathArgs],
      { cwd, maxBuffer: 4 * 1024 * 1024 }
    );

    let staged = "";
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["diff", "--no-color", "--unified=3", "--cached", ...pathArgs],
        { cwd, maxBuffer: 2 * 1024 * 1024 }
      );
      staged = stdout;
    } catch {
      /* ignore */
    }

    // untracked: show as full-add if single path requested
    let untrackedPatch = "";
    if (opts.path) {
      const isUntracked = files.some(
        (f) => f.path === opts.path && (f.code === "??" || f.code === "A")
      );
      if (isUntracked || (files.some((f) => f.path === opts.path && f.code === "??"))) {
        try {
          const { stdout } = await execFileAsync(
            "git",
            ["diff", "--no-color", "--unified=3", "--no-index", "/dev/null", opts.path],
            { cwd, maxBuffer: 2 * 1024 * 1024 }
          );
          untrackedPatch = stdout;
        } catch (e) {
          // git --no-index exits 1 when files differ
          const err = e as { stdout?: string };
          if (err.stdout) untrackedPatch = err.stdout;
        }
      }
    }

    const patch = (
      diffFull +
      (staged ? "\n" + staged : "") +
      (untrackedPatch ? "\n" + untrackedPatch : "")
    ).slice(0, 200_000);
    const parsed = parseUnifiedPatch(patch);

    return {
      ok: true as const,
      branchLine,
      files,
      stat,
      patch,
      fileDiffs: parsed,
    };
  } catch (error) {
    return {
      ok: false as const,
      error: error instanceof Error ? error.message : "git failed",
    };
  }
}
