import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowUpCircle,
  AudioLines,
  ChevronLeft,
  ChevronRight,
  Cpu,
  Download,
  Eye,
  EyeOff,
  LayoutGrid,
  Link2,
  Loader2,
  RefreshCw,
  SlidersHorizontal,
  Workflow,
} from 'lucide-react';
import {
  AI_MODULE_META_LIST,
  API_PROTOCOL_OPTIONS,
  ASR_PROVIDER_PRESETS,
  LLM_PROVIDER_PRESETS,
} from '../../constants/providers';
import { useAudioDevices } from '../../hooks/useAudioDevices';
import { IS_MOCK_MODE, api } from '../../services/api';
import { useAppStore } from '../../store/useAppStore';
import type { AIModuleKey, ApiProtocol, DesktopHotkeys } from '../../types/domain';
import {
  formatShortcutLabel,
  getDefaultDesktopHotkeys,
  isAndroidPlatform,
  isMacPlatform,
  keyboardEventToHotkeyCombo,
  useViewportLayout,
} from '../../utils/desktopBridge';
import { useOverscrollSpring } from '../../hooks/useOverscrollSpring';
import { triggerHaptic } from '../../utils/springPhysics';
import { ProviderIcon } from '../icons/ProviderIcons';
import { IconButton } from '../ui/IconButton';
import { MobileSpringPage } from '../ui/MobileSpringPage';
import { Modal } from '../ui/Modal';
import { Select } from '../ui/Select';
import { Switch } from '../ui/Switch';
import { ProviderGridModal } from './ProviderGridModal';

type SettingsTabKey = 'llm' | 'routing' | 'asr' | 'general';

const SETTINGS_TABS: Array<{
  key: SettingsTabKey;
  label: string;
  icon: typeof Cpu;
}> = [
  { key: 'llm', label: '模型供应商', icon: Cpu },
  { key: 'routing', label: '功能模型分配', icon: Workflow },
  { key: 'asr', label: '语音转写服务', icon: AudioLines },
  { key: 'general', label: '音频与常规', icon: SlidersHorizontal },
];

const EXPORT_FORMAT_LABELS: Record<'markdown' | 'docx' | 'txt', string> = {
  markdown: 'Markdown',
  docx: 'Word',
  txt: '纯文本',
};

