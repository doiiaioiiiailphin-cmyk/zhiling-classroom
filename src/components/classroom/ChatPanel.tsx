import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowUp,
  BookmarkCheck,
  Clock,
  Code2,
  FileText,
  Loader2,
  MessageSquareText,
  Paperclip,
  Radio,
  X,
} from 'lucide-react';
import { useSmoothStream } from '../../hooks/useSmoothStream';
import { useVirtualList } from '../../hooks/useVirtualList';
import { useAppStore } from '../../store/useAppStore';
import type { ChatMessage, SessionAttachmentItem } from '../../types/domain';
import {
  loadPanelScroll,
  savePanelScroll,
  type PanelScrollSnapshot,
} from '../../utils/classroomScrollMemory';
import { getPasteShortcutLabel } from '../../utils/desktopBridge';
import { IconButton } from '../ui/IconButton';
import { MarkdownRenderer } from '../ui/MarkdownRenderer';
import { Modal } from '../ui/Modal';
import { ThinkingDisclosure } from '../ui/ThinkingDisclosure';

const BOTTOM_SNAP_THRESHOLD_PX = 32;

function checkIsAtBottom(el: HTMLDivElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SNAP_THRESHOLD_PX;
}

interface ChatMessageRowProps {
  message: ChatMessage;
  onTimestampClick: (ms: number) => void;
  onPreviewImage: (att: SessionAttachmentItem) => void;
}

