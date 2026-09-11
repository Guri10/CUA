/**
 * The escalation itself: what a person is handed when the system stops.
 *
 * CONTEXT.md names the four things it must carry — the Capability, the current
 * Step, the observed state, and why it stopped — and this type is that list and
 * nothing else. The spec's user story says the same from the other side: an
 * operator wants enough context to act, which means not having to open the run
 * directory to find out which Step they are standing on.
 *
 * `observed` is the screen as the Surface saw it, not a description of it. The
 * URL is masked the way every other reported URL on this path is (ADR 0006
 * classes ParaBank's session token a Secret), and the accessibility tree is
 * carried whole because the operator reading it is the person already looking
 * at that same screen in the browser window beside them. That is why this value
 * is served over a loopback endpoint and why the tree is not what gets written
 * to evidence — the run log records the reason and the masked URL, which is the
 * part that survives the session.
 */

export interface InterventionRequest {
  /**
   * Which Capability, as `id@version`. A Discovery Run that is not recording
   * one says what it was given instead — the goal — because "the thing being
   * attempted" is what the operator needs and a run without an id still has
   * one.
   */
  readonly capability: string;
  /**
   * The Step the run had reached. A Recording's stable Step id during Replay;
   * during a Discovery Run there is no Recording yet, so it is the Action the
   * run was refused at, described.
   */
  readonly step: string;
  /** Why it stopped, in the words of whatever refused. */
  readonly reason: string;
  readonly observed: ObservedState;
}

export interface ObservedState {
  /** Where the screen is, with any session token masked. */
  readonly url: string;
  /** The accessibility tree, as the snapshot YAML. */
  readonly tree: string;
}

/**
 * The context an escalation carries to a caller that is not holding a browser.
 *
 * The CLI hands a person the live session and the whole Intervention Request,
 * observed screen and all. The catalog cannot: it refuses a mutating draft
 * before a run exists (ADR 0007), so there is no screen to observe and no
 * session to hand over. What it still carries is the rest of the Intervention
 * Request — which Capability, where it stopped, and why — which is what a caller
 * reading a stopped-with-context result over HTTP needs. It is that type minus
 * `observed` on purpose, so the two cannot drift: a field added to the live
 * request is a field this context carries too.
 */
export type EscalationContext = Omit<InterventionRequest, "observed">;
