/**
 * The dashboard as one self-contained HTML page: the approved Capability catalog
 * above, the run history below. Server-rendered on every request with no client
 * code, because it is a read-only view of state the core already emits — there is
 * nothing to drive, so there is nothing for a script to do, and a page that runs
 * no script cannot be turned into one that does.
 *
 * Every value that reaches the page from a log or a Contract is escaped through
 * `esc`. The evidence trail is redacted (`[SENSITIVE]`), but redaction is about
 * secrets, not markup, and a run's inputs are still attacker-adjacent strings off
 * disk; escaping is what keeps a logged value a value rather than a tag.
 */
import type { CatalogEntry } from "../catalog/catalog.js";
import type { DisplayStatus, RunSummary } from "./history.js";

export interface DashboardModel {
  /** The approved Capabilities, as `GET /capabilities` returns them. */
  readonly catalog: readonly CatalogEntry[];
  /** The run history, newest first. */
  readonly runs: readonly RunSummary[];
  /** When the page was built, so a watcher knows how fresh it is. */
  readonly generatedAt: string;
}

/** The human label and a class name for each display status. */
const STATUS_LABELS: Record<DisplayStatus, string> = {
  success: "Success",
  recovered: "Recovered",
  "business-outcome": "Business outcome",
  failed: "Failed",
  escalated: "Escalated",
  stopped: "Stopped",
  incomplete: "Incomplete",
};

/** The whole page. Pure: the same model always renders the same bytes. */
export function renderDashboard(model: DashboardModel): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MERIDIAN dashboard</title>
<style>${STYLE}</style>
</head>
<body>
<header>
  <h1>MERIDIAN</h1>
  <p class="sub">A read-only view of the catalog and the run history. It shows what the core emits; it drives nothing.</p>
  <p class="stamp">As of ${esc(model.generatedAt)}</p>
</header>
<main>
  <section>
    <h2>Approved capabilities <span class="count">${model.catalog.length}</span></h2>
    ${model.catalog.length === 0 ? empty("No approved capabilities. A draft stays out of the catalog until it is signed off.") : renderCatalog(model.catalog)}
  </section>
  <section>
    <h2>Run history <span class="count">${model.runs.length}</span></h2>
    ${model.runs.length === 0 ? empty("No runs yet. A discovery or replay run appears here once it has written its evidence.") : model.runs.map(renderRun).join("\n")}
  </section>
</main>
</body>
</html>
`;
}

function renderCatalog(entries: readonly CatalogEntry[]): string {
  const rows = entries
    .map(
      (e) => `<tr>
  <td class="mono">${esc(e.id)}<span class="ver">@${esc(String(e.version))}</span></td>
  <td>${esc(e.contract.summary)}</td>
  <td><span class="chip effects-${esc(e.contract.effects)}">${esc(e.contract.effects)}</span></td>
  <td class="mono">${inputNames(e).map((n) => `<span class="chip">${esc(n)}</span>`).join(" ") || "&mdash;"}</td>
</tr>`,
    )
    .join("\n");
  return `<table class="catalog">
<thead><tr><th>Capability</th><th>Summary</th><th>Effects</th><th>Inputs</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>`;
}

function renderRun(run: RunSummary): string {
  const label = STATUS_LABELS[run.status];
  const when = run.startedAt ?? run.id;
  return `<article class="run">
  <div class="run-head">
    <span class="status status-${esc(run.status)}">${esc(label)}</span>
    <span class="run-cap mono">${esc(run.capability ?? runLabel(run))}</span>
    <span class="chip kind">${esc(run.kind)}</span>
    <span class="run-when">${esc(when)}</span>
  </div>
  <dl class="run-body">
    ${run.recoveredFrom !== undefined ? field("Recovered from", `<span class="chip">${esc(run.recoveredFrom)}</span>`) : ""}
    ${run.businessOutcome !== undefined ? field("Outcome", `<span class="chip">${esc(run.businessOutcome)}</span>`) : ""}
    ${field("Inputs", fields(run.inputs))}
    ${field("Outputs", `${run.readCount} value${run.readCount === 1 ? "" : "s"} read${run.readCount > 0 ? " <span class=\"muted\">(redacted in evidence)</span>" : ""}`)}
    ${run.result.length > 0 ? field("Result", fields(run.result)) : ""}
    ${field("Evidence", evidence(run))}
  </dl>
