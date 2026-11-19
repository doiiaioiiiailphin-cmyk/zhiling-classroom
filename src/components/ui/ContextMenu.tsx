import React, { useEffect, useState } from 'react';
import {
  useFloating,
  offset,
  flip,
  shift,
  FloatingPortal,
} from '@floating-ui/react';
import type { LucideIcon } from 'lucide-react';
import { ChevronRight } from 'lucide-react';

export interface ContextMenuItem {
  id: string;
  label: string;
  icon: LucideIcon;
  danger?: boolean;
  onClick?: () => void;
  children?: Array<{
    id: string;
    label: string;
    icon: LucideIcon;
    onClick: () => void;
  }>;
}

interface ContextMenuProps {
  position: { x: number; y: number } | null;
  items: ContextMenuItem[];
  onClose: () => void;
}

export const ContextMenu: React.FC<ContextMenuProps> = ({ position, items, onClose }) => {
  const [expandedSubId, setExpandedSubId] = useState<string | null>(null);

  const { refs, floatingStyles } = useFloating({
    open: Boolean(position),
    middleware: [offset(4), flip({ padding: 10 }), shift({ padding: 10 })],
  });

  useEffect(() => {
    setExpandedSubId(null);
    if (!position) return;
    refs.setPositionReference({
      getBoundingClientRect() {
        return {
          width: 0,
          height: 0,
          x: position.x,
          y: position.y,
          top: position.y,
          left: position.x,
          right: position.x,
          bottom: position.y,
        };
      },
    });
  }, [position, refs]);

  useEffect(() => {
    if (!position) return;
    const handlePointerDown = (e: MouseEvent) => {
      const floatingEl = refs.floating.current;
      if (floatingEl && !floatingEl.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleEscape);
    return () => {
      window.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleEscape);
    };
  }, [position, onClose, refs.floating]);

  if (!position || items.length === 0) return null;

  return (
    <FloatingPortal>
      <div
        ref={refs.setFloating}
        style={floatingStyles}
        onContextMenu={(e) => e.preventDefault()}
        className="z-[80] min-w-[200px] rounded-xl border border-[#DEE0E3] bg-white p-1.5 shadow-[0_12px_32px_rgba(31,35,41,0.16)] select-none"
      >
        {items.map((item) => {
          const Icon = item.icon;
          const hasChildren = Boolean(item.children && item.children.length > 0);
          const isExpanded = expandedSubId === item.id;

          return (
            <div key={item.id}>
              <button
                type="button"
                onClick={() => {
                  if (hasChildren) {
                    setExpandedSubId(isExpanded ? null : item.id);
                    return;
                  }
                  item.onClick?.();
                  onClose();
                }}
                className={`w-full flex items-center justify-between gap-3 rounded-lg px-3 py-2 text-[14px] transition-colors cursor-pointer ${
                  item.danger
                    ? 'text-[#D83931] hover:bg-[#FFECE8]'
                    : 'text-[#1F2329] hover:bg-[#F2F3F5]'
                }`}
              >
                <span className="flex items-center gap-2.5">
                  <Icon
                    className={`w-[17px] h-[17px] ${
                      item.danger ? 'text-[#D83931]' : 'text-[#4E5969]'
                    }`}
                    strokeWidth={1.8}
                  />
                  <span>{item.label}</span>
                </span>
                {hasChildren && (
                  <ChevronRight
                    className={`w-4 h-4 text-[#646A73] transition-transform ${
                      isExpanded ? 'rotate-90 text-[#1456F0]' : ''
                    }`}
                    strokeWidth={1.8}
                  />
                )}
              </button>

              {hasChildren && isExpanded && (
                <div className="mt-0.5 mb-1 ml-3 border-l-2 border-[#EBF2FF] pl-1.5 space-y-0.5">
                  {item.children!.map((sub) => {
                    const SubIcon = sub.icon;
                    return (
                      <button
                        key={sub.id}
                        type="button"
                        onClick={() => {
                          sub.onClick();
                          onClose();
                        }}
                        className="w-full flex items-center gap-2.5 rounded-lg px-3 py-1.5 text-[14px] text-[#1F2329] hover:bg-[#EBF2FF] hover:text-[#1456F0] transition-colors cursor-pointer"
                      >
                        <SubIcon className="w-4 h-4 text-[#1456F0]" strokeWidth={1.8} />
                        <span className="truncate">{sub.label}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </FloatingPortal>
  );
};
