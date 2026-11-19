import React from 'react';
import type { LucideIcon } from 'lucide-react';
import { Tooltip } from './Tooltip';
import type { Placement } from '@floating-ui/react';

export type IconButtonVariant = 'ghost' | 'outline' | 'primary' | 'active' | 'danger';
export type IconButtonSize = 'md' | 'lg';

interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  icon: LucideIcon;
  tooltip?: string;
  tooltipPlacement?: Placement;
  variant?: IconButtonVariant;
  size?: IconButtonSize;
  spinning?: boolean;
}

const VARIANT_STYLES: Record<IconButtonVariant, string> = {
  ghost:
    'text-[#4E5969] hover:text-[#1F2329] hover:bg-[#F2F3F5] active:bg-[#E5E6EB] border border-transparent',
  outline:
    'text-[#1F2329] bg-white border border-[#DEE0E3] hover:border-[#3370FF] hover:text-[#1456F0] hover:bg-[#F0F4FF]/50',
  primary:
    'text-white bg-[#1456F0] hover:bg-[#3370FF] active:bg-[#0E42C2] border border-transparent shadow-xs',
  active:
    'text-[#1456F0] bg-[#EBF2FF] hover:bg-[#DCE8FF] border border-[#BEDAFF]',
  danger:
    'text-[#D83931] bg-[#FFECE8] hover:bg-[#FFD8D2] border border-[#FFBCB3]',
};

const SIZE_STYLES: Record<IconButtonSize, string> = {
  md: 'w-9 h-9 rounded-lg',
  lg: 'w-10 h-10 rounded-lg',
};

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  (
    {
      icon: Icon,
      tooltip,
      tooltipPlacement = 'bottom',
      variant = 'ghost',
      size = 'md',
      spinning = false,
      className = '',
      disabled,
      ...rest
    },
    ref
  ) => {
    const buttonNode = (
      <button
        ref={ref}
        type="button"
        aria-label={tooltip || rest['aria-label']}
        disabled={disabled}
        className={`inline-flex items-center justify-center shrink-0 transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-[#1456F0]/25 disabled:opacity-45 disabled:cursor-not-allowed ${SIZE_STYLES[size]} ${VARIANT_STYLES[variant]} ${className}`}
        {...rest}
      >
        <Icon
          className={`${size === 'lg' ? 'w-5 h-5' : 'w-[19px] h-[19px]'} ${
            spinning ? 'animate-spin' : ''
          }`}
          strokeWidth={1.8}
        />
      </button>
    );

    if (!tooltip) {
      return buttonNode;
    }

    return (
      <Tooltip content={disabled ? null : tooltip} placement={tooltipPlacement}>
        {buttonNode}
      </Tooltip>
    );
  }
);

IconButton.displayName = 'IconButton';
