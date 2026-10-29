import { writeFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { SayRunner } from "./macos-voice.js";
import { MacOsVoiceProvider, macOsVoiceAvailable, parseMacOsVoices } from "./macos-voice.js";

const ctx = {
  operationId: "voice",
  traceId: "voice",
  spaceId: "w",
  userId: "u",
  signal: new AbortController().signal,
};

const LIST = `Karen               en_AU    # Hello! My name is Karen.
Zoe (Premium)       en_US    # Hello! My name is Zoe.
Daniel (English (UK)) en_GB    # Hello! My name is Daniel.
Flo (Enhanced)      en_US    # Hello! My name is Flo.
Fiona               en-scotland # Hello! My name is Fiona.
`;

function fakeSay() {
  return vi.fn<SayRunner>(async (args) => {
    const out = args[args.indexOf("-o") + 1];
    if (args[1] === "?") return LIST;
    if (out) await writeFile(out, "RIFF");
    return "";
  });
}

describe("parseMacOsVoices", () => {
  it("lists premium, then enhanced, then the rest, with the locale", () => {
    const voices = parseMacOsVoices(LIST);
    expect(voices.map((voice) => voice.id)).toEqual([
      "Zoe (Premium)",
      "Flo (Enhanced)",
      "Daniel (English (UK))",
      "Fiona",
      "Karen",
    ]);
    expect(voices[0]?.description).toBe("en_US");
  });
});

describe("macOsVoiceAvailable", () => {
  it("requires macOS and an executable say", () => {
    expect(macOsVoiceAvailable("linux")).toBe(false);
    expect(macOsVoiceAvailable("darwin", "/no/such/say")).toBe(false);
  });
});

describe("MacOsVoiceProvider", () => {
  it("renders WAV and passes the reply on stdin, never as an argument", async () => {
    const run = fakeSay();
    const clip = await new MacOsVoiceProvider(run).synthesize(
      { text: "-o /tmp/owned", voiceId: "Zoe (Premium)", apiKey: "" },
      ctx,
    );
    expect(clip.mimeType).toBe("audio/wav");
    expect(new TextDecoder().decode(clip.bytes)).toBe("RIFF");
    const [args, options] = run.mock.calls[1] ?? [];
    expect(args).not.toContain("-o /tmp/owned");
    expect(args?.slice(-2)).toEqual(["-f", "-"]);
    expect(options?.stdin).toBe("-o /tmp/owned");
  });

  it("refuses a voice that is not installed", async () => {
    const run = fakeSay();
    await expect(
      new MacOsVoiceProvider(run).synthesize({ text: "Hi", voiceId: "Missing", apiKey: "" }, ctx),
    ).rejects.toThrow(/not installed/);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
