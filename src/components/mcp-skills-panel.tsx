"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Loader2,
  Plus,
  Power,
  RefreshCw,
  Sparkles,
  Stethoscope,
  Trash2,
  X,
} from "lucide-react";
import { cn } from "@/lib/cn";

type McpServer = {
  name: string;
  enabled: boolean;
  type: string;
  command?: string;
  args?: string[];
  url?: string;
  scope?: string;
  source?: string;
};

type McpPreset = {
  id: string;
  label: string;
  transport: "stdio" | "http" | "sse";
  name: string;
  url?: string;
  command?: string;
  args?: string[];
  note?: string;
};

type DoctorCheck = { label: string; passed: boolean; detail?: string };
type DoctorResult = {
  name: string;
  healthy: boolean;
  transport?: string;
  target?: string;
  checks: DoctorCheck[];
};

type Skill = {
  name: string;
  description: string;
  shortDescription?: string;
  path: string;
  source: string;
  scope: string;
  removable?: boolean;
  userInvocable?: boolean;
};

type PanelTab = "mcp" | "skills";

export function McpSkillsPanel({
  cwd,
  liveMcp,
}: {
  cwd?: string | null;
  liveMcp?: unknown[];
}) {
  const [tab, setTab] = useState<PanelTab>("mcp");
  const [servers, setServers] = useState<McpServer[]>([]);
  const [presets, setPresets] = useState<McpPreset[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [configPath, setConfigPath] = useState("");
  const [loading, setLoading] = useState(true);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyName, setBusyName] = useState<string | null>(null);
  const [doctor, setDoctor] = useState<Record<string, DoctorResult>>({});
  const [doctorAll, setDoctorAll] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [showAddSkill, setShowAddSkill] = useState(false);
  const [expandedSkill, setExpandedSkill] = useState<string | null>(null);
  const [skillQuery, setSkillQuery] = useState("");
  const [skillName, setSkillName] = useState("");
  const [skillDesc, setSkillDesc] = useState("");
  const [skillBody, setSkillBody] = useState("");
  const [skillScope, setSkillScope] = useState<"user" | "project">("user");
  const [skillBusy, setSkillBusy] = useState(false);

  // Add form
  const [transport, setTransport] = useState<"stdio" | "http" | "sse">("http");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [command, setCommand] = useState("npx");
  const [argsText, setArgsText] = useState("");
  const [headerText, setHeaderText] = useState("");
  const [envText, setEnvText] = useState("");
  const [scope, setScope] = useState<"user" | "project">("user");
  const [adding, setAdding] = useState(false);

  const refreshMcp = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/mcp");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "falha ao listar MCP");
      setServers(data.servers || []);
      setPresets(data.presets || []);
      setConfigPath(data.configPath || "");
    } catch (e) {
      setError(e instanceof Error ? e.message : "erro");
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshSkills = useCallback(async () => {
    setSkillsLoading(true);
    try {
      const q = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
      const res = await fetch(`/api/skills${q}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "falha ao listar skills");
      setSkills(data.skills || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "erro skills");
    } finally {
      setSkillsLoading(false);
    }
  }, [cwd]);

  useEffect(() => {
    void refreshMcp();
  }, [refreshMcp]);

  useEffect(() => {
    if (tab === "skills" && skills.length === 0) void refreshSkills();
  }, [tab, skills.length, refreshSkills]);

  const filteredSkills = useMemo(() => {
    const q = skillQuery.trim().toLowerCase();
    if (!q) return skills;
    return skills.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.source.toLowerCase().includes(q)
    );
  }, [skills, skillQuery]);

  function applyPreset(p: McpPreset) {
    setTransport(p.transport);
    setName(p.name);
    setUrl(p.url || "");
    setCommand(p.command || "npx");
    setArgsText((p.args || []).join(" "));
    setShowAdd(true);
  }

  async function onAdd() {
    setAdding(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        name: name.trim(),
        transport,
        scope,
      };
      if (transport === "http" || transport === "sse") {
        body.url = url.trim();
        if (headerText.trim()) {
          body.headers = headerText
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean);
        }
      } else {
        body.command = command.trim();
        body.args = argsText.trim() ? argsText.trim().split(/\s+/) : [];
        if (envText.trim()) {
          body.env = envText
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean);
        }
      }
      const res = await fetch("/api/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "add failed");
      setServers(data.servers || []);
      setShowAdd(false);
      setName("");
      setUrl("");
      setArgsText("");
      setHeaderText("");
      setEnvText("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "add failed");
    } finally {
      setAdding(false);
    }
  }

  async function onToggle(s: McpServer) {
    setBusyName(s.name);
    setError(null);
    try {
      const res = await fetch("/api/mcp", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: s.name, enabled: !s.enabled }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "toggle failed");
      setServers(data.servers || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "toggle failed");
    } finally {
      setBusyName(null);
    }
  }

  async function onRemove(s: McpServer) {
    if (!confirm(`Remover MCP “${s.name}”?`)) return;
    setBusyName(s.name);
    setError(null);
    try {
      const scope = s.scope === "project" ? "project" : "user";
      const res = await fetch(
        `/api/mcp?name=${encodeURIComponent(s.name)}&scope=${scope}`,
        { method: "DELETE" }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "remove failed");
      setServers(data.servers || []);
      setDoctor((prev) => {
        const next = { ...prev };
        delete next[s.name];
        return next;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "remove failed");
    } finally {
      setBusyName(null);
    }
  }

  async function onCreateSkill() {
    setSkillBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: skillName.trim(),
          description: skillDesc.trim(),
          body: skillBody.trim() || undefined,
          scope: skillScope,
          cwd: cwd || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "create failed");
      setSkills(data.skills || []);
      setShowAddSkill(false);
      setSkillName("");
      setSkillDesc("");
      setSkillBody("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "create failed");
    } finally {
      setSkillBusy(false);
    }
  }

  async function onDeleteSkill(s: Skill) {
    if (!s.removable) return;
    if (!confirm(`Remover skill “${s.name}”?\n${s.path}`)) return;
    setSkillBusy(true);
    setError(null);
    try {
      const q = new URLSearchParams({ path: s.path });
      if (cwd) q.set("cwd", cwd);
      const res = await fetch(`/api/skills?${q}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "delete failed");
      setSkills(data.skills || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "delete failed");
    } finally {
      setSkillBusy(false);
    }
  }

  async function onTest(name?: string) {
    if (name) setBusyName(name);
    else setDoctorAll(true);
    setError(null);
    try {
      const res = await fetch("/api/mcp/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(name ? { name } : {}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "doctor failed");
      const map: Record<string, DoctorResult> = { ...doctor };
      for (const r of (data.results || []) as DoctorResult[]) {
        map[r.name] = r;
      }
      setDoctor(map);
    } catch (e) {
      setError(e instanceof Error ? e.message : "doctor failed");
    } finally {
      setBusyName(null);
      setDoctorAll(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      {/* Sub-tabs */}
      <div className="flex items-center gap-1 rounded-lg border border-[var(--border)] bg-[var(--bg-soft)] p-0.5">
        <button
          type="button"
          className={cn(
            "flex-1 rounded-md px-2 py-1 text-[11px] font-medium transition",
            tab === "mcp"
              ? "bg-[var(--bg-panel)] text-[var(--text)] shadow-sm"
              : "text-[var(--muted)] hover:text-[var(--text)]"
          )}
          onClick={() => setTab("mcp")}
        >
          MCP
          <span className="ml-1 tabular-nums text-[var(--muted)]">
            {servers.length}
          </span>
        </button>
        <button
          type="button"
          className={cn(
            "flex-1 rounded-md px-2 py-1 text-[11px] font-medium transition",
            tab === "skills"
              ? "bg-[var(--bg-panel)] text-[var(--text)] shadow-sm"
              : "text-[var(--muted)] hover:text-[var(--text)]"
          )}
          onClick={() => setTab("skills")}
        >
          Skills
          <span className="ml-1 tabular-nums text-[var(--muted)]">
            {skills.length || "·"}
          </span>
        </button>
      </div>

      {error ? (
        <div className="rounded-lg border border-[color-mix(in_srgb,#f87171_35%,transparent)] bg-[color-mix(in_srgb,#f87171_10%,transparent)] px-2.5 py-1.5 text-[11px] text-[var(--text)]">
          {error}
          <button
            type="button"
            className="ml-2 text-[var(--muted)] underline"
            onClick={() => setError(null)}
          >
            ok
          </button>
        </div>
      ) : null}

      {tab === "mcp" ? (
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-0.5">
          <div className="flex items-center justify-between gap-1">
            <div className="truncate text-[10px] text-[var(--muted)]" title={configPath}>
              {configPath.replace(/\/home\/[^/]+/, "~") || "~/.grok/config.toml"}
            </div>
            <div className="flex shrink-0 items-center gap-0.5">
              <button
                type="button"
                className="rounded-md p-1.5 text-[var(--muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
                title="Atualizar"
                onClick={() => void refreshMcp()}
              >
                <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
              </button>
              <button
                type="button"
                className="rounded-md p-1.5 text-[var(--muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
                title="Testar todos (doctor)"
                disabled={doctorAll}
                onClick={() => void onTest()}
              >
                {doctorAll ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Stethoscope className="h-3.5 w-3.5" />
                )}
              </button>
              <button
                type="button"
                className={cn(
                  "inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition",
                  showAdd
                    ? "bg-[var(--bg-hover)] text-[var(--text)]"
                    : "bg-[var(--text)] text-[var(--bg)] hover:opacity-90"
                )}
                onClick={() => setShowAdd((v) => !v)}
              >
                {showAdd ? <X className="h-3 w-3" /> : <Plus className="h-3 w-3" />}
                {showAdd ? "Fechar" : "Add"}
              </button>
            </div>
          </div>

          {showAdd ? (
            <div className="space-y-2 rounded-xl border border-[var(--border)] bg-[var(--bg-soft)] p-2.5">
              <div className="text-[11px] font-medium text-[var(--text-secondary)]">
                Adicionar MCP
              </div>
              {presets.length > 0 ? (
                <div className="flex flex-wrap gap-1">
                  {presets.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      className="rounded-full border border-[var(--border)] px-2 py-0.5 text-[10px] text-[var(--muted)] transition hover:border-[var(--accent)] hover:text-[var(--text)]"
                      onClick={() => applyPreset(p)}
                      title={p.note}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              ) : null}

              <div className="grid grid-cols-3 gap-1">
                {(["http", "sse", "stdio"] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    className={cn(
                      "rounded-md border px-1.5 py-1 text-[10px] font-medium uppercase tracking-wide",
                      transport === t
                        ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--text)]"
                        : "border-[var(--border)] text-[var(--muted)]"
                    )}
                    onClick={() => setTransport(t)}
                  >
                    {t}
                  </button>
                ))}
              </div>

              <label className="block text-[10px] text-[var(--muted)]">
                Nome
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="meu-server"
                  className="mt-0.5 w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-[12px] text-[var(--text)] outline-none focus:border-[var(--accent)]"
                />
              </label>

              {transport === "stdio" ? (
                <>
                  <label className="block text-[10px] text-[var(--muted)]">
                    Command
                    <input
                      value={command}
                      onChange={(e) => setCommand(e.target.value)}
                      placeholder="npx"
                      className="mt-0.5 w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 font-mono text-[12px] text-[var(--text)] outline-none focus:border-[var(--accent)]"
                    />
                  </label>
                  <label className="block text-[10px] text-[var(--muted)]">
                    Args (espaço)
                    <input
                      value={argsText}
                      onChange={(e) => setArgsText(e.target.value)}
                      placeholder="-y @modelcontextprotocol/server-…"
                      className="mt-0.5 w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 font-mono text-[12px] text-[var(--text)] outline-none focus:border-[var(--accent)]"
                    />
                  </label>
                  <label className="block text-[10px] text-[var(--muted)]">
                    Env (KEY=value por linha)
                    <textarea
                      value={envText}
                      onChange={(e) => setEnvText(e.target.value)}
                      rows={2}
                      placeholder="GITHUB_TOKEN=${GITHUB_TOKEN}"
                      className="mt-0.5 w-full resize-y rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 font-mono text-[11px] text-[var(--text)] outline-none focus:border-[var(--accent)]"
                    />
                  </label>
                </>
              ) : (
                <>
                  <label className="block text-[10px] text-[var(--muted)]">
                    URL
                    <input
                      value={url}
                      onChange={(e) => setUrl(e.target.value)}
                      placeholder="http://127.0.0.1:PORT/mcp"
                      className="mt-0.5 w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 font-mono text-[12px] text-[var(--text)] outline-none focus:border-[var(--accent)]"
                    />
                  </label>
                  <label className="block text-[10px] text-[var(--muted)]">
                    Headers (Header: value por linha)
                    <textarea
                      value={headerText}
                      onChange={(e) => setHeaderText(e.target.value)}
                      rows={2}
                      placeholder={"Authorization: Bearer ${TOKEN}"}
                      className="mt-0.5 w-full resize-y rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 font-mono text-[11px] text-[var(--text)] outline-none focus:border-[var(--accent)]"
                    />
                  </label>
                </>
              )}

              <div className="flex items-center gap-2">
                <label className="flex items-center gap-1 text-[10px] text-[var(--muted)]">
                  <input
                    type="radio"
                    checked={scope === "user"}
                    onChange={() => setScope("user")}
                  />
                  user (~/.grok)
                </label>
                <label className="flex items-center gap-1 text-[10px] text-[var(--muted)]">
                  <input
                    type="radio"
                    checked={scope === "project"}
                    onChange={() => setScope("project")}
                  />
                  project (.grok/)
                </label>
              </div>

              <button
                type="button"
                disabled={adding || !name.trim()}
                onClick={() => void onAdd()}
                className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-[var(--text)] py-1.5 text-[12px] font-medium text-[var(--bg)] transition hover:opacity-90 disabled:opacity-40"
              >
                {adding ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Plus className="h-3.5 w-3.5" />
                )}
                Salvar no config
              </button>
              <p className="text-[10px] leading-snug text-[var(--muted)]">
                Usa <code className="font-mono">grok mcp add</code>. Reinicie o agent /{" "}
                <code className="font-mono">npm run web</code> se o processo já estava no ar.
              </p>
            </div>
          ) : null}

          {loading && !servers.length ? (
            <div className="flex items-center gap-2 py-6 text-[11px] text-[var(--muted)]">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Carregando…
            </div>
          ) : null}

          {servers.map((s) => {
            const d = doctor[s.name];
            const busy = busyName === s.name;
            return (
              <div
                key={s.name}
                className="rounded-xl border border-[var(--border)] bg-[var(--bg-soft)] p-2.5"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="truncate font-medium text-[13px]">{s.name}</span>
                      <span
                        className={cn(
                          "rounded-full px-1.5 py-0.5 text-[9px] font-medium uppercase",
                          s.enabled
                            ? "bg-[color-mix(in_srgb,var(--ok)_15%,transparent)] text-[var(--ok)]"
                            : "bg-[var(--bg-hover)] text-[var(--muted)]"
                        )}
                      >
                        {s.enabled ? "on" : "off"}
                      </span>
                      {d ? (
                        <span
                          className={cn(
                            "rounded-full px-1.5 py-0.5 text-[9px] font-medium",
                            d.healthy
                              ? "bg-[color-mix(in_srgb,var(--ok)_15%,transparent)] text-[var(--ok)]"
                              : "bg-[color-mix(in_srgb,#f87171_15%,transparent)] text-[#f87171]"
                          )}
                        >
                          {d.healthy ? "ok" : "fail"}
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-0.5 truncate font-mono text-[10px] text-[var(--muted)]">
                      {s.type}
                      {s.scope ? ` · ${s.scope}` : ""}
                      {s.url ? ` · ${s.url}` : ""}
                      {s.command
                        ? ` · ${s.command}${(s.args || []).length ? " " + s.args!.join(" ") : ""}`
                        : ""}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-0.5">
                    <button
                      type="button"
                      className="rounded-md p-1.5 text-[var(--muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
                      title="Testar (doctor)"
                      disabled={busy}
                      onClick={() => void onTest(s.name)}
                    >
                      {busy ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Stethoscope className="h-3.5 w-3.5" />
                      )}
                    </button>
                    <button
                      type="button"
                      className="rounded-md p-1.5 text-[var(--muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
                      title={s.enabled ? "Desabilitar" : "Habilitar"}
                      disabled={busy}
                      onClick={() => void onToggle(s)}
                    >
                      <Power
                        className={cn(
                          "h-3.5 w-3.5",
                          s.enabled ? "text-[var(--ok)]" : ""
                        )}
                      />
                    </button>
                    <button
                      type="button"
                      className="rounded-md p-1.5 text-[var(--muted)] hover:bg-[color-mix(in_srgb,#f87171_12%,transparent)] hover:text-[#f87171]"
                      title="Excluir"
                      disabled={busy}
                      onClick={() => void onRemove(s)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
                {d?.checks?.length ? (
                  <ul className="mt-2 space-y-0.5 border-t border-[var(--border)] pt-2">
                    {d.checks.map((c, i) => (
                      <li
                        key={i}
                        className="flex items-start gap-1.5 text-[10px] text-[var(--text-secondary)]"
                      >
                        {c.passed ? (
                          <Check className="mt-0.5 h-3 w-3 shrink-0 text-[var(--ok)]" />
                        ) : (
                          <X className="mt-0.5 h-3 w-3 shrink-0 text-[#f87171]" />
                        )}
                        <span>
                          {c.label}
                          {c.detail ? (
                            <span className="text-[var(--muted)]"> — {c.detail}</span>
                          ) : null}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            );
          })}

          {!loading && !servers.length ? (
            <p className="py-4 text-center text-[11px] text-[var(--muted)]">
              Nenhum MCP no config. Use <strong>Add</strong> ou presets.
            </p>
          ) : null}

          {liveMcp && liveMcp.length > 0 ? (
            <details className="rounded-xl border border-[var(--border)] bg-[var(--code-bg)] p-2">
              <summary className="cursor-pointer text-[10px] text-[var(--muted)]">
                Live do agent ({liveMcp.length})
              </summary>
              <pre className="mt-1 max-h-40 overflow-auto font-mono text-[10px] text-[var(--muted)]">
                {JSON.stringify(liveMcp, null, 2).slice(0, 4000)}
              </pre>
            </details>
          ) : null}
        </div>
      ) : (
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-0.5">
          <div className="flex items-center gap-1">
            <input
              value={skillQuery}
              onChange={(e) => setSkillQuery(e.target.value)}
              placeholder="Filtrar skills…"
              className="min-w-0 flex-1 rounded-md border border-[var(--border)] bg-[var(--bg-soft)] px-2 py-1.5 text-[12px] outline-none focus:border-[var(--accent)]"
            />
            <button
              type="button"
              className="rounded-md p-1.5 text-[var(--muted)] hover:bg-[var(--bg-hover)]"
              title="Atualizar skills"
              onClick={() => void refreshSkills()}
            >
              <RefreshCw
                className={cn("h-3.5 w-3.5", skillsLoading && "animate-spin")}
              />
            </button>
            <button
              type="button"
              className={cn(
                "inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition",
                showAddSkill
                  ? "bg-[var(--bg-hover)] text-[var(--text)]"
                  : "bg-[var(--text)] text-[var(--bg)] hover:opacity-90"
              )}
              onClick={() => setShowAddSkill((v) => !v)}
            >
              {showAddSkill ? <X className="h-3 w-3" /> : <Plus className="h-3 w-3" />}
              {showAddSkill ? "Fechar" : "Add"}
            </button>
          </div>

          <p className="px-0.5 text-[10px] leading-snug text-[var(--muted)]">
            Skills em <code className="font-mono">~/.grok/skills</code> e projeto.
            Use <code className="font-mono">/nome</code> no chat. Bundled não remove.
          </p>

          {showAddSkill ? (
            <div className="space-y-2 rounded-xl border border-[var(--border)] bg-[var(--bg-soft)] p-2.5">
              <div className="text-[11px] font-medium text-[var(--text-secondary)]">
                Nova skill
              </div>
              <label className="block text-[10px] text-[var(--muted)]">
                Nome (slash command)
                <input
                  value={skillName}
                  onChange={(e) =>
                    setSkillName(
                      e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "")
                    )
                  }
                  placeholder="minha-skill"
                  className="mt-0.5 w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 font-mono text-[12px] outline-none focus:border-[var(--accent)]"
                />
              </label>
              <label className="block text-[10px] text-[var(--muted)]">
                Description (quando invocar)
                <textarea
                  value={skillDesc}
                  onChange={(e) => setSkillDesc(e.target.value)}
                  rows={2}
                  placeholder="Use when the user wants to…"
                  className="mt-0.5 w-full resize-y rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-[12px] outline-none focus:border-[var(--accent)]"
                />
              </label>
              <label className="block text-[10px] text-[var(--muted)]">
                Corpo (markdown, opcional)
                <textarea
                  value={skillBody}
                  onChange={(e) => setSkillBody(e.target.value)}
                  rows={3}
                  placeholder="# Passos&#10;1. …"
                  className="mt-0.5 w-full resize-y rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 font-mono text-[11px] outline-none focus:border-[var(--accent)]"
                />
              </label>
              <div className="flex items-center gap-2">
                <label className="flex items-center gap-1 text-[10px] text-[var(--muted)]">
                  <input
                    type="radio"
                    checked={skillScope === "user"}
                    onChange={() => setSkillScope("user")}
                  />
                  user (~/.grok/skills)
                </label>
                <label className="flex items-center gap-1 text-[10px] text-[var(--muted)]">
                  <input
                    type="radio"
                    checked={skillScope === "project"}
                    onChange={() => setSkillScope("project")}
                  />
                  project (.grok/skills)
                </label>
              </div>
              <button
                type="button"
                disabled={
                  skillBusy || !skillName.trim() || !skillDesc.trim()
                }
                onClick={() => void onCreateSkill()}
                className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-[var(--text)] py-1.5 text-[12px] font-medium text-[var(--bg)] disabled:opacity-40"
              >
                {skillBusy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Plus className="h-3.5 w-3.5" />
                )}
                Criar skill
              </button>
            </div>
          ) : null}

          {skillsLoading && !skills.length ? (
            <div className="flex items-center gap-2 py-6 text-[11px] text-[var(--muted)]">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Escaneando skills…
            </div>
          ) : null}

          {filteredSkills.map((s) => {
            const open = expandedSkill === s.name;
            return (
              <div
                key={`${s.source}:${s.name}`}
                className="rounded-xl border border-[var(--border)] bg-[var(--bg-soft)] p-2.5"
              >
                <div className="flex items-start gap-1.5">
                  <button
                    type="button"
                    className="mt-0.5 shrink-0 text-[var(--muted)]"
                    onClick={() => setExpandedSkill(open ? null : s.name)}
                  >
                    {open ? (
                      <ChevronDown className="h-3.5 w-3.5" />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5" />
                    )}
                  </button>
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left"
                    onClick={() => setExpandedSkill(open ? null : s.name)}
                  >
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Sparkles className="h-3 w-3 text-[var(--accent)]" />
                      <span className="font-medium text-[13px]">/{s.name}</span>
                      <span className="rounded-full bg-[var(--bg-hover)] px-1.5 py-0.5 text-[9px] text-[var(--muted)]">
                        {s.source}
                      </span>
                    </div>
                    <p className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-[var(--text-secondary)]">
                      {s.shortDescription || s.description}
                    </p>
                  </button>
                  {s.removable ? (
                    <button
                      type="button"
                      className="shrink-0 rounded-md p-1.5 text-[var(--muted)] hover:bg-[color-mix(in_srgb,#f87171_12%,transparent)] hover:text-[#f87171]"
                      title="Remover skill"
                      disabled={skillBusy}
                      onClick={() => void onDeleteSkill(s)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  ) : null}
                </div>
                {open ? (
                  <div className="mt-2 space-y-1 border-t border-[var(--border)] pt-2 pl-5">
                    <p className="text-[11px] leading-relaxed text-[var(--text-secondary)]">
                      {s.description}
                    </p>
                    <p
                      className="truncate font-mono text-[10px] text-[var(--muted)]"
                      title={s.path}
                    >
                      {s.path.replace(/\/home\/[^/]+/, "~")}
                    </p>
                  </div>
                ) : null}
              </div>
            );
          })}

          {!skillsLoading && !filteredSkills.length ? (
            <p className="py-4 text-center text-[11px] text-[var(--muted)]">
              Nenhuma skill encontrada.
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}
