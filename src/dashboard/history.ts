/**
 * The read side of the evidence trail: `run.jsonl` files projected to what a
 * person watching the system wants to see — one row per run, its inputs, what it
 * produced, how it ended, and whether there is a screen to look at.
 *
 * Nothing here writes; it reads directories `EvidenceRun` already wrote (see
 * `src/evidence/run.ts`). It is deliberately tolerant: a run that crashed
 * mid-sentence leaves a log with no `run-finished`, and a half-written last line
 * is a real thing to find on disk, so a malformed line is skipped rather than
 * failing the whole run and a missing finish reads as `incomplete` rather than
 * throwing. A viewer that fell over on the first ugly file would be useless
 * exactly when the run it cannot show is the one worth looking at.
 *
 * The status vocabulary is the one place criterion 3 of #29 is settled. The core
 * writes five real `RunOutcome` values (`src/evidence/run.ts`); the dashboard
 * shows them under the labels the spec asked for, mapped here and nowhere else:
 *
 *   success              -> success   (or `recovered` when the finish record
 *                                       carries a `recovered` marker)
 *   business-outcome     -> business-outcome
 *   hard-failure         -> failed
 *   intervention-request -> escalated
 *   stopped              -> stopped
 *   (no run-finished)    -> incomplete
 *
 * "Recoverable" is not a terminal status the core emits — a recovered run ends in
 * one of the real outcomes, and recovery is absorbed inside `replayCapability`.
 * So it is a `success` shown differently, decided from what the run recorded. The
 * authoritative signal is the `recovered` marker the finish record now carries
 * (#37): `replayCapability` returns which Recoverable Conditions it absorbed, and
 * `runCapability` writes their names onto the finish `about`, so a real recovered
 * replay says so as a fact and names what it re-established from (e.g.
 * `SESSION_EXPIRED`). As a fallback for a run that recorded no marker, a `success`
 * that also captured a `failure.png` is treated as recovered too: a run that never
 * missed an Action captures no screen, so a success with one rode through a fault.
 * The marker is preferred because only it carries the condition's name.
 * A pre-run gate escalation (#27) writes no run at all, so it never appears here;
 * the only escalations shown are discovery handovers.
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

/** The name each `run-finished.outcome` shows under. See the module comment. */
export type DisplayStatus =
  | "success"
  | "recovered"
  | "business-outcome"
  | "failed"
  | "escalated"
  | "stopped"
  | "incomplete";

/** One named value: a run input, or one field of the recorded result. */
export interface RunField {
  readonly name: string;
  readonly value: string;
}

/** One run, projected to the part the dashboard shows. */
export interface RunSummary {
  /** The run directory's name, which leads with its ISO timestamp so runs sort. */
  readonly id: string;
  /** Which command wrote it, read from the directory name. */
  readonly kind: "discovery" | "replay" | "other";
  /** `<id>@<version>` when the run named one; discovery runs before a save may not. */
  readonly capability?: string;
  /** When the `run-started` record was written. */
  readonly startedAt?: string;
  /** When the `run-finished` record was written; absent for an incomplete run. */
  readonly finishedAt?: string;
  readonly status: DisplayStatus;
  /** The declared Business Outcome name, when the run ended in one. */
  readonly businessOutcome?: string;
  /** The condition a recovered run re-established from, when it recovered. */
  readonly recoveredFrom?: string;
  /** The run's inputs, off the `run-started` record (`input.*`), values as logged. */
  readonly inputs: RunField[];
  /** The finish record's `about` fields — the recorded result and its details. */
  readonly result: RunField[];
  /** How many Actions the run took. */
  readonly actionCount: number;
  /** How many typed values the run read — its outputs, redacted in the log. */
  readonly readCount: number;
  /** Whether a `failure.png` was captured — the screen worth looking at. */
  readonly hasFailureScreenshot: boolean;
}

/** The evidence file inside each run directory. Matches `src/evidence/run.ts`. */
const LOG_FILE = "run.jsonl";

/** A finish `about` field promoted to its own place on the summary, not the generic list. */
const PROMOTED_RESULT_FIELDS = new Set(["outcome", "recovered"]);

/**
 * Every run under `runsDir`, newest first. A directory without a readable
 * `run.jsonl` is not a run and is skipped, so the runs README and any stray file
 * do not turn into empty rows.
 */
