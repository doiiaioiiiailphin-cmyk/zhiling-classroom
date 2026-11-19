import React from 'react';
import { Check } from 'lucide-react';
import { ProviderIcon } from '../icons/ProviderIcons';
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
  return (
    <Modal open={open} onClose={onClose} title={title} widthClass="max-w-2xl">
      <div className="p-6">
        <div className="grid grid-cols-3 sm:grid-cols-4 gap-3.5">
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
                className={`relative aspect-square rounded-xl border p-4 flex flex-col items-center justify-center gap-3 transition-all cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-[#1456F0]/30 ${
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
