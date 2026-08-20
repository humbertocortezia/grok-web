
import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/cn";

function MarkdownBodyInner({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  if (!text) return null;
  return (
    <div className={cn("md-body", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          ),
          code: ({ className: codeClass, children, ...props }) => {
            const isBlock = Boolean(codeClass) || String(children).includes("\n");
            if (isBlock) {
              return (
                <code className={cn("md-code-block", codeClass)} {...props}>
                  {children}
                </code>
              );
            }
            return (
              <code className="md-code-inline" {...props}>
                {children}
              </code>
            );
          },
          pre: ({ children }) => <pre className="md-pre">{children}</pre>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

/** Memoized — full remount of ReactMarkdown on every parent paint caused end-of-turn flicker. */
export const MarkdownBody = memo(MarkdownBodyInner, (prev, next) => {
  return prev.text === next.text && prev.className === next.className;
});
