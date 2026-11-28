import React from 'react';
import { triggerHaptic } from '../../utils/springPhysics';

interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  ariaLabel?: string;
}

export const Switch: React.FC<SwitchProps> = ({
  checked,
  onChange,
  disabled = false,
  ariaLabel,
}) => {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => {
        triggerHaptic('selection');
        onChange(!checked);
      }}
      className={`group relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#1456F0]/30 active:scale-[0.94] disabled:opacity-45 disabled:cursor-not-allowed ${
        checked ? 'bg-[#1456F0]' : 'bg-[#C9CDD4] hover:bg-[#AEB4BE]'
      }`}
      style={{
        transitionTimingFunction: 'var(--spring-snappy, cubic-bezier(0.22, 1, 0.36, 1))',
      }}
    >
      <span
        className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow-xs transition-transform duration-300 group-active:scale-x-110 ${
          checked ? 'translate-x-5' : 'translate-x-0'
        }`}
        style={{
          transitionTimingFunction: 'var(--spring-snappy, cubic-bezier(0.22, 1, 0.36, 1))',
        }}
      />
    </button>
  );
};
