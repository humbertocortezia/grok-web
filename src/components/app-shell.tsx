"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type ReactNode,
} from "react";
import {
  FolderGit2,
  GitBranch,
  ImagePlus,
  Layers3,
  Loader2,
  MessageSquare,
  MessageSquarePlus,
  Moon,
  PanelRight,
  Plug,
  RefreshCw,
  Search,
  Pencil,
  Send,
  Square,
  Sun,
  Terminal,
  Gauge,
  Trash2,
  X,
} from "lucide-react";
import { AcpClient, type ChatMessage, type ToolCallView } from "@/lib/acp-client";
import { cn } from "@/lib/cn";
import {
  cacheFromTabState,
  getCachedSession,
  putCachedSession,
} from "@/lib/session-cache";
import { ComposerCombo } from "@/components/composer-combo";
import { FileWorkbench } from "@/components/file-workbench";
import { MessageBubble } from "@/components/message-bubble";
import { OrbitMark } from "@/components/orbit-mark";
import { GrokMark, GrokWordmark } from "@/components/grok-logo";
import { useTheme } from "@/components/theme-provider";
import {
  UsageFooterStrip,
  UsagePanel,
  type UsagePrimary,
  type WorkStatus,
} from "@/components/usage-meter";
import { McpSkillsPanel } from "@/components/mcp-skills-panel";
import { SlashArmedChip, SlashMenu } from "@/components/slash-menu";
import {
  BUILTIN_SLASH,
  filterSlashCommands,
  parseSlashInput,
  skillsToSlash,
  type SlashCommand,
} from "@/lib/slash-commands";

type SessionRow = {
  id: string;
  cwd: string;
  title: string;
  updatedAt: string | null;
  modelId: string | null;
  numMessages: number;
  active?: boolean;
  /** True while a model turn is running (not just TUI session open). */
  turnLive?: boolean;
};

function metaTurnLive(
  meta?: { active?: boolean; turnLive?: boolean } | null
): boolean {
  if (!meta) return false;
  if (typeof meta.turnLive === "boolean") return meta.turnLive;
  return false;
}

/** Drop stuck "working" flags when the turn is over. */
function clearPendingMessages(messages: ChatMessage[]): ChatMessage[] {
  let changed = false;
  const next = messages.map((m) => {
    if (!m.pending && !(m.toolCalls || []).some((t) => !t.status || t.status === "running" || t.status === "pending" || t.status === "in_progress")) {
      return m;
    }
    changed = true;
    return {
      ...m,
      pending: false,
      toolCalls: m.toolCalls?.map((t) =>
        !t.status ||
        t.status === "running" ||
        t.status === "pending" ||
        t.status === "in_progress"
          ? { ...t, status: "completed" }
          : t
      ),
    };
  });
  return changed ? next : messages;
}

type ProjectRow = { name: string; path: string; hasGit: boolean };
type ComposerImage = {
  mimeType: string;
  dataUrl: string;
  data: string;
};

/** Prompt waiting until the agent turn is free. */
type QueuedPrompt = {
  id: string;
  text: string;
  images: ComposerImage[];
  createdAt: number;
};

type Tab = {
  id: string;
  title: string;
  sessionId: string | null;
  cwd: string;
  messages: ChatMessage[];
  busy: boolean;
  /** Follow chat_history.jsonl on disk (TUI / other clients). */
  liveFollow?: boolean;
  /** Last seen mtime:size of chat_history — skip re-parse when unchanged. */
  historyRev?: string;
  /**
   * Model turn currently running (events turn_started…turn_ended).
   * Not the same as "session open in TUI" — that can stay open while idle.
   */
  liveActive?: boolean;
  /**
   * True only after this browser's ACP agent successfully session/new or session/load.
   * Having a sessionId from disk is NOT enough to prompt — agent must attach first.
   */
  agentAttached?: boolean;
  attachError?: string | null;
  /** Windowed history (only loaded for open tabs). */
  historyTotal?: number;
  historyWindowStart?: number;
  historyWindowEnd?: number;
  historyHasMoreBefore?: boolean;
  historyLoadingOlder?: boolean;
  /** Typed while Grok is busy — flushed when the turn actually ends. */
  outboundQueue?: QueuedPrompt[];
  /** Model id for prompts on this tab (ACP session/set_model). */
  modelId?: string;
  /** Reasoning effort: high | medium | low (when model supports it). */
  reasoningEffort?: string;
};

type ModelCatalogItem = {
  id: string;
  name: string;
  description?: string;
  supportsReasoningEffort: boolean;
  defaultEffort?: string | null;
  efforts: Array<{
    id: string;
    value: string;
    label: string;
    description?: string;
    default?: boolean;
  }>;
};

const MODEL_PREF_KEY = "grok-web-model-pref";

function loadModelPref(): { modelId: string; effort: string } {
  if (typeof window === "undefined") {
    return { modelId: "grok-4.5", effort: "high" };
  }
  try {
    const raw = window.localStorage.getItem(MODEL_PREF_KEY);
    if (raw) {
      const o = JSON.parse(raw) as { modelId?: string; effort?: string };
      return {
        modelId: o.modelId || "grok-4.5",
        effort: o.effort || "high",
      };
    }
  } catch {
    /* ignore */
  }
  return { modelId: "grok-4.5", effort: "high" };
}

function saveModelPref(modelId: string, effort: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      MODEL_PREF_KEY,
      JSON.stringify({ modelId, effort })
    );
  } catch {
    /* ignore */
  }
}

function tabIsOccupied(tab: Tab | null | undefined): boolean {
  return Boolean(tab?.busy || tab?.liveActive);
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = window.setTimeout(
      () => reject(new Error(`${label} timeout (${ms}ms)`)),
      ms
    );
    p.then(
      (v) => {
        window.clearTimeout(t);
        resolve(v);
      },
      (e) => {
        window.clearTimeout(t);
        reject(e);
      }
    );
  });
}

const HISTORY_PAGE = 24;

type HistoryApiMsg = ChatMessage & { index?: number };

function mapHistoryMessages(list: HistoryApiMsg[] | undefined): ChatMessage[] {
  return (list || []).map((m) => {
    const index =
      m.index != null
        ? m.index
        : m.historyIndex != null
          ? m.historyIndex
          : m.id?.startsWith("hist-")
            ? Number(m.id.slice(5))
            : undefined;
    const historyIndex =
      index != null && Number.isFinite(index) ? index : undefined;
    return {
      ...m,
      historyIndex,
      // Prefer stable hist-{index} so window merges can dedupe by identity
      id:
        historyIndex != null
          ? `hist-${historyIndex}`
          : m.id || uid(),
      pending: false,
    };
  });
}

function histIndex(m: ChatMessage): number | null {
  if (m.historyIndex != null && Number.isFinite(m.historyIndex)) {
    return m.historyIndex;
  }
  if (!m.id.startsWith("hist-")) return null;
  const n = Number(m.id.slice(5));
  return Number.isFinite(n) ? n : null;
}

/** Trailing non-history messages (live send, system errors) still only in memory. */
function localSuffix(messages: ChatMessage[]): ChatMessage[] {
  // Cache/hydrate rows often keep UUID ids without historyIndex. If *nothing*
  // is tagged as history, treating the whole list as "local" re-appends it on
  // every disk merge and produces duplicate React keys forever.
  if (!messages.some((m) => histIndex(m) != null)) return [];

  const out: ChatMessage[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (histIndex(messages[i]) != null) break;
    out.unshift(messages[i]);
  }
  return out;
}

/**
 * True when disk tail already contains the live local suffix (same roles / user text).
 * In that case we must not keep the UUID copies — they would duplicate keys after
 * preserveMessageIds rewrites the tail.
 */
function localCaughtUpByDisk(local: ChatMessage[], disk: ChatMessage[]): boolean {
  if (!local.length || disk.length < local.length) return false;
  if (local.some((m) => m.pending)) return false;
  for (let i = 0; i < local.length; i++) {
    const d = disk[disk.length - local.length + i];
    const l = local[i];
    if (d.role !== l.role) return false;
    if (l.role === "user" && d.text.trim() !== l.text.trim()) return false;
  }
  return true;
}

/**
 * Keep React keys stable when disk history replaces in-memory messages.
 * Without this, uuid → hist-N remounts every bubble and re-plays enter animations
 * (the “piscada” at the end of a turn).
 */
function preserveMessageIds(
  previous: ChatMessage[],
  next: ChatMessage[]
): ChatMessage[] {
  if (!next.length) return next;
  if (!previous.length) return ensureUniqueMessageIds(next);
  const out = next.map((m) => ({ ...m }));
  let pi = previous.length - 1;
  let ni = out.length - 1;
  // Track ids already claimed while walking so we never stamp the same UUID twice
  const claimed = new Set<string>();
  while (pi >= 0 && ni >= 0) {
    const prev = previous[pi];
    const cur = out[ni];
    if (prev.role !== cur.role) break;

    const preferId =
      prev.id && !claimed.has(prev.id)
        ? prev.id
        : cur.id && !claimed.has(cur.id)
          ? cur.id
          : cur.historyIndex != null
            ? `hist-${cur.historyIndex}`
            : uid();

    claimed.add(preferId);
    // Prefer local React key so MessageBubble does not remount, but keep
    // historyIndex from disk so the next merge can still window/dedupe.
    out[ni] = {
      ...cur,
      id: preferId,
      historyIndex: cur.historyIndex ?? prev.historyIndex,
      // Don't resurrect a live pending flag after history catch-up
      pending: false,
      // Keep richer streaming fields if history is thinner
      thinking: cur.thinking || prev.thinking,
      toolCalls:
        (cur.toolCalls?.length || 0) >= (prev.toolCalls?.length || 0)
          ? cur.toolCalls
          : prev.toolCalls,
      images: cur.images?.length ? cur.images : prev.images,
    };
    pi--;
    ni--;
  }
  return ensureUniqueMessageIds(out);
}

/**
 * Never hand React two children with the same key. Also drop duplicate
 * historyIndex rows (same disk message kept twice after a bad merge).
 * Walks from the end so the newest/richest copy wins.
 */
function ensureUniqueMessageIds(messages: ChatMessage[]): ChatMessage[] {
  const seenIds = new Set<string>();
  const seenHist = new Set<number>();
  const out: ChatMessage[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const hi = histIndex(m);
    if (hi != null) {
      if (seenHist.has(hi)) continue;
      seenHist.add(hi);
    }
    let id = m.id || (hi != null ? `hist-${hi}` : `msg-${i}`);
    if (seenIds.has(id)) {
      if (hi != null) {
        id = `hist-${hi}`;
        if (seenIds.has(id)) continue;
      } else {
        // Exact id clone of a later bubble — drop, don't show twice
        continue;
      }
    }
    seenIds.add(id);
    out.unshift(id === m.id ? m : { ...m, id });
  }
  return out;
}

/**
 * Merge an older in-memory window with a fresh disk tail.
 * Critical: do NOT keep UUID-preserved history rows as "older" — after
 * preserveMessageIds they no longer start with hist- and would duplicate the tail.
 */
function mergeHistoryWindows(
  stillMessages: ChatMessage[],
  tail: ChatMessage[],
  tailStart: number
): ChatMessage[] {
  const older = stillMessages.filter((m) => {
    const idx = histIndex(m);
    return idx != null && idx < tailStart;
  });

  const live = localSuffix(stillMessages);
  const disk = [...older, ...tail];
  const raw =
    live.length && !localCaughtUpByDisk(live, disk)
      ? [...disk, ...live]
      : disk;

  return preserveMessageIds(stillMessages, raw);
}

