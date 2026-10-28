import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { crc32, deflateSync } from "node:zlib";

import { approveAll, CopilotClient, type Tool } from "@github/copilot-sdk";

import type { AnalysisProviderTestResult } from "../common/analysis-provider";
import type { AnalysisProvider } from "./analysis-provider";
import { copilotConnectionOption, withStartupTimeout } from "./copilot-cli-path";

/**
 * "Test connection" for a custom model provider. It starts a throwaway agent
 * session against the draft settings (nothing is saved) and sends two tiny
 * requests: a text round-trip to prove the endpoint, key and model work, then a
 * solid-colour test image to prove the model can see — analysis reads screen frames,
 * so a text-only model would connect fine and then fail on the first real recording.
 */

/** The slice of the SDK this check uses, so it can be faked in tests. */
export interface TestSession {
  sendAndWait(options: { prompt: string; attachments?: { type: "blob"; data: string; mimeType: string; displayName?: string }[] }, timeoutMs?: number): Promise<{ data: { content: string } } | undefined>;
  abort(): Promise<void>;
  disconnect(): Promise<void>;
}
export interface TestClient {
  start(): Promise<void>;
  createSession(config: Record<string, unknown>): Promise<TestSession>;
  stop(): Promise<unknown>;
}

export interface TestOptions {
  createClient?: () => TestClient;
  signal?: AbortSignal;
  /** Per-request budget. The runtime retries transient failures before giving up. */
  requestTimeoutMs?: number;
}

const REQUEST_TIMEOUT_MS = 45_000;
const MAX_DETAIL = 300;

/** A plain-red PNG, built in place so the check needs no bundled asset. */
export function solidPng(size: number, [r, g, b]: [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const out = Buffer.alloc(8 + data.length + 4);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => [r, g, b]).flat())]);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Strip the API key from text before it is shown or logged, and keep it short. */
function scrub(text: string, apiKey: string | undefined): string {
  // The runtime suggests its own COPILOT_PROVIDER_* variables, which mean nothing here.
  let out = text.replace(/\s+/g, " ").replace(/\s*Check your COPILOT_PROVIDER_\w+(?: or COPILOT_PROVIDER_\w+)?\.?/gi, "").trim();
  if (apiKey) out = out.split(apiKey).join("•••");
  return out.length > MAX_DETAIL ? `${out.slice(0, MAX_DETAIL)}…` : out;
}

/** Turn a raw runtime error into something actionable, keeping the detail. */
export function explainFailure(raw: string, apiKey?: string): string {
  const detail = scrub(raw, apiKey);
  // Network failures first: "ENOTFOUND" contains "not found" and must not read as a 404.
  const hint = /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|fetch failed|network|certificate|did not start/i.test(raw)
    ? "Couldn't reach the server. Check the Base URL and that it is running."
    : /\b(401|403)\b|unauthori[sz]ed|invalid.{0,12}api.?key|incorrect api key|forbidden/i.test(raw)
      ? "The provider rejected the API key."
      : /\b404\b|not.?found|does not exist|unknown model/i.test(raw)
        ? "The endpoint or model wasn't found. Check the Base URL and the model name."
        : /\b429\b|rate.?limit|quota/i.test(raw)
          ? "The provider is rate limiting this key or the quota is used up."
          : "";
  return hint ? `${hint} (${detail})` : detail;
}

export async function testAnalysisProvider(
  selected: AnalysisProvider,
  options: TestOptions = {},
): Promise<AnalysisProviderTestResult> {
  const started = Date.now();
  const timeout = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const apiKey = selected.provider.apiKey;
  const elapsedMs = () => Date.now() - started;
  const cancelled = (): AnalysisProviderTestResult => ({ ok: false, cancelled: true, message: "Test cancelled." });
  if (options.signal?.aborted) return cancelled();

  const workDir = mkdtempSync(path.join(os.tmpdir(), "skill-recorder-test-"));
  const client = (options.createClient ?? defaultClient)();
  let session: TestSession | null = null;
  let aborted = false;
  const onAbort = () => {
    aborted = true;
    void session?.abort().catch(() => undefined);
    void client.stop().catch(() => undefined);
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    await withStartupTimeout(client.start(), "The agent runtime");
    // An allowlist with one inert tool: the agent can't run anything on this machine.
    const noop: Tool = {
      name: "noop",
      description: "Does nothing.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      handler: () => "",
    };
    session = await client.createSession({
      tools: [noop],
      availableTools: ["noop"],
      onPermissionRequest: approveAll,
      workingDirectory: workDir,
      enableHostGitOperations: false,
      infiniteSessions: { enabled: false },
      provider: selected.provider,
      model: selected.model,
    });

    try {
      const reply = await session.sendAndWait({ prompt: "Reply with the single word OK." }, timeout);
      if (!reply?.data.content.trim()) {
        return { ok: false, elapsedMs: elapsedMs(), message: "The model connected but returned an empty answer." };
      }
    } catch (err) {
      if (aborted) return cancelled();
      return { ok: false, elapsedMs: elapsedMs(), message: explainFailure(errorText(err), apiKey) };
    }

    const png = solidPng(64, [220, 30, 30]);
    try {
      const reply = await session.sendAndWait(
        {
          prompt: "What single colour fills this image? Answer with one word.",
          attachments: [{ type: "blob", data: png.toString("base64"), mimeType: "image/png", displayName: "test.png" }],
        },
        timeout,
      );
      const answer = reply?.data.content.toLowerCase() ?? "";
      if (/\bred\b/.test(answer)) {
        return { ok: true, vision: "ok", elapsedMs: elapsedMs(), message: "Connected. The model answered and can read images." };
      }
      return {
        ok: true,
        vision: "unconfirmed",
        elapsedMs: elapsedMs(),
        message:
          "Connected, but the model didn't describe a test image correctly. Analysis reads screen frames, so check that this model accepts images.",
      };
    } catch (err) {
      if (aborted) return cancelled();
      return {
        ok: true,
        vision: "unsupported",
        elapsedMs: elapsedMs(),
        message: `Connected, but the image check failed, so this may be a text-only model. Analysis needs one that accepts images. (${scrub(errorText(err), apiKey)})`,
      };
    }
  } catch (err) {
    if (aborted) return cancelled();
    return { ok: false, elapsedMs: elapsedMs(), message: explainFailure(errorText(err), apiKey) };
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    await session?.disconnect().catch(() => undefined);
    await client.stop().catch(() => undefined);
    rmSync(workDir, { recursive: true, force: true });
  }
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

const defaultClient = (): TestClient => new CopilotClient(copilotConnectionOption()) as unknown as TestClient;
