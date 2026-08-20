/**
 * The escalation, from the run stopping to the run continuing.
 *
 * Five things have to happen together and stay together: control moves, the
 * reason is written down, the endpoint opens, what the person does is recorded,
 * and then all of it unwinds. Doing them at the call site would mean each
 * caller doing them in its own order — and the orders that look reasonable are
 * not equivalent. Opening the endpoint before control moves is a window in
 * which a resume arrives for a session the agent still holds; stopping the
 * capture before control returns loses the person's last click, which is
 * usually the one that mattered.
 *
 * The one thing it does not own is the browser. Injecting listeners into a page
 * belongs to the Surface implementation that has one — a desktop Surface would
 * capture a person's actions through platform accessibility events instead, and
 * the shape of this function would not change. So it takes `capture` as a
 * function, the same way the discovery loop takes `decide` rather than a model
 * client.
 */
import { loggedAction, loggedResult } from "../evidence/classify-action.js";
import type { EvidenceRun } from "../evidence/run.js";
import { redactSessionIds } from "../evidence/redact-session-ids.js";
import type { StopCapture } from "../surface/human-actions.js";
import type { Action } from "../surface/surface.js";
import type { SessionControl } from "./controller.js";
import type { InterventionRequest } from "./intervention-request.js";
import { openResumeEndpoint } from "./resume-endpoint.js";

export type { StopCapture };

export interface HandoverOptions {
  readonly control: SessionControl;
  readonly evidence: EvidenceRun;
  /** Why the run stopped, and everything the operator needs to act on it. */
  readonly request: InterventionRequest;
  /**
   * Starts recording what the person does, in the Action vocabulary. Called
   * once, before the endpoint opens, so that nothing done between the window
   * becoming the person's and the endpoint being reachable is missed.
   */
  capture(onAction: (action: Action) => void): Promise<StopCapture>;
  /** Where the endpoint listens. Zero asks for a free one, which tests use. */
  readonly port?: number;
  /**
   * How the operator is told. The terminal, in the command; the tests read what
   * it was handed rather than the terminal.
   */
  announce?(message: string): void;
}

export interface Handover {
  /**
   * What the person did, in order, as Steps a Recording could carry. The
   * spec's user story is that a manual fix can later be folded into the
   * Recording rather than re-derived, and this list is that fix.
   */
  readonly actions: readonly Action[];
}

export async function handOverToHuman(options: HandoverOptions): Promise<Handover> {
  const { control, evidence, request } = options;
  const actions: Action[] = [];

  // Appends are asynchronous and the capture fires synchronously, so every
  // write goes through one chain. Without it a person clicking twice quickly
  // could have the two Actions land in the log in the order their `appendFile`
  // calls happened to resolve, which for an audit trail is the one thing it
  // must not do.
  let writing = Promise.resolve();
  const write = (record: Parameters<EvidenceRun["append"]>[0]): void => {
    writing = writing.then(() => evidence.append(record));
  };

  // Before the transition, so the trail reads in the order it happened: this is
  // why control moved, and then control moved.
  write({
    kind: "intervention-request",
    capability: request.capability,
    step: request.step,
    reason: request.reason,
    screen: redactSessionIds(request.observed.url),
  });
  // Registered rather than written at each transition, so that a handover the
  // endpoint ends is recorded by the same line as one this function ends. Torn
  // down with everything else: a run may escalate twice, and a listener left
  // behind by the first would write the second one's transitions twice.
  const stopWatching = control.onChange((controller) =>
    write({ kind: "control", to: controller }),
  );

  control.toHuman(request);

  let stop: StopCapture | undefined;
  let endpoint: Awaited<ReturnType<typeof openResumeEndpoint>> | undefined;

  try {
    stop = await options.capture((action) => {
      actions.push(action);
      write({
        kind: "action",
        seq: evidence.nextSeq(),
        by: "human",
        // No `ms`: the capture sees a control being used, not a call being
        // made. The result is `ok` because the browser already did it — there
        // is no Locator that could have missed, and nothing was dispatched
        // that could have been refused.
        action: loggedAction(evidence.redaction, action),
        result: loggedResult(evidence.redaction, { kind: "ok" }),
      });
    });

    endpoint = await openResumeEndpoint({
      control,
      request,
      ...(options.port === undefined ? {} : { port: options.port }),
    });
    options.announce?.(announcement(request, endpoint.url));

    await endpoint.resumed;
  } finally {
    // In this order, and in a `finally`, because three things must be true
    // afterwards however the pause ended — by a person resuming, or by the
    // capture failing to install, or by the port already being in use. Nobody
    // is left recording a session the agent is driving. No endpoint is left
    // listening for a resume that has already happened. And the Controller does
    // not still say a person holds a session nobody is holding, which would
    // leave every later Action refused with no way left to un-refuse it.
    await stop?.();
    await endpoint?.close();
    if (control.controller === "human") control.toAgent();
    stopWatching();
    await writing;
  }

  return { actions };
}

/**
 * What the operator reads. It is the whole interface: the spec puts a built
 * console out of scope, so this and the browser window already in front of them
 * is what they get, and it has to be enough to act without reading the source.
 */
function announcement(request: InterventionRequest, url: string): string {
  return [
    "Paused. This session is yours.",
    `  capability: ${request.capability}`,
    `  step:       ${request.step}`,
    `  screen:     ${redactSessionIds(request.observed.url)}`,
    `  reason:     ${request.reason}`,
    "",
    "  Do what is needed in the browser window; what you do is being recorded.",
    `  Then hand control back:  curl -X POST ${url}/resume`,
    `  Read this again:         curl ${url}`,
    "",
  ].join("\n");
}
