import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useViewportLayout } from '../../utils/desktopBridge';
import { MiniOverlayView, type OverlaySyncSnapshot } from './MiniOverlayView';

interface MobilePreviewFloatingOverlayProps {
  open: boolean;
  snapshot: OverlaySyncSnapshot;
  onClose: () => void;
}

const BUBBLE_W = 94;
const BUBBLE_H = 44;

/**
 * 浏览器移动端预览台（/?platform=android 且无原生 Android 壳）专用的可拖动、可缩放、可收起悬浮窗宿主，
 * 与 Android 原生 FloatingOverlayController 交互行为 1:1 保持一致，便于在网页预览中直接体验悬浮小窗与横竖屏旋转适配。
 */
export const MobilePreviewFloatingOverlay: React.FC<MobilePreviewFloatingOverlayProps> = ({
  open,
  snapshot,
  onClose,
}) => {
  const { width: vw, height: vh, isLandscape } = useViewportLayout();
  const [collapsed, setCollapsed] = useState(false);
  const [aiExpanded, setAiExpanded] = useState(false);
  const [isPointerDragging, setIsPointerDragging] = useState(false);
  const [rect, setRect] = useState(() => ({
    x: 16,
    y: 64,
    w: 344,
    h: 224,
  }));
  const [bubblePos, setBubblePos] = useState(() => ({
    x: Math.max(12, vw - BUBBLE_W - 12),
    y: 120,
  }));
  const rectRef = useRef(rect);
  const bubblePosRef = useRef(bubblePos);
  rectRef.current = rect;
  bubblePosRef.current = bubblePos;

  // 横竖屏旋转或视口尺寸改变时，自动夹紧悬浮窗与悬浮球位置，避免飘出屏幕外
  useEffect(() => {
    const pad = 10;
    const maxW = Math.max(260, vw - pad * 2);
    const maxH = Math.max(170, vh - pad * 2);
    setRect((prev) => {
      const targetW = Math.min(prev.w, maxW);
      const targetH = Math.min(prev.h, maxH);
      const next = {
        x: Math.max(pad, Math.min(prev.x, vw - targetW - pad)),
        y: Math.max(pad, Math.min(prev.y, vh - targetH - pad)),
        w: targetW,
        h: targetH,
      };
      rectRef.current = next;
      return next;
    });
    setBubblePos((prev) => {
      const next = {
        x: prev.x + BUBBLE_W / 2 < vw / 2 ? pad : Math.max(pad, vw - BUBBLE_W - pad),
        y: Math.max(48, Math.min(prev.y, vh - BUBBLE_H - 16)),
      };
      bubblePosRef.current = next;
      return next;
    });
  }, [vw, vh, isLandscape]);

  const handleMove = useCallback(
    (dx: number, dy: number) => {
      const pad = 8;
      if (collapsed) {
        setBubblePos((prev) => {
          const next = {
            x: Math.max(pad, Math.min(prev.x + dx, vw - BUBBLE_W - pad)),
            y: Math.max(pad, Math.min(prev.y + dy, vh - BUBBLE_H - pad)),
          };
          bubblePosRef.current = next;
          return next;
        });
      } else {
        setRect((prev) => {
          const next = {
            ...prev,
            x: Math.max(pad, Math.min(prev.x + dx, vw - prev.w - pad)),
            y: Math.max(pad, Math.min(prev.y + dy, vh - prev.h - pad)),
          };
          rectRef.current = next;
          return next;
        });
      }
    },
    [collapsed, vw, vh]
  );

  const handleResize = useCallback(
    (dw: number, dh: number) => {
      const pad = 8;
      setRect((prev) => {
        const nextW = Math.max(260, Math.min(vw - prev.x - pad, prev.w + dw));
        const nextH = Math.max(170, Math.min(vh - prev.y - pad, prev.h + dh));
        const next = { ...prev, w: nextW, h: nextH };
        rectRef.current = next;
        return next;
      });
    },
    [vw, vh]
  );

  const handleCollapseChange = useCallback(
    (nextCollapsed: boolean) => {
      const pad = 10;
      setCollapsed(nextCollapsed);
      if (nextCollapsed) {
        const curRect = rectRef.current;
        const snapLeft = curRect.x + curRect.w / 2 < vw / 2;
        const nextBubble = {
          x: snapLeft ? pad : Math.max(pad, vw - BUBBLE_W - pad),
          y: Math.max(48, Math.min(curRect.y, vh - BUBBLE_H - 16)),
        };
        bubblePosRef.current = nextBubble;
        setBubblePos(nextBubble);
      } else {
        // 展开时跟随收起后悬浮球移动到的最新位置，而不是跳回收起前的旧坐标
        const curBubble = bubblePosRef.current;
        const prevRect = rectRef.current;
        const maxW = Math.max(260, vw - pad * 2);
        const maxH = Math.max(170, vh - pad * 2);
        const targetW = Math.min(prevRect.w, maxW);
        const targetH = Math.min(prevRect.h, maxH);
        const bubbleOnRight = curBubble.x + BUBBLE_W / 2 >= vw / 2;
        const desiredX = bubbleOnRight
          ? curBubble.x + BUBBLE_W - targetW
          : curBubble.x;
        const desiredY = curBubble.y;
        const nextRect = {
          x: Math.max(pad, Math.min(desiredX, vw - targetW - pad)),
          y: Math.max(pad, Math.min(desiredY, vh - targetH - pad)),
          w: targetW,
          h: targetH,
        };
        rectRef.current = nextRect;
        setRect(nextRect);
      }
    },
    [vw, vh]
  );

  const handleAiExpandChange = useCallback(
    (expanded: boolean) => {
      setAiExpanded(expanded);
      const pad = 10;
      const desiredH = expanded
        ? Math.min(isLandscape ? 320 : 410, vh - pad * 2)
        : Math.min(isLandscape ? 190 : 224, vh - pad * 2);
      setRect((prev) => {
        const next = {
          ...prev,
          y: Math.max(pad, Math.min(prev.y, vh - desiredH - pad)),
          h: desiredH,
        };
        rectRef.current = next;
        return next;
      });
    },
    [isLandscape, vh]
  );

  const handleBubbleSnapEdge = useCallback(() => {
    const pad = 10;
    setBubblePos((prev) => {
      const next = {
        x: prev.x + BUBBLE_W / 2 < vw / 2 ? pad : Math.max(pad, vw - BUBBLE_W - pad),
        y: Math.max(48, Math.min(prev.y, vh - BUBBLE_H - 16)),
      };
      bubblePosRef.current = next;
      return next;
    });
  }, [vw, vh]);

  if (!open) return null;

  const box = collapsed
    ? { x: bubblePos.x, y: bubblePos.y, w: BUBBLE_W, h: BUBBLE_H }
    : {
        x: Math.max(8, Math.min(rect.x, vw - Math.min(rect.w, vw - 16) - 8)),
        y: Math.max(8, Math.min(rect.y, vh - Math.min(rect.h, vh - 16) - 8)),
        w: Math.min(rect.w, Math.max(260, vw - 16)),
        h: Math.min(rect.h, Math.max(170, vh - 16)),
      };

  return (
    <div
      data-testid="mobile-preview-floating-overlay"
      data-collapsed={collapsed ? 'true' : 'false'}
      data-ai-open={aiExpanded ? 'true' : 'false'}
      style={{
        left: `${box.x}px`,
        top: `${box.y}px`,
        width: `${box.w}px`,
        height: `${box.h}px`,
        transitionTimingFunction: isPointerDragging
          ? undefined
          : 'var(--spring-sheet, cubic-bezier(0.22, 1, 0.36, 1))',
      }}
      className={`fixed z-[92] ${
        isPointerDragging
          ? 'transition-none'
          : 'transition-[left,top,width,height] duration-[320ms]'
      }`}
    >
      <MiniOverlayView
        embeddedPreview
        initialSnap={snapshot}
        onRequestClose={onClose}
        onPreviewMove={handleMove}
        onPreviewResize={handleResize}
        onPreviewBubbleSnapEdge={handleBubbleSnapEdge}
        onPreviewOpStateChange={setIsPointerDragging}
        onPreviewCollapseChange={handleCollapseChange}
        onPreviewAiExpandChange={handleAiExpandChange}
      />
    </div>
  );
};