type InspectorTab = "diff" | "mcp" | "session" | "usage";

function uid() {
  return crypto.randomUUID();
}

function formatRelative(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const sec = Math.round((Date.now() - t) / 1000);
  if (sec < 60) return "agora";
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  if (sec < 86400 * 7) return `${Math.floor(sec / 86400)}d`;
  return new Date(t).toLocaleDateString("pt-BR", { day: "2-digit", month: "short" });
}

function shortHome(p: string): string {
  return p.replace(/^\/home\/[^/]+/, "~");
}

function projectLabel(cwd: string): string {
  const cleaned = cwd.replace(/\/+$/, "");
  const base = cleaned.split("/").filter(Boolean).pop();
  return base || cleaned || "—";
}

function normPath(p: string): string {
  return p.replace(/\/+$/, "") || p;
}

function sessionDayBucket(iso: string | null): "today" | "yesterday" | "earlier" {
  if (!iso) return "earlier";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "earlier";
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startYesterday = startToday - 86_400_000;
  if (t >= startToday) return "today";
  if (t >= startYesterday) return "yesterday";
  return "earlier";
}

const DAY_BUCKET_LABEL: Record<"today" | "yesterday" | "earlier", string> = {
  today: "Hoje",
  yesterday: "Ontem",
  earlier: "Anteriormente",
};

