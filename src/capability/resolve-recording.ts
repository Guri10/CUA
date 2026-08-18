/**
 * Which Steps a Tenant actually runs.
 *
 * One Capability holds one shared Recording plus, per Tenant that needs it, a
 * patch keyed by Step id. Resolving is applying that patch — so a correction to
 * the shared flow reaches every Tenant, and a site-specific difference stays a
 * two-line entry rather than a second copy of the whole Recording.
 *
 * The Steps keep their order and their ids: a patch corrects a Step in place
 * and cannot add, remove, or reorder one. That is a deliberate limit. A Tenant
 * whose flow has a different shape has a different Recording, and pretending
 * otherwise inside a patch format is how a "small correction" turns into an
 * unreviewable diff.
 */
import { BASE_VARIANT, isBaseRecording, type Capability, type Step } from "./schema.js";

export function resolveRecording(capability: Capability, variant: string = BASE_VARIANT): Step[] {
  const base = capability.recordings.find(isBaseRecording);
  if (base === undefined) {
    // The schema guarantees exactly one, so reaching here means an unvalidated
    // Capability was constructed in code — a programming error, not a state of
    // the application.
    throw new Error(`Capability "${capability.id}@${capability.version}" has no base Recording.`);
  }

  // A Tenant with no Recording of its own runs the shared flow unchanged. That
  // is the common case and the whole point of the shared Recording.
  const override = capability.recordings.find(
    (recording) => !isBaseRecording(recording) && recording.variant === variant,
  );
  if (override === undefined || isBaseRecording(override)) return base.steps;

  return base.steps.map((step) => {
    const patch = override.patch[step.id];
    return patch === undefined ? step : { id: step.id, action: patch.action };
  });
}
