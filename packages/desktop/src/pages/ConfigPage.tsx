import { useEffect, useState, type FormEvent, type ReactNode } from "react";

import { getLocalConfig, patchLocalConfig } from "../api";
import type {
  DashboardSnapshot,
  LocalConfigPatch,
  LocalConfigSnapshot,
  LoginStatus,
  QrLoginResponse,
} from "../types";
import { EmptyState, StatusPill } from "../ui/Common";
import { QrGlitch } from "../ui/QrGlitch";

type ConfigSection = "llm" | "memory";

interface LocalConfigDraft {
  llmProvider: string;
  llmApiKey: string;
  removeLlmApiKey: boolean;
  llmModel: string;
  llmBaseUrl: string;
  llmTemperature: string;
  llmMaxTokens: string;
  llmTimeoutMs: string;
  memoryProvider: string;
  memoryApiKey: string;
  removeMemoryApiKey: boolean;
  memoryBaseUrl: string;
  memoryTimeoutMs: string;
  localMaxSearchRows: string;
}

function valueFromNumber(value: number | null) {
  return value === null ? "" : String(value);
}

function optionalNumber(value: string) {
  const normalized = value.trim();
  return normalized ? Number(normalized) : null;
}

function draftFromConfig(config: LocalConfigSnapshot): LocalConfigDraft {
  return {
    llmProvider: config.llm.provider,
    llmApiKey: "",
    removeLlmApiKey: false,
    llmModel: config.llm.model ?? "",
    llmBaseUrl: config.llm.baseUrl,
    llmTemperature: valueFromNumber(config.llm.temperature),
    llmMaxTokens: valueFromNumber(config.llm.maxTokens),
    llmTimeoutMs: valueFromNumber(config.llm.timeoutMs),
    memoryProvider: config.memory.provider,
    memoryApiKey: "",
    removeMemoryApiKey: false,
    memoryBaseUrl: config.memory.baseUrl,
    memoryTimeoutMs: String(config.memory.timeoutMs),
    localMaxSearchRows: valueFromNumber(config.memory.localMaxSearchRows),
  };
}

function secretPatch(value: string, remove: boolean) {
  if (remove) return null;
  const normalized = value.trim();
  return normalized || undefined;
}

function configFileName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

function ConfigField(props: {
  label: string;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <label className={props.wide ? "config-field config-field-wide" : "config-field"}>
      <span className="config-field-label">{props.label}</span>
      {props.children}
    </label>
  );
}

