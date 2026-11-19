import { Download, Loader2 } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { Modal } from './Modal';

export function AddonDownloadModal() {
  const { addon, stage } = useAppStore((s) => s.addonDownload);
  const close = useAppStore((s) => s.closeAddonDownload);
  const download = useAppStore((s) => s.confirmAddonDownload);
  const downloading = stage === 'downloading';
  const opencode = addon === 'opencode';

  return (
    <Modal
      open={stage !== 'closed'}
      onClose={close}
      title={opencode ? '下载 OpenCode 组件' : '下载默认语音组件'}
      widthClass="max-w-md"
      layerClass="z-[80]"
    >
      <div className="space-y-5 p-6">
        <p className="text-[15px] leading-relaxed text-[#1F2329]">
          {opencode
            ? '首次使用 OpenCode 免费模型需要下载组件（约 126 MB）。'
            : '首次使用默认免登录语音需要下载语音组件。'}
        </p>
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
