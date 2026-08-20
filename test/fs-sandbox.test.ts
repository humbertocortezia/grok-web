import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { resolveAllowedPath, isTextLike } from "../server/lib/fs-sandbox";

let tmpHome: string;
let spy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "gw-home-"));
  spy = vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
});

afterEach(async () => {
  spy.mockRestore();
  await fs.rm(tmpHome, { recursive: true, force: true });
});

describe("resolveAllowedPath", () => {
  it("allows read under $HOME", () => {
    const r = resolveAllowedPath(path.join(tmpHome, "projos/app/src/main.ts"));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.resolved).toBe(path.join(tmpHome, "projos/app/src/main.ts"));
  });

  it("allows read at $HOME root", () => {
    expect(resolveAllowedPath(tmpHome).ok).toBe(true);
  });

  it("allows read under /tmp", () => {
    expect(resolveAllowedPath("/tmp/some-file.txt").ok).toBe(true);
  });

  it("denies read outside $HOME and /tmp", () => {
    const r = resolveAllowedPath("/etc/passwd");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("path not allowed");
  });

  it("allows write under $HOME", () => {
    expect(resolveAllowedPath(path.join(tmpHome, "x.txt"), { write: true }).ok).toBe(true);
  });

  it("denies write under /tmp (writes only under $HOME)", () => {
    const r = resolveAllowedPath("/tmp/x.txt", { write: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("write only allowed under $HOME");
  });

  it("denies write outside $HOME", () => {
    expect(resolveAllowedPath("/etc/x.txt", { write: true }).ok).toBe(false);
  });

  it("denies traversal escaping $HOME", () => {
    const r = resolveAllowedPath(path.join(tmpHome, "..", "..", "etc", "passwd"));
    expect(r.ok).toBe(false);
  });

  it("denies write to a sibling that shares the $HOME string prefix", () => {
    // "$HOME-evil" starts with the $HOME string but is NOT under $HOME —
    // the check must use home + path.sep, not a bare prefix.
    const r = resolveAllowedPath(tmpHome + "-evil/file.txt", { write: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("write only allowed under $HOME");
  });

  it("rejects null bytes", () => {
    const r = resolveAllowedPath(path.join(tmpHome, "a\0b.txt"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("invalid path");
  });

  it("rejects empty path", () => {
    const r = resolveAllowedPath("");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("path required");
  });
});

describe("isTextLike", () => {
  it("treats known text extensions as text without sampling", () => {
    for (const f of ["a.ts", "b.md", "c.json", "d.css", "e.svg", "f"]) {
      expect(isTextLike(f)).toBe(true);
    }
  });

  it("treats unknown extensions as binary without a sample", () => {
    expect(isTextLike("model.bin")).toBe(false);
    expect(isTextLike("archive.xyz123")).toBe(false);
  });

  it("detects NUL bytes in the sample as binary", () => {
    const sample = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 1, 2]);
    expect(isTextLike("unknown.xyz", sample)).toBe(false);
  });

  it("accepts clean samples for unknown extensions", () => {
    const sample = Buffer.from("plain text content, no nul bytes");
    expect(isTextLike("notes.xyz", sample)).toBe(true);
  });

  it("scans up to 8000 bytes for NUL", () => {
    const beyond = Buffer.alloc(9000, 65); // 'A'
    beyond[8500] = 0; // NUL beyond scan window → still text
    expect(isTextLike("big.xyz", beyond)).toBe(true);

    const within = Buffer.alloc(9000, 65);
    within[100] = 0; // NUL inside scan window → binary
    expect(isTextLike("big2.xyz", within)).toBe(false);
  });
});
