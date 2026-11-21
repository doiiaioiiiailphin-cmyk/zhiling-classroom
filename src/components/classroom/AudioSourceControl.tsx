import React, { useEffect, useState } from 'react';
import {
  useFloating,
  autoUpdate,
  offset,
  flip,
  shift,
  useDismiss,
  useInteractions,
  FloatingPortal,
} from '@floating-ui/react';
import {
  AudioWaveform,
  Check,
  ChevronDown,
  Mic,
  MicOff,
  MonitorUp,
  RefreshCw,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { useAnimatedPresence } from '../../hooks/useAnimatedPresence';
import { useAudioDevices } from '../../hooks/useAudioDevices';
import { classroomSocket } from '../../services/classroomSocket';
import type { AudioRuntimeTelemetry } from '../../services/classroomAudio';
import { useAppStore } from '../../store/useAppStore';
import { Switch } from '../ui/Switch';
import { Tooltip } from '../ui/Tooltip';

type OpenMenu = 'mic' | 'system' | null;

/**
 * 扬声器 + 双讲回声消除（AEC3）一体化融合图标：
 * 左侧保持与 Volume2 完全一致的扬声器锥体，右侧将普通弧形发散声波替换为洁净垂直声波纹。
 */
const SpeakerAecIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    className={className}
  >
    <path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z" />
    <path d="M15 9.5v5" />
    <path d="M18.5 6.5v11" />
    <path d="M22 10v4" />
  </svg>
);

const MiniLevelBars: React.FC<{ percent: number }> = ({ percent }) => {
  const clamped = Math.min(100, Math.max(0, percent));
  const bar1 = Math.max(14, Math.round(clamped * 0.65));
  const bar2 = Math.max(14, Math.round(clamped));
  const bar3 = Math.max(14, Math.round(clamped * 0.8));
  const active = clamped >= 6;
  return (
    <span className="inline-flex items-end gap-[2px] h-4 w-3 shrink-0" aria-hidden="true">
      <span
        className={`w-[3px] rounded-full transition-[height,background-color] duration-75 ${
          active ? 'bg-[#1456F0]' : 'bg-[#C9CDD4]'
        }`}
        style={{ height: `${bar1}%` }}
      />
      <span
        className={`w-[3px] rounded-full transition-[height,background-color] duration-75 ${
          active ? 'bg-[#1456F0]' : 'bg-[#C9CDD4]'
        }`}
        style={{ height: `${bar2}%` }}
      />
      <span
        className={`w-[3px] rounded-full transition-[height,background-color] duration-75 ${
          active ? 'bg-[#3370FF]' : 'bg-[#C9CDD4]'
        }`}
        style={{ height: `${bar3}%` }}
      />
    </span>
  );
};

