import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  DEFAULT_ANALYSIS_PROVIDER_SETTINGS,
  type AnalysisProviderSaveInput,
  type AnalysisProviderSaveResult,
  type AnalysisProviderSettings,
  type AnalysisProviderStatus,
} from "../common/analysis-provider";
import {
  buildAnalysisProvider,
  resolveAnalysisProvider,
  SETTINGS_FIELD_NAMES,
  type AnalysisProvider,
  type ProviderEnv,
} from "./analysis-provider";

/** Encrypts the API key at rest. Backed by the OS keychain (Electron `safeStorage`). */
export interface KeyCipher {
  available(): boolean;
  encrypt(plain: string): string;
  decrypt(encrypted: string): string;
}

interface PersistedFile {
  version: 1;
  settings: AnalysisProviderSettings;
  /** Base64 ciphertext; the key is never written in clear. */
  apiKey?: string;
}

const MAX_KEY_LENGTH = 4096;

const msg = (err: unknown) => (err instanceof Error ? err.message : String(err));

function sanitize(raw: unknown): AnalysisProviderSettings {
  const d = DEFAULT_ANALYSIS_PROVIDER_SETTINGS;
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const str = (v: unknown, fallback: string) => (typeof v === "string" ? v : fallback);
  const mode = r.mode === "custom" ? "custom" : "copilot";
  const type = r.type === "azure" || r.type === "anthropic" ? r.type : "openai";
  const wireApi = r.wireApi === "completions" || r.wireApi === "responses" ? r.wireApi : "";
  return {
    mode,
    type,
    baseUrl: str(r.baseUrl, d.baseUrl).trim(),
    model: str(r.model, d.model).trim(),
    wireApi,
    azureApiVersion: str(r.azureApiVersion, d.azureApiVersion).trim(),
  };
}

/**
 * Where the model for analysis and the builders is chosen. Persists the choice to
 * one JSON file and keeps the API key encrypted via the OS. Environment variables
 * (`SKILL_RECORDER_PROVIDER_*`) override the saved choice, for CI and power users.
 */
export class AnalysisSettingsStore {
  private cache: PersistedFile | null = null;

  constructor(
    private readonly file: string,
    private readonly cipher: KeyCipher,
    private readonly env: ProviderEnv = process.env,
  ) {}

  status(): AnalysisProviderStatus {
    const data = this.load();
    return {
      settings: data.settings,
      hasApiKey: Boolean(data.apiKey),
      secureStorage: this.cipher.available(),
      envOverride: this.envConfigured(),
    };
  }

  /** Validate, then persist. A custom provider must be complete and valid. */
  save(input: AnalysisProviderSaveInput): AnalysisProviderSaveResult {
    const fail = (error: string): AnalysisProviderSaveResult => ({ ok: false, status: this.status(), error });
    const settings = sanitize(input.settings);
    const prior = this.load();
    let apiKey = prior.apiKey;

    if (input.apiKey === null) apiKey = undefined;
    else if (typeof input.apiKey === "string" && input.apiKey.trim()) {
      const plain = input.apiKey.trim();
      if (plain.length > MAX_KEY_LENGTH) return fail("That API key is too long.");
      if (!this.cipher.available()) {
        return fail(
          "This computer can't encrypt the API key, so it won't be saved. Set SKILL_RECORDER_PROVIDER_API_KEY instead.",
        );
      }
      try {
        apiKey = this.cipher.encrypt(plain);
      } catch (err) {
        return fail(`Could not encrypt the API key: ${msg(err)}`);
      }
    } else if (input.apiKey !== undefined && typeof input.apiKey !== "string") {
      return fail("Invalid API key.");
    }

    if (settings.mode === "custom") {
      try {
        buildAnalysisProvider(this.fields(settings), SETTINGS_FIELD_NAMES);
      } catch (err) {
        return fail(msg(err));
      }
    }

    const next: PersistedFile = { version: 1, settings, ...(apiKey ? { apiKey } : {}) };
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (err) {
      return fail(`Could not save settings: ${msg(err)}`);
    }
    this.cache = next;
    return { ok: true, status: this.status() };
  }

  /**
   * The provider the agent features should use right now, or null for Copilot.
   * Throws a readable error when the environment or the saved choice is invalid.
   */
  provider(): AnalysisProvider | null {
    if (this.envConfigured()) return resolveAnalysisProvider(this.env);
    const data = this.load();
    if (data.settings.mode !== "custom") return null;
    return buildAnalysisProvider({ ...this.fields(data.settings), apiKey: this.savedKey() }, SETTINGS_FIELD_NAMES);
  }

  /**
   * The provider a not-yet-saved draft would use, for "Test connection". A typed key
   * wins, no key (null) tests without one, and leaving it untouched uses the saved key.
   */
  candidate(input: AnalysisProviderSaveInput): AnalysisProvider {
    const settings = sanitize(input.settings);
    if (settings.mode !== "custom") throw new Error("Choose “My own model provider” to test it.");
    const typed = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
    const apiKey = typed || (input.apiKey === undefined ? this.savedKey() : undefined);
    return buildAnalysisProvider({ ...this.fields(settings), apiKey }, SETTINGS_FIELD_NAMES);
  }

  private savedKey(): string | undefined {
    const encrypted = this.load().apiKey;
    if (!encrypted) return undefined;
    try {
      return this.cipher.decrypt(encrypted);
    } catch {
      throw new Error("The saved API key couldn't be read on this computer. Open Settings and enter it again.");
    }
  }

  private fields(s: AnalysisProviderSettings) {
    return {
      baseUrl: s.baseUrl,
      model: s.model,
      type: s.type,
      wireApi: s.wireApi,
      azureApiVersion: s.azureApiVersion,
    };
  }

  private envConfigured(): boolean {
    return Object.keys(this.env).some((k) => k.startsWith("SKILL_RECORDER_PROVIDER_") && this.env[k]?.trim());
  }

  private load(): PersistedFile {
    if (this.cache) return this.cache;
    let loaded: PersistedFile = { version: 1, settings: { ...DEFAULT_ANALYSIS_PROVIDER_SETTINGS } };
    if (existsSync(this.file)) {
      try {
        const raw = JSON.parse(readFileSync(this.file, "utf8")) as Partial<PersistedFile>;
        loaded = {
          version: 1,
          settings: sanitize(raw.settings),
          ...(typeof raw.apiKey === "string" && raw.apiKey ? { apiKey: raw.apiKey } : {}),
        };
      } catch {
        // A corrupt file falls back to defaults (Copilot); the next save rewrites it.
      }
    }
    this.cache = loaded;
    return loaded;
  }
}

let active: AnalysisSettingsStore | null = null;

/** Register the app's store so every agent feature resolves the same provider. */
export function setAnalysisSettingsStore(store: AnalysisSettingsStore | null): void {
  active = store;
}

/** The provider to use for the next agent session: Settings/environment, else null (Copilot). */
export function currentAnalysisProvider(): AnalysisProvider | null {
  return active ? active.provider() : resolveAnalysisProvider();
}
