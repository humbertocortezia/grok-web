import fs from "fs/promises";
import path from "path";
import { grokHome, sessionsRoot } from "./paths";

export type SessionSummary = {
  id: string;
  cwd: string;
  title: string;
  createdAt: string | null;
  updatedAt: string | null;
  modelId: string | null;
  numMessages: number;
  agentName: string | null;
  groupDir: string;
  /** Process still has this session open (active_sessions.json). */
  active: boolean;
  /**
   * A model turn is currently in progress (turn_started without turn_ended).
   * Distinct from `active` — the TUI can stay open while idle between turns.
   */
  turnLive?: boolean;
};

/** UI-ready chat line (matches ChatMessage shape in the client). */
export type HistoryMessage = {
  id: string;
  /** Stable index in the full transcript (0..total-1). Used for windowed paging. */
  index: number;
  role: "user" | "assistant" | "system" | "tool";
  text: string;
  thinking?: string;
  toolCalls?: Array<{
    id: string;
    title: string;
    kind?: string;
    status?: string;
    input?: unknown;
    output?: string;
  }>;
};

export type HistoryWindow = {
  messages: HistoryMessage[];
  total: number;
  /** Inclusive start index of this window in the full transcript. */
  windowStart: number;
  /** Inclusive end index of this window. */
  windowEnd: number;
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
};

/** In-memory parse cache keyed by session dir + rev (mtime:size). */
const historyCache = new Map<string, { rev: string; messages: HistoryMessage[] }>();

async function readJsonSafe<T>(file: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function loadActiveSessionIds(): Promise<Set<string>> {
  const activePath = path.join(grokHome(), "active_sessions.json");
  const data = await readJsonSafe<
    Array<{ session_id?: string }> | { sessions?: Array<{ session_id?: string }> }
  >(activePath);
  const ids = new Set<string>();
  const list = Array.isArray(data)
    ? data
    : Array.isArray(data?.sessions)
      ? data.sessions
      : [];
  for (const row of list) {
    if (row?.session_id) ids.add(row.session_id);
  }
  return ids;
}

/**
 * True when events.jsonl shows an open turn (turn_started after last turn_ended).
 * Walks the file from the end in chunks — long reasoning streams can push
 * turn_started hundreds of KB before the tail.
 */
export async function readSessionTurnLive(dir: string): Promise<boolean> {
  const eventsPath = path.join(dir, "events.jsonl");
  try {
    const st = await fs.stat(eventsPath);
    if (st.size <= 0) return false;

    const chunkSize = 256_000;
    let pos = st.size;
    const fh = await fs.open(eventsPath, "r");
    try {
      while (pos > 0) {
        const start = Math.max(0, pos - chunkSize);
        const len = pos - start;
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, start);
        const lines = buf.toString("utf8").split("\n");
        // First line may be a partial JSON when we didn't start at byte 0
        const from = start === 0 ? 0 : 1;
        for (let i = lines.length - 1; i >= from; i--) {
          const line = lines[i];
          if (!line || !line.includes("turn_")) continue;
          try {
            const o = JSON.parse(line) as { type?: string };
            if (o.type === "turn_started") return true;
            if (o.type === "turn_ended") return false;
          } catch {
            /* skip */
          }
        }
        pos = start;
      }
    } finally {
      await fh.close();
    }
    return false;
  } catch {
    return false;
  }
}

