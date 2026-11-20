import { Download, Loader2 } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import type { OpenCodeDownloadProgress } from '../../types/domain';
import { Modal } from './Modal';

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  if (bytes >= 1_000_000) {
    return `${(bytes / 1_000_000).toFixed(1)} MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1_000))} KB`;
}

function describeStage(
  stage: OpenCodeDownloadProgress['stage'] | undefined
): string {
  switch (stage) {
    case 'connecting':
      return '正在连接组件源...';
    case 'downloading':
      return '正在下载 OpenCode 运行组件...';
    case 'verifying':
      return '正在校验并解压组件…';
    case 'starting':
      return '正在启动 OpenCode…';
    case 'ready':
      return '组件已就绪，正在继续...';
    default:
      return '正在准备下载...';
  }
}

export function AddonDownloadModal() {
  const { addon, stage } = useAppStore((s) => s.addonDownload);
  const progress = useAppStore((s) => s.addonDownloadProgress);
  const close = useAppStore((s) => s.closeAddonDownload);
  const download = useAppStore((s) => s.confirmAddonDownload);
  const downloading = stage === 'downloading';
  const opencode = addon === 'opencode';
  const percent = progress ? Math.min(100, Math.max(0, progress.percent)) : 0;
  const transfer = progress?.stage === 'downloading' && progress.totalBytes > 0 ? progress : null;

  return (
    <Modal
      open={stage !== 'closed'}
      onClose={close}
      closable={!downloading}
      title={opencode ? '下载 OpenCode 组件' : '下载默认语音组件'}
      widthClass="max-w-md"
      layerClass="z-[80]"
    >
      <div className="space-y-5 p-6">
        <p className="text-[15px] leading-relaxed text-[#1F2329]">
          {opencode
            ? '首次使用 OpenCode 免费模型需要下载组件。'
            : '首次使用默认免登录语音需要下载语音组件。'}
        </p>

        {downloading && opencode && (
          <div className="space-y-2 rounded-xl border border-[#BEDAFF] bg-[#F5F8FF] p-4">
            <div className="flex items-center justify-between gap-2 text-[14px]">
              <span className="font-medium text-[#1456F0] flex items-center gap-2 min-w-0">
                <Loader2 className="w-4 h-4 animate-spin shrink-0" />
                <span className="truncate">{describeStage(progress?.stage)}</span>
              </span>
              {transfer && (
                <span className="font-semibold text-[#1F2329] tabular-nums shrink-0">
                  {percent}%
                </span>
              )}
            </div>
            {transfer && (
              <>
                <div className="h-2 w-full rounded-full bg-[#DCE8FF] overflow-hidden">
                  <div
                    className="h-full rounded-full bg-[#1456F0] transition-[width] duration-200 ease-out"
                    style={{ width: `${percent}%` }}
                  />
                </div>
                <div className="text-[14px] text-[#4E5969] text-right tabular-nums">
                  {formatBytes(transfer.downloadedBytes)} / {formatBytes(transfer.totalBytes)}
                </div>
              </>
            )}
          </div>
        )}

        <div className="flex items-center justify-end gap-3">
          <button
            type="button"
            disabled={downloading}
            onClick={close}
            className="h-10 px-4 rounded-lg border border-[#DEE0E3] bg-white text-[14px] font-medium text-[#1F2329] hover:bg-[#F2F3F5] disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
          >
            取消
          </button>
          <button
            type="button"
            disabled={downloading}
            onClick={() => void download()}
            className="h-10 px-4 rounded-lg bg-[#1456F0] text-white text-[14px] font-medium hover:bg-[#3370FF] disabled:opacity-60 disabled:cursor-not-allowed flex items-center gap-2 transition-colors cursor-pointer"
          >
            {downloading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
            {downloading ? '正在下载…' : '下载并继续'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
