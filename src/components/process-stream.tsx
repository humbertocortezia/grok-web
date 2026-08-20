
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  FileText,
  Globe,
  LayoutGrid,
  Lightbulb,
  Pencil,
  Search,
  Terminal,
  Wrench,
} from "lucide-react";
import type { ToolCallView } from "@/lib/acp-client";
import { cn } from "@/lib/cn";
import { GrokMark } from "@/components/grok-logo";

function isRunning(status?: string) {
  const s = (status || "").toLowerCase();
  return !s || s === "running" || s === "pending" || s === "in_progress";
}

function toolPath(tool: ToolCallView): string {
  const input = tool.input;
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    for (const key of [
      "path",
      "target_file",
      "file",
      "command",
      "query",
      "url",
      "pattern",
    ]) {
      if (o[key] != null) return String(o[key]);
    }
  }
  if (typeof input === "string") return input.slice(0, 80);
  return "";
}

export type ActivityIcon =
  | "search"
  | "globe"
  | "bulb"
  | "term"
  | "file"
  | "write"
  | "tool"
  | "active";

function classifyTool(tool: ToolCallView): ActivityIcon {
  const kind = `${tool.kind || ""} ${tool.title || ""}`.toLowerCase();
  if (/web_search|web_fetch|open_page|browse|http|url:|naveg|fetch/.test(kind)) {
    if (/search|pesquis|grep|query/.test(kind) && !/fetch|open|browse|url|naveg/.test(kind)) {
      return "search";
    }
    if (/fetch|open|browse|url|naveg|page/.test(kind)) return "globe";
  }
  if (/search|grep|query|pesquis|find|list_dir|glob/.test(kind)) return "search";
  if (/fetch|open_page|browse|http|web_|url/.test(kind)) return "globe";
  if (/terminal|shell|bash|command|run_terminal/.test(kind)) return "term";
  if (/write|edit|search_replace|create|patch/.test(kind)) return "write";
  if (/read|file|fs|cat/.test(kind)) return "file";
  if (/plan|think|architect|design|defin/.test(kind)) return "bulb";
  return "tool";
}