const ChatMessageRow: React.FC<ChatMessageRowProps> = React.memo(
  ({ message, onTimestampClick, onPreviewImage }) => {
    const isUser = message.role === 'user';
    const isLiveMessage = Boolean(message.isStreaming);
    const isActivelyStreamingContent = Boolean(message.isStreaming && !message.isThinking);

    const { text: smoothContent, isAnimating: isContentAnimating } = useSmoothStream(
      message.content,
      isUser ? false : isLiveMessage
    );

    if (isUser) {
      return (
        <div className="flex flex-col items-end gap-2">
          {message.attachments && message.attachments.length > 0 && (
            <div className="flex flex-wrap justify-end gap-2 max-w-[82%]">
              {message.attachments.map((att) =>
                att.kind === 'material' ? (
                  <div
                    key={att.id}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-[#BEDAFF] bg-[#F0F4FF] px-3 py-1.5 text-[14px] text-[#1456F0]"
                  >
                    <FileText className="w-4 h-4 shrink-0" />
                    <span className="truncate max-w-48">{att.fileName}</span>
                  </div>
                ) : (
                  <button
                    key={att.id}
                    type="button"
                    onClick={() => onPreviewImage(att)}
                    className="rounded-xl overflow-hidden border border-[#DEE0E3] bg-[#F8F9FA] hover:border-[#1456F0] transition-colors cursor-pointer"
                  >
                    <img
                      src={att.url}
                      alt={att.fileName}
                      className="max-h-36 max-w-56 object-cover block"
                    />
                  </button>
                )
              )}
            </div>
          )}
          <div className="max-w-[82%] rounded-2xl rounded-tr-sm bg-[#EBF2FF] px-4 py-2.5 text-[15px] leading-relaxed text-[#1F2329] whitespace-pre-wrap break-words">
            {message.content}
          </div>
        </div>
      );
    }

    const hasThinking =
      Boolean(message.thinking && message.thinking.trim().length > 0) ||
      Boolean(message.isThinking);
    const hasVisibleContent = smoothContent.length > 0;

    return (
      <div className={`w-full py-1 space-y-2.5 ${isLiveMessage ? 'animate-stream-block' : ''}`}>
        {hasThinking && (
          <ThinkingDisclosure
            thinking={message.thinking}
            isThinking={Boolean(message.isThinking)}
            thinkingSeconds={message.thinkingSeconds}
          />
        )}

        {hasVisibleContent ? (
          <MarkdownRenderer
            content={smoothContent}
            isStreaming={isActivelyStreamingContent || isContentAnimating}
            onTimestampClick={onTimestampClick}
          />
        ) : message.isStreaming && !message.isThinking ? (
          <div className="py-0.5 text-[14px] font-medium thinking-shimmer inline-block">
            正在生成回答...
          </div>
        ) : null}
      </div>
    );
  }
);

ChatMessageRow.displayName = 'ChatMessageRow';

interface ChatComposerProps {
  isSendingChat: boolean;
  onSend: (text: string, attachments?: SessionAttachmentItem[]) => Promise<void>;
}

const ChatComposer: React.FC<ChatComposerProps> = React.memo(({ isSendingChat, onSend }) => {
  const prefill = useAppStore((s) => s.chatDraftPrefill);
  const clearChatDraftPrefill = useAppStore((s) => s.clearChatDraftPrefill);
  const uploadSessionAttachment = useAppStore((s) => s.uploadSessionAttachment);
  const segments = useAppStore((s) => s.segments);

  const [input, setInput] = useState('');
  const [pendingAttachments, setPendingAttachments] = useState<SessionAttachmentItem[]>([]);
  const [uploadingCount, setUploadingCount] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const handledPrefillSeqRef = useRef<number>(0);

  useEffect(() => {
    if (!prefill) return;
    if (prefill.seq <= handledPrefillSeqRef.current) return;
    handledPrefillSeqRef.current = prefill.seq;
    clearChatDraftPrefill();
    setInput(prefill.text);
    if (prefill.attachments && prefill.attachments.length > 0) {
      setPendingAttachments((prev) => {
        const existingIds = new Set(prev.map((p) => p.id));
        const merged = [...prev];
        for (const item of prefill.attachments ?? []) {
          if (!existingIds.has(item.id)) merged.push(item);
        }
        return merged.slice(0, 6);
      });
    }
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
    });
  }, [prefill, clearChatDraftPrefill]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = '36px';
    el.style.height = `${Math.min(el.scrollHeight, 144)}px`;
  }, [input]);

  const handleFilesUpload = async (files: FileList | File[]) => {
    const list = Array.from(files).slice(0, 4);
    if (list.length === 0) return;
    setUploadingCount((c) => c + list.length);
    try {
      for (const file of list) {
        const isImg = file.type.startsWith('image/');
        const uploaded = await uploadSessionAttachment(file, {
          fileName: file.name || `paste_${Date.now()}.png`,
          kind: isImg ? 'image' : 'material',
        });
        if (uploaded) {
          setPendingAttachments((prev) => [...prev.slice(-5), uploaded]);
        }
      }
    } finally {
      setUploadingCount((c) => Math.max(0, c - list.length));
    }
  };

  const handleSubmit = async (overridePrompt?: string) => {
    const text = (overridePrompt ?? input).trim();
    if (!text || isSendingChat || uploadingCount > 0) return;
    const atts = pendingAttachments.length > 0 ? [...pendingAttachments] : undefined;
    if (!overridePrompt) {
      setInput('');
      setPendingAttachments([]);
    }
    try {
      await onSend(text, atts);
    } catch {
      if (!overridePrompt) {
        setInput(text);
        if (atts) setPendingAttachments(atts);
      }
    }
  };

  const confusedCount = segments.reduce(
    (acc, seg) =>
      acc +
      seg.utterances.filter((u) => u.isBookmarked && u.bookmarkKind === 'confused').length,
    0
  );

  return (
    <div
      className="px-4 pt-2.5 pb-4 border-t border-[#ECEEF2] bg-white shrink-0 space-y-2.5"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        if (e.dataTransfer.files?.length) {
          void handleFilesUpload(e.dataTransfer.files);
        }
      }}
    >
      {/* 防走神快捷指令胶囊栏 */}
      <div className="flex items-center gap-2 overflow-x-auto pb-0.5">
        <button
          type="button"
          disabled={isSendingChat || segments.length === 0}
          onClick={() =>
            void handleSubmit(
              '我刚才走神了几分钟，请结合最近几分钟的最新课堂转写，用精炼要点帮我快速补上刚才讲的核心逻辑与结论，并附带 `[MM:SS]` 时间戳。'
            )
          }
          className="h-8 px-3 rounded-lg border border-[#DEE0E3] bg-[#F8F9FA] hover:border-[#BEDAFF] hover:bg-[#EBF2FF] hover:text-[#1456F0] disabled:opacity-45 text-[14px] text-[#4E5969] inline-flex items-center gap-1.5 shrink-0 transition-colors cursor-pointer"
        >
          <Clock className="w-3.5 h-3.5 text-[#1456F0]" />
          <span>速览最近 3 分钟</span>
        </button>

        <button
          type="button"
          disabled={isSendingChat || segments.length === 0}
          onClick={() =>
            void handleSubmit(
              confusedCount > 0
                ? '请逐一针对我在本堂课标记的所有「待搞懂」难点书签，结合前后上下文深入浅出地串讲清楚，并标注对应 `[MM:SS]` 时间点。'
                : '请帮我排查本堂课目前已讲内容中最容易混淆或出错的难点，并结合 `[MM:SS]` 时间点做通俗拆解。'
            )
          }
          className="h-8 px-3 rounded-lg border border-[#DEE0E3] bg-[#F8F9FA] hover:border-[#BEDAFF] hover:bg-[#EBF2FF] hover:text-[#1456F0] disabled:opacity-45 text-[14px] text-[#4E5969] inline-flex items-center gap-1.5 shrink-0 transition-colors cursor-pointer"
        >
          <BookmarkCheck className="w-3.5 h-3.5 text-[#1456F0]" />
          <span>
            {confusedCount > 0 ? `串讲我的不懂点 (${confusedCount})` : '拆解本课易错难点'}
          </span>
        </button>

        <button
          type="button"
          disabled={isSendingChat || segments.length === 0}
          onClick={() =>
            void handleSubmit(
              '请完整提炼并规范排版最近讲解涉及的核心数学公式、状态转移方程或算法伪代码，说明每个符号的含义。'
            )
          }
          className="h-8 px-3 rounded-lg border border-[#DEE0E3] bg-[#F8F9FA] hover:border-[#BEDAFF] hover:bg-[#EBF2FF] hover:text-[#1456F0] disabled:opacity-45 text-[14px] text-[#4E5969] inline-flex items-center gap-1.5 shrink-0 transition-colors cursor-pointer"
        >
          <Code2 className="w-3.5 h-3.5 text-[#1456F0]" />
          <span>提炼公式与代码</span>
        </button>
      </div>

      {/* 待发送图片/讲义附件预览栏 */}
      {(pendingAttachments.length > 0 || uploadingCount > 0) && (
        <div className="flex items-center gap-2 flex-wrap">
          {pendingAttachments.map((att) => (
            <div
              key={att.id}
              className="relative group inline-flex items-center gap-2 rounded-lg border border-[#BEDAFF] bg-[#F0F4FF] px-2.5 py-1.5 text-[14px] text-[#1456F0]"
            >
              {att.kind !== 'material' ? (
                <img
                  src={att.url}
                  alt={att.fileName}
                  className="w-8 h-8 rounded object-cover border border-white"
                />
              ) : (
                <FileText className="w-4 h-4 shrink-0" />
              )}
              <span className="truncate max-w-36">{att.fileName}</span>
              <button
                type="button"
                onClick={() =>
                  setPendingAttachments((prev) => prev.filter((item) => item.id !== att.id))
                }
                className="w-5 h-5 rounded-full hover:bg-[#DCE8FF] flex items-center justify-center cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
          {uploadingCount > 0 && (
            <div className="inline-flex items-center gap-1.5 text-[14px] text-[#646A73] px-2">
              <Loader2 className="w-4 h-4 animate-spin text-[#1456F0]" />
              <span>正在上传附件...</span>
            </div>
          )}
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="image/png,image/jpeg,image/webp,.pdf,.md,.txt,.py,.cpp,.c,.java"
        className="hidden"
        onChange={(e) => {
          if (e.target.files?.length) {
            void handleFilesUpload(e.target.files);
            e.target.value = '';
          }
        }}
      />

      <div className="rounded-xl border border-[#DEE0E3] bg-white px-3 py-2 focus-within:border-[#1456F0] focus-within:ring-2 focus-within:ring-[#1456F0]/15 transition-all flex items-end gap-2">
        <IconButton
          icon={Paperclip}
          variant="ghost"
          tooltip={`上传截图或参考讲义（支持直接 ${getPasteShortcutLabel()} 粘贴截图）`}
          onClick={() => fileInputRef.current?.click()}
        />

        <textarea
          ref={textareaRef}
          rows={1}
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            const el = e.currentTarget;
            el.style.height = '36px';
            el.style.height = `${Math.min(el.scrollHeight, 144)}px`;
          }}
          onPaste={(e) => {
            const files: File[] = [];
            for (const item of Array.from(e.clipboardData.items)) {
              if (item.kind === 'file') {
                const f = item.getAsFile();
                if (f) files.push(f);
              }
            }
            if (files.length > 0) {
              e.preventDefault();
              void handleFilesUpload(files);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void handleSubmit();
            }
          }}
          placeholder={`询问本堂课要点、直接 ${getPasteShortcutLabel()} 粘贴板书截图提问...`}
          className="flex-1 min-h-[36px] max-h-36 py-[6px] resize-none bg-transparent text-[15px] leading-[24px] text-[#1F2329] placeholder-[#646A73] focus:outline-none"
        />

        <IconButton
          icon={ArrowUp}
          variant="primary"
          tooltip="发送提问"
          disabled={!input.trim() || isSendingChat || uploadingCount > 0}
          onClick={() => void handleSubmit()}
        />
      </div>
    </div>
  );
});