export function AppShell() {
  const [agentReady, setAgentReady] = useState(false);
  const [wsUrl, setWsUrl] = useState<string | null>(null);
  const [defaultCwd, setDefaultCwd] = useState("/home/humberto/projetos");
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState("conectando…");

  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [liveMcp, setLiveMcp] = useState<unknown[]>([]);

  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [images, setImages] = useState<ComposerImage[]>([]);
  /** Queue item being edited inline above the composer. */
  const [queueEditId, setQueueEditId] = useState<string | null>(null);
  const [queueEditText, setQueueEditText] = useState("");
  const flushLockRef = useRef(false);
  const [modelCatalog, setModelCatalog] = useState<ModelCatalogItem[]>([]);
  const [selectedModelId, setSelectedModelId] = useState("grok-4.5");
  const [selectedEffort, setSelectedEffort] = useState("high");
  const [modelSwitching, setModelSwitching] = useState(false);
  const [slashSkills, setSlashSkills] = useState<
    Array<{
      name: string;
      description: string;
      shortDescription?: string;
      userInvocable?: boolean;
    }>
  >([]);
  const [slashIndex, setSlashIndex] = useState(0);
  const [inspector, setInspector] = useState<InspectorTab>("diff");
  const [usage, setUsage] = useState<UsagePrimary | null>(null);
  const [usageRecent, setUsageRecent] = useState<UsagePrimary[]>([]);
  const [usageNote, setUsageNote] = useState<string>("");
  const [usageBillingUrl, setUsageBillingUrl] = useState(
    "https://grok.com?_s=usage"
  );
  const [usageAccount, setUsageAccount] = useState<{
    email: string | null;
    firstName: string | null;
  } | null>(null);
  const [usageLoading, setUsageLoading] = useState(false);
  const [diffFiles, setDiffFiles] = useState<{ code: string; path: string }[]>([]);
  const [diffBranch, setDiffBranch] = useState("");
  const { theme, toggle: toggleTheme } = useTheme();
  const [leftPanel, setLeftPanel] = useState<"sessions" | "projects">("sessions");
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [sidebarQuery, setSidebarQuery] = useState("");

  const clientRef = useRef<AcpClient | null>(null);
  const activeTabIdRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  /** Keep pin-to-bottom unless user scrolls up to read history. */
  const stickToBottomRef = useRef(true);
  /** After prepending older messages, restore scroll so the viewport doesn't jump. */
  const pendingScrollRestoreRef = useRef<{ height: number; top: number } | null>(
    null
  );
  const loadingOlderRef = useRef(false);

  useEffect(() => {
    activeTabIdRef.current = activeTabId;
    // Switching tabs: show the latest end of that thread without animating through history
    stickToBottomRef.current = true;
  }, [activeTabId]);

  const activeTab = useMemo(
    () => tabs.find((t) => t.id === activeTabId) || null,
    [tabs, activeTabId]
  );

  const workStatus: WorkStatus = !connected
    ? "offline"
    : activeTab?.busy || activeTab?.liveActive
      ? "busy"
      : "idle";

  function openUsagePanel() {
    setInspectorOpen(true);
    setInspector("usage");
  }

  const refreshMeta = useCallback(async () => {
    const [s, p] = await Promise.all([
      fetch("/api/sessions").then((r) => r.json()),
      fetch("/api/projects").then((r) => r.json()),
    ]);
    setSessions(s.sessions || []);
    setProjects(p.projects || []);
  }, []);

  const refreshSessionsOnly = useCallback(async () => {
    try {
      const s = await fetch("/api/sessions").then((r) => r.json());
      setSessions(s.sessions || []);
    } catch {
      /* ignore transient errors */
    }
  }, []);

  const refreshProjectsOnly = useCallback(async () => {
    try {
      const p = await fetch("/api/projects").then((r) => r.json());
      setProjects(p.projects || []);
    } catch {
      /* ignore transient errors */
    }
  }, []);

  const refreshDiff = useCallback(async (cwd: string) => {
    // Light poll — only status list; per-file patch loads on demand in FileWorkbench
    const res = await fetch(
      `/api/diffs?cwd=${encodeURIComponent(cwd)}&light=1`
    );
    const data = await res.json();
    if (data.ok) {
      setDiffFiles(data.files || []);
      setDiffBranch(data.branchLine || "");
    } else {
      setDiffFiles([]);
      setDiffBranch("");
    }
  }, []);

  const refreshUsage = useCallback(
    async (sessionId?: string | null, opts?: { full?: boolean }) => {
      try {
        setUsageLoading(true);
        const params = new URLSearchParams();
        if (sessionId) params.set("sessionId", sessionId);
        if (opts?.full) params.set("full", "1");
        const q = params.toString() ? `?${params}` : "";
        const res = await fetch(`/api/usage${q}`);
        if (!res.ok) return;
        const data = (await res.json()) as {
          primary?: UsagePrimary | null;
          recent?: UsagePrimary[];
          note?: string;
          billingUrl?: string;
          account?: { email: string | null; firstName: string | null } | null;
        };
        setUsage(data.primary || null);
        setUsageRecent(data.recent || []);
        setUsageNote(data.note || "");
        if (data.billingUrl) setUsageBillingUrl(data.billingUrl);
        setUsageAccount(data.account || null);
      } catch {
        /* ignore */
      } finally {
        setUsageLoading(false);
      }
    },
    []
  );

  // Poll context usage for active session (and active TUI session when no tab id)
  useEffect(() => {
    void refreshUsage(activeTab?.sessionId);
    const id = window.setInterval(() => {
      void refreshUsage(activeTab?.sessionId);
    }, 8000);
    return () => window.clearInterval(id);
  }, [activeTab?.sessionId, refreshUsage]);

  // Full token/cost aggregate every time the Uso tab is opened
  useEffect(() => {
    if (inspector !== "usage" || !inspectorOpen) return;
    void refreshUsage(activeTab?.sessionId, { full: true });
  }, [inspector, inspectorOpen, activeTab?.sessionId, refreshUsage]);

  const updateTab = useCallback((tabId: string, patch: Partial<Tab>) => {
    setTabs((prev) =>
      prev.map((t) => {
        if (t.id !== tabId) return t;
        const next = { ...t, ...patch };
        if (patch.messages) {
          next.messages = ensureUniqueMessageIds(patch.messages);
        }
        return next;
      })
    );
  }, []);

  const appendToTab = useCallback((tabId: string, msg: ChatMessage) => {
    setTabs((prev) =>
      prev.map((t) =>
        t.id === tabId
          ? { ...t, messages: ensureUniqueMessageIds([...t.messages, msg]) }
          : t
      )
    );
  }, []);

  const patchLastAssistant = useCallback(
    (tabId: string, fn: (m: ChatMessage) => ChatMessage) => {
      setTabs((prev) =>
        prev.map((t) => {
          if (t.id !== tabId) return t;
          const msgs = [...t.messages];
          for (let i = msgs.length - 1; i >= 0; i--) {
            if (msgs[i].role === "assistant") {
              msgs[i] = fn(msgs[i]);
              break;
            }
          }
          return { ...t, messages: ensureUniqueMessageIds(msgs) };
        })
      );
    },
    []
  );

  // Repair tabs that already hold duplicate keys (sessionStorage / pre-fix state)
  useEffect(() => {
    setTabs((prev) => {
      let changed = false;
      const next = prev.map((t) => {
        const ids = t.messages.map((m) => m.id);
        const hasDup = ids.length !== new Set(ids).size;
        const hasDupHist =
          t.messages.filter((m) => histIndex(m) != null).length !==
          new Set(
            t.messages
              .map((m) => histIndex(m))
              .filter((n): n is number => n != null)
          ).size;
        if (!hasDup && !hasDupHist) return t;
        changed = true;
        return { ...t, messages: ensureUniqueMessageIds(t.messages) };
      });
      return changed ? next : prev;
    });
  }, [tabs.length, activeTabId]);

  // Bootstrap agent env + metadata + models catalog
  useEffect(() => {
    (async () => {
      const pref = loadModelPref();
      setSelectedModelId(pref.modelId);
      setSelectedEffort(pref.effort);

      const env = await fetch("/api/agent/env").then((r) => r.json());
      setWsUrl(env.wsUrl);
      setAgentReady(Boolean(env.ready && env.wsUrl));
      if (env.defaultCwd) setDefaultCwd(env.defaultCwd);
      await refreshMeta();

      try {
        const cat = await fetch("/api/models").then((r) => r.json());
        const models = (cat.models || []) as ModelCatalogItem[];
        setModelCatalog(models);
        const def =
          models.find((m) => m.id === pref.modelId) ||
          models.find((m) => m.id === cat.defaultModelId) ||
          models[0];
        if (def) {
          setSelectedModelId(def.id);
          const efforts = def.efforts || [];
          const effortOk = efforts.some((e) => e.value === pref.effort);
          const nextEffort = effortOk
            ? pref.effort
            : def.defaultEffort ||
              efforts.find((e) => e.default)?.value ||
              efforts[0]?.value ||
              "high";
          setSelectedEffort(nextEffort);
          saveModelPref(def.id, nextEffort);
        }
      } catch {
        /* keep defaults */
      }
    })();
  }, [refreshMeta]);

  const activeModel = useMemo(
    () => modelCatalog.find((m) => m.id === selectedModelId) || null,
    [modelCatalog, selectedModelId]
  );
  const effortOptions = activeModel?.efforts?.length
    ? activeModel.efforts
    : [
        { id: "high", value: "high", label: "High" },
        { id: "medium", value: "medium", label: "Medium" },
        { id: "low", value: "low", label: "Low" },
      ];
  const showEffort =
    activeModel?.supportsReasoningEffort !== false && effortOptions.length > 0;

  // Skills for / menu (refetch when cwd changes)
  useEffect(() => {
    const cwd = activeTab?.cwd || defaultCwd;
    const q = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
    void fetch(`/api/skills${q}`)
      .then((r) => r.json())
      .then((d) => setSlashSkills(d.skills || []))
      .catch(() => setSlashSkills([]));
  }, [activeTab?.cwd, defaultCwd, inspector]);

  const slashCatalog = useMemo(() => {
    const skills = skillsToSlash(slashSkills);
    // Built-ins first; skills fill gaps (skip name collisions with builtins)
    const builtinNames = new Set(
      BUILTIN_SLASH.flatMap((c) => [c.name, ...(c.aliases || [])])
    );
    const skillCmds = skills.filter((s) => !builtinNames.has(s.name));
    return [...BUILTIN_SLASH, ...skillCmds];
  }, [slashSkills]);

  const slashParse = useMemo(() => parseSlashInput(draft), [draft]);
  const slashItems = useMemo(() => {
    if (!slashParse.active || slashParse.hasArgs) return [];
    return filterSlashCommands(slashCatalog, slashParse.filter);
  }, [slashCatalog, slashParse]);
  const slashMenuOpen =
    slashParse.active && !slashParse.hasArgs && slashItems.length > 0;

  /** Exact catalog match for the command name currently in the draft */
  const slashResolved = useMemo(() => {
    if (!slashParse.active || !slashParse.commandName) return null;
    const name = slashParse.commandName.toLowerCase();
    return (
      slashCatalog.find(
        (c) => c.name === name || (c.aliases || []).includes(name)
      ) || null
    );
  }, [slashCatalog, slashParse]);

  /** Item under keyboard/mouse focus in the open menu */
  const slashFocused =
    slashMenuOpen && slashItems.length
      ? slashItems[Math.min(slashIndex, slashItems.length - 1)] || null
      : null;

  /**
   * Armed = confirmed selection (exact name match, with or without args).
   * While only browsing the menu, we show the focused row as "em foco".
   */
  const slashArmed = slashResolved;
  const slashChipCmd = slashArmed || slashFocused;
  const slashChipPicking = Boolean(slashFocused && !slashArmed);

  useEffect(() => {
    setSlashIndex(0);
  }, [slashParse.filter, slashMenuOpen]);

  /** Apply model/effort to the live ACP session when attached. */
  async function applyModelToSession(
    tab: Tab,
    modelId: string,
    effort: string
  ) {
    const client = clientRef.current;
    if (!client?.connected || !tab.sessionId || !tab.agentAttached) return;
    setModelSwitching(true);
    try {
      await withTimeout(
        client.setModel(tab.sessionId, modelId, {
          reasoningEffort: effort,
        }),
        15_000,
        "session/set_model"
      );
      updateTab(tab.id, { modelId, reasoningEffort: effort });
      setStatus("online");
    } catch (e) {
      setStatus(
        e instanceof Error ? e.message : "falha ao trocar modelo"
      );
    } finally {
      setModelSwitching(false);
    }
  }

  async function onSelectModel(modelId: string) {
    const m = modelCatalog.find((x) => x.id === modelId);
    const efforts = m?.efforts || [];
    let effort = selectedEffort;
    if (efforts.length && !efforts.some((e) => e.value === effort)) {
      effort =
        m?.defaultEffort ||
        efforts.find((e) => e.default)?.value ||
        efforts[0]?.value ||
        effort;
    }
    setSelectedModelId(modelId);
    setSelectedEffort(effort);
    saveModelPref(modelId, effort);
    if (activeTab) {
      updateTab(activeTab.id, { modelId, reasoningEffort: effort });
      void applyModelToSession(
        { ...activeTab, modelId, reasoningEffort: effort },
        modelId,
        effort
      );
    }
  }

  async function onSelectEffort(effort: string) {
    setSelectedEffort(effort);
    saveModelPref(selectedModelId, effort);
    if (activeTab) {
      updateTab(activeTab.id, {
        modelId: selectedModelId,
        reasoningEffort: effort,
      });
      void applyModelToSession(
        {
          ...activeTab,
          modelId: selectedModelId,
          reasoningEffort: effort,
        },
        selectedModelId,
        effort
      );
    }
  }

  function pickSlashCommand(cmd: SlashCommand) {
    // Needs args → complete the token and let the user type
    if (cmd.argumentHint) {
      setDraft(`${cmd.command} `);
      return;
    }
    // Local web command → run now
    if (cmd.local) {
      setDraft("");
      void runSlashFromDraft(cmd.command);
      return;
    }
    // Skill / agent builtin without args → send to model as slash prompt
    setDraft("");
    if (!activeTab) return;
    const tabId = activeTab.id;
    const latest =
      latestTabsRef.current.find((t) => t.id === tabId) || activeTab;
    if (tabIsOccupied(latest)) {
      enqueuePrompt(tabId, cmd.command, []);
      return;
    }
    void dispatchPrompt(tabId, cmd.command, []);
  }

  async function runSlashFromDraft(text: string): Promise<boolean> {
    const t = text.trim();
    if (!t.startsWith("/")) return false;
    const body = t.slice(1);
    const sp = body.search(/\s/);
    const name = (sp < 0 ? body : body.slice(0, sp)).toLowerCase();
    const args = (sp < 0 ? "" : body.slice(sp + 1)).trim();

    const match =
      slashCatalog.find(
        (c) =>
          c.name === name || (c.aliases || []).includes(name)
      ) || null;

    // Local web handlers
    if (match?.local || name === "new" || name === "clear") {
      if (name === "new" || name === "clear") {
        if (activeTab) {
          updateTab(activeTab.id, {
            messages: [],
            sessionId: null,
            agentAttached: false,
            title: "Nova conversa",
            busy: false,
            liveFollow: false,
            outboundQueue: [],
          });
        } else {
          newTab();
        }
        setDraft("");
        setStatus("nova conversa");
        return true;
      }
      if (name === "model" || name === "m") {
        const mid = args.split(/\s+/)[0];
        if (mid) {
          void onSelectModel(mid);
          setDraft("");
          setStatus(`modelo → ${mid}`);
          return true;
        }
        setDraft("/model ");
        return true;
      }
      if (name === "effort") {
        const lvl = args.split(/\s+/)[0]?.toLowerCase();
        if (lvl && ["low", "medium", "high", "xhigh"].includes(lvl)) {
          void onSelectEffort(lvl === "xhigh" ? "high" : lvl);
          setDraft("");
          setStatus(`effort → ${lvl}`);
          return true;
        }
        setDraft("/effort ");
        return true;
      }
      if (name === "usage" || name === "cost") {
        openUsagePanel();
        setDraft("");
        return true;
      }
      if (name === "mcps" || name === "skills") {
        setInspectorOpen(true);
        setInspector("mcp");
        setDraft("");
        return true;
      }
      if (name === "rename" || name === "title") {
        if (args && activeTab) {
          updateTab(activeTab.id, { title: args.slice(0, 48) });
          setDraft("");
          return true;
        }
        setDraft("/rename ");
        return true;
      }
    }

    // Everything else (skills + agent builtins): send as prompt so the agent runs it
    return false;
  }

  // Keep history list fresh so live TUI / other agents appear quickly
  useEffect(() => {
    const id = window.setInterval(() => {
      void refreshSessionsOnly();
    }, 4000);
    return () => window.clearInterval(id);
  }, [refreshSessionsOnly]);

  // Connect ACP
  useEffect(() => {
    if (!wsUrl) return;
    const client = new AcpClient({
      onOpen: async () => {
        setConnected(true);
        setStatus("inicializando ACP…");
        try {
          await client.initialize();
          setStatus("online");
        } catch (e) {
          setStatus(e instanceof Error ? e.message : "falha initialize");
        }
      },
      onClose: () => {
        setConnected(false);
        setStatus("desconectado");
      },
      onError: (err) => setStatus(err.message),
      onMcpServers: (servers) => setLiveMcp(servers),
      onClientRequest: (method) => {
        setStatus((s) => (s === "online" || s.startsWith("tool") ? `client: ${method}` : s));
      },
      onTurnEnd: (sessionId) => {
        const tab = tabsRefFindBySession(sessionId);
        if (!tab) return;
        finishTabTurn(tab.id);
        setStatus("online");
      },
      onSessionUpdate: (sessionId, update) => {
        const tab = tabsRefFindBySession(sessionId);
        if (!tab) return;
        const kind = String(update.sessionUpdate || "");
        // After session/prompt resolves, late chunks must not resurrect "working"
        const tabNow =
          latestTabsRef.current.find((t) => t.id === tab.id) || tab;
        const inTurn = Boolean(tabNow.busy);

        if (kind === "agent_message_chunk") {
          const text =
            (update.content as { text?: string } | undefined)?.text ||
            (update as { text?: string }).text ||
            "";
          if (!text) return;
          patchLastAssistant(tab.id, (m) => ({
            ...m,
            pending: inTurn,
            text: (m.text || "") + text,
          }));
        }

        if (kind === "agent_thought_chunk") {
          const text =
            (update.content as { text?: string } | undefined)?.text ||
            (update as { text?: string }).text ||
            "";
          if (!text) return;
          patchLastAssistant(tab.id, (m) => ({
            ...m,
            pending: inTurn,
            thinking: (m.thinking || "") + text,
          }));
        }

        if (kind === "tool_call") {
          const tool: ToolCallView = {
            id: String(update.toolCallId || update.tool_call_id || uid()),
            title: String(update.title || update.kind || "tool"),
            kind: update.kind as string | undefined,
            status: String(update.status || "running"),
            input: update.rawInput || update.input,
          };
          patchLastAssistant(tab.id, (m) => {
            const existing = m.toolCalls || [];
            if (existing.some((t) => t.id === tool.id)) {
              return {
                ...m,
                pending: inTurn,
                toolCalls: existing.map((t) =>
                  t.id === tool.id ? { ...t, ...tool, status: tool.status || t.status } : t
                ),
              };
            }
            return {
              ...m,
              pending: inTurn,
              toolCalls: [...existing, tool],
            };
          });
        }

        if (kind === "tool_call_update") {
          const id = String(update.toolCallId || update.tool_call_id || "");
          const status = String(update.status || "");
          const title = update.title ? String(update.title) : undefined;
          const output =
            typeof update.content === "string"
              ? update.content
              : Array.isArray(update.content)
                ? JSON.stringify(update.content).slice(0, 2000)
                : update.rawOutput
                  ? String(update.rawOutput).slice(0, 2000)
                  : undefined;
          patchLastAssistant(tab.id, (m) => ({
            ...m,
            pending: inTurn ? m.pending : false,
            toolCalls: (m.toolCalls || []).map((t) =>
              t.id === id || (!id && (t.status === "running" || t.status === "pending"))
                ? {
                    ...t,
                    title: title || t.title,
                    status: status || t.status || "running",
                    output: output || t.output,
                    kind: (update.kind as string) || t.kind,
                  }
                : t
            ),
          }));
        }

        // Grok-specific: interaction resolved / tool finished signals
        if (kind === "interaction_resolved" || kind === "tool_call_end") {
          const id = String(update.tool_call_id || update.toolCallId || "");
          patchLastAssistant(tab.id, (m) => ({
            ...m,
            toolCalls: (m.toolCalls || []).map((t) =>
              !id || t.id === id ? { ...t, status: "completed" } : t
            ),
          }));
        }
      },
    });

    function tabsRefFindBySession(sessionId: string) {
      return (
        latestTabsRef.current.find((t) => t.sessionId === sessionId) ||
        // race: session just created, ref may lag one tick — fall back to active tab
        latestTabsRef.current.find((t) => t.id === activeTabIdRef.current) ||
        null
      );
    }

    function finishTabTurn(tabId: string) {
      patchLastAssistant(tabId, (m) => ({
        ...m,
        pending: false,
        toolCalls: (m.toolCalls || []).map((t) =>
          t.status === "running" ||
          t.status === "pending" ||
          t.status === "in_progress" ||
          !t.status
            ? { ...t, status: "completed" }
            : t
        ),
      }));
      updateTab(tabId, { busy: false, liveActive: false });
    }

    clientRef.current = client;
    client.connect(wsUrl);
    return () => client.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsUrl]);

  const latestTabsRef = useRef<Tab[]>([]);
  useEffect(() => {
    latestTabsRef.current = tabs;
  }, [tabs]);

  // Create first tab
  useEffect(() => {
    if (tabs.length === 0 && agentReady) {
      const id = uid();
      setTabs([
        {
          id,
          title: "Nova conversa",
          sessionId: null,
          cwd: defaultCwd,
          messages: [
            {
              id: uid(),
              role: "system",
              text: "Grok Web — interface gráfica sobre o agent no terminal. Sessões, projetos, MCP e diffs ficam nos painéis laterais.",
            },
          ],
          busy: false,
          liveFollow: false,
          agentAttached: false,
        },
      ]);
      setActiveTabId(id);
    }
  }, [tabs.length, agentReady, defaultCwd]);

  useEffect(() => {
    if (activeTab?.cwd) refreshDiff(activeTab.cwd);
  }, [activeTab?.cwd, refreshDiff]);

  // Instant pin to bottom (or restore after loading older).
  // Do NOT depend on `busy` — flipping busy at turn end forced a scroll jump (flicker).
  const messagesSig = activeTab
    ? `${activeTab.messages.length}:${activeTab.messages[activeTab.messages.length - 1]?.id ?? ""}:${activeTab.messages[activeTab.messages.length - 1]?.text?.length ?? 0}`
    : "";
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const restore = pendingScrollRestoreRef.current;
    if (restore) {
      el.scrollTop = el.scrollHeight - restore.height + restore.top;
      pendingScrollRestoreRef.current = null;
      return;
    }
    if (stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messagesSig, activeTabId]);

  const loadOlderHistory = useCallback(async () => {
    if (loadingOlderRef.current) return;
    const tabId = activeTabIdRef.current;
    if (!tabId) return;
    const tab = latestTabsRef.current.find((t) => t.id === tabId);
    if (
      !tab?.sessionId ||
      !tab.liveFollow ||
      !tab.historyHasMoreBefore ||
      tab.historyLoadingOlder ||
      tab.historyWindowStart == null ||
      tab.historyWindowStart <= 0
    ) {
      return;
    }

    // Don't thrash when already at top with no room to scroll (short thread)
    const el0 = scrollRef.current;
    if (el0 && el0.scrollHeight <= el0.clientHeight + 8) {
      // Content fits viewport — only load once if has more, then stop
      if ((tab.messages?.length || 0) > HISTORY_PAGE) return;
    }

    loadingOlderRef.current = true;
    updateTab(tabId, { historyLoadingOlder: true });

    const el = scrollRef.current;
    if (el) {
      pendingScrollRestoreRef.current = {
        height: el.scrollHeight,
        top: el.scrollTop,
      };
    }

    try {
      const res = await fetch(
        `/api/sessions/${encodeURIComponent(tab.sessionId)}?limit=${HISTORY_PAGE}&before=${tab.historyWindowStart}&light=1`
      );
      if (!res.ok) throw new Error("falha ao carregar histórico antigo");
      const detail = (await res.json()) as {
        messages?: HistoryApiMsg[];
        total?: number;
        windowStart?: number;
        windowEnd?: number;
        hasMoreBefore?: boolean;
        rev?: string;
      };
      const older = mapHistoryMessages(detail.messages);
      const still = latestTabsRef.current.find((t) => t.id === tabId);
      if (!still) return;

      // Dedupe by history index (not React id — preserveMessageIds may rewrite those)
      const existingHist = new Set(
        still.messages
          .map((m) => histIndex(m))
          .filter((n): n is number => n != null)
      );
      const prepend = older.filter((m) => {
        const idx = histIndex(m);
        return idx == null || !existingHist.has(idx);
      });

      // Empty page → stop paging (prevents infinite fetch loop that freezes UI)
      if (prepend.length === 0) {
        updateTab(tabId, {
          historyHasMoreBefore: false,
          historyLoadingOlder: false,
        });
        pendingScrollRestoreRef.current = null;
        return;
      }

      updateTab(tabId, {
        messages: ensureUniqueMessageIds([...prepend, ...still.messages]),
        historyTotal: detail.total ?? still.historyTotal,
        historyWindowStart:
          detail.windowStart != null
            ? detail.windowStart
            : still.historyWindowStart,
        historyHasMoreBefore: Boolean(detail.hasMoreBefore),
        historyLoadingOlder: false,
        historyRev: detail.rev || still.historyRev,
      });
      // Keep cache filled with the wider window
      queueMicrotask(() => rememberTabHistory(tabId));
    } catch {
      updateTab(tabId, { historyLoadingOlder: false, historyHasMoreBefore: false });
      pendingScrollRestoreRef.current = null;
    } finally {
      loadingOlderRef.current = false;
    }
  }, [updateTab]);

  const onChatScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distBottom < 80;

    // Only load older when user intentionally scrolled near the top
    // (and there is actual scroll room — avoids loop on short threads)
    if (el.scrollTop < 80 && el.scrollHeight > el.clientHeight + 40) {
      void loadOlderHistory();
    }
  }, [loadOlderHistory]);

  /**
   * Live mirror ONLY for the active tab.
   * Critical: do NOT call setState when rev is unchanged or content is identical —
   * otherwise a live TUI session freezes the tab with 1Hz full re-renders + animations.
   */
  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    let inFlight = false;

    const tick = async () => {
      if (cancelled) return;
      // Tab in background — don't burn CPU/disk
      if (typeof document !== "undefined" && document.hidden) {
        timer = window.setTimeout(tick, 8000);
        return;
      }
      if (inFlight) {
        timer = window.setTimeout(tick, 2000);
        return;
      }

      const tab = latestTabsRef.current.find(
        (t) =>
          t.id === activeTabIdRef.current &&
          t.liveFollow &&
          t.sessionId &&
          !t.busy
      );
      if (!tab?.sessionId) {
        timer = window.setTimeout(tick, 4000);
        return;
      }

      inFlight = true;
      try {
        const params = new URLSearchParams({
          limit: String(HISTORY_PAGE),
          light: "1",
        });
        if (tab.historyRev) params.set("rev", tab.historyRev);

        const res = await fetch(
          `/api/sessions/${encodeURIComponent(tab.sessionId)}?${params}`
        );
        if (!res.ok) {
          timer = window.setTimeout(tick, 2500);
          return;
        }
        const detail = (await res.json()) as {
          unchanged?: boolean;
          rev?: string;
          meta?: SessionRow;
          messages?: HistoryApiMsg[];
          total?: number;
          windowStart?: number;
          windowEnd?: number;
          hasMoreBefore?: boolean;
        };

        // turnLive = model actually running; active alone only means TUI has session open
        const liveActive = metaTurnLive(detail.meta);

        if (detail.unchanged) {
          const patch: Partial<Tab> = {};
          if (tab.liveActive !== liveActive) patch.liveActive = liveActive;
          // Turn ended while history rev idle — clear stuck "working" bubbles
          if (!liveActive && tab.messages.some((m) => m.pending)) {
            patch.messages = clearPendingMessages(tab.messages);
          }
          if (Object.keys(patch).length) updateTab(tab.id, patch);
          // Poll faster while a turn is live so UI settles quickly on turn_ended
          timer = window.setTimeout(tick, liveActive ? 1500 : 5000);
          return;
        }

        const still = latestTabsRef.current.find((t) => t.id === tab.id);
        if (!still || still.busy || !still.liveFollow) {
          timer = window.setTimeout(tick, 2000);
          return;
        }

        // Same rev we already applied (race) — still refresh turnLive
        if (detail.rev && detail.rev === still.historyRev) {
          const patch: Partial<Tab> = {};
          if (still.liveActive !== liveActive) patch.liveActive = liveActive;
          if (!liveActive && still.messages.some((m) => m.pending)) {
            patch.messages = clearPendingMessages(still.messages);
          }
          if (Object.keys(patch).length) updateTab(tab.id, patch);
          timer = window.setTimeout(tick, liveActive ? 1500 : 4000);
          return;
        }

        const tail = mapHistoryMessages(detail.messages);
        const tailStart = detail.windowStart ?? 0;
        let merged = mergeHistoryWindows(still.messages, tail, tailStart);
        if (!liveActive) merged = clearPendingMessages(merged);
        const olderHist = still.messages.filter((m) => {
          const idx = histIndex(m);
          return idx != null && idx < tailStart;
        });
        const windowStart =
          olderHist.length > 0
            ? (histIndex(olderHist[0]) ?? detail.windowStart ?? still.historyWindowStart)
            : (detail.windowStart ?? still.historyWindowStart);

        // Cheap equality: avoid setState if nothing meaningful changed
        const sameLen = merged.length === still.messages.length;
        const lastNew = merged[merged.length - 1];
        const lastOld = still.messages[still.messages.length - 1];
        const sameTail =
          sameLen &&
          lastNew?.id === lastOld?.id &&
          lastNew?.text === lastOld?.text &&
          lastNew?.pending === lastOld?.pending &&
          (lastNew?.toolCalls?.length || 0) === (lastOld?.toolCalls?.length || 0);

        if (sameTail && detail.rev === still.historyRev) {
          if (still.liveActive !== liveActive) {
            updateTab(tab.id, { liveActive });
          }
          timer = window.setTimeout(tick, liveActive ? 1500 : 4000);
          return;
        }

        updateTab(tab.id, {
          title: (detail.meta?.title || still.title || "Sessão").slice(0, 48),
          cwd: detail.meta?.cwd || still.cwd,
          messages: merged.length > 0 ? merged : still.messages,
          historyRev: detail.rev,
          liveActive,
          historyTotal: detail.total ?? still.historyTotal,
          historyWindowStart: windowStart,
          historyWindowEnd: detail.windowEnd ?? still.historyWindowEnd,
          historyHasMoreBefore:
            windowStart != null ? windowStart > 0 : Boolean(detail.hasMoreBefore),
        });
        queueMicrotask(() => rememberTabHistory(tab.id));
      } catch {
        /* ignore */
      } finally {
        inFlight = false;
      }

      // After a content change, cool down (was 1s — froze React with full re-renders)
      timer = window.setTimeout(tick, 4000);
    };

    timer = window.setTimeout(tick, 1500);
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [updateTab]);

  async function ensureSession(tab: Tab): Promise<string> {
    const client = clientRef.current;
    if (!client?.connected) throw new Error("Agent offline. Rode: npm run web");

    const modelId = tab.modelId || selectedModelId;
    const reasoningEffort = tab.reasoningEffort || selectedEffort;

    // Already bound to this browser's agent process
    // (model/effort applied on picker change + session/new — not every prompt)
    if (tab.sessionId && tab.agentAttached) {
      return tab.sessionId;
    }

    // History / mirror tab: must session/load into agent serve before prompt
    if (tab.sessionId && !tab.agentAttached) {
      setStatus(`anexando sessão ${tab.sessionId.slice(0, 8)}…`);
      try {
        await withTimeout(
          client.loadSession(tab.sessionId, tab.cwd),
          20_000,
          "session/load"
        );
        try {
          await client.setModel(tab.sessionId, modelId, { reasoningEffort });
        } catch {
          /* optional */
        }
        latestTabsRef.current = latestTabsRef.current.map((t) =>
          t.id === tab.id
            ? {
                ...t,
                agentAttached: true,
                attachError: null,
                modelId,
                reasoningEffort,
              }
            : t
        );
        updateTab(tab.id, {
          agentAttached: true,
          attachError: null,
          modelId,
          reasoningEffort,
        });
        setStatus("online");
        return tab.sessionId;
      } catch (e) {
        const msg = e instanceof Error ? e.message : "session/load falhou";
        updateTab(tab.id, { agentAttached: false, attachError: msg });
        setStatus("online");
        throw new Error(
          `Não deu para anexar esta conversa no agent do grok-web (${msg}). ` +
            `Sessões abertas no TUI (outra sessão “ao vivo”) costumam ficar exclusivas. ` +
            `Feche-a no terminal ou use “Nova” para um chat novo neste browser.`
        );
      }
    }

    // Brand-new tab
    const res = await withTimeout(
      client.newSession(tab.cwd, { modelId, reasoningEffort }),
      20_000,
      "session/new"
    );
    // Reinforce model after create (some agents only honor set_model)
    try {
      await client.setModel(res.sessionId, modelId, { reasoningEffort });
    } catch {
      /* optional */
    }
    latestTabsRef.current = latestTabsRef.current.map((t) =>
      t.id === tab.id
        ? {
            ...t,
            sessionId: res.sessionId,
            agentAttached: true,
            attachError: null,
            modelId,
            reasoningEffort,
          }
        : t
    );
    updateTab(tab.id, {
      sessionId: res.sessionId,
      agentAttached: true,
      attachError: null,
      title: tab.title || "Sessão",
      modelId,
      reasoningEffort,
    });
    return res.sessionId;
  }

  function scrollChatToEnd() {
    requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }

  /** Persist transcript window so reopening a card is instant. */
  function rememberTabHistory(tabId: string) {
    const t = latestTabsRef.current.find((x) => x.id === tabId);
    if (t) cacheFromTabState(t);
  }

  async function attachAgentInBackground(
    tabId: string,
    sessionId: string,
    cwd: string
  ) {
    const client = clientRef.current;
    if (!client?.connected) {
      updateTab(tabId, {
        busy: false,
        agentAttached: false,
        attachError: "agent offline",
      });
      return;
    }
    try {
      setStatus(`retomando ${sessionId.slice(0, 8)}…`);
      await withTimeout(client.loadSession(sessionId, cwd), 20_000, "session/load");
      setStatus("online");
      updateTab(tabId, {
        busy: false,
        agentAttached: true,
        attachError: null,
      });
      latestTabsRef.current = latestTabsRef.current.map((t) =>
        t.id === tabId
          ? { ...t, busy: false, agentAttached: true, attachError: null }
          : t
      );
      void refreshSessionsOnly();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "erro";
      setStatus("online");
      const still = latestTabsRef.current.find((t) => t.id === tabId);
      updateTab(tabId, {
        busy: false,
        agentAttached: false,
        attachError: msg,
        messages: [
          ...(still?.messages || []),
          {
            id: uid(),
            role: "system",
            text:
              `Histórico em cache/disco OK (só leitura por enquanto).\n` +
              `session/load falhou: ${msg}\n\n` +
              `Comum se a sessão está aberta no TUI. Envie de novo para reanexar, ou use Nova.`,
          },
        ],
      });
    }
  }

  /**
   * Revalidate disk in background. If rev unchanged → zero work (server + client).
   * If changed → merge new tail without blanking the UI.
   */
  async function revalidateHistoryInBackground(tabId: string, sessionId: string) {
    const still0 = latestTabsRef.current.find((t) => t.id === tabId);
    const knownRev = still0?.historyRev;
    try {
      const params = new URLSearchParams({
        limit: String(HISTORY_PAGE),
        light: "1",
      });
      if (knownRev) params.set("rev", knownRev);

      const res = await fetch(
        `/api/sessions/${encodeURIComponent(sessionId)}?${params}`
      );
      if (!res.ok) return;
      const detail = (await res.json()) as {
        unchanged?: boolean;
        rev?: string;
        meta?: SessionRow;
        messages?: HistoryApiMsg[];
        total?: number;
        windowStart?: number;
        windowEnd?: number;
        hasMoreBefore?: boolean;
      };

      const still = latestTabsRef.current.find((t) => t.id === tabId);
      if (!still || still.sessionId !== sessionId) return;

      if (detail.unchanged) {
        // Cache is warm — nothing to do
        rememberTabHistory(tabId);
        return;
      }

      const tail = mapHistoryMessages(detail.messages);
      const tailStart = detail.windowStart ?? 0;
      const merged = mergeHistoryWindows(still.messages, tail, tailStart);
      const olderHist = still.messages.filter((m) => {
        const idx = histIndex(m);
        return idx != null && idx < tailStart;
      });
      const title = (detail.meta?.title || still.title || "Sessão").slice(0, 48);

      updateTab(tabId, {
        title,
        cwd: detail.meta?.cwd || still.cwd,
        messages: merged.length ? merged : still.messages,
        historyRev: detail.rev,
        liveActive: metaTurnLive(detail.meta),
        historyTotal: detail.total ?? still.historyTotal,
        historyWindowStart:
          olderHist.length > 0
            ? (histIndex(olderHist[0]) ?? detail.windowStart)
            : detail.windowStart,
        historyWindowEnd: detail.windowEnd ?? still.historyWindowEnd,
        historyHasMoreBefore:
          detail.windowStart != null
            ? detail.windowStart > 0
            : still.historyHasMoreBefore,
      });

      putCachedSession({
        sessionId,
        cwd: detail.meta?.cwd || still.cwd,
        title,
        rev: detail.rev,
        messages: merged.length ? merged : still.messages,
        historyTotal: detail.total,
        historyWindowStart: detail.windowStart,
        historyWindowEnd: detail.windowEnd,
        historyHasMoreBefore: Boolean(detail.hasMoreBefore),
        liveActive: metaTurnLive(detail.meta),
        savedAt: Date.now(),
      });
    } catch {
      /* ignore soft revalidate errors */
    }
  }

  async function openSessionFromHistory(s: SessionRow) {
    // 1) Tab already open → just focus (zero load)
    const existing = latestTabsRef.current.find((t) => t.sessionId === s.id);
    if (existing) {
      setActiveTabId(existing.id);
      stickToBottomRef.current = true;
      scrollChatToEnd();
      // Soft revalidate without spinner
      void revalidateHistoryInBackground(existing.id, s.id);
      return;
    }

    const cached = getCachedSession(s.id);
    const tabId = uid();
    stickToBottomRef.current = true;

    // 2) Cache hit → paint immediately, no empty "loading" state
    if (cached && cached.messages.length > 0) {
      setTabs((prev) => [
        ...prev,
        {
          id: tabId,
          title: (cached.title || s.title || "Sessão").slice(0, 48),
          sessionId: s.id,
          cwd: cached.cwd || s.cwd,
          messages: ensureUniqueMessageIds(cached.messages),
          busy: false, // chat usable instantly; attach agent in bg
          liveFollow: true,
          // Prefer turnLive from next poll; cache may still store stale "session open"
          liveActive: Boolean(cached.liveActive && s.turnLive),
          agentAttached: false,
          historyRev: cached.rev,
          historyTotal: cached.historyTotal,
          historyWindowStart: cached.historyWindowStart,
          historyWindowEnd: cached.historyWindowEnd,
          historyHasMoreBefore: Boolean(cached.historyHasMoreBefore),
          historyLoadingOlder: false,
        },
      ]);
      setActiveTabId(tabId);
      scrollChatToEnd();
      // Background: confirm rev + attach agent (doesn't blank the UI)
      void revalidateHistoryInBackground(tabId, s.id);
      void attachAgentInBackground(tabId, s.id, cached.cwd || s.cwd);
      return;
    }

    // 3) Cold open — fetch tail once, then cache it
    setTabs((prev) => [
      ...prev,
      {
        id: tabId,
        title: (s.title || "Sessão").slice(0, 48),
        sessionId: s.id,
        cwd: s.cwd,
        messages: [
          {
            id: uid(),
            role: "system",
            text: `Abrindo ${s.id.slice(0, 8)}…`,
          },
        ],
        busy: true,
        liveFollow: true,
        liveActive: Boolean(s.turnLive),
        agentAttached: false,
        historyLoadingOlder: false,
      },
    ]);
    setActiveTabId(tabId);

    let historyMessages: ChatMessage[] = [];
    let historyRev: string | undefined;
    let windowMeta: {
      total?: number;
      windowStart?: number;
      windowEnd?: number;
      hasMoreBefore?: boolean;
    } = {};
    let title = (s.title || "Sessão").slice(0, 48);
    let cwd = s.cwd;

    try {
      const res = await fetch(
        `/api/sessions/${encodeURIComponent(s.id)}?limit=${HISTORY_PAGE}&light=1`
      );
      const detail = (await res.json()) as {
        error?: string;
        meta?: SessionRow;
        messages?: HistoryApiMsg[];
        rev?: string;
        total?: number;
        windowStart?: number;
        windowEnd?: number;
        hasMoreBefore?: boolean;
      };
      if (!res.ok) throw new Error(detail.error || "falha ao ler sessão");
      historyRev = detail.rev;
      historyMessages = mapHistoryMessages(detail.messages);
      windowMeta = {
        total: detail.total,
        windowStart: detail.windowStart,
        windowEnd: detail.windowEnd,
        hasMoreBefore: detail.hasMoreBefore,
      };
      title = (detail.meta?.title || s.title || "Sessão").slice(0, 48);
      cwd = detail.meta?.cwd || s.cwd;

      updateTab(tabId, {
        title,
        cwd,
        messages:
          historyMessages.length > 0
            ? historyMessages
            : [
                {
                  id: uid(),
                  role: "system",
                  text: `Sessão ${s.id.slice(0, 8)} sem mensagens visíveis ainda.\nCWD: ${cwd}`,
                },
              ],
        busy: false,
        liveFollow: true,
        historyRev,
        liveActive: metaTurnLive(detail.meta) || Boolean(s.turnLive),
        historyTotal: windowMeta.total,
        historyWindowStart: windowMeta.windowStart,
        historyWindowEnd: windowMeta.windowEnd,
        historyHasMoreBefore: Boolean(windowMeta.hasMoreBefore),
        agentAttached: false,
      });
      scrollChatToEnd();

      putCachedSession({
        sessionId: s.id,
        cwd,
        title,
        rev: historyRev,
        messages: historyMessages,
        historyTotal: windowMeta.total,
        historyWindowStart: windowMeta.windowStart,
        historyWindowEnd: windowMeta.windowEnd,
        historyHasMoreBefore: Boolean(windowMeta.hasMoreBefore),
        liveActive: metaTurnLive(detail.meta),
        savedAt: Date.now(),
      });
    } catch (e) {
      updateTab(tabId, {
        busy: false,
        liveFollow: true,
        messages: [
          {
            id: uid(),
            role: "system",
            text: `Não foi possível ler o histórico: ${
              e instanceof Error ? e.message : "erro"
            }`,
          },
        ],
      });
      return;
    }

    void attachAgentInBackground(tabId, s.id, cwd);
  }

  function newTab(cwd = defaultCwd) {
    const id = uid();
    setTabs((prev) => [
      ...prev,
      {
        id,
        title: "Nova conversa",
        sessionId: null,
        cwd,
        messages: [],
        busy: false,
        liveFollow: false,
        agentAttached: false,
        modelId: selectedModelId,
        reasoningEffort: selectedEffort,
      },
    ]);
    setActiveTabId(id);
  }

  // When switching tabs, reflect that tab's model/effort in the composer pickers
  useEffect(() => {
    if (!activeTab) return;
    if (activeTab.modelId && activeTab.modelId !== selectedModelId) {
      setSelectedModelId(activeTab.modelId);
    }
    if (
      activeTab.reasoningEffort &&
      activeTab.reasoningEffort !== selectedEffort
    ) {
      setSelectedEffort(activeTab.reasoningEffort);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId]);

  function closeTab(id: string) {
    // Keep transcript in cache so reopening the card is instant
    rememberTabHistory(id);
    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== id);
      if (activeTabId === id) setActiveTabId(next[0]?.id || null);
      return next;
    });
  }

  function enqueuePrompt(
    tabId: string,
    text: string,
    imgs: ComposerImage[]
  ): void {
    const item: QueuedPrompt = {
      id: uid(),
      text,
      images: imgs,
      createdAt: Date.now(),
    };
    setTabs((prev) =>
      prev.map((t) =>
        t.id === tabId
          ? { ...t, outboundQueue: [...(t.outboundQueue || []), item] }
          : t
      )
    );
    setStatus("na fila — envia quando o Grok terminar");
  }

  function removeQueuedPrompt(tabId: string, itemId: string) {
    setTabs((prev) =>
      prev.map((t) =>
        t.id === tabId
          ? {
              ...t,
              outboundQueue: (t.outboundQueue || []).filter((q) => q.id !== itemId),
            }
          : t
      )
    );
    if (queueEditId === itemId) {
      setQueueEditId(null);
      setQueueEditText("");
    }
  }

  function saveQueuedPromptEdit(tabId: string, itemId: string, text: string) {
    const trimmed = text.trim();
    if (!trimmed) {
      removeQueuedPrompt(tabId, itemId);
      return;
    }
    setTabs((prev) =>
      prev.map((t) =>
        t.id === tabId
          ? {
              ...t,
              outboundQueue: (t.outboundQueue || []).map((q) =>
                q.id === itemId ? { ...q, text: trimmed } : q
              ),
            }
          : t
      )
    );
    setQueueEditId(null);
    setQueueEditText("");
  }

  /**
   * Actually send a prompt to the agent. Only call when the tab is free
   * (or about to own the turn). Does not touch the draft queue.
   */
  async function dispatchPrompt(
    tabId: string,
    text: string,
    attached: ComposerImage[]
  ): Promise<void> {
    const client = clientRef.current;
    if (!client?.connected) {
      setStatus("Agent offline — inicie com npm run web / bin/grok-web.mjs");
      return;
    }

    const tabSnap =
      latestTabsRef.current.find((t) => t.id === tabId) ||
      tabs.find((t) => t.id === tabId);
    if (!tabSnap) return;

    const userMsg: ChatMessage = {
      id: uid(),
      role: "user",
      text: text || "(imagem anexada)",
      images: attached.map((i) => ({ mimeType: i.mimeType, dataUrl: i.dataUrl })),
    };
    const assistantMsg: ChatMessage = {
      id: uid(),
      role: "assistant",
      text: "",
      thinking: "",
      toolCalls: [],
      pending: true,
    };

    const latest =
      latestTabsRef.current.find((t) => t.id === tabId) || tabSnap;

    updateTab(tabId, {
      busy: true,
      title:
        latest.title === "Nova conversa"
          ? text.slice(0, 36) || "Conversa"
          : latest.title,
      messages: [...latest.messages, userMsg, assistantMsg],
    });

    try {
      const sessionId = await ensureSession({
        ...latest,
        messages: [...latest.messages, userMsg, assistantMsg],
        busy: true,
      });

      const blocks: Array<
        | { type: "text"; text: string }
        | { type: "image"; data: string; mimeType: string }
      > = [];
      if (text) blocks.push({ type: "text", text });
      for (const img of attached) {
        blocks.push({ type: "image", data: img.data, mimeType: img.mimeType });
      }
      if (!text && attached.length) {
        blocks.unshift({
          type: "text",
          text: "[usuário enviou imagem(ns) via Grok Web]",
        });
      }

      await client.prompt(sessionId, blocks);
      patchLastAssistant(tabId, (m) => ({
        ...m,
        pending: false,
        toolCalls: (m.toolCalls || []).map((t) =>
          !t.status ||
          t.status === "running" ||
          t.status === "pending" ||
          t.status === "in_progress"
            ? { ...t, status: "completed" }
            : t
        ),
      }));
      updateTab(tabId, { busy: false, liveActive: false });
      refreshDiff(latest.cwd);
      refreshMeta();
    } catch (e) {
      patchLastAssistant(tabId, (m) => ({
        ...m,
        pending: false,
        text:
          (m.text || "") +
          `\n\n⚠️ ${e instanceof Error ? e.message : "erro ao enviar"}`,
      }));
      updateTab(tabId, { busy: false, liveActive: false });
    }
  }

  async function sendMessage() {
    if (!activeTab) return;
    const text = draft.trim();
    if (!text && images.length === 0) return;

    // Slash: local handlers first (new, model, effort, panels…)
    if (text.startsWith("/")) {
      const handled = await runSlashFromDraft(text);
      if (handled) return;
      // Non-local slash (/skill, /compact, …) → send as prompt to agent
    }

    const client = clientRef.current;
    if (!client?.connected) {
      setStatus("Agent offline — inicie com npm run web / bin/grok-web.mjs");
      return;
    }

    const attached = [...images];
    const tabId = activeTab.id;

    // Grok still working (this tab's turn OR live TUI turn) → queue, don't fake-send
    const latest =
      latestTabsRef.current.find((t) => t.id === tabId) || activeTab;
    if (tabIsOccupied(latest)) {
      enqueuePrompt(tabId, text, attached);
      setDraft("");
      setImages([]);
      return;
    }

    setDraft("");
    setImages([]);
    await dispatchPrompt(tabId, text, attached);
  }

  /** After a real turn ends, send the next queued prompt (FIFO). */
  async function flushOutboundQueue(tabId: string) {
    if (flushLockRef.current) return;
    // Lock before any await so React Strict Mode / re-effects can't double-send
    flushLockRef.current = true;
    try {
      const tab = latestTabsRef.current.find((t) => t.id === tabId);
      if (!tab || tabIsOccupied(tab)) return;
      const queue = tab.outboundQueue || [];
      if (!queue.length) return;

      const [next, ...rest] = queue;
      updateTab(tabId, { outboundQueue: rest });
      if (queueEditId === next.id) {
        setQueueEditId(null);
        setQueueEditText("");
      }
      await dispatchPrompt(tabId, next.text, next.images);
    } finally {
      flushLockRef.current = false;
    }
  }

  // Auto-flush queue when the agent becomes free (busy/liveActive both false)
  useEffect(() => {
    if (!activeTabId) return;
    const tab = tabs.find((t) => t.id === activeTabId);
    if (!tab) return;
    if (tabIsOccupied(tab)) return;
    if (!(tab.outboundQueue && tab.outboundQueue.length > 0)) return;
    if (flushLockRef.current) return;
    void flushOutboundQueue(tab.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeTabId,
    activeTab?.busy,
    activeTab?.liveActive,
    activeTab?.outboundQueue?.length,
  ]);

  function onPaste(e: ClipboardEvent) {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        e.preventDefault();
        const file = item.getAsFile();
        if (!file) continue;
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = String(reader.result || "");
          const base64 = dataUrl.split(",")[1] || "";
          setImages((prev) => [
            ...prev,
            { mimeType: file.type, dataUrl, data: base64 },
          ]);
        };
        reader.readAsDataURL(file);
      }
    }
  }

  function onFilePick(files: FileList | null) {
    if (!files) return;
    Array.from(files).forEach((file) => {
      if (!file.type.startsWith("image/")) return;
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = String(reader.result || "");
        const base64 = dataUrl.split(",")[1] || "";
        setImages((prev) => [
          ...prev,
          { mimeType: file.type, dataUrl, data: base64 },
        ]);
      };
      reader.readAsDataURL(file);
    });
  }



  return (
    <div className="app-shell">
      {/* Icon rail */}
      <nav className="app-rail" aria-label="Navegação">
        <button
          type="button"
          className="mb-2 flex h-10 w-10 items-center justify-center rounded-xl text-[var(--text)] transition hover:bg-[var(--bg-hover)] active:scale-95"
          title="Grok Web"
          onClick={() => newTab()}
        >
          <GrokMark size={26} state={activeTab?.busy ? "thinking" : "idle"} />
        </button>
        <button
          type="button"
          className={cn("app-rail-btn", leftPanel === "sessions" && "is-active")}
          title="Sessões"
          onClick={() => setLeftPanel("sessions")}
        >
          <Layers3 className="h-4 w-4" />
        </button>
        <button
          type="button"
          className={cn("app-rail-btn", leftPanel === "projects" && "is-active")}
          title="Projetos"
          onClick={() => setLeftPanel("projects")}
        >
          <FolderGit2 className="h-4 w-4" />
        </button>
        <div className="flex-1" />
        <button
          type="button"
          className={cn("app-rail-btn", inspectorOpen && "is-active")}
          title="Painel direito"
          onClick={() => setInspectorOpen((v) => !v)}
        >
          <PanelRight className="h-4 w-4" />
        </button>
        <button
          type="button"
          className="app-rail-btn"
          title={theme === "dark" ? "Modo claro" : "Modo escuro"}
          onClick={toggleTheme}
        >
          {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </button>
      </nav>

      <div
        className="app-workspace"
        style={inspectorOpen ? undefined : { gridTemplateColumns: "260px minmax(0, 1fr)" }}
      >
        {/* Sessions / projects column — Grok-like history list, same structure */}
        <aside className="app-sessions">
          <div className="flex items-center justify-between gap-2 px-3 pb-2 pt-3">
            <div className="min-w-0">
              <div className="text-[13px] font-semibold tracking-tight text-[var(--text)]">
                {leftPanel === "sessions" ? "Histórico" : "Projetos"}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-0.5">
              <button
                type="button"
                onClick={() =>
                  void (leftPanel === "sessions"
                    ? refreshSessionsOnly()
                    : refreshProjectsOnly())
                }
                className="app-rail-btn !h-8 !w-8"
                title="Atualizar"
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => newTab()}
                className="inline-flex h-8 items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--bg-soft)] px-2.5 text-[12px] font-medium text-[var(--text-secondary)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text)] active:scale-[0.98]"
                title="Novo bate-papo"
              >
                <MessageSquarePlus className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Novo</span>
              </button>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
            {leftPanel === "sessions" ? (
              sessions.length === 0 ? (
                <p className="px-2 py-6 text-center text-[12px] text-[var(--muted)]">
                  Nenhuma conversa ainda.
                </p>
              ) : (
                (() => {
                  const buckets: Record<
                    "today" | "yesterday" | "earlier",
                    SessionRow[]
                  > = { today: [], yesterday: [], earlier: [] };
                  for (const s of sessions) {
                    buckets[sessionDayBucket(s.updatedAt)].push(s);
                  }
                  const order: Array<"today" | "yesterday" | "earlier"> = [
                    "today",
                    "yesterday",
                    "earlier",
                  ];
                  return order.map((bucket) => {
                    const list = buckets[bucket];
                    if (!list.length) return null;
                    return (
                      <div key={bucket} className="mb-3">
                        <div className="history-day-label px-2.5 pb-1.5 pt-2">
                          {DAY_BUCKET_LABEL[bucket]}
                        </div>
                        <div className="flex flex-col gap-0.5">
                          {list.map((s) => {
                            const open = tabs.some((t) => t.sessionId === s.id);
                            const project = projectLabel(s.cwd);
                            const when = s.updatedAt
                              ? formatRelative(s.updatedAt)
                              : "";
                            return (
                              <button
                                key={s.id}
                                type="button"
                                onClick={() => openSessionFromHistory(s)}
                                className={cn(
                                  "history-item group w-full rounded-lg px-2.5 py-2 text-left transition active:scale-[0.995]",
                                  open
                                    ? "history-item--active"
                                    : "hover:bg-[var(--bg-hover)]"
                                )}
                              >
                                <div className="flex min-w-0 items-center gap-2">
                                  {s.active ? (
                                    <span
                                      className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--ok)] pulse-dot"
                                      title="Ativo"
                                    />
                                  ) : null}
                                  <span className="history-item-title truncate">
                                    {s.title || "Conversa"}
                                  </span>
                                </div>
                                <div className="history-item-meta mt-1 flex min-w-0 items-center gap-1.5 pl-0">
                                  <span className="history-item-project truncate">
                                    {project}
                                  </span>
                                  {when ? (
                                    <span className="history-item-when shrink-0">
                                      {when}
                                    </span>
                                  ) : null}
                                  {s.active ? (
                                    <span className="history-item-status shrink-0 text-[var(--ok)]">
                                      Ativo
                                    </span>
                                  ) : null}
                                </div>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    );
                  });
                })()
              )
            ) : projects.length === 0 ? (
              <p className="px-2 py-6 text-center text-[12px] text-[var(--muted)]">
                Nenhum projeto encontrado.
              </p>
            ) : (
              (() => {
                const activeCwd = normPath(activeTab?.cwd || defaultCwd);
                const sorted = [...projects].sort((a, b) =>
                  a.name.localeCompare(b.name, "pt-BR", { sensitivity: "base" })
                );
                return (
                  <div className="mb-3">
                    <div className="history-day-label px-2.5 pb-1.5 pt-2">
                      Todos
                    </div>
                    <div className="flex flex-col gap-0.5">
                      {sorted.map((p) => {
                        const root = normPath(p.path);
                        const isActive = activeCwd === root;
                        const isOpen = tabs.some(
                          (t) => normPath(t.cwd || "") === root
                        );
                        let latestAt: string | null = null;
                        for (const s of sessions) {
                          const c = normPath(s.cwd || "");
                          if (c !== root && !c.startsWith(`${root}/`)) continue;
                          if (!s.updatedAt) continue;
                          if (
                            !latestAt ||
                            Date.parse(s.updatedAt) > Date.parse(latestAt)
                          ) {
                            latestAt = s.updatedAt;
                          }
                        }
                        const when = latestAt ? formatRelative(latestAt) : "";
                        return (
                          <button
                            key={p.path}
                            type="button"
                            onClick={() => newTab(p.path)}
                            className={cn(
                              "history-item group w-full rounded-lg px-2.5 py-2 text-left transition active:scale-[0.995]",
                              isOpen || isActive
                                ? "history-item--active"
                                : "hover:bg-[var(--bg-hover)]"
                            )}
                          >
                            <div className="flex min-w-0 items-center gap-2">
                              {isActive ? (
                                <span
                                  className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--ok)] pulse-dot"
                                  title="Ativo"
                                />
                              ) : null}
                              <span className="history-item-title truncate">
                                {p.name}
                              </span>
                            </div>
                            <div className="history-item-meta mt-1 flex min-w-0 items-center gap-1.5 pl-0">
                              <span className="history-item-project truncate">
                                {shortHome(p.path)}
                              </span>
                              {when ? (
                                <span className="history-item-when shrink-0">
                                  {when}
                                </span>
                              ) : null}
                              {p.hasGit ? (
                                <span
                                  className="history-item-when shrink-0"
                                  title="Repositório git"
                                >
                                  git
                                </span>
                              ) : null}
                              {isActive ? (
                                <span className="history-item-status shrink-0 text-[var(--ok)]">
                                  Ativo
                                </span>
                              ) : null}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })()
            )}
          </div>
        </aside>

        {/* Main chat column */}
        <main className="app-main">
          <header className="app-topbar">
            <div className="flex min-w-0 items-center gap-3">
              <GrokWordmark
                height={16}
                className="hidden shrink-0 sm:inline-flex"
                state={activeTab?.busy ? "thinking" : "idle"}
              />
              <div className="min-w-0">
                <div className="truncate text-[13px] font-semibold">
                  {activeTab?.title || "Grok Web"}
                </div>
                <div className="truncate font-mono text-[11px] text-[var(--muted)]">
                  {(activeTab?.cwd || defaultCwd).replace(/\/home\/[^/]+/, "~")}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px]",
                  connected
                    ? "border-[color-mix(in_srgb,var(--ok)_35%,transparent)] text-[var(--ok)]"
                    : "border-[color-mix(in_srgb,var(--warning)_35%,transparent)] text-[var(--warning)]"
                )}
              >
                <span
                  className={cn(
                    "h-1.5 w-1.5 rounded-full",
                    connected ? "bg-[var(--ok)] pulse-dot" : "bg-[var(--warning)]"
                  )}
                />
                {status}
              </span>
            </div>
          </header>

          {/* Tabs */}
          <div className="flex items-center gap-1 overflow-x-auto border-b border-[var(--border)] px-2 py-1.5">
            {tabs.map((t) => (
              <div
                key={t.id}
                className={cn(
                  "group flex max-w-[220px] items-center gap-1 rounded-lg px-2 py-1.5 text-xs transition",
                  t.id === activeTabId
                    ? "bg-[var(--bg-soft)] text-[var(--text)]"
                    : "text-[var(--muted)] hover:bg-[var(--bg-hover)]"
                )}
              >
                <button type="button" className="truncate" onClick={() => setActiveTabId(t.id)}>
                  {t.busy ? (
                    <OrbitMark size={12} state="thinking" className="mr-1 inline-flex" />
                  ) : null}
                  {t.liveFollow && t.liveActive ? (
                    <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-[var(--ok)]" />
                  ) : t.liveFollow ? (
                    <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-[var(--muted)]" />
                  ) : null}
                  {t.title}
                </button>
                <button
                  type="button"
                  className="rounded p-0.5 opacity-40 transition hover:bg-[var(--bg-active)] hover:opacity-100"
                  onClick={() => closeTab(t.id)}
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() => newTab()}
              className="rounded-lg px-2 py-1.5 text-[var(--muted)] transition hover:bg-[var(--bg-hover)] active:scale-95"
              title="Nova aba"
            >
              <MessageSquarePlus className="h-4 w-4" />
            </button>
          </div>

          <div
            ref={scrollRef}
            onScroll={onChatScroll}
            className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-6 md:px-10"
          >
            {activeTab?.historyLoadingOlder ? (
              <div className="mx-auto flex max-w-[42rem] items-center justify-center gap-2 py-2 text-[11px] text-[var(--muted)]">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Carregando mensagens anteriores…
              </div>
            ) : activeTab?.historyHasMoreBefore ? (
              <div className="mx-auto max-w-[42rem] text-center text-[11px] text-[var(--muted)]">
                Role para cima para carregar mais
                {activeTab.historyTotal != null && activeTab.historyWindowStart != null
                  ? ` · ${activeTab.historyWindowStart} de ${activeTab.historyTotal} ocultas`
                  : ""}
              </div>
            ) : activeTab?.liveFollow && (activeTab.historyTotal ?? 0) > 0 ? (
              <div className="mx-auto max-w-[42rem] text-center text-[11px] text-[var(--muted)]">
                Início da conversa
              </div>
            ) : null}

            {!agentReady ? (
              <div className="mx-auto max-w-xl rounded-2xl border border-[color-mix(in_srgb,var(--warning)_30%,transparent)] bg-[color-mix(in_srgb,var(--warning)_10%,transparent)] p-5 text-sm">
                <p className="font-semibold">Agent ainda não está no ar</p>
                <p className="mt-2 text-[var(--text-secondary)]">No terminal, rode:</p>
                <pre className="mt-3 overflow-x-auto rounded-xl border border-[var(--border)] bg-[var(--bg-soft)] p-3 font-mono text-xs">
                  cd ~/projetos/grok-web && npm run web
                </pre>
              </div>
            ) : null}

            {activeTab?.liveFollow ? (
              <div className="mx-auto flex max-w-[42rem] items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--bg-soft)]/80 px-3 py-1.5 text-[11px] text-[var(--text-secondary)] backdrop-blur">
                <OrbitMark size={14} state={activeTab.liveActive ? "thinking" : "idle"} />
                {activeTab.liveActive
                  ? "Espelho ao vivo — TUI ↔ web"
                  : "Espelho do disco"}
              </div>
            ) : null}

            {activeTab?.messages.map((m, i) => (
              <MessageBubble
                key={m.historyIndex != null ? `h-${m.historyIndex}` : m.id}
                message={m}
                index={i}
              />
            ))}
          </div>

          <div className="composer-dock">
            {images.length > 0 ? (
              <div className="mx-auto mb-3 flex max-w-[42rem] flex-wrap gap-2">
                {images.map((img, i) => (
                  <div
                    key={i}
                    className="relative h-16 w-16 overflow-hidden rounded-xl border border-[var(--border)]"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={img.dataUrl} alt="" className="h-full w-full object-cover" />
                    <button
                      type="button"
                      className="absolute right-0.5 top-0.5 rounded-md bg-black/60 p-0.5 text-white"
                      onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
            {activeTab?.liveFollow && activeTab.agentAttached === false ? (
              <div className="mx-auto mb-2 max-w-[42rem] rounded-xl border border-[color-mix(in_srgb,var(--warning)_35%,transparent)] bg-[color-mix(in_srgb,var(--warning)_10%,transparent)] px-3 py-2 text-[11px] text-[var(--text-secondary)]">
                Sessão do histórico ainda <strong className="text-[var(--text)]">não anexada</strong> no
                agent do browser
                {activeTab.attachError ? ` (${activeTab.attachError})` : ""}. Enviar tenta
                reanexar; se falhar, use <strong className="text-[var(--text)]">Nova</strong> para um
                chat que responde de verdade.
              </div>
            ) : null}

            {(activeTab?.outboundQueue?.length ?? 0) > 0 ? (
              <div className="prompt-queue mx-auto mb-2 max-w-[42rem]">
                <div className="prompt-queue-label">
                  Na fila
                  {tabIsOccupied(activeTab)
                    ? " · envia quando o Grok terminar"
                    : " · enviando…"}
                  <span className="prompt-queue-count">
                    {activeTab!.outboundQueue!.length}
                  </span>
                </div>
                <ul className="prompt-queue-list">
                  {activeTab!.outboundQueue!.map((item, idx) => {
                    const editing = queueEditId === item.id;
                    return (
                      <li key={item.id} className="prompt-queue-item">
                        <span className="prompt-queue-ord" aria-hidden>
                          {idx + 1}
                        </span>
                        {editing ? (
                          <div className="prompt-queue-edit">
                            <textarea
                              value={queueEditText}
                              onChange={(e) => setQueueEditText(e.target.value)}
                              rows={2}
                              className="prompt-queue-textarea"
                              autoFocus
                              onKeyDown={(e) => {
                                if (e.key === "Enter" && !e.shiftKey) {
                                  e.preventDefault();
                                  saveQueuedPromptEdit(
                                    activeTab!.id,
                                    item.id,
                                    queueEditText
                                  );
                                }
                                if (e.key === "Escape") {
                                  setQueueEditId(null);
                                  setQueueEditText("");
                                }
                              }}
                            />
                            <div className="prompt-queue-edit-actions">
                              <button
                                type="button"
                                className="prompt-queue-btn prompt-queue-btn--primary"
                                onClick={() =>
                                  saveQueuedPromptEdit(
                                    activeTab!.id,
                                    item.id,
                                    queueEditText
                                  )
                                }
                              >
                                Salvar
                              </button>
                              <button
                                type="button"
                                className="prompt-queue-btn"
                                onClick={() => {
                                  setQueueEditId(null);
                                  setQueueEditText("");
                                }}
                              >
                                Cancelar
                              </button>
                            </div>
                          </div>
                        ) : (
                          <>
                            <div className="prompt-queue-body">
                              <p className="prompt-queue-text">
                                {item.text || "(imagem anexada)"}
                              </p>
                              {item.images.length > 0 ? (
                                <span className="prompt-queue-meta">
                                  {item.images.length} imagem
                                  {item.images.length > 1 ? "ns" : ""}
                                </span>
                              ) : null}
                            </div>
                            <div className="prompt-queue-actions">
                              <button
                                type="button"
                                className="prompt-queue-icon-btn"
                                title="Editar"
                                onClick={() => {
                                  setQueueEditId(item.id);
                                  setQueueEditText(item.text);
                                }}
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </button>
                              <button
                                type="button"
                                className="prompt-queue-icon-btn prompt-queue-icon-btn--danger"
                                title="Excluir"
                                onClick={() =>
                                  removeQueuedPrompt(activeTab!.id, item.id)
                                }
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          </>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : null}

            <div
              className={cn(
                "composer-box composer-box--slash mx-auto max-w-[42rem] p-2",
                slashMenuOpen && "is-slash-open",
                slashArmed && "is-slash-armed",
                slashArmed?.source === "skill" && "is-slash-skill",
                slashArmed?.source === "web" && "is-slash-web",
                slashArmed?.source === "builtin" && "is-slash-builtin"
              )}
            >
                <SlashMenu
                  open={slashMenuOpen}
                  items={slashItems}
                  activeIndex={Math.min(
                    slashIndex,
                    Math.max(0, slashItems.length - 1)
                  )}
                  onActiveIndexChange={setSlashIndex}
                  onPick={pickSlashCommand}
                  query={slashParse.filter}
                />
                {slashChipCmd ? (
                  <SlashArmedChip
                    cmd={slashChipCmd}
                    args={
                      slashArmed && slashParse.hasArgs
                        ? slashParse.args
                        : undefined
                    }
                    picking={slashChipPicking}
                    onClear={
                      slashArmed
                        ? () => {
                            setDraft("");
                          }
                        : undefined
                    }
                  />
                ) : null}
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onPaste={onPaste}
                  onKeyDown={(e) => {
                    if (slashMenuOpen && slashItems.length) {
                      if (e.key === "ArrowDown") {
                        e.preventDefault();
                        setSlashIndex((i) =>
                          i + 1 >= slashItems.length ? 0 : i + 1
                        );
                        return;
                      }
                      if (e.key === "ArrowUp") {
                        e.preventDefault();
                        setSlashIndex((i) =>
                          i - 1 < 0 ? slashItems.length - 1 : i - 1
                        );
                        return;
                      }
                      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
                        e.preventDefault();
                        const cmd =
                          slashItems[
                            Math.min(slashIndex, slashItems.length - 1)
                          ];
                        if (cmd) pickSlashCommand(cmd);
                        return;
                      }
                      if (e.key === "Escape") {
                        e.preventDefault();
                        setDraft("");
                        return;
                      }
                    }
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void sendMessage();
                    }
                  }}
                  rows={3}
                  placeholder={
                    slashArmed
                      ? slashArmed.argumentHint
                        ? `Args para ${slashArmed.command}… (Enter envia)`
                        : `${slashArmed.command} selecionado · Enter executa`
                      : tabIsOccupied(activeTab)
                        ? "Grok ocupado — Enter coloca na fila…"
                        : "Pergunte ao Grok… (/ comandos · Enter envia · Shift+Enter quebra)"
                  }
                  className={cn(
                    "w-full resize-none bg-transparent px-3 py-2 text-sm outline-none placeholder:text-[var(--muted)]",
                    slashArmed && "slash-textarea-armed"
                  )}
                />
                <div className="flex flex-wrap items-center justify-between gap-2 px-1 pb-0.5">
                  <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                    <label className="inline-flex cursor-pointer items-center gap-1 rounded-lg px-2 py-1.5 text-xs text-[var(--muted)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text)]">
                      <ImagePlus className="h-3.5 w-3.5" />
                      <span className="hidden sm:inline">Imagem</span>
                      <input
                        type="file"
                        accept="image/*"
                        className="hidden"
                        multiple
                        onChange={(e) => onFilePick(e.target.files)}
                      />
                    </label>

                    <div className="composer-model-pickers">
                      {modelCatalog.length > 1 ? (
                        <label className="composer-select-wrap" title="Modelo">
                          <span className="composer-select-label">Modelo</span>
                          <select
                            className="composer-select"
                            value={selectedModelId}
                            disabled={modelSwitching || !modelCatalog.length}
                            onChange={(e) => void onSelectModel(e.target.value)}
                          >
                            {modelCatalog.map((m) => (
                              <option key={m.id} value={m.id}>
                                {m.name || m.id}
                              </option>
                            ))}
                          </select>
                        </label>
                      ) : (
                        <div
                          className="composer-select-wrap composer-select-wrap--static"
                          title="Modelo"
                        >
                          <span className="composer-select-label">Modelo</span>
                          <span className="composer-select-value">
                            {activeModel?.name || selectedModelId}
                          </span>
                        </div>
                      )}
                      {showEffort ? (
                        <ComposerCombo
                          label="Nível"
                          title="Nível de reasoning / effort"
                          value={selectedEffort}
                          disabled={modelSwitching}
                          options={effortOptions.map((e) => ({
                            value: e.value,
                            label: e.label || e.value,
                            description: e.description,
                          }))}
                          onChange={(v) => void onSelectEffort(v)}
                        />
                      ) : null}
                      {modelSwitching ? (
                        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-[var(--muted)]" />
                      ) : null}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <UsageFooterStrip
                      usage={usage}
                      loading={usageLoading}
                      workStatus={workStatus}
                      onClick={openUsagePanel}
                    />
                    {activeTab?.busy ? (
                      <button
                        type="button"
                        onClick={() =>
                          activeTab.sessionId &&
                          clientRef.current?.cancel(activeTab.sessionId)
                        }
                        className="inline-flex items-center gap-1 rounded-full border border-[var(--border)] px-3 py-1.5 text-xs transition hover:bg-[var(--bg-hover)] active:scale-95"
                      >
                        <Square className="h-3.5 w-3.5" />
                        Parar
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => void sendMessage()}
                      disabled={
                        !connected || (!draft.trim() && images.length === 0)
                      }
                      className={cn(
                        "inline-flex h-9 w-9 items-center justify-center rounded-full transition active:scale-95 disabled:opacity-40",
                        tabIsOccupied(activeTab)
                          ? "bg-[var(--accent-soft)] text-[var(--text)] hover:opacity-90"
                          : "bg-[var(--text)] text-[var(--bg)] hover:opacity-90"
                      )}
                      title={
                        tabIsOccupied(activeTab)
                          ? "Enfileirar (envia quando o Grok terminar)"
                          : "Enviar"
                      }
                    >
                      {activeTab?.busy && !(activeTab.outboundQueue?.length) ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Send className="h-4 w-4" />
                      )}
                    </button>
                  </div>
                </div>
              </div>
            </div>
        </main>

        {/* Inspector */}
        {inspectorOpen ? (
          <aside className="app-inspector">
            <div className="flex gap-1 border-b border-[var(--border)] p-2">
              <SideTab
                active={inspector === "usage"}
                onClick={() => setInspector("usage")}
                icon={<Gauge className="h-3.5 w-3.5" />}
                label="Uso"
              />
              <SideTab
                active={inspector === "diff"}
                onClick={() => setInspector("diff")}
                icon={<GitBranch className="h-3.5 w-3.5" />}
                label="Arquivos"
              />
              <SideTab
                active={inspector === "mcp"}
                onClick={() => setInspector("mcp")}
                icon={<Plug className="h-3.5 w-3.5" />}
                label="MCP/Skills"
              />
              <SideTab
                active={inspector === "session"}
                onClick={() => setInspector("session")}
                icon={<Terminal className="h-3.5 w-3.5" />}
                label="Sessão"
              />
            </div>
            <div className="min-h-0 flex-1 overflow-hidden p-3 text-sm">
              {inspector === "usage" ? (
                <div className="h-full overflow-y-auto">
                  <UsagePanel
                    usage={usage}
                    recent={usageRecent}
                    note={usageNote}
                    account={usageAccount}
                    workStatus={workStatus}
                    billingUrl={usageBillingUrl}
                    loading={usageLoading}
                    onRefresh={() =>
                      void refreshUsage(activeTab?.sessionId, { full: true })
                    }
                  />
                </div>
              ) : null}
              {inspector === "diff" ? (
                <FileWorkbench
                  cwd={activeTab?.cwd || defaultCwd}
                  seedFiles={diffFiles}
                  branchHint={diffBranch}
                  onSaved={() => {
                    const c = activeTab?.cwd || defaultCwd;
                    void refreshDiff(c);
                  }}
                />
              ) : null}
              {inspector === "mcp" ? (
                <McpSkillsPanel cwd={activeTab?.cwd} liveMcp={liveMcp} />
              ) : null}
              {inspector === "session" ? (
                <div className="space-y-3 overflow-y-auto text-[13px]">
                  <Row label="Tab" value={activeTab?.title || "—"} />
                  <Row label="Session ID" value={activeTab?.sessionId || "(ainda não criada)"} mono />
                  <Row label="CWD" value={activeTab?.cwd || "—"} mono />
                  <Row label="Mensagens" value={String(activeTab?.messages.length || 0)} />
                  <Row label="Agent WS" value={connected ? "conectado" : "offline"} />
                  <Row
                    label="Agent anexado"
                    value={
                      activeTab?.agentAttached
                        ? "sim"
                        : activeTab?.sessionId
                          ? "não (só histórico)"
                          : "—"
                    }
                  />
                  <Row label="Espelho" value={activeTab?.liveFollow ? "sim" : "não"} />
                  {activeTab?.attachError ? (
                    <Row label="Erro attach" value={activeTab.attachError} />
                  ) : null}
                </div>
              ) : null}
            </div>
          </aside>
        ) : null}
      </div>
    </div>
  );
}

function SideTab({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex flex-1 items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-[11px] font-medium transition active:scale-[0.97]",
        active
          ? "bg-[var(--bg-soft)] text-[var(--text)]"
          : "text-[var(--muted)] hover:bg-[var(--bg-hover)]"
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-[0.14em] text-[var(--muted)]">{label}</div>
      <div className={cn("mt-0.5 break-all text-[var(--text)]", mono && "font-mono text-[11px]")}>
        {value}
      </div>
    </div>
  );
}

