/**
 * The catalog: every saved Capability, projected to the part a calling agent
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
 * One entry per id at its highest version, because a bare id invokes the
 * highest version and that is the one a caller should see. The history is on
 * disk for review; it is not part of what is offered.
 */
import { listCapabilities, loadCapabilityRef } from "../capability/storage.js";
import type { Contract } from "../capability/schema.js";

export interface CatalogEntry {
  readonly id: string;
  readonly version: number;
  /** The part a calling agent reads. JSON Schema for inputs and outputs. */
  readonly contract: Contract;
}

/** Every Capability on disk, highest version each, in id order. */
export async function listCatalog(root: string): Promise<CatalogEntry[]> {
  const ids = await listCapabilities(root);
  const entries: CatalogEntry[] = [];
  for (const id of ids) {
    const capability = await loadCapabilityRef(root, id);
    entries.push({ id: capability.id, version: capability.version, contract: capability.contract });
  }
  return entries;
}
