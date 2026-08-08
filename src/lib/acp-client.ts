export type AcpContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  text: string;
  thinking?: string;
  toolCalls?: ToolCallView[];
  images?: { mimeType: string; dataUrl: string }[];
  pending?: boolean;
  /** Stable disk history index (survives React-key id rewrites). */
  historyIndex?: number;
};

export type ToolCallView = {
  id: string;
  title: string;
  kind?: string;
  status?: string;
  input?: unknown;
  output?: string;
};

type JsonRpcId = number | string;

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
};

export type AcpClientEvents = {
  onOpen?: () => void;
  onClose?: () => void;
  onError?: (err: Error) => void;
  onNotification?: (method: string, params: unknown) => void;
  onSessionUpdate?: (sessionId: string, update: Record<string, unknown>) => void;
  onMcpServers?: (servers: unknown[]) => void;
  onClientRequest?: (method: string, params: unknown) => void;
  onTurnEnd?: (sessionId: string, result: unknown) => void;
};

/**
 * ACP WebSocket client for Grok agent serve.
 * Handles:
 * - outbound requests (initialize, session/new, session/prompt, …)
 * - inbound notifications (session/update, …)
 * - inbound requests FROM agent (fs/read_text_file, session/request_permission, …)
 *   — without these, tools hang forever on "running".
 */
