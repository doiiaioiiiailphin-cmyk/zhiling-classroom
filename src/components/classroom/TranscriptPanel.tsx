import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlignLeft,
  AudioLines,
  Bookmark,
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
import { useVirtualList } from '../../hooks/useVirtualList';
import { useAppStore } from '../../store/useAppStore';
import { getPasteShortcutLabel } from '../../utils/desktopBridge';
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
import { Modal } from '../ui/Modal';
import { Tooltip } from '../ui/Tooltip';
import { AudioPlaybackBar } from './AudioPlaybackBar';
import { HighlightedText } from './HighlightedText';
import { KnowledgeBubblePopover } from './KnowledgeBubblePopover';

type TranscriptUtterance = KnowledgeSegment['utterances'][number];

interface UtteranceRowProps {
  utterance: TranscriptUtterance;
  highlights: HighlightedTerm[];
  enableCorrection: boolean;
  enableHighlight: boolean;
  showDiarization: boolean;
  deferOffscreen: boolean;
  isActiveAudio: boolean;
  isFocusedTarget: boolean;
  stickyAnchors?: UtteranceStickyAnchor[];
  onSeekAudio: (startTimeMs: number) => void;
  onRenameSpeaker: (speakerId: string, label: string) => Promise<void>;
  onUpdateUtterance: (utteranceId: string, patch: UtterancePatch) => Promise<void>;
  onAskAboutText: (quoted: string, timeLabel: string) => void;
  onFocusStickyAnchor: (noteId: string, timestampSec: number, charOffset: number) => void;
  onQuickNoteUtterance: (utterance: { startTimeMs: number; timestampText: string }) => void;
}

