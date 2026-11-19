import React, { useEffect, useRef, useState } from 'react';
import { Atom, ChevronRight } from 'lucide-react';
import { useSmoothStream } from '../../hooks/useSmoothStream';
import { MarkdownRenderer } from './MarkdownRenderer';

interface ThinkingBodyProps {
  thinking: string;
  isThinking: boolean;
}

const ThinkingBody: React.FC<ThinkingBodyProps> = ({ thinking, isThinking }) => {
  const { text: smoothThinking, isAnimating } = useSmoothStream(thinking, isThinking);
  return (
    <div className="mt-1.5 mb-1 ml-[7px] border-l-2 border-[#E5E6EB] pl-3.5 py-0.5">
      <MarkdownRenderer
        content={smoothThinking || thinking}
        variant="thinking"
        isStreaming={isThinking && isAnimating}
      />
    </div>
  );
};

interface ThinkingDisclosureProps {
  thinking?: string;
  isThinking?: boolean;
  thinkingSeconds?: number;
  defaultExpanded?: boolean;
  className?: string;
}

/**
 * OpenAI / DeepSeek 极简无边框思维链组件：
 * - 默认全程自动收起（无论正在思考还是思考结束），仅在用户主动点击时展开
 * - 顶部为无背景轻量化状态行 + 旋转箭头，思考时呈现柔和流光动画与实时秒数
 * - 展开后仅保留左侧 2px 浅灰竖线导引，绝不内嵌卡片色块
 */
export const ThinkingDisclosure: React.FC<ThinkingDisclosureProps> = ({
  thinking = '',
  isThinking = false,
  thinkingSeconds,
  defaultExpanded = false,
  className = '',
}) => {
  const [expanded, setExpanded] = useState<boolean>(defaultExpanded);
  const [hasOpened, setHasOpened] = useState<boolean>(defaultExpanded);
  const [liveSeconds, setLiveSeconds] = useState<number>(0);
  const startTimeRef = useRef<number | null>(isThinking ? performance.now() : null);

  // 思考进行中计时器
  useEffect(() => {
    if (!isThinking) {
      return;
    }
    if (startTimeRef.current === null) {
      startTimeRef.current = performance.now();
    }
    const timer = window.setInterval(() => {
      if (startTimeRef.current !== null) {
        setLiveSeconds(
          Math.max(1, Math.floor((performance.now() - startTimeRef.current) / 1000))
        );
      }
    }, 500);
    return () => window.clearInterval(timer);
  }, [isThinking]);

  const hasContent = thinking.trim().length > 0;
  if (!hasContent && !isThinking) {
    return null;
  }

  const finalSeconds = thinkingSeconds ?? (liveSeconds > 0 ? liveSeconds : undefined);

  const labelText = isThinking
    ? liveSeconds > 0
      ? `正在深度思考 · ${liveSeconds} 秒`
      : '正在深度思考...'
    : finalSeconds
      ? `已深度思考（用时 ${finalSeconds} 秒）`
      : '已深度思考';

  const isExpandedVisible = expanded && hasContent;

  return (
    <div className={`select-text ${className}`}>
      <button
        type="button"
        onClick={() => {
          if (hasContent) {
            setHasOpened(true);
            setExpanded((prev) => !prev);
          }
        }}
        disabled={!hasContent}
        className={`group inline-flex items-center gap-1.5 py-0.5 text-[14px] transition-colors focus:outline-none ${
          hasContent
            ? 'cursor-pointer text-[#646A73] hover:text-[#1F2329]'
            : 'cursor-default text-[#646A73]'
        }`}
      >
        <Atom
          className={`w-[15px] h-[15px] shrink-0 transition-colors ${
            isThinking
              ? 'text-[#1456F0] animate-spin'
              : 'text-[#646A73] group-hover:text-[#1456F0]'
          }`}
          style={isThinking ? { animationDuration: '3.2s' } : undefined}
          strokeWidth={1.85}
        />

        <span className={isThinking ? 'thinking-shimmer font-medium' : 'font-medium'}>
          {labelText}
        </span>

        {hasContent && (
          <ChevronRight
            className={`w-4 h-4 shrink-0 text-[#86909C] group-hover:text-[#1F2329] transition-transform duration-200 ease-out ${
              isExpandedVisible ? 'rotate-90' : 'rotate-0'
            }`}
            strokeWidth={1.9}
          />
        )}
      </button>

      <div
        className={`grid transition-[grid-template-rows,opacity] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${
          isExpandedVisible ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
        }`}
      >
        <div className="overflow-hidden">
          {hasOpened && hasContent && (
            <ThinkingBody thinking={thinking} isThinking={isThinking} />
          )}
        </div>
      </div>
    </div>
  );
};
