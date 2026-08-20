import { describe, it, expect } from "vitest";
import {
  BUILTIN_SLASH,
  filterSlashCommands,
  parseSlashInput,
  skillsToSlash,
} from "../src/lib/slash-commands";

describe("parseSlashInput", () => {
  it("inactive for plain text", () => {
    expect(parseSlashInput("hello world").active).toBe(false);
  });

  it("active with empty filter on bare /", () => {
    const r = parseSlashInput("/");
    expect(r.active).toBe(true);
    expect(r.filter).toBe("");
    expect(r.hasArgs).toBe(false);
  });

  it("parses command name without args", () => {
    const r = parseSlashInput("/model");
    expect(r.commandName).toBe("model");
    expect(r.hasArgs).toBe(false);
    expect(r.args).toBe("");
  });

  it("splits command and args on first space", () => {
    const r = parseSlashInput("/model grok-4.5 extra");
    expect(r.commandName).toBe("model");
    expect(r.hasArgs).toBe(true);
    expect(r.args).toBe("grok-4.5 extra");
  });

  it("does not activate for / inside a word", () => {
    const r = parseSlashInput("foo/bar");
    expect(r.active).toBe(false);
  });
});

describe("filterSlashCommands", () => {
  it("returns all builtins (up to 40) for empty query", () => {
    const all = filterSlashCommands(BUILTIN_SLASH, "");
    expect(all.length).toBe(Math.min(40, BUILTIN_SLASH.length));
  });

  it("exact name match ranks first", () => {
    const r = filterSlashCommands(BUILTIN_SLASH, "compact");
    expect(r[0].name).toBe("compact");
  });

  it("strips a leading slash from the query", () => {
    const r = filterSlashCommands(BUILTIN_SLASH, "/plan");
    expect(r[0].name).toBe("plan");
  });

  it("prefix match beats subsequence match", () => {
    const r = filterSlashCommands(BUILTIN_SLASH, "pl");
    expect(r[0].name).toBe("plan");
  });

  it("matches aliases (status → session-info)", () => {
    const r = filterSlashCommands(BUILTIN_SLASH, "status");
    expect(r[0].name).toBe("session-info");
  });

  it("falls back to description match", () => {
    const r = filterSlashCommands(BUILTIN_SLASH, "mcp");
    expect(r.map((c) => c.name)).toContain("mcps");
    expect(r[0].name).toBe("mcps");
  });

  it("returns empty for nonsense query", () => {
    expect(filterSlashCommands(BUILTIN_SLASH, "zzzzqqq")).toHaveLength(0);
  });
});

describe("skillsToSlash", () => {
  it("maps skills to /name commands with source skill", () => {
    const out = skillsToSlash([
      { name: "deploy", description: "Deploy the app" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].command).toBe("/deploy");
    expect(out[0].source).toBe("skill");
    expect(out[0].description).toBe("Deploy the app");
  });

  it("filters out non-invocable skills", () => {
    const out = skillsToSlash([
      { name: "hidden", description: "x", userInvocable: false },
      { name: "visible", description: "y" },
    ]);
    expect(out.map((s) => s.name)).toEqual(["visible"]);
  });

  it("truncates long descriptions to 120 chars and prefers shortDescription", () => {
    const long = "z".repeat(300);
    const out = skillsToSlash([
      { name: "big", description: long, shortDescription: "short one" },
      { name: "longer", description: long },
    ]);
    expect(out[0].description).toBe("short one");
    expect(out[1].description).toHaveLength(120);
  });
});
