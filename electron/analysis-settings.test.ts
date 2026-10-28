import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { afterEach, beforeEach } from "node:test";

import { DEFAULT_ANALYSIS_PROVIDER_SETTINGS, type AnalysisProviderSettings } from "../common/analysis-provider";
import { AnalysisSettingsStore, type KeyCipher } from "./analysis-settings";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "sr-settings-"));
  file = path.join(dir, "nested", "analysis-provider.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Reversible stand-in for the OS keychain: the "ciphertext" differs from the plaintext. */
const cipher = (available = true): KeyCipher => ({
  available: () => available,
  encrypt: (plain) => Buffer.from(`enc:${plain}`).toString("base64"),
  decrypt: (encrypted) => {
    const plain = Buffer.from(encrypted, "base64").toString();
    if (!plain.startsWith("enc:")) throw new Error("bad ciphertext");
    return plain.slice(4);
  },
});

const custom = (patch: Partial<AnalysisProviderSettings> = {}): AnalysisProviderSettings => ({
  ...DEFAULT_ANALYSIS_PROVIDER_SETTINGS,
  mode: "custom",
  baseUrl: "https://api.example.com/v1",
  model: "vision-1",
  ...patch,
});

test("defaults to Copilot when nothing is saved", () => {
  const store = new AnalysisSettingsStore(file, cipher(), {});
  assert.deepEqual(store.status(), {
    settings: DEFAULT_ANALYSIS_PROVIDER_SETTINGS,
    hasApiKey: false,
    secureStorage: true,
    envOverride: false,
  });
  assert.equal(store.provider(), null);
});

test("saves a custom provider, encrypts the key, and survives a restart", () => {
  const first = new AnalysisSettingsStore(file, cipher(), {});
  const result = first.save({ settings: custom(), apiKey: "sk-secret" });
  assert.equal(result.ok, true);
  assert.equal(result.status.hasApiKey, true);
  assert.ok(!JSON.stringify(result).includes("sk-secret"), "the key is never returned");

  const onDisk = readFileSync(file, "utf8");
  assert.ok(!onDisk.includes("sk-secret"), "the key is never written in clear");

  const second = new AnalysisSettingsStore(file, cipher(), {});
  const provider = second.provider();
  assert.ok(provider);
  assert.equal(provider.provider.apiKey, "sk-secret");
  assert.equal(provider.provider.baseUrl, "https://api.example.com/v1");
  assert.equal(provider.model, "vision-1");
});

test("an empty key field keeps the saved key; null removes it", () => {
  const store = new AnalysisSettingsStore(file, cipher(), {});
  store.save({ settings: custom(), apiKey: "sk-secret" });
  assert.equal(store.save({ settings: custom({ model: "vision-2" }) }).status.hasApiKey, true);
  assert.equal(store.provider()?.provider.apiKey, "sk-secret");
  assert.equal(store.provider()?.model, "vision-2");

  const removed = store.save({ settings: custom(), apiKey: null });
  assert.equal(removed.status.hasApiKey, false);
  assert.equal("apiKey" in (store.provider()?.provider ?? {}), false);
});

test("switching back to Copilot keeps the saved details but selects no provider", () => {
  const store = new AnalysisSettingsStore(file, cipher(), {});
  store.save({ settings: custom(), apiKey: "sk-secret" });
  const result = store.save({ settings: { ...custom(), mode: "copilot" } });
  assert.equal(result.ok, true);
  assert.equal(store.provider(), null);
  assert.equal(result.status.settings.baseUrl, "https://api.example.com/v1");
  assert.equal(result.status.hasApiKey, true);
});

test("an incomplete or unsafe custom provider is rejected and nothing is written", () => {
  const store = new AnalysisSettingsStore(file, cipher(), {});
  for (const [settings, expected] of [
    [custom({ baseUrl: "" }), /Base URL is required/],
    [custom({ model: "  " }), /Model is required/],
    [custom({ baseUrl: "http://api.example.com" }), /https/],
    [custom({ type: "anthropic", wireApi: "responses" }), /Wire API does not apply/],
    [custom({ azureApiVersion: "2024-10-21" }), /Azure API version only applies/],
  ] as const) {
    const result = store.save({ settings, apiKey: "sk-secret" });
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", expected);
    assert.ok(!(result.error ?? "").includes("sk-secret"));
  }
  assert.equal(store.status().hasApiKey, false);
  assert.throws(() => readFileSync(file, "utf8"), /ENOENT/);
});

test("without OS encryption a key is refused rather than stored in clear", () => {
  const store = new AnalysisSettingsStore(file, cipher(false), {});
  const result = store.save({ settings: custom(), apiKey: "sk-secret" });
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /can't encrypt/);
  assert.equal(result.status.secureStorage, false);
  // A local server needs no key, so it can still be saved.
  assert.equal(store.save({ settings: custom({ baseUrl: "http://localhost:11434/v1" }) }).ok, true);
});

test("environment variables take priority over saved settings", () => {
  const env = {
    SKILL_RECORDER_PROVIDER_BASE_URL: "https://env.example.com",
    SKILL_RECORDER_PROVIDER_MODEL: "env-model",
  };
  const store = new AnalysisSettingsStore(file, cipher(), env);
  store.save({ settings: custom(), apiKey: "sk-secret" });
  assert.equal(store.status().envOverride, true);
  assert.equal(store.provider()?.model, "env-model");
  assert.equal(store.provider()?.provider.baseUrl, "https://env.example.com");
});

test("a key that can't be decrypted explains how to recover", () => {
  const store = new AnalysisSettingsStore(file, cipher(), {});
  store.save({ settings: custom(), apiKey: "sk-secret" });
  const broken = new AnalysisSettingsStore(
    file,
    { ...cipher(), decrypt: () => { throw new Error("keychain locked"); } },
    {},
  );
  assert.throws(() => broken.provider(), /enter it again/);
});

test("a corrupt settings file falls back to Copilot and is rewritten by the next save", () => {
  const store = new AnalysisSettingsStore(file, cipher(), {});
  store.save({ settings: custom() });
  writeFileSync(file, "{ not json");
  const reread = new AnalysisSettingsStore(file, cipher(), {});
  assert.equal(reread.provider(), null);
  assert.equal(reread.save({ settings: custom() }).ok, true);
  assert.equal(new AnalysisSettingsStore(file, cipher(), {}).provider()?.model, "vision-1");
});

test("unknown values in the file are ignored", () => {
  const store = new AnalysisSettingsStore(file, cipher(), {});
  store.save({ settings: custom() });
  writeFileSync(
    file,
    JSON.stringify({ version: 1, settings: { mode: "other", type: "gemini", wireApi: "grpc", baseUrl: 5 } }),
  );
  const status = new AnalysisSettingsStore(file, cipher(), {}).status();
  assert.deepEqual(status.settings, DEFAULT_ANALYSIS_PROVIDER_SETTINGS);
});

test("candidate() builds the provider a draft would use without saving it", () => {
  const store = new AnalysisSettingsStore(file, cipher(), {});
  store.save({ settings: custom(), apiKey: "sk-saved" });

  // Untouched key field: the saved key is used. A typed key wins. null tests without one.
  assert.equal(store.candidate({ settings: custom({ model: "draft" }) }).provider.apiKey, "sk-saved");
  assert.equal(store.candidate({ settings: custom({ model: "draft" }) }).model, "draft");
  assert.equal(store.candidate({ settings: custom(), apiKey: "sk-typed" }).provider.apiKey, "sk-typed");
  assert.equal("apiKey" in store.candidate({ settings: custom(), apiKey: null }).provider, false);

  // Nothing was persisted by testing.
  assert.equal(store.provider()?.model, "vision-1");
  assert.equal(store.provider()?.provider.apiKey, "sk-saved");
});

test("candidate() rejects Copilot mode and invalid drafts with field-level messages", () => {
  const store = new AnalysisSettingsStore(file, cipher(), {});
  assert.throws(() => store.candidate({ settings: DEFAULT_ANALYSIS_PROVIDER_SETTINGS }), /My own model provider/);
  assert.throws(() => store.candidate({ settings: custom({ baseUrl: "" }) }), /Base URL is required/);
  assert.throws(() => store.candidate({ settings: custom({ baseUrl: "http://api.example.com" }) }), /https/);
});
