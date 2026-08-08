"use client";

import { memo, useMemo, useRef, useState } from "react";
import type { ChatMessage } from "@/lib/acp-client";
import { GrokMark } from "@/components/grok-logo";
import { buildToolStamps, ProcessStampStack, ThinkingStream } from "@/components/process-stream";
import { MarkdownBody } from "@/components/markdown-body";
import { cn } from "@/lib/cn";

function MessageBubbleInner({
  message,
  index = 0,
}: {
  message: ChatMessage;
  index?: number;
}) {
  const delay = Math.min(index, 6) * 35;
  // Enter animation only once — never re-fire on re-render / pending flip.
  const [enterClass, setEnterClass] = useState(() => {
    if (message.role === "user") return "msg-enter msg-enter--user";
    if (message.role === "assistant") return "msg-enter msg-enter--assistant";
    return "msg-enter";
  });
  const enteredRef = useRef(false);

  const toolStamps = useMemo(
    () =>
      message.role === "assistant" ? buildToolStamps(message.toolCalls) : [],
    [message.role, message.toolCalls]
  );

  const onEnterEnd = () => {
    if (enteredRef.current) return;
    enteredRef.current = true;
    setEnterClass("");
  };

  if (message.role === "system") {
    return (
      <div
        className={cn("mx-auto max-w-[42rem]", enterClass)}
        style={enterClass ? { animationDelay: `${delay}ms` } : undefined}
        onAnimationEnd={onEnterEnd}
      >
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-soft)]/80 px-4 py-3 text-[13px] text-[var(--muted)] backdrop-blur-sm">
          {message.text}
        </div>
      </div>
    );
  }

  if (message.role === "user") {
    return (
      <div
        className={cn("mx-auto flex max-w-[42rem] justify-end", enterClass)}
        style={enterClass ? { animationDelay: `${delay}ms` } : undefined}
        onAnimationEnd={onEnterEnd}
      >
        <div className="bubble-user max-w-[min(92%,34rem)] px-4 py-2.5">
          {message.images?.length ? (
            <div className="mb-2 flex flex-wrap gap-2">
              {message.images.map((img, i) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={i}
                  src={img.dataUrl}
                  alt=""
                  className="max-h-48 rounded-xl border border-[var(--border)]"
                />
              ))}
            </div>
          ) : null}
          <div className="prose-chat text-[14px] leading-relaxed whitespace-pre-wrap">
            {message.text}
          </div>
        </div>
      </div>
    );
  }

  // Assistant
  const hasText = Boolean(message.text?.trim());
  const hasThinking = Boolean(message.thinking?.trim());
  const hasTools = toolStamps.length > 0;
  const live = Boolean(message.pending);

  // Thinking: expanded only while pure-reasoning (no tools/text yet).
  // Chip when there is thought content and tools/text already present or turn ended.
  const showThinkingExpanded = Boolean(live && !hasTools && !hasText);
  const showThinkingChip = Boolean(
    hasThinking && (hasTools || hasText || !live)
  );

  return (
    <div
      className={cn("mx-auto max-w-[42rem]", enterClass)}
      style={enterClass ? { animationDelay: `${delay}ms` } : undefined}
      onAnimationEnd={onEnterEnd}
    >
      <div className="mb-1.5 flex items-center gap-2 px-0.5">
        <GrokMark size={16} state={live ? "thinking" : "idle"} />
        <span
          className={cn(
            "text-[12px] font-medium",
            live ? "light-sweep-text" : "text-[var(--text-secondary)]"
          )}
        >
          Grok
        </span>
        {live ? (
          <span className="text-[11px] light-sweep-text">working</span>
        ) : null}
      </div>

      <div className="bubble-assistant px-3.5 py-3">
        {showThinkingExpanded ? (
          <ThinkingStream text={message.thinking} active />
        ) : showThinkingChip ? (
          <ThinkingStream text={message.thinking} active={false} />
        ) : null}

        {/* Single component for live + done — collapses in place, no remount */}
        {hasTools ? <ProcessStampStack stamps={toolStamps} live={live} /> : null}

        {hasText ? (
          <div className={cn(live && "streaming-light")}>
            <MarkdownBody text={message.text} className="md-body--chat" />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function sameTools(
  a: ChatMessage["toolCalls"],
  b: ChatMessage["toolCalls"]
): boolean {
  if (a === b) return true;
  if (!a?.length && !b?.length) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (
      a[i].id !== b[i].id ||
      a[i].status !== b[i].status ||
      a[i].title !== b[i].title
    ) {
      return false;
    }
  }
  return true;
}

export const MessageBubble = memo(MessageBubbleInner, (prev, next) => {
  const a = prev.message;
  const b = next.message;
  return (
    prev.index === next.index &&
    a.id === b.id &&
    a.role === b.role &&
    a.text === b.text &&
    a.thinking === b.thinking &&
    a.pending === b.pending &&
    a.images === b.images &&
    sameTools(a.toolCalls, b.toolCalls)
  );
});