export const AudioSourceControl: React.FC = React.memo(() => {
  const settings = useAppStore((s) => s.settings);
  const isRecording = useAppStore((s) => s.activeSession?.status === 'recording');
  const aec3Installed = useAppStore((s) => Boolean(s.aec3Addon?.installed));
  const setMicChannel = useAppStore((s) => s.setMicChannel);
  const setSystemChannel = useAppStore((s) => s.setSystemChannel);
  const requestToggleWebrtcAec3 = useAppStore((s) => s.requestToggleWebrtcAec3);

  const [openMenu, setOpenMenu] = useState<OpenMenu>(null);
  const micOpen = openMenu === 'mic';
  const sysOpen = openMenu === 'system';
  const micPresence = useAnimatedPresence(micOpen, 140);
  const sysPresence = useAnimatedPresence(sysOpen, 140);

  const [telemetry, setTelemetry] = useState<AudioRuntimeTelemetry>(() =>
    classroomSocket.getTelemetry()
  );

  // 使用 FloatingPortal 彻底跳出 macOS 顶栏 backdrop-blur-md 与主容器 overflow-hidden 堆叠上下文
  const micFloating = useFloating({
    open: micOpen,
    onOpenChange: (next) => {
      if (!next && openMenu === 'mic') setOpenMenu(null);
    },
    placement: 'bottom-end',
    whileElementsMounted: autoUpdate,
    middleware: [offset(8), flip({ padding: 12 }), shift({ padding: 12 })],
  });
  const micDismiss = useDismiss(micFloating.context, { outsidePress: true, escapeKey: true });
  const micInteractions = useInteractions([micDismiss]);

  const sysFloating = useFloating({
    open: sysOpen,
    onOpenChange: (next) => {
      if (!next && openMenu === 'system') setOpenMenu(null);
    },
    placement: 'bottom-end',
    whileElementsMounted: autoUpdate,
    middleware: [offset(8), flip({ padding: 12 }), shift({ padding: 12 })],
  });
  const sysDismiss = useDismiss(sysFloating.context, { outsidePress: true, escapeKey: true });
  const sysInteractions = useInteractions([sysDismiss]);

  const { micOptions, systemOptions, isRefreshing, refreshDevices } = useAudioDevices(
    Boolean(openMenu) || isRecording
  );

  useEffect(() => {
    return classroomSocket.subscribeTelemetry(setTelemetry);
  }, []);

  // Refresh device labels shortly after recording starts (once browser unlocks mic labels)
  useEffect(() => {
    if (!isRecording) return;
    const timer = window.setTimeout(() => {
      void refreshDevices();
    }, 600);
    return () => window.clearTimeout(timer);
  }, [isRecording, refreshDevices]);

  if (!settings) return null;

  const { micEnabled, systemAudioEnabled, audioDeviceId, systemAudioDeviceId, enableWebrtcAec3 } =
    settings;

  const micMeterPercent = Math.round(Math.min(100, Math.max(0, telemetry.micLevel * 100)));
  const sysMeterPercent = Math.round(Math.min(100, Math.max(0, telemetry.sysLevel * 100)));
  const aec3DualActive = Boolean(
    micEnabled && systemAudioEnabled && enableWebrtcAec3 && aec3Installed
  );

  return (
    <div className="relative flex items-center gap-2 app-no-drag">
      {/* ==================== 1. 麦克风源控制（图标直点禁用/启用 + 下拉选源） ==================== */}
      <div
        ref={micFloating.refs.setReference}
        className={`h-10 rounded-lg border flex items-center overflow-hidden transition-colors ${
          micEnabled
            ? 'border-[#DEE0E3] bg-white text-[#1F2329]'
            : 'border-[#F54A45]/35 bg-[#FFF2F1] text-[#D83931]'
        }`}
      >
        <Tooltip content={micEnabled ? '点击禁用麦克风' : '点击启用麦克风'}>
          <button
            type="button"
            aria-label={micEnabled ? '禁用麦克风' : '启用麦克风'}
            onClick={() => void setMicChannel({ enabled: !micEnabled })}
            className="h-full px-2.5 flex items-center gap-1.5 hover:bg-[#F2F3F5]/80 transition-colors cursor-pointer"
          >
            {micEnabled ? (
              <Mic className="w-[18px] h-[18px] text-[#1456F0]" />
            ) : (
              <MicOff className="w-[18px] h-[18px] text-[#D83931]" />
            )}
            {isRecording && micEnabled && <MiniLevelBars percent={micMeterPercent} />}
          </button>
        </Tooltip>

        <span className="w-px h-5 bg-[#ECEEF2]" />

        <Tooltip content={micOpen ? null : '选择麦克风音频源'}>
          <button
            type="button"
            aria-label="选择麦克风音频源"
            aria-expanded={micOpen}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              const next = openMenu === 'mic' ? null : 'mic';
              setOpenMenu(next);
              if (next) void refreshDevices();
            }}
            className={`h-full px-1.5 flex items-center justify-center hover:bg-[#F2F3F5] transition-colors cursor-pointer ${
              micOpen ? 'bg-[#EBF2FF] text-[#1456F0]' : 'text-[#646A73]'
            }`}
          >
            <ChevronDown
              className={`w-4 h-4 transition-transform duration-150 ${micOpen ? 'rotate-180' : ''}`}
            />
          </button>
        </Tooltip>
      </div>

      {/* ==================== 2. 系统内录源控制（图标直点禁用/启用 + 下拉选源与 AEC3） ==================== */}
      <div
        ref={sysFloating.refs.setReference}
        className={`h-10 rounded-lg border flex items-center overflow-hidden transition-colors ${
          systemAudioEnabled
            ? 'border-[#DEE0E3] bg-white text-[#1F2329]'
            : 'border-[#F54A45]/35 bg-[#FFF2F1] text-[#D83931]'
        }`}
      >
        <Tooltip
          content={
            !systemAudioEnabled
              ? '点击启用系统内录'
              : aec3DualActive
                ? '系统内录已开启（双讲回声消除已融入开启），点击禁用'
                : '点击禁用系统内录'
          }
        >
          <button
            type="button"
            aria-label={systemAudioEnabled ? '禁用系统内录' : '启用系统内录'}
            onClick={() => void setSystemChannel({ enabled: !systemAudioEnabled })}
            className="h-full px-2.5 flex items-center gap-1.5 hover:bg-[#F2F3F5]/80 transition-colors cursor-pointer"
          >
            {!systemAudioEnabled ? (
              <VolumeX className="w-[18px] h-[18px] text-[#D83931]" />
            ) : aec3DualActive ? (
              <SpeakerAecIcon className="w-[18px] h-[18px] text-[#1456F0]" />
            ) : (
              <Volume2 className="w-[18px] h-[18px] text-[#1456F0]" />
            )}
            {isRecording && systemAudioEnabled && <MiniLevelBars percent={sysMeterPercent} />}
          </button>
        </Tooltip>

        <span className="w-px h-5 bg-[#ECEEF2]" />

        <Tooltip content={sysOpen ? null : '选择系统音频源与双讲回声消除'}>
          <button
            type="button"
            aria-label="选择系统音频源"
            aria-expanded={sysOpen}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              const next = openMenu === 'system' ? null : 'system';
              setOpenMenu(next);
              if (next) void refreshDevices();
            }}
            className={`h-full px-1.5 flex items-center justify-center hover:bg-[#F2F3F5] transition-colors cursor-pointer ${
              sysOpen ? 'bg-[#EBF2FF] text-[#1456F0]' : 'text-[#646A73]'
            }`}
          >
            <ChevronDown
              className={`w-4 h-4 transition-transform duration-150 ${sysOpen ? 'rotate-180' : ''}`}
            />
          </button>
        </Tooltip>
      </div>

      {/* ==================== 麦克风下拉面板（FloatingPortal 防裁切） ==================== */}
      {micPresence.shouldRender && (
        <FloatingPortal>
          <div
            ref={micFloating.refs.setFloating}
            style={{
              ...micFloating.floatingStyles,
              visibility: micFloating.isPositioned ? 'visible' : 'hidden',
            }}
            {...micInteractions.getFloatingProps()}
            className="z-[75] focus:outline-none app-no-drag"
          >
            <div
              className={`w-88 origin-top-right rounded-2xl border border-[#DEE0E3] bg-white shadow-[0_14px_36px_rgba(31,35,41,0.16)] p-3.5 space-y-3 transition-all duration-160 ease-[cubic-bezier(0.16,1,0.3,1)] ${
                micPresence.isVisible && micFloating.isPositioned
                  ? 'opacity-100 scale-100 translate-y-0'
                  : 'opacity-0 scale-[0.95] -translate-y-1.5 pointer-events-none'
              }`}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Mic className="w-4 h-4 text-[#1456F0]" />
                  <span className="text-[15px] font-semibold text-[#1F2329]">麦克风输入</span>
                </div>
                <div className="flex items-center gap-2.5">
                  <button
                    type="button"
                    onClick={() => void refreshDevices()}
                    aria-label="刷新设备列表"
                    className="p-1.5 rounded-md text-[#646A73] hover:bg-[#F2F3F5] hover:text-[#1F2329] transition-colors cursor-pointer"
                  >
                    <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
                  </button>
                  <Switch
                    checked={micEnabled}
                    ariaLabel="启用麦克风输入"
                    onChange={(checked) => void setMicChannel({ enabled: checked })}
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-[14px] text-[#646A73]">
                  <span>实时输入电平</span>
                  <span className="tabular-nums font-medium text-[#1F2329]">
                    {!micEnabled
                      ? '已禁用'
                      : isRecording
                        ? `${micMeterPercent}%`
                        : '开始录音后显示'}
                  </span>
                </div>
                <div className="h-2 rounded-full bg-[#EBEDF0] overflow-hidden">
                  <div
                    className="h-full rounded-full bg-[#1456F0] transition-[width] duration-75"
                    style={{ width: `${isRecording && micEnabled ? micMeterPercent : 0}%` }}
                  />
                </div>
              </div>

              <div className="border-t border-[#ECEEF2] pt-2.5 space-y-1 max-h-64 overflow-y-auto">
                {micOptions.map((opt) => {
                  const selected = (audioDeviceId || 'default') === opt.value;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => {
                        void setMicChannel({ enabled: true, deviceId: opt.value });
                        setOpenMenu(null);
                      }}
                      className={`w-full rounded-lg px-3 py-2 text-left text-[14px] flex items-center justify-between gap-2 transition-colors cursor-pointer ${
                        selected
                          ? 'bg-[#EBF2FF] text-[#1456F0] font-medium'
                          : 'text-[#1F2329] hover:bg-[#F5F6F7]'
                      }`}
                    >
                      <span className="truncate">{opt.label}</span>
                      {selected && <Check className="w-4 h-4 text-[#1456F0] shrink-0" />}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </FloatingPortal>
      )}

      {/* ==================== 系统内录与 AEC3 下拉面板（FloatingPortal 防裁切） ==================== */}
      {sysPresence.shouldRender && (
        <FloatingPortal>
          <div
            ref={sysFloating.refs.setFloating}
            style={{
              ...sysFloating.floatingStyles,
              visibility: sysFloating.isPositioned ? 'visible' : 'hidden',
            }}
            {...sysInteractions.getFloatingProps()}
            className="z-[75] focus:outline-none app-no-drag"
          >
            <div
              className={`w-96 origin-top-right rounded-2xl border border-[#DEE0E3] bg-white shadow-[0_14px_36px_rgba(31,35,41,0.16)] p-3.5 space-y-3 transition-all duration-160 ease-[cubic-bezier(0.16,1,0.3,1)] ${
                sysPresence.isVisible && sysFloating.isPositioned
                  ? 'opacity-100 scale-100 translate-y-0'
                  : 'opacity-0 scale-[0.95] -translate-y-1.5 pointer-events-none'
              }`}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Volume2 className="w-4 h-4 text-[#1456F0]" />
                  <span className="text-[15px] font-semibold text-[#1F2329]">系统内录音频</span>
                </div>
                <div className="flex items-center gap-2.5">
                  <button
                    type="button"
                    onClick={() => void refreshDevices()}
                    aria-label="刷新系统音频源"
                    className="p-1.5 rounded-md text-[#646A73] hover:bg-[#F2F3F5] hover:text-[#1F2329] transition-colors cursor-pointer"
                  >
                    <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
                  </button>
                  <Switch
                    checked={systemAudioEnabled}
                    ariaLabel="启用系统内录"
                    onChange={(checked) => void setSystemChannel({ enabled: checked })}
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-[14px] text-[#646A73]">
                  <span>实时内录电平</span>
                  <span className="tabular-nums font-medium text-[#1F2329]">
                    {!systemAudioEnabled
                      ? '已禁用'
                      : isRecording
                        ? `${sysMeterPercent}%`
                        : '开始录音后显示'}
                  </span>
                </div>
                <div className="h-2 rounded-full bg-[#EBEDF0] overflow-hidden">
                  <div
                    className="h-full rounded-full bg-[#1456F0] transition-[width] duration-75"
                    style={{
                      width: `${isRecording && systemAudioEnabled ? sysMeterPercent : 0}%`,
                    }}
                  />
                </div>
              </div>

              <div className="border-t border-[#ECEEF2] pt-2.5 space-y-1 max-h-64 overflow-y-auto">
                {systemOptions.map((opt) => {
                  const selected = (systemAudioDeviceId || 'default') === opt.value;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => {
                        void setSystemChannel({
                          enabled: true,
                          deviceId: opt.value,
                          forceRepick: opt.value === 'display-share' && selected && isRecording,
                        });
                        setOpenMenu(null);
                      }}
                      className={`w-full rounded-lg px-3 py-2 text-left text-[14px] flex items-center justify-between gap-2 transition-colors cursor-pointer ${
                        selected
                          ? 'bg-[#EBF2FF] text-[#1456F0] font-medium'
                          : 'text-[#1F2329] hover:bg-[#F5F6F7]'
                      }`}
                    >
                      <span className="truncate">{opt.label}</span>
                      {selected && <Check className="w-4 h-4 text-[#1456F0] shrink-0" />}
                    </button>
                  );
                })}
              </div>

              {isRecording && systemAudioEnabled && systemAudioDeviceId === 'display-share' && (
                <button
                  type="button"
                  onClick={() => {
                    void setSystemChannel({
                      enabled: true,
                      deviceId: 'display-share',
                      forceRepick: true,
                    });
                    setOpenMenu(null);
                  }}
                  className="w-full h-9 rounded-lg border border-[#BEDAFF] bg-[#EBF2FF]/60 hover:bg-[#EBF2FF] text-[#1456F0] text-[14px] font-medium flex items-center justify-center gap-2 transition-colors cursor-pointer"
                >
                  <MonitorUp className="w-4 h-4" />
                  <span>重新选择共享窗口或屏幕音频</span>
                </button>
              )}

              <div className="border-t border-[#ECEEF2] pt-3 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 text-[14px] font-medium text-[#1F2329]">
                    <AudioWaveform className="w-4 h-4 text-[#1456F0] shrink-0" />
                    <span>双讲回声消除（WebRTC AEC3）</span>
                  </div>
                  <p className="text-[14px] text-[#646A73] truncate mt-0.5">
                    {telemetry.aec3Active
                      ? '实时回声剔除生效中'
                      : enableWebrtcAec3 && aec3Installed
                        ? micEnabled && systemAudioEnabled
                          ? '双讲就绪，开始录音后生效'
                          : '同时开启双通道时自动生效'
                        : aec3Installed
                          ? '组件已安装，当前已关闭'
                          : '首次开启将提示下载组件'}
                  </p>
                </div>
                <Switch
                  checked={Boolean(enableWebrtcAec3 && aec3Installed)}
                  ariaLabel="启用 WebRTC AEC3 回声消除"
                  onChange={(checked) => void requestToggleWebrtcAec3(checked)}
                />
              </div>
            </div>
          </div>
        </FloatingPortal>
      )}
    </div>
  );
});

AudioSourceControl.displayName = 'AudioSourceControl';
