import type { ProviderConfig } from "@github/copilot-sdk";

/**
 * Optional "bring your own model" backend for every agent feature (Describer, Skill
 * Builder, Automation Builder). By default they run on GitHub Copilot's models. When
 * a custom provider is configured, the same bundled agent runtime talks to that
 * endpoint instead — any OpenAI-compatible API (OpenAI, OpenRouter, vLLM, Ollama,
 * LM Studio…), Azure OpenAI, or Anthropic — and Copilot sign-in is no longer required.
 *
 * It is configured in Settings, or with environment variables (which take priority):
 *
 *   SKILL_RECORDER_PROVIDER_BASE_URL      required; endpoint (https, or http on loopback)
 *   SKILL_RECORDER_PROVIDER_MODEL         required; model / deployment name
 *   SKILL_RECORDER_PROVIDER_TYPE          openai (default) | azure | anthropic
 *   SKILL_RECORDER_PROVIDER_API_KEY       optional for local servers
 *   SKILL_RECORDER_PROVIDER_WIRE_API      completions (default) | responses (openai/azure)
 *   SKILL_RECORDER_PROVIDER_AZURE_API_VERSION  optional (azure)
 *
 * The model must accept images: the Describer inspects screen frames.
 */

export type ProviderEnv = Record<string, string | undefined>;

export interface AnalysisProvider {
  provider: ProviderConfig;
  model: string;
  /** Safe to log or show: never contains the API key. */
  label: string;
}

/** Unvalidated provider fields, from the environment or from saved settings. */
export interface ProviderFields {
  baseUrl?: string;
  model?: string;
  type?: string;
  apiKey?: string;
  wireApi?: string;
  azureApiVersion?: string;
}

type FieldKey = "BASE_URL" | "MODEL" | "TYPE" | "API_KEY" | "WIRE_API" | "AZURE_API_VERSION";

const PREFIX = "SKILL_RECORDER_PROVIDER_";
const TYPES = ["openai", "azure", "anthropic"] as const;
const WIRE_APIS = ["completions", "responses"] as const;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** How a field is named in error messages: the variable for the environment, a label in Settings. */
export const ENV_FIELD_NAMES = (key: FieldKey): string => `${PREFIX}${key}`;
export const SETTINGS_FIELD_NAMES = (key: FieldKey): string =>
  ({
    BASE_URL: "Base URL",
    MODEL: "Model",
    TYPE: "Provider type",
    API_KEY: "API key",
    WIRE_API: "Wire API",
    AZURE_API_VERSION: "Azure API version",
  })[key];

const oneOf = <T extends string>(options: readonly T[], value: string, name: string): T => {
  const match = options.find((o) => o === value.toLowerCase());
  if (!match) throw new Error(`${name} must be one of: ${options.join(", ")}.`);
  return match;
};

/**
 * Validate provider fields and build the SDK config. Throws a message that names the
 * field to fix and never contains the API key.
 */
export function buildAnalysisProvider(
  fields: ProviderFields,
  name: (key: FieldKey) => string = ENV_FIELD_NAMES,
): AnalysisProvider {
  const baseUrl = fields.baseUrl?.trim();
  const model = fields.model?.trim();
  if (!baseUrl) throw new Error(`${name("BASE_URL")} is required.`);
  if (!model) throw new Error(`${name("MODEL")} is required: name the model or deployment to use.`);

  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error(`${name("BASE_URL")} is not a valid URL.`);
  }
  const secure = url.protocol === "https:";
  if (!secure && !(url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))) {
    throw new Error(`${name("BASE_URL")} must use https (plain http is allowed only for localhost).`);
  }

  const providerType = fields.type?.trim() ? oneOf(TYPES, fields.type.trim(), name("TYPE")) : "openai";
  const apiKey = fields.apiKey?.trim();
  const provider: ProviderConfig = { type: providerType, baseUrl, ...(apiKey ? { apiKey } : {}) };
  const wireApi = fields.wireApi?.trim();
  if (wireApi) {
    if (providerType === "anthropic") throw new Error(`${name("WIRE_API")} does not apply to anthropic.`);
    provider.wireApi = oneOf(WIRE_APIS, wireApi, name("WIRE_API"));
  }
  const azureApiVersion = fields.azureApiVersion?.trim();
  if (azureApiVersion) {
    if (providerType !== "azure") throw new Error(`${name("AZURE_API_VERSION")} only applies to azure.`);
    provider.azure = { apiVersion: azureApiVersion };
  }

  return { provider, model, label: `${providerType} · ${url.host} · ${model}` };
}

/**
 * Read the provider configuration from the environment. Returns null when none is
 * set. A partial or invalid configuration throws rather than silently falling back
 * to Copilot and sending a recording somewhere the user did not intend.
 */
export function resolveAnalysisProvider(env: ProviderEnv = process.env): AnalysisProvider | null {
  const read = (key: FieldKey) => env[`${PREFIX}${key}`]?.trim() || undefined;
  const fields: ProviderFields = {
    baseUrl: read("BASE_URL"),
    model: read("MODEL"),
    type: read("TYPE"),
    apiKey: read("API_KEY"),
    wireApi: read("WIRE_API"),
    azureApiVersion: read("AZURE_API_VERSION"),
  };
  if (!Object.values(fields).some(Boolean)) return null;
  if (!fields.baseUrl) throw new Error(`${PREFIX}BASE_URL is required when another ${PREFIX}* variable is set.`);
  return buildAnalysisProvider(fields);
}

/** The session options that route a Copilot-runtime session to a custom provider. */
export function providerSessionOptions(selected: AnalysisProvider | null): { provider?: ProviderConfig; model?: string } {
  return selected ? { provider: selected.provider, model: selected.model } : {};
}
