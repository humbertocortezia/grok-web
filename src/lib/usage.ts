import fs from "fs/promises";
import path from "path";
import { createReadStream } from "fs";
import { createInterface } from "readline";
import { grokHome, sessionsRoot } from "./paths";
import { findSessionDir } from "./sessions";

/** Grok stores cost as integer ticks; divide by 1e9 for USD. */
export const COST_USD_TICKS_PER_DOLLAR = 1_000_000_000;

export type ModelUsageRow = {
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedReadTokens: number;
  reasoningTokens: number;
  modelCalls: number;
  apiDurationMs: number;
  costUsd: number;
};

export type SessionUsage = {
  sessionId: string;
  cwd: string | null;
  title: string | null;
  modelId: string | null;
  modelsUsed: string[];
  /** 0–100 from Grok signals (context window fill) */
  contextUsagePct: number;
  contextTokensUsed: number;
  contextWindowTokens: number;
  contextTokensRemaining: number;
  turnCount: number;
  toolCallCount: number;
  toolFailureCount: number;
  userMessageCount: number;
  assistantMessageCount: number;
  toolsUsed: string[];
  /** Aggregated from session/update turn_completed.usage */
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedReadTokens: number;
  totalTokens: number;
  modelCalls: number;
  /** Estimated session cost in USD (from costUsdTicks) */
  costUsd: number;
  costUsdTicks: number;
  /** Per-model breakdown when available */
  modelUsage: ModelUsageRow[];
  /** Latency / activity from signals */
  avgResponseTimeMs: number | null;
  avgTimeToFirstTokenMs: number | null;
  sessionDurationSeconds: number | null;
  agentLinesAdded: number;
  agentLinesRemoved: number;
  totalFilesTouched: number;
  compactionCount: number;
  errorCount: number;
  /** ISO last_active when known */
  updatedAt: string | null;
  source: "signals" | "signals+turns";
};

export type UsageSnapshot = {
  /** Best session to show (active or requested) */
  primary: SessionUsage | null;
  /** Other recent sessions with usage */
  recent: SessionUsage[];
  /** Account hints from auth (no secrets) */
  account: {
    email: string | null;
    firstName: string | null;
    teamId: string | null;
  } | null;
  note: string;
  billingUrl: string;
};

async function readJsonSafe<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

async function loadActiveSessionId(): Promise<string | null> {
  const data = await readJsonSafe<
    Array<{ session_id?: string }> | { sessions?: Array<{ session_id?: string }> }
  >(path.join(grokHome(), "active_sessions.json"));
  const list = Array.isArray(data)
    ? data
    : Array.isArray(data?.sessions)
      ? data.sessions
      : [];
  return list[0]?.session_id || null;
}

async function loadAccountHints() {
  const auth = await readJsonSafe<Record<string, Record<string, unknown>>>(
    path.join(grokHome(), "auth.json")
  );
  if (!auth || typeof auth !== "object") return null;
  const first = Object.values(auth)[0];
  if (!first || typeof first !== "object") return null;
  return {
    email: typeof first.email === "string" ? first.email : null,
    firstName: typeof first.first_name === "string" ? first.first_name : null,
    teamId: typeof first.team_id === "string" ? first.team_id : null,
  };
}

