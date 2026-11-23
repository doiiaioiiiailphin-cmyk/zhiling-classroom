import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlignLeft,
  AudioLines,
  Bookmark,
  BookmarkCheck,
  BookmarkPlus,
  Check,
  HelpCircle,
  MessageSquarePlus,
  Pencil,
  Play,
  StickyNote,
  Trash2,
  UserRound,
  X,
} from 'lucide-react';
import { useAnimatedPresence } from '../../hooks/useAnimatedPresence';
import { useVirtualList } from '../../hooks/useVirtualList';
import { useAppStore } from '../../store/useAppStore';
import {
  loadPanelScroll,
  savePanelScroll,
  type PanelScrollSnapshot,
} from '../../utils/classroomScrollMemory';
import {
  getPasteShortcutLabel,
  isAndroidPlatform,
  useViewportLayout,
} from '../../utils/desktopBridge';
import {
  mapStickyAnchorsToUtterances,
  PAPER_THEMES,
  type UtteranceStickyAnchor,
} from '../../utils/stickyNoteTimestamps';
import type {
  HighlightedTerm,
  KnowledgeSegment,
  SessionAttachmentItem,
  UtterancePatch,
} from '../../types/domain';
import { DraggableBottomSheet } from '../ui/DraggableBottomSheet';
import { Modal } from '../ui/Modal';
import { Tooltip } from '../ui/Tooltip';
import { AudioPlaybackBar } from './AudioPlaybackBar';
import { HighlightedText } from './HighlightedText';
import { KnowledgeBubblePopover } from './KnowledgeBubblePopover';

type TranscriptUtterance = KnowledgeSegment['utterances'][number];

const LONG_PRESS_MS = 420;
const LONG_PRESS_FEEDBACK_MS = 110;
const LONG_PRESS_MOVE_TOLERANCE_PX = 10;

function isUtteranceInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest('button, input, textarea, a, [role="button"]'));
}

interface UtteranceRowProps {
  utterance: TranscriptUtterance;
  highlights: HighlightedTerm[];
  enableCorrection: boolean;
  enableHighlight: boolean;
  showDiarization: boolean;
  deferOffscreen: boolean;
  /** 仅在手机窄屏下隐藏桌面悬浮微操作栏；平板与桌面均保留悬浮微操作 */
  hideDesktopHoverBar: boolean;
  /** 手机与安卓平板均支持长按记录呼出快捷操作 */
  enableLongPress: boolean;
  isActiveAudio: boolean;
  isFocusedTarget: boolean;
  editRequestSeq: number;
  stickyAnchors?: UtteranceStickyAnchor[];
  onSeekAudio: (startTimeMs: number) => void;
  onRenameSpeaker: (speakerId: string, label: string) => Promise<void>;
  onUpdateUtterance: (utteranceId: string, patch: UtterancePatch) => Promise<void>;
  onAskAboutText: (quoted: string, timeLabel: string) => void;
  onFocusStickyAnchor: (noteId: string, timestampSec: number, charOffset: number) => void;
  onQuickNoteUtterance: (utterance: { startTimeMs: number; timestampText: string }) => void;
  onOpenMobileActions: (
    utterance: TranscriptUtterance,
    displayedText: string,
    anchor: { x: number; y: number }
  ) => void;
}

