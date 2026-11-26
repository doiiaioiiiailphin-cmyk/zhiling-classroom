import { useCallback, useEffect, useRef, useState } from 'react';
import {
  computeAnchorIndexBounds,
  computeEdgeAutoScrollSpeed,
  computeMarqueeViewportRect,
  computeVirtualSelectionRange,
  resolveDragSelectedIds,
  type AnchorIndexBounds,
  type ContentPoint,
  type MountedRowBox,
  type ViewportRect,
} from '../utils/marqueeSelection';

export interface ActiveMarqueeVisual {
  rect: ViewportRect;
  mode: 'select' | 'deselect';
  rangeCount: number;
}

interface UseMarqueeAutoScrollOptions {
  enabled: boolean;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  orderedIds: string[];
  idToIndex: Map<string, number>;
  selectedIds: Set<string>;
  onSelectedIdsChange: (next: Set<string>) => void;
  onNotifyScroll: () => void;
  edgeZonePx?: number;
}

interface DragSession {
  pointerId: number;
  kind: 'marquee' | 'rail';
  startClientX: number;
  startClientY: number;
  lastClientX: number;
  lastClientY: number;
  anchorContent: ContentPoint;
  anchorBounds: AnchorIndexBounds;
  baseSelectedIds: Set<string>;
  mode: 'select' | 'deselect';
  activated: boolean;
}

const DRAG_ACTIVATION_PX = 6;

function collectMountedRows(
  container: HTMLElement,
  idToIndex: Map<string, number>
): MountedRowBox[] {
  const containerRect = container.getBoundingClientRect();
  const scrollLeft = container.scrollLeft;
  const scrollTop = container.scrollTop;
  const nodes = container.querySelectorAll<HTMLElement>('[data-utterance-id]');
  const boxes: MountedRowBox[] = [];
  for (const node of nodes) {
    const uid = node.dataset.utteranceId;
    if (!uid) continue;
    const orderIndex = idToIndex.get(uid);
    if (orderIndex === undefined) continue;
    const rect = node.getBoundingClientRect();
    boxes.push({
      orderIndex,
      contentLeft: rect.left - containerRect.left + scrollLeft,
      contentRight: rect.right - containerRect.left + scrollLeft,
      contentTop: rect.top - containerRect.top + scrollTop,
      contentBottom: rect.bottom - containerRect.top + scrollTop,
    });
  }
  return boxes;
}

function isBlockingInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest('input, textarea, a, [data-marquee-ignore="true"]'));
}

