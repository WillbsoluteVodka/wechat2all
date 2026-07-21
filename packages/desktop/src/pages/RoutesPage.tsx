import { useEffect, useState, type ChangeEvent, type KeyboardEvent } from "react";

import { getUpochiConfig, getUpochiHealth, patchUpochiConfig } from "../api";
import type {
  LocalConfigSnapshot,
  RouteSetupCheckItemStatus,
  RouteSetupCheckResponse,
  RouteSummary,
  UpochiConfigSnapshot,
  UpochiHealthResponse,
  UpochiLlmModel,
} from "../types";
import { StatusPill } from "../ui/Common";
import { displayRouteName, routeRuleDetails } from "../ui/constants";
import { PixelText } from "../ui/PixelArt";

const UPOCHI_LLM_PRESETS: Record<UpochiLlmModel, { label: string; endpoint: string }> = {
  "deepseek-chat": {
    label: "DeepSeek",
    endpoint: "https://api.deepseek.com/v1",
  },
  "gpt-4.1-mini": {
    label: "OpenAI",
    endpoint: "https://api.openai.com/v1",
  },
};

function isUpochiLlmModel(value: string | null): value is UpochiLlmModel {
  return value !== null && value in UPOCHI_LLM_PRESETS;
}

function UpochiLlmSettings() {
  const [config, setConfig] = useState<UpochiConfigSnapshot | null>(null);
  const [model, setModel] = useState<UpochiLlmModel>("deepseek-chat");
  const [apiKey, setApiKey] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let retryTimer: number | undefined;
    const loadConfig = async (initial: boolean) => {
      if (initial) setLoading(true);
      try {
        const nextConfig = await getUpochiConfig();
        if (cancelled) return;
        setConfig(nextConfig);
        if (isUpochiLlmModel(nextConfig.llm.model)) setModel(nextConfig.llm.model);
        setError(null);
      } catch (reason) {
        if (cancelled) return;
        setError(reason instanceof Error ? reason.message : String(reason));
        retryTimer = window.setTimeout(() => void loadConfig(false), 2_000);
      } finally {
        if (!cancelled && initial) setLoading(false);
      }
    };
    void loadConfig(true);
    return () => {
      cancelled = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    };
  }, []);

  async function save(payload: { model: UpochiLlmModel; apiKey?: string | null }) {
    if (saving) return;
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const result = await patchUpochiConfig(payload);
      setConfig(result.config);
      setApiKey("");
      setSaved(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  }

  function onModelChange(event: ChangeEvent<HTMLSelectElement>) {
    const nextModel = event.target.value as UpochiLlmModel;
    setModel(nextModel);
    void save({ model: nextModel });
  }

  function savePendingApiKey() {
    if (!apiKey.trim() || saving) return;
    void save({ model, apiKey });
  }

  function onApiKeyKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    event.currentTarget.blur();
  }

  const endpoint = UPOCHI_LLM_PRESETS[model].endpoint;

  return (
    <section className="route-detail-section upochi-llm-settings">
      <div className="route-detail-section-heading upochi-llm-heading">
        <div>
          <h2 className="home-kicker">UPOCHI LLM SETTINGS</h2>
          <p>MODEL 自动匹配 LLM_ENDPOINT；修改会写入自动找到的 Upochi .env。</p>
        </div>
        {config?.restartRequired ? (
          <span className="route-delivery-restart">RESTART UPOCHI REQUIRED</span>
        ) : null}
      </div>

      {loading ? (
        <div className="upochi-config-state">SEARCHING FOR UPOCHI ENV...</div>
      ) : error && !config ? (
        <div className="upochi-config-state is-error">{error}</div>
      ) : (
        <div className="upochi-llm-form">
          <label className="upochi-config-field">
            <span>LLM MODEL</span>
            <select value={model} disabled={saving} onChange={onModelChange}>
              {(Object.entries(UPOCHI_LLM_PRESETS) as Array<[
                UpochiLlmModel,
                { label: string; endpoint: string },
              ]>).map(([value, preset]) => (
                <option key={value} value={value}>{preset.label}</option>
              ))}
            </select>
          </label>

          <div className="upochi-config-field">
            <div className="upochi-config-field-heading">
              <span>LLM API KEY</span>
              <small>{config?.llm.apiKey.masked ?? "NOT CONFIGURED"}</small>
            </div>
            <div className="upochi-secret-control">
              <input
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={apiKey}
                disabled={saving}
                placeholder={config?.llm.apiKey.configured
                  ? "Enter a new key to replace the saved key"
                  : "Enter API key"}
                onChange={(event) => {
                  setApiKey(event.target.value);
                  setSaved(false);
                }}
                onBlur={savePendingApiKey}
                onKeyDown={onApiKeyKeyDown}
              />
              <button
                type="button"
                className="secondary-button upochi-clear-key"
                disabled={saving || !config?.llm.apiKey.configured}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => void save({ model, apiKey: null })}
              >
                CLEAR
              </button>
            </div>
          </div>

          <div className="upochi-endpoint-field">
            <span>LLM ENDPOINT</span>
            <code>{endpoint}</code>
          </div>
        </div>
      )}

      {config || !error ? (
        <div className="upochi-config-footer">
          <div>
            <strong className={error ? "is-error" : ""}>
              {saving ? "SAVING..." : error ? error : saved ? "SAVED" : "AUTO SAVE ON SELECT / BLUR"}
            </strong>
            <small title={config?.envPath}>{config?.envPath ?? "Upochi .env is being located automatically"}</small>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function UpochiHealthChecklist() {
  const [health, setHealth] = useState<UpochiHealthResponse["upochi"] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let requestInFlight = false;
    const refresh = async () => {
      if (requestInFlight) return;
      requestInFlight = true;
      try {
        const result = await getUpochiHealth();
        if (!cancelled) {
          setHealth(result.upochi);
          setError(null);
        }
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        requestInFlight = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const running = health?.running === true && !error;
  const label = error
    ? "COULD NOT CHECK UPOCHI"
    : health === null
      ? "CHECKING UPOCHI"
      : running
        ? "UPOCHI IS RUNNING"
        : "UPOCHI IS NOT RUNNING";
  const detail = error
    ? "CHECK FAILED"
    : health === null
      ? "CHECKING"
      : running
        ? `LISTENING · ${health.latencyMs} MS`
        : "NOT LISTENING";

  return (
    <section className="route-detail-section">
      <h2 className="home-kicker">CONFIG CHECKLIST</h2>
      <ul className="route-config-checklist upochi-health-checklist" aria-live="polite">
        <li
          className={running ? "is-pass" : health === null && !error ? "is-info" : "is-missing"}
          title={error ?? health?.error ?? health?.baseUrl}
        >
          <span className="route-config-check" aria-hidden="true">
            {running ? "[x]" : health === null && !error ? "[...]" : "[!]"}
          </span>
          <strong>{label}</strong>
          <small>{detail}</small>
        </li>
      </ul>
    </section>
  );
}

function isWeConnectRoute(route: RouteSummary) {
  return route.id === "main-assistant-default"
    || route.connectorId === "main-assistant"
    || route.name === "大助手";
}

function RouteCard(props: {
  route: RouteSummary;
  selected: boolean;
  onClick: () => void;
}) {
  const commands = props.route.matchText.filter((tag) => tag.startsWith("/"));

  return (
    <button
      className={[
        "route-card",
        props.route.enabled ? "is-enabled" : "is-disabled",
        props.selected ? "selected" : "",
      ].join(" ")}
      onClick={props.onClick}
      aria-pressed={props.selected}
    >
      <div className="route-card-head">
        <h3>
          <PixelText text={displayRouteName(props.route)} className="route-title-pixel" />
        </h3>
      </div>
      <StatusPill
        active={props.route.enabled}
        label={props.route.enabled ? "Enabled" : "Disabled"}
      />
      <p>{props.route.description}</p>
      {commands.length ? (
        <div className="tag-row route-command-tags">
          {commands.map((tag) => (
            <span className="tag" key={tag}>{tag}</span>
          ))}
        </div>
      ) : null}
    </button>
  );
}

function WeConnectStage(props: { route: RouteSummary | null }) {
  if (!props.route) return null;
  const rules = routeRuleDetails(props.route);

  return (
    <section className="command-stage routes-weconnect-stage" aria-label="WeConnect primary router">
      <div className="routes-weconnect-summary">
        <div className="routes-weconnect-title-row">
          <div>
            <p className="home-kicker">PRIMARY ROUTER</p>
            <h1>
              <PixelText text={displayRouteName(props.route)} className="routes-weconnect-title" />
            </h1>
          </div>
          <StatusPill
            active={props.route.enabled}
            label={props.route.enabled ? "Enabled" : "Disabled"}
          />
        </div>
        <p className="routes-weconnect-description">{props.route.description}</p>
        <div className="routes-weconnect-meta">
          <span>CONNECTOR</span>
          <strong>{props.route.connectorId}</strong>
        </div>
      </div>

      <div className="routes-weconnect-commands">
        <h2 className="home-kicker">COMMANDS</h2>
        <ul>
          {rules.map((item) => (
            <li key={item.rule}>
              <code>{item.rule}</code>
              <span>{item.description}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

export function RoutesPage(props: {
  routeSetupChecks: Record<string, RouteSetupCheckResponse | null>;
  routeSetupErrors: Record<string, string | null>;
  routeSetupRefreshingId: string | null;
  localConfig: LocalConfigSnapshot | null;
  routeConfigSavingPath: string | null;
  routes: RouteSummary[];
  selectedRouteId: string | null;
  onRefreshRouteSetupCheck: (routeId: string) => void;
  onSetRouteConfig: (
    configKey: string,
    field: string,
    value: string,
  ) => void;
  onSelect: (routeId: string | null) => void;
}) {
  const weConnectRoute = props.routes.find(isWeConnectRoute) ?? null;
  const concreteRoutes = props.routes.filter((route) => !isWeConnectRoute(route));
  const selectedCandidate = props.routes.find((route) => route.id === props.selectedRouteId) ?? null;
  const selected = selectedCandidate && !isWeConnectRoute(selectedCandidate)
    ? selectedCandidate
    : null;

  if (!selected) {
    return (
      <main className="page">
        <WeConnectStage route={weConnectRoute} />
        <section className="route-grid">
          {concreteRoutes.map((route) => (
            <RouteCard
              key={route.id}
              route={route}
              selected={false}
              onClick={() => props.onSelect(route.id)}
            />
          ))}
        </section>
      </main>
    );
  }

  const matchRules = routeRuleDetails(selected);
  const isUpochiRoute = selected.id === "upochi" || selected.connectorId.includes("upochi");
  const management = selected.management;
  const hasSetupCheck = management?.setupCheck === true;
  const configControls = management?.configControls ?? [];
  const manualPermissions = management?.manualPermissions ?? [];
  const genericConfigChecklist: Array<{
    label: string;
    status: RouteSetupCheckItemStatus;
    detail: string;
  }> = [
    { label: "Route enabled", status: selected.enabled ? "pass" : "missing", detail: selected.enabled ? "ON" : "OFF" },
    {
      label: "Connector assigned",
      status: selected.connectorId ? "pass" : "missing",
      detail: selected.connectorId || "NOT SET",
    },
    {
      label: "Priority configured",
      status: Number.isFinite(selected.priority) ? "pass" : "missing",
      detail: String(selected.priority),
    },
    {
      label: "Match rules configured",
      status: matchRules.length > 0 ? "pass" : "missing",
      detail: `${matchRules.length} RULES`,
    },
  ];
  const cachedSetupCheck = props.routeSetupChecks[selected.id]?.check;
  const setupConfigChecklist = props.routeSetupErrors[selected.id]
    ? [{
        label: props.routeSetupErrors[selected.id] ?? "Setup check failed",
        status: "missing" as RouteSetupCheckItemStatus,
        detail: "action failed",
      }]
    : cachedSetupCheck?.error
      ? [{
          label: cachedSetupCheck.error,
          status: "missing" as RouteSetupCheckItemStatus,
          detail: "check failed",
        }]
      : cachedSetupCheck?.items.length
        ? cachedSetupCheck.items.map((item) => ({
            label: item.message,
            status: item.status,
            detail: item.section
              ? `${item.status} / ${item.section}`
              : item.status,
          }))
        : cachedSetupCheck?.status === "checking"
          ? [{
              label: "CHECKING ROUTE CONFIGURATION",
              status: "info" as RouteSetupCheckItemStatus,
              detail: "IN PROGRESS",
            }]
          : cachedSetupCheck?.status === "ready"
            ? [{
                label: "ALL CHECKS PASSED",
                status: "pass" as RouteSetupCheckItemStatus,
                detail: "NO WARNINGS",
              }]
            : [{
                label: "WAITING FOR ROUTE SETUP CHECK",
                status: "info" as RouteSetupCheckItemStatus,
                detail: "STARTING",
              }];
  const configChecklist = hasSetupCheck ? setupConfigChecklist : genericConfigChecklist;
  const checklistMarker: Record<RouteSetupCheckItemStatus, string> = {
    pass: "[x]",
    missing: "[!]",
    warn: "[-]",
    unknown: "[?]",
    info: "[i]",
  };
  const matchRulesSection = (
    <section className="route-detail-section">
      <h2 className="home-kicker">MATCH RULES</h2>
      <ol className="route-match-rule-list">
        {matchRules.map((item, index) => (
          <li key={`${item.rule}-${index}`}>
            <span>{String(index + 1).padStart(2, "0")}</span>
            <code>{item.rule}</code>
            <small>{item.description}</small>
          </li>
        ))}
      </ol>
    </section>
  );
  const configChecklistSection = (
    <section className="route-detail-section">
      <div className="route-detail-section-heading">
        <h2 className="home-kicker">CONFIG CHECKLIST</h2>
        {hasSetupCheck || configControls.length ? (
          <div className="route-config-actions">
            {props.localConfig?.restartRequired && configControls.length ? (
              <span className="route-delivery-restart">RESTART REQUIRED</span>
            ) : null}
            {configControls.map((control) => {
              const configNamespace = props.localConfig?.[control.configKey];
              const currentValue = configNamespace
                && typeof configNamespace === "object"
                && !Array.isArray(configNamespace)
                ? (configNamespace as Record<string, unknown>)[control.field]
                : undefined;
              const currentIndex = control.values.findIndex(
                (choice) => choice.value === currentValue,
              );
              const activeChoice = control.values[currentIndex >= 0 ? currentIndex : 0];
              const nextChoice = control.values[(currentIndex + 1 + control.values.length)
                % control.values.length];
              const controlPath = `${control.configKey}.${control.field}`;
              return (
                <button
                  key={controlPath}
                  type="button"
                  className="secondary-button route-delivery-toggle"
                  disabled={props.routeConfigSavingPath === controlPath || !nextChoice}
                  onClick={() => nextChoice && props.onSetRouteConfig(
                    control.configKey,
                    control.field,
                    nextChoice.value,
                  )}
                  title={nextChoice?.title ?? `Switch ${control.label}`}
                >
                  {props.routeConfigSavingPath === controlPath
                    ? "SAVING..."
                    : `${control.label}: ${activeChoice?.label ?? String(currentValue ?? "NOT SET")}`}
                </button>
              );
            })}
            {hasSetupCheck ? (
              <button
                type="button"
                className="secondary-button route-config-refresh"
                disabled={props.routeSetupRefreshingId === selected.id}
                onClick={() => props.onRefreshRouteSetupCheck(selected.id)}
              >
                {props.routeSetupRefreshingId === selected.id
                  ? "Refreshing..."
                  : "Refresh"}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      <ul className="route-config-checklist">
        {configChecklist.map((item, index) => (
          <li key={`${item.status}-${item.label}-${index}`} className={`is-${item.status}`}>
            <span className="route-config-check" aria-hidden="true">
              {checklistMarker[item.status]}
            </span>
            <strong>{item.label}</strong>
            <small>{item.detail}</small>
          </li>
        ))}
      </ul>
    </section>
  );
  const manualPermissionsSection = (
    <section className="route-detail-section route-manual-permissions">
      <div className="route-manual-permissions-heading">
        <h2 className="home-kicker">MANUAL PERMISSIONS</h2>
        <span>USER VERIFICATION REQUIRED</span>
      </div>
      <p className="route-manual-permissions-intro">
        This route declares permissions that cannot be verified reliably through a read-only API. Verify each item manually in System Settings → Privacy &amp; Security.
      </p>
      <div className="route-manual-permission-groups">
        {manualPermissions.map((group) => (
          <section key={group.title} className="route-manual-permission-group">
            <h3>{group.title}</h3>
            <ul>
              {group.items.map((item) => <li key={item}>{item}</li>)}
            </ul>
          </section>
        ))}
      </div>
    </section>
  );

  return (
    <main className="route-detail-page">
      <section className="panel route-detail route-detail-single">
        <button className="primary-button route-detail-back" onClick={() => props.onSelect(null)}>
          Back to All Routes
        </button>
        <header className="route-detail-heading">
          <h1>
            <PixelText text={displayRouteName(selected)} className="route-detail-title-pixel" />
          </h1>
          <p>{selected.description}</p>
        </header>

        {hasSetupCheck
          ? configChecklistSection
          : isUpochiRoute
            ? <UpochiLlmSettings />
            : matchRulesSection}
        {manualPermissions.length ? manualPermissionsSection : null}
        {isUpochiRoute ? <UpochiHealthChecklist /> : null}
        {hasSetupCheck || isUpochiRoute ? matchRulesSection : configChecklistSection}
      </section>
    </main>
  );
}