function decodeCwd(encoded: string): string {
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

function shortTitleFromCwd(cwd: string, id: string): string {
  const base = cwd.split("/").filter(Boolean).pop() || cwd || "sessão";
  return `${base} · ${id.slice(0, 8)}`;
}

export async function listSessions(limit = 80): Promise<SessionSummary[]> {
  const root = sessionsRoot();
  let groups: string[] = [];
  try {
    groups = (await fs.readdir(root, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }

  const activeIds = await loadActiveSessionIds();

  // Collect (group, id) pairs first — cheap readdir only
  const entries: Array<{ group: string; id: string }> = [];
  await Promise.all(
    groups.map(async (group) => {
      const groupPath = path.join(root, group);
      try {
        const children = (await fs.readdir(groupPath, { withFileTypes: true }))
          .filter((d) => d.isDirectory())
          .map((d) => d.name);
        for (const id of children) entries.push({ group, id });
      } catch {
        /* skip */
      }
    })
  );

  // Parallel summary reads
  const settled = await Promise.all(
    entries.map(async ({ group, id }) => {
      const summaryPath = path.join(root, group, id, "summary.json");
      const summary = await readJsonSafe<{
        info?: { id?: string; cwd?: string };
        session_summary?: string | null;
        generated_title?: string | null;
        created_at?: string;
        updated_at?: string;
        last_active_at?: string;
        current_model_id?: string;
        num_messages?: number;
        agent_name?: string;
      }>(summaryPath);

      // Sessions without summary yet (just created) — still list from dir mtime
      if (!summary) {
        let mtime: string | null = null;
        try {
          const st = await fs.stat(path.join(root, group, id));
          mtime = st.mtime.toISOString();
        } catch {
          return null;
        }
        const cwd = decodeCwd(group);
        const sid = id;
        return {
          id: sid,
          cwd,
          title: shortTitleFromCwd(cwd, sid),
          createdAt: mtime,
          updatedAt: mtime,
          modelId: null,
          numMessages: 0,
          agentName: null,
          groupDir: group,
          active: activeIds.has(sid),
        } satisfies SessionSummary;
      }

      const sid = summary.info?.id || id;
      const cwd = summary.info?.cwd || decodeCwd(group);
      const title =
        (summary.session_summary && summary.session_summary.trim()) ||
        (summary.generated_title && String(summary.generated_title).trim()) ||
        shortTitleFromCwd(cwd, sid);

      return {
        id: sid,
        cwd,
        title,
        createdAt: summary.created_at || null,
        updatedAt: summary.last_active_at || summary.updated_at || null,
        modelId: summary.current_model_id || null,
        numMessages: summary.num_messages || 0,
        agentName: summary.agent_name || null,
        groupDir: group,
        active: activeIds.has(sid),
      } satisfies SessionSummary;
    })
  );

  const out = settled.filter(Boolean) as SessionSummary[];
  out.sort((a, b) => {
    // Active first, then by updatedAt desc
    if (a.active !== b.active) return a.active ? -1 : 1;
    return (b.updatedAt || "").localeCompare(a.updatedAt || "");
  });
  return out.slice(0, limit);
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object") {
        const p = part as Record<string, unknown>;
        if (typeof p.text === "string") return p.text;
        if (typeof p.content === "string") return p.content;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/** Prefer the real user prompt inside <user_query>; skip system injects. */
function visibleUserText(raw: string): string | null {
  if (!raw.trim()) return null;

  const queryMatch = raw.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i);
  if (queryMatch) {
    const q = queryMatch[1].trim();
    return q || null;
  }

  // Injected context — not a real user turn
  if (
    /<user_info>/.test(raw) ||
    /<system-reminder>/.test(raw) ||
    /<!--\s*ai-memory/.test(raw) ||
    raw.trimStart().startsWith("You are Grok")
  ) {
    return null;
  }

  // Bare user text (rare)
  const trimmed = raw.trim();
  if (trimmed.length > 8000) return trimmed.slice(0, 8000) + "…";
  return trimmed;
}

function reasoningSummary(entry: Record<string, unknown>): string {
  const summary = entry.summary;
  if (typeof summary === "string") return summary;
  if (Array.isArray(summary)) {
    return summary
      .map((s) => {
        if (typeof s === "string") return s;
        if (s && typeof s === "object" && typeof (s as { text?: string }).text === "string") {
          return (s as { text: string }).text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function parseToolCalls(
  raw: unknown
): HistoryMessage["toolCalls"] {
  if (!Array.isArray(raw)) return undefined;
  const out: NonNullable<HistoryMessage["toolCalls"]> = [];
  for (const tc of raw) {
    if (!tc || typeof tc !== "object") continue;
    const t = tc as Record<string, unknown>;
    const id = String(t.id || t.tool_call_id || `tool-${out.length}`);
    const name = String(t.name || t.toolName || t.title || "tool");
    let input: unknown = t.arguments ?? t.input ?? t.params;
    if (typeof input === "string") {
      try {
        input = JSON.parse(input);
      } catch {
        /* keep string */
      }
    }
    out.push({
      id,
      title: name,
      kind: name,
      status: "completed",
      input,
    });
  }
  return out.length ? out : undefined;
}

type ParseOpts = { maxToolOutput?: number };

/**
 * Parse full chat_history.jsonl into UI messages (cached per rev).
 * Assigns stable sequential `index` / `id` after merge.
 */
export async function parseFullHistory(
  dir: string,
  rev: string,
  opts: ParseOpts = {}
): Promise<HistoryMessage[]> {
  const cacheKey = dir;
  const hit = historyCache.get(cacheKey);
  if (hit && hit.rev === rev) return hit.messages;

  const maxToolOutput = opts.maxToolOutput ?? 2000;
  const historyPath = path.join(dir, "chat_history.jsonl");

  let raw: string;
  try {
    raw = await fs.readFile(historyPath, "utf8");
  } catch {
    historyCache.set(cacheKey, { rev, messages: [] });
    return [];
  }

  const lines = raw.split("\n");
  const built: Array<Omit<HistoryMessage, "index" | "id"> & { id?: string }> = [];
  let pendingThinking = "";

  for (const line of lines) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    const type = String(entry.type || "");

    if (type === "system") continue;

    if (type === "reasoning") {
      const text = reasoningSummary(entry);
      if (text) pendingThinking = pendingThinking ? `${pendingThinking}\n${text}` : text;
      continue;
    }

    if (type === "user") {
      const visible = visibleUserText(extractTextContent(entry.content));
      if (!visible) continue;
      built.push({ role: "user", text: visible });
      pendingThinking = "";
      continue;
    }

    if (type === "assistant") {
      const text = extractTextContent(entry.content).trim();
      const toolCalls = parseToolCalls(entry.tool_calls || entry.toolCalls);
      if (!text && !toolCalls?.length && !pendingThinking) continue;
      built.push({
        role: "assistant",
        text,
        thinking: pendingThinking || undefined,
        toolCalls,
      });
      pendingThinking = "";
      continue;
    }

    if (type === "tool_result" || type === "tool") {
      const toolCallId = String(
        entry.tool_call_id || entry.toolCallId || entry.id || ""
      );
      let output = extractTextContent(entry.content);
      if (output.length > maxToolOutput) {
        output = output.slice(0, maxToolOutput) + "\n…";
      }
      for (let i = built.length - 1; i >= 0; i--) {
        const m = built[i];
        if (m.role !== "assistant" || !m.toolCalls?.length) continue;
        const tc = toolCallId
          ? m.toolCalls.find((t) => t.id === toolCallId)
          : m.toolCalls.find((t) => !t.output);
        if (tc) {
          tc.output = output;
          tc.status = "completed";
          break;
        }
        if (!toolCallId) break;
      }
      continue;
    }
  }

  const merged = mergeConsecutiveAssistants(built);
  // Stable indices after merge — used for windowed paging
  const messages: HistoryMessage[] = merged.map((m, index) => ({
    ...m,
    index,
    id: `hist-${index}`,
    toolCalls: m.toolCalls ? [...m.toolCalls] : undefined,
  }));

  // Bound cache size
  if (historyCache.size > 40) {
    const first = historyCache.keys().next().value;
    if (first) historyCache.delete(first);
  }
  historyCache.set(cacheKey, { rev, messages });
  return messages;
}

/**
 * Windowed history: default = last `limit` messages (tail).
 * `before` = load older page ending just before this index.
 * `after`  = load newer page starting just after this index (live tail merge).
 */
export async function loadHistoryWindow(
  dir: string,
  rev: string,
  opts: {
    limit?: number;
    before?: number | null;
    after?: number | null;
    maxToolOutput?: number;
  } = {}
): Promise<HistoryWindow> {
  const limit = Math.min(Math.max(opts.limit ?? 24, 1), 80);
  const all = await parseFullHistory(dir, rev, {
    maxToolOutput: opts.maxToolOutput,
  });
  const total = all.length;
  if (total === 0) {
    return {
      messages: [],
      total: 0,
      windowStart: 0,
      windowEnd: -1,
      hasMoreBefore: false,
      hasMoreAfter: false,
    };
  }

  let start: number;
  let end: number; // exclusive

  if (opts.before != null && Number.isFinite(opts.before)) {
    // Older page: [before-limit, before)
    end = Math.max(0, Math.min(total, Math.floor(opts.before)));
    start = Math.max(0, end - limit);
  } else if (opts.after != null && Number.isFinite(opts.after)) {
    // Newer page: (after, after+limit]
    start = Math.min(total, Math.max(0, Math.floor(opts.after) + 1));
    end = Math.min(total, start + limit);
  } else {
    // Default: tail window
    end = total;
    start = Math.max(0, total - limit);
  }

  const slice = all.slice(start, end);
  return {
    messages: slice,
    total,
    windowStart: slice.length ? slice[0].index : start,
    windowEnd: slice.length ? slice[slice.length - 1].index : end - 1,
    hasMoreBefore: start > 0,
    hasMoreAfter: end < total,
  };
}

/** @deprecated prefer loadHistoryWindow — kept for simple callers */
export async function loadHistoryMessages(
  dir: string,
  opts: { limit?: number; maxToolOutput?: number } = {}
): Promise<HistoryMessage[]> {
  const revInfo = await getSessionHistoryRevFromDir(dir);
  const win = await loadHistoryWindow(dir, revInfo.rev, {
    limit: opts.limit ?? 24,
    maxToolOutput: opts.maxToolOutput,
  });
  return win.messages;
}

async function getSessionHistoryRevFromDir(
  dir: string
): Promise<{ rev: string }> {
  const historyPath = path.join(dir, "chat_history.jsonl");
  try {
    const st = await fs.stat(historyPath);
    return { rev: `${st.mtimeMs}:${st.size}` };
  } catch {
    return { rev: "0:0" };
  }
}

function mergeConsecutiveAssistants(
  messages: Array<Omit<HistoryMessage, "index" | "id"> & { id?: string }>
): Array<Omit<HistoryMessage, "index" | "id">> {
  const out: Array<Omit<HistoryMessage, "index" | "id">> = [];
  for (const m of messages) {
    const prev = out[out.length - 1];
    if (m.role === "assistant" && prev?.role === "assistant") {
      const textParts = [prev.text, m.text].filter((t) => t && t.trim());
      prev.text = textParts.join("\n\n");
      if (m.thinking) {
        prev.thinking = prev.thinking
          ? `${prev.thinking}\n${m.thinking}`
          : m.thinking;
      }
      if (m.toolCalls?.length) {
        prev.toolCalls = [...(prev.toolCalls || []), ...m.toolCalls];
      }
      continue;
    }
    out.push({
      role: m.role,
      text: m.text,
      thinking: m.thinking,
      toolCalls: m.toolCalls ? [...m.toolCalls] : undefined,
    });
  }
  return out;
}

export async function findSessionDir(id: string): Promise<{
  dir: string;
  meta: SessionSummary;
} | null> {
  const root = sessionsRoot();
  let groups: string[] = [];
  try {
    groups = (await fs.readdir(root, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return null;
  }

  // Parallel existence check across cwd groups (session id is unique)
  const hits = await Promise.all(
    groups.map(async (group) => {
      const dir = path.join(root, group, id);
      try {
        const st = await fs.stat(dir);
        if (!st.isDirectory()) return null;
      } catch {
        return null;
      }
      return { group, dir };
    })
  );
  const hit = hits.find(Boolean);
  if (!hit) return null;

  const { group, dir } = hit;
  const activeIds = await loadActiveSessionIds();
  const summary = await readJsonSafe<{
    info?: { id?: string; cwd?: string };
    session_summary?: string | null;
    generated_title?: string | null;
    created_at?: string;
    updated_at?: string;
    last_active_at?: string;
    current_model_id?: string;
    num_messages?: number;
    agent_name?: string;
  }>(path.join(dir, "summary.json"));

  const sid = summary?.info?.id || id;
  const cwd = summary?.info?.cwd || decodeCwd(group);
  const title =
    (summary?.session_summary && summary.session_summary.trim()) ||
    (summary?.generated_title && String(summary.generated_title).trim()) ||
    shortTitleFromCwd(cwd, sid);

  return {
    dir,
    meta: {
      id: sid,
      cwd,
      title,
      createdAt: summary?.created_at || null,
      updatedAt: summary?.last_active_at || summary?.updated_at || null,
      modelId: summary?.current_model_id || null,
      numMessages: summary?.num_messages || 0,
      agentName: summary?.agent_name || null,
      groupDir: group,
      active: activeIds.has(sid),
    },
  };
}

/** Cheap revision of chat_history.jsonl (mtime+size). Used for live polling. */
export async function getSessionHistoryRev(
  id: string
): Promise<{ rev: string; dir: string; meta: SessionSummary } | null> {
  const found = await findSessionDir(id);
  if (!found) return null;
  const historyPath = path.join(found.dir, "chat_history.jsonl");
  try {
    const st = await fs.stat(historyPath);
    return {
      rev: `${st.mtimeMs}:${st.size}`,
      dir: found.dir,
      meta: found.meta,
    };
  } catch {
    return { rev: "0:0", dir: found.dir, meta: found.meta };
  }
}

export async function getSessionDetail(
  id: string,
  opts: {
    ifRev?: string | null;
    limit?: number;
    before?: number | null;
    after?: number | null;
    /** Skip signals/plan for lighter window polls */
    light?: boolean;
  } = {}
) {
  const revInfo = await getSessionHistoryRev(id);
  if (!revInfo) return null;

  const { dir, meta } = revInfo;
  const [activeIds, turnLive] = await Promise.all([
    loadActiveSessionIds(),
    readSessionTurnLive(dir),
  ]);
  meta.active = activeIds.has(meta.id);
  meta.turnLive = turnLive;

  // Unchanged only for pure tail polls without before/after (client has same rev).
  // Still refresh active/turnLive — a turn can end without chat_history moving yet,
  // and the session can stay "open" in active_sessions while idle between turns.
  if (
    opts.ifRev &&
    opts.ifRev === revInfo.rev &&
    opts.before == null &&
    opts.after == null
  ) {
    return {
      unchanged: true as const,
      rev: revInfo.rev,
      meta,
      dir,
    };
  }

  const window = await loadHistoryWindow(dir, revInfo.rev, {
    limit: opts.limit ?? 24,
    before: opts.before,
    after: opts.after,
    maxToolOutput: 1500,
  });

  if (opts.light) {
    return {
      unchanged: false as const,
      rev: revInfo.rev,
      meta,
      dir,
      messages: window.messages,
      total: window.total,
      windowStart: window.windowStart,
      windowEnd: window.windowEnd,
      hasMoreBefore: window.hasMoreBefore,
      hasMoreAfter: window.hasMoreAfter,
    };
  }

  const signalsPath = path.join(dir, "signals.json");
  const planPath = path.join(dir, "plan.json");
  const [signals, plan] = await Promise.all([
    readJsonSafe<Record<string, unknown>>(signalsPath),
    readJsonSafe<Record<string, unknown>>(planPath),
  ]);

  return {
    unchanged: false as const,
    rev: revInfo.rev,
    meta,
    signals,
    plan,
    messages: window.messages,
    total: window.total,
    windowStart: window.windowStart,
    windowEnd: window.windowEnd,
    hasMoreBefore: window.hasMoreBefore,
    hasMoreAfter: window.hasMoreAfter,
    dir,
  };
}