export function ConfigPage(props: {
  data: DashboardSnapshot;
  qr: QrLoginResponse | null;
  loginStatus: LoginStatus | null;
  qrImage: string | null;
  qrError: string | null;
  onRequestQr: () => void;
  onUnlink: () => void;
}) {
  const [activeSection, setActiveSection] = useState<ConfigSection>("llm");
  const [config, setConfig] = useState<LocalConfigSnapshot | null>(null);
  const [draft, setDraft] = useState<LocalConfigDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);
  const [loadVersion, setLoadVersion] = useState(0);
  const profile = props.data.profile;
  const visibleQrError = props.qrError?.includes("QR code expired 3 times")
    ? null
    : props.qrError;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setConfigError(null);
    getLocalConfig()
      .then((nextConfig) => {
        if (cancelled) return;
        setConfig(nextConfig);
        setDraft(draftFromConfig(nextConfig));
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setConfigError(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [loadVersion]);

  useEffect(() => {
    if (!saved) return undefined;
    const timer = window.setTimeout(() => setSaved(false), 1800);
    return () => window.clearTimeout(timer);
  }, [saved]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || saving) return;

    const llmApiKey = secretPatch(draft.llmApiKey, draft.removeLlmApiKey);
    const memoryApiKey = secretPatch(
      draft.memoryApiKey,
      draft.removeMemoryApiKey,
    );
    const payload: LocalConfigPatch = {
      llm: {
        provider: draft.llmProvider,
        model: draft.llmModel.trim() || null,
        baseUrl: draft.llmBaseUrl,
        temperature: optionalNumber(draft.llmTemperature),
        maxTokens: optionalNumber(draft.llmMaxTokens),
        timeoutMs: optionalNumber(draft.llmTimeoutMs),
        ...(llmApiKey !== undefined ? { apiKey: llmApiKey } : {}),
      },
      memory: {
        provider: draft.memoryProvider,
        baseUrl: draft.memoryBaseUrl,
        timeoutMs: optionalNumber(draft.memoryTimeoutMs),
        localMaxSearchRows: optionalNumber(draft.localMaxSearchRows),
        ...(memoryApiKey !== undefined ? { apiKey: memoryApiKey } : {}),
      },
    };

    setSaving(true);
    setSaved(false);
    setConfigError(null);
    try {
      const result = await patchLocalConfig(payload);
      setConfig(result.config);
      setDraft(draftFromConfig(result.config));
      setSaved(true);
    } catch (error) {
      setConfigError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  const llmSecretStatus = draft?.removeLlmApiKey
    ? "REMOVE ON SAVE"
    : config?.llm.apiKey.masked ?? "NOT SET";
  const memorySecretStatus = draft?.removeMemoryApiKey
    ? "REMOVE ON SAVE"
    : config?.memory.apiKey.masked ?? "NOT SET";

  return (
    <main className="page-grid two-columns config-page">
      <section className="panel qr-panel config-qr-panel">
        <div className="section-title">
          <p className="home-kicker config-panel-title">WECHAT QR</p>
          <StatusPill
            active={profile.connected}
            label={profile.connected ? "Connected" : "Disconnected"}
          />
        </div>
        <div className="config-qr-stage">
          {props.qr ? (
            <>
              {props.qrImage ? <QrGlitch source={props.qrImage} /> : null}
              {visibleQrError ? <p className="error-copy">{visibleQrError}</p> : null}
            </>
          ) : (
            <>
              {visibleQrError ? <p className="error-copy">{visibleQrError}</p> : null}
              <EmptyState
                title="No QR requested yet"
                body="Click the Request New QR button to ask the local router for a new QR session."
              />
            </>
          )}
        </div>
        <div className="button-row qr-action-row">
          <button className="primary-button" onClick={props.onRequestQr}>
            Request New QR
          </button>
          <button
            className="secondary-button unlink-button"
            disabled={!profile.connected && !props.loginStatus?.connected}
            onClick={props.onUnlink}
          >
            Disconnect
          </button>
        </div>
      </section>

      <section className="panel config-settings-panel">
        <div className="section-title">
          <p className="home-kicker config-panel-title">LOCAL SETTINGS</p>
          <div className="config-title-status">
            {saved ? <span className="pill pill-good">Saved</span> : null}
            {config?.restartRequired ? (
              <span className="pill config-restart-pill">Restart required</span>
            ) : null}
          </div>
        </div>

        {loading ? (
          <div className="config-settings-empty">READING LOCAL CONFIG...</div>
        ) : configError && !draft ? (
          <div className="config-settings-empty">
            <p>{configError}</p>
            <button
              className="secondary-button config-retry-button"
              onClick={() => setLoadVersion((current) => current + 1)}
            >
              Retry
            </button>
          </div>
        ) : draft && config ? (
          <form className="local-config-form" onSubmit={(event) => void submit(event)}>
            <div className="config-settings-tabs" role="tablist" aria-label="Config section">
              <button
                type="button"
                role="tab"
                aria-selected={activeSection === "llm"}
                className={activeSection === "llm" ? "config-settings-tab active" : "config-settings-tab"}
                onClick={() => setActiveSection("llm")}
              >
                LLM
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeSection === "memory"}
                className={activeSection === "memory" ? "config-settings-tab active" : "config-settings-tab"}
                onClick={() => setActiveSection("memory")}
              >
                Memory
              </button>
            </div>

            <div className="config-settings-fields">
              {activeSection === "llm" ? (
                <>
                  <ConfigField label="LLM provider">
                    <select
                      value={draft.llmProvider}
                      onChange={(event) =>
                        setDraft({ ...draft, llmProvider: event.currentTarget.value })
                      }
                    >
                      <option value="openai-compatible">openai-compatible</option>
                      <option value="mock">mock</option>
                    </select>
                  </ConfigField>
                  <ConfigField label="Model">
                    <input
                      value={draft.llmModel}
                      placeholder="gpt-4.1-mini"
                      onChange={(event) =>
                        setDraft({ ...draft, llmModel: event.currentTarget.value })
                      }
                    />
                  </ConfigField>
                  <div className="config-field config-field-wide">
                    <div className="config-field-heading">
                      <span className="config-field-label">LLM API key</span>
                      <small>{llmSecretStatus}</small>
                    </div>
                    <div className="config-secret-control">
                      <input
                        type="password"
                        aria-label="LLM API key"
                        autoComplete="new-password"
                        value={draft.llmApiKey}
                        placeholder={
                          draft.removeLlmApiKey
                            ? "Key will be removed"
                            : config.llm.apiKey.configured
                              ? "Enter a new key to replace the saved key"
                              : "Paste API key"
                        }
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            llmApiKey: event.currentTarget.value,
                            removeLlmApiKey: false,
                          })
                        }
                      />
                      <button
                        type="button"
                        className="config-secret-button"
                        disabled={
                          !config.llm.apiKey.configured
                          && !draft.llmApiKey
                          && !draft.removeLlmApiKey
                        }
                        onClick={() => {
                          if (draft.llmApiKey) {
                            setDraft({ ...draft, llmApiKey: "", removeLlmApiKey: false });
                            return;
                          }
                          setDraft({
                            ...draft,
                            removeLlmApiKey: !draft.removeLlmApiKey,
                          });
                        }}
                      >
                        {draft.removeLlmApiKey ? "Undo" : "Clear"}
                      </button>
                    </div>
                  </div>
                  <ConfigField label="Base URL" wide>
                    <input
                      type="url"
                      value={draft.llmBaseUrl}
                      onChange={(event) =>
                        setDraft({ ...draft, llmBaseUrl: event.currentTarget.value })
                      }
                    />
                  </ConfigField>
                  <ConfigField label="Temperature">
                    <input
                      type="number"
                      min="0"
                      max="2"
                      step="0.1"
                      value={draft.llmTemperature}
                      placeholder="Default"
                      onChange={(event) =>
                        setDraft({ ...draft, llmTemperature: event.currentTarget.value })
                      }
                    />
                  </ConfigField>
                  <ConfigField label="Max tokens">
                    <input
                      type="number"
                      min="1"
                      max="1000000"
                      step="1"
                      value={draft.llmMaxTokens}
                      placeholder="Default"
                      onChange={(event) =>
                        setDraft({ ...draft, llmMaxTokens: event.currentTarget.value })
                      }
                    />
                  </ConfigField>
                  <ConfigField label="Timeout (ms)" wide>
                    <input
                      type="number"
                      min="100"
                      max="600000"
                      step="100"
                      value={draft.llmTimeoutMs}
                      placeholder="15000"
                      onChange={(event) =>
                        setDraft({ ...draft, llmTimeoutMs: event.currentTarget.value })
                      }
                    />
                  </ConfigField>
                </>
              ) : (
                <>
                  <ConfigField label="Memory provider">
                    <select
                      value={draft.memoryProvider}
                      onChange={(event) =>
                        setDraft({ ...draft, memoryProvider: event.currentTarget.value })
                      }
                    >
                      <option value="local">local</option>
                      <option value="mem0">mem0</option>
                      <option value="none">none</option>
                    </select>
                  </ConfigField>
                  <ConfigField label="Timeout (ms)">
                    <input
                      type="number"
                      min="100"
                      max="600000"
                      step="100"
                      value={draft.memoryTimeoutMs}
                      onChange={(event) =>
                        setDraft({ ...draft, memoryTimeoutMs: event.currentTarget.value })
                      }
                    />
                  </ConfigField>
                  <div className="config-field config-field-wide">
                    <div className="config-field-heading">
                      <span className="config-field-label">Memory API key</span>
                      <small>{memorySecretStatus}</small>
                    </div>
                    <div className="config-secret-control">
                      <input
                        type="password"
                        aria-label="Memory API key"
                        autoComplete="new-password"
                        value={draft.memoryApiKey}
                        placeholder={
                          draft.removeMemoryApiKey
                            ? "Key will be removed"
                            : config.memory.apiKey.configured
                              ? "Enter a new key to replace the saved key"
                              : "Paste API key"
                        }
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            memoryApiKey: event.currentTarget.value,
                            removeMemoryApiKey: false,
                          })
                        }
                      />
                      <button
                        type="button"
                        className="config-secret-button"
                        disabled={
                          !config.memory.apiKey.configured
                          && !draft.memoryApiKey
                          && !draft.removeMemoryApiKey
                        }
                        onClick={() => {
                          if (draft.memoryApiKey) {
                            setDraft({
                              ...draft,
                              memoryApiKey: "",
                              removeMemoryApiKey: false,
                            });
                            return;
                          }
                          setDraft({
                            ...draft,
                            removeMemoryApiKey: !draft.removeMemoryApiKey,
                          });
                        }}
                      >
                        {draft.removeMemoryApiKey ? "Undo" : "Clear"}
                      </button>
                    </div>
                  </div>
                  <ConfigField label="Memory base URL" wide>
                    <input
                      type="url"
                      value={draft.memoryBaseUrl}
                      onChange={(event) =>
                        setDraft({ ...draft, memoryBaseUrl: event.currentTarget.value })
                      }
                    />
                  </ConfigField>
                  <ConfigField label="Local max search rows" wide>
                    <input
                      type="number"
                      min="1"
                      max="1000000"
                      step="1"
                      value={draft.localMaxSearchRows}
                      placeholder="2000"
                      onChange={(event) =>
                        setDraft({ ...draft, localMaxSearchRows: event.currentTarget.value })
                      }
                    />
                  </ConfigField>
                </>
              )}
            </div>

            <div className="config-settings-footer">
              <div className="config-file-state">
                <strong className={configError ? "is-error" : undefined}>
                  {configError
                    ? configError
                    : config.restartRequired
                      ? "RESTART REQUIRED"
                      : "RUNTIME SYNCED"}
                </strong>
                <small title={config.configPath}>{configFileName(config.configPath)}</small>
              </div>
              <button className="primary-button" type="submit" disabled={saving}>
                {saving ? "Saving..." : "Save To .env"}
              </button>
            </div>
          </form>
        ) : null}
      </section>
    </main>
  );
}
