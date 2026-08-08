/**
 * Slash command catalog for the Grok Web composer.
 * Built-ins from Grok Build docs + dynamic skills as /name.
 */

export type SlashCommand = {
  name: string;
  /** Display as /name */
  command: string;
  description: string;
  argumentHint?: string;
  /** builtin | skill | web */
  source: "builtin" | "skill" | "web";
  /** Client handles without sending to agent */
  local?: boolean;
  /** Aliases without leading slash */
  aliases?: string[];
};

/** Built-ins useful in grok-web (subset of Grok Build + local web handlers). */
export const BUILTIN_SLASH: SlashCommand[] = [
  {
    name: "new",
    command: "/new",
    description: "Nova conversa nesta aba / limpar chat",
    source: "web",
    local: true,
    aliases: ["clear"],
  },
  {
    name: "model",
    command: "/model",
    description: "Trocar modelo (ex: /model grok-4.5)",
    argumentHint: "<id>",
    source: "web",
    local: true,
    aliases: ["m"],
  },
  {
    name: "effort",
    command: "/effort",
    description: "Nível de reasoning: low | medium | high",
    argumentHint: "<level>",
    source: "web",
    local: true,
  },
  {
    name: "compact",
    command: "/compact",
    description: "Comprimir histórico de contexto (envia ao agent)",
    argumentHint: "[contexto]",
    source: "builtin",
  },
  {
    name: "context",
    command: "/context",
    description: "Uso da janela de contexto",
    source: "builtin",
  },
  {
    name: "session-info",
    command: "/session-info",
    description: "Detalhes da sessão, auth e modelo",
    source: "builtin",
    aliases: ["status", "info"],
  },
  {
    name: "usage",
    command: "/usage",
    description: "Abrir painel de uso / contexto",
    source: "web",
    local: true,
    aliases: ["cost"],
  },
  {
    name: "mcps",
    command: "/mcps",
    description: "Abrir painel MCP / Skills",
    source: "web",
    local: true,
  },
  {
    name: "skills",
    command: "/skills",
    description: "Abrir painel de skills",
    source: "web",
    local: true,
  },
  {
    name: "plan",
    command: "/plan",
    description: "Entrar em plan mode (agent)",
    source: "builtin",
  },
  {
    name: "always-approve",
    command: "/always-approve",
    description: "Toggle always-approve de tools",
    source: "builtin",
  },
  {
    name: "doctor",
    command: "/doctor",
    description: "Diagnóstico MCP / ambiente (agent)",
    source: "builtin",
  },
  {
    name: "imagine",
    command: "/imagine",
    description: "Gerar imagem",
    argumentHint: "<descrição>",
    source: "builtin",
  },
  {
    name: "loop",
    command: "/loop",
    description: "Prompt recorrente no agent",
    argumentHint: "[interval] <prompt>",
    source: "builtin",
  },
  {
    name: "workflow",
    command: "/workflow",
    description: "Rodar workflow do Grok Build",
    argumentHint: "<nome>",
    source: "builtin",
  },
  {
    name: "memory",
    command: "/memory",
    description: "Memória cross-session",
    source: "builtin",
    aliases: ["mem"],
  },
  {
    name: "help",
    command: "/help",
    description: "Ajuda e docs do Grok",
    source: "builtin",
    aliases: ["docs", "howto"],
  },
  {
    name: "rename",
    command: "/rename",
    description: "Renomear título da aba",
    argumentHint: "<título>",
    source: "web",
    local: true,
    aliases: ["title"],
  },
];

export function skillsToSlash(
  skills: Array<{
    name: string;
    description: string;
    shortDescription?: string;
    userInvocable?: boolean;
    source?: string;
  }>
): SlashCommand[] {
  return skills
    .filter((s) => s.userInvocable !== false)
    .map((s) => ({
      name: s.name,
      command: `/${s.name}`,
      description: (s.shortDescription || s.description || "Skill").slice(0, 120),
      source: "skill" as const,
      argumentHint: "[args]",
    }));
}

/** Simple fuzzy: subsequence + substring score. */
export function filterSlashCommands(
  commands: SlashCommand[],
  query: string
): SlashCommand[] {
  const q = query.replace(/^\//, "").trim().toLowerCase();
  if (!q) return commands.slice(0, 40);

  const scored: Array<{ c: SlashCommand; score: number }> = [];
  for (const c of commands) {
    const names = [c.name, ...(c.aliases || [])].map((n) => n.toLowerCase());
    let best = -1;
    for (const n of names) {
      if (n === q) best = Math.max(best, 1000);
      else if (n.startsWith(q)) best = Math.max(best, 500 - n.length);
      else if (n.includes(q)) best = Math.max(best, 200 - n.indexOf(q));
      else if (subsequence(n, q)) best = Math.max(best, 50);
      else if (c.description.toLowerCase().includes(q)) best = Math.max(best, 20);
    }
    if (best >= 0) scored.push({ c, score: best });
  }
  scored.sort((a, b) => b.score - a.score || a.c.name.localeCompare(b.c.name));
  return scored.map((s) => s.c).slice(0, 40);
}

function subsequence(hay: string, needle: string): boolean {
  let i = 0;
  for (const ch of hay) {
    if (ch === needle[i]) i++;
    if (i >= needle.length) return true;
  }
  return false;
}

export function parseSlashInput(text: string): {
  active: boolean;
  /** full token after / up to space or end (for filter) */
  filter: string;
  /** true when user typed space after command name (args mode) */
  hasArgs: boolean;
  commandName: string;
  args: string;
} {
  if (!text.startsWith("/")) {
    return { active: false, filter: "", hasArgs: false, commandName: "", args: "" };
  }
  const rest = text.slice(1);
  const sp = rest.search(/\s/);
  if (sp < 0) {
    return {
      active: true,
      filter: rest,
      hasArgs: false,
      commandName: rest,
      args: "",
    };
  }
  return {
    active: true,
    filter: rest.slice(0, sp),
    hasArgs: true,
    commandName: rest.slice(0, sp),
    args: rest.slice(sp + 1),
  };
}
