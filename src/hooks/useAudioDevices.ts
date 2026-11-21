import { useCallback, useEffect, useState } from 'react';
import { api } from '../services/api';
import type { NativeAudioDevices } from '../types/domain';
import { isDesktopShell, isMacPlatform } from '../utils/desktopBridge';

export interface AudioSourceOption {
  value: string;
  label: string;
}

const VIRTUAL_CABLE_PATTERN =
  /cable|virtual|loopback|stereo\s*mix|what\s*u\s*hear|voicemeeter|blackhole|立体声混音|虚拟/i;

export function useAudioDevices(active = true) {
  const [micOptions, setMicOptions] = useState<AudioSourceOption[]>([
    { value: 'default', label: '系统默认麦克风' },
  ]);
  const [systemOptions, setSystemOptions] = useState<AudioSourceOption[]>([
    { value: 'default', label: '系统默认内录' },
    { value: 'display-share', label: '窗口或屏幕共享音频' },
  ]);
  const [wasapiSupported, setWasapiSupported] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const refreshDevices = useCallback(async () => {
    setIsRefreshing(true);
    try {
      const [browserList, nativeInfo] = await Promise.all([
        navigator.mediaDevices?.enumerateDevices
          ? navigator.mediaDevices.enumerateDevices().catch((): MediaDeviceInfo[] => [])
          : Promise.resolve<MediaDeviceInfo[]>([]),
        api.getNativeAudioDevices().catch(
          (): NativeAudioDevices => ({
            platform: 'browser',
            wasapiSupported: false,
            inputs: [],
            loopbacks: [],
          })
        ),
      ]);

      setWasapiSupported(nativeInfo.wasapiSupported);

      // 1. Build Microphone Options
      const defaultNativeMic = nativeInfo.inputs.find((d) => d.isDefault);
      const commNativeMic = nativeInfo.inputs.find((d) => d.isCommunicationsDefault);

      const nextMic: AudioSourceOption[] = [
        {
          value: 'default',
          label: defaultNativeMic
            ? `系统默认（${defaultNativeMic.name}）`
            : '系统默认麦克风',
        },
      ];

      const hasBrowserComm = browserList.some(
        (d) => d.kind === 'audioinput' && d.deviceId === 'communications'
      );
      if (hasBrowserComm) {
        nextMic.push({
          value: 'communications',
          label: commNativeMic
            ? `系统通信默认（${commNativeMic.name}）`
            : '系统默认通信麦克风',
        });
      }

      const rawBrowserMics = browserList.filter(
        (d) =>
          d.kind === 'audioinput' &&
          Boolean(d.deviceId) &&
          d.deviceId !== 'default' &&
          d.deviceId !== 'communications'
      );

      if (rawBrowserMics.length > 0) {
        rawBrowserMics.forEach((dev, idx) => {
          const cleanLabel = dev.label.trim();
          const fallbackNative = nativeInfo.inputs[idx]?.name;
          nextMic.push({
            value: dev.deviceId,
            label: cleanLabel || fallbackNative || `音频输入设备 ${idx + 1}`,
          });
        });
      } else if (nativeInfo.inputs.length > 0) {
        // Before browser permission or in WebView environments without enumerated hashes
        nativeInfo.inputs.forEach((ep) => {
          if (!ep.isDefault) {
            nextMic.push({
              value: ep.id,
              label: ep.name,
            });
          }
        });
      }

      setMicOptions(nextMic);

      // 2. Build System Audio / Loopback Options
      const nextSys: AudioSourceOption[] = [];
      if (nativeInfo.wasapiSupported) {
        const defaultLoop = nativeInfo.loopbacks.find((d) => d.isDefault);
        const commLoop = nativeInfo.loopbacks.find((d) => d.isCommunicationsDefault);

        nextSys.push({
          value: 'default',
          label: defaultLoop
            ? `系统默认（${defaultLoop.name}）`
            : '系统默认播放设备内录',
        });

        if (commLoop && commLoop.id !== defaultLoop?.id) {
          nextSys.push({
            value: 'communications',
            label: `系统通信默认（${commLoop.name}）`,
          });
        }

        for (const ep of nativeInfo.loopbacks) {
          nextSys.push({
            value: ep.id,
            label: ep.name,
          });
        }
      } else {
        nextSys.push({
          value: 'default',
          label: '系统默认内录（共享音频）',
        });
      }

      // Include virtual audio cables / Stereo Mix inputs if available in browser
      for (const dev of rawBrowserMics) {
        const cleanLabel = dev.label.trim();
        if (cleanLabel && VIRTUAL_CABLE_PATTERN.test(cleanLabel)) {
          nextSys.push({
            value: `input:${dev.deviceId}`,
            label: `虚拟声卡输入：${cleanLabel}`,
          });
        }
      }

      const supportsDisplayShare =
        typeof navigator !== 'undefined' &&
        typeof navigator.mediaDevices?.getDisplayMedia === 'function' &&
        !(isMacPlatform() && isDesktopShell() && nativeInfo.wasapiSupported);

      if (supportsDisplayShare) {
        nextSys.push({
          value: 'display-share',
          label: '窗口或标签页共享音频',
        });
      }

      setSystemOptions(nextSys);
    } finally {
      setIsRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    void refreshDevices();
    const media = navigator.mediaDevices;
    media?.addEventListener?.('devicechange', refreshDevices);
    return () => {
      media?.removeEventListener?.('devicechange', refreshDevices);
    };
  }, [active, refreshDevices]);

  return {
    micOptions,
    systemOptions,
    wasapiSupported,
    isRefreshing,
    refreshDevices,
  };
}