ChatComposer.displayName = 'ChatComposer';

export const ChatPanel: React.FC = React.memo(() => {
  const sessionId = useAppStore((s) => s.activeSession?.id ?? null);
  const messages = useAppStore((s) => s.messages);
  const segmentCount = useAppStore((s) => s.segments.length);
  const isSendingChat = useAppStore((s) => s.isSendingChat);
  const sendChatQuestion = useAppStore((s) => s.sendChatQuestion);
  const jumpToTranscript = useAppStore((s) => s.jumpToTranscript);

  const [previewAttachment, setPreviewAttachment] = useState<SessionAttachmentItem | null>(
    null
  );

  const contentWrapperRef = useRef<HTMLDivElement | null>(null);
  const isAtBottomRef = useRef<boolean>(true);
  const lastScrollTopRef = useRef<number>(0);
  const programmaticTargetTopRef = useRef<number | null>(null);
  const touchStartYRef = useRef<number | null>(null);
  const restoredSessionIdRef = useRef<string | null>(null);
  const restoreRefineRafRef = useRef<number | null>(null);
  const restoreRefineRaf2Ref = useRef<number | null>(null);
  const isRestoringScrollRef = useRef<boolean>(false);
  const saveScrollTimerRef = useRef<number | null>(null);
  const latestScrollSnapshotRef = useRef<{
    sessionId: string;
    snapshot: PanelScrollSnapshot;
  } | null>(null);

  const handleTimestampJump = useCallback(
    (ms: number) => {
      jumpToTranscript({ timestampMs: ms });
    },
    [jumpToTranscript]
  );

  const getItemKey = useCallback(
    (index: number) => {
      const msg = messages[index];
      return msg ? (msg.clientKey ?? msg.id) : String(index);
    },
    [messages]
  );

  const estimateSize = useCallback(
    (index: number) => {
      const msg = messages[index];
      if (!msg) return 120;
      if (msg.role === 'user') {
        const imgExtra = msg.attachments?.length ? 148 : 0;
        return Math.max(52, Math.min(340, Math.ceil(msg.content.length / 26) * 26 + 28 + imgExtra));
      }
      return Math.max(120, Math.min(960, Math.ceil(msg.content.length * 0.42) + 76));
    },
    [messages]
  );

  const {
    scrollRef,
    measureElement,
    notifyScroll,
    scrollToIndexInstant,
    scrollToOffsetInstant,
    getAnchorAtScrollTop,
    range,
  } = useVirtualList({
    count: messages.length,
    getItemKey,
    estimateSize,
    gap: 24,
    overscanPx: 800,
  });

  const cancelPendingRestore = useCallback(() => {
    if (restoreRefineRafRef.current !== null) {
      window.cancelAnimationFrame(restoreRefineRafRef.current);
      restoreRefineRafRef.current = null;
    }
    if (restoreRefineRaf2Ref.current !== null) {
      window.cancelAnimationFrame(restoreRefineRaf2Ref.current);
      restoreRefineRaf2Ref.current = null;
    }
    isRestoringScrollRef.current = false;
  }, []);

  const flushSavedChatScroll = useCallback(() => {
    if (saveScrollTimerRef.current !== null) {
      window.clearTimeout(saveScrollTimerRef.current);
      saveScrollTimerRef.current = null;
    }
    const pending = latestScrollSnapshotRef.current;
    if (pending) {
      savePanelScroll(pending.sessionId, 'chat', pending.snapshot);
    }
  }, []);

  const captureCurrentChatScroll = useCallback(() => {
    if (!sessionId || messages.length === 0) return;
    if (restoredSessionIdRef.current !== sessionId || isRestoringScrollRef.current) return;
    const container = scrollRef.current;
    if (!container) return;

    const scrollTop = Math.max(0, Math.round(container.scrollTop));
    const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
    const atBottom = maxScrollTop > 40 && maxScrollTop - scrollTop <= 36;

    const anchor = getAnchorAtScrollTop(scrollTop);
    const msg = anchor ? messages[anchor.index] : undefined;
    const anchorKey = msg ? msg.id : undefined;
    const domKey = msg ? (msg.clientKey ?? msg.id) : undefined;
    let anchorOffsetPx = anchor ? Math.round(anchor.offsetPx) : 0;

    if (domKey) {
      const anchorEl = container.querySelector<HTMLElement>(
        `[data-virtual-key="${CSS.escape(domKey)}"]`
      );
      if (anchorEl) {
        anchorOffsetPx = Math.round(
          container.getBoundingClientRect().top - anchorEl.getBoundingClientRect().top
        );
      }
    }

    latestScrollSnapshotRef.current = {
      sessionId,
      snapshot: {
        anchorKey,
        anchorOffsetPx,
        scrollTop,
        atBottom,
        updatedAt: Date.now(),
      },
    };

    if (saveScrollTimerRef.current !== null) {
      window.clearTimeout(saveScrollTimerRef.current);
    }
    saveScrollTimerRef.current = window.setTimeout(() => {
      flushSavedChatScroll();
    }, 180);
  }, [sessionId, messages, scrollRef, getAnchorAtScrollTop, flushSavedChatScroll]);

  useEffect(() => {
    const handlePageHide = () => flushSavedChatScroll();
    window.addEventListener('pagehide', handlePageHide);
    window.addEventListener('beforeunload', handlePageHide);
    return () => {
      window.removeEventListener('pagehide', handlePageHide);
      window.removeEventListener('beforeunload', handlePageHide);
      flushSavedChatScroll();
      cancelPendingRestore();
    };
  }, [sessionId, flushSavedChatScroll, cancelPendingRestore]);

  // 打开历史课堂时恢复左侧对话列表上一次拖动到的位置
  useEffect(() => {
    if (!sessionId || messages.length === 0) return;
    if (restoredSessionIdRef.current === sessionId) return;

    restoredSessionIdRef.current = sessionId;
    latestScrollSnapshotRef.current = null;

    const saved = loadPanelScroll(sessionId, 'chat');
    if (!saved) return;

    cancelPendingRestore();

    if (saved.atBottom) {
      isAtBottomRef.current = true;
      isRestoringScrollRef.current = true;
      scrollToIndexInstant(messages.length - 1, 0);
      restoreRefineRafRef.current = window.requestAnimationFrame(() => {
        restoreRefineRafRef.current = null;
        restoreRefineRaf2Ref.current = window.requestAnimationFrame(() => {
          restoreRefineRaf2Ref.current = null;
          const container = scrollRef.current;
          if (container) {
            const bottomTop = Math.max(0, container.scrollHeight - container.clientHeight);
            programmaticTargetTopRef.current = bottomTop;
            container.scrollTop = bottomTop;
            lastScrollTopRef.current = container.scrollTop;
            notifyScroll();
          }
          isRestoringScrollRef.current = false;
        });
      });
      return;
    }

    isAtBottomRef.current = false;
    const anchorIndex = saved.anchorKey
      ? messages.findIndex((m) => m.id === saved.anchorKey || m.clientKey === saved.anchorKey)
      : -1;

    if (anchorIndex >= 0) {
      isRestoringScrollRef.current = true;
      const targetMsg = messages[anchorIndex];
      const domKeyToLock = targetMsg.clientKey ?? targetMsg.id;
      const desiredOffsetPx = saved.anchorOffsetPx;
      const coarseTop = scrollToIndexInstant(anchorIndex, Math.max(0, desiredOffsetPx));
      if (coarseTop !== null) {
        programmaticTargetTopRef.current = coarseTop;
        lastScrollTopRef.current = coarseTop;
      }
      restoreRefineRafRef.current = window.requestAnimationFrame(() => {
        restoreRefineRafRef.current = null;
        restoreRefineRaf2Ref.current = window.requestAnimationFrame(() => {
          restoreRefineRaf2Ref.current = null;
          const container = scrollRef.current;
          if (container) {
            const anchorEl = container.querySelector<HTMLElement>(
              `[data-virtual-key="${CSS.escape(domKeyToLock)}"]`
            );
            if (anchorEl) {
              const delta =
                anchorEl.getBoundingClientRect().top -
                container.getBoundingClientRect().top +
                desiredOffsetPx;
              if (Math.abs(delta) >= 2) {
                const refinedTop = Math.max(0, container.scrollTop + delta);
                programmaticTargetTopRef.current = refinedTop;
                container.scrollTop = refinedTop;
                lastScrollTopRef.current = container.scrollTop;
                notifyScroll();
              }
            }
          }
          isRestoringScrollRef.current = false;
        });
      });
    } else if (saved.scrollTop > 0) {
      programmaticTargetTopRef.current = saved.scrollTop;
      scrollToOffsetInstant(saved.scrollTop);
      lastScrollTopRef.current = saved.scrollTop;
    }
  }, [
    sessionId,
    messages,
    cancelPendingRestore,
    scrollToIndexInstant,
    scrollToOffsetInstant,
    scrollRef,
    notifyScroll,
  ]);

  const followBottomIfAlreadyAtBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el || !isAtBottomRef.current) return;
    const targetTop = Math.max(0, el.scrollHeight - el.clientHeight);
    if (Math.abs(el.scrollTop - targetTop) < 1) return;
    programmaticTargetTopRef.current = targetTop;
    el.scrollTop = targetTop;
    lastScrollTopRef.current = el.scrollTop;
    notifyScroll();
  }, [notifyScroll, scrollRef]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || isRestoringScrollRef.current) return;
    isAtBottomRef.current = checkIsAtBottom(el);
    lastScrollTopRef.current = el.scrollTop;
  }, [scrollRef]);

  useEffect(() => {
    const wrapper = contentWrapperRef.current;
    if (!wrapper) return;

    const observer = new ResizeObserver(() => {
      if (isAtBottomRef.current && !isRestoringScrollRef.current) {
        followBottomIfAlreadyAtBottom();
      }
    });
    observer.observe(wrapper);

    return () => {
      observer.disconnect();
    };
  }, [followBottomIfAlreadyAtBottom, messages.length === 0]);

  const handleScroll = () => {
    notifyScroll();
    const el = scrollRef.current;
    if (!el) return;
    const currentTop = el.scrollTop;

    if (
      programmaticTargetTopRef.current !== null &&
      Math.abs(currentTop - programmaticTargetTopRef.current) <= 2
    ) {
      programmaticTargetTopRef.current = null;
      lastScrollTopRef.current = currentTop;
      return;
    }
    programmaticTargetTopRef.current = null;

    if (currentTop < lastScrollTopRef.current - 1) {
      isAtBottomRef.current = false;
    } else {
      isAtBottomRef.current = checkIsAtBottom(el);
    }
    lastScrollTopRef.current = currentTop;
    captureCurrentChatScroll();
  };

  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    cancelPendingRestore();
    if (e.deltaY < 0) {
      isAtBottomRef.current = false;
      programmaticTargetTopRef.current = null;
    }
  };

  const handleTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    cancelPendingRestore();
    if (e.touches.length > 0) {
      touchStartYRef.current = e.touches[0].clientY;
    }
  };

  const handleTouchMove = (e: React.TouchEvent<HTMLDivElement>) => {
    if (e.touches.length > 0 && touchStartYRef.current !== null) {
      const deltaY = e.touches[0].clientY - touchStartYRef.current;
      if (deltaY > 4) {
        isAtBottomRef.current = false;
        programmaticTargetTopRef.current = null;
      }
    }
  };

  const handleSend = useCallback(
    async (text: string, attachments?: SessionAttachmentItem[]) => {
      const el = scrollRef.current;
      if (el) {
        isAtBottomRef.current = checkIsAtBottom(el);
      }
      await sendChatQuestion(text, attachments);
    },
    [scrollRef, sendChatQuestion]
  );

  const visibleMessages =
    range.endIndex >= range.startIndex
      ? messages.slice(range.startIndex, range.endIndex + 1)
      : [];

  return (
    <section className="h-full flex flex-col bg-white">
      <div className="h-12 px-5 border-b border-[#ECEEF2] flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2 text-[15px] font-semibold text-[#1F2329]">
          <MessageSquareText
            className="w-[18px] h-[18px] text-[#1456F0]"
            strokeWidth={1.85}
          />
          <span>课堂实时问答</span>
        </div>

        <div className="flex items-center gap-1.5 text-[14px] text-[#4E5969]">
          <Radio className="w-4 h-4 text-[#1456F0]" strokeWidth={1.9} />
          <span>已注入 {segmentCount} 段实时转写上下文</span>
        </div>
      </div>

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        onWheel={handleWheel}
        onPointerDown={cancelPendingRestore}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        className="flex-1 overflow-y-auto px-6 py-5"
      >
        {messages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center px-6 space-y-3">
            <div className="w-12 h-12 rounded-2xl bg-[#EBF2FF] text-[#1456F0] flex items-center justify-center">
              <MessageSquareText className="w-6 h-6" strokeWidth={1.8} />
            </div>
            <div className="text-[16px] font-medium text-[#1F2329]">
              基于本堂课实时内容的多模态 AI 助教
            </div>
            <p className="max-w-sm text-[14px] leading-relaxed text-[#4E5969]">
              右侧课堂转写与讲义会自动作为上下文。您可随时粘贴板书截图、点击下方快捷胶囊追回走神内容，或点击回答中的时间戳直达原话。
            </p>
          </div>
        ) : (
          <div
            ref={contentWrapperRef}
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '24px',
              paddingTop: `${range.topSpacerPx}px`,
              paddingBottom: `${range.bottomSpacerPx + 8}px`,
            }}
          >
            {visibleMessages.map((msg) => {
              const itemKey = msg.clientKey ?? msg.id;
              return (
                <div key={itemKey} data-virtual-key={itemKey} ref={measureElement}>
                  <ChatMessageRow
                    message={msg}
                    onTimestampClick={handleTimestampJump}
                    onPreviewImage={setPreviewAttachment}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>

      <ChatComposer isSendingChat={isSendingChat} onSend={handleSend} />

      <Modal
        open={Boolean(previewAttachment)}
        onClose={() => setPreviewAttachment(null)}
        title={previewAttachment?.fileName ?? '课堂图片预览'}
        widthClass="max-w-4xl"
      >
        {previewAttachment && (
          <div className="p-4 bg-[#F5F6F7] flex items-center justify-center max-h-[80vh] overflow-auto">
            <img
              src={previewAttachment.url}
              alt={previewAttachment.fileName}
              className="max-w-full max-h-[74vh] rounded-lg object-contain"
            />
          </div>
        )}
      </Modal>
    </section>
  );
});

ChatPanel.displayName = 'ChatPanel';
