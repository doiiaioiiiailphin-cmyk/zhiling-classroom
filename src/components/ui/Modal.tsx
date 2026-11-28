import React, { useEffect, useId } from 'react';
import { X } from 'lucide-react';
import { useAnimatedPresence } from '../../hooks/useAnimatedPresence';
import { useViewportLayout } from '../../utils/desktopBridge';
import { IconButton } from './IconButton';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  widthClass?: string;
  layerClass?: string;
  closable?: boolean;
  children: React.ReactNode;
}

// 维护打开的弹窗栈，确保多层弹窗（如设置内弹出方格选择菜单）按 Esc 时仅关闭最顶层弹窗
const activeModalStack: string[] = [];

export const Modal: React.FC<ModalProps> = ({
  open,
  onClose,
  title,
  widthClass = 'max-w-3xl',
  layerClass = 'z-50',
  closable = true,
  children,
}) => {
  const modalId = useId();
  const { isCompactPhoneLayout } = useViewportLayout();
  const { shouldRender, isVisible } = useAnimatedPresence(open, 170);

  useEffect(() => {
    if (!open) return;
    activeModalStack.push(modalId);

    const handleKeyDown = (e: KeyboardEvent) => {
      const topModalId = activeModalStack[activeModalStack.length - 1];
      if (e.key === 'Escape' && topModalId === modalId) {
        e.stopPropagation();
        if (closable) onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      const idx = activeModalStack.lastIndexOf(modalId);
      if (idx !== -1) activeModalStack.splice(idx, 1);
    };
  }, [open, onClose, modalId, closable]);

  if (!shouldRender) return null;

  return (
    <div
      style={{
        paddingTop: 'calc(12px + var(--android-safe-top, 0px))',
        paddingBottom: 'calc(12px + var(--android-safe-bottom, 0px))',
      }}
      className={`fixed inset-0 ${layerClass} flex items-center justify-center px-3 sm:px-4 transition-opacity duration-200 ${
        isCompactPhoneLayout ? 'bg-[#1F2329]/38' : 'bg-[#1F2329]/35 backdrop-blur-[1.5px]'
      } ${isVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && closable) onClose();
      }}
    >
      <div
        style={{
          transitionTimingFunction: isVisible
            ? 'var(--spring-expressive, cubic-bezier(0.22, 1, 0.36, 1))'
            : 'cubic-bezier(0.32, 0.72, 0, 1)',
        }}
        className={`w-full ${widthClass} rounded-2xl border border-[#DEE0E3] bg-white shadow-[0_20px_48px_rgba(31,35,41,0.18)] overflow-hidden flex flex-col max-h-full transition-[transform,opacity] ${
          isVisible
            ? 'duration-[300ms] opacity-100 scale-100 translate-y-0'
            : 'duration-[170ms] opacity-0 scale-[0.94] translate-y-3'
        }`}
      >
        <div className="flex items-center justify-between gap-3 border-b border-[#ECEEF2] px-4 sm:px-6 py-3.5 sm:py-4 shrink-0">
          <h2 className="text-[16px] sm:text-[17px] font-semibold text-[#1F2329] truncate min-w-0">
            {title}
          </h2>
          <IconButton
            icon={X}
            tooltip={closable ? '关闭' : undefined}
            disabled={!closable}
            onClick={onClose}
          />
        </div>
        <div className="flex-1 overflow-y-auto overscroll-contain-y">{children}</div>
      </div>
    </div>
  );
};
