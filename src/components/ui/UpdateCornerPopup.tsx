import React, { useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertTriangle,
  ArrowUpCircle,
  CheckCircle2,
  Download,
  ExternalLink,
  FolderOpen,
  Loader2,
  RefreshCw,
  ShieldCheck,
  X,
} from 'lucide-react';
import { useAnimatedPresence } from '../../hooks/useAnimatedPresence';
import { useAppStore } from '../../store/useAppStore';
import {
  getDesktopBridge,
  isAndroidPlatform,
  useViewportLayout,
} from '../../utils/desktopBridge';

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function summarizeReleaseNotes(notes: string): string {
  const cleaned = notes
    .replace(/```[\s\S]*?```/g, '')
    .replace(/[#>*`]/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 5)
    .join('\n');
  return cleaned || '包含最新功能优化与稳定性修复，建议立即升级。';
}

export const UpdateCornerPopup: React.FC = () => {
  const appUpdate = useAppStore((s) => s.appUpdate);
  const isRecording = useAppStore((s) => s.activeSession?.status === 'recording');
  const startOneClickAppUpdate = useAppStore((s) => s.startOneClickAppUpdate);
  const applyReadyAppUpdate = useAppStore((s) => s.applyReadyAppUpdate);
  const dismissUpdatePopup = useAppStore((s) => s.dismissUpdatePopup);
  const ignoreAvailableUpdateVersion = useAppStore((s) => s.ignoreAvailableUpdateVersion);
  const { isCompactPhoneLayout } = useViewportLayout();

  const hasDisplayableStatus =
    appUpdate.status !== 'idle' &&
    appUpdate.status !== 'checking' &&
    appUpdate.status !== 'up-to-date';
  const isOpen = Boolean(appUpdate.popupVisible && hasDisplayableStatus);
  const { shouldRender, isVisible } = useAnimatedPresence(isOpen, 180);

  const cachedStateRef = useRef(appUpdate);
  if (isOpen) {
    cachedStateRef.current = appUpdate;
  }

  if (!shouldRender) return null;

  const activeUpdate = isOpen ? appUpdate : cachedStateRef.current;
  const { status, info, progress, errorMessage, manualDownloadPath } = activeUpdate;
  if (status === 'idle' || status === 'checking' || status === 'up-to-date') {
    return null;
  }

  const latestVer = info?.latestVersion ? `v${info.latestVersion}` : '新版本';
  const currentVer = info?.currentVersion ? `v${info.currentVersion}` : '';
  const sizeLabel = info?.asset?.sizeBytes ? formatBytes(info.asset.sizeBytes) : '';
  const isBusy = status === 'downloading' || status === 'verifying' || status === 'applying';
  const isAndroid = isAndroidPlatform();
  const percent = Math.max(0, Math.min(100, progress?.percent ?? (status === 'ready' ? 100 : 0)));

  const cardContent = (
    <>
      {/* 顶部飞书蓝细亮条 */}
      <div className="h-[3px] w-full shrink-0 bg-gradient-to-r from-[#1456F0] via-[#3370FF] to-[#5B8EFF]" />

      <div className="p-4 flex flex-col gap-3 min-h-0 flex-1 overflow-hidden">
        {/* 标题栏 */}
        <div className="flex items-start justify-between gap-3 shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <div
              className={`w-9 h-9 rounded-[10px] shrink-0 flex items-center justify-center ${
                status === 'error'
                  ? 'bg-[#FFF1F0] text-[#D83931]'
                  : status === 'ready'
                    ? 'bg-[#E8F8F0] text-[#00A854]'
                    : 'bg-[#EBF2FF] text-[#1456F0]'
              }`}
            >
              {status === 'error' ? (
                <AlertTriangle className="w-5 h-5" />
              ) : status === 'ready' ? (
                <CheckCircle2 className="w-5 h-5" />
              ) : status === 'applying' ? (
                <Loader2 className="w-5 h-5 animate-spin" />
              ) : status === 'verifying' ? (
                <ShieldCheck className="w-5 h-5" />
              ) : (
                <ArrowUpCircle className="w-5 h-5" />
              )}
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-[15px] font-semibold text-[#1F2329] truncate">
                  {status === 'applying'
                    ? isAndroid
                      ? '正在拉起安装器...'
                      : '正在安装新版本...'
                    : status === 'ready'
                      ? `更新 ${latestVer} 已就绪`
                      : status === 'error'
                        ? '软件更新未能完成'
                        : `发现新版本 ${latestVer}`}
                </span>
              </div>
              <p className="text-[14px] text-[#646A73] truncate">
                {currentVer && info?.latestVersion
                  ? `${currentVer} → ${latestVer}${sizeLabel ? ` · ${sizeLabel}` : ''}`
                  : '来自 CNB 官方发布渠道'}
              </p>
            </div>
          </div>

          {!isBusy && (
            <button
              type="button"
              onClick={dismissUpdatePopup}
              aria-label="稍后提醒"
              className="w-7 h-7 rounded-lg flex items-center justify-center text-[#8F959E] hover:text-[#1F2329] hover:bg-[#F2F3F5] transition-colors shrink-0 cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* 正文区域：按状态切换，内容超长时内部滚动绝不撑破屏幕底部 */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {status === 'available' && (
            <div className="rounded-[10px] bg-[#F7F9FC] border border-[#EBEEF5] px-3 py-2.5 max-h-[140px] overflow-y-auto">
              <p className="text-[14px] leading-relaxed text-[#4E5969] whitespace-pre-line break-words">
                {summarizeReleaseNotes(info?.releaseNotes || '')}
              </p>
            </div>
          )}

          {(status === 'downloading' || status === 'verifying') && (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2 text-[14px]">
                <span className="text-[#1F2329] font-medium truncate">
                  {status === 'verifying'
                    ? '正在校验 SHA-256 完整性...'
                    : progress?.stage === 'connecting'
                      ? '正在连接 CNB 高速节点...'
                      : '正在下载更新包...'}
                </span>
                <span className="font-semibold text-[#1456F0] tabular-nums shrink-0">{percent}%</span>
              </div>
              <div className="h-2 w-full rounded-full bg-[#E8EEFA] overflow-hidden">
                <div
                  className="h-full rounded-full bg-[#1456F0] transition-[width] duration-150 ease-out"
                  style={{ width: `${Math.max(4, percent)}%` }}
                />
              </div>
              <div className="flex items-center justify-between gap-2 text-[14px] text-[#646A73] tabular-nums">
                <span className="truncate">
                  {formatBytes(progress?.downloadedBytes ?? 0)}
                  {progress?.totalBytes ? ` / ${formatBytes(progress.totalBytes)}` : ''}
                </span>
                <span className="shrink-0">
                  {progress?.speedBytesPerSec && status === 'downloading'
                    ? `${(progress.speedBytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`
                    : status === 'verifying'
                      ? '防篡改校验中'
                      : ''}
                </span>
              </div>
            </div>
          )}

          {status === 'ready' && (
            <div className="rounded-[10px] bg-[#F0F9F4] border border-[#C6ECD7] px-3 py-2.5 space-y-1">
              <p className="text-[14px] text-[#1F2329] leading-relaxed">
                {manualDownloadPath
                  ? '安装包已通过 SHA-256 校验（当前为源码开发运行模式，请手动运行或打包测试）。'
                  : isRecording
                    ? `新版本已下载并校验完成。检测到当前正在录音，请先暂停录音后再点击「${isAndroid ? '立即安装' : '立即重启安装'}」。`
                    : isAndroid
                      ? '新版本已通过 SHA-256 安全校验，点击下方按钮即可拉起系统安装器覆盖升级，课堂数据不会丢失。'
                      : '新版本已通过 SHA-256 安全校验，点击下方按钮将自动完成替换并重启。'}
              </p>
            </div>
          )}

          {status === 'applying' && (
            <p className="text-[14px] text-[#4E5969] leading-relaxed">
              {isAndroid
                ? '正在拉起安卓系统安装界面，请确认安装以完成升级，课堂数据不会丢失。'
                : '已启动独立热更新程序，应用将在 1 秒内自动退出、覆盖安装并重新启动，课堂数据不会丢失。'}
            </p>
          )}

          {status === 'error' && (
            <div className="rounded-[10px] bg-[#FFF5F5] border border-[#FAD2CF] px-3 py-2.5">
              <p className="text-[14px] text-[#B42318] leading-relaxed break-words">
                {errorMessage || '下载或校验更新时出现异常，请稍后重试。'}
              </p>
            </div>
          )}
        </div>

        {/* 底部按钮栏（固定不随正文滚动，始终完整可见） */}
        {status === 'available' && (
          <div className="flex items-center justify-between gap-2 pt-0.5 shrink-0">
            <div className="flex items-center gap-1 shrink-0">
              <button
                type="button"
                onClick={ignoreAvailableUpdateVersion}
                className="px-2.5 py-1.5 rounded-lg text-[14px] text-[#646A73] hover:text-[#1F2329] hover:bg-[#F2F3F5] whitespace-nowrap transition-colors cursor-pointer"
              >
                忽略此版
              </button>
              <button
                type="button"
                onClick={dismissUpdatePopup}
                className="px-2.5 py-1.5 rounded-lg text-[14px] text-[#646A73] hover:text-[#1F2329] hover:bg-[#F2F3F5] whitespace-nowrap transition-colors cursor-pointer"
              >
                稍后
              </button>
            </div>
            <button
              type="button"
              onClick={() => void startOneClickAppUpdate()}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-[10px] bg-[#1456F0] hover:bg-[#3370FF] active:bg-[#0F45C9] text-white text-[14px] font-medium shadow-[0_4px_12px_rgba(20,86,240,0.24)] whitespace-nowrap shrink-0 transition-colors cursor-pointer"
            >
              <Download className="w-4 h-4 shrink-0" />
              <span>一键更新</span>
            </button>
          </div>
        )}

        {status === 'ready' && (
          <div className="flex items-center justify-end gap-2 pt-0.5 shrink-0">
            <button
              type="button"
              onClick={dismissUpdatePopup}
              className="px-3 py-1.5 rounded-lg text-[14px] text-[#646A73] hover:text-[#1F2329] hover:bg-[#F2F3F5] whitespace-nowrap transition-colors cursor-pointer"
            >
              稍后安装
            </button>
            {manualDownloadPath ? (
              <button
                type="button"
                onClick={() => {
                  void getDesktopBridge()?.open_path_in_explorer?.(manualDownloadPath);
                }}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-[10px] bg-[#1456F0] hover:bg-[#3370FF] text-white text-[14px] font-medium whitespace-nowrap transition-colors cursor-pointer"
              >
                <FolderOpen className="w-4 h-4 shrink-0" />
                <span>打开目录</span>
              </button>
            ) : (
              <button
                type="button"
                disabled={isRecording}
                onClick={() => void applyReadyAppUpdate()}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-[10px] bg-[#1456F0] hover:bg-[#3370FF] disabled:opacity-50 disabled:cursor-not-allowed text-white text-[14px] font-medium whitespace-nowrap transition-colors cursor-pointer"
              >
                <RefreshCw className="w-4 h-4 shrink-0" />
                <span>
                  {isRecording
                    ? '请先暂停录音'
                    : isAndroid
                      ? '立即安装'
                      : '立即重启安装'}
                </span>
              </button>
            )}
          </div>
        )}

        {status === 'error' && (
          <div className="flex items-center justify-between gap-2 pt-0.5 shrink-0 flex-wrap">
            {info?.releaseUrl ? (
              <a
                href={info.releaseUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-[14px] text-[#1456F0] hover:underline whitespace-nowrap"
              >
                <span>前往 CNB 手动下载</span>
                <ExternalLink className="w-3.5 h-3.5 shrink-0" />
              </a>
            ) : (
              <span />
            )}
            <button
              type="button"
              onClick={() => void startOneClickAppUpdate()}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-[10px] bg-[#1456F0] hover:bg-[#3370FF] text-white text-[14px] font-medium whitespace-nowrap shrink-0 transition-colors cursor-pointer"
            >
              <RefreshCw className="w-4 h-4 shrink-0" />
              <span>重试更新</span>
            </button>
          </div>
        )}
      </div>
    </>
  );

  // 紧凑手机端（含横屏短视口）：居中弹窗 + 120Hz 弹簧弹出 + 安全区留白 + 内部滚动，绝不贴底被导航栏遮挡或超出屏幕底部
  const popupNode = isCompactPhoneLayout ? (
    <div
      role="presentation"
      data-update-backdrop="true"
      style={{
        paddingTop: 'calc(16px + var(--android-safe-top, 0px))',
        paddingBottom: 'calc(16px + var(--android-safe-bottom, 0px))',
      }}
      className={`fixed inset-0 z-[85] flex items-center justify-center px-4 bg-[#1F2329]/38 transition-opacity duration-200 ${
        isVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'
      }`}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !isBusy) {
          dismissUpdatePopup();
        }
      }}
    >
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="软件版本更新提示"
        data-update-popup="true"
        style={{
          transitionTimingFunction: isVisible
            ? 'var(--spring-expressive, cubic-bezier(0.22, 1, 0.36, 1))'
            : 'cubic-bezier(0.32, 0.72, 0, 1)',
        }}
        className={`w-full max-w-[368px] max-h-full rounded-[16px] border border-[#DCE4F7] bg-white shadow-[0_20px_48px_rgba(20,86,240,0.18),0_4px_16px_rgba(31,35,41,0.12)] overflow-hidden flex flex-col transition-[transform,opacity] ${
          isVisible
            ? 'duration-[300ms] opacity-100 scale-100 translate-y-0'
            : 'duration-[180ms] opacity-0 scale-[0.94] translate-y-3'
        }`}
      >
        {cardContent}
      </aside>
    </div>
  ) : (
    <aside
      role="dialog"
      aria-label="软件版本更新提示"
      data-update-popup="true"
      style={{
        bottom: 'calc(20px + var(--android-safe-bottom, 0px))',
        maxHeight: 'calc(100% - 40px - var(--android-safe-top, 0px) - var(--android-safe-bottom, 0px))',
        transitionTimingFunction: isVisible
          ? 'var(--spring-expressive, cubic-bezier(0.22, 1, 0.36, 1))'
          : 'cubic-bezier(0.32, 0.72, 0, 1)',
      }}
      className={`fixed right-5 z-[85] w-[376px] max-w-[calc(100vw-32px)] rounded-[14px] border border-[#DCE4F7] bg-white/98 backdrop-blur-md shadow-[0_14px_40px_rgba(20,86,240,0.16),0_2px_10px_rgba(31,35,41,0.08)] overflow-hidden flex flex-col transition-[transform,opacity] ${
        isVisible
          ? 'duration-[320ms] opacity-100 scale-100 translate-y-0'
          : 'duration-[180ms] opacity-0 scale-[0.94] translate-y-3 pointer-events-none'
      }`}
    >
      {cardContent}
    </aside>
  );

  if (typeof document !== 'undefined') {
    return createPortal(popupNode, document.body);
  }
  return popupNode;
};
