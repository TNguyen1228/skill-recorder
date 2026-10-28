import assert from "node:assert/strict";
import test from "node:test";
import { providerSessionOptions, resolveAnalysisProvider } from "./analysis-provider";

const env = (vars: Record<string, string>) =>
  Object.fromEntries(Object.entries(vars).map(([k, v]) => [`SKILL_RECORDER_PROVIDER_${k}`, v]));

test("no provider variables selects Copilot", () => {
  assert.equal(resolveAnalysisProvider({}), null);
  assert.equal(resolveAnalysisProvider(env({ MODEL: "  " })), null);
  assert.deepEqual(providerSessionOptions(null), {});
});

test("an OpenAI-compatible endpoint defaults the type and keeps the key out of the label", () => {
  const selected = resolveAnalysisProvider(
    env({ BASE_URL: "https://api.example.com/v1", MODEL: "gpt-x", API_KEY: "sk-secret" }),
  );
  assert.ok(selected);
  assert.equal(selected.provider.type, "openai");
  assert.equal(selected.provider.baseUrl, "https://api.example.com/v1");
  assert.equal(selected.provider.apiKey, "sk-secret");
  assert.equal(selected.label, "openai · api.example.com · gpt-x");
  assert.ok(!selected.label.includes("sk-secret"));
  assert.deepEqual(providerSessionOptions(selected), { provider: selected.provider, model: "gpt-x" });
});

test("local servers may use plain http without a key", () => {
  for (const host of ["localhost:11434", "127.0.0.1:1234", "[::1]:8080"]) {
    const selected = resolveAnalysisProvider(env({ BASE_URL: `http://${host}/v1`, MODEL: "llava" }));
    assert.ok(selected, host);
    assert.equal("apiKey" in selected.provider, false);
  }
});

test("plain http to a non-loopback host is rejected", () => {
  assert.throws(
    () => resolveAnalysisProvider(env({ BASE_URL: "http://api.example.com/v1", MODEL: "m", API_KEY: "k" })),
    /https/,
  );
  assert.throws(() => resolveAnalysisProvider(env({ BASE_URL: "ftp://example.com", MODEL: "m" })), /https/);
  assert.throws(() => resolveAnalysisProvider(env({ BASE_URL: "not a url", MODEL: "m" })), /valid URL/);
});

test("a partial configuration fails instead of falling back to Copilot", () => {
  assert.throws(() => resolveAnalysisProvider(env({ MODEL: "m" })), /BASE_URL is required/);
  assert.throws(() => resolveAnalysisProvider(env({ API_KEY: "k" })), /BASE_URL is required/);
  assert.throws(() => resolveAnalysisProvider(env({ BASE_URL: "https://api.example.com" })), /MODEL is required/);
});

test("type, wire API and Azure version are validated per provider", () => {
  const base = { BASE_URL: "https://example.com", MODEL: "m" };
  assert.equal(resolveAnalysisProvider(env({ ...base, TYPE: "Anthropic" }))?.provider.type, "anthropic");
  assert.throws(() => resolveAnalysisProvider(env({ ...base, TYPE: "bedrock" })), /TYPE must be one of/);
  assert.equal(resolveAnalysisProvider(env({ ...base, WIRE_API: "responses" }))?.provider.wireApi, "responses");
  assert.throws(() => resolveAnalysisProvider(env({ ...base, WIRE_API: "grpc" })), /WIRE_API must be one of/);
  assert.throws(() => resolveAnalysisProvider(env({ ...base, TYPE: "anthropic", WIRE_API: "responses" })), /anthropic/);
  assert.deepEqual(
    resolveAnalysisProvider(env({ ...base, TYPE: "azure", AZURE_API_VERSION: "2024-10-21" }))?.provider.azure,
    { apiVersion: "2024-10-21" },
  );
  assert.throws(() => resolveAnalysisProvider(env({ ...base, AZURE_API_VERSION: "2024-10-21" })), /only applies to azure/);
});

test("validation errors never echo the API key", () => {
  assert.throws(
    () => resolveAnalysisProvider(env({ BASE_URL: "http://api.example.com", MODEL: "m", API_KEY: "sk-secret" })),
    (err: Error) => !err.message.includes("sk-secret"),
  );
});
