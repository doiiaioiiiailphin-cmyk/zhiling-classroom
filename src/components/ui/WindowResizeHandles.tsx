import React from 'react';
import {
  getDesktopBridge,
  isDesktopShell,
  type DesktopWindowOpMode,
  type DesktopWindowTarget,
} from '../../utils/desktopBridge';

interface WindowResizeHandlesProps {
  target: DesktopWindowTarget;
  disabled?: boolean;
}

interface HandleSpec {
  mode: Exclude<DesktopWindowOpMode, 'move'>;
  className: string;
}

const HANDLES: HandleSpec[] = [
  { mode: 'n', className: 'top-0 left-3 right-3 h-[5px] cursor-ns-resize' },
  { mode: 's', className: 'bottom-0 left-3 right-3 h-[5px] cursor-ns-resize' },
  { mode: 'w', className: 'left-0 top-3 bottom-3 w-[5px] cursor-ew-resize' },
  { mode: 'e', className: 'right-0 top-3 bottom-3 w-[5px] cursor-ew-resize' },
  { mode: 'nw', className: 'top-0 left-0 w-3 h-3 cursor-nwse-resize' },
  { mode: 'ne', className: 'top-0 right-0 w-3 h-3 cursor-nesw-resize' },
  { mode: 'sw', className: 'bottom-0 left-0 w-3 h-3 cursor-nesw-resize' },
  { mode: 'se', className: 'bottom-0 right-0 w-3 h-3 cursor-nwse-resize' },
];

export const WindowResizeHandles: React.FC<WindowResizeHandlesProps> = React.memo(
  ({ target, disabled = false }) => {
    if (disabled || !isDesktopShell()) {
      return null;
    }

    const handleMouseDown = (
      mode: Exclude<DesktopWindowOpMode, 'move'>,
      e: React.MouseEvent<HTMLDivElement>
    ) => {
      if (e.button !== 0) return;
      const bridge = getDesktopBridge();
      if (!bridge?.start_native_resize) return;
      e.preventDefault();
      e.stopPropagation();
      void bridge.start_native_resize(target, mode);
    };

    return (
      <>
        {HANDLES.map((h) => (
          <div
            key={h.mode}
            onMouseDown={(e) => handleMouseDown(h.mode, e)}
            className={`fixed z-[95] app-no-drag select-none ${h.className}`}
          />
        ))}
      </>
    );
  }
);

WindowResizeHandles.displayName = 'WindowResizeHandles';
