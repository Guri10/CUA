/**
 * The catalog: every approved Capability, projected to the part a calling agent
 * reads.
 *
 * A caller discovers what it can invoke by reading this list and nothing else.
 * Each entry carries the Capability's identity and its whole Contract — the
 * summary to choose by, the input and output JSON Schema to invoke against, the
 * declared effects, and the Terminal States it can reach. The Recording, which
 * is the part a caller does not read, is deliberately left out: publishing it
 * would leak the how, and a caller that read it would be coupling to Steps
 * rather than to the Contract.
 *
 * Approved only. A draft is an authoring artifact — a Capability the recorder
 * wrote that nobody has signed off — and the whole point of the catalog is that
 * an agent invokes what it finds there, so a draft found there is a draft
 * invoked. Approval, not effects, is the line: a read-only draft is still a
 * draft, and it stays out until somebody has put their name to it.
 *
 * One entry per id at its highest version, because a bare id invokes the highest
 * version and that is the one a caller should see. An id whose highest version
 * is a draft drops out entirely rather than advertising an older approved one a
 * bare-id invoke would not run. The history is on disk for review; it is not
 * part of what is offered.
 */
import { listCapabilities, loadCapabilityRef } from "../capability/storage.js";
import type { Contract } from "../capability/schema.js";

export interface CatalogEntry {
  readonly id: string;
  readonly version: number;
  /** The part a calling agent reads. JSON Schema for inputs and outputs. */
  readonly contract: Contract;
}

/**
 * Capabilities that exist and replay on disk but are deliberately not offered
 * over the served catalog (#52).
 *
 * `sign-on` is the one. It is session establishment, not a task an agent invokes,
 * and its Contract carries the operator password as an input — so offering it
 * would let a caller (chiefly the chatbot) route a password into an invoke payload
 * and evidence, the exact thing ADR 0006 forbids. It stays a recorded,
 * CLI-replayable Capability for §2.1 coverage; the served catalog simply does not
 * carry it, over either route (see `serve.ts`).
 */
export const UNSERVED_CAPABILITY_IDS: ReadonlySet<string> = new Set(["sign-on"]);

/** Every approved, served Capability on disk, highest version each, in id order. */
export async function listCatalog(root: string): Promise<CatalogEntry[]> {
  const ids = await listCapabilities(root);
  const entries: CatalogEntry[] = [];
  for (const id of ids) {
    if (UNSERVED_CAPABILITY_IDS.has(id)) continue;
    const capability = await loadCapabilityRef(root, id);
    if (capability.approval !== "approved") continue;
    entries.push({ id: capability.id, version: capability.version, contract: capability.contract });
  }
  return entries;
}