export async function readRunHistory(runsDir: string): Promise<RunSummary[]> {
  let names: string[];
  try {
    names = (await readdir(runsDir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    // No runs directory yet is an empty history, not an error: a fresh checkout
    // that has never run anything should show a clean, empty view.
    return [];
  }

  const summaries: RunSummary[] = [];
  for (const name of names) {
    const summary = await readOneRun(runsDir, name);
    if (summary !== undefined) summaries.push(summary);
  }
  // The directory name leads with an ISO timestamp, so reverse lexical order is
  // newest first without parsing a date.
  summaries.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  return summaries;
}

async function readOneRun(runsDir: string, name: string): Promise<RunSummary | undefined> {
  let text: string;
  try {
    text = await readFile(join(runsDir, name, LOG_FILE), "utf8");
  } catch {
    return undefined;
  }

  let started: Record<string, unknown> | undefined;
  let finished: Record<string, unknown> | undefined;
  let actionCount = 0;
  let readCount = 0;
  let hasFailureScreenshot = false;

  for (const line of text.split("\n")) {
    const record = parseLine(line);
    if (record === undefined) continue;
    switch (record["kind"]) {
      case "run-started":
        started = record;
        break;
      case "run-finished":
        finished = record;
        break;
      case "action":
        actionCount += 1;
        if (isReadValue(record)) readCount += 1;
        break;
      case "failure-screenshot":
        hasFailureScreenshot = true;
        break;
    }
  }

  const startedAbout = asStringMap(started?.["about"]);
  const finishedAbout = asStringMap(finished?.["about"]);
  const outcome = typeof finished?.["outcome"] === "string" ? (finished["outcome"] as string) : undefined;

  return {
    id: name,
    kind: kindOf(name),
    ...(startedAbout["capability"] !== undefined ? { capability: startedAbout["capability"] } : {}),
    ...(typeof started?.["at"] === "string" ? { startedAt: started["at"] as string } : {}),
    ...(typeof finished?.["at"] === "string" ? { finishedAt: finished["at"] as string } : {}),
    status: displayStatus(outcome, finishedAbout, hasFailureScreenshot),
    ...(finishedAbout["outcome"] !== undefined ? { businessOutcome: finishedAbout["outcome"] } : {}),
    ...(finishedAbout["recovered"] !== undefined ? { recoveredFrom: finishedAbout["recovered"] } : {}),
    inputs: inputsFrom(startedAbout),
    result: resultFrom(finishedAbout),
    actionCount,
    readCount,
    hasFailureScreenshot,
  };
}

/** One log line as a record, or undefined if it is blank or not a JSON object. */
function parseLine(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim();
  if (trimmed === "") return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** An `action` record whose result carries a read value — one typed output. */
function isReadValue(record: Record<string, unknown>): boolean {
  const action = record["action"];
  const result = record["result"];
  const isRead = typeof action === "object" && action !== null && (action as Record<string, unknown>)["kind"] === "read";
  const gotValue =
    typeof result === "object" && result !== null && "value" in (result as Record<string, unknown>);
  return isRead && gotValue;
}

/** Which command wrote the run, read from the directory name's label. */
function kindOf(name: string): RunSummary["kind"] {
  if (/-discover(-|$)/.test(name)) return "discovery";
  if (/-replay-/.test(name)) return "replay";
  return "other";
}

/** Map the real outcome to its display label, deriving `recovered`. See the module comment. */
function displayStatus(
  outcome: string | undefined,
  about: Record<string, string>,
  hasFailureScreenshot: boolean,
): DisplayStatus {
  switch (outcome) {
    case "success":
      // A success that captured a failure screen recovered from it; the marker,
      // when present, only adds the condition's name (see `recoveredFrom`).
      return about["recovered"] !== undefined || hasFailureScreenshot ? "recovered" : "success";
    case "business-outcome":
      return "business-outcome";
    case "hard-failure":
      return "failed";
    case "intervention-request":
      return "escalated";
    case "stopped":
      return "stopped";
    default:
      return "incomplete";
  }
}

/** The `input.*` fields of the run-started `about`, prefix stripped, in log order. */
function inputsFrom(about: Record<string, string>): RunField[] {
  return Object.entries(about)
    .filter(([name]) => name.startsWith("input."))
    .map(([name, value]) => ({ name: name.slice("input.".length), value }));
}

/** The finish `about`, minus the fields promoted to their own place on the summary. */
function resultFrom(about: Record<string, string>): RunField[] {
  return Object.entries(about)
    .filter(([name]) => !PROMOTED_RESULT_FIELDS.has(name))
    .map(([name, value]) => ({ name, value }));
}

/** An `about` object as a string map; anything not a string map reads as empty. */
function asStringMap(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === "string") out[name] = raw;
  }
  return out;
}