</article>`;
}

/** A `<div>` term/description pair inside the run body. */
function field(term: string, valueHtml: string): string {
  return `<div><dt>${esc(term)}</dt><dd>${valueHtml}</dd></div>`;
}

/** A list of named values as chips, or an em dash when there are none. */
function fields(list: readonly { name: string; value: string }[]): string {
  if (list.length === 0) return "&mdash;";
  return list.map((f) => `<span class="pair"><span class="k">${esc(f.name)}</span><span class="v mono">${esc(f.value)}</span></span>`).join(" ");
}

/** The evidence cell: the action count, and a link to the screen when one exists. */
function evidence(run: RunSummary): string {
  const actions = `${run.actionCount} action${run.actionCount === 1 ? "" : "s"}`;
  const dir = `<span class="muted mono">${esc(run.id)}</span>`;
  const shot = run.hasFailureScreenshot
    ? ` &middot; <a href="/runs/${encodeURIComponent(run.id)}/failure.png">failure screenshot</a>`
    : "";
  return `${actions} &middot; ${dir}${shot}`;
}

/** The input property names declared by a Capability's Contract. */
function inputNames(entry: CatalogEntry): string[] {
  const properties = entry.contract.inputs.properties;
  return properties === undefined ? [] : Object.keys(properties);
}

/** A run with no capability names itself by its directory, minus the trailing suffix. */
function runLabel(run: RunSummary): string {
  return run.id;
}

function empty(message: string): string {
  return `<p class="empty">${esc(message)}</p>`;
}

/** HTML-escape a value. The one gate every logged or contracted string passes. */
function esc(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const STYLE = `
:root { color-scheme: light dark; --ink: #1a1a1a; --muted: #6b7280; --line: #e5e7eb; --bg: #fafafa; --card: #fff; }
@media (prefers-color-scheme: dark) { :root { --ink: #e5e7eb; --muted: #9ca3af; --line: #2a2a2a; --bg: #111; --card: #1a1a1a; } }
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: var(--ink); background: var(--bg); }
header { padding: 24px 32px 8px; }
h1 { margin: 0; font-size: 22px; letter-spacing: 0.04em; }
.sub { margin: 4px 0 0; color: var(--muted); }
.stamp { margin: 2px 0 0; color: var(--muted); font-size: 12px; }
main { padding: 8px 32px 48px; max-width: 1100px; }
section { margin-top: 28px; }
h2 { font-size: 15px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); border-bottom: 1px solid var(--line); padding-bottom: 6px; }
.count { display: inline-block; margin-left: 6px; color: var(--muted); font-weight: 400; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.muted { color: var(--muted); }
table.catalog { width: 100%; border-collapse: collapse; }
table.catalog th { text-align: left; font-size: 12px; color: var(--muted); font-weight: 600; padding: 6px 10px; }
table.catalog td { padding: 8px 10px; border-top: 1px solid var(--line); vertical-align: top; }
.ver { color: var(--muted); }
.chip { display: inline-block; padding: 1px 7px; border-radius: 10px; background: var(--line); font-size: 12px; }
.chip.effects-mutating { background: #fde68a; color: #713f12; }
.chip.effects-read-only { background: #d1fae5; color: #065f46; }
.run { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; margin-top: 10px; }
.run-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.run-cap { font-weight: 600; }
.run-when { margin-left: auto; color: var(--muted); font-size: 12px; }
.status { padding: 2px 9px; border-radius: 10px; font-size: 12px; font-weight: 600; }
.status-success, .status-recovered { background: #d1fae5; color: #065f46; }
.status-business-outcome { background: #dbeafe; color: #1e40af; }
.status-failed { background: #fee2e2; color: #991b1b; }
.status-escalated { background: #fef3c7; color: #92400e; }
.status-stopped { background: var(--line); color: var(--muted); }
.status-incomplete { background: repeating-linear-gradient(45deg, var(--line), var(--line) 4px, transparent 4px, transparent 8px); color: var(--muted); }
.run-body { margin: 10px 0 0; display: grid; grid-template-columns: 1fr; gap: 4px; }
.run-body > div { display: grid; grid-template-columns: 120px 1fr; gap: 10px; }
dt { color: var(--muted); font-size: 12px; }
dd { margin: 0; }
.pair { display: inline-block; margin-right: 10px; }
.pair .k { color: var(--muted); }
.pair .v { margin-left: 4px; }
.empty { color: var(--muted); font-style: italic; padding: 12px 0; }
a { color: inherit; }
`;
