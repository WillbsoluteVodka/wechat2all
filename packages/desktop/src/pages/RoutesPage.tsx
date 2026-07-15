import type { RouteSummary } from "../types";
import { StatusPill } from "../ui/Common";
import { ConstructionBarrier } from "../ui/Construction";
import { displayRouteName, routeRuleDetails } from "../ui/constants";
import { PixelText } from "../ui/PixelArt";

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
  routes: RouteSummary[];
  selectedRouteId: string | null;
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
  const configChecklist = [
    { label: "Route enabled", value: selected.enabled, detail: selected.enabled ? "ON" : "OFF" },
    {
      label: "Connector assigned",
      value: Boolean(selected.connectorId),
      detail: selected.connectorId || "NOT SET",
    },
    {
      label: "Priority configured",
      value: Number.isFinite(selected.priority),
      detail: String(selected.priority),
    },
    {
      label: "Match rules configured",
      value: matchRules.length > 0,
      detail: `${matchRules.length} RULES`,
    },
  ];

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

        <section className="route-detail-section">
          <h2 className="home-kicker">CONFIG CHECKLIST</h2>
          <ul className="route-config-checklist">
            {configChecklist.map((item) => (
              <li key={item.label} className={item.value ? "is-complete" : "is-incomplete"}>
                <span className="route-config-check" aria-hidden="true">
                  {item.value ? "[x]" : "[ ]"}
                </span>
                <strong>{item.label}</strong>
                <small>{item.detail}</small>
              </li>
            ))}
          </ul>
        </section>
      </section>
    </main>
  );
}