const UtteranceRow: React.FC<UtteranceRowProps> = React.memo(
  ({
    utterance,
    highlights,
    enableCorrection,
    enableHighlight,
    showDiarization,
    deferOffscreen,
    isActiveAudio,
    isFocusedTarget,
    stickyAnchors,
    onSeekAudio,
    onRenameSpeaker,
    onUpdateUtterance,
    onAskAboutText,
    onFocusStickyAnchor,
    onQuickNoteUtterance,
  }) => {
    const [isEditingSpk, setIsEditingSpk] = useState(false);
    const [speakerDraft, setSpeakerDraft] = useState('');

    const [isEditingText, setIsEditingText] = useState(false);
    const [textDraft, setTextDraft] = useState('');

    const [isEditingNote, setIsEditingNote] = useState(false);
    const [noteDraft, setNoteDraft] = useState('');
    const [stickyPickerOpen, setStickyPickerOpen] = useState(false);

    const primarySticky = stickyAnchors && stickyAnchors.length > 0 ? stickyAnchors[0] : null;
    const stickyTheme = primarySticky
      ? PAPER_THEMES[primarySticky.paperColor] ?? PAPER_THEMES.cream
      : null;

    const displayedText =
      enableCorrection && utterance.isRefined ? utterance.refinedText : utterance.rawText;

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
        className={`relative group rounded-lg px-2.5 py-2 -mx-2.5 space-y-1.5 transition-colors ${
          isFocusedTarget
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
                      className="inline-flex items-center gap-1.5 rounded-md bg-[#F0F4FF] hover:bg-[#DCE8FF] px-2.5 py-1 text-[14px] font-medium text-[#1456F0] transition-colors cursor-pointer"
                    >
                      <UserRound className="w-3.5 h-3.5" strokeWidth={2} />
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

          {/* 右侧微操作栏 + 便签纸色直达角标 */}
          <div className="flex items-center gap-1 shrink-0">
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
  enableCorrection: boolean;
  enableResegment: boolean;
  enableHighlight: boolean;
  enableBubble: boolean;
  showDiarization: boolean;
  activeAudioMs: number | null;
  focusedUtteranceId: string | null;
  isFocusedSegment: boolean;
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
}

const SegmentCard: React.FC<SegmentCardProps> = React.memo(
  ({
    segment,
    visibleUtterances,
    segmentImages,
    enableCorrection,
    enableResegment,
    enableHighlight,
    enableBubble,
    showDiarization,
    activeAudioMs,
    focusedUtteranceId,
    isFocusedSegment,
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
  }) => {
    const isLargeSegment = visibleUtterances.length > 24;

    return (
      <div className="flex items-start gap-3">
        {enableBubble && (
          <div className="pt-3 shrink-0">
            <KnowledgeBubblePopover segment={segment} />
          </div>
        )}

        <article
          className={`flex-1 min-w-0 rounded-xl border bg-white p-5 shadow-[0_2px_8px_rgba(31,35,41,0.03)] space-y-3.5 transition-all ${
            isFocusedSegment
              ? 'border-[#1456F0] ring-2 ring-[#1456F0]/20'
              : 'border-[#DEE0E3]'
          }`}
        >
          {enableResegment && segment.topicTitle && (
            <div className="flex items-center gap-2 border-b border-[#F2F3F5] pb-2.5">
              <span className="w-2 h-2 rounded-full bg-[#1456F0] shrink-0" />
              <h3 className="text-[15px] font-semibold text-[#1F2329]">
                {segment.topicTitle}
              </h3>
            </div>
          )}

          <div className="space-y-3">
            {visibleUtterances.map((utt, idx) => {
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
                  deferOffscreen={isLargeSegment && idx < visibleUtterances.length - 8}
                  isActiveAudio={isPlayingHere}
                  isFocusedTarget={focusedUtteranceId === utt.id}
                  stickyAnchors={utteranceStickyMap.get(utt.id)}
                  onSeekAudio={onSeekAudio}
                  onRenameSpeaker={onRenameSpeaker}
                  onUpdateUtterance={onUpdateUtterance}
                  onAskAboutText={onAskAboutText}
                  onFocusStickyAnchor={onFocusStickyAnchor}
                  onQuickNoteUtterance={onQuickNoteUtterance}
                />
              );
            })}
          </div>

          {/* 挂载在该知识分段的课堂板书/PPT 截图卡片 */}
          {segmentImages.length > 0 && (
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

export const TranscriptPanel: React.FC = React.memo(() => {
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

  const [focusedIds, setFocusedIds] = useState<{
    segmentId: string | null;
    utteranceId: string | null;
  }>({ segmentId: null, utteranceId: null });
  const handledFocusSeqRef = useRef<number>(0);
  const focusTimerRef = useRef<number | null>(null);
  const utteranceRefineRafRef = useRef<number | null>(null);
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

  const renderedSegments = useMemo(
    () =>
      segments
        .map((segment) => {
          const base = enableCorrection
            ? segment.utterances.filter((utt) => !(utt.isRefined && !utt.refinedText.trim()))
            : segment.utterances;
          const visibleUtterances = onlyBookmarks
            ? base.filter((utt) => utt.isBookmarked)
            : base;
          const segmentImages = imagesBySegment.get(segment.id) ?? [];
          return { segment, visibleUtterances, segmentImages };
        })
        .filter(({ segment, visibleUtterances, segmentImages }) => {
          if (onlyBookmarks) return visibleUtterances.length > 0;
          if (segmentImages.length > 0) return true;
          return (
            !enableCorrection || segment.utterances.length === 0 || visibleUtterances.length > 0
          );
        }),
    [segments, enableCorrection, onlyBookmarks, imagesBySegment]
  );

  const getItemKey = useCallback(
    (index: number) => renderedSegments[index]?.segment.id ?? String(index),
    [renderedSegments]
  );

  const estimateSize = useCallback(
    (index: number) => {
      const item = renderedSegments[index];
      if (!item) return 140;
      const imgRows = Math.ceil(item.segmentImages.length / 2);
      return 84 + Math.max(1, item.visibleUtterances.length) * 72 + imgRows * 210;
    },
    [renderedSegments]
  );

  const { scrollRef, measureElement, notifyScroll, scrollToIndex, range } = useVirtualList({
    count: renderedSegments.length,
    getItemKey,
    estimateSize,
    gap: 16,
    overscanPx: 750,
  });

  const cancelPendingFocusRefine = useCallback(() => {
    if (utteranceRefineRafRef.current !== null) {
      window.cancelAnimationFrame(utteranceRefineRafRef.current);
      utteranceRefineRafRef.current = null;
    }
  }, []);

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
    };
  }, []);

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

    if (targetSegId) {
      targetIndex = renderedSegments.findIndex((r) => r.segment.id === targetSegId);
    } else if (targetUttId) {
      targetIndex = renderedSegments.findIndex((r) =>
        r.segment.utterances.some((u) => u.id === targetUttId)
      );
      if (targetIndex >= 0) targetSegId = renderedSegments[targetIndex].segment.id;
    } else if (focusRequest.timestampMs !== undefined) {
      const ts = focusRequest.timestampMs;
      let bestDist = Number.POSITIVE_INFINITY;
      renderedSegments.forEach((r, idx) => {
        for (const u of r.segment.utterances) {
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
      <div className="h-12 px-5 bg-white border-b border-[#ECEEF2] flex items-center justify-between gap-3 shrink-0">
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
          if (selectionBar) setSelectionBar(null);
        }}
        onMouseUp={handleMouseUpSelection}
        className="flex-1 overflow-y-auto px-5 py-5"
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
                  gap: '16px',
                  paddingTop: `${range.topSpacerPx}px`,
                  paddingBottom: `${range.bottomSpacerPx}px`,
                }}
              >
                {visibleSlice.map(({ segment, visibleUtterances, segmentImages }) => (
                  <div
                    key={segment.id}
                    data-virtual-key={segment.id}
                    ref={measureElement}
                  >
                    <SegmentCard
                      segment={segment}
                      visibleUtterances={visibleUtterances}
                      segmentImages={segmentImages}
                      enableCorrection={enableCorrection}
                      enableResegment={enableResegment}
                      enableHighlight={enableHighlight}
                      enableBubble={enableBubble}
                      showDiarization={showDiarization}
                      activeAudioMs={activeAudioMs}
                      focusedUtteranceId={focusedIds.utteranceId}
                      isFocusedSegment={focusedIds.segmentId === segment.id}
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
                    />
                  </div>
                ))}
              </div>
            )}

            <LiveRecordingBanner enableBubble={enableBubble} />
          </>
        )}
      </div>

      {/* 原声倍速点句回放条 */}
      <AudioPlaybackBar />

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
