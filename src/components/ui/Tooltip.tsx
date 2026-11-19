import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  useFloating,
  autoUpdate,
  offset,
  flip,
  shift,
  FloatingPortal,
  type Placement,
} from '@floating-ui/react';

interface TooltipProps {
  content: React.ReactNode;
  children: React.ReactElement;
  placement?: Placement;
  maxWidthClass?: string;
  delayMs?: number;
}

function assignRef<T>(ref: React.Ref<T> | undefined, value: T | null): void {
  if (!ref) return;
  if (typeof ref === 'function') {
    ref(value);
  } else if (typeof ref === 'object') {
    (ref as React.MutableRefObject<T | null>).current = value;
  }
}

export const Tooltip: React.FC<TooltipProps> = ({
  content,
  children,
  placement = 'top',
  maxWidthClass = 'max-w-xs',
  delayMs = 140,
}) => {
  const tooltipId = useId();
  const [isOpen, setIsOpen] = useState(false);

  const domRef = useRef<HTMLElement | null>(null);
  const openTimerRef = useRef<number | null>(null);
  const isHoveredRef = useRef(false);
  const isFocusedRef = useRef(false);

  const clearOpenTimer = useCallback(() => {
    if (openTimerRef.current !== null) {
      window.clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
  }, []);

  const closeImmediately = useCallback(() => {
    clearOpenTimer();
    isHoveredRef.current = false;
    isFocusedRef.current = false;
    setIsOpen(false);
  }, [clearOpenTimer]);

  const scheduleOpen = useCallback(() => {
    clearOpenTimer();
    openTimerRef.current = window.setTimeout(() => {
      openTimerRef.current = null;
      const el = domRef.current;
      if (!el || !el.isConnected) {
        isHoveredRef.current = false;
        isFocusedRef.current = false;
        return;
      }
      // 二次校验浏览器真实 :hover / :focus-visible 命中态，杜绝快速掠过时的事件竞态残留
      const stillHovered = isHoveredRef.current && el.matches(':hover');
      const stillFocused = isFocusedRef.current && el.matches(':focus-visible');
      if (!stillHovered && !stillFocused) {
        isHoveredRef.current = false;
        isFocusedRef.current = false;
        return;
      }
      setIsOpen(true);
    }, delayMs);
  }, [clearOpenTimer, delayMs]);

  useEffect(() => {
    return () => {
      clearOpenTimer();
    };
  }, [clearOpenTimer]);

  // 打开期间挂载全局指针/滚动/失焦守卫：一旦光标已经不在宿主元素内，立即收回说明气泡
  useEffect(() => {
    if (!isOpen) return;

    const verifyStillActive = () => {
      const el = domRef.current;
      if (!el || !el.isConnected) {
        closeImmediately();
        return;
      }
      if (!el.matches(':hover') && !el.matches(':focus-visible')) {
        closeImmediately();
      }
    };

    const rafId = window.requestAnimationFrame(verifyStillActive);

    const handleGlobalPointerMove = (e: PointerEvent) => {
      const el = domRef.current;
      if (!el || !el.isConnected) {
        closeImmediately();
        return;
      }
      const target = e.target as Node | null;
      const inside = (target !== null && el.contains(target)) || el.matches(':hover');
      if (!inside && !el.matches(':focus-visible')) {
        closeImmediately();
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        closeImmediately();
      }
    };

    const docEl = document.documentElement;
    window.addEventListener('pointermove', handleGlobalPointerMove, { passive: true });
    window.addEventListener('pointerdown', closeImmediately, { capture: true, passive: true });
    window.addEventListener('scroll', closeImmediately, { capture: true, passive: true });
    window.addEventListener('blur', closeImmediately);
    window.addEventListener('keydown', handleKeyDown);
    docEl.addEventListener('mouseleave', closeImmediately);

    return () => {
      window.cancelAnimationFrame(rafId);
      window.removeEventListener('pointermove', handleGlobalPointerMove);
      window.removeEventListener('pointerdown', closeImmediately, { capture: true });
      window.removeEventListener('scroll', closeImmediately, { capture: true });
      window.removeEventListener('blur', closeImmediately);
      window.removeEventListener('keydown', handleKeyDown);
      docEl.removeEventListener('mouseleave', closeImmediately);
    };
  }, [isOpen, closeImmediately]);

  const { refs, floatingStyles, isPositioned } = useFloating({
    open: isOpen,
    onOpenChange: (next) => {
      if (!next) {
        closeImmediately();
      } else {
        setIsOpen(true);
      }
    },
    placement,
    whileElementsMounted: autoUpdate,
    middleware: [offset(8), flip({ padding: 10 }), shift({ padding: 10 })],
  });

  // React 19 下 forwardRef 子组件会将 ref 放入 children.props，需单独提取合并，避免覆盖 refs.setReference
  const rawChildProps = children.props as {
    ref?: React.Ref<HTMLElement>;
    onPointerEnter?: (e: React.PointerEvent<HTMLElement>) => void;
    onPointerLeave?: (e: React.PointerEvent<HTMLElement>) => void;
    onPointerCancel?: (e: React.PointerEvent<HTMLElement>) => void;
    onPointerDown?: (e: React.PointerEvent<HTMLElement>) => void;
    onMouseEnter?: (e: React.MouseEvent<HTMLElement>) => void;
    onMouseLeave?: (e: React.MouseEvent<HTMLElement>) => void;
    onFocus?: (e: React.FocusEvent<HTMLElement>) => void;
    onBlur?: (e: React.FocusEvent<HTMLElement>) => void;
    [key: string]: unknown;
  };

  const {
    ref: childRef,
    onPointerEnter: origPointerEnter,
    onPointerLeave: origPointerLeave,
    onPointerCancel: origPointerCancel,
    onPointerDown: origPointerDown,
    onMouseEnter: origMouseEnter,
    onMouseLeave: origMouseLeave,
    onFocus: origFocus,
    onBlur: origBlur,
    ...restChildProps
  } = rawChildProps;

  const setMergedReference = useCallback(
    (node: HTMLElement | null) => {
      domRef.current = node;
      refs.setReference(node);
      assignRef(childRef, node);
      if (node === null) {
        clearOpenTimer();
        isHoveredRef.current = false;
        isFocusedRef.current = false;
      }
    },
    [refs, childRef, clearOpenTimer]
  );

  const hasContent = Boolean(content);

  useEffect(() => {
    if (!hasContent && isOpen) {
      closeImmediately();
    }
  }, [hasContent, isOpen, closeImmediately]);

  return (
    <>
      {React.cloneElement(children, {
        ...restChildProps,
        ref: setMergedReference,
        'aria-describedby':
          hasContent && isOpen ? tooltipId : restChildProps['aria-describedby'],
        onPointerEnter: (e: React.PointerEvent<HTMLElement>) => {
          origPointerEnter?.(e);
          if (!hasContent || e.pointerType === 'touch') return;
          isHoveredRef.current = true;
          scheduleOpen();
        },
        onMouseEnter: (e: React.MouseEvent<HTMLElement>) => {
          origMouseEnter?.(e);
          if (!hasContent) return;
          if (!isHoveredRef.current) {
            isHoveredRef.current = true;
            scheduleOpen();
          }
        },
        onPointerLeave: (e: React.PointerEvent<HTMLElement>) => {
          origPointerLeave?.(e);
          isHoveredRef.current = false;
          clearOpenTimer();
          if (!isFocusedRef.current) {
            setIsOpen(false);
          }
        },
        onMouseLeave: (e: React.MouseEvent<HTMLElement>) => {
          origMouseLeave?.(e);
          isHoveredRef.current = false;
          clearOpenTimer();
          if (!isFocusedRef.current) {
            setIsOpen(false);
          }
        },
        onPointerCancel: (e: React.PointerEvent<HTMLElement>) => {
          origPointerCancel?.(e);
          closeImmediately();
        },
        onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
          origPointerDown?.(e);
          closeImmediately();
        },
        onFocus: (e: React.FocusEvent<HTMLElement>) => {
          origFocus?.(e);
          if (!hasContent) return;
          if (domRef.current?.matches(':focus-visible')) {
            isFocusedRef.current = true;
            setIsOpen(true);
          }
        },
        onBlur: (e: React.FocusEvent<HTMLElement>) => {
          origBlur?.(e);
          isFocusedRef.current = false;
          if (!isHoveredRef.current) {
            setIsOpen(false);
          }
        },
      } as React.Attributes)}
      {hasContent && isOpen && (
        <FloatingPortal>
          <div
            id={tooltipId}
            role="tooltip"
            ref={refs.setFloating}
            style={{
              ...floatingStyles,
              visibility: isPositioned ? 'visible' : 'hidden',
            }}
            className={`z-[80] ${maxWidthClass} rounded-lg border border-[#DEE0E3] bg-white px-3.5 py-2 text-[14px] leading-relaxed text-[#1F2329] shadow-[0_8px_24px_rgba(31,35,41,0.12)] pointer-events-none select-none transition-opacity duration-120 ${
              isPositioned ? 'opacity-100' : 'opacity-0'
            }`}
          >
            {content}
          </div>
        </FloatingPortal>
      )}
    </>
  );
};
