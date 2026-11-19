import React, { useEffect, useRef } from 'react';
import { Copy, Minus, Square, X } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { getDesktopBridge } from '../../utils/desktopBridge';
import { Tooltip } from './Tooltip';

export const WindowControls: React.FC = React.memo(() => {
  const windowMaximized = useAppStore((s) => s.windowMaximized);
  const setWindowMaximized = useAppStore((s) => s.setWindowMaximized);
  const setWindowMotion = useAppStore((s) => s.setWindowMotion);
  const activeSession = useAppStore((s) => s.activeSession);
  const leaveClassroom = useAppStore((s) => s.leaveClassroom);
  const showNotice = useAppStore((s) => s.showNotice);

  const busyRef = useRef(false);

  useEffect(() => {
    const onFullscreenChange = () => {
      if (!getDesktopBridge()) {
        setWindowMaximized(Boolean(document.fullscreenElement));
      }
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, [setWindowMaximized]);

  const handleMinimize = async () => {
    if (busyRef.current) return;
    const api = getDesktopBridge();
    if (api?.minimize_window) {
      busyRef.current = true;
      setWindowMotion('minimizing');
      window.setTimeout(() => {
        // 先切换为无过渡隐藏态再执行原生最小化，杜绝窗口尚未隐藏完成时反向回弹造成的抽搐
        setWindowMotion('minimized-hidden');
        void api.minimize_window?.().finally(() => {
          busyRef.current = false;
        });
      }, 165);
      return;
    }
    showNotice('info', '桌面端打包后点击将直接最小化至任务栏');
  };

  const handleToggleMaximize = async () => {
    if (busyRef.current) return;
    const api = getDesktopBridge();
    if (api?.toggle_maximize_window) {
      busyRef.current = true;
      const optimisticNext = !windowMaximized;
      setWindowMaximized(optimisticNext);
      try {
        const nextMax = await api.toggle_maximize_window();
        setWindowMaximized(Boolean(nextMax));
      } finally {
        busyRef.current = false;
      }
      return;
    }
    setWindowMaximized(!windowMaximized);
  };

  const handleClose = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    if (activeSession?.status === 'recording') {
      await leaveClassroom();
    }
    const api = getDesktopBridge();
    if (api?.close_window) {
      setWindowMotion('closing');
      window.setTimeout(() => {
        void api.close_window?.();
      }, 150);
      return;
    }
    busyRef.current = false;
    window.close();
    showNotice('info', '已安全保存当前课堂状态，桌面端下将直接退出应用窗口');
  };

  return (
    <div className="flex items-center pl-2 ml-1 border-l border-[#ECEEF2] gap-1 app-no-drag shrink-0">
      <Tooltip content="最小化" placement="bottom">
        <button
          type="button"
          aria-label="最小化窗口"
          onClick={() => void handleMinimize()}
          className="w-9 h-9 rounded-lg text-[#4E5969] hover:text-[#1F2329] hover:bg-[#F2F3F5] active:bg-[#E5E6EB] active:scale-90 flex items-center justify-center transition-all duration-150 cursor-pointer"
        >
          <Minus className="w-4 h-4 transition-transform duration-150" strokeWidth={1.9} />
        </button>
      </Tooltip>

      <Tooltip content={windowMaximized ? '向下还原窗口圆角' : '最大化窗口'} placement="bottom">
        <button
          type="button"
          aria-label={windowMaximized ? '向下还原' : '最大化'}
          onClick={() => void handleToggleMaximize()}
          className="w-9 h-9 rounded-lg text-[#4E5969] hover:text-[#1F2329] hover:bg-[#F2F3F5] active:bg-[#E5E6EB] active:scale-90 flex items-center justify-center transition-all duration-150 cursor-pointer"
        >
          <span className="relative w-[15px] h-[15px] inline-flex items-center justify-center">
            <Square
              className={`absolute w-[15px] h-[15px] transition-all duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] ${
                windowMaximized ? 'opacity-0 scale-75 rotate-6' : 'opacity-100 scale-100 rotate-0'
              }`}
              strokeWidth={1.85}
            />
            <Copy
              className={`absolute w-[15px] h-[15px] transition-all duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] ${
                windowMaximized ? 'opacity-100 scale-100 rotate-0' : 'opacity-0 scale-75 -rotate-6'
              }`}
              strokeWidth={1.85}
            />
          </span>
        </button>
      </Tooltip>

      <Tooltip content="关闭窗口" placement="bottom">
        <button
          type="button"
          aria-label="关闭窗口"
          onClick={() => void handleClose()}
          className="w-9 h-9 rounded-lg text-[#4E5969] hover:bg-[#F53F3F] hover:text-white active:bg-[#D93025] active:scale-90 flex items-center justify-center transition-all duration-150 cursor-pointer group"
        >
          <X
            className="w-[17px] h-[17px] transition-transform duration-150 group-hover:scale-105"
            strokeWidth={1.95}
          />
        </button>
      </Tooltip>
    </div>
  );
});

WindowControls.displayName = 'WindowControls';
