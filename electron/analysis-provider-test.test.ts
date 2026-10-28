import assert from "node:assert/strict";
import test from "node:test";
import { inflateSync } from "node:zlib";

import { buildAnalysisProvider } from "./analysis-provider";
import { explainFailure, solidPng, testAnalysisProvider, type TestClient, type TestSession } from "./analysis-provider-test";

const selected = buildAnalysisProvider({
  baseUrl: "https://api.example.com/v1",
  model: "vision-1",
  apiKey: "sk-secret",
});

type Reply = string | Error | ((signal: { aborted: boolean }) => Promise<never>);

/** A scripted stand-in for the agent runtime: one reply per request, in order. */
function fakeClient(replies: Reply[], opts: { startError?: Error } = {}) {
  const log = {
    config: undefined as Record<string, unknown> | undefined,
    sent: [] as { prompt: string; attachments?: { mimeType: string; data: string }[] }[],
    stopped: 0,
    disconnected: 0,
    aborted: 0,
    created: 0,
  };
  const session: TestSession = {
    async sendAndWait(options) {
      log.sent.push(options);
      const next = replies[log.sent.length - 1];
      if (typeof next === "function") return next({ aborted: false });
      if (next instanceof Error) throw next;
      return { data: { content: next ?? "" } };
    },
    async abort() {
      log.aborted++;
    },
    async disconnect() {
      log.disconnected++;
    },
  };
  const client: TestClient = {
    async start() {
      if (opts.startError) throw opts.startError;
    },
    async createSession(config) {
      log.config = config;
      return session;
    },
    async stop() {
      log.stopped++;
    },
  };
  return { log, createClient: () => { log.created++; return client; } };
}

test("a working vision model passes both checks and sends the image as a PNG blob", async () => {
  const { log, createClient } = fakeClient(["OK", "Red"]);
  const result = await testAnalysisProvider(selected, { createClient });
  assert.equal(result.ok, true);
  assert.equal(result.vision, "ok");
  assert.equal(log.sent.length, 2);
  const blob = log.sent[1].attachments?.[0];
  assert.equal(blob?.mimeType, "image/png");
  assert.ok(blob?.data.startsWith("iVBORw0KGgo"), "PNG signature");
  // The session uses the draft provider and can run nothing but an inert tool.
  assert.equal(log.config?.model, "vision-1");
  assert.deepEqual(log.config?.provider, selected.provider);
  assert.deepEqual(log.config?.availableTools, ["noop"]);
  assert.equal(log.disconnected, 1);
  assert.equal(log.stopped, 1);
});

test("a model that answers but misreads the image is connected with vision unconfirmed", async () => {
  const { createClient } = fakeClient(["OK", "I can't see any image."]);
  const result = await testAnalysisProvider(selected, { createClient });
  assert.equal(result.ok, true);
  assert.equal(result.vision, "unconfirmed");
  assert.match(result.message, /accepts images/);
});

test("a text-only model that rejects the image is connected with vision unsupported", async () => {
  const { createClient } = fakeClient(["OK", new Error("400 images are not supported by this model sk-secret")]);
  const result = await testAnalysisProvider(selected, { createClient });
  assert.equal(result.ok, true);
  assert.equal(result.vision, "unsupported");
  assert.match(result.message, /text-only/);
  assert.ok(!result.message.includes("sk-secret"), "the key is scrubbed");
});

test("a rejected key fails the first check with a hint and never echoes the key", async () => {
  const { log, createClient } = fakeClient([new Error("Last error: 401 Unauthorized: invalid key sk-secret")]);
  const result = await testAnalysisProvider(selected, { createClient });
  assert.equal(result.ok, false);
  assert.match(result.message, /rejected the API key/);
  assert.ok(!result.message.includes("sk-secret"));
  assert.equal(log.sent.length, 1, "no image request after a failed connection");
  assert.equal(log.stopped, 1);
});

test("an empty answer is reported as a failure", async () => {
  const { createClient } = fakeClient(["   "]);
  const result = await testAnalysisProvider(selected, { createClient });
  assert.equal(result.ok, false);
  assert.match(result.message, /empty answer/);
});

test("a server that can't be reached explains what to check", async () => {
  const { log, createClient } = fakeClient([], { startError: new Error("connect ECONNREFUSED 127.0.0.1:11434") });
  const result = await testAnalysisProvider(selected, { createClient });
  assert.equal(result.ok, false);
  assert.match(result.message, /Couldn't reach the server/);
  assert.equal(log.stopped, 1);
});

test("cancelling mid-request stops the runtime and reports a cancelled test", async () => {
  const controller = new AbortController();
  const { log, createClient } = fakeClient([
    () =>
      new Promise<never>((_resolve, reject) => {
        controller.abort();
        reject(new Error("aborted by user"));
      }),
  ]);
  const result = await testAnalysisProvider(selected, { createClient, signal: controller.signal });
  assert.equal(result.ok, false);
  assert.equal(result.cancelled, true);
  assert.ok(log.aborted >= 1 && log.stopped >= 1);
});

test("an already-cancelled test never starts the runtime", async () => {
  const controller = new AbortController();
  controller.abort();
  const { log, createClient } = fakeClient(["OK"]);
  const result = await testAnalysisProvider(selected, { createClient, signal: controller.signal });
  assert.equal(result.cancelled, true);
  assert.equal(log.created, 0);
});

test("failure hints cover the common causes and trim long details", () => {
  assert.match(explainFailure("HTTP 404 model not found"), /endpoint or model wasn't found/);
  assert.match(explainFailure("429 rate limit exceeded"), /rate limiting/);
  assert.match(explainFailure("getaddrinfo ENOTFOUND api.example.com"), /Couldn't reach/);
  assert.equal(explainFailure("something else entirely"), "something else entirely");
  assert.ok(explainFailure("x".repeat(2000)).length <= 301);
});

test("the runtime's own env-var advice is dropped from error details", () => {
  const raw = "Authentication failed with provider at http://x/v1 (HTTP 401). Check your COPILOT_PROVIDER_API_KEY or COPILOT_PROVIDER_BEARER_TOKEN.";
  const message = explainFailure(raw);
  assert.match(message, /rejected the API key/);
  assert.ok(!message.includes("COPILOT_PROVIDER"));
});

test("solidPng builds a valid truecolour PNG", () => {
  const png = solidPng(8, [10, 20, 30]);
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.readUInt32BE(16), 8, "width");
  assert.equal(png.readUInt32BE(20), 8, "height");
  const idatLength = png.readUInt32BE(33);
  const pixels = inflateSync(png.subarray(41, 41 + idatLength));
  assert.equal(pixels.length, 8 * (1 + 8 * 3));
  assert.deepEqual([...pixels.subarray(0, 4)], [0, 10, 20, 30]);
  assert.equal(png.subarray(-8, -4).toString("latin1"), "IEND");
});
