import { useEffect, useState } from 'react';

/**
 * 双阶段进退场动效状态管理：
 * - open 变为 true 时：先挂载节点（isVisible=false），下一帧切换为 isVisible=true 触发弹簧展开动画；
 * - open 变为 false 时：先置 isVisible=false 触发渐隐缩放动画，待 exitDurationMs 后卸载节点。
 */
export function useAnimatedPresence(
  open: boolean,
  exitDurationMs = 160
): { shouldRender: boolean; isVisible: boolean } {
  const [shouldRender, setShouldRender] = useState(open);
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    if (open) {
      setShouldRender(true);
      let raf2: number | null = null;
      const raf1 = window.requestAnimationFrame(() => {
        raf2 = window.requestAnimationFrame(() => {
          setIsVisible(true);
        });
      });
      return () => {
        window.cancelAnimationFrame(raf1);
        if (raf2 !== null) window.cancelAnimationFrame(raf2);
      };
    }

    setIsVisible(false);
    const timer = window.setTimeout(() => {
      setShouldRender(false);
    }, exitDurationMs);
    return () => window.clearTimeout(timer);
  }, [open, exitDurationMs]);

  return { shouldRender, isVisible };
}
