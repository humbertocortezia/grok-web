
import { cn } from "@/lib/cn";

type Props = {
  size?: number;
  className?: string;
  /** idle | thinking | done */
  state?: "idle" | "thinking" | "done";
};

/**
 * Simple black-hole light: a dark core with a soft light fade (no orbit rings).
 */
export function OrbitMark({ size = 22, className, state = "thinking" }: Props) {
  return (
    <span
      className={cn(
        "void-light",
        state === "thinking" && "is-thinking",
        state === "done" && "is-done",
        className
      )}
      style={{ width: size, height: size }}
      aria-hidden
    >
      <span className="void-light-glow" />
      <span className="void-light-core" />
    </span>
  );
}
