/**
 * One run's evidence: a directory, a structured log, and the screenshot of the
 * screen that stopped it.
 *
 * The log is JSON Lines rather than one JSON document because a run is appended
 * to as it happens. A document would have to be held in memory and written at
 * the end, which is precisely the moment a crashed run has nothing to say — and
 * a line-per-record file is readable by `jq`, by `grep`, and by a person, with
 * no reader to write.
 *
 * There is deliberately no free-text field on any record. ADR 0006 persists a
 * filtered transcript — the Actions taken and their results, not the reasoning
 * that led to them — because a value mentioned in prose ("the balance is
 * $1,234.56") is not something field-level masking can catch. Leaving prose out
 * of the record type is that rule made structural: the leak path does not exist
 * rather than being patched. The discovery loop writes its model turns through
 * this same seam, as Actions and results.
 */
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { packageRootFrom } from "../package-root.js";
import type { Controller } from "../escalation/controller.js";
import { redact, stripSecrets, type Redaction } from "./redaction.js";

/** The structured log, one record per line. */
const LOG_FILE = "run.jsonl";
/** The screen the run could not interpret. Written at most once. */
const SCREENSHOT_FILE = "failure.png";

/**
 * One line of the log.
 *
 * The fields carrying values off the screen — `action` and `result` — arrive
 * already classified by the decorator that built them, because only it knows
 * which position a value sat in. Everything else here is Plain by construction,
 * and `stripSecrets` runs over the finished line either way.
 */
export type EvidenceRecord =
  | {
      readonly kind: "run-started";
      readonly redaction: "on" | "off";
      readonly about: Readonly<Record<string, string>>;
    }
  | {
      readonly kind: "action";
      readonly seq: number;
      /**
       * Who took it — CONTEXT.md's Controller, as it appears in the trail.
       * The auditor's user story is "a record of every action taken, by whom —
       * agent or human — so that responsibility for each change is
       * attributable", and one field on one record kind is what makes that
       * countable: a run's actions are one `jq` away from being split by
       * author, rather than living in two record types that have to be merged
       * by hand and re-sorted.
       */
      readonly by: Controller;
      /**
       * How long the Action took, which is Plain and is what a slow page looks
       * like. Absent for a human's Action: the capture sees a control being
       * used, not a call being made, and there is no honest duration to give
       * — a zero would be read as an instant one.
       */
      readonly ms?: number;
      readonly action: unknown;
      readonly result: unknown;
    }
  | {
      /**
       * The escalation was raised, in the four parts CONTEXT.md names. The
       * accessibility tree is deliberately not among them: it is served to the
       * operator over the loopback endpoint while they hold the session, and
       * writing every node of it here would put more Sensitive data on disk than
       * the rest of the run — the same trade the snapshot is left out of the log
       * for. What persists is which Capability, which Step, the masked screen,
       * and why.
       */
      readonly kind: "intervention-request";
      readonly capability: string;
      readonly step: string;
      readonly reason: string;
      readonly screen: string;
    }
  | {
      /**
       * A handover, in either direction. Two per escalation, and the boundary
       * that says which side of it every surrounding Action falls on.
       */
      readonly kind: "control";
      readonly to: Controller;
    }
  | { readonly kind: "failure-screenshot"; readonly file: string }
  | {
      readonly kind: "run-finished";
      readonly outcome: RunOutcome;
      readonly about: Readonly<Record<string, string>>;
    };

/**
 * How a run ended, in the vocabulary of CONTEXT.md and the ADRs and no other.
 *
 * A free string here would let each caller invent its own word for the same
 * ending, and a log whose outcomes cannot be counted is not a log anybody
 * queries.
 *
 * - `success` — the goal was met, or the Capability reached its success state.
 * - `business-outcome` — ADR 0005: a legitimate answer the application gave,
 *   named by the Capability that declared it. The one ending a Capability
 *   declares for itself rather than the system declaring for it, and counted
 *   apart from success because "no such account" and "here is the balance" are
 *   different things to have happened.
 * - `hard-failure` — ADR 0005: a state the run could not interpret or continue
 *   from.
 * - `intervention-request` — ADR 0007: the gate refused, and a person decides.
 *   Not a failure; the run stopped exactly as it was supposed to.
 * - `stopped` — a Discovery Run that did not produce what it was for: it ran
 *   out of steps, time, or ideas, or it reached the goal in a way that could
 *   not be saved as a Capability. It did not fail to understand anything, and
 *   nothing about the application broke; there is simply nothing to keep.
 */
