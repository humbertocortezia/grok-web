
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/cn";

export type ComposerComboOption = {
  value: string;
  label: string;
  description?: string;
};

export function ComposerCombo({
  label,
  value,
  options,
  disabled,
  title,
  className,
  onChange,
}: {
  label: string;
  value: string;
  options: ComposerComboOption[];
  disabled?: boolean;
  title?: string;
  className?: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listboxId = useId();

  const selected =
    options.find((o) => o.value === value) || options[0] || null;
  const selectedLabel = selected?.label || value;

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const idx = Math.max(
      0,
      options.findIndex((o) => o.value === value)
    );
    setActiveIndex(idx >= 0 ? idx : 0);
  }, [open, options, value]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);

  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector(`[data-idx="${activeIndex}"]`);
    if (el && "scrollIntoView" in el) {
      (el as HTMLElement).scrollIntoView({ block: "nearest" });
    }
  }, [activeIndex, open]);

  function pick(next: string) {
    onChange(next);
    close();
  }

  function onTriggerKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    if (disabled) return;
    if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setOpen(true);
    }
  }

  function onListKeyDown(e: KeyboardEvent<HTMLUListElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(options.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(0, i - 1));
    } else if (e.key === "Home") {
      e.preventDefault();
      setActiveIndex(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActiveIndex(options.length - 1);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const opt = options[activeIndex];
      if (opt) pick(opt.value);
    } else if (e.key === "Tab") {
      close();
    }
  }

  return (
    <div
      ref={rootRef}
      className={cn(
        "composer-combo",
        open && "is-open",
        disabled && "is-disabled",
        className
      )}
      title={title}
    >
      <button
        type="button"
        className="composer-combo-trigger"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-label={`${label}: ${selectedLabel}`}
        onClick={() => !disabled && setOpen((v) => !v)}
        onKeyDown={onTriggerKeyDown}
      >
        <span className="composer-select-label">{label}</span>
        <span className="composer-combo-value">{selectedLabel}</span>
        <ChevronDown
          className={cn("composer-combo-chevron", open && "is-open")}
          aria-hidden
        />
      </button>

      {open ? (
        <ul
          ref={listRef}
          id={listboxId}
          className="composer-combo-menu"
          role="listbox"
          aria-label={label}
          tabIndex={-1}
          onKeyDown={onListKeyDown}
        >
          {options.map((opt, i) => {
            const isSelected = opt.value === value;
            const isActive = i === activeIndex;
            return (
              <li key={opt.value} role="presentation">
                <button
                  type="button"
                  role="option"
                  data-idx={i}
                  aria-selected={isSelected}
                  className={cn(
                    "composer-combo-option",
                    isSelected && "is-selected",
                    isActive && "is-active"
                  )}
                  onMouseEnter={() => setActiveIndex(i)}
                  onClick={() => pick(opt.value)}
                >
                  <span className="composer-combo-option-text">
                    <span className="composer-combo-option-label">
                      {opt.label}
                    </span>
                    {opt.description ? (
                      <span className="composer-combo-option-desc">
                        {opt.description}
                      </span>
                    ) : null}
                  </span>
                  {isSelected ? (
                    <Check className="composer-combo-check" aria-hidden />
                  ) : (
                    <span className="composer-combo-check-spacer" aria-hidden />
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
