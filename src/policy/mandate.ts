/**
 * What one run is allowed to do, decided before it starts.
 *
 * Two declared fields and nothing else: the effects the Capability declares,
 * and whether a human has signed it off. ADR 0007 rejected both alternatives —
 * the model labelling its own Steps, and inferring risk from button text —
 * because the point of a guardrail is that the thing being guarded has no vote
 * in it. What is left is a rule a reviewer checks in ten seconds.
 *
 * Every run today is unattended: there is no human watching a `npm run replay`.
 * Ticket 11 introduces one, along with the Controller that says whose turn it
 * is, and this is where the attended case will hang off when it does.
 */
import type { Capability } from "../capability/schema.js";

export type Mandate =
  | { readonly allowed: true; readonly mayMutate: boolean }
  | { readonly allowed: false; readonly reason: string };

export function mandateFor(capability: Capability): Mandate {
  // Approval answers "may this run at all", not "what may it touch". A
  // read-only Capability that happens to be approved still has no business on a
  // route that can move money, so the mandate follows the declared effects.
  if (capability.contract.effects === "read-only") return { allowed: true, mayMutate: false };

  if (capability.approval === "approved") return { allowed: true, mayMutate: true };

  return {
    allowed: false,
    reason:
      `"${capability.id}@${capability.version}" can change data and is still a draft, ` +
      `so it will not replay unattended. Review it and mark it approved.`,
  };
}
