/**
 * RIFF WAV parsing and building for 16-bit PCM. Ported from the desktop's
 * findWavData/makePcmWav (rtech-whisper src/helpers/selfHostedDictationTranscription.js),
 * widened to read the fmt chunk so the hub can reject audio it cannot trim.
 */

export interface WavInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  /** Interleaved samples. */
  pcm: Int16Array;
}

export type WavErrorCode =
  "not-riff-wave" | "missing-fmt" | "missing-data" | "unsupported-format";

export class WavError extends Error {
  readonly code: WavErrorCode;
  constructor(code: WavErrorCode, message: string) {
    super(message);
    this.name = "WavError";
    this.code = code;
  }
}

export type WavParseResult =
  { ok: true; wav: WavInfo } | { ok: false; error: WavError };

const PCM_FORMAT = 1;

function fail(code: WavErrorCode, message: string): WavParseResult {
  return { ok: false, error: new WavError(code, message) };
}

/** Parse a RIFF/WAVE buffer holding 16-bit linear PCM. Never throws. */
export function parseWav(buf: Uint8Array): WavParseResult {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const ascii = (at: number) =>
    String.fromCharCode(buf[at], buf[at + 1], buf[at + 2], buf[at + 3]);
  if (buf.length < 12 || ascii(0) !== "RIFF" || ascii(8) !== "WAVE") {
    return fail("not-riff-wave", "not a RIFF/WAVE buffer");
  }

  let fmt:
    | { format: number; channels: number; sampleRate: number; bits: number }
    | undefined;
  let offset = 12;
  while (offset <= buf.length - 8) {
    const id = ascii(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt ") {
      if (size < 16 || body + 16 > buf.length) {
        return fail("missing-fmt", "fmt chunk is truncated");
      }
      fmt = {
        format: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bits: view.getUint16(body + 14, true),
      };
    } else if (id === "data") {
      if (!fmt) return fail("missing-fmt", "data chunk precedes fmt chunk");
      if (fmt.format !== PCM_FORMAT || fmt.bits !== 16) {
        return fail(
          "unsupported-format",
          `need 16-bit PCM, got format ${fmt.format} at ${fmt.bits} bits`,
        );
      }
      const bytes = Math.min(size, buf.length - body);
      const pcm = new Int16Array(Math.floor(bytes / 2));
      for (let i = 0; i < pcm.length; i += 1) {
        pcm[i] = view.getInt16(body + i * 2, true);
      }
      return {
        ok: true,
        wav: {
          sampleRate: fmt.sampleRate,
          channels: fmt.channels,
          bitsPerSample: fmt.bits,
          pcm,
        },
      };
    }
    offset = body + size + (size % 2);
  }
  return fail(fmt ? "missing-data" : "missing-fmt", "WAV has no data chunk");
}

/** The only shape the speech pipeline accepts: 16 kHz, mono, 16-bit PCM. */
export function isSpeechWav(
  info: Pick<WavInfo, "sampleRate" | "channels" | "bitsPerSample">,
): boolean {
  return (
    info.sampleRate === 16000 &&
    info.channels === 1 &&
    info.bitsPerSample === 16
  );
}

/** Build a mono 16-bit PCM WAV with a canonical 44-byte header. */
export function makePcmWav(pcm: Int16Array, sampleRate: number): Uint8Array {
  const dataBytes = pcm.length * 2;
  const out = new Uint8Array(44 + dataBytes);
  const view = new DataView(out.buffer);
  const writeAscii = (at: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) out[at + i] = text.charCodeAt(i);
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, PCM_FORMAT, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < pcm.length; i += 1)
    view.setInt16(44 + i * 2, pcm[i], true);
  return out;
}
