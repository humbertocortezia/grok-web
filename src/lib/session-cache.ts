/**
 * Client-side cache for conversation windows.
 * Opening a history card should feel instant — we hydrate from here and
 * only re-fetch when the disk rev (mtime:size) changed.
 */

import type { ChatMessage } from "@/lib/acp-client";

export type CachedSessionWindow = {
  sessionId: string;
  cwd: string;
  title: string;
  rev?: string;
  messages: ChatMessage[];
  historyTotal?: number;
  historyWindowStart?: number;
  historyWindowEnd?: number;
  historyHasMoreBefore?: boolean;
  liveActive?: boolean;
  savedAt: number;
};

const mem = new Map<string, CachedSessionWindow>();
const MAX_ENTRIES = 40;
const STORAGE_KEY = "grok-web-session-cache-v1";
const MAX_MESSAGES_PERSIST = 48;

let storageHydrated = false;

function trimMap() {
  while (mem.size > MAX_ENTRIES) {
    // Drop oldest by savedAt
    let oldestKey: string | null = null;
    let oldestAt = Infinity;
    for (const [k, v] of mem) {
      if (v.savedAt < oldestAt) {
        oldestAt = v.savedAt;
        oldestKey = k;
      }
    }
    if (oldestKey) mem.delete(oldestKey);
    else break;
  }
}

function persist() {
  if (typeof window === "undefined") return;
  try {
    const payload = Array.from(mem.values())
      .sort((a, b) => b.savedAt - a.savedAt)
      .slice(0, 20)
      .map((c) => ({
        ...c,
        // Cap size for sessionStorage
        messages: c.messages.slice(-MAX_MESSAGES_PERSIST).map((m) => ({
          id: m.id,
          role: m.role,
          text: typeof m.text === "string" ? m.text.slice(0, 8000) : "",
          thinking:
            typeof m.thinking === "string" ? m.thinking.slice(0, 4000) : m.thinking,
          // Keep disk identity so reopen + live merge don't re-duplicate keys
          historyIndex: m.historyIndex,
          // Drop heavy tool outputs in persisted form — still ok for instant paint
          toolCalls: m.toolCalls?.slice(0, 12).map((t) => ({
            id: t.id,
            title: t.title,
            kind: t.kind,
            status: t.status,
            input: t.input,
            output:
              typeof t.output === "string" ? t.output.slice(0, 400) : t.output,
          })),
          pending: false,
        })),
      }));
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    /* quota / private mode */
  }
}

function hydrateFromStorage() {
  if (storageHydrated || typeof window === "undefined") return;
  storageHydrated = true;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const list = JSON.parse(raw) as CachedSessionWindow[];
    if (!Array.isArray(list)) return;
    for (const item of list) {
      if (item?.sessionId && Array.isArray(item.messages)) {
        mem.set(item.sessionId, item);
      }
    }
  } catch {
    /* ignore */
  }
}

export function getCachedSession(sessionId: string): CachedSessionWindow | null {
  hydrateFromStorage();
  return mem.get(sessionId) || null;
}

export function putCachedSession(entry: CachedSessionWindow): void {
  hydrateFromStorage();
  mem.set(entry.sessionId, { ...entry, savedAt: Date.now() });
  trimMap();
  persist();
}

export function patchCachedSession(
  sessionId: string,
  patch: Partial<CachedSessionWindow>
): void {
  const cur = getCachedSession(sessionId);
  if (!cur) return;
  putCachedSession({ ...cur, ...patch, sessionId, savedAt: Date.now() });
}

/** Call when a history tab updates so reopen is free. */
export function cacheFromTabState(tab: {
  sessionId: string | null;
  cwd: string;
  title: string;
  messages: ChatMessage[];
  historyRev?: string;
  historyTotal?: number;
  historyWindowStart?: number;
  historyWindowEnd?: number;
  historyHasMoreBefore?: boolean;
  liveActive?: boolean;
  liveFollow?: boolean;
}): void {
  if (!tab.sessionId || !tab.liveFollow) return;
  if (!tab.messages.length) return;
  putCachedSession({
    sessionId: tab.sessionId,
    cwd: tab.cwd,
    title: tab.title,
    rev: tab.historyRev,
    messages: tab.messages,
    historyTotal: tab.historyTotal,
    historyWindowStart: tab.historyWindowStart,
    historyWindowEnd: tab.historyWindowEnd,
    historyHasMoreBefore: tab.historyHasMoreBefore,
    liveActive: tab.liveActive,
    savedAt: Date.now(),
  });
}
