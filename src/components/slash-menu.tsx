
import { useEffect, useRef } from "react";
import { Check, CornerDownLeft } from "lucide-react";
import { cn } from "@/lib/cn";
import type { SlashCommand } from "@/lib/slash-commands";

export function SlashMenu({
  open,
  items,
  activeIndex,
  onActiveIndexChange,
  onPick,
  query,
}: {
  open: boolean;
  items: SlashCommand[];
  activeIndex: number;
  onActiveIndexChange: (i: number) => void;
  onPick: (cmd: SlashCommand) => void;
  query: string;
}) {
  const listRef = useRef<HTMLUListElement>(null);
  const safeIndex = Math.min(activeIndex, Math.max(0, items.length - 1));
  const focused = items[safeIndex] || null;

  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector(`[data-idx="${safeIndex}"]`);
    if (el && "scrollIntoView" in el) {
      (el as HTMLElement).scrollIntoView({ block: "nearest" });
    }
  }, [safeIndex, open]);

  if (!open || !items.length) return null;

  return (
    <div className="slash-menu" role="listbox" aria-label="Comandos slash">
      <div className="slash-menu-header">
        <span>Comandos</span>
        {focused ? (
          <span className="slash-menu-focus-hint">
            foco <strong>{focused.command}</strong>
            <CornerDownLeft className="h-3 w-3 opacity-70" />
          </span>
        ) : query ? (
          <span className="slash-menu-query">/{query}</span>
        ) : (
          <span className="slash-menu-hint">↑↓ · Tab/Enter · Esc</span>
        )}
      </div>
      <ul ref={listRef} className="slash-menu-list">
        {items.map((item, i) => {
          const active = i === safeIndex;
          return (
            <li key={`${item.source}:${item.command}`}>
              <button
                type="button"
                data-idx={i}
                role="option"
                aria-selected={active}
                className={cn(
                  "slash-menu-item",
                  active && "is-active",
                  active && item.source === "skill" && "is-skill",
                  active && item.source === "web" && "is-web",
                  active && item.source === "builtin" && "is-builtin"
                )}
                onMouseEnter={() => onActiveIndexChange(i)}
                onClick={() => onPick(item)}
              >
                <span className="slash-menu-cmd">{item.command}</span>
                <span className="slash-menu-desc">{item.description}</span>
                <span className="slash-menu-tail">
                  <span
                    className={cn(
                      "slash-menu-src",
                      item.source === "skill" && "is-skill",
                      item.source === "web" && "is-web",
                      item.source === "builtin" && "is-builtin"
                    )}
                  >
                    {item.source}
                  </span>
                  {active ? (
                    <span className="slash-menu-check" aria-hidden>
                      <Check className="h-3.5 w-3.5" />
                    </span>
                  ) : null}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="slash-menu-footer">
        <span>
          Item em destaque = selecionado · <kbd>Enter</kbd> confirma
        </span>
      </div>
    </div>
  );
}

/** Chip above the textarea when a slash command is armed / active. */
export function SlashArmedChip({
  cmd,
  args,
  picking,
  onClear,
}: {
  cmd: SlashCommand;
  args?: string;
  /** Still navigating the menu (not confirmed) */
  picking?: boolean;
  onClear?: () => void;
}) {
  return (
    <div
      className={cn(
        "slash-armed",
        cmd.source === "skill" && "is-skill",
        cmd.source === "web" && "is-web",
        cmd.source === "builtin" && "is-builtin",
        picking && "is-picking"
      )}
    >
      <span className="slash-armed-dot" aria-hidden />
      <div className="slash-armed-body">
        <span className="slash-armed-label">
          {picking ? "Em foco" : "Recurso ativo"}
        </span>
        <span className="slash-armed-cmd font-mono">{cmd.command}</span>
        {args ? (
          <span className="slash-armed-args truncate">{args}</span>
        ) : cmd.argumentHint && !picking ? (
          <span className="slash-armed-hint">{cmd.argumentHint}</span>
        ) : null}
      </div>
      <span
        className={cn(
          "slash-armed-src",
          cmd.source === "skill" && "is-skill",
          cmd.source === "web" && "is-web"
        )}
      >
        {cmd.source === "skill"
          ? "skill"
          : cmd.source === "web"
            ? "web"
            : "builtin"}
      </span>
      {onClear && !picking ? (
        <button
          type="button"
          className="slash-armed-clear"
          title="Limpar comando"
          onClick={onClear}
        >
          ×
        </button>
      ) : null}
    </div>
  );
}