function num(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function ticksToUsd(ticks: number): number {
  return ticks / COST_USD_TICKS_PER_DOLLAR;
}

type TurnAgg = {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedReadTokens: number;
  totalTokens: number;
  modelCalls: number;
  costUsdTicks: number;
  turnEvents: number;
  byModel: Map<
    string,
    {
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      cachedReadTokens: number;
      reasoningTokens: number;
      modelCalls: number;
      apiDurationMs: number;
      costUsdTicks: number;
    }
  >;
};

function emptyAgg(): TurnAgg {
  return {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedReadTokens: 0,
    totalTokens: 0,
    modelCalls: 0,
    costUsdTicks: 0,
    turnEvents: 0,
    byModel: new Map(),
  };
}

function addUsageBlob(agg: TurnAgg, usage: Record<string, unknown>) {
  agg.turnEvents += 1;
  agg.inputTokens += num(usage.inputTokens ?? usage.input_tokens);
  agg.outputTokens += num(usage.outputTokens ?? usage.output_tokens);
  agg.reasoningTokens += num(usage.reasoningTokens ?? usage.reasoning_tokens);
  agg.cachedReadTokens += num(
    usage.cachedReadTokens ?? usage.cacheReadInputTokens ?? usage.cached_read_tokens
  );
  agg.totalTokens += num(usage.totalTokens ?? usage.total_tokens);
  agg.modelCalls += num(usage.modelCalls ?? usage.model_calls);
  agg.costUsdTicks += num(usage.costUsdTicks ?? usage.cost_usd_ticks);

  const mu = usage.modelUsage ?? usage.model_usage;
  if (mu && typeof mu === "object") {
    for (const [modelId, raw] of Object.entries(mu as Record<string, unknown>)) {
      if (!raw || typeof raw !== "object") continue;
      const row = raw as Record<string, unknown>;
      const cur = agg.byModel.get(modelId) || {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        cachedReadTokens: 0,
        reasoningTokens: 0,
        modelCalls: 0,
        apiDurationMs: 0,
        costUsdTicks: 0,
      };
      cur.inputTokens += num(row.inputTokens ?? row.input_tokens);
      cur.outputTokens += num(row.outputTokens ?? row.output_tokens);
      cur.totalTokens += num(row.totalTokens ?? row.total_tokens);
      cur.cachedReadTokens += num(
        row.cachedReadTokens ?? row.cacheReadInputTokens
      );
      cur.reasoningTokens += num(row.reasoningTokens ?? row.reasoning_tokens);
      cur.modelCalls += num(row.modelCalls ?? row.model_calls);
      cur.apiDurationMs += num(row.apiDurationMs ?? row.api_duration_ms);
      cur.costUsdTicks += num(row.costUsdTicks ?? row.cost_usd_ticks);
      agg.byModel.set(modelId, cur);
    }
  }
}

/**
 * Stream updates.jsonl and sum usage from turn_completed events.
 * Only lines containing "turn_completed" are JSON-parsed (efficient).
 */
async function aggregateTurnUsage(dir: string): Promise<TurnAgg> {
  const file = path.join(dir, "updates.jsonl");
  const agg = emptyAgg();
  try {
    await fs.access(file);
  } catch {
    return agg;
  }

  const rl = createInterface({
    input: createReadStream(file, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.includes("turn_completed")) continue;
    try {
      const o = JSON.parse(line) as {
        params?: { update?: Record<string, unknown> };
        update?: Record<string, unknown>;
      };
      const update = o.params?.update || o.update;
      if (!update || update.sessionUpdate !== "turn_completed") continue;
      const usage = update.usage;
      if (usage && typeof usage === "object") {
        addUsageBlob(agg, usage as Record<string, unknown>);
      }
    } catch {
      /* skip bad line */
    }
  }

  return agg;
}

function parseSignals(
  sessionId: string,
  meta: {
    cwd?: string | null;
    title?: string | null;
    modelId?: string | null;
    updatedAt?: string | null;
  },
  signals: Record<string, unknown> | null,
  turns: TurnAgg
): SessionUsage | null {
  if (!signals && turns.turnEvents === 0) return null;
  const s = signals || {};

  const used = num(s.contextTokensUsed);
  const window =
    num(s.contextWindowTokens) || num(s.context_window_tokens) || 0;
  let pct = Number(s.contextWindowUsage ?? s.context_usage_pct ?? NaN);
  if (!Number.isFinite(pct) && window > 0) {
    pct = Math.round((used / window) * 100);
  }
  if (!Number.isFinite(pct)) pct = 0;
  pct = Math.max(0, Math.min(100, pct));

  const remaining = window > 0 ? Math.max(0, window - used) : 0;

  const modelsUsed = Array.isArray(s.modelsUsed)
    ? (s.modelsUsed as unknown[]).map(String)
    : turns.byModel.size
      ? Array.from(turns.byModel.keys())
      : [];

  const toolsUsed = Array.isArray(s.toolsUsed)
    ? (s.toolsUsed as unknown[]).map(String)
    : [];

  const modelUsage: ModelUsageRow[] = Array.from(turns.byModel.entries())
    .map(([modelId, row]) => ({
      modelId,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      totalTokens: row.totalTokens,
      cachedReadTokens: row.cachedReadTokens,
      reasoningTokens: row.reasoningTokens,
      modelCalls: row.modelCalls,
      apiDurationMs: row.apiDurationMs,
      costUsd: ticksToUsd(row.costUsdTicks),
    }))
    .sort((a, b) => b.costUsd - a.costUsd);

  return {
    sessionId,
    cwd: meta.cwd ?? null,
    title: meta.title ?? null,
    modelId:
      meta.modelId ??
      (typeof s.primaryModelId === "string" ? s.primaryModelId : null) ??
      modelsUsed[0] ??
      null,
    modelsUsed,
    contextUsagePct: pct,
    contextTokensUsed: used,
    contextWindowTokens: window,
    contextTokensRemaining: remaining,
    turnCount: num(s.turnCount) || turns.turnEvents,
    toolCallCount: num(s.toolCallCount),
    toolFailureCount: num(s.toolFailureCount),
    userMessageCount: num(s.userMessageCount),
    assistantMessageCount: num(s.assistantMessageCount),
    toolsUsed,
    inputTokens: turns.inputTokens,
    outputTokens: turns.outputTokens,
    reasoningTokens: turns.reasoningTokens,
    cachedReadTokens: turns.cachedReadTokens,
    totalTokens: turns.totalTokens,
    modelCalls: turns.modelCalls,
    costUsd: ticksToUsd(turns.costUsdTicks),
    costUsdTicks: turns.costUsdTicks,
    modelUsage,
    avgResponseTimeMs:
      s.avgResponseTimeMs != null ? num(s.avgResponseTimeMs) : null,
    avgTimeToFirstTokenMs:
      s.avgTimeToFirstTokenMs != null ? num(s.avgTimeToFirstTokenMs) : null,
    sessionDurationSeconds:
      s.sessionDurationSeconds != null ? num(s.sessionDurationSeconds) : null,
    agentLinesAdded: num(s.agentLinesAdded),
    agentLinesRemoved: num(s.agentLinesRemoved),
    totalFilesTouched: num(s.totalFilesTouched ?? s.agentFilesTouched),
    compactionCount: num(s.compactionCount),
    errorCount: num(s.errorCount),
    updatedAt: meta.updatedAt ?? null,
    source: turns.turnEvents > 0 ? "signals+turns" : "signals",
  };
}

export async function getSessionUsage(
  sessionId: string
): Promise<SessionUsage | null> {
  const found = await findSessionDir(sessionId);
  if (!found) return null;
  const [signals, turns] = await Promise.all([
    readJsonSafe<Record<string, unknown>>(
      path.join(found.dir, "signals.json")
    ),
    aggregateTurnUsage(found.dir),
  ]);
  return parseSignals(
    sessionId,
    {
      cwd: found.meta.cwd,
      title: found.meta.title,
      modelId: found.meta.modelId,
      updatedAt: found.meta.updatedAt,
    },
    signals,
    turns
  );
}

/** Scan recent sessions for usage (by summary mtime via list). */
export async function getUsageSnapshot(opts?: {
  sessionId?: string | null;
  recentLimit?: number;
  /** Skip heavy updates.jsonl scan for recent list (only primary full). */
  lightRecent?: boolean;
}): Promise<UsageSnapshot> {
  const account = await loadAccountHints();
  const activeId = opts?.sessionId || (await loadActiveSessionId());

  let primary: SessionUsage | null = null;
  if (activeId) {
    primary = await getSessionUsage(activeId);
  }

  const recent: SessionUsage[] = [];
  const root = sessionsRoot();
  try {
    const groups = (await fs.readdir(root, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    const candidates: Array<{ id: string; group: string; mtime: number }> = [];
    await Promise.all(
      groups.map(async (group) => {
        const gp = path.join(root, group);
        try {
          const kids = (await fs.readdir(gp, { withFileTypes: true }))
            .filter((d) => d.isDirectory())
            .map((d) => d.name);
          for (const id of kids) {
            try {
              const st = await fs.stat(path.join(gp, id, "signals.json"));
              candidates.push({ id, group, mtime: st.mtimeMs });
            } catch {
              /* no signals */
            }
          }
        } catch {
          /* skip */
        }
      })
    );

    candidates.sort((a, b) => b.mtime - a.mtime);
    const limit = opts?.recentLimit ?? 5;
    for (const c of candidates.slice(0, limit)) {
      if (primary && c.id === primary.sessionId) continue;
      // light: signals only for sidebar list (faster)
      if (opts?.lightRecent !== false) {
        const found = await findSessionDir(c.id);
        if (!found) continue;
        const signals = await readJsonSafe<Record<string, unknown>>(
          path.join(found.dir, "signals.json")
        );
        const u = parseSignals(
          c.id,
          {
            cwd: found.meta.cwd,
            title: found.meta.title,
            modelId: found.meta.modelId,
            updatedAt: found.meta.updatedAt,
          },
          signals,
          emptyAgg()
        );
        if (u) recent.push(u);
      } else {
        const u = await getSessionUsage(c.id);
        if (u) recent.push(u);
      }
    }

    if (!primary && candidates[0]) {
      primary = await getSessionUsage(candidates[0].id);
    }
  } catch {
    /* empty */
  }

  return {
    primary,
    recent,
    account,
    note:
      "Tokens e custo agregados dos turns da sessão (updates.jsonl). Contexto = janela atual (signals). Créditos da conta: /usage manage no TUI ou grok.com.",
    billingUrl: "https://grok.com?_s=usage",
  };
}

/** Format tokens for UI: 228324 → "228k" */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1000) return String(Math.round(n));
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

export function formatUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "$0.00";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 10) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

export function formatDuration(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return "—";
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h}h ${m}m`;
}

export function formatMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
