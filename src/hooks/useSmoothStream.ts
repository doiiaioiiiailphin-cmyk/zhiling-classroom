import { useEffect, useRef, useState } from 'react';

/**
 * 自适应 60fps 流式文本平滑器：
 * 将网络层突发到达的 SSE 分块缓冲为连续均匀的逐帧推进，
 * 既消除卡顿跳变，又在高速输出时自动加速追赶不积压延迟。
 */
export function useSmoothStream(targetText: string, isStreaming: boolean): {
  text: string;
  isAnimating: boolean;
} {
  const [displayed, setDisplayed] = useState<string>(() =>
    isStreaming ? '' : targetText
  );
  const displayedRef = useRef<string>(isStreaming ? '' : targetText);
  const targetRef = useRef<string>(targetText);
  const streamingRef = useRef<boolean>(isStreaming);
  const rafRef = useRef<number | null>(null);
  const lastFrameTimeRef = useRef<number>(0);
  const carryRef = useRef<number>(0);

  targetRef.current = targetText;
  streamingRef.current = isStreaming;

  useEffect(() => {
    // 非流式历史消息且当前未处于追赶态：直接同步显示
    if (!isStreaming && displayedRef.current === targetText) {
      return;
    }

    // 若目标文本发生了非前缀替换（例如最终规整了首尾空白），且流已结束且几乎追平，平滑对齐
    if (!targetText.startsWith(displayedRef.current)) {
      if (!isStreaming) {
        displayedRef.current = targetText;
        setDisplayed(targetText);
        return;
      }
      // 流式中若被重置为空
      if (!targetText) {
        displayedRef.current = '';
        setDisplayed('');
        return;
      }
    }

    if (rafRef.current !== null) {
      return;
    }

    const stepFrame = (now: number) => {
      const target = targetRef.current;
      const current = displayedRef.current;

      if (!target.startsWith(current)) {
        displayedRef.current = target;
        carryRef.current = 0;
        lastFrameTimeRef.current = 0;
        rafRef.current = null;
        setDisplayed(target);
        return;
      }

      const remaining = target.length - current.length;
      if (remaining <= 0) {
        lastFrameTimeRef.current = 0;
        rafRef.current = null;
        return;
      }

      const prevTime = lastFrameTimeRef.current || now - 16.67;
      const dt = Math.min(50, Math.max(8, now - prevTime));
      lastFrameTimeRef.current = now;
      const frameScale = dt / 16.67;

      let advanceFloat: number;
      if (!streamingRef.current) {
        // 网络流已完成，快速平滑收尾
        advanceFloat = Math.max(3, remaining * 0.34) * frameScale;
      } else {
        // 基础丝滑推进速度 + 按积压量自适应平滑追赶
        advanceFloat = (1.5 + remaining * 0.115) * frameScale;
      }

      carryRef.current += advanceFloat;
      const stepCount = Math.floor(carryRef.current);

      if (stepCount >= 1) {
        carryRef.current -= stepCount;
        let nextLen = Math.min(target.length, current.length + stepCount);

        // 避免截断 UTF-16 代理对（如生僻数学符号）
        if (nextLen < target.length) {
          const code = target.charCodeAt(nextLen - 1);
          if (code >= 0xd800 && code <= 0xdbff) {
            nextLen += 1;
          }
        }

        const nextSlice = target.slice(0, nextLen);
        displayedRef.current = nextSlice;
        setDisplayed(nextSlice);
      }

      if (displayedRef.current.length < targetRef.current.length) {
        rafRef.current = window.requestAnimationFrame(stepFrame);
      } else {
        lastFrameTimeRef.current = 0;
        rafRef.current = null;
      }
    };

    rafRef.current = window.requestAnimationFrame(stepFrame);
  }, [targetText, isStreaming]);

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, []);

  const isAnimating = isStreaming || displayed.length < targetText.length;
  return { text: displayed, isAnimating };
}
