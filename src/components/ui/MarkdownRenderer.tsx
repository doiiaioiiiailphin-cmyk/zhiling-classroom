import React, { useMemo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';

interface MarkdownRendererProps {
  content: string;
  variant?: 'default' | 'compact' | 'thinking';
  isStreaming?: boolean;
  className?: string;
  onTimestampClick?: (ms: number, label: string) => void;
}

const CODE_SEGMENT_REGEX = /(```[\s\S]*?```|`[^`\n]+`)/g;
const TIMESTAMP_TOKEN_RE = /^\[?(?:(\d{1,2}):)?(\d{1,3}):(\d{2})\]?$/;

function parseTimestampMs(raw: string): number | null {
  const m = raw.trim().match(TIMESTAMP_TOKEN_RE);
  if (!m) return null;
  const hrs = m[1] ? Number(m[1]) : 0;
  const mins = Number(m[2]);
  const secs = Number(m[3]);
  if (secs >= 60) return null;
  return (hrs * 3600 + mins * 60 + secs) * 1000;
}

export function normalizeLatexDelimiters(
  source: string,
  wrapBareTimestamps = false
): string {
  if (!source) return '';
  return source
    .split(CODE_SEGMENT_REGEX)
    .map((segment) => {
      if (segment.startsWith('```') || segment.startsWith('`')) {
        return segment;
      }
      let out = segment
        .replace(/\\\[([\s\S]*?)\\\]/g, (_, expr: string) => `\n\n$$\n${expr.trim()}\n$$\n\n`)
        .replace(/\\\(([\s\S]*?)\\\)/g, (_, expr: string) => `$${expr.trim()}$`)
        .replace(
          /^([ \t]*)\$\$([^\n]+?)\$\$[ \t]*$/gm,
          (_, indent: string, expr: string) => `${indent}$$\n${indent}${expr.trim()}\n${indent}$$`
        );
      if (wrapBareTimestamps) {
        out = out.replace(/\[(\d{1,3}:\d{2}(?::\d{2})?)\](?!\()/g, '`[$1]`');
      }
      return out;
    })
    .join('');
}

const REMARK_PLUGINS = [remarkGfm, remarkMath];
const REHYPE_PLUGINS: NonNullable<React.ComponentProps<typeof ReactMarkdown>['rehypePlugins']> = [
  [rehypeKatex, { throwOnError: false, strict: false, errorColor: '#646A73' }],
];

export const MarkdownRenderer: React.FC<MarkdownRendererProps> = React.memo(
  ({
    content,
    variant = 'default',
    isStreaming = false,
    className = '',
    onTimestampClick,
  }) => {
    const normalized = useMemo(
      () => normalizeLatexDelimiters(content, Boolean(onTimestampClick)),
      [content, onTimestampClick]
    );
    const isThinking = variant === 'thinking';
    const isCompact = variant === 'compact' || isThinking;

    const components = useMemo<Components>(
      () => ({
        h1: ({ children }) => (
          <h1
            className={`${
              isCompact ? 'text-[15px] mt-2 mb-1' : 'text-[17px] mt-4 mb-2'
            } font-semibold ${
              isThinking ? 'text-[#4E5969]' : 'text-[#1F2329]'
            } leading-snug first:mt-0`}
          >
            {children}
          </h1>
        ),
        h2: ({ children }) => (
          <h2
            className={`${
              isCompact ? 'text-[15px] mt-2 mb-1' : 'text-[16px] mt-3.5 mb-1.5'
            } font-semibold ${
              isThinking ? 'text-[#4E5969]' : 'text-[#1F2329]'
            } leading-snug first:mt-0`}
          >
            {children}
          </h2>
        ),
        h3: ({ children }) => (
          <h3
            className={`${
              isCompact ? 'text-[14px] mt-2 mb-1' : 'text-[15px] mt-3 mb-1'
            } font-semibold ${
              isThinking ? 'text-[#4E5969]' : 'text-[#1F2329]'
            } leading-snug first:mt-0`}
          >
            {children}
          </h3>
        ),
        p: ({ children }) => (
          <p className={`${isCompact ? 'my-1.5' : 'my-2.5'} first:mt-0 last:mb-0 break-words`}>
            {children}
          </p>
        ),
        ul: ({ children }) => (
          <ul
            className={`${
              isCompact ? 'my-1.5 space-y-1' : 'my-2.5 space-y-1.5'
            } list-disc pl-5 first:mt-0 last:mb-0`}
          >
            {children}
          </ul>
        ),
        ol: ({ children }) => (
          <ol
            className={`${
              isCompact ? 'my-1.5 space-y-1' : 'my-2.5 space-y-1.5'
            } list-decimal pl-5 first:mt-0 last:mb-0`}
          >
            {children}
          </ol>
        ),
        li: ({ children }) => <li className="leading-relaxed break-words">{children}</li>,
        strong: ({ children }) => (
          <strong className={`font-semibold ${isThinking ? 'text-[#4E5969]' : 'text-[#1F2329]'}`}>
            {children}
          </strong>
        ),
        blockquote: ({ children }) => (
          <blockquote
            className={`my-2.5 border-l-[3px] ${
              isThinking
                ? 'border-[#D0D3D6] pl-3 text-[#646A73]'
                : 'border-[#3370FF] bg-[#EBF2FF]/45 px-3.5 py-2 rounded-r-lg text-[#4E5969]'
            }`}
          >
            {children}
          </blockquote>
        ),
        code: ({ className: codeClass, children, ...rest }) => {
          const isBlock = Boolean(codeClass && codeClass.includes('language-'));
          if (isBlock) {
            return (
              <code className={`${codeClass ?? ''} text-[14px] font-mono`} {...rest}>
                {children}
              </code>
            );
          }
          if (onTimestampClick && typeof children === 'string') {
            const parsedMs = parseTimestampMs(children);
            if (parsedMs !== null) {
              return (
                <button
                  type="button"
                  title="点击定位到右侧对应课堂转写位置"
                  onClick={() => onTimestampClick(parsedMs, children)}
                  className="inline-flex items-center rounded-md px-1.5 py-0.5 text-[14px] font-mono font-medium bg-[#EBF2FF] hover:bg-[#DCE8FF] border border-[#BEDAFF] text-[#1456F0] transition-colors cursor-pointer mx-0.5 tabular-nums"
                >
                  {children}
                </button>
              );
            }
          }
          return (
            <code
              className={`rounded-md px-1.5 py-0.5 text-[14px] font-mono break-words ${
                isThinking
                  ? 'bg-[#F2F3F5] text-[#4E5969]'
                  : 'bg-[#EBF2FF]/75 border border-[#D6E4FF] text-[#1456F0]'
              }`}
              {...rest}
            >
              {children}
            </code>
          );
        },
        pre: ({ children }) => (
          <pre className="my-2.5 overflow-x-auto rounded-xl border border-[#E5E6EB] bg-[#F7F8FA] p-3.5 text-[14px] leading-relaxed text-[#1F2329]">
            {children}
          </pre>
        ),
        table: ({ children }) => (
          <div className="my-2.5 overflow-x-auto rounded-xl border border-[#DEE0E3]">
            <table className="w-full border-collapse text-[14px]">{children}</table>
          </div>
        ),
        thead: ({ children }) => <thead className="bg-[#F5F8FF]">{children}</thead>,
        th: ({ children }) => (
          <th className="border-b border-[#DEE0E3] px-3 py-2 text-left font-semibold text-[#1F2329]">
            {children}
          </th>
        ),
        td: ({ children }) => (
          <td className="border-b border-[#ECEEF2] px-3 py-2 text-[#1F2329]">{children}</td>
        ),
        a: ({ href, children }) => (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="text-[#1456F0] underline decoration-[#1456F0]/40 hover:decoration-[#1456F0]"
          >
            {children}
          </a>
        ),
        hr: () => <hr className="my-3 border-[#ECEEF2]" />,
      }),
      [isCompact, isThinking, onTimestampClick]
    );

    const typographyClass = isThinking
      ? 'text-[14px] leading-[1.7] text-[#646A73]'
      : isCompact
        ? 'text-[14px] leading-[1.7]'
        : 'text-[15px] leading-[1.78] text-[#1F2329]';

    return (
      <div
        className={`${typographyClass} ${
          isStreaming ? 'streaming-markdown' : ''
        } ${className}`}
      >
        <ReactMarkdown
          remarkPlugins={REMARK_PLUGINS}
          rehypePlugins={REHYPE_PLUGINS}
          components={components}
        >
          {normalized}
        </ReactMarkdown>
      </div>
    );
  }
);

MarkdownRenderer.displayName = 'MarkdownRenderer';
