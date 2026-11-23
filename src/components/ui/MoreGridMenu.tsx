import React, { useState } from 'react';
import {
  useFloating,
  autoUpdate,
  offset,
  flip,
  shift,
  useClick,
  useDismiss,
  useRole,
  useInteractions,
  FloatingPortal,
} from '@floating-ui/react';
import { MoreHorizontal, type LucideIcon } from 'lucide-react';
import { useAnimatedPresence } from '../../hooks/useAnimatedPresence';
import { Tooltip } from './Tooltip';

export interface GridMenuItem {
  id: string;
  label: string;
  icon: LucideIcon;
  badge?: string | number;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}

interface MoreGridMenuProps {
  items: GridMenuItem[];
  tooltip?: string;
  title?: string;
}

export const MoreGridMenu: React.FC<MoreGridMenuProps> = ({
  items,
  tooltip = '更多课堂工具与设置',
  title = '功能导航',
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const { shouldRender, isVisible } = useAnimatedPresence(isOpen, 150);

  const { refs, floatingStyles, context, isPositioned } = useFloating({
    open: isOpen,
    onOpenChange: setIsOpen,
    placement: 'bottom-end',
    whileElementsMounted: autoUpdate,
    middleware: [offset(10), flip({ padding: 12 }), shift({ padding: 12 })],
  });

  const click = useClick(context);
  const dismiss = useDismiss(context, { outsidePress: true, escapeKey: true });
  const role = useRole(context, { role: 'menu' });

  const { getReferenceProps, getFloatingProps } = useInteractions([
    click,
    dismiss,
    role,
  ]);

  const triggerButton = (
    <button
      ref={refs.setReference}
      type="button"
      aria-label={tooltip}
      {...getReferenceProps()}
      className={`w-10 h-10 rounded-lg border inline-flex items-center justify-center shrink-0 transition-all duration-150 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-[#1456F0]/25 app-no-drag ${
        isOpen
          ? 'border-[#3370FF] bg-[#EBF2FF] text-[#1456F0] shadow-xs'
          : 'border-[#DEE0E3] bg-white text-[#1F2329] hover:border-[#3370FF] hover:text-[#1456F0] hover:bg-[#F0F4FF]/50'
      }`}
    >
      <MoreHorizontal className="w-5 h-5" strokeWidth={1.9} />
    </button>
  );

  return (
    <>
      <Tooltip content={isOpen ? null : tooltip} placement="bottom">
        {triggerButton}
      </Tooltip>

      {shouldRender && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            style={{
              ...floatingStyles,
              visibility: isPositioned ? 'visible' : 'hidden',
            }}
            {...getFloatingProps()}
            className="z-[70] focus:outline-none app-no-drag"
          >
            <div
              className={`w-[min(356px,calc(100vw-24px))] max-h-[calc(100vh-72px)] overflow-y-auto origin-top-right rounded-2xl border border-[#DEE0E3] bg-white/98 backdrop-blur-md p-3.5 shadow-[0_18px_44px_rgba(31,35,41,0.16)] transition-all duration-180 ease-[cubic-bezier(0.16,1,0.3,1)] ${
                isVisible && isPositioned
                  ? 'opacity-100 scale-100 translate-y-0'
                  : 'opacity-0 scale-[0.93] -translate-y-1.5 pointer-events-none'
              }`}
            >
              <div className="px-1.5 pb-2.5 flex items-center justify-between">
                <span className="text-[14px] font-semibold text-[#646A73]">
                  {title}
                </span>
              </div>

              <div className="grid grid-cols-3 gap-2">
                {items.map((item) => {
                  const Icon = item.icon;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      disabled={item.disabled}
                      onClick={() => {
                        setIsOpen(false);
                        item.onClick();
                      }}
                      className={`group relative rounded-xl border p-2.5 flex flex-col items-center justify-center gap-2 text-center transition-all duration-150 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed active:scale-[0.96] ${
                        item.active
                          ? 'border-[#BEDAFF] bg-[#EBF2FF] text-[#1456F0]'
                          : 'border-transparent bg-[#F8F9FA] text-[#1F2329] hover:-translate-y-0.5 hover:border-[#D6E4FF] hover:bg-[#F0F4FF] hover:shadow-[0_6px_16px_rgba(20,86,240,0.08)]'
                      }`}
                    >
                      {item.badge !== undefined && (
                        <span
                          className={`absolute top-1.5 right-1.5 min-w-5 h-5 px-1.5 rounded-full text-[14px] leading-none font-semibold inline-flex items-center justify-center tabular-nums ${
                            item.active
                              ? 'bg-[#1456F0] text-white'
                              : 'bg-[#EBF2FF] text-[#1456F0]'
                          }`}
                        >
                          {item.badge}
                        </span>
                      )}

                      <div
                        className={`w-10 h-10 rounded-xl flex items-center justify-center transition-colors ${
                          item.active
                            ? 'bg-[#1456F0] text-white shadow-xs'
                            : 'bg-white text-[#1456F0] border border-[#ECEEF2] group-hover:bg-[#1456F0] group-hover:text-white group-hover:border-[#1456F0]'
                        }`}
                      >
                        <Icon className="w-5 h-5 shrink-0" strokeWidth={1.85} />
                      </div>

                      <span className="text-[14px] font-medium leading-tight whitespace-nowrap">
                        {item.label}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </FloatingPortal>
      )}
    </>
  );
};
