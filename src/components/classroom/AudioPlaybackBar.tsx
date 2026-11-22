import React, { useEffect, useRef, useState } from 'react';
import { Pause, Play, RefreshCw, RotateCcw, RotateCw, Volume2, X } from 'lucide-react';
import { api } from '../../services/api';
import { useAppStore } from '../../store/useAppStore';
import { formatDuration } from '../../utils/format';
import { IconButton } from '../ui/IconButton';

const SPEED_OPTIONS = [0.75, 1.0, 1.25, 1.5, 2.0] as const;

export const AudioPlaybackBar: React.FC = () => {
  const sessionId = useAppStore((s) => s.activeSession?.id ?? null);
  const audioPlayback = useAppStore((s) => s.audioPlayback);
  const audioDurationMs = useAppStore((s) => s.audioDurationMs);
  const sessionDurationSec = useAppStore((s) => s.activeSession?.durationSeconds ?? 0);
  const updateAudioPlaybackState = useAppStore((s) => s.updateAudioPlaybackState);
  const closeAudioPlayback = useAppStore((s) => s.closeAudioPlayback);
  const retranscribeSessionGap = useAppStore((s) => s.retranscribeSessionGap);
  const showNotice = useAppStore((s) => s.showNotice);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const lastHandledSeekSeqRef = useRef<number>(0);
  const [speedIndex, setSpeedIndex] = useState(1); // 1.0x
  const speedRef = useRef<number>(SPEED_OPTIONS[1]);
  const [durationSec, setDurationSec] = useState(0);
  const [retranscribing, setRetranscribing] = useState(false);

  const speed = SPEED_OPTIONS[speedIndex];
  speedRef.current = speed;

  useEffect(() => {
    lastHandledSeekSeqRef.current = 0;
  }, [sessionId]);

  useEffect(() => {
    if (!audioPlayback.visible || !sessionId) return;
    const el = audioRef.current;
    if (!el) return;
    el.playbackRate = speed;
  }, [speed, audioPlayback.visible, sessionId]);

  useEffect(() => {
    if (!audioPlayback.visible || !sessionId || audioPlayback.seekRequestMs === null) {
      return;
    }
    if (audioPlayback.requestSeq <= lastHandledSeekSeqRef.current) {
      return;
    }
    const el = audioRef.current;
    if (!el) return;
    lastHandledSeekSeqRef.current = audioPlayback.requestSeq;
    const targetSec = Math.max(0, audioPlayback.seekRequestMs / 1000);

    const applySeekAndPlay = () => {
      try {
        el.currentTime = targetSec;
      } catch {
        // wait for metadata if needed
      }
      el.playbackRate = speedRef.current;
      void el.play().catch((err: unknown) => {
        updateAudioPlaybackState({ isPlaying: false });
        showNotice(
          'error',
          err instanceof Error ? '无法播放该时间点原声，请确认课堂已开启自动保存录音' : '原声播放失败'
        );
      });
    };

    if (el.readyState >= 1) {
      applySeekAndPlay();
    } else {
      el.addEventListener('loadedmetadata', applySeekAndPlay, { once: true });
      el.load();
    }
  }, [
    audioPlayback.requestSeq,
    audioPlayback.visible,
    audioPlayback.seekRequestMs,
    sessionId,
    updateAudioPlaybackState,
    showNotice,
  ]);

  if (!audioPlayback.visible || !sessionId) {
    return null;
  }

  const totalSec = Math.max(
    durationSec,
    Math.floor(audioDurationMs / 1000),
    sessionDurationSec,
    1
  );
  const currentSec = Math.floor(audioPlayback.currentMs / 1000);

  const togglePlay = () => {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) {
      void el.play().catch(() => {
        showNotice('error', '该课堂暂无可回放的本地原声文件');
      });
    } else {
      el.pause();
    }
  };

  const skipBy = (deltaSec: number) => {
    const el = audioRef.current;
    if (!el) return;
    const next = Math.max(0, Math.min(totalSec, el.currentTime + deltaSec));
    el.currentTime = next;
    updateAudioPlaybackState({ currentMs: Math.round(next * 1000) });
  };

  const handleRetranscribeGap = async () => {
    if (retranscribing) return;
    setRetranscribing(true);
    try {
      await retranscribeSessionGap();
    } finally {
      setRetranscribing(false);
    }
  };

  return (
    <div className="border-t border-[#DEE0E3] bg-white px-4 py-2.5 flex items-center gap-3 shrink-0 shadow-xs">
      <audio
        ref={audioRef}
        src={api.getSessionAudioUrl(sessionId)}
        preload="metadata"
        onLoadedMetadata={(e) => {
          const d = e.currentTarget.duration;
          if (Number.isFinite(d) && d > 0) setDurationSec(Math.floor(d));
        }}
        onTimeUpdate={(e) => {
          updateAudioPlaybackState({
            currentMs: Math.round(e.currentTarget.currentTime * 1000),
          });
        }}
        onPlay={() => updateAudioPlaybackState({ isPlaying: true })}
        onPause={() => updateAudioPlaybackState({ isPlaying: false })}
        onEnded={() => updateAudioPlaybackState({ isPlaying: false })}
      />

      <div className="flex items-center gap-1 shrink-0">
        <IconButton
          icon={RotateCcw}
          variant="ghost"
          tooltip="后退 5 秒"
          onClick={() => skipBy(-5)}
        />
        <IconButton
          icon={audioPlayback.isPlaying ? Pause : Play}
          variant="primary"
          tooltip={audioPlayback.isPlaying ? '暂停原声回放' : '播放原声回放'}
          onClick={togglePlay}
        />
        <IconButton
          icon={RotateCw}
          variant="ghost"
          tooltip="快进 5 秒"
          onClick={() => skipBy(5)}
        />
      </div>

      <div className="flex-1 flex items-center gap-3 min-w-0">
        <Volume2 className="w-4 h-4 text-[#1456F0] shrink-0" />
        <span className="text-[14px] font-medium text-[#1F2329] tabular-nums shrink-0">
          {formatDuration(currentSec)}
        </span>
        <input
          type="range"
          min={0}
          max={totalSec}
          value={Math.min(totalSec, currentSec)}
          onChange={(e) => {
            const sec = Number(e.target.value);
            if (audioRef.current) {
              audioRef.current.currentTime = sec;
            }
            updateAudioPlaybackState({ currentMs: sec * 1000 });
          }}
          className="flex-1 h-1.5 accent-[#1456F0] bg-[#EBEDF0] rounded-lg cursor-pointer"
        />
        <span className="text-[14px] text-[#646A73] tabular-nums shrink-0">
          {formatDuration(totalSec)}
        </span>
      </div>

      <button
        type="button"
        onClick={() => setSpeedIndex((idx) => (idx + 1) % SPEED_OPTIONS.length)}
        className="h-8 px-2.5 rounded-lg border border-[#DEE0E3] bg-[#F8F9FA] hover:bg-[#EBF2FF] hover:border-[#BEDAFF] text-[14px] font-medium text-[#1F2329] tabular-nums transition-colors cursor-pointer shrink-0"
      >
        {speed.toFixed(speed % 1 === 0 ? 1 : 2)}x
      </button>

      <IconButton
        icon={RefreshCw}
        variant="ghost"
        tooltip="检测断流缺口并从本地原声补转写"
        disabled={retranscribing}
        onClick={() => void handleRetranscribeGap()}
      />

      <IconButton
        icon={X}
        variant="ghost"
        tooltip="收起原声回放条"
        onClick={() => {
          audioRef.current?.pause();
          closeAudioPlayback();
        }}
      />
    </div>
  );
};
