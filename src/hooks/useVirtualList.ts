import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

export interface VirtualListOptions {
  count: number;
  getItemKey: (index: number) => string;
  estimateSize: (index: number) => number;
  gap?: number;
  overscanPx?: number;
}

export interface VirtualRange {
  startIndex: number;
  endIndex: number;
  topSpacerPx: number;
  bottomSpacerPx: number;
  totalHeightPx: number;
}

export interface VirtualListResult {
  scrollRef: React.RefObject<HTMLDivElement | null>;
  measureElement: (node: HTMLElement | null) => void;
  notifyScroll: () => void;
  scrollToIndex: (index: number) => void;
  range: VirtualRange;
}

function lowerBound(offsets: Float64Array, target: number): number {
  let lo = 0;
  let hi = offsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (offsets[mid] <= target) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo;
}

export function useVirtualList({
  count,
  getItemKey,
  estimateSize,
  gap = 16,
  overscanPx = 700,
}: VirtualListOptions): VirtualListResult {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const measuredHeightsRef = useRef<Map<string, number>>(new Map());
  const elementToKeyRef = useRef<WeakMap<Element, string>>(new WeakMap());
  const activeElementsRef = useRef<Map<string, HTMLElement>>(new Map());
  const resizeObserverRef = useRef<ResizeObserver | null>(null);

  const [viewport, setViewport] = useState<{ scrollTop: number; clientHeight: number }>({
    scrollTop: 0,
    clientHeight: 900,
  });
  const [measureVersion, setMeasureVersion] = useState(0);
  const rafScrollRef = useRef<number | null>(null);
  const lastContainerWidthRef = useRef<number>(0);

  // Keep latest callbacks/offsets accessible in ResizeObserver without recreating it
  const itemIndexByKeyRef = useRef<Map<string, number>>(new Map());
  const offsetsRef = useRef<Float64Array>(new Float64Array(0));

  const syncViewportNow = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nextTop = el.scrollTop;
    const nextHeight = el.clientHeight || 900;
    const atEdge = nextTop <= 4 || nextTop >= el.scrollHeight - nextHeight - 24;
    setViewport((prev) => {
      const threshold = atEdge ? 2 : 96;
      if (
        Math.abs(prev.scrollTop - nextTop) < threshold &&
        Math.abs(prev.clientHeight - nextHeight) < 4
      ) {
        return prev;
      }
      return { scrollTop: nextTop, clientHeight: nextHeight };
    });
  }, []);

  const notifyScroll = useCallback(() => {
    if (rafScrollRef.current !== null) return;
    rafScrollRef.current = window.requestAnimationFrame(() => {
      rafScrollRef.current = null;
      syncViewportNow();
    });
  }, [syncViewportNow]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    lastContainerWidthRef.current = el.clientWidth;
    setViewport({
      scrollTop: el.scrollTop,
      clientHeight: el.clientHeight || 900,
    });

    const containerObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const width = entry.contentRect.width;
      const height = entry.contentRect.height || 900;
      if (
        lastContainerWidthRef.current > 0 &&
        Math.abs(width - lastContainerWidthRef.current) > 6
      ) {
        lastContainerWidthRef.current = width;
        // Re-measure currently mounted elements immediately; clear off-screen stale widths
        const mountedKeys = new Set(activeElementsRef.current.keys());
        for (const key of measuredHeightsRef.current.keys()) {
          if (!mountedKeys.has(key)) {
            measuredHeightsRef.current.delete(key);
          }
        }
        for (const [key, node] of activeElementsRef.current.entries()) {
          const h = node.offsetHeight;
          if (h > 0) {
            measuredHeightsRef.current.set(key, h);
          }
        }
        setMeasureVersion((v) => v + 1);
      } else {
        lastContainerWidthRef.current = width;
      }
      setViewport((prev) =>
        Math.abs(prev.clientHeight - height) < 2 && Math.abs(prev.scrollTop - el.scrollTop) < 2
          ? prev
          : { scrollTop: el.scrollTop, clientHeight: height }
      );
    });

    containerObserver.observe(el);
    return () => {
      containerObserver.disconnect();
      if (rafScrollRef.current !== null) {
        window.cancelAnimationFrame(rafScrollRef.current);
        rafScrollRef.current = null;
      }
    };
  }, []);

  // Shared ResizeObserver for mounted virtual items
  useEffect(() => {
    const ro = new ResizeObserver((entries) => {
      const scrollEl = scrollRef.current;
      let changed = false;
      let scrollDelta = 0;

      for (const entry of entries) {
        const target = entry.target as HTMLElement;
        const key = target.dataset.virtualKey ?? elementToKeyRef.current.get(target);
        if (!key) continue;
        const borderSize = entry.borderBoxSize?.[0]?.blockSize;
        const nextHeight =
          typeof borderSize === 'number' && borderSize > 0 ? borderSize : target.offsetHeight;
        if (nextHeight <= 0) continue;

        const prevHeight = measuredHeightsRef.current.get(key);
        if (prevHeight === undefined || Math.abs(prevHeight - nextHeight) >= 0.5) {
          // If this item sits above the current scroll fold, compensate scrollTop to prevent visual jump
          if (scrollEl && prevHeight !== undefined) {
            const idx = itemIndexByKeyRef.current.get(key);
            const offsets = offsetsRef.current;
            if (idx !== undefined && idx < offsets.length && offsets[idx] < scrollEl.scrollTop - 2) {
              scrollDelta += nextHeight - prevHeight;
            }
          }
          measuredHeightsRef.current.set(key, nextHeight);
          changed = true;
        }
      }

      if (scrollDelta !== 0 && scrollEl) {
        scrollEl.scrollTop += scrollDelta;
      }
      if (changed) {
        if (measuredHeightsRef.current.size > 5000) {
          const firstKey = measuredHeightsRef.current.keys().next().value;
          if (firstKey !== undefined) {
            measuredHeightsRef.current.delete(firstKey);
          }
        }
        setMeasureVersion((v) => v + 1);
      }
    });

    resizeObserverRef.current = ro;
    for (const node of activeElementsRef.current.values()) {
      ro.observe(node);
    }

    return () => {
      ro.disconnect();
      resizeObserverRef.current = null;
    };
  }, []);

  const measureElement = useCallback((node: HTMLElement | null) => {
    if (!node) return;
    const key = node.dataset.virtualKey;
    if (!key) return;

    const prevNode = activeElementsRef.current.get(key);
    if (prevNode && prevNode !== node) {
      resizeObserverRef.current?.unobserve(prevNode);
    }
    activeElementsRef.current.set(key, node);
    elementToKeyRef.current.set(node, key);
    resizeObserverRef.current?.observe(node);

    const h = node.offsetHeight;
    if (h > 0) {
      const prev = measuredHeightsRef.current.get(key);
      if (prev === undefined || Math.abs(prev - h) >= 1) {
        const scrollEl = scrollRef.current;
        const idx = itemIndexByKeyRef.current.get(key);
        const offsets = offsetsRef.current;
        // Compensate even on first measurement if item mounted above current scrollTop (upward scroll)
        if (
          scrollEl &&
          idx !== undefined &&
          idx < offsets.length &&
          offsets[idx] < scrollEl.scrollTop - 2
        ) {
          const priorEstimate =
            idx + 1 < offsets.length
              ? offsets[idx + 1] - offsets[idx] - gap
              : prev;
          if (priorEstimate !== undefined && Math.abs(h - priorEstimate) >= 1) {
            scrollEl.scrollTop += h - priorEstimate;
          }
        }
        measuredHeightsRef.current.set(key, h);
        setMeasureVersion((v) => v + 1);
      }
    }
  }, [gap]);

  const layout = useMemo(() => {
    // Reference measureVersion so layout recomputes when heights update
    void measureVersion;

    const indexMap = new Map<string, number>();
    if (count === 0) {
      itemIndexByKeyRef.current = indexMap;
      offsetsRef.current = new Float64Array(0);
      return {
        offsets: new Float64Array(0),
        heights: new Float64Array(0),
        totalHeightPx: 0,
      };
    }

    const offsets = new Float64Array(count);
    const heights = new Float64Array(count);
    let running = 0;

    for (let i = 0; i < count; i++) {
      const key = getItemKey(i);
      indexMap.set(key, i);
      const h = measuredHeightsRef.current.get(key) ?? estimateSize(i);
      offsets[i] = running;
      heights[i] = h;
      running += h + (i < count - 1 ? gap : 0);
    }

    itemIndexByKeyRef.current = indexMap;
    offsetsRef.current = offsets;

    return {
      offsets,
      heights,
      totalHeightPx: running,
    };
  }, [count, getItemKey, estimateSize, gap, measureVersion]);

  // Prune unmounted nodes from activeElementsRef after render
  useEffect(() => {
    for (const [key, node] of activeElementsRef.current.entries()) {
      if (!node.isConnected) {
        resizeObserverRef.current?.unobserve(node);
        activeElementsRef.current.delete(key);
      }
    }
  });

  const range = useMemo<VirtualRange>(() => {
    if (count === 0) {
      return {
        startIndex: 0,
        endIndex: -1,
        topSpacerPx: 0,
        bottomSpacerPx: 0,
        totalHeightPx: 0,
      };
    }

    const { offsets, heights, totalHeightPx } = layout;
    const minVisibleY = Math.max(0, viewport.scrollTop - overscanPx);
    const maxVisibleY = viewport.scrollTop + Math.max(viewport.clientHeight, 400) + overscanPx;

    let startIndex = lowerBound(offsets, minVisibleY);
    while (startIndex > 0 && offsets[startIndex] + heights[startIndex] > minVisibleY && startIndex === count - 1) {
      break;
    }
    // Walk back 1 if lowerBound landed after an item whose bottom still overlaps minVisibleY
    if (startIndex > 0 && offsets[startIndex - 1] + heights[startIndex - 1] >= minVisibleY) {
      startIndex -= 1;
    }

    let endIndex = lowerBound(offsets, maxVisibleY);
    if (endIndex < count - 1 && offsets[endIndex] < maxVisibleY) {
      // lowerBound already gives the last index whose start <= maxVisibleY
    }
    endIndex = Math.min(count - 1, Math.max(startIndex, endIndex));

    const topSpacerPx = startIndex > 0 ? offsets[startIndex] : 0;
    const visibleEndBottom = offsets[endIndex] + heights[endIndex];
    const bottomSpacerPx =
      endIndex < count - 1 ? Math.max(0, totalHeightPx - visibleEndBottom) : 0;

    return {
      startIndex,
      endIndex,
      topSpacerPx,
      bottomSpacerPx,
      totalHeightPx,
    };
  }, [count, layout, overscanPx, viewport.clientHeight, viewport.scrollTop]);

  const scrollToIndex = useCallback((index: number) => {
    const el = scrollRef.current;
    const offsets = offsetsRef.current;
    if (!el || index < 0 || index >= offsets.length) return;
    const targetTop = Math.max(0, offsets[index] - 12);
    el.scrollTo({ top: targetTop, behavior: 'smooth' });
    setViewport((prev) => ({ ...prev, scrollTop: targetTop }));
  }, []);

  return {
    scrollRef,
    measureElement,
    notifyScroll,
    scrollToIndex,
    range,
  };
}
