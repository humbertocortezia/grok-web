import os from "os";
import path from "path";

/**
 * Sandbox for local FS operations in grok-web.
 * Only paths under $HOME (and /tmp for read) are allowed.
 */
export function resolveAllowedPath(
  filePath: string,
  opts: { write?: boolean } = {}
): { ok: true; resolved: string } | { ok: false; error: string } {
  if (!filePath || typeof filePath !== "string") {
    return { ok: false, error: "path required" };
  }
  // Reject null bytes / weird escapes
  if (filePath.includes("\0")) {
    return { ok: false, error: "invalid path" };
  }

  const resolved = path.resolve(filePath);
  const home = os.homedir();
  const tmp = os.tmpdir();

  const underHome =
    resolved === home || resolved.startsWith(home + path.sep);
  const underTmp =
    resolved === tmp ||
    resolved.startsWith(tmp + path.sep) ||
    resolved.startsWith("/tmp/") ||
    resolved.startsWith("/var/tmp/");

  if (opts.write) {
    if (!underHome) {
      return { ok: false, error: "write only allowed under $HOME" };
    }
  } else if (!underHome && !underTmp) {
    return { ok: false, error: "path not allowed" };
  }

  return { ok: true, resolved };
}

export function isTextLike(filePath: string, sample?: Buffer): boolean {
  const ext = path.extname(filePath).toLowerCase();
  const textExt = new Set([
    "",
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".json",
    ".md",
    ".mdx",
    ".css",
    ".scss",
    ".html",
    ".htm",
    ".svg",
    ".txt",
    ".toml",
    ".yaml",
    ".yml",
    ".xml",
    ".env",
    ".sh",
    ".bash",
    ".zsh",
    ".py",
    ".rb",
    ".go",
    ".rs",
    ".java",
    ".kt",
    ".c",
    ".h",
    ".cpp",
    ".hpp",
    ".cs",
    ".php",
    ".sql",
    ".graphql",
    ".vue",
    ".svelte",
    ".astro",
    ".dockerfile",
    ".gitignore",
    ".gitattributes",
    ".editorconfig",
    ".prettierrc",
    ".eslintrc",
    ".lock",
    ".csv",
    ".tsv",
    ".ini",
    ".cfg",
    ".conf",
    ".log",
    ".rhai",
  ]);
  if (textExt.has(ext)) return true;
  if (sample) {
    // NUL in first bytes → binary
    const n = Math.min(sample.length, 8000);
    for (let i = 0; i < n; i++) {
      if (sample[i] === 0) return false;
    }
    return true;
  }
  return false;
}
