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
      /** How long the Action took, which is Plain and is what a slow page looks like. */
      readonly ms: number;
      readonly action: unknown;
      readonly result: unknown;
    }
  | { readonly kind: "failure-screenshot"; readonly file: string }
  | {
      readonly kind: "run-finished";
      readonly outcome: RunOutcome;
      readonly about: Readonly<Record<string, string>>;
    };

/**
 * How a run ended, in ADR 0004's and ADR 0005's vocabulary and no other.
 *
 * A free string here would let each caller invent its own word for the same
 * ending, and a log whose outcomes cannot be counted is not a log anybody
 * queries. #6 adds the third member — a named Business Outcome — which is why
 * this is two today rather than a string with two usual values.
 */
export type RunOutcome = "success" | "hard-failure";

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

/** Where this repository keeps its committed run evidence. */
export function evidenceRunsDir(): string {
  return join(packageRootFrom(import.meta.url), "evidence", "runs");
}
