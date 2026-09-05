import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { accountLookupCapability } from "../capability/parabank/account-lookup.js";
import type { Capability } from "../capability/schema.js";
import { saveCapability } from "../capability/storage.js";
import { listCatalog } from "./catalog.js";

/**
 * The catalog is what a calling agent reads to discover what it can invoke, so
 * the things worth pinning are that every approved Capability shows up at the
 * version a bare-id invoke would run, that each entry carries the Contract and
 * only the Contract — the Recording is the part a caller must not see — and that
 * a draft never appears, because a caller must never invoke one.
 */
describe("Capability catalog", () => {
  let root = "";

  /** A signed-off Capability: the only kind the catalog offers. */
  const approved = (capability: Capability): Capability => ({ ...capability, approval: "approved" });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cua-catalog-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("lists every approved Capability at its highest version, in id order", async () => {
    await saveCapability(root, approved(accountLookupCapability()));
    await saveCapability(root, approved({ ...accountLookupCapability(), version: 2 }));
    await saveCapability(root, approved({ ...accountLookupCapability(), id: "open-account" }));

    const catalog = await listCatalog(root);

    expect(catalog.map((entry) => `${entry.id}@${entry.version}`)).toEqual([
      "account-lookup@2",
      "open-account@1",
    ]);
  });

  it("publishes the Contract with its JSON Schema, and no Recording", async () => {
    const capability = approved(accountLookupCapability());
    await saveCapability(root, capability);

    const [entry] = await listCatalog(root);

    expect(entry?.contract).toEqual(capability.contract);
    expect(entry?.contract.inputs.type).toBe("object");
    expect(entry).not.toHaveProperty("recordings");
  });

  it("omits drafts — they are authoring artifacts, invisible to the agent", async () => {
    // A draft on disk, at the only version there is: the catalog skips it rather
    // than offering the agent a Capability nobody has signed off.
    await saveCapability(root, accountLookupCapability());

    expect(await listCatalog(root)).toEqual([]);
  });

  it("omits an id whose highest version is a draft, even with an approved earlier one", async () => {
    // A bare id invokes the highest version, so the catalog offers that version
    // or nothing — never an older one a caller could not reach by name. Version 2
    // is an unreviewed draft, so the id drops out rather than advertising a v1 an
    // invoke would not run.
    await saveCapability(root, approved(accountLookupCapability()));
    await saveCapability(root, { ...accountLookupCapability(), version: 2 });

    expect(await listCatalog(root)).toEqual([]);
  });

  it("lists nothing when there are no Capabilities on disk", async () => {
    expect(await listCatalog(root)).toEqual([]);
  });
});
