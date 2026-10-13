import assert from "node:assert/strict";
import { test } from "node:test";
import { isSpeechWav, makePcmWav, parseWav } from "../src/voice/wav.ts";

function header(
  sampleRate: number,
  channels: number,
  bits: number,
  format = 1,
): Uint8Array {
  const wav = makePcmWav(new Int16Array([1, -2, 3, -4]), sampleRate);
  const view = new DataView(wav.buffer);
  view.setUint16(20, format, true);
  view.setUint16(22, channels, true);
  view.setUint16(34, bits, true);
  return wav;
}

test("makePcmWav round-trips through parseWav", () => {
  const pcm = new Int16Array([0, 1, -1, 32767, -32768, 1234]);
  const parsed = parseWav(makePcmWav(pcm, 16000));
  assert.ok(parsed.ok);
  assert.deepEqual(
    { ...parsed.wav, pcm: Array.from(parsed.wav.pcm) },
    { sampleRate: 16000, channels: 1, bitsPerSample: 16, pcm: Array.from(pcm) },
  );
  assert.equal(isSpeechWav(parsed.wav), true);
});

test("makePcmWav writes the canonical 44-byte header", () => {
  const wav = makePcmWav(new Int16Array(3), 16000);
  const view = new DataView(wav.buffer);
  assert.equal(wav.length, 50);
  assert.equal(Buffer.from(wav.subarray(0, 4)).toString("ascii"), "RIFF");
  assert.equal(view.getUint32(4, true), 42);
  assert.equal(view.getUint32(28, true), 32000);
  assert.equal(view.getUint32(40, true), 6);
});

test("parseWav skips unknown chunks before data", () => {
  const base = makePcmWav(new Int16Array([7, 8]), 16000);
  const extra = new Uint8Array([
    ...Buffer.from("LIST"),
    3,
    0,
    0,
    0,
    1,
    2,
    3,
    0,
  ]);
  const wav = new Uint8Array([
    ...base.subarray(0, 36),
    ...extra,
    ...base.subarray(36),
  ]);
  const parsed = parseWav(wav);
  assert.ok(parsed.ok);
  assert.deepEqual(Array.from(parsed.wav.pcm), [7, 8]);
});

test("a 44.1 kHz or stereo WAV parses but is not speech audio", () => {
  const cd = parseWav(header(44100, 1, 16));
  const stereo = parseWav(header(16000, 2, 16));
  assert.ok(cd.ok && stereo.ok);
  assert.equal(isSpeechWav(cd.wav), false);
  assert.equal(isSpeechWav(stereo.wav), false);
  assert.equal(
    isSpeechWav({ sampleRate: 16000, channels: 1, bitsPerSample: 24 }),
    false,
  );
});

test("non-PCM or non-16-bit data is a typed unsupported-format error", () => {
  for (const wav of [header(16000, 1, 16, 3), header(16000, 1, 8)]) {
    const parsed = parseWav(wav);
    assert.ok(!parsed.ok);
    assert.equal(parsed.error.code, "unsupported-format");
  }
});

test("garbage and headerless buffers are typed errors", () => {
  const notWav = parseWav(Buffer.from("definitely not a wav file"));
  assert.ok(!notWav.ok);
  assert.equal(notWav.error.code, "not-riff-wave");
  const noData = parseWav(makePcmWav(new Int16Array(0), 16000).subarray(0, 36));
  assert.ok(!noData.ok);
  assert.equal(noData.error.code, "missing-data");
});
