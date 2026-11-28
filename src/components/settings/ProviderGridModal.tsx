import React from 'react';
import { Check, ChevronLeft } from 'lucide-react';
import { useOverscrollSpring } from '../../hooks/useOverscrollSpring';
import { isAndroidPlatform, useViewportLayout } from '../../utils/desktopBridge';
import { triggerHaptic } from '../../utils/springPhysics';
import { ProviderIcon } from '../icons/ProviderIcons';
import { MobileSpringPage } from '../ui/MobileSpringPage';
import { Modal } from '../ui/Modal';

export interface ProviderGridOption {
  id: string;
  name: string;
  configured?: boolean;
}

interface ProviderGridModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  selectedId: string;
  options: ProviderGridOption[];
  onSelect: (id: string) => void;
}

export const ProviderGridModal: React.FC<ProviderGridModalProps> = ({
  open,
  onClose,
  title,
  selectedId,
  options,
  onSelect,
}) => {
  const { isCompactPhoneLayout, isShortLandscape } = useViewportLayout();
  const isAndroid = isAndroidPlatform();
  const useMobilePage = isCompactPhoneLayout;
  const overscroll = useOverscrollSpring({ enabled: useMobilePage && open });

  if (useMobilePage) {
    return (
      <MobileSpringPage
        open={open}
        onClose={onClose}
        zIndexClassName="z-[60]"
        className="bg-[#F5F6F7]"
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label={title}
          style={
            isAndroid
              ? {
                  paddingTop: 'var(--android-safe-top, 0px)',
                  paddingBottom: 'var(--android-safe-bottom, 0px)',
                }
              : undefined
          }
          className="h-full w-full flex flex-col"
        >
          <header
            className={`${
              isShortLandscape ? 'h-12' : 'h-14'
            } px-3 bg-white border-b border-[#ECEEF2] flex items-center gap-1.5 shrink-0`}
          >
            <button
              type="button"
              onClick={onClose}
              aria-label="返回上一页"
              className="spring-press w-10 h-10 rounded-full flex items-center justify-center text-[#1F2329] active:bg-[#F2F3F5] transition-colors cursor-pointer shrink-0"
            >
              <ChevronLeft className="w-6 h-6" strokeWidth={2} />
            </button>
            <h2 className="text-[17px] font-semibold text-[#1F2329] truncate min-w-0">
              {title}
            </h2>
          </header>

          <div
            ref={overscroll.bindScrollRef}
            className="flex-1 overflow-y-auto overscroll-contain-y px-4 py-4"
          >
            <div ref={overscroll.contentRef} className="max-w-2xl mx-auto">
              <div className="rounded-2xl border border-[#EAEDF1] bg-white shadow-[0_1px_2px_rgba(31,35,41,0.03)] divide-y divide-[#F0F2F5] overflow-hidden">
                {options.map((item) => {
                  const isSelected = item.id === selectedId;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => {
                        triggerHaptic('selection');
                        onSelect(item.id);
                        onClose();
                      }}
                      className={`spring-press w-full min-h-[60px] px-4 py-3 flex items-center justify-between gap-3 text-left transition-colors cursor-pointer ${
                        isSelected
                          ? 'bg-[#F0F5FF]/70 active:bg-[#EBF2FF]'
                          : 'bg-white active:bg-[#F5F6F7]'
                      }`}
                    >
                      <div className="flex items-center gap-3.5 min-w-0">
                        <div
                          className={`w-10 h-10 rounded-xl border flex items-center justify-center shrink-0 ${
                            isSelected
                              ? 'bg-white border-[#BEDAFF]'
                              : 'bg-[#F7F8FA] border-[#ECEEF2]'
                          }`}
                        >
                          <ProviderIcon providerId={item.id} className="w-6 h-6" />
                        </div>
                        <div className="min-w-0 flex items-center gap-2 flex-wrap">
                          <span
                            className={`text-[15px] font-medium truncate ${
                              isSelected ? 'text-[#1456F0]' : 'text-[#1F2329]'
                            }`}
                          >
                            {item.name}
                          </span>
                          {item.configured && (
                            <span className="px-2 py-0.5 rounded-md bg-[#EBF2FF] text-[#1456F0] text-[14px] font-medium shrink-0">
                              已配置
                            </span>
                          )}
                        </div>
                      </div>

                      {isSelected && (
                        <Check
                          className="w-5 h-5 text-[#1456F0] shrink-0"
                          strokeWidth={2.25}
                        />
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </MobileSpringPage>
    );
  }

  return (
    <Modal open={open} onClose={onClose} title={title} widthClass="max-w-2xl">
      <div className="p-4 sm:p-6">
        <div className="grid grid-cols-3 sm:grid-cols-4 gap-2.5 sm:gap-3.5">
          {options.map((item) => {
            const isSelected = item.id === selectedId;

            return (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  onSelect(item.id);
                  onClose();
                }}
                className={`relative aspect-square rounded-xl border p-2.5 sm:p-4 flex flex-col items-center justify-center gap-2 sm:gap-3 transition-all cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-[#1456F0]/30 ${
                  isSelected
                    ? 'border-[#1456F0] bg-[#EBF2FF]/75 text-[#1456F0] shadow-[0_4px_14px_rgba(20,86,240,0.12)]'
                    : 'border-[#DEE0E3] bg-white text-[#1F2329] hover:border-[#3370FF] hover:bg-[#F5F8FF]'
                }`}
              >
                {item.configured && (
                  <span
                    className={`absolute top-2.5 right-2.5 w-5 h-5 rounded-full flex items-center justify-center ${
                      isSelected
                        ? 'bg-[#1456F0] text-white'
                        : 'bg-[#EBF2FF] text-[#1456F0]'
                    }`}
                  >
                    <Check className="w-3.5 h-3.5" strokeWidth={2.4} />
                  </span>
                )}

                <ProviderIcon providerId={item.id} className="w-8 h-8" />

                <span className="text-[14px] font-medium text-center leading-tight">
                  {item.name}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </Modal>
  );
};
