import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowUpCircle,
  AudioLines,
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
  OPENCODE_FREE_PROVIDER_ID,
} from '../../constants/providers';
import { useAudioDevices } from '../../hooks/useAudioDevices';
import { IS_MOCK_MODE, api } from '../../services/api';
import { useAppStore } from '../../store/useAppStore';
import type { AIModuleKey, ApiProtocol, DesktopHotkeys } from '../../types/domain';
import {
  formatShortcutLabel,
  getDefaultDesktopHotkeys,
  isMacPlatform,
  keyboardEventToHotkeyCombo,
} from '../../utils/desktopBridge';
import { ProviderIcon } from '../icons/ProviderIcons';
import { IconButton } from '../ui/IconButton';
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
  const [localAsrReady, setLocalAsrReady] = useState<boolean | null>(null);
  const [recordingHotkeyKey, setRecordingHotkeyKey] = useState<
    Exclude<keyof DesktopHotkeys, 'enabled'> | null
  >(null);
  const isMac = isMacPlatform();

  useEffect(() => {
    if (settingsOpen && settingsDefaultTab) {
      setActiveTab(settingsDefaultTab);
    }
  }, [settingsOpen, settingsDefaultTab]);

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
  const [llmPickerOpen, setLlmPickerOpen] = useState(false);
  const [asrPickerOpen, setAsrPickerOpen] = useState(false);
  const [showLlmKey, setShowLlmKey] = useState(false);
  const [showAsrKey, setShowAsrKey] = useState(false);
  const [showCustomProxyOverride, setShowCustomProxyOverride] = useState(false);
  const [fetchingLlm, setFetchingLlm] = useState(false);
  const [fetchingAsr, setFetchingAsr] = useState(false);
  const [previewLlmModel, setPreviewLlmModel] = useState('');
  const { micOptions, systemOptions } = useAudioDevices(settingsOpen);

  const selectedLlm = settings
    ? settings.llmProviders[settings.selectedLlmProviderId]
    : null;
  const selectedAsr = settings
    ? settings.asrProviders[settings.selectedAsrProviderId]
    : null;
  const isOpenCodeFree = selectedLlm?.providerId === OPENCODE_FREE_PROVIDER_ID;
  const hasOpenCodeCatalog = Boolean(isOpenCodeFree && selectedLlm?.lastFetchedAt);

  useEffect(() => {
    if (IS_MOCK_MODE || !settingsOpen || activeTab !== 'llm' || !isOpenCodeFree || hasOpenCodeCatalog) return;
    setFetchingLlm(true);
    void fetchModelsForLlmProvider(OPENCODE_FREE_PROVIDER_ID).finally(() => setFetchingLlm(false));
  }, [settingsOpen, activeTab, isOpenCodeFree, hasOpenCodeCatalog, fetchModelsForLlmProvider]);

  const selectedAsrPreset = useMemo(
    () =>
      ASR_PROVIDER_PRESETS.find((p) => p.id === settings?.selectedAsrProviderId),
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
        nextModelId = nextProviderId === OPENCODE_FREE_PROVIDER_ID ? '' : providerModels[0] ?? '';
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

  return (
    <>
      <Modal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        title="系统与模型设置"
        widthClass="max-w-4xl"
      >
        <div className="flex min-h-[520px] max-h-[76vh]">
          {/* 左侧分类栏 */}
          <aside className="w-52 shrink-0 border-r border-[#ECEEF2] bg-[#F5F6F7]/70 p-3 space-y-1">
            {SETTINGS_TABS.map((tab) => {
              const Icon = tab.icon;
              const active = activeTab === tab.key;
              return (
                <button
                  key={tab.key}
                  type="button"
                  onClick={() => setActiveTab(tab.key)}
                  className={`w-full flex items-center gap-2.5 rounded-lg px-3.5 py-2.5 text-[15px] transition-colors cursor-pointer ${
                    active
                      ? 'bg-[#EBF2FF] text-[#1456F0] font-medium'
                      : 'text-[#4E5969] hover:bg-[#ECEEF2]/80 hover:text-[#1F2329]'
                  }`}
                >
                  <Icon
                    className={`w-[18px] h-[18px] ${
                      active ? 'text-[#1456F0]' : 'text-[#4E5969]'
                    }`}
                    strokeWidth={1.85}
                  />
                  <span>{tab.label}</span>
                </button>
              );
            })}
          </aside>

          {/* 右侧设置详情区 */}
          <div className="flex-1 overflow-y-auto p-6 space-y-6 bg-white">
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
                          {!isOpenCodeFree && (
                            <div className="text-[14px] text-[#4E5969] truncate">
                              {protocolLabel}
                            </div>
                          )}
                        </div>
                      </div>
                    </button>

                    <div className="flex items-center gap-2 shrink-0">
                      {!selectedLlm.isCustom && !isOpenCodeFree && (
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

                {!selectedLlm.isCustom && !isOpenCodeFree && showCustomProxyOverride && (
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

                {!isOpenCodeFree && (
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
                        className="h-10 flex-1 rounded-lg border border-[#DEE0E3] bg-white px-3.5 text-[15px] text-[#1F2329] placeholder-[#646A73] focus:border-[#1456F0] focus:outline-none focus:ring-2 focus:ring-[#1456F0]/15"
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
                )}

                {/* 已拉取模型列表预览下拉框 */}
                <div className="space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[15px] font-medium text-[#1F2329]">
                      已获取模型列表
                    </span>
                    <div className="flex items-center gap-2">
                      {(!isOpenCodeFree || selectedLlm.availableModels.length > 0) && (
                        <span className="text-[14px] text-[#1456F0]">
                          {selectedLlm.availableModels.length > 0
                            ? isOpenCodeFree
                              ? `上次拉取 ${selectedLlm.availableModels.length} 个模型`
                              : `共 ${selectedLlm.availableModels.length} 个模型可用`
                            : '待拉取模型列表'}
                        </span>
                      )}
                      {isOpenCodeFree && (
                        <IconButton
                          icon={RefreshCw}
                          size="md"
                          variant="outline"
                          spinning={fetchingLlm}
                          disabled={fetchingLlm}
                          tooltip="刷新模型列表"
                          onClick={() => void handleFetchLlmModels()}
                        />
                      )}
                    </div>
                  </div>
                  <Select
                    value={previewLlmModel}
                    disabled={selectedLlm.availableModels.length === 0}
                    placeholder={isOpenCodeFree ? '暂无模型' : '填写密钥并点击刷新获取模型列表'}
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
                  if (binding.providerId === OPENCODE_FREE_PROVIDER_ID) {
                    modelOptions.unshift({ value: '', label: '自动选择免费模型' });
                  }

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
                                    availableModels: resetCatalog ? [] : current.availableModels,
                                    selectedModelId: resetCatalog ? '' : current.selectedModelId,
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
                          className="h-10 flex-1 rounded-lg border border-[#DEE0E3] bg-white px-3.5 text-[15px] text-[#1F2329] placeholder-[#646A73] focus:border-[#1456F0] focus:outline-none focus:ring-2 focus:ring-[#1456F0]/15"
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

                {/* 跨平台桌面全局快捷键配置（Windows / macOS 原生按键录制与符号显示） */}
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
                        ariaLabel={isMac ? '启用 macOS 全局快捷键' : '启用 Windows 全局快捷键'}
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
                        const displayCombo = formatShortcutLabel(settings.desktopHotkeys[hk.key]);
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
                                const recorded = keyboardEventToHotkeyCombo(e.nativeEvent);
                                if (!recorded) return;
                                setRecordingHotkeyKey(null);
                                void updateSettings((prev) => ({
                                  ...prev,
                                  desktopHotkeys: { ...prev.desktopHotkeys, [hk.key]: recorded },
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
                  <div className="flex items-start justify-between gap-4">
                    <div className="space-y-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <ArrowUpCircle className="w-4 h-4 text-[#1456F0] shrink-0" />
                        <span className="text-[15px] font-semibold text-[#1F2329]">
                          关于知聆课堂与软件更新
                        </span>
                        <span className="px-2 py-0.5 rounded-md bg-white border border-[#DCE4F7] text-[14px] font-medium text-[#1456F0] tabular-nums">
                          v{appUpdate.info?.currentVersion || '0.1.6'}
                        </span>
                      </div>
                      <p className="text-[14px] text-[#646A73]">
                        每次启动自动通过 CNB 公开仓库检查更新，发现新版本时在右下角提示一键热更新
                        {appUpdate.info?.repo ? `（源：cnb.cool/${appUpdate.info.repo}）` : ''}
                      </p>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      {appUpdate.info?.hasUpdate && (
                        <button
                          type="button"
                          onClick={() => {
                            setSettingsOpen(false);
                            void startOneClickAppUpdate();
                          }}
                          className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-[10px] bg-[#1456F0] hover:bg-[#3370FF] text-white text-[14px] font-medium transition-colors"
                        >
                          <Download className="w-4 h-4" />
                          <span>升级至 v{appUpdate.info.latestVersion}</span>
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={
                          appUpdate.status === 'checking' ||
                          appUpdate.status === 'downloading' ||
                          appUpdate.status === 'verifying' ||
                          appUpdate.status === 'applying'
                        }
                        onClick={() => void checkForAppUpdates({ silent: false, force: true })}
                        className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-[10px] bg-white hover:bg-[#F2F3F5] border border-[#DEE0E3] text-[#1F2329] text-[14px] font-medium disabled:opacity-60 transition-colors"
                      >
                        {appUpdate.status === 'checking' ? (
                          <Loader2 className="w-4 h-4 animate-spin text-[#1456F0]" />
                        ) : (
                          <RefreshCw className="w-4 h-4 text-[#4E5969]" />
                        )}
                        <span>{appUpdate.status === 'checking' ? '检查中...' : '检查更新'}</span>
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

      {/* 大模型供应商方格选择菜单 */}
      <ProviderGridModal
        open={llmPickerOpen}
        onClose={() => setLlmPickerOpen(false)}
        title="选择大模型供应商"
        selectedId={settings.selectedLlmProviderId}
        options={LLM_PROVIDER_PRESETS.map((p) => ({
          id: p.id,
          name: p.name,
          configured: p.id === OPENCODE_FREE_PROVIDER_ID
            ? Boolean(settings.llmProviders[p.id]?.lastFetchedAt)
            : Boolean(settings.llmProviders[p.id]?.apiKey.trim()),
        }))}
        onSelect={(providerId) => {
          setShowCustomProxyOverride(false);
          void updateSettings((prev) => ({
            ...prev,
            selectedLlmProviderId: providerId,
          }));
        }}
      />

      {/* 语音转写供应商方格选择菜单 */}
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
