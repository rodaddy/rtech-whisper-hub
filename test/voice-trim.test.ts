import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { trimSilence } from "../src/voice/trim.ts";
import { makePcmWav } from "../src/voice/wav.ts";

const SR = 16000;
type Segment = ["quiet" | "tone" | "hum", number];

/** Deterministic PCM: LCG noise of +/-noiseAmp plus a 440 Hz sine per segment. */
function synth(segments: Segment[], noiseAmp: number): Int16Array {
  let s = 12345;
  const out: number[] = [];
  for (const [kind, ms] of segments) {
    const n = Math.round((ms / 1000) * SR);
    for (let i = 0; i < n; i += 1) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      const noise = noiseAmp ? ((s >>> 16) % (2 * noiseAmp + 1)) - noiseAmp : 0;
      const amp = kind === "tone" ? 8000 : kind === "hum" ? 400 : 0;
      out.push(
        Math.round(amp * Math.sin((2 * Math.PI * 440 * i) / SR)) + noise,
      );
    }
  }
  return Int16Array.from(out);
}

const pcmSha = (pcm: Int16Array) =>
  createHash("sha256").update(makePcmWav(pcm, SR).subarray(44)).digest("hex");

const SPEECH: Segment[] = [
  ["quiet", 1000],
  ["tone", 500],
  ["quiet", 2000],
  ["tone", 700],
  ["quiet", 800],
];
// The 2 s gap holds a quiet hum above the noise floor but below 2.5x it, so
// only the adaptive threshold decides whether the gap is shrunk.
const HUM: Segment[] = [
  ["quiet", 1000],
  ["tone", 500],
  ["hum", 2000],
  ["tone", 700],
  ["quiet", 800],
];

// Pinned numbers come from running the DESKTOP trimSilence
// (ported from the desktop app, github.com/rodaddy/openwhispr, branch rtech-whisper:
// src/helpers/silenceTrim.js) once, under node 24,
// on the same synth() output wrapped by the desktop makePcmWav. sha is the
// sha256 of the trimmed PCM bytes (the desktop WAV minus its 44-byte header).
const DESKTOP = {
  noisy: {
    keptMs: 2230,
    sha: "01e7227a709be35c3ce09730ab03ee3206db73aa4fb291f606953166e8c17e17",
  },
  hum: {
    keptMs: 2230,
    sha: "1477d916ac3df29fda646c62d99623bb9a3d698d5db832d24beb2a6025879e82",
  },
  clean: {
    keptMs: 2230,
    sha: "b62622969965f5589c744e756b6c88362c47d49550a8237ec1b2de9274624cc2",
  },
};

test("noisy speech with a long gap matches the desktop byte for byte", () => {
  const r = trimSilence(synth(SPEECH, 300), SR);
  assert.equal(r.hasSpeech, true);
  assert.equal(r.originalMs, 5000);
  assert.equal(r.keptMs, DESKTOP.noisy.keptMs);
  assert.equal(pcmSha(r.pcm), DESKTOP.noisy.sha);
});

test("a hum below 2.5x the noise floor counts as silence, as on the desktop", () => {
  const r = trimSilence(synth(HUM, 300), SR);
  assert.equal(r.keptMs, DESKTOP.hum.keptMs);
  assert.equal(pcmSha(r.pcm), DESKTOP.hum.sha);
});

test("digital silence falls back to the 0.004 floor and matches the desktop", () => {
  const r = trimSilence(synth(SPEECH, 0), SR);
  assert.equal(r.keptMs, DESKTOP.clean.keptMs);
  assert.equal(pcmSha(r.pcm), DESKTOP.clean.sha);
});

test("pure room noise has no speech and keeps nothing", () => {
  const input = synth([["quiet", 3000]], 300);
  const r = trimSilence(input, SR);
  assert.deepEqual(
    { hasSpeech: r.hasSpeech, keptMs: r.keptMs, originalMs: r.originalMs },
    { hasSpeech: false, keptMs: 0, originalMs: 3000 },
  );
  assert.equal(r.pcm, input);
});

test("empty input is returned untouched", () => {
  const r = trimSilence(new Int16Array(0), SR);
  assert.deepEqual(
    {
      hasSpeech: r.hasSpeech,
      keptMs: r.keptMs,
      originalMs: r.originalMs,
      len: r.pcm.length,
    },
    { hasSpeech: false, keptMs: 0, originalMs: 0, len: 0 },
  );
});