export function useMarqueeAutoScroll({
  enabled,
  scrollRef,
  orderedIds,
  idToIndex,
  selectedIds,
  onSelectedIdsChange,
  onNotifyScroll,
  edgeZonePx = 68,
}: UseMarqueeAutoScrollOptions) {
  const [marqueeVisual, setMarqueeVisual] = useState<ActiveMarqueeVisual | null>(null);
  const [isDraggingSelection, setIsDraggingSelection] = useState(false);

  const sessionRef = useRef<DragSession | null>(null);
  const rafIdRef = useRef<number | null>(null);
  const lastFrameTsRef = useRef<number>(0);
  const suppressClickUntilRef = useRef<number>(0);

  // 保持最新引用避免 rAF 闭包拿到过期状态
  const orderedIdsRef = useRef(orderedIds);
  const idToIndexRef = useRef(idToIndex);
  const selectedIdsRef = useRef(selectedIds);
  const onSelectedIdsChangeRef = useRef(onSelectedIdsChange);
  const onNotifyScrollRef = useRef(onNotifyScroll);
  orderedIdsRef.current = orderedIds;
  idToIndexRef.current = idToIndex;
  selectedIdsRef.current = selectedIds;
  onSelectedIdsChangeRef.current = onSelectedIdsChange;
  onNotifyScrollRef.current = onNotifyScroll;

  const stopRaf = useCallback(() => {
    if (rafIdRef.current !== null) {
      window.cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    lastFrameTsRef.current = 0;
  }, []);

  const applyCurrentPointerSelection = useCallback((session: DragSession) => {
    const container = scrollRef.current;
    if (!container) return;

    const containerRect = container.getBoundingClientRect();
    const currentContent: ContentPoint = {
      x: session.lastClientX - containerRect.left + container.scrollLeft,
      y: session.lastClientY - containerRect.top + container.scrollTop,
    };

    const mountedRows = collectMountedRows(container, idToIndexRef.current);
    const range = computeVirtualSelectionRange({
      anchor: session.anchorContent,
      current: currentContent,
      anchorBounds: session.anchorBounds,
      mountedRows,
      requireHorizontalOverlap: session.kind === 'marquee',
    });

    const nextSelected = resolveDragSelectedIds(
      orderedIdsRef.current,
      session.baseSelectedIds,
      range,
      session.mode
    );
    onSelectedIdsChangeRef.current(nextSelected);

    if (session.kind === 'marquee') {
      const rect = computeMarqueeViewportRect(
        session.anchorContent,
        currentContent,
        container.scrollLeft,
        container.scrollTop,
        container.clientWidth,
        container.clientHeight
      );
      const rangeCount = range ? Math.abs(range[1] - range[0]) + 1 : 0;
      setMarqueeVisual({
        rect,
        mode: session.mode,
        rangeCount,
      });
    } else {
      setMarqueeVisual(null);
    }
  }, [scrollRef]);

  const endDragSession = useCallback(() => {
    const session = sessionRef.current;
    if (session?.activated) {
      suppressClickUntilRef.current = performance.now() + 180;
    }
    sessionRef.current = null;
    stopRaf();
    setMarqueeVisual(null);
    setIsDraggingSelection(false);
  }, [stopRaf]);

  const startAutoScrollLoop = useCallback(() => {
    if (rafIdRef.current !== null) return;
    lastFrameTsRef.current = performance.now();

    const tick = (now: number) => {
      const session = sessionRef.current;
      const container = scrollRef.current;
      if (!session || !session.activated || !container) {
        rafIdRef.current = null;
        lastFrameTsRef.current = 0;
        return;
      }

      const dtSec = Math.min(0.032, Math.max(0.001, (now - lastFrameTsRef.current) / 1000));
      lastFrameTsRef.current = now;

      const rect = container.getBoundingClientRect();
      const speed = computeEdgeAutoScrollSpeed(
        session.lastClientY,
        rect.top,
        rect.bottom,
        edgeZonePx
      );

      if (speed !== 0) {
        const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
        const prevTop = container.scrollTop;
        const nextTop = Math.max(0, Math.min(maxScrollTop, prevTop + speed * dtSec));
        if (Math.abs(nextTop - prevTop) >= 0.5) {
          container.scrollTop = nextTop;
          onNotifyScrollRef.current();
          applyCurrentPointerSelection(session);
        }
        rafIdRef.current = window.requestAnimationFrame(tick);
      } else {
        rafIdRef.current = null;
        lastFrameTsRef.current = 0;
      }
    };

    rafIdRef.current = window.requestAnimationFrame(tick);
  }, [scrollRef, edgeZonePx, applyCurrentPointerSelection]);

  // 监听全局 pointermove / pointerup / blur，确保拖到滚动区外部也能平滑自动滚动并正确结束
  useEffect(() => {
    if (!enabled) {
      endDragSession();
      return;
    }

    const handleWindowPointerMove = (e: PointerEvent) => {
      const session = sessionRef.current;
      if (!session || e.pointerId !== session.pointerId) return;

      session.lastClientX = e.clientX;
      session.lastClientY = e.clientY;

      if (!session.activated) {
        const dist = Math.hypot(
          e.clientX - session.startClientX,
          e.clientY - session.startClientY
        );
        if (dist < DRAG_ACTIVATION_PX) return;
        session.activated = true;
        setIsDraggingSelection(true);
        try {
          window.getSelection()?.removeAllRanges();
        } catch {
          // ignore
        }
      }

      if (session.kind === 'rail') {
        e.preventDefault();
      }

      applyCurrentPointerSelection(session);

      const container = scrollRef.current;
      if (container) {
        const rect = container.getBoundingClientRect();
        const speed = computeEdgeAutoScrollSpeed(e.clientY, rect.top, rect.bottom, edgeZonePx);
        if (speed !== 0) {
          startAutoScrollLoop();
        } else {
          stopRaf();
        }
      }
    };

    const handleWindowPointerUp = (e: PointerEvent) => {
      const session = sessionRef.current;
      if (!session || e.pointerId !== session.pointerId) return;
      endDragSession();
    };

    const handleWindowBlur = () => {
      if (sessionRef.current) endDragSession();
    };

    window.addEventListener('pointermove', handleWindowPointerMove, { passive: false });
    window.addEventListener('pointerup', handleWindowPointerUp);
    window.addEventListener('pointercancel', handleWindowPointerUp);
    window.addEventListener('blur', handleWindowBlur);

    return () => {
      window.removeEventListener('pointermove', handleWindowPointerMove);
      window.removeEventListener('pointerup', handleWindowPointerUp);
      window.removeEventListener('pointercancel', handleWindowPointerUp);
      window.removeEventListener('blur', handleWindowBlur);
      endDragSession();
    };
  }, [enabled, scrollRef, edgeZonePx, applyCurrentPointerSelection, startAutoScrollLoop, stopRaf, endDragSession]);

  const handleContainerPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!enabled || orderedIdsRef.current.length === 0) return;
      if (isBlockingInteractiveTarget(e.target)) return;

      const container = scrollRef.current;
      if (!container) return;

      // 鼠标/触控笔：容器内任意位置按左键拖动即可拉出蓝框选框
      // 触控手指：仅在左侧勾选轨（data-batch-checkbox-rail="true"）按下时触发连续滑选，正文区保留原生滚动
      const targetEl = e.target instanceof Element ? e.target : null;
      const isTouch = e.pointerType === 'touch';
      const onCheckboxRail = Boolean(targetEl?.closest('[data-batch-checkbox-rail="true"]'));

      if (isTouch) {
        if (!onCheckboxRail) return;
      } else if (e.button !== 0) {
        return;
      }

      // 排除点击原生垂直滚动条轨道（位于 clientWidth 右侧）
      const containerRect = container.getBoundingClientRect();
      if (!isTouch && e.clientX > containerRect.left + container.clientWidth) {
        return;
      }

      const anchorContent: ContentPoint = {
        x: e.clientX - containerRect.left + container.scrollLeft,
        y: e.clientY - containerRect.top + container.scrollTop,
      };
      const mountedRows = collectMountedRows(container, idToIndexRef.current);
      const anchorBounds = computeAnchorIndexBounds(
        mountedRows,
        anchorContent.y,
        orderedIdsRef.current.length
      );

      // 智能极性：起点正好落在已选中的行上 -> 本次拖拽取消选中；否则 -> 加入选中
      const hitId =
        anchorBounds.hitRowIndex !== null
          ? orderedIdsRef.current[anchorBounds.hitRowIndex]
          : null;
      const mode: 'select' | 'deselect' =
        hitId && selectedIdsRef.current.has(hitId) ? 'deselect' : 'select';

      sessionRef.current = {
        pointerId: e.pointerId,
        kind: isTouch ? 'rail' : 'marquee',
        startClientX: e.clientX,
        startClientY: e.clientY,
        lastClientX: e.clientX,
        lastClientY: e.clientY,
        anchorContent,
        anchorBounds,
        baseSelectedIds: new Set(selectedIdsRef.current),
        mode,
        activated: false,
      };
    },
    [enabled, scrollRef]
  );

  const shouldSuppressRowClick = useCallback(() => {
    return performance.now() < suppressClickUntilRef.current;
  }, []);

  const syncSelectionOnScroll = useCallback(() => {
    const session = sessionRef.current;
    if (session && session.activated) {
      applyCurrentPointerSelection(session);
    }
  }, [applyCurrentPointerSelection]);

  return {
    marqueeVisual,
    isDraggingSelection,
    handleContainerPointerDown,
    shouldSuppressRowClick,
    syncSelectionOnScroll,
    cancelMarqueeDrag: endDragSession,
  };
}
