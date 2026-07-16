import type {
  CodexSetupCheckItemStatus,
  CodexSetupCheckResponse,
  RouteSummary,
} from "../types";
import accessibilityPermissionsImage from "../assets/codex-permissions-accessibility.png";
import automationPermissionsImage from "../assets/codex-permissions-automation.png";
import screenRecordingPermissionsImage from "../assets/codex-permissions-screen-recording.png";
import { StatusPill } from "../ui/Common";
import { ConstructionBarrier } from "../ui/Construction";
import { displayRouteName, routeRuleDetails } from "../ui/constants";
import { PixelText } from "../ui/PixelArt";

const CODEX_MANUAL_PERMISSION_GROUPS = [
  {
    title: "ACCESSIBILITY",
    image: accessibilityPermissionsImage,
    alt: "Accessibility permissions enabled for ChatGPT, Codex Computer Use, osascript, and Terminal",
  },
  {
    title: "AUTOMATION",
    image: automationPermissionsImage,
    alt: "Automation permissions enabled under Terminal",
  },
  {
    title: "SCREEN & SYSTEM AUDIO RECORDING",
    image: screenRecordingPermissionsImage,
    alt: "Screen and System Audio Recording enabled for ChatGPT",
  },
] as const;

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

function RoutesStage() {
  return (
    <section className="command-stage routes-construction-stage" aria-label="Routes under construction">
      <div className="routes-construction-content">
        <ConstructionBarrier />
        <PixelText text="Construction Site" className="construction-label" />
      </div>
    </section>
  );
}

export function RoutesPage(props: {
  codexSetupCheck: CodexSetupCheckResponse | null;
  codexSetupError: string | null;
  codexSetupRefreshing: boolean;
  codexDelivery: "app-server" | "gui-automation";
  codexDeliveryRestartRequired: boolean;
  codexDeliverySaving: boolean;
  routes: RouteSummary[];
  selectedRouteId: string | null;
  onRefreshCodexSetupCheck: () => void;
  onToggleCodexDelivery: () => void;
  onSelect: (routeId: string | null) => void;
}) {
  const selected = props.routes.find((route) => route.id === props.selectedRouteId) ?? null;

  if (!selected) {
    return (
      <main className="page">
        <RoutesStage />
        <section className="route-grid">
          {props.routes.map((route) => (
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
  const isCodexRoute = selected.id === "codex" || selected.connectorId.includes("codex");
  const genericConfigChecklist: Array<{
    label: string;
    status: CodexSetupCheckItemStatus;
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
  const cachedCodexCheck = props.codexSetupCheck?.check;
  const codexWarnings = cachedCodexCheck?.items.filter((item) => item.status === "warn") ?? [];
  const codexConfigChecklist = props.codexSetupError
    ? [{
        label: props.codexSetupError,
        status: "missing" as CodexSetupCheckItemStatus,
        detail: "action failed",
      }]
    : cachedCodexCheck?.error
      ? [{
          label: cachedCodexCheck.error,
          status: "missing" as CodexSetupCheckItemStatus,
          detail: "check failed",
        }]
      : codexWarnings.length
        ? codexWarnings.map((item) => ({
        label: item.message,
        status: item.status,
        detail: item.section
          ? `${item.status} / ${item.section}`
          : item.status,
        }))
        : cachedCodexCheck?.status === "ready"
          ? [{
              label: "ALL CHECKS PASSED",
              status: "pass" as CodexSetupCheckItemStatus,
              detail: "NO WARNINGS",
            }]
          : [];
  const configChecklist = isCodexRoute ? codexConfigChecklist : genericConfigChecklist;
  const checklistMarker: Record<CodexSetupCheckItemStatus, string> = {
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
        {isCodexRoute ? (
          <div className="route-config-actions">
            {props.codexDeliveryRestartRequired ? (
              <span className="route-delivery-restart">RESTART REQUIRED</span>
            ) : null}
            <button
              type="button"
              className={props.codexDelivery === "gui-automation"
                ? "secondary-button route-delivery-toggle is-gui"
                : "secondary-button route-delivery-toggle"}
              disabled={props.codexDeliverySaving}
              onClick={props.onToggleCodexDelivery}
              title={props.codexDelivery === "app-server"
                ? "Switch Codex route to GUI Automation"
                : "Switch Codex route to App Server"}
            >
              {props.codexDeliverySaving
                ? "SAVING..."
                : `MODE: ${props.codexDelivery === "app-server" ? "APP SERVER" : "GUI AUTOMATION"}`}
            </button>
            <button
              type="button"
              className="secondary-button route-config-refresh"
              disabled={props.codexSetupRefreshing}
              onClick={props.onRefreshCodexSetupCheck}
            >
              {props.codexSetupRefreshing
                ? "Refreshing..."
                : "Refresh"}
            </button>
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
        macOS does not expose a reliable read-only status for these permissions. Open System Settings → Privacy &amp; Security, then verify each item manually in the section below.
      </p>
      <div className="route-manual-permission-groups">
        {CODEX_MANUAL_PERMISSION_GROUPS.map((group) => (
          <section key={group.title} className="route-manual-permission-group">
            <h3>{group.title}</h3>
            <img
              className="route-manual-permission-image"
              src={group.image}
              alt={group.alt}
              draggable={false}
            />
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

        {isCodexRoute ? configChecklistSection : matchRulesSection}
        {isCodexRoute ? manualPermissionsSection : null}
        {isCodexRoute ? matchRulesSection : configChecklistSection}
      </section>
    </main>
  );
}
