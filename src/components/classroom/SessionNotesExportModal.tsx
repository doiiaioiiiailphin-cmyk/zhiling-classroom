import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  BookOpenCheck,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  FileDown,
  FileSpreadsheet,
  FileText,
  Layers,
  Loader2,
  RefreshCw,
  RotateCcw,
} from 'lucide-react';
import { useSmoothStream } from '../../hooks/useSmoothStream';
import { AddonDownloadCancelled, api } from '../../services/api';
import { useAppStore } from '../../store/useAppStore';
import type {
  FlashcardItem,
  SessionExportRequest,
  SessionStudyNote,
} from '../../types/domain';
import { useViewportLayout } from '../../utils/desktopBridge';
import { MarkdownRenderer } from '../ui/MarkdownRenderer';
import { Modal } from '../ui/Modal';
import { ThinkingDisclosure } from '../ui/ThinkingDisclosure';

type ModalTab = 'notes' | 'flashcards' | 'export';

export const SessionNotesExportModal: React.FC = () => {
  const modalState = useAppStore((s) => s.notesExportModal);
  const activeSession = useAppStore((s) => s.activeSession);
  const sessions = useAppStore((s) => s.sessions);
  const storeStudyNote = useAppStore((s) => s.studyNote);
  const storeFlashcards = useAppStore((s) => s.flashcards);
  const defaultExportFormat = useAppStore(
    (s) => s.settings?.defaultExportFormat ?? 'markdown'
  );
  const closeNotesExportModal = useAppStore((s) => s.closeNotesExportModal);
  const streamGenerateStudyNote = useAppStore((s) => s.streamGenerateStudyNote);
  const generateSessionFlashcards = useAppStore((s) => s.generateSessionFlashcards);
  const exportSessionDocument = useAppStore((s) => s.exportSessionDocument);
  const showNotice = useAppStore((s) => s.showNotice);

  const [tab, setTab] = useState<ModalTab>('notes');
  const [localNote, setLocalNote] = useState<SessionStudyNote | null>(null);
  const [localCards, setLocalCards] = useState<FlashcardItem[]>([]);
  const [loadingWorkspace, setLoadingWorkspace] = useState(false);

  // 流式生成精编笔记状态
  const [isGeneratingNote, setIsGeneratingNote] = useState(false);
  const [streamContent, setStreamContent] = useState('');
  const [streamThinking, setStreamThinking] = useState('');
  const [isThinkingPhase, setIsThinkingPhase] = useState(false);
  const [copiedNote, setCopiedNote] = useState(false);

  // 闪卡状态
  const [isGeneratingCards, setIsGeneratingCards] = useState(false);
  const [cardIndex, setCardIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [masteredIds, setMasteredIds] = useState<Record<string, boolean>>({});

  // 导出选项状态
  const [exportFormat, setExportFormat] = useState<'markdown' | 'docx' | 'txt'>(
    defaultExportFormat
  );
  const [includeStudyNote, setIncludeStudyNote] = useState(true);
  const [includeHighlights, setIncludeHighlights] = useState(true);
  const [includeChat, setIncludeChat] = useState(true);
  const [includeTranscript, setIncludeTranscript] = useState(true);
  const [includeStickyNotes, setIncludeStickyNotes] = useState(true);
  const [isExporting, setIsExporting] = useState(false);

  const targetSessionId = modalState.sessionId;
  const isCurrentActiveSession =
    Boolean(targetSessionId) && activeSession?.id === targetSessionId;
  const sessionTitle =
    (isCurrentActiveSession
      ? activeSession?.title
      : sessions.find((s) => s.id === targetSessionId)?.title) ?? '课堂笔记与导出';

  useEffect(() => {
    if (!modalState.open || !targetSessionId) return;
    setTab(modalState.initialTab);
    setExportFormat(defaultExportFormat);
    setCardIndex(0);
    setFlipped(false);

    if (isCurrentActiveSession) {
      setLocalNote(storeStudyNote);
      setLocalCards(storeFlashcards);
      return;
    }

    let cancelled = false;
    setLoadingWorkspace(true);
    void api
      .getSessionWorkspace(targetSessionId)
      .then((ws) => {
        if (cancelled) return;
        setLocalNote(ws.studyNote ?? null);
        setLocalCards(ws.flashcards ?? []);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          showNotice(
            'error',
            err instanceof Error ? err.message : '加载课堂笔记数据失败'
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingWorkspace(false);
      });

    return () => {
      cancelled = true;
    };
  }, [
    modalState.open,
    modalState.initialTab,
    targetSessionId,
    isCurrentActiveSession,
    defaultExportFormat,
    storeStudyNote,
    storeFlashcards,
    showNotice,
  ]);

  const effectiveNote = isCurrentActiveSession ? storeStudyNote : localNote;
  const effectiveCards = isCurrentActiveSession ? storeFlashcards : localCards;

  const { text: animatedNoteContent, isAnimating } = useSmoothStream(
    isGeneratingNote ? streamContent : effectiveNote?.contentMarkdown ?? '',
    isGeneratingNote
  );

  const handleGenerateNote = async () => {
    if (!targetSessionId || isGeneratingNote) return;
    setIsGeneratingNote(true);
    setStreamContent('');
    setStreamThinking('');
    setIsThinkingPhase(true);
    try {
      const saved = await streamGenerateStudyNote(targetSessionId, {
        onThinkingDelta: (delta) => {
          setStreamThinking((prev) => prev + delta);
        },
        onContentDelta: (delta) => {
          setIsThinkingPhase(false);
          setStreamContent((prev) => prev + delta);
        },
      });
      setLocalNote(saved);
    } catch (err) {
      if (err instanceof AddonDownloadCancelled) return;
      showNotice(
        'error',
        err instanceof Error ? err.message : '生成全课精编笔记失败'
      );
    } finally {
      setIsGeneratingNote(false);
      setIsThinkingPhase(false);
    }
  };

  const handleCopyNote = async () => {
    const md = effectiveNote?.contentMarkdown;
    if (!md) return;
    try {
      await navigator.clipboard.writeText(md);
      setCopiedNote(true);
      window.setTimeout(() => setCopiedNote(false), 1800);
    } catch {
      showNotice('error', '复制到剪贴板失败');
    }
  };

  const handleGenerateCards = async () => {
    if (!targetSessionId || isGeneratingCards) return;
    setIsGeneratingCards(true);
    try {
      const cards = await generateSessionFlashcards(targetSessionId);
      setLocalCards(cards);
      setCardIndex(0);
      setFlipped(false);
    } catch (err) {
      if (err instanceof AddonDownloadCancelled) return;
      showNotice(
        'error',
        err instanceof Error ? err.message : '生成巩固自测闪卡失败'
      );
    } finally {
      setIsGeneratingCards(false);
    }
  };

  const handleExport = async (overrideFormat?: SessionExportRequest['format']) => {
    if (!targetSessionId || isExporting) return;
    setIsExporting(true);
    try {
      await exportSessionDocument(targetSessionId, {
        format: overrideFormat ?? exportFormat,
        includeStudyNote,
        includeHighlights,
        includeChat,
        includeTranscript,
        includeStickyNotes,
      });
    } finally {
      setIsExporting(false);
    }
  };

  const currentCard = effectiveCards[cardIndex] ?? null;
  const masteredCount = Object.values(masteredIds).filter(Boolean).length;
  const viewport = useViewportLayout();
  // 手机窄屏/矮横屏使用全屏页面式；平板大屏与桌面端保持类电脑弹窗体验
  const useMobilePageLayout = viewport.isCompactPhoneLayout;
  const canClose = !isGeneratingNote && !isExporting;

  useEffect(() => {
    if (!modalState.open || !useMobilePageLayout) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && canClose) {
        e.preventDefault();
        closeNotesExportModal();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [modalState.open, useMobilePageLayout, canClose, closeNotesExportModal]);

  if (!modalState.open) return null;

  const canExportAny =
    includeStudyNote ||
    includeHighlights ||
    includeChat ||
    includeTranscript ||
    includeStickyNotes;

  if (useMobilePageLayout) {
    return createPortal(
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`课堂总结与导出 · ${sessionTitle}`}
        data-mobile-notes-page="true"
        style={{ paddingTop: 'var(--android-safe-top, 0px)' }}
        className="fixed inset-0 z-50 bg-[#F5F6F7] flex flex-col overflow-hidden animate-mobile-page-in"
      >
        {/* 手机端原生页面顶部导航栏 */}
        <header className="h-[52px] bg-white border-b border-[#ECEEF2] px-2 flex items-center justify-between gap-2 shrink-0">
          <button
            type="button"
            disabled={!canClose}
            onClick={() => {
              if (canClose) closeNotesExportModal();
            }}
            aria-label="返回课堂"
            className="h-10 px-2 rounded-xl text-[#1F2329] active:bg-[#F2F3F5] disabled:opacity-40 inline-flex items-center gap-0.5 text-[15px] font-medium shrink-0 cursor-pointer"
          >
            <ChevronLeft className="w-5 h-5 shrink-0" />
            <span>返回</span>
          </button>

          <div className="min-w-0 flex-1 text-center px-1">
            <div className="text-[16px] font-semibold text-[#1F2329] truncate">
              {sessionTitle}
            </div>
          </div>

          <button
            type="button"
            disabled={!canClose}
            onClick={() => {
              if (canClose) closeNotesExportModal();
            }}
            className="h-10 px-3 rounded-xl text-[#1456F0] active:bg-[#EBF2FF] disabled:opacity-40 text-[15px] font-medium shrink-0 cursor-pointer"
          >
            完成
          </button>
        </header>

        {/* 三等分原生分段切换栏：窄屏绝无遮挡或裁切 */}
        <div className="px-3.5 py-2.5 bg-white border-b border-[#ECEEF2] shrink-0">
          <div className="grid grid-cols-3 gap-1 rounded-xl bg-[#EEF0F4] p-1">
            {(
              [
                { key: 'notes', label: '精编笔记', icon: BookOpenCheck },
                { key: 'flashcards', label: '自测闪卡', icon: Layers },
                { key: 'export', label: '导出文档', icon: FileDown },
              ] as const
            ).map((item) => {
              const Icon = item.icon;
              const active = tab === item.key;
              return (
                <button
                  key={item.key}
                  type="button"
                  data-notes-tab={item.key}
                  onClick={() => setTab(item.key)}
                  className={`h-9 px-1.5 rounded-lg text-[14px] font-medium inline-flex items-center justify-center gap-1 min-w-0 whitespace-nowrap transition-all cursor-pointer ${
                    active
                      ? 'bg-white text-[#1456F0] shadow-xs'
                      : 'text-[#4E5969] active:text-[#1F2329]'
                  }`}
                >
                  <Icon className="w-4 h-4 shrink-0" />
                  <span className="truncate">{item.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* 主体全页滚动内容区 */}
        <div className="flex-1 min-h-0 overflow-y-auto px-3.5 py-4 space-y-4">
          {loadingWorkspace ? (
            <div className="h-full flex items-center justify-center gap-2.5 text-[15px] text-[#646A73]">
              <Loader2 className="w-5 h-5 animate-spin text-[#1456F0]" />
              <span>正在读取课堂内容...</span>
            </div>
          ) : tab === 'notes' ? (
            isGeneratingNote || effectiveNote?.contentMarkdown ? (
              <div className="rounded-2xl border border-[#EAEDF1] bg-white p-4 shadow-[0_1px_2px_rgba(31,35,41,0.03)] space-y-3.5">
                {(isGeneratingNote ? streamThinking : effectiveNote?.thinking) && (
                  <ThinkingDisclosure
                    thinking={isGeneratingNote ? streamThinking : effectiveNote?.thinking}
                    isThinking={isGeneratingNote && isThinkingPhase}
                  />
                )}
                {animatedNoteContent ? (
                  <MarkdownRenderer
                    content={animatedNoteContent}
                    isStreaming={isGeneratingNote || isAnimating}
                  />
                ) : isGeneratingNote ? (
                  <div className="py-2 text-[14px] font-medium thinking-shimmer inline-block">
                    正在梳理全课知识脉络与公式推导...
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="h-full flex flex-col items-center justify-center text-center px-4 space-y-4">
                <div className="w-14 h-14 rounded-2xl bg-[#EBF2FF] text-[#1456F0] flex items-center justify-center">
                  <BookOpenCheck className="w-7 h-7" />
                </div>
                <div className="space-y-1.5 max-w-sm">
                  <h3 className="text-[16px] font-semibold text-[#1F2329]">
                    尚未生成全课精编笔记
                  </h3>
                  <p className="text-[14px] text-[#646A73] leading-relaxed">
                    点击下方「一键生成全课笔记」，AI 将综合整堂课的知识分段、重点词、不懂点书签与讲义，生成完整的复习总结文档。
                  </p>
                </div>
              </div>
            )
          ) : tab === 'flashcards' ? (
            currentCard ? (
              <div className="h-full flex flex-col justify-between gap-4">
                <div className="flex items-center justify-between gap-2 text-[14px] text-[#646A73]">
                  <span className="px-2.5 py-1 rounded-lg bg-[#EBF2FF] text-[#1456F0] font-medium truncate">
                    {currentCard.tag || '课堂核心'}
                  </span>
                  <span className="tabular-nums shrink-0">
                    {cardIndex + 1} / {effectiveCards.length} · 已掌握 {masteredCount}
                  </span>
                </div>

                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => setFlipped((f) => !f)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setFlipped((f) => !f);
                    }
                  }}
                  className="flex-1 min-h-[240px] rounded-2xl border border-[#BEDAFF] bg-gradient-to-b from-[#F8FAFF] to-white p-5 flex flex-col justify-between shadow-xs active:scale-[0.99] transition-transform cursor-pointer select-none"
                >
                  <div className="flex items-center justify-between text-[14px] font-medium text-[#1456F0]">
                    <span>{flipped ? '参考解析与答案' : '自测提问（点击翻转）'}</span>
                    <RotateCcw className="w-4 h-4 shrink-0" />
                  </div>

                  <div className="my-auto py-4">
                    {flipped ? (
                      <MarkdownRenderer content={currentCard.back} />
                    ) : (
                      <p className="text-[17px] font-semibold text-[#1F2329] leading-relaxed">
                        {currentCard.front}
                      </p>
                    )}
                  </div>

                  <div className="text-[14px] text-[#646A73]">
                    {flipped ? '再次点击卡片切回题目面' : '先思考作答，再点击卡片核对'}
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-2">
                  <button
                    type="button"
                    disabled={cardIndex === 0}
                    onClick={() => {
                      setCardIndex((i) => Math.max(0, i - 1));
                      setFlipped(false);
                    }}
                    className="min-h-10 py-2 px-2 rounded-xl border border-[#DEE0E3] bg-white active:bg-[#F2F3F5] disabled:opacity-40 text-[14px] font-medium text-[#1F2329] inline-flex items-center justify-center gap-1 whitespace-nowrap cursor-pointer"
                  >
                    <ChevronLeft className="w-4 h-4 shrink-0" />
                    <span>上一张</span>
                  </button>

                  <button
                    type="button"
                    onClick={() =>
                      setMasteredIds((prev) => ({
                        ...prev,
                        [currentCard.id]: !prev[currentCard.id],
                      }))
                    }
                    className={`min-h-10 py-2 px-2 rounded-xl border text-[14px] font-medium inline-flex items-center justify-center gap-1 whitespace-nowrap transition-colors cursor-pointer ${
                      masteredIds[currentCard.id]
                        ? 'border-[#1456F0] bg-[#EBF2FF] text-[#1456F0]'
                        : 'border-[#DEE0E3] bg-white text-[#4E5969] active:bg-[#F2F3F5]'
                    }`}
                  >
                    <Check className="w-4 h-4 shrink-0" />
                    <span>{masteredIds[currentCard.id] ? '已掌握' : '标记掌握'}</span>
                  </button>

                  <button
                    type="button"
                    disabled={cardIndex >= effectiveCards.length - 1}
                    onClick={() => {
                      setCardIndex((i) => Math.min(effectiveCards.length - 1, i + 1));
                      setFlipped(false);
                    }}
                    className="min-h-10 py-2 px-2 rounded-xl border border-[#DEE0E3] bg-white active:bg-[#F2F3F5] disabled:opacity-40 text-[14px] font-medium text-[#1F2329] inline-flex items-center justify-center gap-1 whitespace-nowrap cursor-pointer"
                  >
                    <span>下一张</span>
                    <ChevronRight className="w-4 h-4 shrink-0" />
                  </button>
                </div>
              </div>
            ) : (
              <div className="h-full flex flex-col items-center justify-center text-center px-4 space-y-4">
                <div className="w-14 h-14 rounded-2xl bg-[#EBF2FF] text-[#1456F0] flex items-center justify-center">
                  <Layers className="w-7 h-7" />
                </div>
                <div className="space-y-1.5 max-w-sm">
                  <h3 className="text-[16px] font-semibold text-[#1F2329]">
                    一键生成课堂巩固自测闪卡
                  </h3>
                  <p className="text-[14px] text-[#646A73] leading-relaxed">
                    基于本节课提取的重点术语与关键推导生成 5 至 8 张互动问答卡，支持翻转自测或直接导出为 Anki 记忆卡包（.tsv）。
                  </p>
                </div>
              </div>
            )
          ) : (
            <div className="space-y-4 pb-2">
              <section className="space-y-2">
                <h3 className="text-[14px] font-medium text-[#646A73] px-1">
                  选择导出文件格式
                </h3>
                <div className="space-y-2.5">
                  {(
                    [
                      {
                        value: 'markdown',
                        title: 'Markdown (.md)',
                        desc: '适配 Obsidian / Notion / Typora，保留公式与表格',
                      },
                      {
                        value: 'docx',
                        title: 'Word 文档 (.docx)',
                        desc: '办公蓝标题与双栏术语表排版，适合打印与提交',
                      },
                      {
                        value: 'txt',
                        title: '纯文本 (.txt)',
                        desc: '清爽无格式纯文本归档，兼容任意阅读器',
                      },
                    ] as const
                  ).map((opt) => {
                    const selected = exportFormat === opt.value;
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => setExportFormat(opt.value)}
                        className={`w-full rounded-2xl border p-3.5 text-left space-y-1 transition-all cursor-pointer ${
                          selected
                            ? 'border-[#1456F0] bg-[#EBF2FF]/70 ring-2 ring-[#1456F0]/15'
                            : 'border-[#EAEDF1] bg-white active:bg-[#F8F9FA]'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[15px] font-semibold text-[#1F2329]">
                            {opt.title}
                          </span>
                          <FileText
                            className={`w-4 h-4 shrink-0 ${
                              selected ? 'text-[#1456F0]' : 'text-[#8F959E]'
                            }`}
                          />
                        </div>
                        <p className="text-[14px] text-[#646A73] leading-snug">{opt.desc}</p>
                      </button>
                    );
                  })}
                </div>
              </section>

              <section className="space-y-2">
                <h3 className="text-[14px] font-medium text-[#646A73] px-1">
                  勾选导出包含的内容模块
                </h3>
                <div className="rounded-2xl border border-[#EAEDF1] bg-white shadow-[0_1px_2px_rgba(31,35,41,0.03)] divide-y divide-[#F0F2F5] overflow-hidden">
                  {(
                    [
                      {
                        checked: includeStudyNote,
                        set: setIncludeStudyNote,
                        label: '一、全课精编笔记',
                        hint: effectiveNote
                          ? '已生成，将包含在文档首部'
                          : '尚未生成（可切到「精编笔记」一键生成）',
                      },
                      {
                        checked: includeHighlights,
                        set: setIncludeHighlights,
                        label: '二、核心术语与概念速查表',
                        hint: '自动汇总各段落荧光笔标注的专业词汇与语境释义',
                      },
                      {
                        checked: includeChat,
                        set: setIncludeChat,
                        label: '三、课堂问答精选记录',
                        hint: '包含您向随堂助手提出的全部问题与解答',
                      },
                      {
                        checked: includeTranscript,
                        set: setIncludeTranscript,
                        label: '四、分段精修逐字稿（含书签与批注）',
                        hint: '按知识分段整理时间戳、讲话人、不懂点标记及批注',
                      },
                      {
                        checked: includeStickyNotes,
                        set: setIncludeStickyNotes,
                        label: '五、课堂便签速记',
                        hint: '汇总本堂课保存的纸色便签与时间锚点',
                      },
                    ] as const
                  ).map((row) => (
                    <label
                      key={row.label}
                      className="flex items-center justify-between gap-3 px-4 py-3.5 cursor-pointer active:bg-[#F8F9FA] transition-colors"
                    >
                      <div className="space-y-0.5 min-w-0">
                        <div className="text-[15px] font-medium text-[#1F2329]">{row.label}</div>
                        <div className="text-[14px] text-[#646A73] leading-snug">{row.hint}</div>
                      </div>
                      <input
                        type="checkbox"
                        checked={row.checked}
                        onChange={(e) => row.set(e.target.checked)}
                        className="w-5 h-5 accent-[#1456F0] rounded shrink-0 cursor-pointer"
                      />
                    </label>
                  ))}
                </div>
              </section>
            </div>
          )}
        </div>

        {/* 手机端固定底部主操作栏 */}
        <footer
          style={{ paddingBottom: 'calc(12px + var(--android-safe-bottom, 0px))' }}
          className="border-t border-[#ECEEF2] bg-white/95 backdrop-blur-md px-3.5 pt-3 shrink-0"
        >
          {tab === 'notes' && (
            <div className="flex items-center gap-2.5">
              {effectiveNote?.contentMarkdown && !isGeneratingNote && (
                <button
                  type="button"
                  onClick={() => void handleCopyNote()}
                  className="h-11 px-4 rounded-xl border border-[#DEE0E3] bg-white active:bg-[#F2F3F5] text-[15px] font-medium text-[#1F2329] inline-flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  {copiedNote ? (
                    <>
                      <Check className="w-4 h-4 text-[#1456F0] shrink-0" />
                      <span>已复制</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-4 h-4 text-[#4E5969] shrink-0" />
                      <span>复制</span>
                    </>
                  )}
                </button>
              )}
              <button
                type="button"
                disabled={isGeneratingNote || loadingWorkspace}
                onClick={() => void handleGenerateNote()}
                className="flex-1 h-11 px-4 rounded-xl bg-[#1456F0] hover:bg-[#3370FF] disabled:opacity-60 text-white text-[15px] font-medium inline-flex items-center justify-center gap-2 whitespace-nowrap transition-colors cursor-pointer"
              >
                {isGeneratingNote ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin shrink-0" />
                    <span>正在流式编撰...</span>
                  </>
                ) : (
                  <>
                    <RefreshCw className="w-4 h-4 shrink-0" />
                    <span>{effectiveNote ? '重新生成笔记' : '一键生成全课笔记'}</span>
                  </>
                )}
              </button>
            </div>
          )}

          {tab === 'flashcards' && (
            <div className="flex items-center gap-2.5">
              {effectiveCards.length > 0 && (
                <button
                  type="button"
                  disabled={isExporting}
                  onClick={() => void handleExport('anki')}
                  className="h-11 px-3.5 rounded-xl border border-[#DEE0E3] bg-white active:bg-[#F2F3F5] text-[15px] font-medium text-[#1F2329] inline-flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <FileSpreadsheet className="w-4 h-4 text-[#1456F0] shrink-0" />
                  <span>Anki 卡包</span>
                </button>
              )}
              <button
                type="button"
                disabled={isGeneratingCards || loadingWorkspace}
                onClick={() => void handleGenerateCards()}
                className="flex-1 h-11 px-4 rounded-xl bg-[#1456F0] hover:bg-[#3370FF] disabled:opacity-60 text-white text-[15px] font-medium inline-flex items-center justify-center gap-2 whitespace-nowrap transition-colors cursor-pointer"
              >
                {isGeneratingCards ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin shrink-0" />
                    <span>正在出题...</span>
                  </>
                ) : (
                  <>
                    <RefreshCw className="w-4 h-4 shrink-0" />
                    <span>{effectiveCards.length > 0 ? '重新生成闪卡' : '生成巩固闪卡'}</span>
                  </>
                )}
              </button>
            </div>
          )}

          {tab === 'export' && (
            <button
              type="button"
              disabled={isExporting || !canExportAny}
              onClick={() => void handleExport()}
              className="w-full h-11 px-5 rounded-xl bg-[#1456F0] hover:bg-[#3370FF] disabled:opacity-50 text-white text-[15px] font-medium inline-flex items-center justify-center gap-2 whitespace-nowrap transition-colors cursor-pointer"
            >
              {isExporting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin shrink-0" />
                  <span>正在打包导出...</span>
                </>
              ) : (
                <>
                  <Download className="w-4 h-4 shrink-0" />
                  <span>立即导出文档</span>
                </>
              )}
            </button>
          )}
        </footer>
      </div>,
      document.body
    );
  }

  return (
    <Modal
      open={modalState.open}
      onClose={() => {
        if (canClose) closeNotesExportModal();
      }}
      title={`全课精编笔记与导出 · ${sessionTitle}`}
      widthClass="max-w-4xl"
    >
      <div className="flex flex-col h-[76vh] max-h-[740px]">
        {/* 顶部三视图切换栏（平板与桌面自适应换行防拥挤） */}
        <div className="px-4 sm:px-6 pt-3 sm:pt-4 pb-3 border-b border-[#ECEEF2] bg-[#F8F9FA] flex flex-wrap items-center justify-between gap-2.5 sm:gap-3 shrink-0">
          <div className="flex w-full sm:w-auto overflow-x-auto no-scrollbar rounded-xl bg-[#EBEDF0] p-1 gap-1">
            {(
              [
                { key: 'notes', label: '全课精编笔记', icon: BookOpenCheck },
                { key: 'flashcards', label: '巩固自测闪卡', icon: Layers },
                { key: 'export', label: '导出课堂文档', icon: FileDown },
              ] as const
            ).map((item) => {
              const Icon = item.icon;
              const active = tab === item.key;
              return (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => setTab(item.key)}
                  className={`h-9 px-3 sm:px-3.5 rounded-lg text-[14px] font-medium inline-flex items-center justify-center gap-1.5 sm:gap-2 shrink-0 whitespace-nowrap transition-all cursor-pointer ${
                    active
                      ? 'bg-white text-[#1456F0] shadow-xs'
                      : 'text-[#4E5969] hover:text-[#1F2329]'
                  }`}
                >
                  <Icon className="w-4 h-4 shrink-0" />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </div>

          {tab === 'notes' && (
            <div className="flex flex-wrap items-center justify-end gap-2 sm:gap-2.5">
              {effectiveNote?.contentMarkdown && !isGeneratingNote && (
                <button
                  type="button"
                  onClick={() => void handleCopyNote()}
                  className="h-9 px-3.5 rounded-lg border border-[#DEE0E3] bg-white hover:bg-[#F2F3F5] text-[14px] font-medium text-[#1F2329] inline-flex items-center gap-1.5 whitespace-nowrap transition-colors cursor-pointer"
                >
                  {copiedNote ? (
                    <>
                      <Check className="w-4 h-4 text-[#1456F0] shrink-0" />
                      <span>已复制</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-4 h-4 text-[#4E5969] shrink-0" />
                      <span>复制 Markdown</span>
                    </>
                  )}
                </button>
              )}

              <button
                type="button"
                disabled={isGeneratingNote || loadingWorkspace}
                onClick={() => void handleGenerateNote()}
                className="h-9 px-4 rounded-lg bg-[#1456F0] hover:bg-[#3370FF] disabled:opacity-60 text-white text-[14px] font-medium inline-flex items-center gap-2 whitespace-nowrap transition-colors cursor-pointer"
              >
                {isGeneratingNote ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin shrink-0" />
                    <span>正在流式编撰...</span>
                  </>
                ) : (
                  <>
                    <RefreshCw className="w-4 h-4 shrink-0" />
                    <span>{effectiveNote ? '重新生成笔记' : '一键生成全课笔记'}</span>
                  </>
                )}
              </button>
            </div>
          )}

          {tab === 'flashcards' && (
            <div className="flex flex-wrap items-center justify-end gap-2 sm:gap-2.5">
              {effectiveCards.length > 0 && (
                <button
                  type="button"
                  disabled={isExporting}
                  onClick={() => void handleExport('anki')}
                  className="h-9 px-3.5 rounded-lg border border-[#DEE0E3] bg-white hover:bg-[#F2F3F5] text-[14px] font-medium text-[#1F2329] inline-flex items-center gap-1.5 whitespace-nowrap transition-colors cursor-pointer"
                >
                  <FileSpreadsheet className="w-4 h-4 text-[#1456F0] shrink-0" />
                  <span>导出 Anki 卡包 (.tsv)</span>
                </button>
              )}
              <button
                type="button"
                disabled={isGeneratingCards || loadingWorkspace}
                onClick={() => void handleGenerateCards()}
                className="h-9 px-4 rounded-lg bg-[#1456F0] hover:bg-[#3370FF] disabled:opacity-60 text-white text-[14px] font-medium inline-flex items-center gap-2 whitespace-nowrap transition-colors cursor-pointer"
              >
                {isGeneratingCards ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin shrink-0" />
                    <span>正在出题...</span>
                  </>
                ) : (
                  <>
                    <RefreshCw className="w-4 h-4 shrink-0" />
                    <span>{effectiveCards.length > 0 ? '重新生成闪卡' : '生成巩固闪卡'}</span>
                  </>
                )}
              </button>
            </div>
          )}
        </div>

        {/* 主体内容区 */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-6 bg-white">
          {loadingWorkspace ? (
            <div className="h-full flex items-center justify-center gap-2.5 text-[15px] text-[#646A73]">
              <Loader2 className="w-5 h-5 animate-spin text-[#1456F0]" />
              <span>正在读取课堂内容...</span>
            </div>
          ) : tab === 'notes' ? (
            isGeneratingNote || effectiveNote?.contentMarkdown ? (
              <div className="max-w-3xl mx-auto space-y-4">
                {(isGeneratingNote ? streamThinking : effectiveNote?.thinking) && (
                  <ThinkingDisclosure
                    thinking={isGeneratingNote ? streamThinking : effectiveNote?.thinking}
                    isThinking={isGeneratingNote && isThinkingPhase}
                  />
                )}
                {animatedNoteContent ? (
                  <MarkdownRenderer
                    content={animatedNoteContent}
                    isStreaming={isGeneratingNote || isAnimating}
                  />
                ) : isGeneratingNote ? (
                  <div className="py-2 text-[14px] font-medium thinking-shimmer inline-block">
                    正在梳理全课知识脉络与公式推导...
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="h-full flex flex-col items-center justify-center text-center max-w-md mx-auto space-y-4">
                <div className="w-12 h-12 rounded-2xl bg-[#EBF2FF] text-[#1456F0] flex items-center justify-center">
                  <BookOpenCheck className="w-6 h-6" />
                </div>
                <div className="space-y-1.5">
                  <h3 className="text-[16px] font-semibold text-[#1F2329]">
                    尚未生成全课精编笔记
                  </h3>
                  <p className="text-[14px] text-[#646A73] leading-relaxed">
                    点击右上角「一键生成全课笔记」，AI 将综合整堂课的知识分段、荧光笔重点词、您标记的不懂点与参考讲义，生成包含导览、公式代码精解与课后待办的完整复习文档。
                  </p>
                </div>
              </div>
            )
          ) : tab === 'flashcards' ? (
            currentCard ? (
              <div className="max-w-2xl mx-auto h-full flex flex-col justify-between gap-5">
                <div className="flex items-center justify-between text-[14px] text-[#646A73]">
                  <span className="px-2.5 py-1 rounded-md bg-[#F0F4FF] text-[#1456F0] font-medium">
                    知识点：{currentCard.tag || '课堂核心'}
                  </span>
                  <span className="tabular-nums">
                    第 {cardIndex + 1} / {effectiveCards.length} 张（已掌握 {masteredCount} 张）
                  </span>
                </div>

                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => setFlipped((f) => !f)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setFlipped((f) => !f);
                    }
                  }}
                  className="flex-1 min-h-[260px] rounded-2xl border border-[#BEDAFF] bg-gradient-to-b from-[#F8FAFF] to-white p-7 flex flex-col justify-between shadow-xs hover:border-[#3370FF] transition-colors cursor-pointer select-none"
                >
                  <div className="flex items-center justify-between text-[14px] font-medium text-[#1456F0]">
                    <span>{flipped ? '参考解析与答案' : '自测提问（点击卡片翻转看答案）'}</span>
                    <RotateCcw className="w-4 h-4" />
                  </div>

                  <div className="my-auto py-4">
                    {flipped ? (
                      <MarkdownRenderer content={currentCard.back} />
                    ) : (
                      <p className="text-[17px] font-semibold text-[#1F2329] leading-relaxed">
                        {currentCard.front}
                      </p>
                    )}
                  </div>

                  <div className="text-[14px] text-[#646A73]">
                    {flipped ? '再次点击卡片可切回题目面' : '先在脑海中作答，再点击卡片核对'}
                  </div>
                </div>

                <div className="flex items-center justify-between gap-2 sm:gap-3">
                  <button
                    type="button"
                    disabled={cardIndex === 0}
                    onClick={() => {
                      setCardIndex((i) => Math.max(0, i - 1));
                      setFlipped(false);
                    }}
                    className="min-h-10 py-2 px-2.5 sm:px-4 rounded-lg border border-[#DEE0E3] bg-white hover:bg-[#F2F3F5] disabled:opacity-40 text-[14px] font-medium text-[#1F2329] inline-flex items-center gap-1 sm:gap-1.5 whitespace-nowrap cursor-pointer"
                  >
                    <ChevronLeft className="w-4 h-4 shrink-0" />
                    <span>上一张</span>
                  </button>

                  <button
                    type="button"
                    onClick={() =>
                      setMasteredIds((prev) => ({
                        ...prev,
                        [currentCard.id]: !prev[currentCard.id],
                      }))
                    }
                    className={`min-h-10 py-2 px-3 sm:px-4 rounded-lg border text-[14px] font-medium inline-flex items-center gap-1.5 sm:gap-2 whitespace-nowrap transition-colors cursor-pointer ${
                      masteredIds[currentCard.id]
                        ? 'border-[#1456F0] bg-[#EBF2FF] text-[#1456F0]'
                        : 'border-[#DEE0E3] bg-white text-[#4E5969] hover:bg-[#F2F3F5]'
                    }`}
                  >
                    <Check className="w-4 h-4 shrink-0" />
                    <span>{masteredIds[currentCard.id] ? '已掌握' : '标记掌握'}</span>
                  </button>

                  <button
                    type="button"
                    disabled={cardIndex >= effectiveCards.length - 1}
                    onClick={() => {
                      setCardIndex((i) => Math.min(effectiveCards.length - 1, i + 1));
                      setFlipped(false);
                    }}
                    className="min-h-10 py-2 px-2.5 sm:px-4 rounded-lg border border-[#DEE0E3] bg-white hover:bg-[#F2F3F5] disabled:opacity-40 text-[14px] font-medium text-[#1F2329] inline-flex items-center gap-1 sm:gap-1.5 whitespace-nowrap cursor-pointer"
                  >
                    <span>下一张</span>
                    <ChevronRight className="w-4 h-4 shrink-0" />
                  </button>
                </div>
              </div>
            ) : (
              <div className="h-full flex flex-col items-center justify-center text-center max-w-md mx-auto space-y-4">
                <div className="w-12 h-12 rounded-2xl bg-[#EBF2FF] text-[#1456F0] flex items-center justify-center">
                  <Layers className="w-6 h-6" />
                </div>
                <div className="space-y-1.5">
                  <h3 className="text-[16px] font-semibold text-[#1F2329]">
                    一键生成课堂巩固自测闪卡
                  </h3>
                  <p className="text-[14px] text-[#646A73] leading-relaxed">
                    基于本节课提取的重点术语与关键推导生成 5 至 8 张互动问答卡，支持翻转自测或直接导出为 Anki 记忆卡包（.tsv）。
                  </p>
                </div>
              </div>
            )
          ) : (
            <div className="max-w-2xl mx-auto space-y-6">
              <div className="space-y-3">
                <h3 className="text-[15px] font-semibold text-[#1F2329]">选择导出文件格式</h3>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  {(
                    [
                      {
                        value: 'markdown',
                        title: 'Markdown (.md)',
                        desc: '适配 Obsidian / Notion / Typora，保留公式与表格',
                      },
                      {
                        value: 'docx',
                        title: 'Word 文档 (.docx)',
                        desc: '办公蓝标题与双栏术语表排版，适合打印与提交',
                      },
                      {
                        value: 'txt',
                        title: '纯文本 (.txt)',
                        desc: '清爽无格式纯文本归档，兼容任意阅读器',
                      },
                    ] as const
                  ).map((opt) => {
                    const selected = exportFormat === opt.value;
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => setExportFormat(opt.value)}
                        className={`rounded-xl border p-4 text-left space-y-1.5 transition-all cursor-pointer ${
                          selected
                            ? 'border-[#1456F0] bg-[#EBF2FF]/65 ring-2 ring-[#1456F0]/15'
                            : 'border-[#DEE0E3] bg-white hover:border-[#3370FF]/60'
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-[15px] font-semibold text-[#1F2329]">
                            {opt.title}
                          </span>
                          <FileText
                            className={`w-4 h-4 ${
                              selected ? 'text-[#1456F0]' : 'text-[#8F959E]'
                            }`}
                          />
                        </div>
                        <p className="text-[14px] text-[#646A73] leading-snug">{opt.desc}</p>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="space-y-3">
                <h3 className="text-[15px] font-semibold text-[#1F2329]">勾选导出包含的内容模块</h3>
                <div className="rounded-xl border border-[#DEE0E3] bg-[#F8F9FA] divide-y divide-[#ECEEF2]">
                  {(
                    [
                      {
                        checked: includeStudyNote,
                        set: setIncludeStudyNote,
                        label: '一、全课精编笔记',
                        hint: effectiveNote
                          ? '已生成，将包含在文档首部'
                          : '尚未生成（可切到第一页签先一键生成）',
                      },
                      {
                        checked: includeHighlights,
                        set: setIncludeHighlights,
                        label: '二、核心术语与概念速查表',
                        hint: '自动汇总各段落荧光笔标注的专业词汇与语境释义',
                      },
                      {
                        checked: includeChat,
                        set: setIncludeChat,
                        label: '三、课堂问答精选记录',
                        hint: '包含您在左侧向随堂助手提出的全部问题与解答',
                      },
                      {
                        checked: includeTranscript,
                        set: setIncludeTranscript,
                        label: '四、分段精修逐字稿（含书签与个人批注）',
                        hint: '按知识分段整理时间戳、讲话人、重点/不懂点标记及批注',
                      },
                      {
                        checked: includeStickyNotes,
                        set: setIncludeStickyNotes,
                        label: '五、课堂便签速记',
                        hint: '汇总本堂课在便签篓中保存的纸色便签与时间锚点',
                      },
                    ] as const
                  ).map((row) => (
                    <label
                      key={row.label}
                      className="flex items-center justify-between gap-4 px-4 py-3.5 cursor-pointer hover:bg-white/70 transition-colors"
                    >
                      <div className="space-y-0.5">
                        <div className="text-[15px] font-medium text-[#1F2329]">{row.label}</div>
                        <div className="text-[14px] text-[#646A73]">{row.hint}</div>
                      </div>
                      <input
                        type="checkbox"
                        checked={row.checked}
                        onChange={(e) => row.set(e.target.checked)}
                        className="w-4 h-4 accent-[#1456F0] rounded cursor-pointer"
                      />
                    </label>
                  ))}
                </div>
              </div>

              <div className="flex justify-end pt-2">
                <button
                  type="button"
                  disabled={
                    isExporting ||
                    (!includeStudyNote &&
                      !includeHighlights &&
                      !includeChat &&
                      !includeTranscript &&
                      !includeStickyNotes)
                  }
                  onClick={() => void handleExport()}
                  className="min-h-11 py-2 px-6 w-full sm:w-auto rounded-xl bg-[#1456F0] hover:bg-[#3370FF] disabled:opacity-50 text-white text-[15px] font-medium inline-flex items-center justify-center gap-2 whitespace-nowrap transition-colors cursor-pointer"
                >
                  {isExporting ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>正在打包导出...</span>
                    </>
                  ) : (
                    <>
                      <Download className="w-4 h-4" />
                      <span>立即导出文档</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
};
