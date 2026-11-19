const TARGET_SAMPLE_RATE = 16000;
const FRAME_SAMPLES_10MS = 160;
const CHUNK_BYTES_20MS = 640;
const SYS_RING_CAPACITY = 8000; // 500ms @ 16kHz
const SYS_RING_MAX_LEAD = 3200; // cap buffer latency at 200ms
const WASAPI_MIC_DELAY_SAMPLES = 720; // 45ms causal lookahead for WASAPI loopback AEC3

function softLimit(sample) {
  const abs = Math.abs(sample);
  if (abs <= 0.85) return sample;
  const sign = sample < 0 ? -1 : 1;
  return sign * (0.85 + 0.15 * Math.tanh((abs - 0.85) / 0.15));
}

class ClassroomPcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.active = false;
    this.generation = 0;

    this.micMuted = false;
    this.sysMuted = false;
    this.sysMode = 'none'; // 'wasapi' | 'webaudio' | 'none'
    this.aec3Enabled = false;
    this.aec3 = null;
    this.aec3Loading = false;

    this.samplesPerOutput = sampleRate / TARGET_SAMPLE_RATE;
    this.remaining = this.samplesPerOutput;
    this.micSum = 0;
    this.sysSum = 0;

    this.micFrame = new Float32Array(FRAME_SAMPLES_10MS);
    this.sysFrame = new Float32Array(FRAME_SAMPLES_10MS);
    this.aecOutFrame = new Float32Array(FRAME_SAMPLES_10MS);
    this.aecSysArg = [this.sysFrame];
    this.aecMicArg = [this.micFrame];
    this.aecOutArg = [this.aecOutFrame];
    this.aecOpts = { sampleRateIn: TARGET_SAMPLE_RATE, sampleRateOut: TARGET_SAMPLE_RATE };
    this.framePos = 0;

    this.sysRing = new Float32Array(SYS_RING_CAPACITY);
    this.sysRead = 0;
    this.sysWrite = 0;
    this.sysCount = 0;

    this.micDelayRing = new Float32Array(WASAPI_MIC_DELAY_SAMPLES);
    this.micDelayIdx = 0;
    this.wasDelayingMic = false;

    this.buffer = new ArrayBuffer(CHUNK_BYTES_20MS);
    this.view = new DataView(this.buffer);
    this.offset = 0;

    this.micLevel = 0;
    this.sysLevel = 0;
    this.levelTick = 0;

    this.port.onmessage = ({ data }) => {
      if (!data || typeof data !== 'object') return;
      const msgType = data.type || 'control';

      if (msgType === 'control') {
        this.active = Boolean(data.active);
        if (typeof data.generation === 'number') {
          this.generation = data.generation;
        }
        this.offset = 0;
        this.framePos = 0;
        this.remaining = this.samplesPerOutput;
        this.micSum = 0;
        this.sysSum = 0;
        if (!this.active) {
          this.sysRead = 0;
          this.sysWrite = 0;
          this.sysCount = 0;
          this.micLevel = 0;
          this.sysLevel = 0;
        }
        return;
      }

      if (msgType === 'channels') {
        if (typeof data.micMuted === 'boolean') this.micMuted = data.micMuted;
        if (typeof data.sysMuted === 'boolean') this.sysMuted = data.sysMuted;
        if (typeof data.sysMode === 'string') {
          if (this.sysMode !== data.sysMode) {
            this.sysRead = 0;
            this.sysWrite = 0;
            this.sysCount = 0;
          }
          this.sysMode = data.sysMode;
        }
        if (typeof data.aec3Enabled === 'boolean') this.aec3Enabled = data.aec3Enabled;
        return;
      }

      if (msgType === 'sys-pcm' && data.pcm instanceof ArrayBuffer) {
        if (!this.active || this.sysMuted || this.sysMode !== 'wasapi') return;
        this.pushWasapiPcm(data.pcm);
        return;
      }

      if (msgType === 'init-aec3' && data.wasmBinary instanceof ArrayBuffer) {
        this.initAec3(data.wasmBinary);
        return;
      }

      if (msgType === 'dispose') {
        this.active = false;
        if (this.aec3) {
          try {
            this.aec3.free();
          } catch {
            // ignore disposal error
          }
          this.aec3 = null;
        }
      }
    };
  }

  initAec3(wasmBinary) {
    if (typeof globalThis.WebRtcAec3 !== 'function' || this.aec3Loading) return;
    this.aec3Loading = true;
    globalThis
      .WebRtcAec3({ wasmBinary: new Uint8Array(wasmBinary) })
      .then((mod) => {
        if (this.aec3) {
          try {
            this.aec3.free();
          } catch {
            // ignore
          }
        }
        this.aec3 = new mod.AEC3(48000, 1, 1);
        this.aec3Loading = false;
        this.port.postMessage({ type: 'aec3-status', ready: true });
      })
      .catch((err) => {
        this.aec3Loading = false;
        this.port.postMessage({
          type: 'aec3-status',
          ready: false,
          message: err instanceof Error ? err.message : String(err),
        });
      });
  }

  pushWasapiPcm(pcmBuffer) {
    const dv = new DataView(pcmBuffer);
    const sampleCount = pcmBuffer.byteLength >> 1;
    for (let i = 0; i < sampleCount; i++) {
      const s16 = dv.getInt16(i << 1, true);
      this.sysRing[this.sysWrite] = s16 < 0 ? s16 / 32768 : s16 / 32767;
      this.sysWrite = (this.sysWrite + 1) % SYS_RING_CAPACITY;
      if (this.sysCount < SYS_RING_CAPACITY) {
        this.sysCount++;
      } else {
        this.sysRead = (this.sysRead + 1) % SYS_RING_CAPACITY;
      }
    }
    if (this.sysCount > SYS_RING_MAX_LEAD) {
      const drop = this.sysCount - (SYS_RING_MAX_LEAD >> 1);
      this.sysRead = (this.sysRead + drop) % SYS_RING_CAPACITY;
      this.sysCount -= drop;
    }
  }

  popWasapiSample() {
    if (this.sysCount <= 0) return 0;
    const val = this.sysRing[this.sysRead];
    this.sysRead = (this.sysRead + 1) % SYS_RING_CAPACITY;
    this.sysCount--;
    return val;
  }

  processFrame10ms() {
    let micSq = 0;
    let sysSq = 0;
    for (let i = 0; i < FRAME_SAMPLES_10MS; i++) {
      const m = this.micMuted ? 0 : this.micFrame[i];
      const s = this.sysMuted ? 0 : this.sysFrame[i];
      micSq += m * m;
      sysSq += s * s;
    }
    const micRms = Math.min(1, Math.sqrt(micSq / FRAME_SAMPLES_10MS) * 3.2);
    const sysRms = Math.min(1, Math.sqrt(sysSq / FRAME_SAMPLES_10MS) * 3.2);
    this.micLevel = micRms > this.micLevel ? micRms : this.micLevel * 0.78 + micRms * 0.22;
    this.sysLevel = sysRms > this.sysLevel ? sysRms : this.sysLevel * 0.78 + sysRms * 0.22;

    const runAec3 = Boolean(
      this.aec3 && this.aec3Enabled && !this.micMuted && !this.sysMuted && this.sysMode !== 'none'
    );

    if (++this.levelTick >= 8) {
      this.levelTick = 0;
      this.port.postMessage({
        type: 'levels',
        micLevel: this.micMuted ? 0 : this.micLevel,
        sysLevel: this.sysMuted ? 0 : this.sysLevel,
        aec3Active: runAec3,
      });
    }

    let cleanMic = this.micFrame;
    if (runAec3) {
      try {
        this.aec3.analyze(this.aecSysArg, this.aecOpts);
        this.aec3.process(this.aecOutArg, this.aecMicArg, this.aecOpts);
        cleanMic = this.aecOutFrame;
      } catch {
        cleanMic = this.micFrame;
      }
    }

    for (let i = 0; i < FRAME_SAMPLES_10MS; i++) {
      const mVal = this.micMuted ? 0 : cleanMic[i];
      const sVal = this.sysMuted ? 0 : this.sysFrame[i];
      const mixed = softLimit(mVal + sVal);
      const clamped = Math.max(-1, Math.min(1, mixed));
      this.view.setInt16(
        this.offset,
        Math.round(clamped * (clamped < 0 ? 32768 : 32767)),
        true
      );
      this.offset += 2;
      if (this.offset === CHUNK_BYTES_20MS) {
        this.port.postMessage(
          { type: 'pcm', generation: this.generation, pcm: this.buffer },
          [this.buffer]
        );
        this.buffer = new ArrayBuffer(CHUNK_BYTES_20MS);
        this.view = new DataView(this.buffer);
        this.offset = 0;
      }
    }
  }

  process(inputs) {
    if (!this.active) return true;

    const micIn = inputs[0]?.[0];
    const sysIn = inputs[1]?.[0];
    const blockLength = micIn?.length || sysIn?.length || 128;

    const useWasapiDelay = Boolean(
      this.sysMode === 'wasapi' && this.aec3 && this.aec3Enabled && !this.micMuted && !this.sysMuted
    );
    if (useWasapiDelay !== this.wasDelayingMic) {
      this.micDelayRing.fill(0);
      this.micDelayIdx = 0;
      this.wasDelayingMic = useWasapiDelay;
    }

    for (let idx = 0; idx < blockLength; idx++) {
      const rawMic = !this.micMuted && micIn ? micIn[idx] : 0;
      const rawSys =
        !this.sysMuted && this.sysMode === 'webaudio' && sysIn ? sysIn[idx] : 0;

      let available = 1;
      while (available > 1e-8) {
        const weight = Math.min(available, this.remaining);
        this.micSum += rawMic * weight;
        this.sysSum += rawSys * weight;
        this.remaining -= weight;
        available -= weight;
        if (this.remaining > 1e-8) continue;

        let m16 = Math.max(-1, Math.min(1, this.micSum / this.samplesPerOutput));
        let s16 =
          this.sysMode === 'wasapi'
            ? this.sysMuted
              ? 0
              : this.popWasapiSample()
            : Math.max(-1, Math.min(1, this.sysSum / this.samplesPerOutput));

        if (useWasapiDelay) {
          const delayed = this.micDelayRing[this.micDelayIdx];
          this.micDelayRing[this.micDelayIdx] = m16;
          this.micDelayIdx = (this.micDelayIdx + 1) % WASAPI_MIC_DELAY_SAMPLES;
          m16 = delayed;
        }

        this.micFrame[this.framePos] = m16;
        this.sysFrame[this.framePos] = s16;
        this.framePos++;

        this.remaining = this.samplesPerOutput;
        this.micSum = 0;
        this.sysSum = 0;

        if (this.framePos === FRAME_SAMPLES_10MS) {
          this.framePos = 0;
          this.processFrame10ms();
        }
      }
    }
    return true;
  }
}

registerProcessor('classroom-pcm', ClassroomPcmProcessor);
