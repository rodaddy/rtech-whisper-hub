// Ported from the desktop sibling rtech-whisper (an OpenWhispr fork):
// src/helpers/selfHostedDictationTranscription.js (splitWav, mergeChunkTexts)
// and src/helpers/transcriptRepetition.js (collapseRepeatedSentences).
// Works on mono 16-bit PCM samples; WAV framing is someone else's job.

export interface ChunkTiming {
  chunkSeconds: number;
  overlapSeconds: number;
}

const DEFAULT_TIMING: ChunkTiming = { chunkSeconds: 25, overlapSeconds: 1 };

/** Split PCM into chunkSeconds windows, each overlapping the previous by overlapSeconds. */
export function splitPcm(
  pcm: Int16Array,
  sampleRate: number,
  timing: ChunkTiming = DEFAULT_TIMING,
): Int16Array[] {
  const { chunkSeconds, overlapSeconds } = timing;
  if (
    !Number.isFinite(chunkSeconds) ||
    !Number.isFinite(overlapSeconds) ||
    chunkSeconds <= 0 ||
    overlapSeconds < 0 ||
    overlapSeconds >= chunkSeconds
  ) {
    throw new Error("Invalid chunk timing");
  }
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
    throw new Error("Invalid sample rate");
  }
  const samplesPerChunk = chunkSeconds * sampleRate;
  const step = (chunkSeconds - overlapSeconds) * sampleRate;
  const chunks: Int16Array[] = [];
  for (let start = 0; start < pcm.length; start += step) {
    chunks.push(
      pcm.subarray(start, Math.min(start + samplesPerChunk, pcm.length)),
    );
    if (start + samplesPerChunk >= pcm.length) break;
  }
  return chunks;
}

function normalizedWord(word: string): string {
  return word.toLocaleLowerCase().replace(/^\p{P}+|\p{P}+$/gu, "");
}

/** Join chunk transcripts, dropping the longest 3-12 word overlap between neighbours. */
export function mergeChunkTexts(texts: string[]): string {
  const merged: string[] = [];
  for (const text of texts) {
    const next = text.trim().split(/\s+/).filter(Boolean);
    let overlap = 0;
    const limit = Math.min(12, merged.length, next.length);
    for (let count = 3; count <= limit; count += 1) {
      const tail = merged.slice(-count).map(normalizedWord);
      const head = next.slice(0, count).map(normalizedWord);
      if (tail.every((word, index) => word && word === head[index]))
        overlap = count;
    }
    merged.push(...next.slice(overlap));
  }
  return merged.join(" ");
}

const normalizeSentence = (sentence: string): string =>
  sentence
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{S}]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();

/**
 * Collapse runs of the same sentence repeated back to back, which
 * self-hosted Whisper emits when it loops on silence. Non-adjacent
 * repeats are left alone.
 */
export function collapseRepeatedSentences(text: string): string {
  if (typeof text !== "string" || !text.trim()) return text;
  const sentences = text.match(/[^.!?]*[.!?]+|[^.!?]+$/gu);
  if (!sentences || sentences.length < 2) return text;

  const kept: string[] = [];
  let previous: string | null = null;
  for (const sentence of sentences) {
    const key = normalizeSentence(sentence);
    if (key && key === previous) continue;
    if (key) previous = key;
    kept.push(sentence);
  }
  return kept.join("").trim();
}
