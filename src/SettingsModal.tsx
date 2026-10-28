import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

import {
  PROVIDER_TYPE_LABELS,
  type AnalysisProviderSettings,
  type AnalysisProviderStatus,
  type AnalysisProviderTestResult,
  type AnalysisProviderType,
  type AnalysisWireApi,
} from "../common/analysis-provider";
import { useModalDialog } from "./use-modal-dialog";

const BASE_URL_HINTS: Record<AnalysisProviderType, string> = {
  openai: "https://api.openai.com/v1  ·  http://localhost:11434/v1 (Ollama)",
  azure: "https://<resource>.openai.azure.com/openai/v1",
  anthropic: "https://api.anthropic.com",
};

export function SettingsModal({
  onClose,
  onSaved,
  restoreFocus,
}: {
  onClose: () => void;
  onSaved: (message: string) => void;
  restoreFocus: () => void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const id = useId();
  useModalDialog(dialog, onClose, restoreFocus);

  const [status, setStatus] = useState<AnalysisProviderStatus | null>(null);
  const [draft, setDraft] = useState<AnalysisProviderSettings | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [removeKey, setRemoveKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<AnalysisProviderTestResult | null>(null);
  const testingRef = useRef(false);

  // Closing the dialog mid-test stops the throwaway agent session.
  useEffect(
    () => () => {
      if (testingRef.current) void window.skillRecorder.cancelAnalysisProviderTest();
    },
    [],
  );

  useEffect(() => {
    let live = true;
    window.skillRecorder
      .analysisProviderStatus()
      .then((s) => {
        if (!live) return;
        setStatus(s);
        setDraft(s.settings);
      })
      .catch(() => live && setError("Could not load the current settings."));
    return () => {
      live = false;
    };
  }, []);

  // Any edit makes an earlier test result stale.
  const patch = (next: Partial<AnalysisProviderSettings>) => {
    setTestResult(null);
    setDraft((d) => (d ? { ...d, ...next } : d));
  };

  /** undefined = keep the saved key, null = remove it, string = the typed key. */
  const pendingKey = removeKey ? null : apiKey.trim() ? apiKey.trim() : undefined;

  const runTest = async () => {
    if (!draft || testing || saving) return;
    testingRef.current = true;
    setTesting(true);
    setTestResult(null);
    setError(null);
    try {
      const result = await window.skillRecorder.testAnalysisProvider({ settings: draft, apiKey: pendingKey });
      if (!result.cancelled) setTestResult(result);
    } catch (err) {
      setTestResult({ ok: false, message: err instanceof Error ? err.message : "The test could not run." });
    } finally {
      testingRef.current = false;
      setTesting(false);
    }
  };

  const save = async () => {
    if (!draft || saving) return;
    setSaving(true);
    setError(null);
    try {
      const result = await window.skillRecorder.saveAnalysisProvider({ settings: draft, apiKey: pendingKey });
      setStatus(result.status);
      if (!result.ok) {
        setError(result.error ?? "Could not save the settings.");
        return;
      }
      setApiKey("");
      onSaved(
        draft.mode === "custom"
          ? `The next analysis will use ${draft.model} from your own provider.`
          : "The next analysis will use GitHub Copilot.",
      );
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the settings.");
    } finally {
      setSaving(false);
    }
  };

  const custom = draft?.mode === "custom";
  const keySaved = Boolean(status?.hasApiKey) && !removeKey;

  return createPortal(
    <div className="sheet-backdrop" onClick={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <div
        ref={dialog}
        className="sheet settings-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
      >
        <div className="sheet-head">
          <h2 id={titleId}>Settings</h2>
          <button className="ghost" onClick={onClose}>Close</button>
        </div>
        <p className="sheet-lead" id={descriptionId}>
          Choose the model that analyzes your recordings and builds skills and automations.
          Changes apply to the next analysis or build.
        </p>

        {error && <p className="sheet-caution" role="alert">{error}</p>}
        {status?.envOverride && (
          <p className="sheet-caution" role="status">
            <code>SKILL_RECORDER_PROVIDER_*</code> environment variables are set and take priority over
            what you save here. Unset them to use these settings.
          </p>
        )}

        {!draft ? (
          <p className="sheet-note">{error ? "" : "Loading…"}</p>
        ) : (
          <fieldset className="settings-group" disabled={testing}>
            <legend className="settings-legend">Analysis model</legend>
            <label className={`settings-choice${!custom ? " on" : ""}`}>
              <input
                type="radio"
                name={`${id}-mode`}
                checked={!custom}
                onChange={() => patch({ mode: "copilot" })}
              />
              <span>
                <strong>GitHub Copilot</strong>
                <span className="settings-hint">Default. Sign in with your GitHub account when asked.</span>
              </span>
            </label>
            <label className={`settings-choice${custom ? " on" : ""}`}>
              <input
                type="radio"
                name={`${id}-mode`}
                checked={custom}
                onChange={() => patch({ mode: "custom" })}
              />
              <span>
                <strong>My own model provider</strong>
                <span className="settings-hint">
                  OpenAI-compatible APIs (including local Ollama or LM Studio), Azure OpenAI, or Anthropic.
                  No Copilot sign-in needed.
                </span>
              </span>
            </label>

            {custom && (
              <div className="settings-custom">
                <div className="settings-field">
                  <label htmlFor={`${id}-type`}>Provider</label>
                  <select
                    id={`${id}-type`}
                    className="fb-input"
                    value={draft.type}
                    onChange={(e) => {
                      const type = e.target.value as AnalysisProviderType;
                      patch({
                        type,
                        wireApi: type === "anthropic" ? "" : draft.wireApi,
                        azureApiVersion: type === "azure" ? draft.azureApiVersion : "",
                      });
                    }}
                  >
                    {(Object.keys(PROVIDER_TYPE_LABELS) as AnalysisProviderType[]).map((t) => (
                      <option key={t} value={t}>{PROVIDER_TYPE_LABELS[t]}</option>
                    ))}
                  </select>
                </div>
                <div className="settings-field">
                  <label htmlFor={`${id}-url`}>Base URL</label>
                  <input
                    id={`${id}-url`}
                    className="fb-input"
                    type="url"
                    inputMode="url"
                    spellCheck={false}
                    autoComplete="off"
                    placeholder={BASE_URL_HINTS[draft.type]}
                    value={draft.baseUrl}
                    onChange={(e) => patch({ baseUrl: e.target.value })}
                  />
                  <span className="settings-hint">https, or http for localhost only.</span>
                </div>
                <div className="settings-field">
                  <label htmlFor={`${id}-model`}>
                    {draft.type === "azure" ? "Deployment name" : "Model"}
                  </label>
                  <input
                    id={`${id}-model`}
                    className="fb-input"
                    spellCheck={false}
                    autoComplete="off"
                    value={draft.model}
                    onChange={(e) => patch({ model: e.target.value })}
                  />
                  <span className="settings-hint">Must accept images — analysis looks at screen frames.</span>
                </div>
                <div className="settings-field">
                  <label htmlFor={`${id}-key`}>API key</label>
                  <input
                    id={`${id}-key`}
                    className="fb-input"
                    type="password"
                    spellCheck={false}
                    autoComplete="off"
                    disabled={status ? !status.secureStorage : false}
                    placeholder={
                      status && !status.secureStorage
                        ? "Not available on this computer"
                        : keySaved
                          ? "Saved — type to replace"
                          : "Optional for local servers"
                    }
                    value={apiKey}
                    onChange={(e) => {
                      setTestResult(null);
                      setApiKey(e.target.value);
                      if (e.target.value) setRemoveKey(false);
                    }}
                  />
                  {status && !status.secureStorage ? (
                    <span className="settings-hint">
                      This computer can't encrypt the key, so it can't be saved here. Use the
                      {" "}<code>SKILL_RECORDER_PROVIDER_API_KEY</code> environment variable instead.
                    </span>
                  ) : (
                    <span className="settings-hint">
                      Encrypted with your operating system and never shown again.
                      {status?.hasApiKey && (
                        <>
                          {" "}
                          <button
                            type="button"
                            className="linky"
                            onClick={() => {
                              setTestResult(null);
                              setRemoveKey((v) => !v);
                              setApiKey("");
                            }}
                          >
                            {removeKey ? "Keep the saved key" : "Remove the saved key"}
                          </button>
                        </>
                      )}
                    </span>
                  )}
                </div>
                {draft.type !== "anthropic" && (
                  <div className="settings-field">
                    <label htmlFor={`${id}-wire`}>API format</label>
                    <select
                      id={`${id}-wire`}
                      className="fb-input"
                      value={draft.wireApi}
                      onChange={(e) => patch({ wireApi: e.target.value as AnalysisWireApi | "" })}
                    >
                      <option value="">Default (chat completions)</option>
                      <option value="completions">Chat completions</option>
                      <option value="responses">Responses</option>
                    </select>
                  </div>
                )}
                {draft.type === "azure" && (
                  <div className="settings-field">
                    <label htmlFor={`${id}-azure`}>Azure API version</label>
                    <input
                      id={`${id}-azure`}
                      className="fb-input"
                      spellCheck={false}
                      autoComplete="off"
                      placeholder="Optional, e.g. 2024-10-21"
                      value={draft.azureApiVersion}
                      onChange={(e) => patch({ azureApiVersion: e.target.value })}
                    />
                  </div>
                )}
                <p className="sheet-caution">
                  When you choose Analyze or build a skill, the event timeline, screen images, narration
                  text and terminal excerpts are sent to this endpoint instead of GitHub. Only use a
                  provider you trust with your recordings.
                </p>
              </div>
            )}
          </fieldset>
        )}

        {custom && draft && (
          <div className="settings-test" aria-live="polite">
            <div className="settings-test-row">
              <button
                className="ghost"
                onClick={runTest}
                disabled={testing || saving || !draft.baseUrl.trim() || !draft.model.trim()}
                title="Try these settings without saving them"
              >
                Test connection
              </button>
              {testing && (
                <>
                  <span className="spinner" aria-hidden="true" />
                  <span className="settings-hint">Testing — this can take up to a minute…</span>
                  <button className="linky" onClick={() => void window.skillRecorder.cancelAnalysisProviderTest()}>
                    Cancel
                  </button>
                </>
              )}
            </div>
            {testResult && (
              <p
                className={`settings-test-result ${
                  !testResult.ok ? "fail" : testResult.vision === "ok" ? "ok" : "warn"
                }`}
              >
                {testResult.message}
                {testResult.ok && testResult.elapsedMs !== undefined && ` (${(testResult.elapsedMs / 1000).toFixed(1)}s)`}
              </p>
            )}
          </div>
        )}

        <div className="sheet-actions">
          <button className="ghost" onClick={onClose}>Cancel</button>
          <button className="record-cta" onClick={save} disabled={!draft || saving || testing}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