export class AcpClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<string, Pending>();
  private events: AcpClientEvents;
  private autoApprove = true;

  constructor(events: AcpClientEvents = {}) {
    this.events = events;
  }

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  setAutoApprove(value: boolean) {
    this.autoApprove = value;
  }

  connect(url: string) {
    if (this.ws) this.disconnect();
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => this.events.onOpen?.();
    ws.onerror = () => this.events.onError?.(new Error("WebSocket error"));
    ws.onclose = () => this.events.onClose?.();
    ws.onmessage = (ev) => {
      void this.handleMessage(String(ev.data));
    };
  }

  disconnect() {
    this.ws?.close();
    this.ws = null;
    for (const [, p] of this.pending) p.reject(new Error("disconnected"));
    this.pending.clear();
  }

  private key(id: JsonRpcId) {
    return String(id);
  }

  private async handleMessage(raw: string) {
    let msg: {
      jsonrpc?: string;
      id?: JsonRpcId;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: { message?: string; code?: number; data?: unknown };
    };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    // Response to our request
    if (msg.id != null && msg.method == null && (msg.result !== undefined || msg.error)) {
      const p = this.pending.get(this.key(msg.id));
      if (!p) return;
      this.pending.delete(this.key(msg.id));
      if (msg.error) p.reject(new Error(msg.error.message || "ACP error"));
      else p.resolve(msg.result);
      return;
    }

    // Request FROM agent → client (must reply or tools hang)
    if (msg.id != null && msg.method) {
      this.events.onClientRequest?.(msg.method, msg.params);
      try {
        const result = await this.dispatchAgentRequest(msg.method, msg.params);
        this.send({ jsonrpc: "2.0", id: msg.id, result });
      } catch (e) {
        this.send({
          jsonrpc: "2.0",
          id: msg.id,
          error: {
            code: -32000,
            message: e instanceof Error ? e.message : "client request failed",
          },
        });
      }
      return;
    }

    // Notification (no id)
    if (msg.method) {
      this.events.onNotification?.(msg.method, msg.params);

      if (
        msg.method === "session/update" ||
        msg.method === "_x.ai/session/update" ||
        msg.method === "_x.ai/session_notification"
      ) {
        const params = msg.params as {
          sessionId?: string;
          update?: Record<string, unknown>;
        };
        if (params?.sessionId && params.update) {
          this.events.onSessionUpdate?.(params.sessionId, params.update);
        }
      }

      if (msg.method === "_x.ai/mcp/servers_updated") {
        const params = msg.params as { mcpServers?: unknown[] };
        this.events.onMcpServers?.(params?.mcpServers || []);
      }
    }
  }

  private async dispatchAgentRequest(method: string, params: unknown): Promise<unknown> {
    const p = (params || {}) as Record<string, unknown>;

    // Permission prompts — auto-allow in web MVP (agent also started with --always-approve)
    if (
      method === "session/request_permission" ||
      method === "request_permission" ||
      method.endsWith("/request_permission")
    ) {
      // ACP shape varies; common is { options: [{ optionId }] }
      const options = (p.options as Array<{ optionId?: string; id?: string }>) || [];
      const allow =
        options.find((o) => /allow|approve|yes|accept/i.test(String(o.optionId || o.id || ""))) ||
        options[0];
      return {
        outcome: {
          outcome: "selected",
          optionId: allow?.optionId || allow?.id || "allow-once",
        },
      };
    }

    if (method === "fs/read_text_file" || method === "fs/readTextFile") {
      const filePath = String(p.path || "");
      const line = typeof p.line === "number" ? p.line : undefined;
      const limit = typeof p.limit === "number" ? p.limit : undefined;
      const res = await fetch("/api/fs/read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: filePath, line, limit }),
      });
      const data = (await res.json()) as { content?: string; error?: string };
      if (!res.ok) throw new Error(data.error || `read failed: ${filePath}`);
      return { content: data.content ?? "" };
    }

    if (method === "fs/write_text_file" || method === "fs/writeTextFile") {
      const filePath = String(p.path || "");
      const content = String(p.content ?? "");
      const res = await fetch("/api/fs/write", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: filePath, content }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error || `write failed: ${filePath}`);
      return {};
    }

    // Terminal APIs — stub so agent doesn't hang if it probes them
    if (method === "terminal/create") {
      return {
        terminalId: `stub-${Date.now()}`,
        error: "terminal not implemented in grok-web yet",
      };
    }
    if (
      method === "terminal/output" ||
      method === "terminal/release" ||
      method === "terminal/wait_for_exit" ||
      method === "terminal/kill"
    ) {
      return { output: "", exitCode: 1, exitStatus: { exitCode: 1 } };
    }

    // Elicitation — empty decline
    if (method === "elicitation/create") {
      return { action: "cancel" };
    }

    console.warn("[acp] unhandled agent request:", method, p);
    // Don't hang forever: return empty result for unknown methods
    return {};
  }

  private send(payload: unknown) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(payload));
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("ACP not connected"));
    }
    const id = this.nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };
    return new Promise<T>((resolve, reject) => {
      this.pending.set(this.key(id), {
        resolve: (v) => resolve(v as T),
        reject,
      });
      this.send(payload);
    });
  }

  notify(method: string, params?: unknown) {
    this.send({ jsonrpc: "2.0", method, params });
  }

  async initialize() {
    return this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        // Don't claim full terminal until implemented — reduces hang risk
        terminal: false,
      },
      clientInfo: { name: "grok-web", version: "0.1.1" },
    });
  }

  async newSession(
    cwd: string,
    opts?: { modelId?: string; reasoningEffort?: string }
  ) {
    const meta: Record<string, unknown> = { yoloMode: true };
    if (opts?.modelId) meta.modelId = opts.modelId;
    if (opts?.reasoningEffort) meta.reasoningEffort = opts.reasoningEffort;
    return this.request<{
      sessionId: string;
      models?: { currentModelId?: string; availableModels?: unknown[] };
    }>("session/new", {
      cwd,
      mcpServers: [],
      _meta: meta,
    });
  }

  async loadSession(sessionId: string, cwd: string) {
    return this.request("session/load", {
      sessionId,
      cwd,
      mcpServers: [],
    });
  }

  /**
   * Switch model / reasoning effort for an existing session.
   * Effort is passed via _meta.reasoningEffort (Grok extension).
   */
  async setModel(
    sessionId: string,
    modelId: string,
    opts?: { reasoningEffort?: string }
  ) {
    const params: Record<string, unknown> = {
      sessionId,
      modelId,
    };
    if (opts?.reasoningEffort) {
      params._meta = { reasoningEffort: opts.reasoningEffort };
    }
    return this.request("session/set_model", params);
  }

  async prompt(sessionId: string, blocks: AcpContentBlock[]) {
    const result = await this.request("session/prompt", {
      sessionId,
      prompt: blocks,
    });
    this.events.onTurnEnd?.(sessionId, result);
    return result;
  }

  cancel(sessionId: string) {
    this.notify("session/cancel", { sessionId });
  }
}
