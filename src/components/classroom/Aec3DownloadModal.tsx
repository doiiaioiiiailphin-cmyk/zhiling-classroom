import React from 'react';
import { AudioWaveform, CheckCircle2, Download, Loader2 } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { Modal } from '../ui/Modal';

function formatKilobytes(bytes: number): string {
  if (bytes <= 0) return '0 KB';
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function getStageDescription(
  stage: 'connecting' | 'downloading' | 'verifying' | 'ready' | undefined
): string {
  switch (stage) {
    case 'connecting':
      return '正在连接组件源...';
    case 'downloading':
      return '正在下载 WebRTC AEC3 回声消除模块...';
    case 'verifying':
      return '正在校验 SHA-256 签名并写入本地组件目录...';
    case 'ready':
      return '组件准备就绪，正在启用...';
    default:
      return '准备下载组件...';
  }
}

export const Aec3DownloadModal: React.FC = () => {
  const aec3Modal = useAppStore((s) => s.aec3Modal);
  const aec3Downloading = useAppStore((s) => s.aec3Downloading);
  const progress = useAppStore((s) => s.aec3DownloadProgress);
  const confirmDownloadAec3Modal = useAppStore((s) => s.confirmDownloadAec3Modal);
  const skipAec3ModalAndProceed = useAppStore((s) => s.skipAec3ModalAndProceed);
  const closeAec3Modal = useAppStore((s) => s.closeAec3Modal);

  const isDualTalkStart = aec3Modal.mode === 'dual-talk-start';
  const percent = progress ? Math.min(100, Math.max(0, progress.percent)) : 0;

  return (
    <Modal
      open={aec3Modal.open}
      onClose={closeAec3Modal}
      closable={!aec3Downloading}
      title="启用 WebRTC AEC3 双讲回声消除"
      widthClass="max-w-lg"
    >
      <div className="p-4 sm:p-6 space-y-4 sm:space-y-5">
        <div className="flex items-start gap-3 sm:gap-3.5 rounded-xl border border-[#BEDAFF] bg-[#EBF2FF]/70 p-3.5 sm:p-4">
          <div className="w-10 h-10 rounded-lg bg-[#1456F0] text-white flex items-center justify-center shrink-0 mt-0.5">
            <AudioWaveform className="w-5 h-5" />
          </div>
          <div className="space-y-1.5 min-w-0">
            <p className="text-[15px] font-semibold text-[#1F2329]">
              {isDualTalkStart
                ? '检测到首次开启双通道音频（双讲模式）'
                : '启用回声消除需下载 WebRTC AEC3 组件'}
            </p>
            <p className="text-[14px] leading-relaxed text-[#4E5969]">
              在「麦克风 + 系统内录」双通道同时工作时，扬声器外放的课程声音容易被麦克风二次拾取产生回声与重复转写。下载 WebRTC AEC3 模块后，系统将以系统内录为参考信号在本地实时剔除回声，并完整保留您同时发言的人声。
            </p>
          </div>
        </div>

        <div className="rounded-xl border border-[#DEE0E3] bg-[#F8F9FA] px-4 py-3.5 space-y-2.5">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-0.5 sm:gap-4 text-[14px]">
            <span className="font-medium text-[#1F2329] shrink-0 whitespace-nowrap">组件名称</span>
            <span className="text-[#4E5969] sm:text-right break-words">
              WebRTC AudioProcessing AEC3 (WASM v0.3.0)
            </span>
          </div>
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-0.5 sm:gap-4 text-[14px]">
            <span className="font-medium text-[#1F2329] shrink-0 whitespace-nowrap">下载体积</span>
            <span className="text-[#4E5969] tabular-nums sm:text-right break-words">
              约 302 KB（本地持久化保存，仅需下载一次）
            </span>
          </div>
          {isDualTalkStart && (
            <div className="flex items-start sm:items-center gap-2 pt-1 text-[14px] text-[#646A73]">
              <CheckCircle2 className="w-4 h-4 text-[#1456F0] shrink-0 mt-0.5 sm:mt-0" />
              <span>若暂不下载也可直接开启双讲模式，后续随时可在设置中启用回声消除。</span>
            </div>
          )}
        </div>

        {aec3Downloading && (
          <div className="space-y-2 rounded-xl border border-[#BEDAFF] bg-white p-4">
            <div className="flex items-center justify-between gap-2 text-[14px]">
              <span className="font-medium text-[#1456F0] flex items-center gap-2 min-w-0">
                <Loader2 className="w-4 h-4 animate-spin shrink-0" />
                <span className="truncate">{getStageDescription(progress?.stage)}</span>
              </span>
              <span className="font-semibold text-[#1F2329] tabular-nums shrink-0">{percent}%</span>
            </div>
            <div className="h-2 w-full rounded-full bg-[#EBEDF0] overflow-hidden">
              <div
                className="h-full rounded-full bg-[#1456F0] transition-[width] duration-200 ease-out"
                style={{ width: `${percent}%` }}
              />
            </div>
            {progress && progress.totalBytes > 0 && (
              <div className="text-[14px] text-[#646A73] text-right tabular-nums">
                {formatKilobytes(progress.downloadedBytes)} / {formatKilobytes(progress.totalBytes)}
              </div>
            )}
          </div>
        )}

        <div className="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-end gap-2.5 sm:gap-3 pt-1">
          {isDualTalkStart ? (
            <button
              type="button"
              disabled={aec3Downloading}
              onClick={() => void skipAec3ModalAndProceed()}
              className="min-h-10 py-2 px-4 w-full sm:w-auto rounded-lg border border-[#DEE0E3] bg-white text-[14px] font-medium text-[#1F2329] hover:bg-[#F2F3F5] disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center justify-center whitespace-nowrap transition-colors cursor-pointer"
            >
              暂不下载，直接开启
            </button>
          ) : (
            <button
              type="button"
              disabled={aec3Downloading}
              onClick={closeAec3Modal}
              className="min-h-10 py-2 px-4 w-full sm:w-auto rounded-lg border border-[#DEE0E3] bg-white text-[14px] font-medium text-[#1F2329] hover:bg-[#F2F3F5] disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center justify-center whitespace-nowrap transition-colors cursor-pointer"
            >
              取消
            </button>
          )}

          <button
            type="button"
            disabled={aec3Downloading}
            onClick={() => void confirmDownloadAec3Modal()}
            className="min-h-10 py-2 px-4 w-full sm:w-auto rounded-lg bg-[#1456F0] text-white text-[14px] font-medium hover:bg-[#3370FF] disabled:opacity-60 disabled:cursor-not-allowed inline-flex items-center justify-center gap-2 whitespace-nowrap transition-colors cursor-pointer"
          >
            {aec3Downloading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin shrink-0" />
                <span>正在下载...</span>
              </>
            ) : (
              <>
                <Download className="w-4 h-4 shrink-0" />
                <span>{isDualTalkStart ? '下载并启用双讲' : '下载并启用'}</span>
              </>
            )}
          </button>
        </div>
      </div>
    </Modal>
  );
};
