import React, { useEffect, useRef, useState } from 'react';
import { Copy, Minus, Square, X } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { getDesktopBridge, isAndroidPlatform, isMacPlatform } from '../../utils/desktopBridge';
import { Tooltip } from './Tooltip';

export const WindowControls: React.FC = React.memo(() => {
  const windowMaximized = useAppStore((s) => s.windowMaximized);
  const setWindowMaximized = useAppStore((s) => s.setWindowMaximized);
  const setWindowMotion = useAppStore((s) => s.setWindowMotion);
  const activeSession = useAppStore((s) => s.activeSession);
  const leaveClassroom = useAppStore((s) => s.leaveClassroom);
  const showNotice = useAppStore((s) => s.showNotice);

  const busyRef = useRef(false);
  const isMac = isMacPlatform();
  const isAndroid = isAndroidPlatform();
  const [windowFocused, setWindowFocused] = useState(
    typeof document === 'undefined' ? true : document.hasFocus()
  );
  const [groupHovered, setGroupHovered] = useState(false);

  useEffect(() => {
    const onFullscreenChange = () => {
      if (!getDesktopBridge()) {
        setWindowMaximized(Boolean(document.fullscreenElement));
      }
    };
    const onFocus = () => setWindowFocused(true);
    const onBlur = () => setWindowFocused(false);
    document.addEventListener('fullscreenchange', onFullscreenChange);
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    return () => {
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
    };
  }, [setWindowMaximized]);

  const handleMinimize = async () => {
    if (busyRef.current) return;
    const api = getDesktopBridge();
    if (api?.minimize_window) {
      busyRef.current = true;
      if (isMac) {
        // macOS 直接触发原生 Dock 神奇/缩放最小化动效，不做假 CSS 缩小遮挡
        void api.minimize_window().finally(() => {
          busyRef.current = false;
        });
        return;
      }
      // Windows 播放唯一一段 200ms GPU 缩小渐隐，完全透明后静默入任务栏（后端已抑制二次 DWM 跳变）
      setWindowMotion('minimizing');
      window.setTimeout(() => {
        setWindowMotion('minimized-hidden');
        void api.minimize_window?.().finally(() => {
          busyRef.current = false;
        });
      }, 205);
      return;
    }
    showNotice(
      'info',
      isMac ? '桌面端打包后点击将最小化至程序坞（Dock）' : '桌面端打包后点击将直接最小化至任务栏'
    );
  };

  const handleToggleMaximize = async () => {
    if (busyRef.current) return;
    const api = getDesktopBridge();
    if (api?.prepare_maximize_transition || api?.toggle_maximize_window) {
      window.dispatchEvent(
        new CustomEvent('zhiling:trigger-maximize', { detail: { mode: 'fullscreen' } })
      );
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
      if (isMac) {
        // macOS 走原生 WindowServer 窗口关闭渐隐动效
        void api.close_window();
        return;
      }
      setWindowMotion('closing');
      window.setTimeout(() => {
        void api.close_window?.();
      }, 185);
      return;
    }
    busyRef.current = false;
    window.close();
    showNotice('info', '已安全保存当前课堂状态，桌面端下将直接退出应用窗口');
  };

  if (isAndroid) {
    return null;
  }

  if (isMac) {
    const activeColors = windowFocused || groupHovered;
    return (
      <div
        className="flex items-center gap-2 pr-3 mr-1 border-r border-[#ECEEF2] app-no-drag shrink-0 select-none"
        onMouseEnter={() => setGroupHovered(true)}
        onMouseLeave={() => setGroupHovered(false)}
      >
        <Tooltip content="关闭窗口" placement="bottom">
          <button
            type="button"
            aria-label="关闭窗口"
            onClick={() => void handleClose()}
            className={`w-3.5 h-3.5 rounded-full flex items-center justify-center transition-all duration-150 cursor-pointer active:scale-90 border ${
              activeColors
                ? 'bg-[#FF5F57] border-[#E0443E] shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.08)]'
                : 'bg-[#D8D9DC] border-[#C9CBD0]'
            }`}
          >
            <svg
              viewBox="0 0 10 10"
              className={`w-2 h-2 transition-opacity duration-100 ${
                groupHovered ? 'opacity-100' : 'opacity-0'
              }`}
              aria-hidden="true"
            >
              <path
                d="M2.4 2.4L7.6 7.6M7.6 2.4L2.4 7.6"
                stroke="#4D0000"
                strokeWidth="1.45"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </Tooltip>

        <Tooltip content="最小化" placement="bottom">
          <button
            type="button"
            aria-label="最小化窗口"
            onClick={() => void handleMinimize()}
            className={`w-3.5 h-3.5 rounded-full flex items-center justify-center transition-all duration-150 cursor-pointer active:scale-90 border ${
              activeColors
                ? 'bg-[#FEBC2E] border-[#DEA123] shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.08)]'
                : 'bg-[#D8D9DC] border-[#C9CBD0]'
            }`}
          >
            <svg
              viewBox="0 0 10 10"
              className={`w-2 h-2 transition-opacity duration-100 ${
                groupHovered ? 'opacity-100' : 'opacity-0'
              }`}
              aria-hidden="true"
            >
              <path
                d="M2 5H8"
                stroke="#6E4400"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </Tooltip>

        <Tooltip content={windowMaximized ? '退出全屏' : '进入全屏'} placement="bottom">
          <button
            type="button"
            aria-label={windowMaximized ? '退出全屏' : '进入全屏'}
            onClick={() => void handleToggleMaximize()}
            className={`w-3.5 h-3.5 rounded-full flex items-center justify-center transition-all duration-150 cursor-pointer active:scale-90 border ${
              activeColors
                ? 'bg-[#28C840] border-[#1AAB29] shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.08)]'
                : 'bg-[#D8D9DC] border-[#C9CBD0]'
            }`}
          >
            <svg
              viewBox="0 0 10 10"
              className={`w-2 h-2 transition-opacity duration-100 ${
                groupHovered ? 'opacity-100' : 'opacity-0'
              }`}
              aria-hidden="true"
            >
              {windowMaximized ? (
                <path
                  d="M2.2 4.6H5.4V7.8M7.8 5.4H4.6V2.2"
                  stroke="#004D00"
                  strokeWidth="1.3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  fill="none"
                />
              ) : (
                <path
                  d="M2.3 5.5V2.3H5.5M7.7 4.5V7.7H4.5"
                  stroke="#004D00"
                  strokeWidth="1.3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  fill="none"
                />
              )}
            </svg>
          </button>
        </Tooltip>
      </div>
    );
  }

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
