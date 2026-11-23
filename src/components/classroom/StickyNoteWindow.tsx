import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  Check,
  Clock,
  Eye,
  Layers,
  LocateFixed,
  MessageSquarePlus,
  Minus,
  Pencil,
  Trash2,
  X,
} from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import type { PaperColor, StickyNoteItem } from '../../types/domain';
import {
  clampStickyBounds,
  computeSessionTimestampClaims,
  formatStickyBracket,
  formatStickySec,
  getStickyNoteDisplayTitle,
  PAPER_THEME_ORDER,
  PAPER_THEMES,
  parseStickyTimestamps,
} from '../../utils/stickyNoteTimestamps';
import { MarkdownRenderer } from '../ui/MarkdownRenderer';
import { Tooltip } from '../ui/Tooltip';

type ResizeDir = 'e' | 's' | 'w' | 'n' | 'se' | 'sw' | 'ne' | 'nw';

const LINE_HEIGHT_PX = 26;
const TEXTAREA_PAD_TOP_PX = 10;

interface StickyNoteWindowProps {
  note: StickyNoteItem;
  displayIndex: number;
  mobileSheet?: boolean;
}

export const StickyNoteWindow: React.FC<StickyNoteWindowProps> = React.memo(
  ({ note, displayIndex, mobileSheet = false }) => {
    const allNotes = useAppStore((s) => s.stickyNotes);
    const jumpRequest = useAppStore((s) => s.stickyNoteJumpRequest);
    const activeDurationSec = useAppStore((s) => s.activeSession?.durationSeconds ?? 0);
    const isRecording = useAppStore((s) => s.activeSession?.status === 'recording');
    const audioPlayback = useAppStore((s) => s.audioPlayback);
    const segments = useAppStore((s) => s.segments);

    const updateStickyNoteLocal = useAppStore((s) => s.updateStickyNoteLocal);
    const persistStickyNote = useAppStore((s) => s.persistStickyNote);
    const bringStickyNoteToFront = useAppStore((s) => s.bringStickyNoteToFront);
    const setStickyNoteOpen = useAppStore((s) => s.setStickyNoteOpen);
    const deleteStickyNote = useAppStore((s) => s.deleteStickyNote);
    const focusStickyNoteTimestamp = useAppStore((s) => s.focusStickyNoteTimestamp);
    const clearStickyNoteJumpRequest = useAppStore((s) => s.clearStickyNoteJumpRequest);
    const jumpToTranscript = useAppStore((s) => s.jumpToTranscript);
    const prefillChatComposer = useAppStore((s) => s.prefillChatComposer);
    const showNotice = useAppStore((s) => s.showNotice);

    const [isPreview, setIsPreview] = useState(false);
    const [isEditingTitle, setIsEditingTitle] = useState(false);
    const [showPalette, setShowPalette] = useState(false);
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [saveState, setSaveState] = useState<'saved' | 'saving'>('saved');
    const [highlightLine, setHighlightLine] = useState<number | null>(null);
    const [editorScrollTop, setEditorScrollTop] = useState(0);

    const textareaRef = useRef<HTMLTextAreaElement | null>(null);
    const saveTimerRef = useRef<number | null>(null);
    const highlightTimerRef = useRef<number | null>(null);
    const handledJumpSeqRef = useRef<number>(0);
    const dirtyPatchRef = useRef<{ title?: string; content?: string } | null>(null);
    const noteRef = useRef(note);
    noteRef.current = note;

    const theme = PAPER_THEMES[note.paperColor] ?? PAPER_THEMES.cream;
    const fallbackLabel = `课堂便签 #${displayIndex}`;
    const displayTitle = getStickyNoteDisplayTitle(note, displayIndex);

    // 计算快捷插入的当前秒数：录音中取实时计时；回放中取回放秒；否则取最新转写时间或课堂时长
    const quickCurrentSec = useMemo(() => {
      if (isRecording) return Math.max(0, Math.floor(activeDurationSec));
      if (audioPlayback.visible && audioPlayback.currentMs > 0) {
        return Math.max(0, Math.floor(audioPlayback.currentMs / 1000));
      }
      for (let i = segments.length - 1; i >= 0; i -= 1) {
        const utts = segments[i].utterances;
        if (utts.length > 0) {
          return Math.max(0, Math.floor(utts[utts.length - 1].startTimeMs / 1000));
        }
      }
      return Math.max(0, Math.floor(activeDurationSec));
    }, [isRecording, activeDurationSec, audioPlayback.visible, audioPlayback.currentMs, segments]);

    const flushSave = useCallback(async () => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      const pending = dirtyPatchRef.current;
      if (!pending) return;
      dirtyPatchRef.current = null;
      setSaveState('saving');
      await persistStickyNote(noteRef.current.id, pending);
      setSaveState('saved');
    }, [persistStickyNote]);

    const scheduleSave = useCallback(
      (patch: { title?: string; content?: string }) => {
        dirtyPatchRef.current = { ...(dirtyPatchRef.current ?? {}), ...patch };
        setSaveState('saving');
        if (saveTimerRef.current !== null) {
          window.clearTimeout(saveTimerRef.current);
        }
        saveTimerRef.current = window.setTimeout(() => {
          void flushSave();
        }, 420);
      },
      [flushSave]
    );

    useEffect(() => {
      return () => {
        if (highlightTimerRef.current !== null) {
          window.clearTimeout(highlightTimerRef.current);
        }
        if (saveTimerRef.current !== null) {
          window.clearTimeout(saveTimerRef.current);
        }
        if (dirtyPatchRef.current) {
          const pending = dirtyPatchRef.current;
          dirtyPatchRef.current = null;
          void persistStickyNote(noteRef.current.id, pending);
        }
      };
    }, [persistStickyNote]);

    // 响应从转写行右侧纸色渐变、便签篓或冲突提示发来的一次性定位请求
    useEffect(() => {
      if (!jumpRequest || jumpRequest.noteId !== note.id) return;
      if (jumpRequest.seq <= handledJumpSeqRef.current) return;
      handledJumpSeqRef.current = jumpRequest.seq;
      clearStickyNoteJumpRequest();

      if (isPreview) setIsPreview(false);

      const content = noteRef.current.content || '';
      let targetOffset: number | null = null;
      let targetEndOffset: number | null = null;

      if (jumpRequest.timestampSec !== undefined) {
        const parsed = parseStickyTimestamps(content);
        const hit = parsed.find((m) => m.timestampSec === jumpRequest.timestampSec);
        if (hit) {
          targetOffset = hit.startOffset;
          targetEndOffset = hit.endOffset;
        }
      }
      if (targetOffset === null && jumpRequest.charOffset !== undefined) {
        targetOffset = Math.max(0, Math.min(content.length, jumpRequest.charOffset));
        targetEndOffset = targetOffset;
      }

      window.requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.focus();
        if (targetOffset !== null) {
          const lineIdx = content.slice(0, targetOffset).split('\n').length - 1;
          const desiredTop = Math.max(
            0,
            lineIdx * LINE_HEIGHT_PX - el.clientHeight / 2 + LINE_HEIGHT_PX
          );
          el.scrollTo({ top: desiredTop, behavior: 'smooth' });
          setEditorScrollTop(desiredTop);
          const caretPos = targetEndOffset ?? targetOffset;
          el.setSelectionRange(caretPos, caretPos);
          setHighlightLine(lineIdx);
          if (highlightTimerRef.current !== null) {
            window.clearTimeout(highlightTimerRef.current);
          }
          highlightTimerRef.current = window.setTimeout(() => {
            highlightTimerRef.current = null;
            setHighlightLine(null);
          }, 2300);
        }
      });
    }, [jumpRequest, note.id, isPreview, clearStickyNoteJumpRequest]);

    const handleInsertCurrentTimestamp = useCallback(() => {
      const sec = quickCurrentSec;
      const claims = computeSessionTimestampClaims(allNotes);
      const occupied = claims.get(sec);
      if (occupied) {
        showNotice(
          'info',
          `[${occupied.timestampText}] 已被便签「${occupied.noteTitle}」先占用（同一秒不能重复添加），已为你定位`
        );
        focusStickyNoteTimestamp(occupied.noteId, sec, occupied.charOffset);
        return;
      }

      const token = `${formatStickyBracket(sec)} `;
      const current = noteRef.current.content;
      const el = textareaRef.current;

      let start = current.length;
      let end = current.length;
      if (el && !isPreview) {
        start = el.selectionStart ?? current.length;
        end = el.selectionEnd ?? start;
      }

      // 若插入在非空行尾且前一个字符不是空白或换行，补一个空格保持整洁
      const prevChar = start > 0 ? current[start - 1] : '';
      const prefix = prevChar && prevChar !== '\n' && prevChar !== ' ' ? ' ' : '';
      const nextContent = `${current.slice(0, start)}${prefix}${token}${current.slice(end)}`;
      const nextCaret = start + prefix.length + token.length;

      if (isPreview) setIsPreview(false);
      updateStickyNoteLocal(note.id, { content: nextContent });
      scheduleSave({ content: nextContent });

      window.requestAnimationFrame(() => {
        const area = textareaRef.current;
        if (!area) return;
        area.focus();
        area.setSelectionRange(nextCaret, nextCaret);
      });
    }, [
      quickCurrentSec,
      allNotes,
      isPreview,
      note.id,
      showNotice,
      focusStickyNoteTimestamp,
      updateStickyNoteLocal,
      scheduleSave,
    ]);

    const handleContentChange = (nextContent: string) => {
      updateStickyNoteLocal(note.id, { content: nextContent });
      scheduleSave({ content: nextContent });
    };

    const handleTitleChange = (nextTitle: string) => {
      updateStickyNoteLocal(note.id, { title: nextTitle });
      scheduleSave({ title: nextTitle });
    };

    const handleSelectPaperColor = (color: PaperColor) => {
      setShowPalette(false);
      if (color === note.paperColor) return;
      updateStickyNoteLocal(note.id, { paperColor: color });
      void persistStickyNote(note.id, { paperColor: color });
    };

    const handleToggleTranslucent = () => {
      const next = !note.isTranslucent;
      updateStickyNoteLocal(note.id, { isTranslucent: next });
      void persistStickyNote(note.id, { isTranslucent: next });
    };

    const handleCollapse = async () => {
      await flushSave();
      await setStickyNoteOpen(note.id, false);
    };

    const handleAskAI = () => {
      const body = note.content.trim();
      if (!body) {
        showNotice('info', '便签内容为空，写点内容后再发给 AI 解答吧');
        return;
      }
      const header = note.title.trim() ? `《${note.title.trim()}》` : '';
      prefillChatComposer(
        `请结合本堂课转写，帮我整理并深入解释我在课堂便签${header}里记下的这些要点：\n${body}`
      );
    };

    // 自由拖动（标题栏 Pointer Capture）
    const handleHeaderPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      if (target.closest('button, input, textarea, [data-no-drag="true"]')) return;

      e.preventDefault();
      bringStickyNoteToFront(note.id);
      const startX = e.clientX;
      const startY = e.clientY;
      const originX = noteRef.current.posX;
      const originY = noteRef.current.posY;
      let latest = { posX: originX, posY: originY };
      let moved = false;

      const onMove = (ev: PointerEvent) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        if (!moved && Math.abs(dx) < 2 && Math.abs(dy) < 2) return;
        moved = true;
        const clamped = clampStickyBounds(
          {
            posX: originX + dx,
            posY: originY + dy,
            width: noteRef.current.width,
            height: noteRef.current.height,
          },
          window.innerWidth,
          window.innerHeight
        );
        latest = { posX: clamped.posX, posY: clamped.posY };
        updateStickyNoteLocal(note.id, latest);
      };

      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        if (moved) {
          void persistStickyNote(note.id, latest);
        }
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    };

    // 多向自由调整大小
    const startResize = (dir: ResizeDir) => (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      bringStickyNoteToFront(note.id);

      const startX = e.clientX;
      const startY = e.clientY;
      const origin = {
        posX: noteRef.current.posX,
        posY: noteRef.current.posY,
        width: noteRef.current.width,
        height: noteRef.current.height,
      };
      let latest = { ...origin };
      let resized = false;

      const onMove = (ev: PointerEvent) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        resized = true;
        let nextX = origin.posX;
        let nextY = origin.posY;
        let nextW = origin.width;
        let nextH = origin.height;

        if (dir.includes('e')) nextW = origin.width + dx;
        if (dir.includes('s')) nextH = origin.height + dy;
        if (dir.includes('w')) {
          const minW = 290;
          const clampedW = Math.max(minW, origin.width - dx);
          nextX = origin.posX + (origin.width - clampedW);
          nextW = clampedW;
        }
        if (dir.includes('n')) {
          const minH = 230;
          const clampedH = Math.max(minH, origin.height - dy);
          nextY = origin.posY + (origin.height - clampedH);
          nextH = clampedH;
        }

        latest = clampStickyBounds(
          { posX: nextX, posY: nextY, width: nextW, height: nextH },
          window.innerWidth,
          window.innerHeight
        );
        updateStickyNoteLocal(note.id, latest);
      };

      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        if (resized) {
          void persistStickyNote(note.id, latest);
        }
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    };

    const effectiveZ = 50 + Math.min(note.zOrder, 18);

    return (
      <div
        role="dialog"
        aria-label={`便签窗口：${displayTitle}`}
        data-sticky-note-id={note.id}
        onPointerDown={() => bringStickyNoteToFront(note.id)}
        style={
          mobileSheet
            ? {
                backgroundColor: theme.bodyBg,
                borderColor: theme.border,
              }
            : {
                left: `${note.posX}px`,
                top: `${note.posY}px`,
                width: `${note.width}px`,
                height: `${note.height}px`,
                zIndex: effectiveZ,
                backgroundColor: note.isTranslucent ? theme.bodyBgTranslucent : theme.bodyBg,
                borderColor: theme.border,
              }
        }
        className={
          mobileSheet
            ? 'w-full h-[64vh] pointer-events-auto flex flex-col overflow-hidden select-none'
            : `fixed pointer-events-auto rounded-2xl border shadow-[0_14px_36px_rgba(31,35,41,0.16),0_2px_8px_rgba(111,84,20,0.08)] flex flex-col overflow-hidden select-none ${
                note.isTranslucent ? 'backdrop-blur-md' : ''
              }`
        }
      >
        {/* 纸色标题栏（拖拽移动 + 标题编辑 + 快捷操作） */}
        <div
          onPointerDown={mobileSheet ? undefined : handleHeaderPointerDown}
          style={{
            backgroundColor: theme.headerBg,
            borderColor: theme.border,
          }}
          className={`h-11 md:h-10 px-2.5 border-b flex items-center justify-between gap-1.5 shrink-0 ${
            mobileSheet ? '' : 'touch-none cursor-grab active:cursor-grabbing'
          }`}
        >
          <div className="flex items-center gap-1.5 min-w-0 flex-1">
            {/* 纸色切换圆点按钮 */}
            <div className="relative shrink-0" data-no-drag="true">
              <Tooltip content="切换便签纸色" placement="bottom">
                <button
                  type="button"
                  aria-label="切换便签纸色"
                  onClick={() => setShowPalette((v) => !v)}
                  style={{
                    backgroundColor: theme.swatchBg,
                    borderColor: theme.borderStrong,
                  }}
                  className="w-4 h-4 rounded-full border-2 shadow-2xs hover:scale-110 transition-transform cursor-pointer block"
                />
              </Tooltip>

              {showPalette && (
                <div
                  className="absolute left-0 top-6 z-20 rounded-xl border border-[#DEE0E3] bg-white px-2 py-1.5 shadow-lg flex items-center gap-1.5"
                  onPointerDown={(e) => e.stopPropagation()}
                >
                  {PAPER_THEME_ORDER.map((colorId) => {
                    const t = PAPER_THEMES[colorId];
                    const active = colorId === note.paperColor;
                    return (
                      <Tooltip key={colorId} content={t.label} placement="bottom">
                        <button
                          type="button"
                          aria-label={t.label}
                          onClick={() => handleSelectPaperColor(colorId)}
                          style={{
                            backgroundColor: t.swatchBg,
                            borderColor: active ? '#1456F0' : t.borderStrong,
                          }}
                          className={`w-5 h-5 rounded-full border-2 flex items-center justify-center transition-transform hover:scale-110 cursor-pointer ${
                            active ? 'ring-2 ring-[#1456F0]/25' : ''
                          }`}
                        >
                          {active && <Check className="w-3 h-3 text-[#1456F0]" strokeWidth={2.5} />}
                        </button>
                      </Tooltip>
                    );
                  })}
                </div>
              )}
            </div>

            {isEditingTitle ? (
              <input
                type="text"
                autoFocus
                data-no-drag="true"
                value={note.title}
                placeholder={fallbackLabel}
                onChange={(e) => handleTitleChange(e.target.value)}
                onBlur={() => {
                  setIsEditingTitle(false);
                  void flushSave();
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    setIsEditingTitle(false);
                    void flushSave();
                    textareaRef.current?.focus();
                  } else if (e.key === 'Escape') {
                    setIsEditingTitle(false);
                  }
                }}
                className="min-w-0 flex-1 bg-white/60 rounded px-1.5 py-0.5 text-[14px] font-semibold text-[#1F2329] placeholder:text-[#7D704A]/70 focus:outline-none focus:ring-1 focus:ring-[#1456F0]/40 truncate"
              />
            ) : (
              <span
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  setIsEditingTitle(true);
                }}
                title="拖动标题栏可移动窗口，双击修改标题"
                className={`min-w-0 flex-1 text-[14px] font-semibold truncate px-1 ${
                  note.title.trim() ? 'text-[#1F2329]' : 'text-[#7D704A]/85'
                }`}
              >
                {note.title.trim() || fallbackLabel}
              </span>
            )}
          </div>

          <div className="flex items-center gap-0.5 shrink-0" data-no-drag="true">
            <Tooltip content={isPreview ? '切回编辑模式' : '预览公式与排版'} placement="bottom">
              <button
                type="button"
                aria-label={isPreview ? '切回编辑模式' : '预览公式与排版'}
                onClick={() => setIsPreview((v) => !v)}
                className={`w-7 h-7 rounded-lg flex items-center justify-center transition-colors cursor-pointer ${
                  isPreview
                    ? 'bg-black/10 text-[#1456F0]'
                    : 'text-[#5C4E28] hover:bg-black/8 hover:text-[#1F2329]'
                }`}
              >
                {isPreview ? <Pencil className="w-3.5 h-3.5" /> : <Eye className="w-4 h-4" />}
              </button>
            </Tooltip>

            <Tooltip
              content={note.isTranslucent ? '恢复实体纸面' : '开启半透明对照模式'}
              placement="bottom"
            >
              <button
                type="button"
                aria-label="切换半透明模式"
                onClick={handleToggleTranslucent}
                className={`w-7 h-7 rounded-lg flex items-center justify-center transition-colors cursor-pointer ${
                  note.isTranslucent
                    ? 'bg-black/10 text-[#1456F0]'
                    : 'text-[#5C4E28] hover:bg-black/8 hover:text-[#1F2329]'
                }`}
              >
                <Layers className="w-3.5 h-3.5" />
              </button>
            </Tooltip>

            <Tooltip content="收起至便签篓（自动保存）" placement="bottom">
              <button
                type="button"
                aria-label="收起便签"
                onClick={() => void handleCollapse()}
                className="w-7 h-7 rounded-lg text-[#5C4E28] hover:bg-black/8 hover:text-[#1F2329] flex items-center justify-center transition-colors cursor-pointer"
              >
                <Minus className="w-4 h-4" />
              </button>
            </Tooltip>

            {confirmDelete ? (
              <button
                type="button"
                onClick={() => {
                  setConfirmDelete(false);
                  void deleteStickyNote(note.id);
                }}
                onMouseLeave={() => setConfirmDelete(false)}
                className="h-7 px-2 rounded-lg bg-[#D83931] hover:bg-[#B82D26] text-white text-[14px] font-medium cursor-pointer"
              >
                删?
              </button>
            ) : (
              <Tooltip content="永久删除此便签" placement="bottom">
                <button
                  type="button"
                  aria-label="删除便签"
                  onClick={() => setConfirmDelete(true)}
                  className="w-7 h-7 rounded-lg text-[#5C4E28] hover:bg-[#FFECE8] hover:text-[#D83931] flex items-center justify-center transition-colors cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </Tooltip>
            )}

            <Tooltip content="保存并关闭（留存在便签篓）" placement="bottom">
              <button
                type="button"
                aria-label="保存并关闭便签"
                onClick={() => void handleCollapse()}
                className="w-7 h-7 rounded-lg text-[#5C4E28] hover:bg-black/8 hover:text-[#1F2329] flex items-center justify-center transition-colors cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </Tooltip>
          </div>
        </div>

        {/* 纸面正文区（编辑 / Markdown 预览） */}
        <div className="relative flex-1 min-h-0 select-text overflow-hidden">
          {isPreview ? (
            <div className="h-full overflow-y-auto px-3.5 py-2.5 text-[14px]">
              {note.content.trim() ? (
                <MarkdownRenderer
                  content={note.content}
                  variant="compact"
                  onTimestampClick={(ms) => jumpToTranscript({ timestampMs: ms })}
                />
              ) : (
                <div className="text-[14px] text-[#7D704A]/75 italic">
                  便签内容为空，点击右上角编辑图标开始记录...
                </div>
              )}
            </div>
          ) : (
            <div className="relative h-full w-full">
              {/* 从转写行纸色渐变跳转过来时的目标行暖光指示带 */}
              {highlightLine !== null && (
                <div
                  aria-hidden="true"
                  style={{
                    top: `${TEXTAREA_PAD_TOP_PX + highlightLine * LINE_HEIGHT_PX - editorScrollTop}px`,
                    height: `${LINE_HEIGHT_PX}px`,
                    backgroundColor: theme.chipBg,
                    borderLeft: `3px solid ${theme.edgeAccent}`,
                  }}
                  className="pointer-events-none absolute left-0 right-0 transition-opacity duration-300"
                />
              )}

              <textarea
                ref={textareaRef}
                value={note.content}
                placeholder={`随手记录要点，输入 [03:54] 或 [01:02:05] 绑定对应转写行，或点左下角快捷插入当前时间...`}
                onChange={(e) => handleContentChange(e.target.value)}
                onBlur={() => void flushSave()}
                onScroll={(e) => setEditorScrollTop(e.currentTarget.scrollTop)}
                onKeyDown={(e) => {
                  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
                    e.preventDefault();
                    void flushSave();
                  } else if (
                    (e.ctrlKey || e.metaKey) &&
                    e.shiftKey &&
                    e.key.toLowerCase() === 't'
                  ) {
                    e.preventDefault();
                    handleInsertCurrentTimestamp();
                  }
                }}
                style={{
                  lineHeight: `${LINE_HEIGHT_PX}px`,
                  paddingTop: `${TEXTAREA_PAD_TOP_PX}px`,
                  backgroundImage: `repeating-linear-gradient(to bottom, transparent 0px, transparent ${
                    LINE_HEIGHT_PX - 1
                  }px, ${theme.ruleLine} ${LINE_HEIGHT_PX - 1}px, ${
                    theme.ruleLine
                  } ${LINE_HEIGHT_PX}px)`,
                  backgroundPositionY: `${TEXTAREA_PAD_TOP_PX - editorScrollTop}px`,
                  backgroundAttachment: 'local',
                }}
                className="relative z-10 w-full h-full resize-none bg-transparent px-3.5 pb-3 text-[14px] text-[#1F2329] placeholder:text-[#7D704A]/65 focus:outline-none overflow-y-auto"
              />
            </div>
          )}
        </div>

        {/* 冲突提示栏（同秒先来后到规则） */}
        {note.conflicts.length > 0 && (
          <div className="px-3 py-1.5 bg-[#FFF2F0] border-t border-[#FFCCC7] space-y-1 shrink-0">
            {note.conflicts.map((conflict) => (
              <div
                key={`${conflict.timestampSec}-${conflict.ownerNoteId}`}
                className="flex items-center justify-between gap-2 text-[14px] text-[#B82D26]"
              >
                <div className="flex items-center gap-1.5 min-w-0">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                  <span className="truncate">
                    [{conflict.timestampText}] 已被「{conflict.ownerNoteTitle}」先占用
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    focusStickyNoteTimestamp(conflict.ownerNoteId, conflict.timestampSec)
                  }
                  className="shrink-0 text-[14px] font-medium text-[#1456F0] hover:underline cursor-pointer"
                >
                  去查看
                </button>
              </div>
            ))}
          </div>
        )}

        {/* 已绑定的时间戳胶囊条（双向点击跳转至右侧转写对应句） */}
        {note.timestamps.length > 0 && (
          <div
            style={{
              backgroundColor: theme.footerBg,
              borderColor: theme.border,
            }}
            className="px-2.5 py-1.5 border-t flex items-center gap-1.5 overflow-x-auto no-scrollbar shrink-0"
          >
            {note.timestamps.map((ts) => (
              <Tooltip
                key={ts.id}
                content={`点击跳转右侧转写 [${ts.timestampText}]`}
                placement="top"
              >
                <button
                  type="button"
                  style={{
                    backgroundColor: theme.chipBg,
                    borderColor: theme.chipBorder,
                    color: theme.chipText,
                  }}
                  onClick={() => jumpToTranscript({ timestampMs: ts.timestampSec * 1000 })}
                  className="shrink-0 px-2 py-0.5 rounded-md border text-[14px] font-mono tabular-nums inline-flex items-center gap-1 hover:brightness-95 transition-all cursor-pointer"
                >
                  <LocateFixed className="w-3 h-3 shrink-0" />
                  <span>{ts.timestampText}</span>
                </button>
              </Tooltip>
            ))}
          </div>
        )}

        {/* 底部快捷工具栏：一键插入当前时间 + 发给 AI + 保存状态 */}
        <div
          style={{
            backgroundColor: theme.footerBg,
            borderColor: theme.border,
          }}
          className="h-10 px-2.5 border-t flex items-center justify-between gap-2 shrink-0"
        >
          <div className="flex items-center gap-1.5 min-w-0">
            <Tooltip
              content={`在光标处插入当前课堂时间 [${formatStickySec(quickCurrentSec)}]（快捷键 Ctrl+Shift+T）`}
              placement="top"
            >
              <button
                type="button"
                onClick={handleInsertCurrentTimestamp}
                style={{
                  backgroundColor: theme.chipBg,
                  borderColor: theme.chipBorder,
                  color: theme.chipText,
                }}
                className="h-7 px-2 rounded-lg border text-[14px] font-medium inline-flex items-center gap-1 hover:brightness-95 active:scale-[0.97] transition-all cursor-pointer tabular-nums shrink-0"
              >
                <Clock className="w-3.5 h-3.5 shrink-0" />
                <span>+ {formatStickySec(quickCurrentSec)}</span>
              </button>
            </Tooltip>

            <Tooltip content="把本便签内容带入左侧 AI 问答栏深入解答" placement="top">
              <button
                type="button"
                onClick={handleAskAI}
                className="h-7 px-2 rounded-lg hover:bg-black/6 text-[14px] text-[#4E5969] hover:text-[#1456F0] inline-flex items-center gap-1 transition-colors cursor-pointer shrink-0"
              >
                <MessageSquarePlus className="w-3.5 h-3.5 shrink-0" />
                <span>问 AI</span>
              </button>
            </Tooltip>
          </div>

          <span className="text-[14px] text-[#7D704A] shrink-0 pr-2">
            {saveState === 'saving' ? '保存中...' : '已保存'}
          </span>
        </div>

        {/* 边缘与四角缩放句柄（桌面与平板独立浮窗模式，支持触控与鼠标拖拽缩放） */}
        {!mobileSheet && (
          <>
            <div
              onPointerDown={startResize('e')}
              className="absolute top-2 bottom-4 right-0 w-2 touch-none cursor-ew-resize"
            />
            <div
              onPointerDown={startResize('w')}
              className="absolute top-2 bottom-4 left-0 w-2 touch-none cursor-ew-resize"
            />
            <div
              onPointerDown={startResize('s')}
              className="absolute left-4 right-4 bottom-0 h-2 touch-none cursor-ns-resize"
            />
            <div
              onPointerDown={startResize('n')}
              className="absolute left-4 right-4 top-0 h-1.5 touch-none cursor-ns-resize"
            />
            <div
              onPointerDown={startResize('sw')}
              className="absolute left-0 bottom-0 w-5 h-5 touch-none cursor-nesw-resize"
            />
            <div
              onPointerDown={startResize('se')}
              title="拖拽调整便签大小"
              className="absolute right-0 bottom-0 w-5 h-5 touch-none cursor-nwse-resize flex items-end justify-end p-1"
            >
              <span
                style={{ borderColor: theme.borderStrong }}
                className="w-2 h-2 border-r-2 border-b-2 rounded-br-[2px] opacity-75 pointer-events-none"
              />
            </div>
          </>
        )}
      </div>
    );
  }
);

StickyNoteWindow.displayName = 'StickyNoteWindow';
