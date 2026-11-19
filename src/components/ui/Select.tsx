import React, { useMemo, useState } from 'react';
import {
  useFloating,
  autoUpdate,
  offset,
  flip,
  size,
  useClick,
  useDismiss,
  useInteractions,
  FloatingPortal,
} from '@floating-ui/react';
import { Check, ChevronDown, Search } from 'lucide-react';

export interface SelectOption {
  value: string;
  label: string;
  group?: string;
  icon?: React.ReactNode;
}

interface SelectProps {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}

const OPTION_ROW_HEIGHT = 38;
const VIRTUAL_THRESHOLD = 40;

export const Select: React.FC<SelectProps> = ({
  value,
  options,
  onChange,
  placeholder = '请选择',
  disabled = false,
  className = '',
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [scrollTop, setScrollTop] = useState(0);

  const { refs, floatingStyles, context } = useFloating({
    open: isOpen,
    onOpenChange: (open) => {
      if (disabled) return;
      setIsOpen(open);
      setScrollTop(0);
      if (!open) setQuery('');
    },
    whileElementsMounted: autoUpdate,
    middleware: [
      offset(6),
      flip({ padding: 12 }),
      size({
        apply({ rects, elements }) {
          Object.assign(elements.floating.style, {
            minWidth: `${Math.max(rects.reference.width, 220)}px`,
          });
        },
        padding: 12,
      }),
    ],
  });

  const click = useClick(context);
  const dismiss = useDismiss(context);
  const { getReferenceProps, getFloatingProps } = useInteractions([click, dismiss]);

  const selectedOption = useMemo(
    () => options.find((opt) => opt.value === value),
    [options, value]
  );

  const filteredOptions = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return options;
    return options.filter(
      (opt) =>
        opt.label.toLowerCase().includes(trimmed) ||
        opt.value.toLowerCase().includes(trimmed) ||
        (opt.group && opt.group.toLowerCase().includes(trimmed))
    );
  }, [options, query]);

  const showSearch = options.length > 6;
  const useVirtual = filteredOptions.length > VIRTUAL_THRESHOLD;

  const { visibleOptions, topPad, bottomPad } = useMemo(() => {
    if (!useVirtual) {
      return { visibleOptions: filteredOptions, topPad: 0, bottomPad: 0 };
    }
    const startIdx = Math.max(0, Math.floor(scrollTop / OPTION_ROW_HEIGHT) - 6);
    const endIdx = Math.min(
      filteredOptions.length - 1,
      Math.ceil((scrollTop + 260) / OPTION_ROW_HEIGHT) + 6
    );
    return {
      visibleOptions: filteredOptions.slice(startIdx, endIdx + 1),
      topPad: startIdx * OPTION_ROW_HEIGHT,
      bottomPad: Math.max(0, (filteredOptions.length - 1 - endIdx) * OPTION_ROW_HEIGHT),
    };
  }, [filteredOptions, scrollTop, useVirtual]);

  return (
    <>
      <button
        ref={refs.setReference}
        type="button"
        disabled={disabled}
        {...getReferenceProps()}
        className={`h-10 w-full rounded-lg border bg-white px-3.5 text-left text-[15px] transition-colors flex items-center justify-between gap-2 cursor-pointer focus:outline-none ${
          isOpen
            ? 'border-[#1456F0] ring-2 ring-[#1456F0]/15'
            : 'border-[#DEE0E3] hover:border-[#BBBFC4]'
        } disabled:bg-[#F5F6F7] disabled:text-[#8F959E] disabled:cursor-not-allowed ${className}`}
      >
        <span className="flex items-center gap-2.5 truncate">
          {selectedOption?.icon && <span className="shrink-0">{selectedOption.icon}</span>}
          <span
            className={`truncate ${
              selectedOption ? 'text-[#1F2329]' : 'text-[#646A73]'
            }`}
          >
            {selectedOption ? selectedOption.label : placeholder}
          </span>
        </span>
        <ChevronDown
          className={`w-4 h-4 shrink-0 text-[#646A73] transition-transform ${
            isOpen ? 'rotate-180 text-[#1456F0]' : ''
          }`}
          strokeWidth={1.9}
        />
      </button>

      {isOpen && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            style={floatingStyles}
            {...getFloatingProps()}
            className="z-[70] rounded-xl border border-[#DEE0E3] bg-white p-1.5 shadow-[0_12px_32px_rgba(31,35,41,0.14)] focus:outline-none"
          >
            {showSearch && (
              <div className="mb-1.5 flex items-center gap-2 rounded-lg border border-[#ECEEF2] bg-[#F5F6F7] px-3 h-9">
                <Search className="w-4 h-4 text-[#646A73] shrink-0" strokeWidth={1.8} />
                <input
                  type="text"
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setScrollTop(0);
                  }}
                  placeholder="筛选模型或选项..."
                  autoFocus
                  className="w-full bg-transparent text-[14px] text-[#1F2329] placeholder-[#646A73] focus:outline-none"
                />
              </div>
            )}

            <div
              onScroll={(e) => {
                if (useVirtual) {
                  setScrollTop(e.currentTarget.scrollTop);
                }
              }}
              className="max-h-64 overflow-y-auto"
            >
              {filteredOptions.length === 0 ? (
                <div className="px-3 py-3 text-[14px] text-[#646A73] text-center">
                  暂无匹配选项
                </div>
              ) : (
                <div
                  style={
                    useVirtual
                      ? { paddingTop: `${topPad}px`, paddingBottom: `${bottomPad}px` }
                      : undefined
                  }
                  className={useVirtual ? '' : 'space-y-0.5'}
                >
                  {visibleOptions.map((opt) => {
                    const active = opt.value === value;
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        style={useVirtual ? { height: `${OPTION_ROW_HEIGHT}px` } : undefined}
                        onClick={() => {
                          onChange(opt.value);
                          setIsOpen(false);
                          setQuery('');
                        }}
                        className={`w-full flex items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-[14px] transition-colors cursor-pointer ${
                          active
                            ? 'bg-[#EBF2FF] text-[#1456F0] font-medium'
                            : 'text-[#1F2329] hover:bg-[#F2F3F5]'
                        }`}
                      >
                        <span className="flex items-center gap-2.5 truncate">
                          {opt.icon && <span className="shrink-0">{opt.icon}</span>}
                          <span className="truncate">{opt.label}</span>
                        </span>
                        {active && (
                          <Check
                            className="w-4 h-4 text-[#1456F0] shrink-0"
                            strokeWidth={2.1}
                          />
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </FloatingPortal>
      )}
    </>
  );
};
