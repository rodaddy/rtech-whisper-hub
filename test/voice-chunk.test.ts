import assert from "node:assert/strict";
import { test } from "node:test";
import {
  collapseRepeatedSentences,
  mergeChunkTexts,
  splitPcm,
} from "../src/voice/chunk.ts";

const RATE = 16000;

/** Samples whose value is their own index modulo 2^15, so boundaries are checkable. */
function ramp(seconds: number): Int16Array {
  const pcm = new Int16Array(seconds * RATE);
  for (let i = 0; i < pcm.length; i += 1) pcm[i] = i % 32768;
  return pcm;
}

test("60 s splits into 3 chunks of 25 s stepping 24 s", () => {
  const pcm = ramp(60);
  const chunks = splitPcm(pcm, RATE, { chunkSeconds: 25, overlapSeconds: 1 });
  assert.deepEqual(
    chunks.map((c) => c.length),
    [25 * RATE, 25 * RATE, 12 * RATE],
  );
  assert.equal(chunks[0][0], pcm[0]);
  assert.equal(chunks[1][0], pcm[24 * RATE]);
  assert.equal(chunks[2][0], pcm[48 * RATE]);
  assert.equal(chunks[2][chunks[2].length - 1], pcm[pcm.length - 1]);
  // The last second of chunk 0 is the first second of chunk 1.
  assert.deepEqual(chunks[0].subarray(24 * RATE), chunks[1].subarray(0, RATE));
});

test("defaults to 25 s chunks with 1 s overlap", () => {
  assert.deepEqual(
    splitPcm(ramp(60), RATE).map((c) => c.length),
    [25 * RATE, 25 * RATE, 12 * RATE],
  );
});

test("10 s gives one chunk holding every sample", () => {
  const pcm = ramp(10);
  const chunks = splitPcm(pcm, RATE);
  assert.equal(chunks.length, 1);
  assert.deepEqual(chunks[0], pcm);
});

test("empty input gives zero chunks", () => {
  assert.deepEqual(splitPcm(new Int16Array(0), RATE), []);
});

test("rejects overlap that is not shorter than the chunk", () => {
  assert.throws(
    () => splitPcm(ramp(1), RATE, { chunkSeconds: 5, overlapSeconds: 5 }),
    /timing/,
  );
});

// Expected outputs pinned from running the desktop mergeChunkTexts
// (rtech-whisper origin/main src/helpers/selfHostedDictationTranscription.js) under node.
test("merge drops the overlap exactly as the desktop does", () => {
  assert.equal(
    mergeChunkTexts([
      "the quick brown fox jumps over",
      "Fox jumps over the lazy dog",
    ]),
    "the quick brown fox jumps over the lazy dog",
  );
  assert.equal(
    mergeChunkTexts(["one two three four", "Two, three. Four five"]),
    "one two three four five",
  );
  // Two-word overlap is under the 3-word floor, so it is kept.
  assert.equal(
    mergeChunkTexts(["alpha beta gamma delta", "gamma delta epsilon"]),
    "alpha beta gamma delta gamma delta epsilon",
  );
  assert.equal(mergeChunkTexts(["  ", "hello world"]), "hello world");
});

// Expected outputs pinned from running the desktop collapseRepeatedSentences
// (rtech-whisper origin/main src/helpers/transcriptRepetition.js) under node.
test("collapse matches the desktop output", () => {
  const cases: Array<[string, string]> = [
    ["Thank you. Thank you. Thank you.", "Thank you."],
    ["Hello there. hello, there! Bye.", "Hello there. Bye."],
    ["A. B. A.", "A. B. A."],
    ["One. . One.", "One. ."],
    ["no terminator here", "no terminator here"],
    ["Same? SAME! same", "Same?"],
    ["", ""],
    ["   ", "   "],
    ["Only one sentence.", "Only one sentence."],
  ];
  for (const [input, expected] of cases) {
    assert.equal(
      collapseRepeatedSentences(input),
      expected,
      JSON.stringify(input),
    );
  }
});