function shortPath(path: string): string {
  return path
    .replace(/^\/home\/[^/]+/, "~")
    .replace(/^https?:\/\//, "")
    .slice(0, 72);
}

function activityLabel(tool: ToolCallView, running: boolean): string {
  const icon = classifyTool(tool);
  const path = toolPath(tool);
  const detail = path ? shortPath(path) : "";
  const title = (tool.title || "").trim();

  if (icon === "search") {
    if (running) return detail ? `Pesquisando ${detail}` : "Pesquisando…";
    return detail ? `Executou pesquisa · ${detail}` : title || "Executou pesquisa";
  }
  if (icon === "globe") {
    if (running) return detail ? `Navegando ${detail}` : "Navegando…";
    return detail ? `Navegado ${detail}` : title || "Navegou página";
  }
  if (icon === "term") {
    if (running) return detail ? `Executando ${detail}` : "Executando comando…";
    return detail ? `Executou ${detail}` : title || "Comando executado";
  }
  if (icon === "write") {
    if (running) return detail ? `Editando ${detail}` : title || "Editando…";
    return detail ? `Editou ${detail}` : title || "Arquivo editado";
  }
  if (icon === "file") {
    if (running) return detail ? `Lendo ${detail}` : title || "Lendo…";
    return detail ? `Leu ${detail}` : title || "Arquivo lido";
  }
  if (icon === "bulb") {
    return title || (running ? "Planejando…" : "Planejou");
  }

  // Prefer agent-provided title when present
  if (title) {
    if (detail && !title.includes(detail.slice(0, 24))) {
      return `${title}${detail ? ` · ${detail}` : ""}`;
    }
    return title;
  }
  return running ? "Trabalhando…" : "Ferramenta";
}

/**
 * ScrollText Fade — partial text rising with soft edges + light sweep.
 * Used by Thinking (the look you liked).
 */
export function ScrollTextFade({
  text,
  active = true,
  className,
  maxHeight = 112,
  mono = false,
}: {
  text: string;
  active?: boolean;
  className?: string;
  maxHeight?: number;
  mono?: boolean;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const lines = useMemo(() => {
    const all = text
      .split(/\n+/)
      .map((l) => l.trim())
      .filter(Boolean);
    return all.length > 24 ? all.slice(-24) : all;
  }, [text]);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTo({
      top: el.scrollHeight,
      behavior: active ? "smooth" : "auto",
    });
  }, [text, active, lines.length]);

  return (
    <div
      className={cn("scrolltext-fade", active && "is-active", className)}
      style={{ maxHeight }}
    >
      <div className="scrolltext-fade-mask" />
      <div ref={scrollerRef} className="scrolltext-fade-scroll">
        <div
          className={cn(
            "scrolltext-fade-body",
            mono && "is-mono",
            active && "is-light-sweep"
          )}
        >
          {lines.length === 0 ? (
            <p className="scrolltext-line is-ghost">…</p>
          ) : (
            lines.map((line, i) => (
              <p
                key={`${i}-${line.slice(0, 24)}`}
                className="scrolltext-line"
                style={{ animationDelay: `${Math.min(i, 8) * 40}ms` }}
              >
                {line}
              </p>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Thinking — single label "Thinking". No extra "pensando…".
 * Streams thought text underneath when available; collapses to chip when done.
 */
export function ThinkingStream({
  text,
  active,
}: {
  text?: string;
  /** true while reasoning is the current phase */
  active?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const hasText = Boolean(text?.trim());

  if (!hasText && !active) return null;

  // Live: only "Thinking" (+ stream if text exists). Never a second idle label.
  if (active) {
    return (
      <div className="thinking-inline fade-rise mb-2.5">
        <div className="thinking-inline-head">
          <GrokMark size={12} state="thinking" />
          <span className="thinking-inline-label">Thinking</span>
        </div>
        {hasText ? (
          <ScrollTextFade
            text={text!}
            active
            mono={false}
            maxHeight={96}
            className="thinking-inline-fade"
          />
        ) : null}
      </div>
    );
  }

  // Done — tiny chip only (optional expand)
  if (!hasText) return null;
  const preview = text!.replace(/\s+/g, " ").trim();

  return (
    <div className="mb-2 fade-rise">
      <button
        type="button"
        className="tool-chip"
        onClick={() => setOpen((v) => !v)}
      >
        <GrokMark size={14} state="done" />
        <span className="font-medium text-[var(--text-secondary)]">Thought</span>
        <span className="min-w-0 flex-1 truncate text-[var(--muted)]">
          {preview.slice(0, 48)}
          {preview.length > 48 ? "…" : ""}
        </span>
        {open ? (
          <ChevronDown className="h-3 w-3 text-[var(--muted)]" />
        ) : (
          <ChevronRight className="h-3 w-3 text-[var(--muted)]" />
        )}
      </button>
      {open ? (
        <div className="thinking-inline-expand mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap px-0.5 py-1 text-[12px] leading-relaxed text-[var(--muted)]">
          {text}
        </div>
      ) : null}
    </div>
  );
}

export type ProcessStamp = {
  id: string;
  code: string;
  title: string;
  detail?: string;
  status: "active" | "done";
  icon: ActivityIcon;
  label: string;
};

function iconForCode(code: string): ActivityIcon {
  switch (code) {
    case "SEARCH":
      return "search";
    case "NAV":
      return "globe";
    case "TERM":
      return "term";
    case "WRITE":
      return "write";
    case "READ":
      return "file";
    case "PLAN":
      return "bulb";
    default:
      return "tool";
  }
}

function toolCode(tool: ToolCallView): string {
  const icon = classifyTool(tool);
  switch (icon) {
    case "search":
      return "SEARCH";
    case "globe":
      return "NAV";
    case "term":
      return "TERM";
    case "write":
      return "WRITE";
    case "file":
      return "READ";
    case "bulb":
      return "PLAN";
    default:
      return "TOOL";
  }
}

/** Build activity items for tools. */
export function buildToolStamps(tools: ToolCallView[] | undefined): ProcessStamp[] {
  if (!tools?.length) return [];
  return tools.map((t) => {
    const running = isRunning(t.status);
    const path = toolPath(t);
    const icon = classifyTool(t);
    return {
      id: t.id,
      code: toolCode(t),
      title: t.title,
      detail: path ? shortPath(path) : undefined,
      status: running ? "active" : "done",
      icon: running && icon === "tool" ? "active" : icon,
      label: activityLabel(t, running),
    };
  });
}

function ActivityIconNode({
  icon,
  active,
}: {
  icon: ActivityIcon;
  active?: boolean;
}) {
  const cls = cn(
    "activity-icon-svg",
    active ? "text-[var(--text-secondary)]" : "text-[var(--muted)]"
  );
  const sw = 1.75;
  const size = 14;

  switch (icon) {
    case "search":
      return <Search className={cls} size={size} strokeWidth={sw} />;
    case "globe":
      return <Globe className={cls} size={size} strokeWidth={sw} />;
    case "bulb":
      return <Lightbulb className={cls} size={size} strokeWidth={sw} />;
    case "term":
      return <Terminal className={cls} size={size} strokeWidth={sw} />;
    case "file":
      return <FileText className={cls} size={size} strokeWidth={sw} />;
    case "write":
      return <Pencil className={cls} size={size} strokeWidth={sw} />;
    case "active":
      return <span className="activity-hollow-dot" aria-hidden />;
    default:
      return <Wrench className={cls} size={size} strokeWidth={sw} />;
  }
}

function useElapsedSeconds(running: boolean) {
  const [sec, setSec] = useState(0);
  const started = useRef<number | null>(null);

  useEffect(() => {
    if (!running) {
      started.current = null;
      setSec(0);
      return;
    }
    if (started.current == null) started.current = Date.now();
    const tick = () => {
      if (started.current == null) return;
      setSec(Math.max(0, Math.floor((Date.now() - started.current) / 1000)));
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [running]);

  return sec;
}

/**
 * Tool process — Grok-style activity timeline.
 * Same component for live + done: when `live` flips false, collapses in-place
 * to a chip (no unmount/swap → no flicker at end of turn).
 */
export function ProcessStampStack({
  stamps,
  live,
}: {
  stamps: ProcessStamp[];
  live: boolean;
}) {
  const elapsed = useElapsedSeconds(live);
  // Expanded while the turn is live; auto-collapse when the turn ends.
  const [expanded, setExpanded] = useState(live);
  const wasLiveRef = useRef(live);

  useEffect(() => {
    if (live) {
      setExpanded(true);
      wasLiveRef.current = true;
      return;
    }
    // Turn just finished — collapse after a short beat so the final
    // answer can paint without fighting a height collapse (less flicker).
    if (wasLiveRef.current) {
      const t = window.setTimeout(() => setExpanded(false), 220);
      wasLiveRef.current = false;
      return () => window.clearTimeout(t);
    }
    wasLiveRef.current = false;
  }, [live]);

  if (!stamps.length) return null;

  const maxVisible = 12;
  const visible =
    stamps.length > maxVisible ? stamps.slice(-maxVisible) : stamps;
  const hiddenCount = stamps.length - visible.length;

  // Collapsed chip (done state, or user closed while reviewing)
  if (!expanded) {
    return (
      <div className="mb-2 activity-collapse-host">
        <button
          type="button"
          className="stamp-collapsed-btn"
          onClick={() => setExpanded(true)}
        >
          <Check className="h-3 w-3 text-[var(--ok)]" strokeWidth={3} />
          <span>
            {stamps.length} ferramenta{stamps.length > 1 ? "s" : ""}
          </span>
          <span className="text-[var(--muted)]">· processo</span>
          <ChevronRight className="h-3 w-3 text-[var(--muted)]" />
        </button>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "activity-stream",
        live && "activity-stream--live",
        !live && "activity-stream--collapsed"
      )}
      aria-live={live ? "polite" : undefined}
    >
      {!live ? (
        <div className="mb-1.5">
          <button
            type="button"
            className="stamp-collapsed-btn"
            onClick={() => setExpanded(false)}
          >
            <Check className="h-3 w-3 text-[var(--ok)]" strokeWidth={3} />
            <span>
              {stamps.length} ferramenta{stamps.length > 1 ? "s" : ""}
            </span>
            <span className="text-[var(--muted)]">· processo</span>
            <ChevronDown className="h-3 w-3 text-[var(--muted)]" />
          </button>
        </div>
      ) : null}

      {hiddenCount > 0 ? (
        <div className="activity-more">+{hiddenCount} anteriores</div>
      ) : null}

      <ul className="activity-list">
        {visible.map((s, i) => {
          const isLast = i === visible.length - 1 && !live;
          const isActive = live && s.status === "active";
          return (
            <li
              key={s.id}
              className={cn(
                "activity-item",
                isActive && "is-active",
                s.status === "done" && "is-done"
              )}
            >
              <div className="activity-rail">
                <div className={cn("activity-icon", isActive && "is-active")}>
                  {isActive ? (
                    <ActivityIconNode
                      icon={s.icon === "tool" ? "active" : s.icon}
                      active
                    />
                  ) : (
                    <ActivityIconNode
                      icon={s.icon === "active" ? iconForCode(s.code) : s.icon}
                    />
                  )}
                </div>
                {!isLast ? <div className="activity-connector" aria-hidden /> : null}
              </div>
              <div className="activity-copy">
                <span
                  className={cn(
                    "activity-label",
                    isActive && "light-sweep-text"
                  )}
                >
                  {s.label}
                </span>
              </div>
            </li>
          );
        })}

        {live ? (
          <li className="activity-item is-working">
            <div className="activity-rail">
              <div className="activity-icon is-working">
                <LayoutGrid
                  className="activity-icon-svg text-[var(--muted)]"
                  size={14}
                  strokeWidth={1.75}
                />
              </div>
            </div>
            <div className="activity-copy">
              <span className="activity-label activity-working-label light-sweep-text">
                Trabalhando por {elapsed}s
              </span>
            </div>
          </li>
        ) : null}
      </ul>
    </div>
  );
}

/** @deprecated — collapse is handled inside ProcessStampStack */
export function ProcessItineraryCollapsed({
  stamps,
}: {
  stamps: ProcessStamp[];
}) {
  return <ProcessStampStack stamps={stamps} live={false} />;
}

/** @deprecated */
export function ToolActivityList(): ReactNode {
  return null;
}
