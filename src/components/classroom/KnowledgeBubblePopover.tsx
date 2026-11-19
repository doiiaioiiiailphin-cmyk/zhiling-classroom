import React, { useState } from 'react';
import {
  useFloating,
  autoUpdate,
  offset,
  flip,
  shift,
  useClick,
  useDismiss,
  useRole,
  useInteractions,
  FloatingPortal,
} from '@floating-ui/react';
import { AlertCircle, MessageSquareQuote } from 'lucide-react';
import type { KnowledgeSegment, SegmentDetailedExplanation } from '../../types/domain';
import { useAppStore } from '../../store/useAppStore';
import { MarkdownRenderer } from '../ui/MarkdownRenderer';
import { ThinkingDisclosure } from '../ui/ThinkingDisclosure';
import { Tooltip } from '../ui/Tooltip';

interface KnowledgeBubblePopoverProps {
  segment: KnowledgeSegment;
}

export const KnowledgeBubblePopover: React.FC<KnowledgeBubblePopoverProps> = ({
  segment,
}) => {
  const fetchSegmentExplanation = useAppStore((s) => s.fetchSegmentExplanation);
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [streamingThinking, setStreamingThinking] = useState('');
  const [streamStage, setStreamStage] = useState<'thinking' | 'generating'>('thinking');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [detail, setDetail] = useState<SegmentDetailedExplanation | undefined>(
    segment.detailedExplanation
  );

  const resolvedDetail = segment.detailedExplanation ?? detail;

  const { refs, floatingStyles, context } = useFloating({
    open: isOpen,
    onOpenChange: (nextOpen) => {
      setIsOpen(nextOpen);
      if (nextOpen && !resolvedDetail && !isLoading) {
        setIsLoading(true);
        setStreamingThinking('');
        setStreamStage('thinking');
        setErrorMessage(null);
        fetchSegmentExplanation(segment.id, {
          onThinkingDelta: (delta) => {
            setStreamingThinking((prev) => prev + delta);
          },
          onStageChange: (stage) => {
            setStreamStage(stage);
          },
        })
          .then((res) => setDetail(res))
          .catch((err: unknown) => {
            setErrorMessage(
              err instanceof Error ? err.message : '生成知识点解析失败，请检查模型配置'
            );
          })
          .finally(() => setIsLoading(false));
      }
    },
    placement: 'left-start',
    whileElementsMounted: autoUpdate,
    middleware: [offset(10), flip({ padding: 14 }), shift({ padding: 14 })],
  });

  const click = useClick(context);
  const dismiss = useDismiss(context, { outsidePress: true, escapeKey: true });
  const role = useRole(context, { role: 'dialog' });

  const { getReferenceProps, getFloatingProps } = useInteractions([
    click,
    dismiss,
    role,
  ]);

  const triggerButton = (
    <button
      ref={refs.setReference}
      type="button"
      aria-label="查看知识点详解"
      {...getReferenceProps()}
      className={`w-9 h-9 rounded-xl flex items-center justify-center transition-all cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-[#1456F0]/30 ${
        isOpen
          ? 'bg-[#1456F0] text-white shadow-[0_4px_12px_rgba(20,86,240,0.28)]'
          : 'bg-[#EBF2FF] text-[#1456F0] hover:bg-[#1456F0] hover:text-white'
      }`}
    >
      <MessageSquareQuote className="w-[18px] h-[18px]" strokeWidth={1.85} />
    </button>
  );

  const activeThinking = resolvedDetail?.thinking ?? streamingThinking;
  const showThinkingSection =
    Boolean(activeThinking && activeThinking.trim().length > 0) ||
    (isLoading && streamStage === 'thinking');

  return (
    <>
      <Tooltip content={isOpen ? null : '查看本段知识点解析'} placement="left">
        {triggerButton}
      </Tooltip>

      {isOpen && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            style={floatingStyles}
            {...getFloatingProps()}
            className="z-50 w-[440px] max-w-[92vw] max-h-[75vh] overflow-y-auto rounded-2xl border border-[#DEE0E3] bg-white p-5 shadow-[0_16px_40px_rgba(31,35,41,0.16)] focus:outline-none"
          >
            {errorMessage && !resolvedDetail && !isLoading ? (
              <div className="flex items-start gap-2.5 rounded-xl bg-[#FFECE8]/70 px-3.5 py-3 text-[14px] leading-relaxed text-[#D83931]">
                <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" strokeWidth={1.9} />
                <span>{errorMessage}</span>
              </div>
            ) : (
              <div className="space-y-3.5">
                <div className="flex items-start gap-2.5 border-b border-[#ECEEF2] pb-3">
                  <div className="w-1.5 h-5 rounded-full bg-[#1456F0] mt-1 shrink-0" />
                  <h4 className="text-[16px] font-semibold text-[#1F2329] leading-snug">
                    {resolvedDetail?.title ?? segment.topicTitle}
                  </h4>
                </div>

                {showThinkingSection && (
                  <ThinkingDisclosure
                    thinking={activeThinking}
                    isThinking={isLoading && streamStage === 'thinking'}
                    thinkingSeconds={resolvedDetail?.thinkingSeconds}
                  />
                )}

                {isLoading && !resolvedDetail && streamStage === 'generating' && (
                  <div className="py-1 text-[14px] font-medium thinking-shimmer inline-block">
                    正在整理结构化知识点解析...
                  </div>
                )}

                {resolvedDetail && (
                  <div className="space-y-3.5 animate-stream-block">
                    <ul className="space-y-2">
                      {resolvedDetail.corePoints.map((pt, idx) => (
                        <li
                          key={idx}
                          className="flex items-start gap-2.5 text-[14px] leading-relaxed text-[#1F2329]"
                        >
                          <span className="mt-2 w-1.5 h-1.5 rounded-full bg-[#1456F0] shrink-0" />
                          <div className="min-w-0 flex-1">
                            <MarkdownRenderer content={pt} variant="compact" />
                          </div>
                        </li>
                      ))}
                    </ul>

                    <div className="rounded-xl bg-[#F5F6F7] px-3.5 py-3 text-[14px] leading-relaxed text-[#4E5969]">
                      <MarkdownRenderer
                        content={resolvedDetail.elaboration}
                        variant="compact"
                      />
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </FloatingPortal>
      )}
    </>
  );
};
