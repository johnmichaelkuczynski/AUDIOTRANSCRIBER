import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";

export type Provider = "openai" | "deepseek" | "anthropic" | "venice";
export type Mode = "cleanup" | "speakers" | "rewrite";

const CLEANUP_SYSTEM_PROMPT = `You are a transcript cleanup assistant. You receive a verbatim audio transcript and return a cleaned version. Your rules:

- Remove filler words: "um", "uh", "er", "ah", "like" (only when used as a filler), "you know", "I mean", "sort of", "kind of" (when used as a hedge).
- Remove false starts, stutters, and self-corrections. Keep only the speaker's final intended phrasing.
- Remove verbatim repetitions of the same word or phrase ("I I I think", "the the the cat" → "I think", "the cat").
- Lightly fix obvious grammar and add reasonable punctuation so the text reads as clean prose.
- Preserve the speaker's meaning, voice, and content exactly. Do not summarize, paraphrase, add commentary, or change what was said.
- Output ONLY the cleaned transcript. No preamble, no explanations, no markdown headers.`;

const REWRITE_SYSTEM_PROMPT = `You are a rewriting assistant. You receive an audio transcript and rewriting instructions from the user. Your rules:

- Follow the user's instructions exactly. If they ask for a specific tone, framing, or characterization, deliver it precisely.
- The output is based on the transcript but is NOT required to be identical to it. You may rephrase, restructure, sharpen, or recast as the instructions demand.
- Preserve the underlying factual content (who said what, what happened) unless the instructions explicitly direct otherwise.
- Output ONLY the rewritten text. No preamble, no explanations, no meta-commentary, no markdown headers.`;

const SPEAKERS_SYSTEM_PROMPT = `You are a professional transcript editor. Convert the raw transcript into a polished, speaker-labeled transcript.

Rules:
- Infer speaker turns from questions, answers, wording, and conversational context.
- Label speakers consistently as "Speaker 1", "Speaker 2", and so on.
- If a person's name or role is explicitly and unambiguously stated in the transcript, include it after the generic label, for example "Speaker 1 (Jordan)". Never invent a name or identity.
- Put every turn on its own paragraph using exactly this format: "Speaker 1: Spoken text"
- Remove filler words, stutters, false starts, and immediate repetitions.
- Add punctuation and paragraph breaks for readability.
- Preserve every substantive statement, meaning, and claim. Do not summarize, omit content, add facts, or editorialize.
- If only one speaker is evident, use "Speaker 1" throughout.
- Output ONLY the formatted transcript. No preamble, explanation, markdown heading, or code fence.`;

function buildUserMessage(mode: Mode, transcript: string, instructions: string | undefined): string {
  if (mode === "cleanup") {
    return `Clean up this transcript:\n\n${transcript}`;
  }
  if (mode === "speakers") {
    return `Format this transcript with consistent speaker labels:\n\n${transcript}`;
  }
  return `Rewriting instructions:\n${instructions ?? ""}\n\n---\n\nTranscript to rewrite:\n\n${transcript}`;
}

function systemPromptFor(mode: Mode): string {
  if (mode === "cleanup") return CLEANUP_SYSTEM_PROMPT;
  if (mode === "speakers") return SPEAKERS_SYSTEM_PROMPT;
  return REWRITE_SYSTEM_PROMPT;
}

async function runOpenAICompatible(args: {
  apiKey: string;
  baseURL?: string;
  model: string;
  system: string;
  user: string;
}): Promise<string> {
  const client = new OpenAI({
    apiKey: args.apiKey,
    ...(args.baseURL ? { baseURL: args.baseURL } : {}),
  });
  const completion = await client.chat.completions.create({
    model: args.model,
    messages: [
      { role: "system", content: args.system },
      { role: "user", content: args.user },
    ],
    temperature: 0.4,
  });
  const text = completion.choices[0]?.message?.content?.trim();
  if (!text) throw new Error("Empty response from provider");
  return text;
}

async function runAnthropic(args: { system: string; user: string }): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
  const client = new Anthropic({ apiKey });
  const message = await client.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 4096,
    system: args.system,
    messages: [{ role: "user", content: args.user }],
  });
  const text = message.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  if (!text) throw new Error("Empty response from Anthropic");
  return text;
}

export async function transformTranscript(args: {
  provider: Provider;
  mode: Mode;
  transcript: string;
  instructions?: string;
}): Promise<string> {
  const system = systemPromptFor(args.mode);
  const user = buildUserMessage(args.mode, args.transcript, args.instructions);

  switch (args.provider) {
    case "openai": {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
      return runOpenAICompatible({
        apiKey,
        model: "gpt-4o-mini",
        system,
        user,
      });
    }
    case "deepseek": {
      const apiKey = process.env.DEEPSEEK_API_KEY;
      if (!apiKey) throw new Error("DEEPSEEK_API_KEY is not set");
      return runOpenAICompatible({
        apiKey,
        baseURL: "https://api.deepseek.com/v1",
        model: "deepseek-chat",
        system,
        user,
      });
    }
    case "venice": {
      const apiKey = process.env.VENICE_API_KEY;
      if (!apiKey) throw new Error("VENICE_API_KEY is not set");
      return runOpenAICompatible({
        apiKey,
        baseURL: "https://api.venice.ai/api/v1",
        model: "llama-3.3-70b",
        system,
        user,
      });
    }
    case "anthropic":
      return runAnthropic({ system, user });
  }
}
