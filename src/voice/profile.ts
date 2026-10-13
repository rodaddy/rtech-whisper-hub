/**
 * Skippy's server-side voice profile: the reference clip (ref.wav) and its
 * transcript (ref.txt) that OmniVoice clones from. Ported from the desktop
 * sibling's load_voice_profile (rtech-whisper server/agent/src/voice_agent/config.py).
 * Load it once at startup and hand the result to the synthesis route.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface VoiceProfile {
  /** ref.wav, base64-encoded, as OmniVoice's audio_base64 field. */
  audioBase64: string;
  /** ref.txt, trimmed, as OmniVoice's prompt_text field. */
  promptText: string;
}

export type VoiceProfileErrorCode =
  "not_configured" | "missing_files" | "malformed";

export type VoiceProfileResult =
  | { ok: true; profile: VoiceProfile }
  | { ok: false; code: VoiceProfileErrorCode; message: string };

async function readOrNull(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Read ref.wav and ref.txt from `dir`. Messages name files, never contents. */
export async function loadVoiceProfile(
  dir: string | undefined,
): Promise<VoiceProfileResult> {
  if (!dir) {
    return {
      ok: false,
      code: "not_configured",
      message: "VOICE_PROFILE_DIR is not set",
    };
  }
  const [wav, txt] = await Promise.all([
    readOrNull(join(dir, "ref.wav")),
    readOrNull(join(dir, "ref.txt")),
  ]);
  const missing = [...(wav ? [] : ["ref.wav"]), ...(txt ? [] : ["ref.txt"])];
  if (!wav || !txt) {
    return {
      ok: false,
      code: "missing_files",
      message: `voice profile directory ${dir} is missing ${missing.join(" and ")}`,
    };
  }
  const promptText = txt.toString("utf8").trim();
  if (wav.subarray(0, 4).toString("latin1") !== "RIFF" || !promptText) {
    return {
      ok: false,
      code: "malformed",
      message: `voice profile in ${dir} is malformed: ref.wav must be a RIFF WAV and ref.txt non-empty`,
    };
  }
  return {
    ok: true,
    profile: { audioBase64: wav.toString("base64"), promptText },
  };
}