export const SettingsModal: React.FC = () => {
  const {
    settingsOpen,
    settingsDefaultTab,
    setSettingsOpen,
    settings,
    aec3Addon,
    addonDownload,
    ensureBuiltinAsrReady,
    updateSettings,
    requestToggleWebrtcAec3,
    setMicChannel,
    setSystemChannel,
    setAudioInputMode,
    fetchModelsForLlmProvider,
    fetchModelsForAsrProvider,
    appUpdate,
    checkForAppUpdates,
    startOneClickAppUpdate,
  } = useAppStore();

  const [activeTab, setActiveTab] = useState<SettingsTabKey>('llm');
  const [mobileSection, setMobileSection] = useState<SettingsTabKey | null>(null);
  const [mobileNavMotion, setMobileNavMotion] = useState<'none' | 'push' | 'pop'>('none');
  const [localAsrReady, setLocalAsrReady] = useState<boolean | null>(null);
  const [recordingHotkeyKey, setRecordingHotkeyKey] = useState<
    Exclude<keyof DesktopHotkeys, 'enabled'> | null
  >(null);

  const isMac = isMacPlatform();
  const isAndroid = isAndroidPlatform();
  const { isCompactPhoneLayout, isShortLandscape } = useViewportLayout();
  // 手机窄屏/矮横屏使用独立全屏嵌套设置页；平板大屏与桌面端一致采用类电脑分栏窗口
  const useMobilePageLayout = isCompactPhoneLayout;
  const mobileOverscroll = useOverscrollSpring({ enabled: useMobilePageLayout && settingsOpen });
  const {
    reset: resetMobileOverscroll,
    bindScrollRef: bindMobileScrollRef,
    scrollRef: mobileScrollRef,
    contentRef: mobileContentRef,
  } = mobileOverscroll;

  const [llmPickerOpen, setLlmPickerOpen] = useState(false);
  const [asrPickerOpen, setAsrPickerOpen] = useState(false);
  const [showLlmKey, setShowLlmKey] = useState(false);
  const [showAsrKey, setShowAsrKey] = useState(false);
  const [showCustomProxyOverride, setShowCustomProxyOverride] = useState(false);
  const [fetchingLlm, setFetchingLlm] = useState(false);
  const [fetchingAsr, setFetchingAsr] = useState(false);
  const [previewLlmModel, setPreviewLlmModel] = useState('');
  const { micOptions, systemOptions } = useAudioDevices(settingsOpen);

  useEffect(() => {
    if (settingsOpen) {
      setActiveTab(settingsDefaultTab ?? 'llm');
      setMobileSection(settingsDefaultTab ?? null);
      setMobileNavMotion('none');
      resetMobileOverscroll();
    } else {
      setLlmPickerOpen(false);
      setAsrPickerOpen(false);
    }
  }, [settingsOpen, settingsDefaultTab, resetMobileOverscroll]);

  useEffect(() => {
    if (!settingsOpen || IS_MOCK_MODE) return;
    let active = true;
    void api
      .getBuiltinAsrReady()
      .then((ready) => {
        if (active) setLocalAsrReady(ready);
      })
      .catch(() => {
        if (active) setLocalAsrReady(null);
      });
    return () => {
      active = false;
    };
  }, [settingsOpen, addonDownload.stage]);

  const handleMobileBack = useCallback((): boolean => {
    if (!settingsOpen || !useMobilePageLayout) return false;
    if (llmPickerOpen) {
      setLlmPickerOpen(false);
      return true;
    }
    if (asrPickerOpen) {
      setAsrPickerOpen(false);
      return true;
    }
    if (mobileSection !== null) {
      triggerHaptic('selection');
      setMobileNavMotion('pop');
      setMobileSection(null);
      mobileOverscroll.reset();
      mobileOverscroll.scrollRef.current?.scrollTo({ top: 0 });
      return true;
    }
    setSettingsOpen(false);
    return true;
  }, [
    settingsOpen,
    useMobilePageLayout,
    llmPickerOpen,
    asrPickerOpen,
    mobileSection,
    setSettingsOpen,
  ]);

  // Android 系统返回键与键盘 Esc 逐级返回（供应商列表 -> 板块子页 -> 设置主页 -> 关闭设置）
  useEffect(() => {
    if (!settingsOpen || !useMobilePageLayout) return;
    const win = window as unknown as { __zhilingHandleSettingsBack?: () => boolean };
    win.__zhilingHandleSettingsBack = handleMobileBack;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        handleMobileBack();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      if (win.__zhilingHandleSettingsBack === handleMobileBack) {
        delete win.__zhilingHandleSettingsBack;
      }
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [settingsOpen, useMobilePageLayout, handleMobileBack]);

  const selectedLlm = settings
    ? settings.llmProviders[settings.selectedLlmProviderId]
    : null;
  const selectedAsr = settings
    ? settings.asrProviders[settings.selectedAsrProviderId]
    : null;

  const selectedAsrPreset = useMemo(
    () => ASR_PROVIDER_PRESETS.find((p) => p.id === settings?.selectedAsrProviderId),
    [settings?.selectedAsrProviderId]
  );

  useEffect(() => {
    const list = selectedLlm?.availableModels ?? [];
    setPreviewLlmModel((prev) => (list.includes(prev) ? prev : list[0] ?? ''));
  }, [selectedLlm?.providerId, selectedLlm?.availableModels]);

  if (!settings || !selectedLlm || !selectedAsr) {
    return null;
  }

  const protocolLabel =
    API_PROTOCOL_OPTIONS.find((opt) => opt.value === selectedLlm.protocol)?.label ??
    selectedLlm.protocol;

  const enabledFeatureCount = AI_MODULE_META_LIST.filter(
    (meta) => settings.featureRouting[meta.key]?.enabled
  ).length;

  const hasAnyConfiguredLlm = Object.values(settings.llmProviders).some(
    (p) =>
      Boolean(p.apiKey.trim() || (p.isCustom && p.baseUrl.trim())) &&
      p.availableModels.length > 0
  );

  const llmSummarySubtitle =
    selectedLlm.availableModels.length > 0
      ? `${selectedLlm.name} · 已拉取 ${selectedLlm.availableModels.length} 个模型`
      : selectedLlm.apiKey.trim() || (selectedLlm.isCustom && selectedLlm.baseUrl.trim())
        ? `${selectedLlm.name} · 已填密钥，待拉取模型`
        : `${selectedLlm.name} · 待配置 API Key`;

  const asrSummarySubtitle =
    selectedAsr.providerId === 'builtin-free-asr'
      ? `${selectedAsr.name} · ${localAsrReady ? '离线模型已就绪' : '首次使用自动下载'}`
      : `${selectedAsr.name} · ${selectedAsr.selectedModelId || '待配置密钥与模型'}`;

  const defaultExportLabel =
    EXPORT_FORMAT_LABELS[settings.defaultExportFormat] ?? settings.defaultExportFormat;

  const activeAudioModeLabel =
    settings.micEnabled && settings.systemAudioEnabled
      ? '双通道（麦克风 + 系统内录）'
      : settings.systemAudioEnabled
        ? '仅系统内录'
        : settings.micEnabled
          ? '仅麦克风'
          : '音频已静音';

  const generalSummarySubtitle = `${activeAudioModeLabel} · 导出 ${defaultExportLabel} · 热词 ${settings.globalHotwords.length} 个`;

  const openMobileSection = (section: SettingsTabKey) => {
    triggerHaptic('selection');
    setActiveTab(section);
    setMobileNavMotion('push');
    setMobileSection(section);
    resetMobileOverscroll();
    mobileScrollRef.current?.scrollTo({ top: 0 });
  };

  const handleFetchLlmModels = async () => {
    setFetchingLlm(true);
    try {
      await fetchModelsForLlmProvider(selectedLlm.providerId);
    } finally {
      setFetchingLlm(false);
    }
  };

  const handleFetchAsrModels = async () => {
    setFetchingAsr(true);
    try {
      await fetchModelsForAsrProvider(selectedAsr.providerId);
    } finally {
      setFetchingAsr(false);
    }
  };

  const updateFeatureBinding = (
    key: AIModuleKey,
    patch: Partial<AppSettingsFeaturePatch>
  ) => {
    void updateSettings((prev) => {
      const current = prev.featureRouting[key];
      const nextProviderId = patch.providerId ?? current.providerId;
      const providerModels = prev.llmProviders[nextProviderId]?.availableModels ?? [];
      let nextModelId = patch.modelId ?? current.modelId;

      if (patch.providerId && !providerModels.includes(nextModelId)) {
        nextModelId = providerModels[0] ?? '';
      }

      return {
        ...prev,
        featureRouting: {
          ...prev.featureRouting,
          [key]: {
            ...current,
            ...patch,
            providerId: nextProviderId,
            modelId: nextModelId,
          },
        },
      };
    });
  };

  const isUpdateBusy =
    appUpdate.status === 'checking' ||
    appUpdate.status === 'downloading' ||
    appUpdate.status === 'verifying' ||
    appUpdate.status === 'applying';

  const currentVersionLabel = `v${appUpdate.info?.currentVersion || '0.1.14'}`;

  const renderMobileSubpageContent = (section: SettingsTabKey) => {
    if (section === 'llm') {
      return (
        <div className="space-y-4">
          {/* 分组 1：供应商切换与代理开关 */}
          <section className="space-y-2">
            <h3 className="text-[14px] font-medium text-[#646A73] px-1">当前模型供应商</h3>
            <div className="rounded-2xl border border-[#EAEDF1] bg-white shadow-[0_1px_2px_rgba(31,35,41,0.03)] divide-y divide-[#F0F2F5] overflow-hidden">
              <button
                type="button"
                onClick={() => setLlmPickerOpen(true)}
                className="w-full min-h-[68px] px-4 py-3.5 flex items-center justify-between gap-3 text-left active:bg-[#F5F6F7] transition-colors cursor-pointer"
              >
                <div className="flex items-center gap-3.5 min-w-0">
                  <div className="w-11 h-11 rounded-xl bg-[#F7F8FA] border border-[#ECEEF2] flex items-center justify-center text-[#1F2329] shrink-0">
                    <ProviderIcon
                      providerId={selectedLlm.providerId}
                      className="w-6 h-6"
                    />
                  </div>
                  <div className="min-w-0">
                    <div className="text-[16px] font-semibold text-[#1F2329] truncate">
                      {selectedLlm.name}
                    </div>
                    <div className="text-[14px] text-[#646A73] truncate mt-0.5">
                      {protocolLabel}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0 text-[14px] text-[#1456F0] font-medium">
                  <span>切换</span>
                  <ChevronRight className="w-5 h-5 text-[#A6ABB3]" />
                </div>
              </button>

              {!selectedLlm.isCustom && (
                <div className="px-4 py-3.5 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[15px] font-medium text-[#1F2329]">
                      自定义代理地址
                    </div>
                    <div className="text-[14px] text-[#646A73]">
                      如需通过中转网关访问该供应商可开启
                    </div>
                  </div>
                  <Switch
                    checked={showCustomProxyOverride}
                    ariaLabel="开启自定义代理地址"
                    onChange={setShowCustomProxyOverride}
                  />
                </div>
              )}
            </div>
          </section>

          {/* 分组 2：自定义协议 / 端点 */}
          {selectedLlm.isCustom && (
            <section className="space-y-2">
              <h3 className="text-[14px] font-medium text-[#646A73] px-1">接口端点配置</h3>
              <div className="rounded-2xl border border-[#EAEDF1] bg-white shadow-[0_1px_2px_rgba(31,35,41,0.03)] p-4 space-y-4">
                <div className="space-y-2">
                  <label className="block text-[15px] font-medium text-[#1F2329]">
                    通信协议类型
                  </label>
                  <Select
                    value={selectedLlm.protocol}
                    options={API_PROTOCOL_OPTIONS}
                    onChange={(val) =>
                      void updateSettings((prev) => ({
                        ...prev,
                        llmProviders: {
                          ...prev.llmProviders,
                          [selectedLlm.providerId]: {
                            ...prev.llmProviders[selectedLlm.providerId],
                            protocol: val as ApiProtocol,
                          },
                        },
                      }))
                    }
                  />
                </div>

                <div className="space-y-2">
                  <label className="block text-[15px] font-medium text-[#1F2329]">
                    接口端点地址（Base URL）
                  </label>
                  <input
                    type="url"
                    value={selectedLlm.baseUrl}
                    onChange={(e) =>
                      void updateSettings((prev) => ({
                        ...prev,
                        llmProviders: {
                          ...prev.llmProviders,
                          [selectedLlm.providerId]: {
                            ...prev.llmProviders[selectedLlm.providerId],
                            baseUrl: e.target.value,
                          },
                        },
                      }))
                    }
                    placeholder="https://your-gateway.example.com/v1"
                    className="h-11 w-full rounded-xl border border-[#DEE0E3] bg-[#F8F9FA] focus:bg-white px-3.5 text-[15px] text-[#1F2329] placeholder-[#8F959E] focus:border-[#1456F0] focus:outline-none focus:ring-2 focus:ring-[#1456F0]/15"
                  />
                </div>
              </div>
            </section>
          )}

          {!selectedLlm.isCustom && showCustomProxyOverride && (
            <section className="space-y-2">
              <h3 className="text-[14px] font-medium text-[#646A73] px-1">代理端点覆盖</h3>
              <div className="rounded-2xl border border-[#EAEDF1] bg-white shadow-[0_1px_2px_rgba(31,35,41,0.03)] p-4 space-y-2">
                <label className="block text-[15px] font-medium text-[#1F2329]">
                  代理端点覆盖地址
                </label>
                <input
                  type="url"
                  value={selectedLlm.baseUrl}
                  onChange={(e) =>
                    void updateSettings((prev) => ({
                      ...prev,
                      llmProviders: {
                        ...prev.llmProviders,
                        [selectedLlm.providerId]: {
                          ...prev.llmProviders[selectedLlm.providerId],
                          baseUrl: e.target.value,
                        },
                      },
                    }))
                  }
                  placeholder="https://proxy.example.com/v1"
                  className="h-11 w-full rounded-xl border border-[#DEE0E3] bg-[#F8F9FA] focus:bg-white px-3.5 text-[15px] text-[#1F2329] placeholder-[#8F959E] focus:border-[#1456F0] focus:outline-none focus:ring-2 focus:ring-[#1456F0]/15"
                />
              </div>
            </section>
          )}

          {/* 分组 3：API 密钥与可用模型目录 */}
          <section className="space-y-2">
            <h3 className="text-[14px] font-medium text-[#646A73] px-1">
              密钥鉴权与可用模型
            </h3>
            <div className="rounded-2xl border border-[#EAEDF1] bg-white shadow-[0_1px_2px_rgba(31,35,41,0.03)] divide-y divide-[#F0F2F5] overflow-hidden">
              <div className="p-4 space-y-2.5">
                <label className="block text-[15px] font-medium text-[#1F2329]">
                  API 密钥（API Key）
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type={showLlmKey ? 'text' : 'password'}
                    value={selectedLlm.apiKey}
                    onChange={(e) => {
                      const nextKey = e.target.value;
                      void updateSettings((prev) => {
                        const current = prev.llmProviders[selectedLlm.providerId];
                        const resetCatalog = !nextKey.trim() && !current.isCustom;
                        return {
                          ...prev,
                          llmProviders: {
                            ...prev.llmProviders,
                            [selectedLlm.providerId]: {
                              ...current,
                              apiKey: nextKey,
                              availableModels: resetCatalog ? [] : current.availableModels,
                              lastFetchedAt: resetCatalog ? undefined : current.lastFetchedAt,
                            },
                          },
                        };
                      });
                    }}
                    placeholder="输入 API Key 后点击右侧刷新"
                    className="h-11 min-w-0 flex-1 rounded-xl border border-[#DEE0E3] bg-[#F8F9FA] focus:bg-white px-3.5 text-[15px] text-[#1F2329] placeholder-[#8F959E] focus:border-[#1456F0] focus:outline-none focus:ring-2 focus:ring-[#1456F0]/15"
                  />
                  <IconButton
                    icon={showLlmKey ? EyeOff : Eye}
                    size="lg"
                    variant="outline"
                    tooltip={showLlmKey ? '隐藏密钥' : '显示密钥'}
                    onClick={() => setShowLlmKey(!showLlmKey)}
                  />
                  <IconButton
                    icon={RefreshCw}
                    size="lg"
                    variant="primary"
                    spinning={fetchingLlm}
                    disabled={
                      (!selectedLlm.apiKey.trim() &&
                        !(selectedLlm.isCustom && selectedLlm.baseUrl.trim())) ||
                      fetchingLlm
                    }
                    tooltip="获取模型 ID 列表"
                    onClick={() => void handleFetchLlmModels()}
                  />
                </div>
              </div>

              <div className="p-4 space-y-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[15px] font-medium text-[#1F2329]">已获取模型列表</span>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-[14px] text-[#1456F0]">
                      {selectedLlm.availableModels.length > 0
                        ? `共 ${selectedLlm.availableModels.length} 个可用`
                        : '待拉取列表'}
                    </span>
                  </div>
                </div>
                <Select
                  value={previewLlmModel}
                  disabled={selectedLlm.availableModels.length === 0}
                  placeholder="填写密钥并点击刷新获取模型列表"
                  options={selectedLlm.availableModels.map((m) => ({
                    value: m,
                    label: m,
                  }))}
                  onChange={(modelId) => {
                    setPreviewLlmModel(modelId);
                  }}
                />
              </div>
            </div>
          </section>
        </div>
      );
    }

    if (section === 'routing') {
      return (
        <div className="space-y-3.5">
          {!hasAnyConfiguredLlm && (
            <div className="rounded-2xl border border-[#BEDAFF] bg-[#F5F8FF] p-4 space-y-2.5">
              <div className="text-[15px] font-semibold text-[#1456F0]">
                未配置大模型，自动 AI 功能默认不启动
              </div>
              <p className="text-[14px] text-[#4E5969] leading-relaxed">
                当前可直接使用本地离线语音转写。如需使用课堂问答、去语气词、自动分段、重点词高亮或深度解析，请先在「模型供应商」中配置 API Key 并拉取模型列表。
              </p>
              <button
                type="button"
                onClick={() => openMobileSection('llm')}
                className="min-h-9 px-3.5 py-1.5 rounded-xl bg-[#1456F0] hover:bg-[#3370FF] text-white text-[14px] font-medium transition-colors cursor-pointer"
              >
                前往配置模型供应商
              </button>
            </div>
          )}
          <p className="text-[14px] text-[#646A73] px-1 leading-relaxed">
            可为以下 {AI_MODULE_META_LIST.length} 项随堂 AI 能力独立指定模型供应商与具体模型，也可按需单独开启或关闭。
          </p>
          {AI_MODULE_META_LIST.map((meta) => {
            const binding = settings.featureRouting[meta.key];
            const providerOptions = LLM_PROVIDER_PRESETS.map((p) => {
              const cfg = settings.llmProviders[p.id];
              return {
                value: p.id,
                label: cfg?.name ?? p.name,
                icon: <ProviderIcon providerId={p.id} className="w-4 h-4" />,
              };
            });

            const currentProviderModels =
              settings.llmProviders[binding.providerId]?.availableModels ?? [];
            const modelOptions = currentProviderModels.map((m) => ({
              value: m,
              label: m,
            }));

            return (
              <div
                key={meta.key}
                className="rounded-2xl border border-[#EAEDF1] bg-white shadow-[0_1px_2px_rgba(31,35,41,0.03)] p-4 space-y-3.5"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 flex-wrap min-w-0">
                    <span className="text-[15px] font-semibold text-[#1F2329]">
                      {meta.title}
                    </span>
                    <span
                      className={`rounded-md px-2 py-0.5 text-[14px] ${
                        meta.thinkingActive
                          ? 'bg-[#EBF2FF] text-[#1456F0]'
                          : 'bg-[#F2F3F5] text-[#646A73]'
                      }`}
                    >
                      {meta.thinkingLabel}
                    </span>
                  </div>
                  {meta.canToggle && (
                    <Switch
                      checked={binding.enabled}
                      ariaLabel={`开启或关闭${meta.title}`}
                      onChange={(checked) =>
                        updateFeatureBinding(meta.key, { enabled: checked })
                      }
                    />
                  )}
                </div>

                {binding.enabled && (
                  <div className="space-y-2.5 pt-1 border-t border-[#F2F3F5]">
                    <div className="space-y-1.5">
                      <span className="block text-[14px] text-[#646A73]">模型供应商</span>
                      <Select
                        value={binding.providerId}
                        options={providerOptions}
                        onChange={(providerId) =>
                          updateFeatureBinding(meta.key, { providerId })
                        }
                      />
                    </div>
                    <div className="space-y-1.5">
                      <span className="block text-[14px] text-[#646A73]">调用模型</span>
                      <Select
                        value={binding.modelId}
                        options={modelOptions}
                        disabled={modelOptions.length === 0}
                        placeholder="请先在该供应商下拉取模型"
                        onChange={(modelId) => updateFeatureBinding(meta.key, { modelId })}
                      />
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      );
    }

    if (section === 'asr') {
      return (
        <div className="space-y-4">
          {/* 分组 1：语音转写供应商 */}
          <section className="space-y-2">
            <h3 className="text-[14px] font-medium text-[#646A73] px-1">语音转写引擎</h3>
            <div className="rounded-2xl border border-[#EAEDF1] bg-white shadow-[0_1px_2px_rgba(31,35,41,0.03)] overflow-hidden">
              <button
                type="button"
                onClick={() => setAsrPickerOpen(true)}
                className="w-full min-h-[68px] px-4 py-3.5 flex items-center justify-between gap-3 text-left active:bg-[#F5F6F7] transition-colors cursor-pointer"
              >
                <div className="flex items-center gap-3.5 min-w-0">
                  <div className="w-11 h-11 rounded-xl bg-[#F7F8FA] border border-[#ECEEF2] flex items-center justify-center text-[#1F2329] shrink-0">
                    <ProviderIcon
                      providerId={selectedAsr.providerId}
                      className="w-6 h-6"
                    />
                  </div>
                  <div className="min-w-0">
                    <div className="text-[16px] font-semibold text-[#1F2329] truncate">
                      {selectedAsr.name}
                    </div>
                    <div className="text-[14px] text-[#646A73] truncate mt-0.5">
                      {selectedAsr.providerId === 'builtin-free-asr'
                        ? '本地离线识别 · 免 API Key'
                        : '云端实时流式语音识别'}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0 text-[14px] text-[#1456F0] font-medium">
                  <span>切换</span>
                  <ChevronRight className="w-5 h-5 text-[#A6ABB3]" />
                </div>
              </button>
            </div>
          </section>

          {/* 分组 2：引擎状态或云端密钥配置 */}
          {selectedAsr.providerId === 'builtin-free-asr' ? (
            <section className="rounded-2xl border border-[#BEDAFF] bg-[#F0F5FF] p-4 space-y-3">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <span className="text-[15px] font-semibold text-[#1F2329]">
                  SenseVoice-Small 本地离线引擎
                </span>
                <span className="px-2.5 py-0.5 rounded-md bg-white border border-[#BEDAFF] text-[14px] font-medium text-[#1456F0]">
                  {localAsrReady ? '模型已就绪' : '首次使用自动下载'}
                </span>
              </div>
              <p className="text-[14px] leading-relaxed text-[#4E5969]">
                完全在本机运行的离线语音转写模型（支持中英混合与自动标点，首次下载约 239 MB）。不依赖云端网络、无额度限制，也无需填写任何 API Key。
              </p>
              {localAsrReady === false && (
                <button
                  type="button"
                  onClick={() => void ensureBuiltinAsrReady()}
                  className="w-full min-h-10 py-2 px-4 rounded-xl bg-[#1456F0] text-white text-[14px] font-medium hover:bg-[#3370FF] active:bg-[#0F45C9] transition-colors cursor-pointer"
                >
                  立即下载本地模型
                </button>
              )}
            </section>
          ) : (
            <section className="space-y-2">
              <h3 className="text-[14px] font-medium text-[#646A73] px-1">云端语音鉴权与模型</h3>
              <div className="rounded-2xl border border-[#EAEDF1] bg-white shadow-[0_1px_2px_rgba(31,35,41,0.03)] p-4 space-y-4">
                {selectedAsr.isCustom && (
                  <div className="space-y-2">
                    <label className="block text-[15px] font-medium text-[#1F2329]">
                      自定义语音服务地址
                    </label>
                    <input
                      type="text"
                      value={selectedAsr.baseUrl}
                      onChange={(e) =>
                        void updateSettings((prev) => ({
                          ...prev,
                          asrProviders: {
                            ...prev.asrProviders,
                            [selectedAsr.providerId]: {
                              ...prev.asrProviders[selectedAsr.providerId],
                              baseUrl: e.target.value,
                            },
                          },
                        }))
                      }
                      placeholder="wss://your-asr-server.example.com/v1/stream"
                      className="h-11 w-full rounded-xl border border-[#DEE0E3] bg-[#F8F9FA] focus:bg-white px-3.5 text-[15px] text-[#1F2329] placeholder-[#8F959E] focus:border-[#1456F0] focus:outline-none focus:ring-2 focus:ring-[#1456F0]/15"
                    />
                  </div>
                )}

                {selectedAsrPreset?.requiresAppId && (
                  <div className="space-y-2">
                    <label className="block text-[15px] font-medium text-[#1F2329]">
                      应用标识（App ID）
                    </label>
                    <input
                      type="text"
                      value={selectedAsr.appId ?? ''}
                      onChange={(e) =>
                        void updateSettings((prev) => ({
                          ...prev,
                          asrProviders: {
                            ...prev.asrProviders,
                            [selectedAsr.providerId]: {
                              ...prev.asrProviders[selectedAsr.providerId],
                              appId: e.target.value,
                            },
                          },
                        }))
                      }
                      placeholder={
                        selectedAsr.providerId === 'volcengine-asr'
                          ? '新版纯 API Key 模式可留空'
                          : '输入语音平台 App ID'
                      }
                      className="h-11 w-full rounded-xl border border-[#DEE0E3] bg-[#F8F9FA] focus:bg-white px-3.5 text-[15px] text-[#1F2329] placeholder-[#8F959E] focus:border-[#1456F0] focus:outline-none focus:ring-2 focus:ring-[#1456F0]/15"
                    />
                  </div>
                )}

                <div className="space-y-2">
                  <label className="block text-[15px] font-medium text-[#1F2329]">
                    语音服务密钥（API Key / Token）
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      type={showAsrKey ? 'text' : 'password'}
                      value={selectedAsr.apiKey}
                      onChange={(e) => {
                        const nextKey = e.target.value;
                        void updateSettings((prev) => {
                          const current = prev.asrProviders[selectedAsr.providerId];
                          const resetCatalog = !nextKey.trim() && !current.isCustom;
                          return {
                            ...prev,
                            asrProviders: {
                              ...prev.asrProviders,
                              [selectedAsr.providerId]: {
                                ...current,
                                apiKey: nextKey,
                                availableModels: resetCatalog ? [] : current.availableModels,
                                selectedModelId: resetCatalog ? '' : current.selectedModelId,
                              },
                            },
                          };
                        });
                      }}
                      placeholder={
                        selectedAsr.providerId === 'tencent-asr'
                          ? 'SecretId:SecretKey'
                          : '输入密钥后点击右侧刷新'
                      }
                      className="h-11 min-w-0 flex-1 rounded-xl border border-[#DEE0E3] bg-[#F8F9FA] focus:bg-white px-3.5 text-[15px] text-[#1F2329] placeholder-[#8F959E] focus:border-[#1456F0] focus:outline-none focus:ring-2 focus:ring-[#1456F0]/15"
                    />
                    <IconButton
                      icon={showAsrKey ? EyeOff : Eye}
                      size="lg"
                      variant="outline"
                      tooltip={showAsrKey ? '隐藏密钥' : '显示密钥'}
                      onClick={() => setShowAsrKey(!showAsrKey)}
                    />
                    <IconButton
                      icon={RefreshCw}
                      size="lg"
                      variant="primary"
                      spinning={fetchingAsr}
                      disabled={
                        (!selectedAsr.apiKey.trim() &&
                          !(selectedAsr.isCustom && selectedAsr.baseUrl.trim())) ||
                        fetchingAsr
                      }
                      tooltip="刷新语音模型列表"
                      onClick={() => void handleFetchAsrModels()}
                    />
                  </div>
                </div>

                <div className="space-y-2 pt-2 border-t border-[#F2F3F5]">
                  <div className="flex items-center justify-between gap-2">
                    <label className="block text-[15px] font-medium text-[#1F2329]">
                      语音识别模型
                    </label>
                    <span className="text-[14px] text-[#1456F0] shrink-0">
                      {selectedAsr.availableModels.length > 0
                        ? `共 ${selectedAsr.availableModels.length} 个可用`
                        : '待拉取列表'}
                    </span>
                  </div>
                  <Select
                    value={selectedAsr.selectedModelId}
                    disabled={selectedAsr.availableModels.length === 0}
                    placeholder="填写密钥并点击刷新载入语音模型"
                    options={selectedAsr.availableModels.map((m) => ({
                      value: m,
                      label: m,
                    }))}
                    onChange={(modelId) =>
                      void updateSettings((prev) => ({
                        ...prev,
                        asrProviders: {
                          ...prev.asrProviders,
                          [selectedAsr.providerId]: {
                            ...prev.asrProviders[selectedAsr.providerId],
                            selectedModelId: modelId,
                          },
                        },
                      }))
                    }
                  />
                </div>
              </div>
            </section>
          )}

          {/* 分组 3：声纹分离与语言偏好 */}
          <section className="space-y-2">
            <h3 className="text-[14px] font-medium text-[#646A73] px-1">识别偏好</h3>
            <div className="rounded-2xl border border-[#EAEDF1] bg-white shadow-[0_1px_2px_rgba(31,35,41,0.03)] divide-y divide-[#F0F2F5] overflow-hidden">
              <div className="px-4 py-3.5 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[15px] font-medium text-[#1F2329]">
                    启用讲话人识别（声纹分离）
                  </div>
                  <div className="text-[14px] text-[#646A73]">
                    自动区分老师与不同同学的发言角色
                  </div>
                </div>
                <Switch
                  checked={settings.enableSpeakerDiarization}
                  ariaLabel="启用讲话人识别"
                  onChange={(checked) =>
                    void updateSettings((prev) => ({
                      ...prev,
                      enableSpeakerDiarization: checked,
                    }))
                  }
                />
              </div>

              {settings.enableSpeakerDiarization && (
                <div className="p-4 space-y-4">
                  <div className="space-y-2">
                    <label className="block text-[15px] font-medium text-[#1F2329]">
                      课堂人数模式
                    </label>
                    <Select
                      value={settings.expectedSpeakerMode}
                      options={[
                        { value: 'auto', label: '自动检测讲话人数' },
                        { value: 'dual', label: '双人授课或师生问答' },
                        { value: 'multi', label: '多人研讨课模式' },
                      ]}
                      onChange={(val) =>
                        void updateSettings((prev) => ({
                          ...prev,
                          expectedSpeakerMode: val as typeof prev.expectedSpeakerMode,
                        }))
                      }
                    />
                  </div>

                  <div className="space-y-2">
                    <label className="block text-[15px] font-medium text-[#1F2329]">
                      识别语言偏好
                    </label>
                    <Select
                      value={settings.recognitionLanguage}
                      options={[
                        { value: 'zh-en', label: '中英混合（推荐专业课）' },
                        { value: 'zh', label: '纯中文授课' },
                        { value: 'en', label: '纯英文授课' },
                        { value: 'auto', label: '多语种自动识别' },
                      ]}
                      onChange={(val) =>
                        void updateSettings((prev) => ({
                          ...prev,
                          recognitionLanguage: val as typeof prev.recognitionLanguage,
                        }))
                      }
                    />
                  </div>
                </div>
              )}
            </div>
          </section>
        </div>
      );
    }

    // section === 'general'
    return (
      <div className="space-y-4">
        {/* 分组 1：音频采集（同时支持麦克风、系统内录与双通道混合） */}
        <section className="space-y-2">
          <h3 className="text-[14px] font-medium text-[#646A73] px-1">音频采集</h3>
          <div className="rounded-2xl border border-[#EAEDF1] bg-white shadow-[0_1px_2px_rgba(31,35,41,0.03)] divide-y divide-[#F0F2F5] overflow-hidden">
            <div className="p-4 space-y-2">
              <label className="block text-[15px] font-medium text-[#1F2329]">
                课堂音频采集模式
              </label>
              <Select
                value={settings.audioInputSource}
                options={[
                  {
                    value: 'mixed',
                    label: '双通道混合：麦克风 + 系统内录',
                  },
                  { value: 'mic-only', label: '单通道：仅麦克风输入' },
                  { value: 'system-only', label: '单通道：仅系统内录声音' },
                ]}
                onChange={(val) =>
                  void setAudioInputMode(val as typeof settings.audioInputSource)
                }
              />
            </div>

            <div className="p-4 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <span className="text-[15px] font-medium text-[#1F2329]">麦克风音频源</span>
                  <div className="text-[14px] text-[#646A73]">
                    {settings.micEnabled ? '采集人声与课堂环境音' : '当前已关闭麦克风拾音'}
                  </div>
                </div>
                <Switch
                  checked={settings.micEnabled}
                  ariaLabel="启用麦克风"
                  onChange={(checked) => void setMicChannel({ enabled: checked })}
                />
              </div>
              <Select
                value={settings.audioDeviceId || 'default'}
                options={micOptions}
                onChange={(val) => void setMicChannel({ deviceId: val })}
              />
            </div>

            <div className="p-4 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <span className="text-[15px] font-medium text-[#1F2329]">系统内录音频源</span>
                  <div className="text-[14px] text-[#646A73]">
                    {settings.systemAudioEnabled
                      ? isAndroid
                        ? '同步捕获手机网课/视频/会议媒体声音'
                        : '同步捕获系统播放声音'
                      : '当前已关闭系统声音内录'}
                  </div>
                </div>
                <Switch
                  checked={settings.systemAudioEnabled}
                  ariaLabel="启用系统内录"
                  onChange={(checked) => void setSystemChannel({ enabled: checked })}
                />
              </div>
              <Select
                value={settings.systemAudioDeviceId || 'default'}
                options={systemOptions}
                onChange={(val) => void setSystemChannel({ deviceId: val })}
              />
              {isAndroid && (
                <p className="text-[14px] text-[#646A73] leading-relaxed">
                  基于 Android 10+ 系统媒体内录，戴耳机看网课也能清晰捕获并实时转写；首次开启录制时系统将弹窗请求授权。
                </p>
              )}
            </div>

            {!isAndroid && (
              <div className="px-4 py-3.5 flex items-center justify-between gap-3">
                <div className="space-y-0.5 min-w-0">
                  <div className="text-[15px] font-medium text-[#1F2329]">
                    WebRTC AEC3 回声消除
                  </div>
                  <div className="text-[14px] text-[#646A73]">
                    {aec3Addon?.installed ? `已下载 v${aec3Addon.version}` : '未下载组件'}
                  </div>
                </div>
                <Switch
                  checked={Boolean(settings.enableWebrtcAec3 && aec3Addon?.installed)}
                  ariaLabel="开启 WebRTC AEC3 回声消除"
                  onChange={(checked) => void requestToggleWebrtcAec3(checked)}
                />
              </div>
            )}

            <div className="px-4 py-3.5 flex items-center justify-between gap-3">
              <div className="space-y-0.5 min-w-0">
                <div className="text-[15px] font-medium text-[#1F2329]">
                  双通道自动区分「我 / 老师」
                </div>
                <div className="text-[14px] text-[#646A73]">
                  按麦克风与系统内录能量占比自动标注发言身份
                </div>
              </div>
              <Switch
                checked={settings.enableDualChannelSpeakerSplit}
                ariaLabel="双通道物理声源自动区分身份"
                onChange={(checked) =>
                  void updateSettings((prev) => ({
                    ...prev,
                    enableDualChannelSpeakerSplit: checked,
                  }))
                }
              />
            </div>
          </div>

          {isAndroid && (
            <div className="rounded-2xl border border-[#BEDAFF] bg-[#F0F5FF] p-3.5 space-y-1">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <span className="text-[14px] font-semibold text-[#1F2329]">
                  Android 硬件降噪与后台录音服务
                </span>
                <span className="px-2 py-0.5 rounded-md bg-white border border-[#DCE4F7] text-[14px] font-medium text-[#1456F0] shrink-0">
                  已自动启用
                </span>
              </div>
              <p className="text-[14px] text-[#4E5969] leading-relaxed">
                麦克风通道默认开启系统硬件降噪与回声消除；切后台或锁屏期间，麦克风与系统内录均由前台服务稳定保活。
              </p>
            </div>
          )}
        </section>

        {/* 分组 2：学科热词与默认导出 */}
        <section className="space-y-2">
          <h3 className="text-[14px] font-medium text-[#646A73] px-1">热词与笔记导出</h3>
          <div className="rounded-2xl border border-[#EAEDF1] bg-white shadow-[0_1px_2px_rgba(31,35,41,0.03)] divide-y divide-[#F0F2F5] overflow-hidden">
            <div className="p-4 space-y-2">
              <label className="block text-[15px] font-medium text-[#1F2329]">
                全局通用热词表
              </label>
              <input
                type="text"
                defaultValue={settings.globalHotwords.join(', ')}
                key={`mobile-hotwords-${settingsOpen}`}
                placeholder="用逗号分隔，如：动态规划, 线段树, Transformer"
                onBlur={(e) => {
                  const parsed = e.target.value
                    .split(/[,，、;\n]+/)
                    .map((s) => s.trim())
                    .filter(Boolean);
                  void updateSettings((prev) => ({
                    ...prev,
                    globalHotwords: parsed,
                  }));
                }}
                className="w-full h-11 rounded-xl border border-[#DEE0E3] bg-[#F8F9FA] focus:bg-white px-3.5 text-[14px] text-[#1F2329] placeholder-[#8F959E] focus:outline-none focus:border-[#1456F0] focus:ring-2 focus:ring-[#1456F0]/15"
              />
              <p className="text-[14px] text-[#646A73]">
                自动注入语音识别与重点词纠错，减少专业术语误识
              </p>
            </div>

            <div className="p-4 space-y-2">
              <label className="block text-[15px] font-medium text-[#1F2329]">
                笔记默认导出格式
              </label>
              <Select
                value={settings.defaultExportFormat}
                options={[
                  { value: 'markdown', label: 'Markdown 文档 (.md)' },
                  { value: 'docx', label: 'Word 文档 (.docx)' },
                  { value: 'txt', label: '纯文本记录 (.txt)' },
                ]}
                onChange={(val) =>
                  void updateSettings((prev) => ({
                    ...prev,
                    defaultExportFormat: val as typeof prev.defaultExportFormat,
                  }))
                }
              />
            </div>
          </div>
        </section>

        {/* 分组 3：录音与存储开关 */}
        <section className="space-y-2">
          <h3 className="text-[14px] font-medium text-[#646A73] px-1">录音与存储</h3>
          <div className="rounded-2xl border border-[#EAEDF1] bg-white shadow-[0_1px_2px_rgba(31,35,41,0.03)] divide-y divide-[#F0F2F5] overflow-hidden">
            <div className="px-4 py-3.5 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[15px] font-medium text-[#1F2329]">
                  课间静音自动暂停录音（VAD）
                </div>
                <div className="text-[14px] text-[#646A73]">
                  长时间无说话声时自动暂停，节省算力与电量
                </div>
              </div>
              <Switch
                checked={settings.enableVadAutoPause}
                ariaLabel="静音自动暂停录音"
                onChange={(checked) =>
                  void updateSettings((prev) => ({
                    ...prev,
                    enableVadAutoPause: checked,
                  }))
                }
              />
            </div>

            <div className="px-4 py-3.5 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[15px] font-medium text-[#1F2329]">
                  保存本地原声录音文件
                </div>
                <div className="text-[14px] text-[#646A73]">
                  支持课后点句回放，约占 110 MB/小时；关闭仍保留文字与笔记
                </div>
              </div>
              <Switch
                checked={settings.autoSaveSession}
                ariaLabel="保存课堂本地原声录音文件"
                onChange={(checked) =>
                  void updateSettings((prev) => ({
                    ...prev,
                    autoSaveSession: checked,
                  }))
                }
              />
            </div>
          </div>
        </section>

        {/* 分组 4：关于与软件更新 */}
        <section className="space-y-2">
          <h3 className="text-[14px] font-medium text-[#646A73] px-1">关于与更新</h3>
          <div className="rounded-2xl border border-[#EAEDF1] bg-white shadow-[0_1px_2px_rgba(31,35,41,0.03)] p-4 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2.5 min-w-0">
                <div className="w-10 h-10 rounded-xl bg-[#EBF2FF] text-[#1456F0] flex items-center justify-center shrink-0">
                  <ArrowUpCircle className="w-5 h-5" />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[15px] font-semibold text-[#1F2329]">知聆课堂</span>
                    <span className="px-2 py-0.5 rounded-md bg-[#F0F5FF] border border-[#DCE4F7] text-[14px] font-medium text-[#1456F0] tabular-nums">
                      {currentVersionLabel}
                    </span>
                  </div>
                  <p className="text-[14px] text-[#646A73] truncate">
                    {appUpdate.info?.repo
                      ? `更新源：cnb.cool/${appUpdate.info.repo}`
                      : '通过 CNB 官方公开仓库检查更新'}
                  </p>
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2.5 pt-1">
              {appUpdate.info?.hasUpdate && (
                <button
                  type="button"
                  onClick={() => {
                    setSettingsOpen(false);
                    void startOneClickAppUpdate();
                  }}
                  className="flex-1 min-h-10 py-2 px-4 rounded-xl bg-[#1456F0] hover:bg-[#3370FF] text-white text-[14px] font-medium inline-flex items-center justify-center gap-1.5 whitespace-nowrap transition-colors cursor-pointer"
                >
                  <Download className="w-4 h-4 shrink-0" />
                  <span>升级至 v{appUpdate.info.latestVersion}</span>
                </button>
              )}
              <button
                type="button"
                disabled={isUpdateBusy}
                onClick={() => void checkForAppUpdates({ silent: false, force: true })}
                className={`${
                  appUpdate.info?.hasUpdate ? '' : 'w-full'
                } min-h-10 py-2 px-4 rounded-xl bg-[#F5F6F7] hover:bg-[#EBEDF0] border border-[#E5E6EB] text-[#1F2329] text-[14px] font-medium inline-flex items-center justify-center gap-1.5 whitespace-nowrap disabled:opacity-60 transition-colors cursor-pointer`}
              >
                {appUpdate.status === 'checking' ? (
                  <Loader2 className="w-4 h-4 animate-spin text-[#1456F0] shrink-0" />
                ) : (
                  <RefreshCw className="w-4 h-4 text-[#4E5969] shrink-0" />
                )}
                <span>{appUpdate.status === 'checking' ? '正在检查更新...' : '检查更新'}</span>
              </button>
            </div>

            {appUpdate.status === 'up-to-date' && appUpdate.info && (
              <p className="text-[14px] text-[#00A854]">
                当前已是最新版本（v{appUpdate.info.currentVersion}）
              </p>
            )}
            {appUpdate.status === 'error' && appUpdate.errorMessage && (
              <p className="text-[14px] text-[#D83931] break-words">{appUpdate.errorMessage}</p>
            )}
          </div>
        </section>
      </div>
    );
  };

  const activeMobileMeta = mobileSection
    ? SETTINGS_TABS.find((t) => t.key === mobileSection)
    : null;

  return (
    <>
      {useMobilePageLayout ? (
        <MobileSpringPage
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          enableSwipeBack={mobileSection === null}
          zIndexClassName="z-50"
          className="bg-[#F5F6F7]"
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={activeMobileMeta ? activeMobileMeta.label : '系统与模型设置'}
            style={
              isAndroid
                ? {
                    paddingTop: 'var(--android-safe-top, 0px)',
                    paddingBottom: 'var(--android-safe-bottom, 0px)',
                  }
                : undefined
            }
            className="h-full w-full flex flex-col"
          >
            {/* 独立手机设置页顶部导航栏（横屏自动紧凑高度） */}
            <header
              className={`${
                isShortLandscape ? 'h-12' : 'h-14'
              } px-3 bg-white border-b border-[#ECEEF2] flex items-center justify-between gap-2 shrink-0`}
            >
              <div className="flex items-center gap-1 min-w-0">
                <button
                  type="button"
                  onClick={() => handleMobileBack()}
                  aria-label={mobileSection ? '返回设置主页' : '关闭设置'}
                  className="spring-press w-10 h-10 rounded-full flex items-center justify-center text-[#1F2329] active:bg-[#F2F3F5] transition-colors cursor-pointer shrink-0"
                >
                  <ChevronLeft className="w-6 h-6" strokeWidth={2} />
                </button>
                <h2 className="text-[18px] font-semibold text-[#1F2329] truncate min-w-0">
                  {activeMobileMeta ? activeMobileMeta.label : '设置'}
                </h2>
              </div>

              {mobileSection !== null && (
                <button
                  type="button"
                  onClick={() => setSettingsOpen(false)}
                  className="spring-press px-3 py-1.5 rounded-lg text-[15px] font-medium text-[#1456F0] active:bg-[#EBF2FF] transition-colors cursor-pointer shrink-0 whitespace-nowrap"
                >
                  完成
                </button>
              )}
            </header>

            {/* 页面主体：一级分组列表 或 二级嵌套板块详情，附带顶/底橡皮筋回弹 */}
            <div
              ref={bindMobileScrollRef}
              className="flex-1 overflow-y-auto overscroll-contain-y px-4 py-4"
            >
              <div
                ref={mobileContentRef}
                key={mobileSection ?? 'root'}
                className={`max-w-2xl mx-auto pb-6 ${
                  mobileSection !== null
                    ? 'animate-mobile-page-in'
                    : mobileNavMotion === 'pop'
                      ? 'animate-mobile-root-back'
                      : ''
                }`}
              >
                {mobileSection === null ? (
                  <div className="space-y-5">
                    {/* 分组 1：AI 模型与语音 */}
                    <section className="space-y-2">
                      <h3 className="text-[14px] font-medium text-[#646A73] px-1">
                        AI 模型与语音
                      </h3>
                      <div className="rounded-2xl border border-[#EAEDF1] bg-white shadow-[0_1px_2px_rgba(31,35,41,0.03)] divide-y divide-[#F0F2F5] overflow-hidden">
                        <button
                          type="button"
                          onClick={() => openMobileSection('llm')}
                          className="w-full min-h-[68px] px-4 py-3.5 flex items-center gap-3.5 text-left active:bg-[#F5F6F7] transition-colors cursor-pointer"
                        >
                          <div className="w-10 h-10 rounded-xl bg-[#EBF2FF] text-[#1456F0] flex items-center justify-center shrink-0">
                            <Cpu className="w-5 h-5" strokeWidth={1.9} />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="text-[16px] font-medium text-[#1F2329]">
                              模型供应商
                            </div>
                            <div className="text-[14px] text-[#646A73] truncate mt-0.5">
                              {llmSummarySubtitle}
                            </div>
                          </div>
                          <ChevronRight className="w-5 h-5 text-[#A6ABB3] shrink-0" />
                        </button>

                        <button
                          type="button"
                          onClick={() => openMobileSection('routing')}
                          className="w-full min-h-[68px] px-4 py-3.5 flex items-center gap-3.5 text-left active:bg-[#F5F6F7] transition-colors cursor-pointer"
                        >
                          <div className="w-10 h-10 rounded-xl bg-[#EEF2FF] text-[#3B5BDB] flex items-center justify-center shrink-0">
                            <Workflow className="w-5 h-5" strokeWidth={1.9} />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="text-[16px] font-medium text-[#1F2329]">
                              功能模型分配
                            </div>
                            <div className="text-[14px] text-[#646A73] truncate mt-0.5">
                              {hasAnyConfiguredLlm
                                ? `已启用 ${enabledFeatureCount} / ${AI_MODULE_META_LIST.length} 项随堂 AI 能力`
                                : '未配置模型 · 自动 AI 功能未启动'}
                            </div>
                          </div>
                          <ChevronRight className="w-5 h-5 text-[#A6ABB3] shrink-0" />
                        </button>

                        <button
                          type="button"
                          onClick={() => openMobileSection('asr')}
                          className="w-full min-h-[68px] px-4 py-3.5 flex items-center gap-3.5 text-left active:bg-[#F5F6F7] transition-colors cursor-pointer"
                        >
                          <div className="w-10 h-10 rounded-xl bg-[#E8F7F0] text-[#00A854] flex items-center justify-center shrink-0">
                            <AudioLines className="w-5 h-5" strokeWidth={1.9} />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="text-[16px] font-medium text-[#1F2329]">
                              语音转写服务
                            </div>
                            <div className="text-[14px] text-[#646A73] truncate mt-0.5">
                              {asrSummarySubtitle}
                            </div>
                          </div>
                          <ChevronRight className="w-5 h-5 text-[#A6ABB3] shrink-0" />
                        </button>
                      </div>
                    </section>

                    {/* 分组 2：录音与通用 */}
                    <section className="space-y-2">
                      <h3 className="text-[14px] font-medium text-[#646A73] px-1">
                        录音与通用
                      </h3>
                      <div className="rounded-2xl border border-[#EAEDF1] bg-white shadow-[0_1px_2px_rgba(31,35,41,0.03)] overflow-hidden">
                        <button
                          type="button"
                          onClick={() => openMobileSection('general')}
                          className="w-full min-h-[68px] px-4 py-3.5 flex items-center gap-3.5 text-left active:bg-[#F5F6F7] transition-colors cursor-pointer"
                        >
                          <div className="w-10 h-10 rounded-xl bg-[#FFF4E5] text-[#D97706] flex items-center justify-center shrink-0">
                            <SlidersHorizontal className="w-5 h-5" strokeWidth={1.9} />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="text-[16px] font-medium text-[#1F2329]">
                              音频与常规
                            </div>
                            <div className="text-[14px] text-[#646A73] truncate mt-0.5">
                              {generalSummarySubtitle}
                            </div>
                          </div>
                          <ChevronRight className="w-5 h-5 text-[#A6ABB3] shrink-0" />
                        </button>
                      </div>
                    </section>

                    {/* 分组 3：关于知聆课堂（快速版本检查入口） */}
                    <section className="space-y-2">
                      <h3 className="text-[14px] font-medium text-[#646A73] px-1">关于</h3>
                      <div className="rounded-2xl border border-[#EAEDF1] bg-white shadow-[0_1px_2px_rgba(31,35,41,0.03)] p-4 space-y-3">
                        <div className="flex items-center justify-between gap-2.5">
                          <div className="flex items-center gap-3 min-w-0 flex-1">
                            <div className="w-10 h-10 rounded-xl bg-[#EBF2FF] text-[#1456F0] flex items-center justify-center shrink-0">
                              <ArrowUpCircle className="w-5 h-5" strokeWidth={1.9} />
                            </div>
                            <div className="min-w-0">
                              <div className="text-[16px] font-semibold text-[#1F2329] whitespace-nowrap">
                                知聆课堂
                              </div>
                              <div className="text-[14px] font-medium text-[#1456F0] tabular-nums whitespace-nowrap mt-0.5">
                                {currentVersionLabel}
                              </div>
                            </div>
                          </div>

                          {appUpdate.info?.hasUpdate ? (
                            <button
                              type="button"
                              onClick={() => {
                                setSettingsOpen(false);
                                void startOneClickAppUpdate();
                              }}
                              className="spring-press min-h-9 px-3 py-1.5 rounded-xl bg-[#1456F0] hover:bg-[#3370FF] text-white text-[14px] font-medium inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
                            >
                              <Download className="w-4 h-4 shrink-0" />
                              <span>立即更新</span>
                            </button>
                          ) : (
                            <button
                              type="button"
                              disabled={isUpdateBusy}
                              onClick={() =>
                                void checkForAppUpdates({ silent: false, force: true })
                              }
                              className="spring-press min-h-9 px-3 py-1.5 rounded-xl bg-[#F5F6F7] hover:bg-[#EBEDF0] border border-[#E5E6EB] text-[#1F2329] text-[14px] font-medium inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 disabled:opacity-60 cursor-pointer"
                            >
                              {appUpdate.status === 'checking' ? (
                                <Loader2 className="w-4 h-4 animate-spin text-[#1456F0] shrink-0" />
                              ) : (
                                <RefreshCw className="w-4 h-4 text-[#4E5969] shrink-0" />
                              )}
                              <span>{appUpdate.status === 'checking' ? '检查中' : '检查更新'}</span>
                            </button>
                          )}
                        </div>

                        <div className="pt-2.5 border-t border-[#F0F2F5] flex items-center justify-between gap-2 text-[14px]">
                          <span className="text-[#646A73] whitespace-nowrap shrink-0">更新状态</span>
                          <span
                            className={`truncate ${
                              appUpdate.info?.hasUpdate
                                ? 'text-[#1456F0] font-medium'
                                : 'text-[#4E5969]'
                            }`}
                          >
                            {appUpdate.info?.hasUpdate
                              ? `发现新版本 v${appUpdate.info.latestVersion}`
                              : appUpdate.status === 'up-to-date'
                                ? '当前已是最新版本'
                                : 'CNB 官方更新通道'}
                          </span>
                        </div>

                        {appUpdate.status === 'error' && appUpdate.errorMessage && (
                          <p className="text-[14px] text-[#D83931] break-words">
                            {appUpdate.errorMessage}
                          </p>
                        )}
                      </div>
                    </section>
                  </div>
                ) : (
                  renderMobileSubpageContent(mobileSection)
                )}
              </div>
            </div>
          </div>
        </MobileSpringPage>
      ) : (
        <Modal
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          title="系统与模型设置"
          widthClass="max-w-4xl"
        >
          <div className="flex flex-col md:flex-row min-h-[min(480px,70vh)] md:min-h-[min(520px,74vh)] max-h-[84vh] md:max-h-[78vh]">
            {/* 桌面端左侧分类栏 */}
            <aside className="w-full md:w-52 shrink-0 border-b md:border-b-0 md:border-r border-[#ECEEF2] bg-[#F5F6F7]/70 p-2.5 md:p-3 flex md:block items-center gap-1.5 md:space-y-1 overflow-x-auto no-scrollbar">
              {SETTINGS_TABS.map((tab) => {
                const Icon = tab.icon;
                const active = activeTab === tab.key;
                return (
                  <button
                    key={tab.key}
                    type="button"
                    onClick={() => setActiveTab(tab.key)}
                    className={`shrink-0 md:w-full flex items-center gap-2 md:gap-2.5 rounded-lg px-3 md:px-3.5 py-2 md:py-2.5 text-[14px] md:text-[15px] transition-colors cursor-pointer whitespace-nowrap ${
                      active
                        ? 'bg-[#EBF2FF] text-[#1456F0] font-medium'
                        : 'text-[#4E5969] hover:bg-[#ECEEF2]/80 hover:text-[#1F2329]'
                    }`}
                  >
                    <Icon
                      className={`w-[17px] h-[17px] md:w-[18px] md:h-[18px] shrink-0 ${
                        active ? 'text-[#1456F0]' : 'text-[#4E5969]'
                      }`}
                      strokeWidth={1.85}
                    />
                    <span>{tab.label}</span>
                  </button>
                );
              })}
            </aside>

            {/* 桌面端设置详情区 */}
            <div className="flex-1 overflow-y-auto p-4 md:p-6 space-y-5 md:space-y-6 bg-white">
              {/* ==================== Tab 1: 大模型供应商 ==================== */}
              {activeTab === 'llm' && (
                <div className="space-y-6">
                  {/* 当前供应商卡片：点击弹出方格选择菜单 */}
                  <div className="space-y-2.5">
                    <div className="text-[15px] font-medium text-[#1F2329]">
                      当前模型供应商
                    </div>
                    <div className="rounded-xl border border-[#DEE0E3] hover:border-[#3370FF] bg-[#F5F6F7]/50 hover:bg-[#F0F4FF]/40 px-4 py-3 flex items-center justify-between gap-3 transition-all">
                      <button
                        type="button"
                        onClick={() => setLlmPickerOpen(true)}
                        className="flex-1 min-w-0 flex items-center justify-between gap-3 cursor-pointer text-left"
                      >
                        <div className="flex items-center gap-3.5 min-w-0">
                          <div className="w-11 h-11 rounded-xl bg-white border border-[#ECEEF2] flex items-center justify-center text-[#1F2329] shrink-0">
                            <ProviderIcon
                              providerId={selectedLlm.providerId}
                              className="w-6 h-6"
                            />
                          </div>
                          <div className="text-left min-w-0">
                            <div className="text-[16px] font-semibold text-[#1F2329] truncate">
                              {selectedLlm.name}
                            </div>
                            <div className="text-[14px] text-[#4E5969] truncate">
                              {protocolLabel}
                            </div>
                          </div>
                        </div>
                      </button>

                      <div className="flex items-center gap-2 shrink-0">
                        {!selectedLlm.isCustom && (
                          <IconButton
                            icon={Link2}
                            size="md"
                            variant={showCustomProxyOverride ? 'active' : 'outline'}
                            tooltip="自定义代理地址（可选）"
                            onClick={() =>
                              setShowCustomProxyOverride(!showCustomProxyOverride)
                            }
                          />
                        )}
                        <IconButton
                          icon={LayoutGrid}
                          size="md"
                          variant="outline"
                          tooltip="切换大模型供应商"
                          onClick={() => setLlmPickerOpen(true)}
                          className="text-[#1456F0]"
                        />
                      </div>
                    </div>
                  </div>

                  {/* 仅在“自定义接口”下展示底层协议选择与端点地址；预设供应商默认免填端点 */}
                  {selectedLlm.isCustom && (
                    <div className="space-y-4 rounded-xl border border-[#ECEEF2] bg-[#F5F6F7]/50 p-4">
                      <div className="space-y-2">
                        <label className="block text-[15px] font-medium text-[#1F2329]">
                          通信协议类型
                        </label>
                        <Select
                          value={selectedLlm.protocol}
                          options={API_PROTOCOL_OPTIONS}
                          onChange={(val) =>
                            void updateSettings((prev) => ({
                              ...prev,
                              llmProviders: {
                                ...prev.llmProviders,
                                [selectedLlm.providerId]: {
                                  ...prev.llmProviders[selectedLlm.providerId],
                                  protocol: val as ApiProtocol,
                                },
                              },
                            }))
                          }
                        />
                      </div>

                      <div className="space-y-2">
                        <label className="block text-[15px] font-medium text-[#1F2329]">
                          接口端点地址（Base URL）
                        </label>
                        <input
                          type="url"
                          value={selectedLlm.baseUrl}
                          onChange={(e) =>
                            void updateSettings((prev) => ({
                              ...prev,
                              llmProviders: {
                                ...prev.llmProviders,
                                [selectedLlm.providerId]: {
                                  ...prev.llmProviders[selectedLlm.providerId],
                                  baseUrl: e.target.value,
                                },
                              },
                            }))
                          }
                          placeholder="https://your-gateway.example.com/v1"
                          className="h-10 w-full rounded-lg border border-[#DEE0E3] bg-white px-3.5 text-[15px] text-[#1F2329] placeholder-[#646A73] focus:border-[#1456F0] focus:outline-none focus:ring-2 focus:ring-[#1456F0]/15"
                        />
                      </div>
                    </div>
                  )}

                  {!selectedLlm.isCustom && showCustomProxyOverride && (
                    <div className="space-y-2">
                      <label className="block text-[15px] font-medium text-[#1F2329]">
                        代理端点覆盖地址
                      </label>
                      <input
                        type="url"
                        value={selectedLlm.baseUrl}
                        onChange={(e) =>
                          void updateSettings((prev) => ({
                            ...prev,
                            llmProviders: {
                              ...prev.llmProviders,
                              [selectedLlm.providerId]: {
                                ...prev.llmProviders[selectedLlm.providerId],
                                baseUrl: e.target.value,
                              },
                            },
                          }))
                        }
                        className="h-10 w-full rounded-lg border border-[#DEE0E3] bg-white px-3.5 text-[15px] text-[#1F2329] focus:border-[#1456F0] focus:outline-none focus:ring-2 focus:ring-[#1456F0]/15"
                      />
                    </div>
                  )}

                  <div className="space-y-2.5">
                    <label className="block text-[15px] font-medium text-[#1F2329]">
                      API 密钥（API Key）
                    </label>
                    <div className="flex items-center gap-2">
                      <input
                        type={showLlmKey ? 'text' : 'password'}
                        value={selectedLlm.apiKey}
                        onChange={(e) => {
                          const nextKey = e.target.value;
                          void updateSettings((prev) => {
                            const current = prev.llmProviders[selectedLlm.providerId];
                            const resetCatalog = !nextKey.trim() && !current.isCustom;
                            return {
                              ...prev,
                              llmProviders: {
                                ...prev.llmProviders,
                                [selectedLlm.providerId]: {
                                  ...current,
                                  apiKey: nextKey,
                                  availableModels: resetCatalog ? [] : current.availableModels,
                                  lastFetchedAt: resetCatalog ? undefined : current.lastFetchedAt,
                                },
                              },
                            };
                          });
                        }}
                        placeholder="输入 API Key 后点击右侧刷新图标获取可用模型列表"
                        className="h-10 min-w-0 flex-1 rounded-lg border border-[#DEE0E3] bg-white px-3.5 text-[15px] text-[#1F2329] placeholder-[#646A73] focus:border-[#1456F0] focus:outline-none focus:ring-2 focus:ring-[#1456F0]/15"
                      />
                      <IconButton
                        icon={showLlmKey ? EyeOff : Eye}
                        size="lg"
                        variant="outline"
                        tooltip={showLlmKey ? '隐藏密钥' : '显示密钥'}
                        onClick={() => setShowLlmKey(!showLlmKey)}
                      />
                      <IconButton
                        icon={RefreshCw}
                        size="lg"
                        variant="primary"
                        spinning={fetchingLlm}
                        disabled={
                          (!selectedLlm.apiKey.trim() &&
                            !(selectedLlm.isCustom && selectedLlm.baseUrl.trim())) ||
                          fetchingLlm
                        }
                        tooltip="获取模型 ID 列表"
                        onClick={() => void handleFetchLlmModels()}
                      />
                    </div>
                  </div>

                  {/* 已拉取模型列表预览下拉框 */}
                  <div className="space-y-2.5">
                    <div className="flex items-center justify-between">
                      <span className="text-[15px] font-medium text-[#1F2329]">
                        已获取模型列表
                      </span>
                      <div className="flex items-center gap-2">
                        <span className="text-[14px] text-[#1456F0]">
                          {selectedLlm.availableModels.length > 0
                            ? `共 ${selectedLlm.availableModels.length} 个模型可用`
                            : '待拉取模型列表'}
                        </span>
                      </div>
                    </div>
                    <Select
                      value={previewLlmModel}
                      disabled={selectedLlm.availableModels.length === 0}
                      placeholder="填写密钥并点击刷新获取模型列表"
                      options={selectedLlm.availableModels.map((m) => ({
                        value: m,
                        label: m,
                      }))}
                      onChange={(modelId) => {
                        setPreviewLlmModel(modelId);
                      }}
                    />
                  </div>
                </div>
              )}

              {/* ==================== Tab 2: 各功能模型独立分配与开关 ==================== */}
              {activeTab === 'routing' && (
                <div className="space-y-4">
                  {!hasAnyConfiguredLlm && (
                    <div className="rounded-xl border border-[#BEDAFF] bg-[#F5F8FF] p-4 flex items-start justify-between gap-4">
                      <div className="space-y-1 min-w-0">
                        <div className="text-[15px] font-semibold text-[#1456F0]">
                          未配置大模型，自动 AI 功能默认不启动
                        </div>
                        <p className="text-[14px] text-[#4E5969] leading-relaxed">
                          本地离线语音转写可直接使用。如需使用课堂问答、去语气词、自动分段、重点词高亮或深度解析，请先在「模型供应商」中配置 API Key 并拉取模型列表。
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => setActiveTab('llm')}
                        className="min-h-9 px-3.5 py-1.5 rounded-lg bg-[#1456F0] hover:bg-[#3370FF] text-white text-[14px] font-medium whitespace-nowrap shrink-0 transition-colors cursor-pointer"
                      >
                        前往配置
                      </button>
                    </div>
                  )}
                  {AI_MODULE_META_LIST.map((meta) => {
                    const binding = settings.featureRouting[meta.key];
                    const providerOptions = LLM_PROVIDER_PRESETS.map((p) => {
                      const cfg = settings.llmProviders[p.id];
                      return {
                        value: p.id,
                        label: cfg?.name ?? p.name,
                        icon: <ProviderIcon providerId={p.id} className="w-4 h-4" />,
                      };
                    });

                    const currentProviderModels =
                      settings.llmProviders[binding.providerId]?.availableModels ?? [];
                    const modelOptions = currentProviderModels.map((m) => ({
                      value: m,
                      label: m,
                    }));

                    return (
                      <div
                        key={meta.key}
                        className="rounded-xl border border-[#DEE0E3] bg-[#F5F6F7]/45 p-4 space-y-3.5"
                      >
                        <div className="flex items-center justify-between gap-4">
                          <div className="flex items-center gap-2.5 flex-wrap">
                            <span className="text-[15px] font-semibold text-[#1F2329]">
                              {meta.title}
                            </span>
                            <span
                              className={`rounded-md px-2 py-0.5 text-[14px] ${
                                meta.thinkingActive
                                  ? 'bg-[#EBF2FF] text-[#1456F0]'
                                  : 'bg-[#ECEEF2] text-[#646A73]'
                              }`}
                            >
                              {meta.thinkingLabel}
                            </span>
                          </div>
                          {meta.canToggle && (
                            <Switch
                              checked={binding.enabled}
                              ariaLabel={`开启或关闭${meta.title}`}
                              onChange={(checked) =>
                                updateFeatureBinding(meta.key, { enabled: checked })
                              }
                            />
                          )}
                        </div>

                        {binding.enabled && (
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            <Select
                              value={binding.providerId}
                              options={providerOptions}
                              onChange={(providerId) =>
                                updateFeatureBinding(meta.key, { providerId })
                              }
                            />
                            <Select
                              value={binding.modelId}
                              options={modelOptions}
                              disabled={modelOptions.length === 0}
                              placeholder="请先在该供应商下拉取模型"
                              onChange={(modelId) =>
                                updateFeatureBinding(meta.key, { modelId })
                              }
                            />
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* ==================== Tab 3: 语音转写与声纹识别 ==================== */}
              {activeTab === 'asr' && (
                <div className="space-y-6">
                  <div className="space-y-2.5">
                    <div className="text-[15px] font-medium text-[#1F2329]">
                      语音转写供应商
                    </div>
                    <button
                      type="button"
                      onClick={() => setAsrPickerOpen(true)}
                      className="w-full rounded-xl border border-[#DEE0E3] hover:border-[#3370FF] bg-[#F5F6F7]/50 hover:bg-[#F0F4FF]/40 px-4 py-3.5 flex items-center justify-between transition-all cursor-pointer"
                    >
                      <div className="flex items-center gap-3.5">
                        <div className="w-11 h-11 rounded-xl bg-white border border-[#ECEEF2] flex items-center justify-center text-[#1F2329]">
                          <ProviderIcon
                            providerId={selectedAsr.providerId}
                            className="w-6 h-6"
                          />
                        </div>
                        <div className="text-left">
                          <div className="text-[16px] font-semibold text-[#1F2329]">
                            {selectedAsr.name}
                          </div>
                          <div className="text-[14px] text-[#4E5969]">
                            {selectedAsr.providerId === 'builtin-free-asr'
                              ? '纯本地离线语音识别 · 首次使用下载模型 · 无需 API Key'
                              : '实时流式语音识别与角色分离'}
                          </div>
                        </div>
                      </div>

                      <div className="w-9 h-9 rounded-lg bg-white border border-[#DEE0E3] flex items-center justify-center text-[#1456F0]">
                        <LayoutGrid className="w-[18px] h-[18px]" strokeWidth={1.85} />
                      </div>
                    </button>
                  </div>

                  {selectedAsr.providerId === 'builtin-free-asr' ? (
                    <div className="rounded-xl border border-[#BEDAFF] bg-[#F0F4FF]/70 p-4 space-y-3">
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-[15px] font-semibold text-[#1F2329]">
                            SenseVoice-Small 本地离线引擎
                          </span>
                          <span className="px-2 py-0.5 rounded-md bg-[#EBF2FF] border border-[#BEDAFF] text-[14px] font-medium text-[#1456F0]">
                            {localAsrReady ? '模型已就绪' : '首次使用自动下载'}
                          </span>
                        </div>
                        {localAsrReady === false && (
                          <button
                            type="button"
                            onClick={() => void ensureBuiltinAsrReady()}
                            className="h-9 px-3.5 rounded-lg bg-[#1456F0] text-white text-[14px] font-medium hover:bg-[#3370FF] transition-colors cursor-pointer"
                          >
                            立即下载模型
                          </button>
                        )}
                      </div>
                      <p className="text-[14px] leading-relaxed text-[#4E5969]">
                        完全在本机运行的离线语音转写模型（支持中文、英文、中英混合与自动标点，首次下载约 239 MB）。不依赖云端网络、无额度限制，也无需填写任何 API Key。
                      </p>
                    </div>
                  ) : (
                    <>
                      {selectedAsr.isCustom && (
                        <div className="space-y-2">
                          <label className="block text-[15px] font-medium text-[#1F2329]">
                            自定义语音服务地址（WebSocket / HTTP）
                          </label>
                          <input
                            type="text"
                            value={selectedAsr.baseUrl}
                            onChange={(e) =>
                              void updateSettings((prev) => ({
                                ...prev,
                                asrProviders: {
                                  ...prev.asrProviders,
                                  [selectedAsr.providerId]: {
                                    ...prev.asrProviders[selectedAsr.providerId],
                                    baseUrl: e.target.value,
                                  },
                                },
                              }))
                            }
                            placeholder="wss://your-asr-server.example.com/v1/stream"
                            className="h-10 w-full rounded-lg border border-[#DEE0E3] bg-white px-3.5 text-[15px] text-[#1F2329] placeholder-[#646A73] focus:border-[#1456F0] focus:outline-none focus:ring-2 focus:ring-[#1456F0]/15"
                          />
                        </div>
                      )}

                      {selectedAsrPreset?.requiresAppId && (
                        <div className="space-y-2">
                          <label className="block text-[15px] font-medium text-[#1F2329]">
                            应用标识（App ID）
                          </label>
                          <input
                            type="text"
                            value={selectedAsr.appId ?? ''}
                            onChange={(e) =>
                              void updateSettings((prev) => ({
                                ...prev,
                                asrProviders: {
                                  ...prev.asrProviders,
                                  [selectedAsr.providerId]: {
                                    ...prev.asrProviders[selectedAsr.providerId],
                                    appId: e.target.value,
                                  },
                                },
                              }))
                            }
                            placeholder={
                              selectedAsr.providerId === 'volcengine-asr'
                                ? '输入 App ID（新版控制台纯 API Key 模式可留空）'
                                : '输入语音平台分配的 App ID'
                            }
                            className="h-10 w-full rounded-lg border border-[#DEE0E3] bg-white px-3.5 text-[15px] text-[#1F2329] placeholder-[#646A73] focus:border-[#1456F0] focus:outline-none focus:ring-2 focus:ring-[#1456F0]/15"
                          />
                        </div>
                      )}

                      <div className="space-y-2">
                        <label className="block text-[15px] font-medium text-[#1F2329]">
                          语音服务密钥（API Key / Token）
                        </label>
                        <div className="flex items-center gap-2">
                          <input
                            type={showAsrKey ? 'text' : 'password'}
                            value={selectedAsr.apiKey}
                            onChange={(e) => {
                              const nextKey = e.target.value;
                              void updateSettings((prev) => {
                                const current = prev.asrProviders[selectedAsr.providerId];
                                const resetCatalog = !nextKey.trim() && !current.isCustom;
                                return {
                                  ...prev,
                                  asrProviders: {
                                    ...prev.asrProviders,
                                    [selectedAsr.providerId]: {
                                      ...current,
                                      apiKey: nextKey,
                                      availableModels: resetCatalog
                                        ? []
                                        : current.availableModels,
                                      selectedModelId: resetCatalog
                                        ? ''
                                        : current.selectedModelId,
                                    },
                                  },
                                };
                              });
                            }}
                            placeholder={
                              selectedAsr.providerId === 'tencent-asr'
                                ? '输入 SecretId:SecretKey 后点击右侧刷新图标'
                                : '输入语音服务密钥后点击右侧刷新图标获取模型'
                            }
                            className="h-10 min-w-0 flex-1 rounded-lg border border-[#DEE0E3] bg-white px-3.5 text-[15px] text-[#1F2329] placeholder-[#646A73] focus:border-[#1456F0] focus:outline-none focus:ring-2 focus:ring-[#1456F0]/15"
                          />
                          <IconButton
                            icon={showAsrKey ? EyeOff : Eye}
                            size="lg"
                            variant="outline"
                            tooltip={showAsrKey ? '隐藏密钥' : '显示密钥'}
                            onClick={() => setShowAsrKey(!showAsrKey)}
                          />
                          <IconButton
                            icon={RefreshCw}
                            size="lg"
                            variant="primary"
                            spinning={fetchingAsr}
                            disabled={
                              (!selectedAsr.apiKey.trim() &&
                                !(selectedAsr.isCustom && selectedAsr.baseUrl.trim())) ||
                              fetchingAsr
                            }
                            tooltip="刷新语音模型列表"
                            onClick={() => void handleFetchAsrModels()}
                          />
                        </div>
                      </div>

                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <label className="block text-[15px] font-medium text-[#1F2329]">
                            语音识别模型
                          </label>
                          <span className="text-[14px] text-[#1456F0]">
                            {selectedAsr.availableModels.length > 0
                              ? `共 ${selectedAsr.availableModels.length} 个模型可用`
                              : '待拉取模型列表'}
                          </span>
                        </div>
                        <Select
                          value={selectedAsr.selectedModelId}
                          disabled={selectedAsr.availableModels.length === 0}
                          placeholder="填写密钥并点击右上刷新图标后自动载入语音模型列表"
                          options={selectedAsr.availableModels.map((m) => ({
                            value: m,
                            label: m,
                          }))}
                          onChange={(modelId) =>
                            void updateSettings((prev) => ({
                              ...prev,
                              asrProviders: {
                                ...prev.asrProviders,
                                [selectedAsr.providerId]: {
                                  ...prev.asrProviders[selectedAsr.providerId],
                                  selectedModelId: modelId,
                                },
                              },
                            }))
                          }
                        />
                      </div>
                    </>
                  )}

                  <div className="border-t border-[#ECEEF2] pt-5 space-y-4">
                    <div className="flex items-center justify-between">
                      <span className="text-[15px] font-medium text-[#1F2329]">
                        启用讲话人识别（声纹分离）
                      </span>
                      <Switch
                        checked={settings.enableSpeakerDiarization}
                        ariaLabel="启用讲话人识别"
                        onChange={(checked) =>
                          void updateSettings((prev) => ({
                            ...prev,
                            enableSpeakerDiarization: checked,
                          }))
                        }
                      />
                    </div>

                    {settings.enableSpeakerDiarization && (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <label className="block text-[15px] font-medium text-[#1F2329]">
                            课堂人数模式
                          </label>
                          <Select
                            value={settings.expectedSpeakerMode}
                            options={[
                              { value: 'auto', label: '自动检测讲话人数' },
                              { value: 'dual', label: '双人授课或师生问答' },
                              { value: 'multi', label: '多人研讨课模式' },
                            ]}
                            onChange={(val) =>
                              void updateSettings((prev) => ({
                                ...prev,
                                expectedSpeakerMode:
                                  val as typeof prev.expectedSpeakerMode,
                              }))
                            }
                          />
                        </div>

                        <div className="space-y-2">
                          <label className="block text-[15px] font-medium text-[#1F2329]">
                            识别语言偏好
                          </label>
                          <Select
                            value={settings.recognitionLanguage}
                            options={[
                              { value: 'zh-en', label: '中英混合（推荐专业课）' },
                              { value: 'zh', label: '纯中文授课' },
                              { value: 'en', label: '纯英文授课' },
                              { value: 'auto', label: '多语种自动识别' },
                            ]}
                            onChange={(val) =>
                              void updateSettings((prev) => ({
                                ...prev,
                                recognitionLanguage:
                                  val as typeof prev.recognitionLanguage,
                              }))
                            }
                          />
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* ==================== Tab 4: 音频输入与常规选项 ==================== */}
              {activeTab === 'general' && (
                <div className="space-y-5">
                  <div className="space-y-2">
                    <label className="block text-[15px] font-medium text-[#1F2329]">
                      课堂音频采集模式
                    </label>
                    <Select
                      value={settings.audioInputSource}
                      options={[
                        {
                          value: 'mixed',
                          label: '双通道混合：麦克风 + 系统内录（网课与双讲推荐）',
                        },
                        { value: 'mic-only', label: '单通道：仅麦克风输入（线下教室推荐）' },
                        { value: 'system-only', label: '单通道：仅系统内录声音' },
                      ]}
                      onChange={(val) =>
                        void setAudioInputMode(val as typeof settings.audioInputSource)
                      }
                    />
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="rounded-xl border border-[#DEE0E3] bg-[#F8F9FA] p-4 space-y-3">
                      <div className="flex items-center justify-between">
                        <span className="text-[15px] font-medium text-[#1F2329]">
                          麦克风音频源
                        </span>
                        <Switch
                          checked={settings.micEnabled}
                          ariaLabel="启用麦克风"
                          onChange={(checked) => void setMicChannel({ enabled: checked })}
                        />
                      </div>
                      <Select
                        value={settings.audioDeviceId || 'default'}
                        options={micOptions}
                        onChange={(val) => void setMicChannel({ deviceId: val })}
                      />
                    </div>

                    <div className="rounded-xl border border-[#DEE0E3] bg-[#F8F9FA] p-4 space-y-3">
                      <div className="flex items-center justify-between">
                        <span className="text-[15px] font-medium text-[#1F2329]">
                          系统内录音频源
                        </span>
                        <Switch
                          checked={settings.systemAudioEnabled}
                          ariaLabel="启用系统内录"
                          onChange={(checked) => void setSystemChannel({ enabled: checked })}
                        />
                      </div>
                      <Select
                        value={settings.systemAudioDeviceId || 'default'}
                        options={systemOptions}
                        onChange={(val) => void setSystemChannel({ deviceId: val })}
                      />
                    </div>
                  </div>

                  {/* 双讲回声消除（WebRTC AEC3）设置卡片 */}
                  <div className="rounded-xl border border-[#DEE0E3] bg-white p-4 flex items-center justify-between gap-4">
                    <div className="space-y-1 min-w-0">
                      <div className="flex items-center gap-2.5 flex-wrap">
                        <span className="text-[15px] font-medium text-[#1F2329]">
                          剔除回声（WebRTC AEC3 双讲模式）
                        </span>
                        <span
                          className={`px-2.5 py-0.5 rounded-md text-[14px] font-medium ${
                            aec3Addon?.installed
                              ? 'bg-[#EBF2FF] text-[#1456F0]'
                              : 'bg-[#F2F3F5] text-[#646A73]'
                          }`}
                        >
                          {aec3Addon?.installed
                            ? `已下载 v${aec3Addon.version}`
                            : '未下载组件'}
                        </span>
                      </div>
                      <p className="text-[14px] text-[#646A73]">
                        在双通道模式下以系统内录作为参考流，实时消除扬声器外放串入麦克风的回声。开启时若尚未安装将弹窗提示下载。
                      </p>
                    </div>
                    <Switch
                      checked={Boolean(settings.enableWebrtcAec3 && aec3Addon?.installed)}
                      ariaLabel="开启 WebRTC AEC3 回声消除"
                      onChange={(checked) => void requestToggleWebrtcAec3(checked)}
                    />
                  </div>

                  {/* 双通道物理声源自动身份分离卡片 */}
                  <div className="rounded-xl border border-[#DEE0E3] bg-white p-4 flex items-center justify-between gap-4">
                    <div className="space-y-1 min-w-0">
                      <span className="text-[15px] font-medium text-[#1F2329]">
                        双通道物理声源自动区分「我 / 课堂老师」
                      </span>
                      <p className="text-[14px] text-[#646A73]">
                        在双通道录音下根据麦克风与系统内录实时能量占比，自动将发言标记为「我（麦克风）」与「课堂老师（内录）」。
                      </p>
                    </div>
                    <Switch
                      checked={settings.enableDualChannelSpeakerSplit}
                      ariaLabel="双通道物理声源自动区分身份"
                      onChange={(checked) =>
                        void updateSettings((prev) => ({
                          ...prev,
                          enableDualChannelSpeakerSplit: checked,
                        }))
                      }
                    />
                  </div>

                  {/* 全局通用学科热词 */}
                  <div className="space-y-2">
                    <label className="block text-[15px] font-medium text-[#1F2329]">
                      全局通用热词表（以逗号分隔，特定科目热词可右键对应文件夹配置）
                    </label>
                    <input
                      type="text"
                      defaultValue={settings.globalHotwords.join(', ')}
                      key={`hotwords-${settingsOpen}`}
                      placeholder="例如：动态规划, 线段树, 拉格朗日乘子, Transformer"
                      onBlur={(e) => {
                        const parsed = e.target.value
                          .split(/[,，、;\n]+/)
                          .map((s) => s.trim())
                          .filter(Boolean);
                        void updateSettings((prev) => ({
                          ...prev,
                          globalHotwords: parsed,
                        }));
                      }}
                      className="w-full h-10 rounded-lg border border-[#DEE0E3] bg-white px-3 text-[14px] text-[#1F2329] focus:outline-none focus:border-[#1456F0]"
                    />
                  </div>

                  {/* 跨平台桌面全局快捷键配置 */}
                  <div className="rounded-xl border border-[#DEE0E3] bg-[#F8F9FA] p-4 space-y-3.5">
                    <div className="flex items-center justify-between gap-3">
                      <div className="space-y-0.5 min-w-0">
                        <span className="text-[15px] font-medium text-[#1F2329]">
                          {isMac ? 'macOS 全局后台快捷键' : 'Windows 全局后台快捷键'}
                        </span>
                        <p className="text-[14px] text-[#646A73]">
                          全屏看网课或写代码时无需切回窗口，直接触发截图、打书签与置顶字幕窗（点击快捷键框后直接按键即可录制）
                        </p>
                      </div>
                      <div className="flex items-center gap-2.5 shrink-0">
                        {settings.desktopHotkeys.enabled && (
                          <button
                            type="button"
                            onClick={() => {
                              const defaults = getDefaultDesktopHotkeys();
                              setRecordingHotkeyKey(null);
                              void updateSettings((prev) => ({
                                ...prev,
                                desktopHotkeys: {
                                  ...defaults,
                                  enabled: prev.desktopHotkeys.enabled,
                                },
                              }));
                            }}
                            className="h-8 px-2.5 rounded-lg border border-[#DEE0E3] bg-white hover:bg-[#F2F3F5] text-[14px] text-[#4E5969] transition-colors cursor-pointer"
                          >
                            恢复默认
                          </button>
                        )}
                        <Switch
                          checked={settings.desktopHotkeys.enabled}
                          ariaLabel={
                            isMac ? '启用 macOS 全局快捷键' : '启用 Windows 全局快捷键'
                          }
                          onChange={(checked) => {
                            setRecordingHotkeyKey(null);
                            void updateSettings((prev) => ({
                              ...prev,
                              desktopHotkeys: { ...prev.desktopHotkeys, enabled: checked },
                            }));
                          }}
                        />
                      </div>
                    </div>

                    {settings.desktopHotkeys.enabled && (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 pt-1">
                        {(
                          [
                            { key: 'toggleRecording', label: '暂停 / 继续录音' },
                            { key: 'toggleMicMute', label: '麦克风静音切换' },
                            { key: 'captureScreenshot', label: '抓拍屏幕入时间轴' },
                            { key: 'bookmarkConfused', label: '标记此处没听懂' },
                            { key: 'toggleMiniOverlay', label: '打开置顶迷你字幕窗' },
                          ] as const
                        ).map((hk) => {
                          const isCapturing = recordingHotkeyKey === hk.key;
                          const displayCombo = formatShortcutLabel(
                            settings.desktopHotkeys[hk.key]
                          );
                          return (
                            <div
                              key={hk.key}
                              className="flex items-center justify-between gap-2 rounded-lg border border-[#DEE0E3] bg-white px-3 py-2"
                            >
                              <span className="text-[14px] text-[#4E5969]">{hk.label}</span>
                              <button
                                type="button"
                                onClick={() =>
                                  setRecordingHotkeyKey(isCapturing ? null : hk.key)
                                }
                                onBlur={() => {
                                  if (isCapturing) setRecordingHotkeyKey(null);
                                }}
                                onKeyDown={(e) => {
                                  if (!isCapturing) return;
                                  e.preventDefault();
                                  e.stopPropagation();
                                  if (e.key === 'Escape') {
                                    setRecordingHotkeyKey(null);
                                    return;
                                  }
                                  const recorded = keyboardEventToHotkeyCombo(
                                    e.nativeEvent
                                  );
                                  if (!recorded) return;
                                  setRecordingHotkeyKey(null);
                                  void updateSettings((prev) => ({
                                    ...prev,
                                    desktopHotkeys: {
                                      ...prev.desktopHotkeys,
                                      [hk.key]: recorded,
                                    },
                                  }));
                                }}
                                className={`min-w-[116px] h-8 rounded border px-2.5 text-center font-mono text-[14px] transition-colors cursor-pointer focus:outline-none ${
                                  isCapturing
                                    ? 'border-[#1456F0] bg-[#EBF2FF] text-[#1456F0] ring-2 ring-[#1456F0]/20'
                                    : 'border-[#DEE0E3] bg-[#F8F9FA] text-[#1456F0] hover:border-[#3370FF]'
                                }`}
                              >
                                {isCapturing ? '请按下组合键...' : displayCombo}
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  <div className="space-y-2">
                    <label className="block text-[15px] font-medium text-[#1F2329]">
                      笔记默认导出格式
                    </label>
                    <Select
                      value={settings.defaultExportFormat}
                      options={[
                        { value: 'markdown', label: 'Markdown 文档 (.md)' },
                        { value: 'docx', label: 'Word 文档 (.docx)' },
                        { value: 'txt', label: '纯文本记录 (.txt)' },
                      ]}
                      onChange={(val) =>
                        void updateSettings((prev) => ({
                          ...prev,
                          defaultExportFormat: val as typeof prev.defaultExportFormat,
                        }))
                      }
                    />
                  </div>

                  <div className="border-t border-[#ECEEF2] pt-5 space-y-4">
                    <div className="flex items-center justify-between">
                      <span className="text-[15px] font-medium text-[#1F2329]">
                        课间长时间静音自动暂停录音（VAD）
                      </span>
                      <Switch
                        checked={settings.enableVadAutoPause}
                        ariaLabel="静音自动暂停录音"
                        onChange={(checked) =>
                          void updateSettings((prev) => ({
                            ...prev,
                            enableVadAutoPause: checked,
                          }))
                        }
                      />
                    </div>

                    <div className="flex items-center justify-between gap-4">
                      <div className="space-y-0.5 min-w-0">
                        <span className="text-[15px] font-medium text-[#1F2329]">
                          保存课堂本地原声录音文件（支持课后原声回放）
                        </span>
                        <p className="text-[14px] text-[#646A73]">
                          约占 110 MB/小时；关闭后不生成录音文件以节省磁盘空间，转写文字与笔记仍正常保存
                        </p>
                      </div>
                      <Switch
                        checked={settings.autoSaveSession}
                        ariaLabel="保存课堂本地原声录音文件"
                        onChange={(checked) =>
                          void updateSettings((prev) => ({
                            ...prev,
                            autoSaveSession: checked,
                          }))
                        }
                      />
                    </div>
                  </div>

                  {/* 关于知聆课堂与 CNB 自动更新 */}
                  <div className="rounded-[12px] border border-[#E5E6EB] bg-[#F7F8FA] p-4 space-y-3">
                    <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 sm:gap-4">
                      <div className="space-y-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <ArrowUpCircle className="w-4 h-4 text-[#1456F0] shrink-0" />
                          <span className="text-[15px] font-semibold text-[#1F2329]">
                            关于知聆课堂与软件更新
                          </span>
                          <span className="px-2 py-0.5 rounded-md bg-white border border-[#DCE4F7] text-[14px] font-medium text-[#1456F0] tabular-nums">
                            {currentVersionLabel}
                          </span>
                        </div>
                        <p className="text-[14px] text-[#646A73]">
                          每次启动自动通过 CNB 公开仓库检查更新，发现新版本时提示一键更新
                          {appUpdate.info?.repo ? `（源：cnb.cool/${appUpdate.info.repo}）` : ''}
                        </p>
                      </div>

                      <div className="flex flex-wrap items-center gap-2 shrink-0">
                        {appUpdate.info?.hasUpdate && (
                          <button
                            type="button"
                            onClick={() => {
                              setSettingsOpen(false);
                              void startOneClickAppUpdate();
                            }}
                            className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-[10px] bg-[#1456F0] hover:bg-[#3370FF] text-white text-[14px] font-medium whitespace-nowrap transition-colors cursor-pointer"
                          >
                            <Download className="w-4 h-4 shrink-0" />
                            <span>升级至 v{appUpdate.info.latestVersion}</span>
                          </button>
                        )}
                        <button
                          type="button"
                          disabled={isUpdateBusy}
                          onClick={() =>
                            void checkForAppUpdates({ silent: false, force: true })
                          }
                          className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-[10px] bg-white hover:bg-[#F2F3F5] border border-[#DEE0E3] text-[#1F2329] text-[14px] font-medium whitespace-nowrap disabled:opacity-60 transition-colors cursor-pointer"
                        >
                          {appUpdate.status === 'checking' ? (
                            <Loader2 className="w-4 h-4 animate-spin text-[#1456F0] shrink-0" />
                          ) : (
                            <RefreshCw className="w-4 h-4 text-[#4E5969] shrink-0" />
                          )}
                          <span>
                            {appUpdate.status === 'checking' ? '检查中...' : '检查更新'}
                          </span>
                        </button>
                      </div>
                    </div>

                    {appUpdate.status === 'up-to-date' && appUpdate.info && (
                      <p className="text-[14px] text-[#00A854]">
                        当前已是最新版本（v{appUpdate.info.currentVersion}）
                      </p>
                    )}
                    {appUpdate.status === 'error' && appUpdate.errorMessage && (
                      <p className="text-[14px] text-[#D83931]">{appUpdate.errorMessage}</p>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </Modal>
      )}

      {/* 大模型供应商选择器（手机端独立二级嵌套列表页 / 桌面端方格弹窗） */}
      <ProviderGridModal
        open={llmPickerOpen}
        onClose={() => setLlmPickerOpen(false)}
        title="选择大模型供应商"
        selectedId={settings.selectedLlmProviderId}
        options={LLM_PROVIDER_PRESETS.map((p) => {
          const cfg = settings.llmProviders[p.id];
          return {
            id: p.id,
            name: p.name,
            configured: Boolean(
              cfg?.apiKey.trim() || (cfg?.isCustom && cfg?.baseUrl.trim())
            ),
          };
        })}
        onSelect={(providerId) => {
          setShowCustomProxyOverride(false);
          void updateSettings((prev) => ({
            ...prev,
            selectedLlmProviderId: providerId,
          }));
        }}
      />

      {/* 语音转写供应商选择器（手机端独立二级嵌套列表页 / 桌面端方格弹窗） */}
      <ProviderGridModal
        open={asrPickerOpen}
        onClose={() => setAsrPickerOpen(false)}
        title="选择语音转写供应商"
        selectedId={settings.selectedAsrProviderId}
        options={ASR_PROVIDER_PRESETS.map((p) => ({
          id: p.id,
          name: p.name,
          configured:
            p.id === 'builtin-free-asr'
              ? true
              : Boolean(settings.asrProviders[p.id]?.apiKey.trim()),
        }))}
        onSelect={(providerId) => {
          void updateSettings((prev) => ({
            ...prev,
            selectedAsrProviderId: providerId,
          }));
        }}
      />
    </>
  );
};

interface AppSettingsFeaturePatch {
  enabled: boolean;
  providerId: string;
  modelId: string;
}
