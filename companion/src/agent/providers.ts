import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";
import { distCliPath } from "../config.js";

export interface ResolvedModel {
  model: LanguageModel;
  label: string;
}

export interface ProviderChoice {
  provider?: string;
  model?: string;
  apiKey?: string;
  ollamaBaseUrl?: string;
}

const DEFAULT_OPENROUTER_MODEL = "anthropic/claude-sonnet-4.5";
const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-5";
const DEFAULT_OPENAI_MODEL = "gpt-5.2";
const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434/v1";

export function noBrainError(): Error {
  return new Error(
    [
      "no AI brain configured. Pick one:",
      "  • OpenRouter (recommended — one key, hundreds of models): set OPENROUTER_API_KEY",
      "  • Anthropic: set ANTHROPIC_API_KEY",
      "  • OpenAI: set OPENAI_API_KEY",
      "  • Ollama (local, no key): --provider ollama --model <name>, e.g. --model qwen3",
      "  • or use your Claude Code / Codex subscription via MCP:",
      `      claude mcp add factorio -- node ${distCliPath()} mcp`,
      `      codex mcp add factorio -- node ${distCliPath()} mcp`,
      "Run `npx agentic-factorio setup` for a guided walkthrough.",
    ].join("\n"),
  );
}

/** Builds the LanguageModel for the chosen (or auto-detected) provider.
 *  Key precedence per provider: explicit apiKey > its env var. */
export function resolveModel(choice: ProviderChoice = {}): ResolvedModel {
  const provider = choice.provider ?? autoPickProvider(choice);

  switch (provider) {
    case "openrouter": {
      const apiKey = choice.apiKey ?? process.env.OPENROUTER_API_KEY;
      if (!apiKey) throw new Error("provider is openrouter but no key found — set OPENROUTER_API_KEY or re-run setup");
      const id = choice.model ?? DEFAULT_OPENROUTER_MODEL;
      return { model: createOpenRouter({ apiKey }).chat(id), label: `openrouter/${id}` };
    }
    case "anthropic": {
      const apiKey = choice.apiKey ?? process.env.ANTHROPIC_API_KEY;
      if (!apiKey) throw new Error("provider is anthropic but no key found — set ANTHROPIC_API_KEY or re-run setup");
      const id = choice.model ?? DEFAULT_ANTHROPIC_MODEL;
      return { model: createAnthropic({ apiKey })(id), label: `anthropic/${id}` };
    }
    case "openai": {
      const apiKey = choice.apiKey ?? process.env.OPENAI_API_KEY;
      if (!apiKey) throw new Error("provider is openai but no key found — set OPENAI_API_KEY or re-run setup");
      const id = choice.model ?? DEFAULT_OPENAI_MODEL;
      return { model: createOpenAI({ apiKey })(id), label: `openai/${id}` };
    }
    case "ollama": {
      if (!choice.model) {
        throw new Error(
          "ollama needs an explicit model — pass --model <name> (e.g. --model qwen3). Pick one that supports tool calling.",
        );
      }
      const baseURL = choice.ollamaBaseUrl ?? DEFAULT_OLLAMA_BASE_URL;
      const ollama = createOpenAI({ baseURL, apiKey: "ollama", name: "ollama" });
      // Ollama's OpenAI-compatible endpoint only implements chat completions.
      return { model: ollama.chat(choice.model), label: `ollama/${choice.model}` };
    }
    default:
      throw new Error(
        `unknown provider "${provider}" — expected one of: openrouter, anthropic, openai, ollama`,
      );
  }
}

function autoPickProvider(choice: ProviderChoice): string {
  if (choice.apiKey ?? process.env.OPENROUTER_API_KEY) return "openrouter";
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (process.env.OPENAI_API_KEY) return "openai";
  throw noBrainError();
}