export type RunOutcome =
  | "success"
  | "business-outcome"
  | "hard-failure"
  | "intervention-request"
  | "stopped";

export interface EvidenceRunOptions {
  /** The directory runs are kept under. `evidenceRunsDir()` in the command. */
  readonly root: string;
  /** Goes in the directory name, after the timestamp, so a run is findable. */
  readonly label: string;
  /** Plain facts about the run — which Capability, which inputs, where. */
  readonly about: Readonly<Record<string, string>>;
  readonly redaction: Redaction;
}

export class EvidenceRun {
  readonly #directory: string;
  readonly #redaction: Redaction;
  #seq = 0;
  #captured = false;

  private constructor(directory: string, redaction: Redaction) {
    this.#directory = directory;
    this.#redaction = redaction;
  }

  static async start(options: EvidenceRunOptions): Promise<EvidenceRun> {
    // Colons are legal in a path on this platform and not on every one, and a
    // run directory is a thing people copy between machines and into archives.
    const stamp = new Date().toISOString().replaceAll(":", "-");
    const directory = join(options.root, `${stamp}-${options.label}`);
    await mkdir(directory, { recursive: true });

    const run = new EvidenceRun(directory, options.redaction);
    await run.append({
      kind: "run-started",
      redaction: options.redaction.masking,
      about: run.#redactAbout(options.about),
    });
    return run;
  }

  get directory(): string {
    return this.#directory;
  }

  /** What this run masks, so the decorator classifies against the same setting. */
  get redaction(): Redaction {
    return this.#redaction;
  }

  /** The next sequence number, so the decorator can number an Action it is about to take. */
  nextSeq(): number {
    return this.#seq++;
  }

  async append(record: EvidenceRecord): Promise<void> {
    const line = JSON.stringify({ at: new Date().toISOString(), ...record });
    // The boundary. Fields were classified upstream; this is the pass that runs
    // whatever they were, so a Secret in a field nobody thought about does not
    // reach the disk.
    await appendFile(join(this.#directory, LOG_FILE), `${stripSecrets(this.#redaction, line)}\n`);
  }

  /**
   * The screen that stopped the run.
   *
   * Two callers reach this — the decorator, at the Action that missed, and the
   * command, at a run that ran out of Steps without arriving anywhere it could
   * name. The first wins, because the screen that explains a failure is the one
   * it happened on rather than any later one.
   *
   * A screenshot is pixels, so nothing here can mask a balance shown in it.
   * That is the deliberate trade in ADR 0006's terms: a reviewer needs to see
   * the state the system could not interpret, and an unreadable one would not
   * serve them. It is the one place evidence carries a Sensitive value the flag
   * does not reach.
   */
  async captureFailure(screenshot: Buffer): Promise<void> {
    if (this.#captured) return;
    this.#captured = true;

    await writeFile(join(this.#directory, SCREENSHOT_FILE), screenshot);
    await this.append({ kind: "failure-screenshot", file: SCREENSHOT_FILE });
  }

  async finish(outcome: RunOutcome, about: Readonly<Record<string, string>>): Promise<void> {
    await this.append({ kind: "run-finished", outcome, about: this.#redactAbout(about) });
  }

  /**
   * Plain by position, which is not the same as safe to write: a run's own
   * inputs are Sensitive and are substituted into things that describe it.
   */
  #redactAbout(about: Readonly<Record<string, string>>): Record<string, string> {
    return Object.fromEntries(
      Object.entries(about).map(([name, value]) => [name, redact(this.#redaction, "plain", value)]),
    );
  }
}

/**
 * Where this repository keeps its committed run evidence.
 *
 * Fixed rather than configurable, and `evidence/` is deliberately outside
 * `.gitignore` because it is a required deliverable. The cost is that every run
 * anybody makes lands in a tracked directory: replay the demo four times and
 * `git status` shows four run directories beside the three curated ones, which
 * is noise and is one `git add -A` away from committing a throwaway.
 *
 * Left that way on purpose for now — `evidence/runs/README.md` says which runs
 * are the committed ones, and deleting the rest is cheaper than an option every
 * reader has to understand. If it starts to bite, the fix is a `--evidence-dir`
 * on the command rather than the two tempting alternatives: `EvidenceRun.start`
 * already takes a `root` (the end-to-end tests pass a temporary one), so it is
 * a passthrough. An environment variable would hide the setting from the usage
 * text, and a `.gitignore` rule with exceptions would contradict the note in
 * that file asking for no `/evidence` rule at all.
 */
export function evidenceRunsDir(): string {
  return join(packageRootFrom(import.meta.url), "evidence", "runs");
}
