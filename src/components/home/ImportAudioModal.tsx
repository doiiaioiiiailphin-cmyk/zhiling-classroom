import React, { useRef, useState } from 'react';
import { FileAudio, Loader2, Upload } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import type { AudioImportProgress } from '../../types/domain';
import { Modal } from '../ui/Modal';

function encodeFloat32ToWav16kMono(samples: Float32Array): Blob {
  const sampleRate = 16000;
  const byteLength = 44 + samples.length * 2;
  const buffer = new ArrayBuffer(byteLength);
  const view = new DataView(buffer);

  const writeAscii = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i += 1) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // Mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, 'data');
  view.setUint32(40, samples.length * 2, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

async function transcodeTo16kWavInBrowser(file: File): Promise<{ blob: Blob; name: string }> {
  // Small/medium files decode directly via WebAudio so Windows machines without FFmpeg still work
  if (file.size > 140 * 1024 * 1024 || typeof AudioContext === 'undefined') {
    return { blob: file, name: file.name };
  }
  const ctx = new AudioContext();
  try {
    const rawBuf = await file.arrayBuffer();
    const decoded = await ctx.decodeAudioData(rawBuf.slice(0));
    const targetLength = Math.max(1, Math.ceil(decoded.duration * 16000));
    const offline = new OfflineAudioContext(1, targetLength, 16000);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start(0);
    const rendered = await offline.startRendering();
    const wavBlob = encodeFloat32ToWav16kMono(rendered.getChannelData(0));
    const stem = file.name.replace(/\.[^.]+$/, '') || 'imported_audio';
    return { blob: wavBlob, name: `${stem}.wav` };
  } catch {
    return { blob: file, name: file.name };
  } finally {
    void ctx.close().catch(() => {});
  }
}

function describeStage(stage?: AudioImportProgress['stage']): string {
  switch (stage) {
    case 'decoding':
      return '正在提取并重采样课堂音轨...';
    case 'transcribing':
      return '正在流式语音转写并记录时间轴...';
    case 'refining':
      return '正在执行顺句清洗、知识分段与重点词标注...';
    default:
      return '准备处理音视频文件...';
  }
}

export const ImportAudioModal: React.FC = () => {
  const open = useAppStore((s) => s.importAudioModalOpen);
  const setImportAudioModalOpen = useAppStore((s) => s.setImportAudioModalOpen);
  const importAudioSession = useAppStore((s) => s.importAudioSession);
  const ensureBuiltinAsrReady = useAppStore((s) => s.ensureBuiltinAsrReady);
  const showNotice = useAppStore((s) => s.showNotice);

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [titleDraft, setTitleDraft] = useState('');
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState<AudioImportProgress | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const handlePickFile = (file: File | undefined | null) => {
    if (!file) return;
    setSelectedFile(file);
    if (!titleDraft.trim()) {
      setTitleDraft(file.name.replace(/\.[^.]+$/, ''));
    }
  };

  const handleStartImport = async () => {
    if (!selectedFile || importing) return;
    setImporting(true);
    try {
      if (!(await ensureBuiltinAsrReady())) return;
      setProgress({
        stage: 'decoding',
        downloadedBytes: 0,
        totalBytes: selectedFile.size,
        percent: 5,
      });
      const prepared = await transcodeTo16kWavInBrowser(selectedFile);
      await importAudioSession(
        prepared.blob,
        {
          fileName: prepared.name,
          title: titleDraft.trim() || selectedFile.name.replace(/\.[^.]+$/, ''),
        },
        (p) => setProgress(p)
      );
      setSelectedFile(null);
      setTitleDraft('');
      setProgress(null);
    } catch (err) {
      showNotice(
        'error',
        err instanceof Error ? err.message : '导入音视频文件失败'
      );
    } finally {
      setImporting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => {
        if (!importing) {
          setImportAudioModalOpen(false);
        }
      }}
      title="导入本地音视频创建课堂"
      widthClass="max-w-lg"
    >
      <div className="p-4 sm:p-6 space-y-4 sm:space-y-5">
        <input
          ref={inputRef}
          type="file"
          accept=".wav,.mp3,.m4a,.aac,.ogg,.flac,.webm,.mp4,.mkv,audio/*,video/*"
          className="hidden"
          onChange={(e) => handlePickFile(e.target.files?.[0])}
        />

        <div
          role="button"
          tabIndex={0}
          onClick={() => {
            if (!importing) inputRef.current?.click();
          }}
          onKeyDown={(e) => {
            if ((e.key === 'Enter' || e.key === ' ') && !importing) {
              e.preventDefault();
              inputRef.current?.click();
            }
          }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            if (!importing) {
              handlePickFile(e.dataTransfer.files?.[0]);
            }
          }}
          className="rounded-2xl border-2 border-dashed border-[#BEDAFF] bg-[#F8FAFF] hover:bg-[#EBF2FF]/60 p-6 text-center space-y-2.5 transition-colors cursor-pointer"
        >
          <div className="w-11 h-11 rounded-xl bg-[#1456F0] text-white flex items-center justify-center mx-auto">
            {selectedFile ? (
              <FileAudio className="w-5 h-5" />
            ) : (
              <Upload className="w-5 h-5" />
            )}
          </div>
          {selectedFile ? (
            <div className="space-y-1">
              <p className="text-[15px] font-semibold text-[#1F2329] break-all">
                {selectedFile.name}
              </p>
              <p className="text-[14px] text-[#646A73] tabular-nums">
                大小：{(selectedFile.size / (1024 * 1024)).toFixed(2)} MB（点击可重新选择文件）
              </p>
            </div>
          ) : (
            <div className="space-y-1">
              <p className="text-[15px] font-semibold text-[#1F2329]">
                点击选择或将录播音视频拖入此处
              </p>
              <p className="text-[14px] text-[#646A73]">
                支持 WAV / MP3 / M4A / MP4 / WebM / OGG 等课堂录音与网课回放
              </p>
            </div>
          )}
        </div>

        <div className="space-y-2">
          <label className="block text-[14px] font-medium text-[#1F2329]">
            新课堂标题
          </label>
          <input
            type="text"
            disabled={importing}
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            placeholder="例如：11月16日 图论与强连通分量录播"
            className="w-full h-10 rounded-lg border border-[#DEE0E3] bg-white px-3 text-[15px] text-[#1F2329] focus:outline-none focus:border-[#1456F0]"
          />
        </div>

        {importing && (
          <div className="rounded-xl border border-[#BEDAFF] bg-white p-4 space-y-2">
            <div className="flex items-center justify-between text-[14px]">
              <span className="font-medium text-[#1456F0] inline-flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin shrink-0" />
                <span>{describeStage(progress?.stage)}</span>
              </span>
              <span className="font-semibold text-[#1F2329] tabular-nums">
                {progress?.percent ?? 5}%
              </span>
            </div>
            <div className="h-2 w-full rounded-full bg-[#EBEDF0] overflow-hidden">
              <div
                className="h-full rounded-full bg-[#1456F0] transition-[width] duration-200 ease-out"
                style={{ width: `${Math.min(100, Math.max(5, progress?.percent ?? 5))}%` }}
              />
            </div>
          </div>
        )}

        <div className="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-end gap-2.5 sm:gap-3 pt-1">
          <button
            type="button"
            disabled={importing}
            onClick={() => setImportAudioModalOpen(false)}
            className="min-h-10 py-2 px-4 w-full sm:w-auto rounded-lg border border-[#DEE0E3] bg-white hover:bg-[#F2F3F5] disabled:opacity-50 text-[14px] font-medium text-[#1F2329] inline-flex items-center justify-center whitespace-nowrap cursor-pointer"
          >
            取消
          </button>
          <button
            type="button"
            disabled={!selectedFile || importing}
            onClick={() => void handleStartImport()}
            className="min-h-10 py-2 px-5 w-full sm:w-auto rounded-lg bg-[#1456F0] hover:bg-[#3370FF] disabled:opacity-50 text-white text-[14px] font-medium inline-flex items-center justify-center gap-2 whitespace-nowrap cursor-pointer"
          >
            {importing ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin shrink-0" />
                <span>正在转写导入...</span>
              </>
            ) : (
              <span>开始导入并生成课堂</span>
            )}
          </button>
        </div>
      </div>
    </Modal>
  );
};
