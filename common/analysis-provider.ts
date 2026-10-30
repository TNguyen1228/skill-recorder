/**
 * Settings for the model that powers analysis and the builders: GitHub Copilot's
 * models (default) or the user's own provider. Shared by the main process and the
 * Settings screen; the API key is deliberately not part of {@link AnalysisProviderSettings}
 * — it travels only on save and is never sent back to the renderer.
 */

export type AnalysisProviderType = "openai" | "azure" | "anthropic";
export type AnalysisWireApi = "completions" | "responses";

export interface AnalysisProviderSettings {
  mode: "copilot" | "custom";
  type: AnalysisProviderType;
  baseUrl: string;
  model: string;
  /** "" = the provider default (completions). openai/azure only. */
  wireApi: AnalysisWireApi | "";
  /** "" = the provider default. azure only. */
  azureApiVersion: string;
}

export const DEFAULT_ANALYSIS_PROVIDER_SETTINGS: AnalysisProviderSettings = {
  mode: "copilot",
  type: "openai",
  baseUrl: "",
  model: "",
  wireApi: "",
  azureApiVersion: "",
};

export interface AnalysisProviderStatus {
  settings: AnalysisProviderSettings;
  /** A key is saved (its value is never returned). */
  hasApiKey: boolean;
  /** The OS can encrypt a key at rest; without it a key cannot be saved. */
  secureStorage: boolean;
  /** SKILL_RECORDER_PROVIDER_* environment variables are set and take priority. */
  envOverride: boolean;
  /** Where Analyze and the builders send recording data now, environment included. */
  destination: AnalysisDestination;
}

/** GitHub Copilot, or the user's own provider (host omitted when its URL is invalid). */
export type AnalysisDestination = { kind: "copilot" } | { kind: "custom"; host?: string };

/** Names the destination in privacy copy. null = not loaded yet, so stay generic. */
export function analysisDestinationName(destination: AnalysisDestination | null): string {
  if (!destination) return "the analysis model";
  if (destination.kind === "copilot") return "GitHub Copilot";
  return destination.host ? `your own model provider (${destination.host})` : "your own model provider";
}

/** Completes "…are " in the privacy copy that says where recording data goes. */
export function analysisSentTo(destination: AnalysisDestination | null): string {
  if (destination?.kind === "copilot") {
    return "sent to GitHub's cloud service for processing by GitHub Copilot";
  }
  return `sent to ${analysisDestinationName(destination)}, as chosen in Settings`;
}

export interface AnalysisProviderSaveInput {
  settings: AnalysisProviderSettings;
  /** undefined = keep the saved key, null = remove it, string = replace it. */
  apiKey?: string | null;
}

export interface AnalysisProviderSaveResult {
  ok: boolean;
  status: AnalysisProviderStatus;
  error?: string;
}

export const PROVIDER_TYPE_LABELS: Record<AnalysisProviderType, string> = {
  openai: "OpenAI-compatible",
  azure: "Azure OpenAI",
  anthropic: "Anthropic",
};

export interface AnalysisProviderTestResult {
  ok: boolean;
  /** One line for the UI: what worked, or what to fix. */
  message: string;
  /** When connected: could the model read a test image? Analysis needs that. */
  vision?: "ok" | "unconfirmed" | "unsupported";
  elapsedMs?: number;
  cancelled?: boolean;
}
