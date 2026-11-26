import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, CheckCircle2, X } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { IconButton } from './IconButton';

export const NoticeToast: React.FC = () => {
  const { notice, clearNotice } = useAppStore();

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => {
      clearNotice();
    }, 5000);
    return () => window.clearTimeout(timer);
  }, [notice, clearNotice]);

  if (!notice) return null;

  const isError = notice.kind === 'error';

  const toastNode = (
    <div
      style={{ top: 'calc(16px + var(--android-safe-top, 0px))' }}
      className="fixed left-1/2 -translate-x-1/2 z-[90] max-w-lg w-[calc(100vw-2rem)] pointer-events-auto"
    >
      <div
        role="status"
        className={`flex items-center justify-between gap-3 rounded-xl border px-4 py-3 shadow-[0_12px_32px_rgba(31,35,41,0.14)] bg-white ${
          isError ? 'border-[#FFBCB3]' : 'border-[#BEDAFF]'
        }`}
      >
        <div className="flex items-center gap-2.5 min-w-0">
          {isError ? (
            <AlertCircle className="w-5 h-5 text-[#D83931] shrink-0" strokeWidth={1.9} />
          ) : (
            <CheckCircle2 className="w-5 h-5 text-[#1456F0] shrink-0" strokeWidth={1.9} />
          )}
          <span className="text-[14px] text-[#1F2329] leading-snug break-words">
            {notice.message}
          </span>
        </div>

        <IconButton icon={X} tooltip="关闭提示" onClick={clearNotice} />
      </div>
    </div>
  );

  if (typeof document !== 'undefined') {
    return createPortal(toastNode, document.body);
  }
  return toastNode;
};