const UtteranceRow: React.FC<UtteranceRowProps> = React.memo(
  ({
    utterance,
    highlights,
    enableCorrection,
    enableHighlight,
    showDiarization,
    deferOffscreen,
    hideDesktopHoverBar,
    enableLongPress,
    isActiveAudio,
    isFocusedTarget,
    editRequestSeq,
    stickyAnchors,
    onSeekAudio,
    onRenameSpeaker,
    onUpdateUtterance,
    onAskAboutText,
    onFocusStickyAnchor,
    onQuickNoteUtterance,
    onOpenMobileActions,
  }) => {
    const [isEditingSpk, setIsEditingSpk] = useState(false);
    const [speakerDraft, setSpeakerDraft] = useState('');

    const [isEditingText, setIsEditingText] = useState(false);
    const [textDraft, setTextDraft] = useState('');

    const [isEditingNote, setIsEditingNote] = useState(false);
    const [noteDraft, setNoteDraft] = useState('');
    const [stickyPickerOpen, setStickyPickerOpen] = useState(false);
    const [isLongPressing, setIsLongPressing] = useState(false);

    const pressTimerRef = useRef<number | null>(null);
    const feedbackTimerRef = useRef<number | null>(null);
    const pressOriginRef = useRef<{ x: number; y: number } | null>(null);
    const longPressTriggeredRef = useRef<boolean>(false);
    const handledEditSeqRef = useRef<number>(editRequestSeq);

    const primarySticky = stickyAnchors && stickyAnchors.length > 0 ? stickyAnchors[0] : null;
    const stickyTheme = primarySticky
      ? PAPER_THEMES[primarySticky.paperColor] ?? PAPER_THEMES.cream
      : null;

    const displayedText =
      enableCorrection && utterance.isRefined ? utterance.refinedText : utterance.rawText;

    const clearLongPressTimers = useCallback(() => {
      if (pressTimerRef.current !== null) {
        window.clearTimeout(pressTimerRef.current);
        pressTimerRef.current = null;
      }
      if (feedbackTimerRef.current !== null) {
        window.clearTimeout(feedbackTimerRef.current);
        feedbackTimerRef.current = null;
      }
      pressOriginRef.current = null;
      setIsLongPressing(false);
    }, []);

    useEffect(() => clearLongPressTimers, [clearLongPressTimers]);

    useEffect(() => {
      if (editRequestSeq > handledEditSeqRef.current) {
        handledEditSeqRef.current = editRequestSeq;
        setTextDraft(displayedText);
        setIsEditingText(true);
      }
    }, [editRequestSeq, displayedText]);

    const handleRowPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
      if (!enableLongPress || isEditingText || isEditingNote || isEditingSpk) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (isUtteranceInteractiveTarget(e.target)) return;

      clearLongPressTimers();
      longPressTriggeredRef.current = false;
      const anchor = { x: e.clientX, y: e.clientY };
      pressOriginRef.current = anchor;

      feedbackTimerRef.current = window.setTimeout(() => {
        setIsLongPressing(true);
      }, LONG_PRESS_FEEDBACK_MS);

      pressTimerRef.current = window.setTimeout(() => {
        longPressTriggeredRef.current = true;
        clearLongPressTimers();
        try {
          navigator.vibrate?.(16);
        } catch {
          // ignore unsupported vibration API
        }
        try {
          window.getSelection()?.removeAllRanges();
        } catch {
          // ignore selection errors
        }
        onOpenMobileActions(utterance, displayedText, anchor);
      }, LONG_PRESS_MS);
    };

    const handleRowPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
      const origin = pressOriginRef.current;
      if (!origin) return;
      const dist = Math.hypot(e.clientX - origin.x, e.clientY - origin.y);
      if (dist > LONG_PRESS_MOVE_TOLERANCE_PX) {
        clearLongPressTimers();
      }
    };

    const handleRowContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
      if (!enableLongPress || isEditingText || isEditingNote || isEditingSpk) return;
      if (isUtteranceInteractiveTarget(e.target)) return;
      e.preventDefault();
      if (!longPressTriggeredRef.current) {
        clearLongPressTimers();
        onOpenMobileActions(utterance, displayedText, { x: e.clientX, y: e.clientY });
      }
    };

    const commitRename = async () => {
      const trimmed = speakerDraft.trim();
      setIsEditingSpk(false);
      if (trimmed && trimmed !== utterance.speakerLabel) {
        await onRenameSpeaker(utterance.speakerId, trimmed);
      }
    };

    const commitTextEdit = async () => {
      const trimmed = textDraft.trim();
      setIsEditingText(false);
      if (trimmed && trimmed !== displayedText) {
        await onUpdateUtterance(utterance.id, { refinedText: trimmed });
      }
    };

    const commitNoteEdit = async () => {
      setIsEditingNote(false);
      const trimmed = noteDraft.trim();
      if (trimmed !== (utterance.userNote ?? '')) {
        await onUpdateUtterance(utterance.id, { userNote: trimmed });
      }
    };

    const toggleConfusedBookmark = () => {
      const nextBookmarked = !utterance.isBookmarked;
      void onUpdateUtterance(utterance.id, {
        isBookmarked: nextBookmarked,
        bookmarkKind: nextBookmarked ? 'confused' : null,
      });
    };

    const handleStickyGradientClick = () => {
      if (!stickyAnchors || stickyAnchors.length === 0) return;
      if (stickyAnchors.length === 1) {
        const only = stickyAnchors[0];
        onFocusStickyAnchor(only.noteId, only.timestampSec, only.charOffset);
      } else {
        setStickyPickerOpen((v) => !v);
      }
    };

    return (
      <div
        data-utterance-id={utterance.id}
        data-has-sticky-anchor={primarySticky ? 'true' : undefined}
        onPointerDown={handleRowPointerDown}
        onPointerMove={handleRowPointerMove}
        onPointerUp={clearLongPressTimers}
        onPointerCancel={clearLongPressTimers}
        onPointerLeave={clearLongPressTimers}
        onContextMenu={handleRowContextMenu}
        className={`relative group rounded-lg px-2.5 py-2 -mx-2.5 space-y-1.5 transition-all duration-150 ${
          enableLongPress && !isEditingText && !isEditingNote && !isEditingSpk
            ? 'mobile-longpress-target'
            : ''
        } ${
          isLongPressing
            ? 'scale-[0.985] bg-[#EBF2FF]/85 ring-1 ring-[#1456F0]/30'
            : isFocusedTarget
              ? 'bg-[#EBF2FF] ring-2 ring-[#1456F0]/30'
              : isActiveAudio
                ? 'bg-[#F0F4FF]/80 border-l-[3px] border-[#1456F0]'
                : 'hover:bg-[#F8F9FA]'
        }`}
        style={
          deferOffscreen
            ? { contentVisibility: 'auto', containIntrinsicSize: 'auto 68px' }
            : undefined
        }
      >
        {/* 便签时间戳命中的右侧纸色渐变：点击直接跳转至便签中对应时间戳位置 */}
        {primarySticky && stickyTheme && (
          <>
            <div
              aria-hidden="true"
              style={{
                background: `linear-gradient(90deg, transparent 0%, ${stickyTheme.gradientMid} 52%, ${stickyTheme.gradientEnd} 100%)`,
                borderRight: `3px solid ${stickyTheme.edgeAccent}`,
              }}
              className="pointer-events-none absolute inset-y-0 right-0 w-[44%] rounded-r-lg transition-opacity"
            />
            <button
              type="button"
              aria-label={`跳转到便签「${primarySticky.noteTitle}」的 [${primarySticky.timestampText}] 位置`}
              onClick={handleStickyGradientClick}
              title={
                stickyAnchors && stickyAnchors.length > 1
                  ? `该行关联 ${stickyAnchors.length} 个便签时间戳，点击选择跳转`
                  : `点击直达便签「${primarySticky.noteTitle}」[${primarySticky.timestampText}]${
                      primarySticky.linePreview ? `：${primarySticky.linePreview}` : ''
                    }`
              }
              className="absolute inset-y-0 right-0 w-7 z-10 rounded-r-lg cursor-pointer hover:bg-black/5 transition-colors"
            />
          </>
        )}

        <div className="relative z-10 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2.5 flex-wrap min-w-0">
            {showDiarization && (
              <>
                {isEditingSpk ? (
                  <input
                    type="text"
                    value={speakerDraft}
                    autoFocus
                    onChange={(e) => setSpeakerDraft(e.target.value)}
                    onBlur={() => void commitRename()}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void commitRename();
                      if (e.key === 'Escape') setIsEditingSpk(false);
                    }}
                    className="h-8 w-40 rounded-lg border border-[#1456F0] bg-white px-2.5 text-[14px] text-[#1F2329] focus:outline-none"
                  />
                ) : (
                  <Tooltip content="点击修改讲话人备注" placement="top">
                    <button
                      type="button"
                      onClick={() => {
                        setSpeakerDraft(utterance.speakerLabel);
                        setIsEditingSpk(true);
                      }}
                      className="inline-flex items-center gap-1.5 rounded-md bg-[#F0F4FF] hover:bg-[#DCE8FF] px-2.5 py-1 text-[14px] font-medium text-[#1456F0] whitespace-nowrap shrink-0 transition-colors cursor-pointer"
                    >
                      <UserRound className="w-3.5 h-3.5 shrink-0" strokeWidth={2} />
                      <span>{utterance.speakerLabel}</span>
                    </button>
                  </Tooltip>
                )}
              </>
            )}

            <Tooltip content="点击从该时间点回听课堂原声" placement="top">
              <button
                type="button"
                onClick={() => onSeekAudio(utterance.startTimeMs)}
                className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[14px] text-[#646A73] hover:bg-[#EBF2FF] hover:text-[#1456F0] tabular-nums transition-colors cursor-pointer"
              >
                <Play className="w-3 h-3 fill-current opacity-70" />
                <span>{utterance.timestampText}</span>
              </button>
            </Tooltip>

            {utterance.isBookmarked && (
              <span
                className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[14px] font-medium ${
                  utterance.bookmarkKind === 'confused'
                    ? 'bg-[#FFF299] text-[#1F2329]'
                    : 'bg-[#EBF2FF] text-[#1456F0]'
                }`}
              >
                <HelpCircle className="w-3.5 h-3.5" />
                <span>{utterance.bookmarkKind === 'confused' ? '待搞懂' : '重点'}</span>
              </span>
            )}
          </div>

          {/* 右侧微操作栏（桌面与平板悬浮显示；手机窄屏改为长按呼出操作抽屉）+ 便签纸色直达角标 */}
          <div className="flex items-center gap-1 shrink-0">
            {!hideDesktopHoverBar && (
              <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                <Tooltip content="追问 AI 这句话" placement="top">
                  <button
                    type="button"
                    onClick={() => onAskAboutText(displayedText, utterance.timestampText)}
                    className="w-7 h-7 rounded-md hover:bg-[#EBF2FF] text-[#646A73] hover:text-[#1456F0] flex items-center justify-center cursor-pointer"
                  >
                    <MessageSquarePlus className="w-4 h-4" />
                  </button>
                </Tooltip>

                <Tooltip content="把此句时间锚点记到便签" placement="top">
                  <button
                    type="button"
                    onClick={() => onQuickNoteUtterance(utterance)}
                    className="w-7 h-7 rounded-md hover:bg-[#F7F0D6] text-[#646A73] hover:text-[#6F5414] flex items-center justify-center cursor-pointer"
                  >
                    <StickyNote className="w-4 h-4" />
                  </button>
                </Tooltip>

                <Tooltip
                  content={utterance.isBookmarked ? '取消难点书签' : '标记为「没听懂」待复习'}
                  placement="top"
                >
                  <button
                    type="button"
                    onClick={toggleConfusedBookmark}
                    className={`w-7 h-7 rounded-md hover:bg-[#EBF2FF] flex items-center justify-center cursor-pointer ${
                      utterance.isBookmarked
                        ? 'text-[#1456F0]'
                        : 'text-[#646A73] hover:text-[#1456F0]'
                    }`}
                  >
                    <Bookmark className="w-4 h-4" />
                  </button>
                </Tooltip>

                <Tooltip content="手动编辑修正此句转写并添加批注" placement="top">
                  <button
                    type="button"
                    onClick={() => {
                      setTextDraft(displayedText);
                      setIsEditingText(true);
                    }}
                    className="w-7 h-7 rounded-md hover:bg-[#EBF2FF] text-[#646A73] hover:text-[#1456F0] flex items-center justify-center cursor-pointer"
                  >
                    <Pencil className="w-4 h-4" />
                  </button>
                </Tooltip>
              </div>
            )}

            {primarySticky && stickyTheme && (
              <div className="relative">
                <Tooltip
                  content={
                    stickyAnchors && stickyAnchors.length > 1
                      ? `本句关联 ${stickyAnchors.length} 个便签时间戳，点击选择跳转`
                      : `便签「${primarySticky.noteTitle}」· ${
                          primarySticky.linePreview || `[${primarySticky.timestampText}]`
                        }（点击直达）`
                  }
                  placement="top"
                >
                  <button
                    type="button"
                    data-sticky-jump-pill={primarySticky.timestampText}
                    onClick={handleStickyGradientClick}
                    style={{
                      backgroundColor: stickyTheme.chipBg,
                      borderColor: stickyTheme.chipBorder,
                      color: stickyTheme.chipText,
                    }}
                    className="h-7 px-2 rounded-md border text-[14px] font-mono tabular-nums inline-flex items-center gap-1 hover:brightness-95 shadow-2xs transition-all cursor-pointer"
                  >
                    <StickyNote className="w-3.5 h-3.5 shrink-0" />
                    <span>{primarySticky.timestampText}</span>
                    {stickyAnchors && stickyAnchors.length > 1 && (
                      <span className="font-sans text-[14px]">+{stickyAnchors.length - 1}</span>
                    )}
                  </button>
                </Tooltip>

                {stickyPickerOpen && stickyAnchors && stickyAnchors.length > 1 && (
                  <div
                    onMouseLeave={() => setStickyPickerOpen(false)}
                    className="absolute right-0 top-8 z-30 w-64 rounded-xl border border-[#E5D8A8] bg-[#FFFDF8] p-1.5 shadow-lg space-y-1"
                  >
                    {stickyAnchors.map((anchor) => {
                      const t = PAPER_THEMES[anchor.paperColor] ?? PAPER_THEMES.cream;
                      return (
                        <button
                          key={`${anchor.noteId}-${anchor.timestampSec}`}
                          type="button"
                          style={{
                            backgroundColor: t.bodyBg,
                            borderColor: t.border,
                          }}
                          onClick={() => {
                            setStickyPickerOpen(false);
                            onFocusStickyAnchor(
                              anchor.noteId,
                              anchor.timestampSec,
                              anchor.charOffset
                            );
                          }}
                          className="w-full rounded-lg border px-2.5 py-1.5 text-left hover:brightness-97 transition-all cursor-pointer space-y-0.5"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-[14px] font-medium text-[#1F2329] truncate">
                              {anchor.noteTitle}
                            </span>
                            <span
                              style={{ color: t.chipText }}
                              className="text-[14px] font-mono tabular-nums shrink-0"
                            >
                              [{anchor.timestampText}]
                            </span>
                          </div>
                          {anchor.linePreview && (
                            <div className="text-[14px] text-[#646A73] truncate">
                              {anchor.linePreview}
                            </div>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="relative z-10 pl-0.5">
          {isEditingText ? (
            <div className="space-y-2 pt-1">
              <textarea
                rows={2}
                value={textDraft}
                autoFocus
                onChange={(e) => setTextDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void commitTextEdit();
                  }
                  if (e.key === 'Escape') setIsEditingText(false);
                }}
                className="w-full rounded-lg border border-[#1456F0] bg-white px-3 py-2 text-[15px] text-[#1F2329] focus:outline-none"
              />
              <div className="flex items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setIsEditingText(false);
                    setNoteDraft(utterance.userNote ?? '');
                    setIsEditingNote(true);
                  }}
                  className="text-[14px] font-medium text-[#1456F0] hover:underline cursor-pointer"
                >
                  {utterance.userNote ? '编辑个人批注' : '+ 添加个人批注'}
                </button>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setIsEditingText(false)}
                    className="h-8 px-3 rounded-lg border border-[#DEE0E3] bg-white text-[14px] text-[#4E5969] inline-flex items-center gap-1 cursor-pointer"
                  >
                    <X className="w-3.5 h-3.5" />
                    <span>取消</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => void commitTextEdit()}
                    className="h-8 px-3 rounded-lg bg-[#1456F0] text-white text-[14px] font-medium inline-flex items-center gap-1 cursor-pointer"
                  >
                    <Check className="w-3.5 h-3.5" />
                    <span>保存修改</span>
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <HighlightedText
              text={displayedText}
              highlights={highlights}
              enabled={enableHighlight}
            />
          )}
        </div>

        {/* 个人批注显示与行内编辑 */}
        {isEditingNote ? (
          <div className="mt-1.5 flex items-center gap-2">
            <input
              type="text"
              value={noteDraft}
              autoFocus
              placeholder="输入个人听课批注（回车保存，清空即删除）..."
              onChange={(e) => setNoteDraft(e.target.value)}
              onBlur={() => void commitNoteEdit()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void commitNoteEdit();
                if (e.key === 'Escape') setIsEditingNote(false);
              }}
              className="flex-1 h-9 rounded-lg border border-[#1456F0] bg-white px-3 text-[14px] text-[#1F2329] focus:outline-none"
            />
          </div>
        ) : utterance.userNote ? (
          <div
            role="button"
            tabIndex={0}
            onClick={() => {
              setNoteDraft(utterance.userNote ?? '');
              setIsEditingNote(true);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                setNoteDraft(utterance.userNote ?? '');
                setIsEditingNote(true);
              }
            }}
            className="mt-1 rounded-lg border-l-[3px] border-[#3370FF] bg-[#F0F4FF]/80 px-3 py-1.5 text-[14px] text-[#4E5969] cursor-pointer hover:bg-[#EBF2FF]"
          >
            批注：{utterance.userNote}
          </div>
        ) : null}
      </div>
    );
  }
);

UtteranceRow.displayName = 'UtteranceRow';

interface SegmentCardProps {
  segment: KnowledgeSegment;
  visibleUtterances: TranscriptUtterance[];
  segmentImages: SessionAttachmentItem[];
  isFirstChunk: boolean;
  isLastChunk: boolean;
  enableCorrection: boolean;
  enableResegment: boolean;
  enableHighlight: boolean;
  enableBubble: boolean;
  showDiarization: boolean;
  hideDesktopHoverBar: boolean;
  enableLongPress: boolean;
  activeAudioMs: number | null;
  focusedUtteranceId: string | null;
  isFocusedSegment: boolean;
  editRequest: { utteranceId: string; seq: number } | null;
  utteranceStickyMap: Map<string, UtteranceStickyAnchor[]>;
  onSeekAudio: (ms: number) => void;
  onRenameSpeaker: (speakerId: string, label: string) => Promise<void>;
  onUpdateUtterance: (utteranceId: string, patch: UtterancePatch) => Promise<void>;
  onAskAboutText: (quoted: string, timeLabel: string) => void;
  onAskWithImage: (att: SessionAttachmentItem) => void;
  onDeleteAttachment: (attachmentId: string) => void;
  onPreviewImage: (att: SessionAttachmentItem) => void;
  onFocusStickyAnchor: (noteId: string, timestampSec: number, charOffset: number) => void;
  onQuickNoteUtterance: (utterance: { startTimeMs: number; timestampText: string }) => void;
  onOpenMobileActions: (
    utterance: TranscriptUtterance,
    displayedText: string,
    anchor: { x: number; y: number }
  ) => void;
}

const SegmentCard: React.FC<SegmentCardProps> = React.memo(
  ({
    segment,
    visibleUtterances,
    segmentImages,
    isFirstChunk,
    isLastChunk,
    enableCorrection,
    enableResegment,
    enableHighlight,
    enableBubble,
    showDiarization,
    hideDesktopHoverBar,
    enableLongPress,
    activeAudioMs,
    focusedUtteranceId,
    isFocusedSegment,
    editRequest,
    utteranceStickyMap,
    onSeekAudio,
    onRenameSpeaker,
    onUpdateUtterance,
    onAskAboutText,
    onAskWithImage,
    onDeleteAttachment,
    onPreviewImage,
    onFocusStickyAnchor,
    onQuickNoteUtterance,
    onOpenMobileActions,
  }) => {
    const borderShapeClass =
      isFirstChunk && isLastChunk
        ? 'rounded-xl border p-5'
        : isFirstChunk
          ? 'rounded-t-xl border border-b-0 px-5 pt-5 pb-2.5'
          : isLastChunk
            ? 'rounded-b-xl border border-t-0 px-5 pt-2.5 pb-5'
            : 'border-x px-5 py-2.5';

    return (
      <div className={`flex items-start gap-3 ${isLastChunk ? 'pb-4' : ''}`}>
        {enableBubble && (
          <div className={isFirstChunk ? 'pt-3 shrink-0' : 'w-9 shrink-0'}>
            {isFirstChunk && <KnowledgeBubblePopover segment={segment} />}
          </div>
        )}

        <article
          className={`flex-1 min-w-0 bg-white shadow-[0_2px_8px_rgba(31,35,41,0.03)] space-y-3.5 transition-all ${borderShapeClass} ${
            isFocusedSegment && isFirstChunk && isLastChunk
              ? 'border-[#1456F0] ring-2 ring-[#1456F0]/20'
              : isFocusedSegment
                ? 'border-[#1456F0]'
                : 'border-[#DEE0E3]'
          }`}
        >
          {isFirstChunk && enableResegment && segment.topicTitle && (
            <div className="flex items-center gap-2 border-b border-[#F2F3F5] pb-2.5">
              <span className="w-2 h-2 rounded-full bg-[#1456F0] shrink-0" />
              <h3 className="text-[15px] font-semibold text-[#1F2329]">
                {segment.topicTitle}
              </h3>
            </div>
          )}

          <div className="space-y-3">
            {visibleUtterances.map((utt) => {
              const isPlayingHere =
                activeAudioMs !== null &&
                activeAudioMs >= utt.startTimeMs &&
                activeAudioMs <= Math.max(utt.endTimeMs, utt.startTimeMs + 2500);
              return (
                <UtteranceRow
                  key={utt.id}
                  utterance={utt}
                  highlights={segment.highlights}
                  enableCorrection={enableCorrection}
                  enableHighlight={enableHighlight}
                  showDiarization={showDiarization}
                  deferOffscreen={false}
                  hideDesktopHoverBar={hideDesktopHoverBar}
                  enableLongPress={enableLongPress}
                  isActiveAudio={isPlayingHere}
                  isFocusedTarget={focusedUtteranceId === utt.id}
                  editRequestSeq={
                    editRequest && editRequest.utteranceId === utt.id ? editRequest.seq : 0
                  }
                  stickyAnchors={utteranceStickyMap.get(utt.id)}
                  onSeekAudio={onSeekAudio}
                  onRenameSpeaker={onRenameSpeaker}
                  onUpdateUtterance={onUpdateUtterance}
                  onAskAboutText={onAskAboutText}
                  onFocusStickyAnchor={onFocusStickyAnchor}
                  onQuickNoteUtterance={onQuickNoteUtterance}
                  onOpenMobileActions={onOpenMobileActions}
                />
              );
            })}
          </div>

          {/* 挂载在该知识分段的课堂板书/PPT 截图卡片（仅尾块渲染） */}
          {isLastChunk && segmentImages.length > 0 && (
            <div className="pt-2 border-t border-[#F2F3F5] grid grid-cols-1 sm:grid-cols-2 gap-3">
              {segmentImages.map((img) => (
                <div
                  key={img.id}
                  className="group relative rounded-xl border border-[#DEE0E3] bg-[#F8F9FA] overflow-hidden"
                >
                  <button
                    type="button"
                    onClick={() => onPreviewImage(img)}
                    className="w-full block cursor-pointer"
                  >
                    <img
                      src={img.url}
                      alt={img.caption || img.fileName}
                      className="w-full h-40 object-cover block"
                    />
                  </button>
                  <div className="px-3 py-2 flex items-center justify-between gap-2 text-[14px]">
                    <span className="text-[#4E5969] truncate tabular-nums">
                      {img.timestampText ? `[${img.timestampText}] ` : ''}
                      {img.caption || '课堂画面快照'}
                    </span>
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        type="button"
                        onClick={() => onAskWithImage(img)}
                        className="px-2 py-0.5 rounded bg-[#EBF2FF] hover:bg-[#DCE8FF] text-[14px] font-medium text-[#1456F0] cursor-pointer"
                      >
                        追问此图
                      </button>
                      <button
                        type="button"
                        title="移除此截图"
                        onClick={() => onDeleteAttachment(img.id)}
                        className="w-6 h-6 rounded hover:bg-[#FFEBE8] text-[#646A73] hover:text-[#D93025] flex items-center justify-center cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </article>
      </div>
    );
  }
);

SegmentCard.displayName = 'SegmentCard';

const LiveRecordingBanner: React.FC<{ enableBubble: boolean }> = React.memo(
  ({ enableBubble }) => {
    const isRecording = useAppStore((s) => s.activeSession?.status === 'recording');
    const livePartialUtterance = useAppStore((s) => s.livePartialUtterance);

    if (!isRecording) return null;

    return (
      <div
        className={`mt-4 flex items-center gap-3 rounded-xl border border-[#BEDAFF] bg-[#EBF2FF]/75 px-4 py-3.5 text-[14px] text-[#1456F0] ${
          enableBubble ? 'ml-12' : ''
        }`}
      >
        <div className="flex items-center gap-1 h-4 shrink-0">
          <span className="w-1 h-4 rounded-full bg-[#1456F0] animate-wave-1" />
          <span className="w-1 h-4 rounded-full bg-[#1456F0] animate-wave-2" />
          <span className="w-1 h-4 rounded-full bg-[#1456F0] animate-wave-3" />
        </div>
        <span className="min-w-0 flex-1 break-words leading-relaxed">
          {livePartialUtterance
            ? `${livePartialUtterance.speakerLabel}：${livePartialUtterance.text}`
            : '正在实时拾音并同步识别讲话人语音...'}
        </span>
      </div>
    );
  }
);

LiveRecordingBanner.displayName = 'LiveRecordingBanner';

interface AnchoredUtteranceActionPopoverProps {
  open: boolean;
  anchor: { x: number; y: number } | null;
  onClose: () => void;
  children: React.ReactNode;
}

/**
 * 平板与宽屏（>=768px）长按转写记录后，在按压位置附近弹出的锚定浮层菜单：
 * 避免宽屏底部出现极窄的底部抽屉，同时支持进场与点击外侧平滑缩放淡出收回。
 */
const AnchoredUtteranceActionPopover: React.FC<AnchoredUtteranceActionPopoverProps> = ({
  open,
  anchor,
  onClose,
  children,
}) => {
  const { shouldRender, isVisible } = useAnimatedPresence(open, 200);
  const cachedChildrenRef = useRef<React.ReactNode>(children);
  const cachedAnchorRef = useRef<{ x: number; y: number }>(
    anchor ?? { x: 400, y: 260 }
  );
  if (open) {
    cachedChildrenRef.current = children;
    if (anchor) cachedAnchorRef.current = anchor;
  }

  if (!shouldRender) return null;

  const vw = typeof window !== 'undefined' ? window.innerWidth : 1024;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 768;
  const popW = Math.min(368, vw - 32);
  const estH = 388;
  const pos = open && anchor ? anchor : cachedAnchorRef.current;

  const left = Math.max(16, Math.min(pos.x - popW / 2, vw - popW - 16));
  const preferBelow = pos.y + 14 + estH <= vh - 16;
  const top = preferBelow
    ? Math.max(16, pos.y + 14)
    : Math.max(16, Math.min(pos.y - estH - 14, vh - estH - 16));

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="转写记录快捷操作"
      data-tablet-utterance-popover="true"
      className="fixed inset-0 z-[60]"
    >
      <div
        data-popover-backdrop="true"
        onClick={onClose}
        className={`absolute inset-0 bg-[#1F2329]/18 backdrop-blur-[1px] transition-opacity duration-200 ease-out ${
          isVisible ? 'opacity-100' : 'opacity-0'
        }`}
      />
      <div
        data-popover-panel="true"
        style={{
          left: `${left}px`,
          top: `${top}px`,
          width: `${popW}px`,
          maxHeight: `${vh - 32}px`,
          transformOrigin: preferBelow ? 'top center' : 'bottom center',
        }}
        className={`fixed z-10 rounded-2xl border border-[#DEE0E3] bg-white shadow-[0_18px_48px_rgba(31,35,41,0.18),0_4px_12px_rgba(31,35,41,0.06)] overflow-y-auto p-3.5 space-y-3 transition-[transform,opacity] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] ${
          isVisible
            ? 'opacity-100 scale-100 translate-y-0'
            : 'opacity-0 scale-95 translate-y-2'
        }`}
      >
        {open ? children : cachedChildrenRef.current}
      </div>
    </div>,
    document.body
  );
};

export const TranscriptPanel: React.FC = React.memo(() => {
  const sessionId = useAppStore((s) => s.activeSession?.id ?? null);
  const segments = useAppStore((s) => s.segments);
  const attachments = useAppStore((s) => s.attachments);
  const stickyNotes = useAppStore((s) => s.stickyNotes);
  const isRecording = useAppStore((s) => s.activeSession?.status === 'recording');
  const audioPlayback = useAppStore((s) => s.audioPlayback);
  const focusRequest = useAppStore((s) => s.transcriptFocusRequest);
  const clearTranscriptFocusRequest = useAppStore((s) => s.clearTranscriptFocusRequest);
  const focusStickyNoteTimestamp = useAppStore((s) => s.focusStickyNoteTimestamp);
  const quickNoteAtUtterance = useAppStore((s) => s.quickNoteAtUtterance);

  const enableCorrection = useAppStore(
    (s) => s.settings?.featureRouting.sentenceCorrection.enabled ?? true
  );
  const enableResegment = useAppStore(
    (s) => s.settings?.featureRouting.resegmentation.enabled ?? true
  );
  const enableHighlight = useAppStore(
    (s) => s.settings?.featureRouting.keyTermHighlight.enabled ?? true
  );
  const enableBubble = useAppStore(
    (s) => s.settings?.featureRouting.bubbleExplanation.enabled ?? true
  );
  const showDiarization = useAppStore((s) => s.settings?.enableSpeakerDiarization ?? true);

  const renameSpeaker = useAppStore((s) => s.renameSpeaker);
  const seekAudioPlayback = useAppStore((s) => s.seekAudioPlayback);
  const updateUtterance = useAppStore((s) => s.updateUtterance);
  const prefillChatComposer = useAppStore((s) => s.prefillChatComposer);
  const deleteSessionAttachment = useAppStore((s) => s.deleteSessionAttachment);
  const onlyBookmarks = useAppStore((s) => s.onlyBookmarksFilter);
  const setOnlyBookmarks = useAppStore((s) => s.setOnlyBookmarksFilter);
  const showNotice = useAppStore((s) => s.showNotice);

  const viewport = useViewportLayout();
  const hideDesktopHoverBar = viewport.isCompactWidth;
  const enableLongPress = viewport.isCompactPhoneLayout || isAndroidPlatform();
  const useBottomSheetForActions = viewport.isCompactWidth;

  const [focusedIds, setFocusedIds] = useState<{
    segmentId: string | null;
    utteranceId: string | null;
  }>({ segmentId: null, utteranceId: null });
  const [mobileActionTarget, setMobileActionTarget] = useState<{
    utterance: TranscriptUtterance;
    displayedText: string;
    anchor: { x: number; y: number };
  } | null>(null);
  const [editRequest, setEditRequest] = useState<{
    utteranceId: string;
    seq: number;
  } | null>(null);
  const editSeqCounterRef = useRef<number>(0);
  const handledFocusSeqRef = useRef<number>(0);
  const focusTimerRef = useRef<number | null>(null);
  const utteranceRefineRafRef = useRef<number | null>(null);
  const restoredSessionIdRef = useRef<string | null>(null);
  const restoreRefineRafRef = useRef<number | null>(null);
  const restoreRefineRaf2Ref = useRef<number | null>(null);
  const isRestoringScrollRef = useRef<boolean>(false);
  const saveScrollTimerRef = useRef<number | null>(null);
  const latestScrollSnapshotRef = useRef<{
    sessionId: string;
    snapshot: PanelScrollSnapshot;
  } | null>(null);
  const [selectionBar, setSelectionBar] = useState<{
    text: string;
    x: number;
    y: number;
  } | null>(null);
  const [previewImage, setPreviewImage] = useState<SessionAttachmentItem | null>(null);

  const totalBookmarkCount = useMemo(
    () =>
      segments.reduce(
        (acc, seg) => acc + seg.utterances.filter((u) => u.isBookmarked).length,
        0
      ),
    [segments]
  );

  const utteranceStickyMap = useMemo(
    () => mapStickyAnchorsToUtterances(stickyNotes, segments),
    [stickyNotes, segments]
  );

  const handleQuickNoteUtterance = useCallback(
    (utterance: { startTimeMs: number; timestampText: string }) => {
      void quickNoteAtUtterance(utterance);
    },
    [quickNoteAtUtterance]
  );

  const handleOpenMobileActions = useCallback(
    (
      utterance: TranscriptUtterance,
      displayedText: string,
      anchor: { x: number; y: number }
    ) => {
      setMobileActionTarget({ utterance, displayedText, anchor });
    },
    []
  );

  // Android 返回键与 Esc 键优先关闭长按转写操作抽屉
  useEffect(() => {
    if (!mobileActionTarget) return;
    const win = window as unknown as {
      __zhilingHandleUtteranceSheetBack?: () => boolean;
    };
    const closeSheet = () => {
      setMobileActionTarget(null);
      return true;
    };
    win.__zhilingHandleUtteranceSheetBack = closeSheet;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setMobileActionTarget(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      if (win.__zhilingHandleUtteranceSheetBack === closeSheet) {
        delete win.__zhilingHandleUtteranceSheetBack;
      }
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [mobileActionTarget]);

  const imagesBySegment = useMemo(() => {
    const map = new Map<string, SessionAttachmentItem[]>();
    const fallbackSegId = segments[segments.length - 1]?.id;
    for (const att of attachments) {
      if (att.kind === 'material') continue;
      const sid = att.segmentId || fallbackSegId;
      if (!sid) continue;
      const list = map.get(sid) ?? [];
      list.push(att);
      map.set(sid, list);
    }
    return map;
  }, [attachments, segments]);

  const renderedSegments = useMemo(() => {
    const CHUNK_THRESHOLD = 32;
    const CHUNK_SIZE = 24;
    const rows: Array<{
      chunkKey: string;
      segment: KnowledgeSegment;
      visibleUtterances: TranscriptUtterance[];
      segmentImages: SessionAttachmentItem[];
      isFirstChunk: boolean;
      isLastChunk: boolean;
    }> = [];

    for (const segment of segments) {
      const base = enableCorrection
        ? segment.utterances.filter((utt) => !(utt.isRefined && !utt.refinedText.trim()))
        : segment.utterances;
      const visibleUtterances = onlyBookmarks
        ? base.filter((utt) => utt.isBookmarked)
        : base;
      const segmentImages = imagesBySegment.get(segment.id) ?? [];

      const shouldKeep = onlyBookmarks
        ? visibleUtterances.length > 0
        : segmentImages.length > 0 ||
          !enableCorrection ||
          segment.utterances.length === 0 ||
          visibleUtterances.length > 0;
      if (!shouldKeep) continue;

      if (visibleUtterances.length <= CHUNK_THRESHOLD) {
        rows.push({
          chunkKey: segment.id,
          segment,
          visibleUtterances,
          segmentImages,
          isFirstChunk: true,
          isLastChunk: true,
        });
      } else {
        const totalChunks = Math.ceil(visibleUtterances.length / CHUNK_SIZE);
        for (let c = 0; c < totalChunks; c += 1) {
          const slice = visibleUtterances.slice(c * CHUNK_SIZE, (c + 1) * CHUNK_SIZE);
          const isFirstChunk = c === 0;
          const isLastChunk = c === totalChunks - 1;
          rows.push({
            chunkKey: isFirstChunk ? segment.id : `${segment.id}::c${c}`,
            segment,
            visibleUtterances: slice,
            segmentImages: isLastChunk ? segmentImages : [],
            isFirstChunk,
            isLastChunk,
          });
        }
      }
    }
    return rows;
  }, [segments, enableCorrection, onlyBookmarks, imagesBySegment]);

  const getItemKey = useCallback(
    (index: number) => renderedSegments[index]?.chunkKey ?? String(index),
    [renderedSegments]
  );

  const estimateSize = useCallback(
    (index: number) => {
      const item = renderedSegments[index];
      if (!item) return 140;
      const imgRows = item.isLastChunk ? Math.ceil(item.segmentImages.length / 2) : 0;
      const headerH = item.isFirstChunk ? 64 : 16;
      const footerH = item.isLastChunk ? 36 : 12;
      return headerH + footerH + Math.max(1, item.visibleUtterances.length) * 76 + imgRows * 210;
    },
    [renderedSegments]
  );

  const {
    scrollRef,
    measureElement,
    notifyScroll,
    scrollToIndex,
    scrollToIndexInstant,
    scrollToOffsetInstant,
    getAnchorAtScrollTop,
    range,
  } = useVirtualList({
    count: renderedSegments.length,
    getItemKey,
    estimateSize,
    gap: 0,
    overscanPx: 750,
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

  const cancelPendingFocusRefine = useCallback(() => {
    if (utteranceRefineRafRef.current !== null) {
      window.cancelAnimationFrame(utteranceRefineRafRef.current);
      utteranceRefineRafRef.current = null;
    }
    cancelPendingRestore();
  }, [cancelPendingRestore]);

  const flushSavedTranscriptScroll = useCallback(() => {
    if (saveScrollTimerRef.current !== null) {
      window.clearTimeout(saveScrollTimerRef.current);
      saveScrollTimerRef.current = null;
    }
    const pending = latestScrollSnapshotRef.current;
    if (pending) {
      savePanelScroll(pending.sessionId, 'transcript', pending.snapshot);
    }
  }, []);

  const captureCurrentTranscriptScroll = useCallback(() => {
    if (!sessionId || onlyBookmarks || renderedSegments.length === 0) return;
    if (restoredSessionIdRef.current !== sessionId || isRestoringScrollRef.current) return;
    const container = scrollRef.current;
    if (!container) return;

    const scrollTop = Math.max(0, Math.round(container.scrollTop));
    const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
    const atBottom = maxScrollTop > 40 && maxScrollTop - scrollTop <= 36;

    const containerTop = container.getBoundingClientRect().top;
    const anchor = getAnchorAtScrollTop(scrollTop);
    let anchorKey = anchor ? renderedSegments[anchor.index]?.chunkKey : undefined;
    let anchorOffsetPx = anchor ? Math.round(anchor.offsetPx) : 0;

    if (anchorKey) {
      const anchorEl = container.querySelector<HTMLElement>(
        `[data-virtual-key="${CSS.escape(anchorKey)}"]`
      );
      if (anchorEl) {
        anchorOffsetPx = Math.round(containerTop - anchorEl.getBoundingClientRect().top);
      }
    }

    // 精确定位到视口顶部第一条可见句（免疫超长分段内 content-visibility: auto 高度估算偏差）
    let anchorUtteranceId: string | undefined;
    let anchorUtteranceOffsetPx: number | undefined;
    const uttNodes = container.querySelectorAll<HTMLElement>('[data-utterance-id]');
    for (const node of uttNodes) {
      const rect = node.getBoundingClientRect();
      if (rect.bottom > containerTop + 8) {
        const uid = node.dataset.utteranceId;
        if (uid) {
          anchorUtteranceId = uid;
          anchorUtteranceOffsetPx = Math.round(containerTop - rect.top);
          const parentSegEl = node.closest<HTMLElement>('[data-virtual-key]');
          if (parentSegEl?.dataset.virtualKey) {
            anchorKey = parentSegEl.dataset.virtualKey;
            anchorOffsetPx = Math.round(containerTop - parentSegEl.getBoundingClientRect().top);
          }
        }
        break;
      }
    }

    latestScrollSnapshotRef.current = {
      sessionId,
      snapshot: {
        anchorKey,
        anchorOffsetPx,
        anchorUtteranceId,
        anchorUtteranceOffsetPx,
        scrollTop,
        atBottom,
        updatedAt: Date.now(),
      },
    };

    if (saveScrollTimerRef.current !== null) {
      window.clearTimeout(saveScrollTimerRef.current);
    }
    saveScrollTimerRef.current = window.setTimeout(() => {
      flushSavedTranscriptScroll();
    }, 180);
  }, [
    sessionId,
    onlyBookmarks,
    renderedSegments,
    scrollRef,
    getAnchorAtScrollTop,
    flushSavedTranscriptScroll,
  ]);

  // 切出课堂或关闭窗口前立刻落盘最后浏览位置
  useEffect(() => {
    const handlePageHide = () => flushSavedTranscriptScroll();
    window.addEventListener('pagehide', handlePageHide);
    window.addEventListener('beforeunload', handlePageHide);
    return () => {
      window.removeEventListener('pagehide', handlePageHide);
      window.removeEventListener('beforeunload', handlePageHide);
      flushSavedTranscriptScroll();
    };
  }, [sessionId, flushSavedTranscriptScroll]);

  // 打开历史课堂时默认恢复到上一次拖动到的精确位置（若有跨课堂搜索定位请求则让位给定位请求）
  useEffect(() => {
    if (!sessionId || renderedSegments.length === 0 || onlyBookmarks) return;
    if (restoredSessionIdRef.current === sessionId) return;

    restoredSessionIdRef.current = sessionId;
    latestScrollSnapshotRef.current = null;

    if (useAppStore.getState().transcriptFocusRequest) {
      return;
    }

    const saved = loadPanelScroll(sessionId, 'transcript');
    if (!saved) return;

    cancelPendingRestore();

    if (saved.atBottom) {
      isRestoringScrollRef.current = true;
      const lastIdx = renderedSegments.length - 1;
      const lastEstH = estimateSize(lastIdx);
      const clientH = scrollRef.current?.clientHeight || 600;
      scrollToIndexInstant(lastIdx, Math.max(0, lastEstH - clientH));
      restoreRefineRafRef.current = window.requestAnimationFrame(() => {
        restoreRefineRafRef.current = null;
        restoreRefineRaf2Ref.current = window.requestAnimationFrame(() => {
          restoreRefineRaf2Ref.current = null;
          const container = scrollRef.current;
          if (container) {
            container.scrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
            notifyScroll();
          }
          isRestoringScrollRef.current = false;
        });
      });
      return;
    }

    let anchorIndex = -1;
    let uttIdxInSeg = -1;
    if (saved.anchorUtteranceId) {
      anchorIndex = renderedSegments.findIndex((r) => {
        const idx = r.visibleUtterances.findIndex((u) => u.id === saved.anchorUtteranceId);
        if (idx >= 0) {
          uttIdxInSeg = idx;
          return true;
        }
        return false;
      });
    }
    if (anchorIndex < 0 && saved.anchorKey) {
      anchorIndex = renderedSegments.findIndex(
        (r) => r.chunkKey === saved.anchorKey || r.segment.id === saved.anchorKey
      );
    }

    if (anchorIndex >= 0) {
      isRestoringScrollRef.current = true;
      const segItem = renderedSegments[anchorIndex];
      const anchorKeyToLock = segItem.chunkKey;
      const uttIdToLock = saved.anchorUtteranceId;
      const desiredUttOffsetPx = saved.anchorUtteranceOffsetPx ?? 0;
      const desiredSegOffsetPx = saved.anchorOffsetPx;

      let coarseOffset = Math.max(0, desiredSegOffsetPx);
      if (uttIdxInSeg >= 0 && segItem.visibleUtterances.length > 0) {
        const estSegH = estimateSize(anchorIndex);
        coarseOffset = Math.max(
          0,
          Math.round((uttIdxInSeg / segItem.visibleUtterances.length) * estSegH)
        );
      }

      scrollToIndexInstant(anchorIndex, coarseOffset);
      restoreRefineRafRef.current = window.requestAnimationFrame(() => {
        restoreRefineRafRef.current = null;
        restoreRefineRaf2Ref.current = window.requestAnimationFrame(() => {
          restoreRefineRaf2Ref.current = null;
          const container = scrollRef.current;
          if (container) {
            const containerTop = container.getBoundingClientRect().top;
            const uttEl = uttIdToLock
              ? container.querySelector<HTMLElement>(
                  `[data-utterance-id="${CSS.escape(uttIdToLock)}"]`
                )
              : null;
            if (uttEl) {
              const delta = uttEl.getBoundingClientRect().top - containerTop + desiredUttOffsetPx;
              if (Math.abs(delta) >= 2) {
                container.scrollTop = Math.max(0, container.scrollTop + delta);
                notifyScroll();
              }
            } else {
              const anchorEl = container.querySelector<HTMLElement>(
                `[data-virtual-key="${CSS.escape(anchorKeyToLock)}"]`
              );
              if (anchorEl) {
                const delta =
                  anchorEl.getBoundingClientRect().top - containerTop + desiredSegOffsetPx;
                if (Math.abs(delta) >= 2) {
                  container.scrollTop = Math.max(0, container.scrollTop + delta);
                  notifyScroll();
                }
              }
            }
          }
          isRestoringScrollRef.current = false;
        });
      });
    } else if (saved.scrollTop > 0) {
      scrollToOffsetInstant(saved.scrollTop);
    }
  }, [
    sessionId,
    renderedSegments,
    onlyBookmarks,
    cancelPendingRestore,
    estimateSize,
    scrollToIndexInstant,
    scrollToOffsetInstant,
    scrollRef,
    notifyScroll,
  ]);

  useEffect(() => {
    return () => {
      if (focusTimerRef.current !== null) {
        window.clearTimeout(focusTimerRef.current);
        focusTimerRef.current = null;
      }
      if (utteranceRefineRafRef.current !== null) {
        window.cancelAnimationFrame(utteranceRefineRafRef.current);
        utteranceRefineRafRef.current = null;
      }
      cancelPendingRestore();
    };
  }, [cancelPendingRestore]);

  // 响应来自对话时间戳角标或跨课堂搜索的一次性定位请求（严格按 seq 消费并清空，绝不随后续转写更新反复回跳）
  useEffect(() => {
    if (!focusRequest) return;
    if (focusRequest.seq <= handledFocusSeqRef.current) return;

    if (onlyBookmarks) {
      setOnlyBookmarks(false);
      return;
    }
    if (renderedSegments.length === 0) return;

    handledFocusSeqRef.current = focusRequest.seq;
    clearTranscriptFocusRequest();

    let targetIndex = -1;
    let targetSegId: string | null = focusRequest.segmentId ?? null;
    let targetUttId: string | null = focusRequest.utteranceId ?? null;

    if (targetUttId) {
      targetIndex = renderedSegments.findIndex((r) =>
        r.visibleUtterances.some((u) => u.id === targetUttId)
      );
      if (targetIndex >= 0) targetSegId = renderedSegments[targetIndex].segment.id;
    } else if (targetSegId) {
      targetIndex = renderedSegments.findIndex((r) => r.segment.id === targetSegId);
    } else if (focusRequest.timestampMs !== undefined) {
      const ts = focusRequest.timestampMs;
      let bestDist = Number.POSITIVE_INFINITY;
      renderedSegments.forEach((r, idx) => {
        for (const u of r.visibleUtterances) {
          const dist = Math.abs(u.startTimeMs - ts);
          if (dist < bestDist) {
            bestDist = dist;
            targetIndex = idx;
            targetSegId = r.segment.id;
            targetUttId = u.id;
          }
        }
      });
    }

    if (targetIndex >= 0) {
      scrollToIndex(targetIndex);
      cancelPendingFocusRefine();
      if (targetUttId) {
        const uttIdToLocate = targetUttId;
        utteranceRefineRafRef.current = window.requestAnimationFrame(() => {
          utteranceRefineRafRef.current = null;
          const container = scrollRef.current;
          if (!container) return;
          const uttEl = container.querySelector<HTMLElement>(
            `[data-utterance-id="${CSS.escape(uttIdToLocate)}"]`
          );
          if (uttEl) {
            const containerRect = container.getBoundingClientRect();
            const elRect = uttEl.getBoundingClientRect();
            if (elRect.top < containerRect.top + 8 || elRect.bottom > containerRect.bottom - 8) {
              uttEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
          }
        });
      }
      setFocusedIds({ segmentId: targetSegId, utteranceId: targetUttId });
      if (focusTimerRef.current !== null) {
        window.clearTimeout(focusTimerRef.current);
      }
      focusTimerRef.current = window.setTimeout(() => {
        focusTimerRef.current = null;
        setFocusedIds({ segmentId: null, utteranceId: null });
      }, 2600);
    }
  }, [
    focusRequest,
    onlyBookmarks,
    renderedSegments,
    scrollToIndex,
    scrollRef,
    setOnlyBookmarks,
    clearTranscriptFocusRequest,
    cancelPendingFocusRefine,
  ]);

  const handleAskAboutText = useCallback(
    (quoted: string, timeLabel?: string) => {
      const prefix = timeLabel ? `[${timeLabel}] ` : '';
      prefillChatComposer(`关于课堂中的这段内容：「${prefix}${quoted}」，请帮我深入解释：`);
      setSelectionBar(null);
    },
    [prefillChatComposer]
  );

  const handleAskWithImage = useCallback(
    (att: SessionAttachmentItem) => {
      prefillChatComposer(
        `请结合这张 [${att.timestampText ?? '00:00'}] 的课堂画面截图帮我讲解其中的要点与公式：`,
        [att]
      );
    },
    [prefillChatComposer]
  );

  const handleMouseUpSelection = () => {
    if (enableLongPress) return;
    const sel = window.getSelection();
    const text = sel?.toString().trim() ?? '';
    if (!text || text.length < 2 || !sel || sel.rangeCount === 0) {
      setSelectionBar(null);
      return;
    }
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      setSelectionBar(null);
      return;
    }
    setSelectionBar({
      text: text.slice(0, 360),
      x: Math.max(120, Math.min(window.innerWidth - 140, rect.left + rect.width / 2)),
      y: Math.max(56, rect.top - 46),
    });
  };

  const activeAudioMs =
    audioPlayback.visible && audioPlayback.isPlaying ? audioPlayback.currentMs : null;

  const visibleSlice =
    range.endIndex >= range.startIndex
      ? renderedSegments.slice(range.startIndex, range.endIndex + 1)
      : [];

  return (
    <section className="h-full flex flex-col bg-[#F5F6F7] relative">
      {/* 右侧栏顶栏：保持纯粹干净，工具均已收纳进顶栏 ··· 宫格 */}
      <div className="h-11 sm:h-12 px-3.5 sm:px-5 bg-white border-b border-[#ECEEF2] flex items-center justify-between gap-3 shrink-0">
        <div className="flex items-center gap-2 text-[15px] font-semibold text-[#1F2329] min-w-0">
          <AlignLeft className="w-[18px] h-[18px] text-[#1456F0] shrink-0" strokeWidth={1.85} />
          <span className="truncate">转写记录与知识点分段</span>
        </div>

        <div className="flex items-center gap-2.5 shrink-0">
          {onlyBookmarks && (
            <button
              type="button"
              onClick={() => setOnlyBookmarks(false)}
              className="h-7 px-2.5 rounded-lg bg-[#EBF2FF] hover:bg-[#DCE8FF] text-[#1456F0] text-[14px] font-medium inline-flex items-center gap-1.5 transition-colors cursor-pointer"
            >
              <Bookmark className="w-3.5 h-3.5" />
              <span>难点书签 ({totalBookmarkCount})</span>
              <X className="w-3.5 h-3.5" />
            </button>
          )}

          <span className="text-[14px] text-[#4E5969]">
            共 {segments.length} 段知识点
          </span>
        </div>
      </div>

      {/* 划词追问浮动工具条 */}
      {selectionBar && (
        <div
          style={{ left: `${selectionBar.x}px`, top: `${selectionBar.y}px` }}
          className="fixed z-40 -translate-x-1/2 rounded-xl border border-[#DEE0E3] bg-white shadow-lg px-2 py-1.5 flex items-center gap-1"
          onMouseDown={(e) => e.preventDefault()}
        >
          <button
            type="button"
            onClick={() => handleAskAboutText(selectionBar.text)}
            className="h-8 px-3 rounded-lg bg-[#1456F0] hover:bg-[#3370FF] text-white text-[14px] font-medium inline-flex items-center gap-1.5 cursor-pointer"
          >
            <MessageSquarePlus className="w-3.5 h-3.5" />
            <span>追问 AI</span>
          </button>
          <button
            type="button"
            onClick={() => setSelectionBar(null)}
            className="w-8 h-8 rounded-lg hover:bg-[#F2F3F5] text-[#646A73] flex items-center justify-center cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* 知识点分段流 */}
      <div
        ref={scrollRef}
        onWheel={cancelPendingFocusRefine}
        onTouchStart={cancelPendingFocusRefine}
        onPointerDown={cancelPendingFocusRefine}
        onScroll={() => {
          notifyScroll();
          captureCurrentTranscriptScroll();
          if (selectionBar) setSelectionBar(null);
        }}
        onMouseUp={handleMouseUpSelection}
        className={`flex-1 overflow-y-auto ${
          viewport.isCompactWidth ? 'px-3.5 pt-4 pb-24' : 'px-5 py-5'
        }`}
      >
        {renderedSegments.length === 0 && !isRecording ? (
          <div className="h-full flex flex-col items-center justify-center text-center px-6 space-y-3">
            <div className="w-12 h-12 rounded-2xl bg-[#EBF2FF] text-[#1456F0] flex items-center justify-center">
              <AudioLines className="w-6 h-6" strokeWidth={1.8} />
            </div>
            <div className="text-[16px] font-medium text-[#1F2329]">
              {onlyBookmarks ? '暂无标记的不懂点书签' : '等待开始课堂录音'}
            </div>
            <p className="max-w-sm text-[14px] leading-relaxed text-[#4E5969]">
              {onlyBookmarks
                ? '点击上方按钮可切回全部课堂转写记录。'
                : enableLongPress
                  ? '点击右上角蓝色麦克风开启录音。长按任意转写记录可标记「不懂」或直接以此时间戳创建便签，点击时间戳即可原声回听。'
                  : `点击右上角蓝色麦克风开启录音，或按 ${getPasteShortcutLabel()} 随时将板书截图锚定到时间轴中。点击任意句时间戳即可原声回听。`}
            </p>
          </div>
        ) : (
          <>
            {renderedSegments.length > 0 && (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  paddingTop: `${range.topSpacerPx}px`,
                  paddingBottom: `${range.bottomSpacerPx}px`,
                }}
              >
                {visibleSlice.map(
                  ({ chunkKey, segment, visibleUtterances, segmentImages, isFirstChunk, isLastChunk }) => (
                    <div
                      key={chunkKey}
                      data-virtual-key={chunkKey}
                      ref={measureElement}
                    >
                      <SegmentCard
                        segment={segment}
                        visibleUtterances={visibleUtterances}
                        segmentImages={segmentImages}
                        isFirstChunk={isFirstChunk}
                        isLastChunk={isLastChunk}
                        enableCorrection={enableCorrection}
                        enableResegment={enableResegment}
                        enableHighlight={enableHighlight}
                        enableBubble={enableBubble}
                        showDiarization={showDiarization}
                        hideDesktopHoverBar={hideDesktopHoverBar}
                        enableLongPress={enableLongPress}
                        activeAudioMs={activeAudioMs}
                        focusedUtteranceId={focusedIds.utteranceId}
                        isFocusedSegment={focusedIds.segmentId === segment.id}
                        editRequest={editRequest}
                        utteranceStickyMap={utteranceStickyMap}
                        onSeekAudio={seekAudioPlayback}
                        onRenameSpeaker={renameSpeaker}
                        onUpdateUtterance={updateUtterance}
                        onAskAboutText={handleAskAboutText}
                        onAskWithImage={handleAskWithImage}
                        onDeleteAttachment={(id) => void deleteSessionAttachment(id)}
                        onPreviewImage={setPreviewImage}
                        onFocusStickyAnchor={focusStickyNoteTimestamp}
                        onQuickNoteUtterance={handleQuickNoteUtterance}
                        onOpenMobileActions={handleOpenMobileActions}
                      />
                    </div>
                  )
                )}
              </div>
            )}

            <LiveRecordingBanner enableBubble={enableBubble} />
          </>
        )}
      </div>

      {/* 原声倍速点句回放条 */}
      <AudioPlaybackBar />

      {/* 长按转写记录快捷操作：手机窄屏使用可拖拽底部抽屉，平板/宽屏使用按压点锚定浮层，均带平滑收回动效 */}
      {(() => {
        const actionContent = mobileActionTarget ? (
          <>
            {/* 被长按记录上下文摘要卡片 */}
            <div className="rounded-xl border border-[#ECEEF2] bg-[#F7F8FA] px-3.5 py-2.5 space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="inline-flex items-center gap-1 rounded-md bg-[#EBF2FF] px-2 py-0.5 text-[14px] font-medium text-[#1456F0] shrink-0">
                    <UserRound className="w-3.5 h-3.5 shrink-0" />
                    <span className="truncate max-w-32">
                      {mobileActionTarget.utterance.speakerLabel}
                    </span>
                  </span>
                  <span className="text-[14px] font-mono text-[#646A73] tabular-nums shrink-0">
                    [{mobileActionTarget.utterance.timestampText}]
                  </span>
                </div>
                {mobileActionTarget.utterance.isBookmarked && (
                  <span className="inline-flex items-center gap-1 rounded-md bg-[#FFF299] px-2 py-0.5 text-[14px] font-medium text-[#1F2329] shrink-0">
                    <HelpCircle className="w-3.5 h-3.5" />
                    <span>待搞懂</span>
                  </span>
                )}
              </div>
              <p className="text-[14px] leading-relaxed text-[#4E5969] line-clamp-2">
                {mobileActionTarget.displayedText}
              </p>
            </div>

            {/* 核心双操作按钮：标不懂 + 直接以此时间戳创建便签 */}
            <div className="grid grid-cols-2 gap-2.5">
              <button
                type="button"
                data-utterance-action="toggle-confused"
                onClick={() => {
                  const u = mobileActionTarget.utterance;
                  const nextBookmarked = !u.isBookmarked;
                  setMobileActionTarget(null);
                  void updateUtterance(u.id, {
                    isBookmarked: nextBookmarked,
                    bookmarkKind: nextBookmarked ? 'confused' : null,
                  });
                  showNotice(
                    'info',
                    nextBookmarked
                      ? `已将 [${u.timestampText}] 标记为「待搞懂」`
                      : `已取消 [${u.timestampText}] 的「待搞懂」标记`
                  );
                }}
                className={`rounded-2xl border p-3.5 text-left transition-all active:scale-[0.97] cursor-pointer space-y-2 ${
                  mobileActionTarget.utterance.isBookmarked
                    ? 'border-[#BEDAFF] bg-[#EBF2FF] text-[#1456F0]'
                    : 'border-[#F2DD89] bg-[#FFFBEB] text-[#1F2329]'
                }`}
              >
                <div
                  className={`w-9 h-9 rounded-xl flex items-center justify-center ${
                    mobileActionTarget.utterance.isBookmarked
                      ? 'bg-white text-[#1456F0]'
                      : 'bg-[#FFF2B2] text-[#B45309]'
                  }`}
                >
                  {mobileActionTarget.utterance.isBookmarked ? (
                    <BookmarkCheck className="w-5 h-5" />
                  ) : (
                    <BookmarkPlus className="w-5 h-5" />
                  )}
                </div>
                <div className="space-y-0.5">
                  <div className="text-[15px] font-semibold">
                    {mobileActionTarget.utterance.isBookmarked
                      ? '取消标不懂'
                      : '标记为「不懂」'}
                  </div>
                  <div className="text-[14px] text-[#646A73] truncate">
                    {mobileActionTarget.utterance.isBookmarked
                      ? '移出难点书签'
                      : '加入难点书签复习'}
                  </div>
                </div>
              </button>

              <button
                type="button"
                data-utterance-action="create-sticky"
                onClick={() => {
                  const u = mobileActionTarget.utterance;
                  setMobileActionTarget(null);
                  void quickNoteAtUtterance(
                    { startTimeMs: u.startTimeMs, timestampText: u.timestampText },
                    viewport.isCompactPhoneLayout ? { forceNew: true } : undefined
                  );
                }}
                className="rounded-2xl border border-[#E7D8A2] bg-[#FCF7E3] text-[#1F2329] p-3.5 text-left transition-all active:scale-[0.97] cursor-pointer space-y-2"
              >
                <div className="w-9 h-9 rounded-xl bg-[#F4E7B6] text-[#7A5B14] flex items-center justify-center">
                  <StickyNote className="w-5 h-5" />
                </div>
                <div className="space-y-0.5">
                  <div className="text-[15px] font-semibold">创建时间戳便签</div>
                  <div className="text-[14px] text-[#646A73] truncate">
                    锚定 [{mobileActionTarget.utterance.timestampText}]
                  </div>
                </div>
              </button>
            </div>

            {/* 辅助快捷操作组 */}
            <div className="rounded-2xl border border-[#ECEEF2] bg-[#F8F9FA] divide-y divide-[#ECEEF2] overflow-hidden">
              <button
                type="button"
                data-utterance-action="ask-ai"
                onClick={() => {
                  const target = mobileActionTarget;
                  setMobileActionTarget(null);
                  handleAskAboutText(target.displayedText, target.utterance.timestampText);
                }}
                className="w-full min-h-[46px] px-4 py-2.5 flex items-center gap-3 text-[15px] font-medium text-[#1F2329] hover:bg-[#EBF2FF]/60 active:bg-[#EBF2FF] transition-colors cursor-pointer"
              >
                <MessageSquarePlus className="w-4 h-4 text-[#1456F0] shrink-0" />
                <span>追问 AI 这句话</span>
              </button>

              <button
                type="button"
                data-utterance-action="edit-text"
                onClick={() => {
                  const uid = mobileActionTarget.utterance.id;
                  setMobileActionTarget(null);
                  editSeqCounterRef.current += 1;
                  setEditRequest({ utteranceId: uid, seq: editSeqCounterRef.current });
                }}
                className="w-full min-h-[46px] px-4 py-2.5 flex items-center gap-3 text-[15px] font-medium text-[#1F2329] hover:bg-[#EBF2FF]/60 active:bg-[#EBF2FF] transition-colors cursor-pointer"
              >
                <Pencil className="w-4 h-4 text-[#4E5969] shrink-0" />
                <span>编辑文字或添加批注</span>
              </button>

              <button
                type="button"
                data-utterance-action="play-audio"
                onClick={() => {
                  const ms = mobileActionTarget.utterance.startTimeMs;
                  setMobileActionTarget(null);
                  seekAudioPlayback(ms);
                }}
                className="w-full min-h-[46px] px-4 py-2.5 flex items-center gap-3 text-[15px] font-medium text-[#1F2329] hover:bg-[#EBF2FF]/60 active:bg-[#EBF2FF] transition-colors cursor-pointer"
              >
                <Play className="w-4 h-4 text-[#4E5969] shrink-0" />
                <span>从 [{mobileActionTarget.utterance.timestampText}] 回放原声</span>
              </button>
            </div>

            {useBottomSheetForActions && (
              <button
                type="button"
                onClick={() => setMobileActionTarget(null)}
                className="w-full h-11 rounded-xl bg-[#F2F3F5] active:bg-[#E5E6EB] text-[15px] font-medium text-[#1F2329] transition-colors cursor-pointer"
              >
                取消
              </button>
            )}
          </>
        ) : null;

        return (
          <>
            <DraggableBottomSheet
              open={Boolean(mobileActionTarget) && useBottomSheetForActions}
              onClose={() => setMobileActionTarget(null)}
              ariaLabel="转写记录快捷操作"
              zIndexClass="z-[60]"
              maxWidthClass="w-full"
              panelClassName="bg-white"
              dataAttributes={{ 'data-mobile-utterance-sheet': 'true' }}
              showHandle
            >
              <div className="px-4 pt-1 pb-[calc(16px+env(safe-area-inset-bottom,0px))] space-y-3.5">
                {actionContent}
              </div>
            </DraggableBottomSheet>

            <AnchoredUtteranceActionPopover
              open={Boolean(mobileActionTarget) && !useBottomSheetForActions}
              anchor={mobileActionTarget?.anchor ?? null}
              onClose={() => setMobileActionTarget(null)}
            >
              {actionContent}
            </AnchoredUtteranceActionPopover>
          </>
        );
      })()}

      <Modal
        open={Boolean(previewImage)}
        onClose={() => setPreviewImage(null)}
        title={
          previewImage
            ? `${previewImage.timestampText ? `[${previewImage.timestampText}] ` : ''}${
                previewImage.caption || previewImage.fileName
              }`
            : '课堂画面快照'
        }
        widthClass="max-w-4xl"
      >
        {previewImage && (
          <div className="p-4 bg-[#F5F6F7] flex flex-col items-center gap-3 max-h-[82vh] overflow-auto">
            <img
              src={previewImage.url}
              alt={previewImage.fileName}
              className="max-w-full max-h-[72vh] rounded-lg object-contain"
            />
          </div>
        )}
      </Modal>
    </section>
  );
});

TranscriptPanel.displayName = 'TranscriptPanel';
