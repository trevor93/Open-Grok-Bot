import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AdapterContext,
  AdapterDescriptor,
  SpeechClip,
  VoiceCapabilities,
  VoiceInfo,
  VoiceProvider,
  VoiceSynthesizeRequest,
  VoiceVerifyResult,
} from "@rakazo/adapter-kit";
import { MACOS_VOICE_PROVIDER_ID } from "@rakazo/contracts";

export { MACOS_VOICE_PROVIDER_ID };

const SAY_BIN = "/usr/bin/say";
const LIST_VOICES_TIMEOUT_MS = 10_000;
const SPEAK_TIMEOUT_MS = 60_000;
const QUALITY_RANK = { premium: 0, enhanced: 1, standard: 2 } as const;

/** Runs `say` with `args`, writes `stdin` to it, and resolves with its stdout. */
export type SayRunner = (
  args: string[],
  options: { stdin?: string; signal: AbortSignal; timeoutMs: number },
) => Promise<string>;

/** Only an API process running natively on macOS can call `say`; Docker and Linux cannot. */
export function macOsVoiceAvailable(platform = process.platform, bin = SAY_BIN): boolean {
  if (platform !== "darwin") return false;
  try {
    accessSync(bin, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** `say -v ?` lines look like `Zoe (Premium)    en_US    # Hello! My name is Zoe.` */
export function parseMacOsVoices(output: string): VoiceInfo[] {
  const voices: { info: VoiceInfo; rank: number }[] = [];
  for (const line of output.split("\n")) {
    const match = /^(.+?)\s+([a-z]{2,3}[_-][\w-]+)\s+#/.exec(line);
    const name = match?.[1]?.trim();
    if (!match || !name) continue;
    const quality = name.endsWith("(Premium)")
      ? "premium"
      : name.endsWith("(Enhanced)")
        ? "enhanced"
        : "standard";
    voices.push({
      info: { id: name, label: name, description: match[2] },
      rank: QUALITY_RANK[quality],
    });
  }
  return voices
    .sort(
      (left, right) => left.rank - right.rank || left.info.label.localeCompare(right.info.label),
    )
    .map((voice) => voice.info);
}

export class MacOsVoiceProvider implements VoiceProvider {
  constructor(private readonly run: SayRunner = runSay) {}

  describe(): AdapterDescriptor<VoiceCapabilities> {
    return {
      id: MACOS_VOICE_PROVIDER_ID,
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { catalog: true, synthesize: true, transcribe: false },
    };
  }

  async verify(apiKey: string, context: AdapterContext): Promise<VoiceVerifyResult> {
    const voices = await this.listVoices(apiKey, context);
    return voices.length > 0 ? { ok: true } : { ok: false, message: "No macOS voices found." };
  }

  async listVoices(_apiKey: string, context: AdapterContext): Promise<VoiceInfo[]> {
    const output = await this.run(["-v", "?"], {
      signal: context.signal,
      timeoutMs: LIST_VOICES_TIMEOUT_MS,
    });
    return parseMacOsVoices(output);
  }

  async synthesize(request: VoiceSynthesizeRequest, context: AdapterContext): Promise<SpeechClip> {
    const signal = request.signal ?? context.signal;
    const voices = await this.listVoices("", { ...context, signal });
    if (!voices.some((voice) => voice.id === request.voiceId)) {
      throw new Error("That macOS voice is not installed.");
    }
    const dir = await mkdtemp(join(tmpdir(), "rakazo-say-"));
    try {
      const file = join(dir, "speech.wav");
      // Text goes through stdin, so a reply can never be read as a `say` option.
      await this.run(
        [
          "-v",
          request.voiceId,
          "-o",
          file,
          "--file-format=WAVE",
          "--data-format=LEI16@22050",
          "-f",
          "-",
        ],
        { stdin: request.text, signal, timeoutMs: SPEAK_TIMEOUT_MS },
      );
      return { bytes: new Uint8Array(await readFile(file)), mimeType: "audio/wav" };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

function runSay(
  args: string[],
  options: { stdin?: string; signal: AbortSignal; timeoutMs: number },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(SAY_BIN, args, {
      stdio: ["pipe", "pipe", "pipe"],
      signal: AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)]),
      killSignal: "SIGKILL",
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `macOS say exited with ${code}.`));
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(options.stdin ?? "");
  });
}
