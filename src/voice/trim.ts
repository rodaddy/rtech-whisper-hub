/**
 * Adaptive silence trim, ported from the desktop's trimSilence
 * (rtech-whisper src/helpers/silenceTrim.js). The desktop works in bytes of a
 * 16 kHz PCM16 buffer; this works in samples, which is the same arithmetic
 * (byte counts are sample counts x 2). Keep the constants in lockstep with the
 * desktop: test/voice-trim.test.ts pins numbers produced by the desktop code.
 *
 * The speech threshold adapts to the recording because a real mic's
 * "silence" is room noise, not zero: max(MIN_SPEECH_RMS, NOISE_FACTOR x the
 * 10th-percentile frame RMS).
 */

const FRAME_MS = 30;
const MIN_SPEECH_RMS = 0.004;
const NOISE_FACTOR = 2.5;
const PAD_MS = 300;
const MAX_GAP_MS = 1000;
const KEEP_GAP_MS = 400;

export interface TrimResult {
  pcm: Int16Array;
  originalMs: number;
  keptMs: number;
  hasSpeech: boolean;
}

function frameRms(pcm: Int16Array, start: number, end: number): number {
  let sum = 0;
  for (let i = start; i < end; i += 1) {
    const sample = pcm[i] / 32768;
    sum += sample * sample;
  }
  const count = end - start;
  return count > 0 ? Math.sqrt(sum / count) : 0;
}

/** Trim leading/trailing silence and shrink long inner silences. Pure. */
export function trimSilence(pcm: Int16Array, sampleRate: number): TrimResult {
  const msToSamples = (ms: number) => Math.round((ms / 1000) * sampleRate);
  const samplesToMs = (n: number) => Math.round((n / sampleRate) * 1000);
  const originalMs = samplesToMs(pcm.length);
  const frame = msToSamples(FRAME_MS);
  if (!frame || !pcm.length) {
    return { pcm, originalMs, keptMs: originalMs, hasSpeech: false };
  }

  const frameCount = Math.ceil(pcm.length / frame);
  const rms = new Array<number>(frameCount);
  for (let i = 0; i < frameCount; i += 1) {
    const start = i * frame;
    rms[i] = frameRms(pcm, start, Math.min(start + frame, pcm.length));
  }
  const sorted = [...rms].sort((a, b) => a - b);
  const noiseFloor = sorted[Math.floor(0.1 * (sorted.length - 1))];
  const threshold = Math.max(MIN_SPEECH_RMS, noiseFloor * NOISE_FACTOR);

  const speech = new Array<boolean>(frameCount);
  let first = -1;
  let last = -1;
  for (let i = 0; i < frameCount; i += 1) {
    speech[i] = rms[i] >= threshold;
    if (speech[i]) {
      if (first === -1) first = i;
      last = i;
    }
  }
  if (first === -1) return { pcm, originalMs, keptMs: 0, hasSpeech: false };

  const padFrames = Math.ceil(PAD_MS / FRAME_MS);
  const startFrame = Math.max(0, first - padFrames);
  const endFrame = Math.min(frameCount - 1, last + padFrames);
  const maxGap = msToSamples(MAX_GAP_MS);
  const keepEdge = msToSamples(KEEP_GAP_MS / 2);

  const pieces: Int16Array[] = [];
  let runStart = startFrame;
  const flushRun = (runEndFrame: number) => {
    const startAt = runStart * frame;
    const endAt = Math.min((runEndFrame + 1) * frame, pcm.length);
    const length = endAt - startAt;
    if (length <= 0) return;
    if (speech[runStart] || length <= maxGap) {
      pieces.push(pcm.subarray(startAt, endAt));
      return;
    }
    pieces.push(pcm.subarray(startAt, startAt + keepEdge));
    pieces.push(pcm.subarray(endAt - keepEdge, endAt));
  };
  for (let i = startFrame + 1; i <= endFrame; i += 1) {
    if (speech[i] !== speech[runStart]) {
      flushRun(i - 1);
      runStart = i;
    }
  }
  flushRun(endFrame);

  const total = pieces.reduce((n, p) => n + p.length, 0);
  const trimmed = new Int16Array(total);
  let at = 0;
  for (const piece of pieces) {
    trimmed.set(piece, at);
    at += piece.length;
  }
  return {
    pcm: trimmed,
    originalMs,
    keptMs: samplesToMs(total),
    hasSpeech: true,
  };
}
