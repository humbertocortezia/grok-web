
import { ExternalLink, RefreshCw } from "lucide-react";
import { cn } from "@/lib/cn";

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

export type UsagePrimary = {
  sessionId: string;
  contextUsagePct: number;
  contextTokensUsed: number;
  contextWindowTokens: number;
  contextTokensRemaining: number;
  turnCount?: number;
  toolCallCount?: number;
  toolFailureCount?: number;
  userMessageCount?: number;
  assistantMessageCount?: number;
  modelId?: string | null;
  modelsUsed?: string[];
  title?: string | null;
  toolsUsed?: string[];
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cachedReadTokens?: number;
  totalTokens?: number;
  modelCalls?: number;
  costUsd?: number;
  modelUsage?: ModelUsageRow[];
  avgResponseTimeMs?: number | null;
  avgTimeToFirstTokenMs?: number | null;
  sessionDurationSeconds?: number | null;
  agentLinesAdded?: number;
  agentLinesRemoved?: number;
  totalFilesTouched?: number;
  compactionCount?: number;
  errorCount?: number;
  source?: string;
};

export type WorkStatus = "offline" | "idle" | "busy";

function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1000) return String(Math.round(n));
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function formatUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "$0.00";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 10) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

function formatDuration(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return "—";
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h}h ${m}m`;
}

function formatMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Green / orange / red from usage % */
function usageTone(pct: number): "ok" | "warn" | "hot" {
  if (pct >= 85) return "hot";
  if (pct >= 65) return "warn";
  return "ok";
}

/**
 * Minimal badge: colored dot + short secondary label.
 */
export function UsageFooterStrip({
  usage,
  loading,
  workStatus,
  onClick,
}: {
  usage: UsagePrimary | null;
  loading?: boolean;
  workStatus: WorkStatus;
  onClick?: () => void;
}) {
  const pct = usage?.contextUsagePct ?? 0;
  const hasData = Boolean(usage && usage.contextWindowTokens > 0);
  const tone = hasData ? usageTone(pct) : "muted";

  const workTone: "ok" | "warn" | "hot" | "muted" =
    workStatus === "busy"
      ? "warn"
      : workStatus === "offline"
        ? "hot"
        : "ok";

  const cost =
    usage?.costUsd && usage.costUsd > 0 ? ` · ${formatUsd(usage.costUsd)}` : "";

  const title = hasData
    ? `Contexto ${pct}% · ${formatTokens(usage!.contextTokensUsed)}/${formatTokens(usage!.contextWindowTokens)}${cost} · clique p/ detalhes`
    : workStatus === "offline"
      ? "Agent offline"
      : loading
        ? "Carregando uso…"
        : "Sem dados de contexto ainda";

  return (
    <button
      type="button"
      className="usage-badge"
      onClick={onClick}
      title={title}
    >
      <span
        className={cn(
          "usage-dot",
          `usage-dot--${workTone}`,
          workStatus === "busy" && "usage-dot--pulse"
        )}
        aria-hidden
      />
      <span
        className={cn("usage-dot", `usage-dot--${tone}`)}
        aria-hidden
      />
      <span className="usage-badge-label">
        {loading && !hasData
          ? "…"
          : hasData
            ? `${Math.round(pct)}%`
            : "—"}
      </span>
    </button>
  );
}

/** @deprecated */
export function UsageMeterChip(props: {
  usage: UsagePrimary | null;
  loading?: boolean;
  onClick?: () => void;
  workStatus?: WorkStatus;
}) {
  return (
    <UsageFooterStrip
      usage={props.usage}
      loading={props.loading}
      workStatus={props.workStatus ?? "idle"}
      onClick={props.onClick}
    />
  );
}

function Stat({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="usage-stat">
      <div className="usage-stat-label">{label}</div>
      <div className={cn("usage-stat-value", mono && "font-mono")}>{value}</div>
    </div>
  );
}

/** Full inspector panel — mirrors /usage style session + token/cost breakdown */
export function UsagePanel({
  usage,
  note,
  account,
  workStatus,
  billingUrl,
  recent,
  loading,
  onRefresh,
}: {
  usage: UsagePrimary | null;
  note?: string;
  account?: { email: string | null; firstName: string | null } | null;
  workStatus?: WorkStatus;
  billingUrl?: string;
  recent?: UsagePrimary[];
  loading?: boolean;
  onRefresh?: () => void;
}) {
  const pct = usage?.contextUsagePct ?? 0;
  const hasCtx = Boolean(usage && usage.contextWindowTokens > 0);
  const hasTurns = Boolean(usage && (usage.totalTokens || 0) > 0);
  const tone = hasCtx ? usageTone(pct) : "muted";

  return (
    <div className="usage-panel">
      <div className="usage-panel-head">
        <div className="usage-panel-row">
          <span
            className={cn(
              "usage-dot",
              workStatus === "busy"
                ? "usage-dot--warn usage-dot--pulse"
                : workStatus === "offline"
                  ? "usage-dot--hot"
                  : "usage-dot--ok"
            )}
          />
          <span className="usage-panel-muted">
            {workStatus === "busy"
              ? "processando"
              : workStatus === "offline"
                ? "offline"
                : "pronto"}
          </span>
        </div>
        {onRefresh ? (
          <button
            type="button"
            className="usage-refresh"
            onClick={onRefresh}
            title="Atualizar uso"
            disabled={loading}
          >
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
          </button>
        ) : null}
      </div>

      {usage?.title || usage?.modelId ? (
        <div className="usage-panel-meta usage-panel-meta--wrap">
          {usage.title ? <span className="truncate">{usage.title}</span> : null}
          {usage.modelId ? (
            <span className="font-mono text-[10px] opacity-80">
              {usage.modelId}
            </span>
          ) : null}
        </div>
      ) : null}

      {!hasCtx && !hasTurns ? (
        <p className="usage-panel-muted">
          Sem uso nesta sessão ainda. Envie um prompt ou abra uma sessão com
          histórico.
        </p>
      ) : (
        <>
          {/* Context window — like /context */}
          {hasCtx ? (
            <>
              <div className="usage-section-title">Janela de contexto</div>
              <div className="usage-panel-row usage-panel-row--main">
                <span className={cn("usage-dot", `usage-dot--${tone}`)} />
                <span className="usage-panel-pct">{Math.round(pct)}%</span>
                <span className="usage-panel-muted">preenchido</span>
              </div>
              <div
                className="usage-progress"
                role="progressbar"
                aria-valuenow={Math.round(pct)}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="Uso de contexto"
              >
                <div
                  className={cn(
                    "usage-progress-fill",
                    `usage-progress-fill--${tone}`
                  )}
                  style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
                />
              </div>
              <div className="usage-progress-scale">
                <span>0</span>
                <span>50%</span>
                <span>100%</span>
              </div>
              <div className="usage-panel-meta">
                <span>{formatTokens(usage!.contextTokensUsed)} usados</span>
                <span>·</span>
                <span>{formatTokens(usage!.contextTokensRemaining)} livres</span>
                <span>·</span>
                <span>{formatTokens(usage!.contextWindowTokens)} máx</span>
              </div>
            </>
          ) : null}

          {/* Token + cost — like /usage session totals */}
          <div className="usage-section-title">Tokens & custo (sessão)</div>
          <div className="usage-stat-grid">
            <Stat
              label="Custo est."
              value={formatUsd(usage?.costUsd ?? 0)}
            />
            <Stat
              label="Total tokens"
              value={formatTokens(usage?.totalTokens ?? 0)}
              mono
            />
            <Stat
              label="Input"
              value={formatTokens(usage?.inputTokens ?? 0)}
              mono
            />
            <Stat
              label="Output"
              value={formatTokens(usage?.outputTokens ?? 0)}
              mono
            />
            <Stat
              label="Reasoning"
              value={formatTokens(usage?.reasoningTokens ?? 0)}
              mono
            />
            <Stat
              label="Cache read"
              value={formatTokens(usage?.cachedReadTokens ?? 0)}
              mono
            />
            <Stat label="Model calls" value={String(usage?.modelCalls ?? 0)} />
            <Stat label="Turns" value={String(usage?.turnCount ?? 0)} />
          </div>

          {usage?.modelUsage && usage.modelUsage.length > 0 ? (
            <div className="usage-model-list">
              <div className="usage-section-title">Por modelo</div>
              {usage.modelUsage.map((m) => (
                <div key={m.modelId} className="usage-model-row">
                  <div className="usage-model-name font-mono">{m.modelId}</div>
                  <div className="usage-panel-meta usage-panel-meta--wrap">
                    <span>{formatUsd(m.costUsd)}</span>
                    <span>·</span>
                    <span>in {formatTokens(m.inputTokens)}</span>
                    <span>·</span>
                    <span>out {formatTokens(m.outputTokens)}</span>
                    <span>·</span>
                    <span>{m.modelCalls} calls</span>
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          <div className="usage-section-title">Atividade</div>
          <div className="usage-stat-grid">
            <Stat label="Tools" value={String(usage?.toolCallCount ?? 0)} />
            <Stat
              label="Tool fails"
              value={String(usage?.toolFailureCount ?? 0)}
            />
            <Stat
              label="Msgs user"
              value={String(usage?.userMessageCount ?? 0)}
            />
            <Stat
              label="Msgs asst"
              value={String(usage?.assistantMessageCount ?? 0)}
            />
            <Stat
              label="Arquivos"
              value={String(usage?.totalFilesTouched ?? 0)}
            />
            <Stat
              label="Linhas ±"
              value={`+${usage?.agentLinesAdded ?? 0}/−${usage?.agentLinesRemoved ?? 0}`}
            />
            <Stat
              label="TTFT méd."
              value={formatMs(usage?.avgTimeToFirstTokenMs)}
            />
            <Stat
              label="Resp. méd."
              value={formatMs(usage?.avgResponseTimeMs)}
            />
            <Stat
              label="Duração"
              value={formatDuration(usage?.sessionDurationSeconds)}
            />
            <Stat
              label="Compactions"
              value={String(usage?.compactionCount ?? 0)}
            />
            <Stat label="Erros" value={String(usage?.errorCount ?? 0)} />
          </div>

          {usage?.toolsUsed && usage.toolsUsed.length > 0 ? (
            <div className="usage-tools">
              <div className="usage-section-title">Tools usadas</div>
              <div className="usage-tool-chips">
                {usage.toolsUsed.slice(0, 24).map((t) => (
                  <span key={t} className="usage-tool-chip">
                    {t}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
        </>
      )}

      {recent && recent.length > 0 ? (
        <div className="usage-recent">
          <div className="usage-section-title">Outras sessões</div>
          {recent.slice(0, 5).map((r) => (
            <div key={r.sessionId} className="usage-recent-row">
              <span className="truncate">
                {r.title || r.sessionId.slice(0, 8)}
              </span>
              <span className="usage-panel-muted shrink-0">
                {Math.round(r.contextUsagePct)}%
                {(r.costUsd ?? 0) > 0 ? ` · ${formatUsd(r.costUsd!)}` : ""}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {account?.email ? (
        <p className="usage-panel-muted truncate">
          {account.firstName || account.email}
        </p>
      ) : null}

      {billingUrl ? (
        <a
          href={billingUrl}
          target="_blank"
          rel="noreferrer"
          className="usage-billing-link"
        >
          <ExternalLink className="h-3 w-3" />
          Créditos / billing no grok.com
          <span className="opacity-60">(/usage manage)</span>
        </a>
      ) : null}

      {note ? <p className="usage-panel-muted">{note}</p> : null}

      <div className="usage-panel-legend">
        <span>
          <i className="usage-dot usage-dot--ok" /> &lt;65%
        </span>
        <span>
          <i className="usage-dot usage-dot--warn" /> 65–85%
        </span>
        <span>
          <i className="usage-dot usage-dot--hot" /> &gt;85%
        </span>
      </div>
    </div>
  );
}
