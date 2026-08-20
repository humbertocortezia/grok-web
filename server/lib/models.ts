import fs from "fs/promises";
import path from "path";
import { grokHome } from "./paths";

export type ReasoningEffortOption = {
  id: string;
  value: string;
  label: string;
  description?: string;
  default?: boolean;
};

export type ModelInfo = {
  id: string;
  name: string;
  description?: string;
  contextWindow?: number;
  agentType?: string | null;
  hidden?: boolean;
  supportsReasoningEffort: boolean;
  defaultEffort?: string | null;
  efforts: ReasoningEffortOption[];
};

export type ModelsCatalog = {
  fetchedAt?: string;
  defaultModelId: string | null;
  models: ModelInfo[];
};

function modelsCachePath(): string {
  return path.join(grokHome(), "models_cache.json");
}

/**
 * Read the offline models catalog Grok keeps at ~/.grok/models_cache.json.
 * Prefer non-hidden models; always include at least the default id if present.
 */
export async function listModels(): Promise<ModelsCatalog> {
  let raw: string;
  try {
    raw = await fs.readFile(modelsCachePath(), "utf8");
  } catch {
    return {
      defaultModelId: "grok-4.5",
      models: [
        {
          id: "grok-4.5",
          name: "Grok 4.5",
          supportsReasoningEffort: true,
          defaultEffort: "high",
          efforts: [
            { id: "high", value: "high", label: "High", default: true },
            { id: "medium", value: "medium", label: "Medium" },
            { id: "low", value: "low", label: "Low" },
          ],
        },
      ],
    };
  }

  const data = JSON.parse(raw) as {
    fetched_at?: string;
    models?: Record<
      string,
      {
        info?: Record<string, unknown>;
      }
    >;
  };

  const models: ModelInfo[] = [];
  for (const [id, entry] of Object.entries(data.models || {})) {
    const info = (entry?.info || entry || {}) as Record<string, unknown>;
    const hidden = Boolean(info.hidden);
    const effortsRaw = Array.isArray(info.reasoning_efforts)
      ? (info.reasoning_efforts as Array<Record<string, unknown>>)
      : [];
    const efforts: ReasoningEffortOption[] = effortsRaw.map((e) => ({
      id: String(e.id || e.value || ""),
      value: String(e.value || e.id || ""),
      label: String(e.label || e.id || e.value || ""),
      description: e.description ? String(e.description) : undefined,
      default: Boolean(e.default),
    })).filter((e) => e.id);

    models.push({
      id: String(info.id || id),
      name: String(info.name || info.system_prompt_label || id),
      description: info.description ? String(info.description) : undefined,
      contextWindow:
        typeof info.context_window === "number"
          ? info.context_window
          : undefined,
      agentType: info.agent_type ? String(info.agent_type) : null,
      hidden,
      supportsReasoningEffort: Boolean(
        info.supports_reasoning_effort ?? efforts.length > 0
      ),
      defaultEffort: info.reasoning_effort
        ? String(info.reasoning_effort)
        : efforts.find((e) => e.default)?.value || efforts[0]?.value || null,
      efforts,
    });
  }

  const visible = models.filter((m) => !m.hidden);
  const list = visible.length ? visible : models;
  list.sort((a, b) => a.name.localeCompare(b.name));

  const defaultModelId =
    list.find((m) => m.id === "grok-4.5")?.id || list[0]?.id || null;

  return {
    fetchedAt: data.fetched_at,
    defaultModelId,
    models: list,
  };
}
