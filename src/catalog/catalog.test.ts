import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { accountLookupCapability } from "../capability/parabank/account-lookup.js";
import { saveCapability } from "../capability/storage.js";
import { listCatalog } from "./catalog.js";

/**
 * The catalog is what a calling agent reads to discover what it can invoke, so
 * the two things worth pinning are that every Capability shows up at the
 * version a bare-id invoke would run, and that each entry carries the Contract
 * and only the Contract — the Recording is the part a caller must not see.
 */
describe("Capability catalog", () => {
  let root = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cua-catalog-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("lists every Capability at its highest version, in id order", async () => {
    await saveCapability(root, accountLookupCapability());
    await saveCapability(root, { ...accountLookupCapability(), version: 2 });
    await saveCapability(root, { ...accountLookupCapability(), id: "open-account" });

    const catalog = await listCatalog(root);

    expect(catalog.map((entry) => `${entry.id}@${entry.version}`)).toEqual([
      "account-lookup@2",
      "open-account@1",
    ]);
  });

  it("publishes the Contract with its JSON Schema, and no Recording", async () => {
    const capability = accountLookupCapability();
    await saveCapability(root, capability);

    const [entry] = await listCatalog(root);

    expect(entry?.contract).toEqual(capability.contract);
    expect(entry?.contract.inputs.type).toBe("object");
    expect(entry).not.toHaveProperty("recordings");
  });

  it("lists nothing when there are no Capabilities on disk", async () => {
    expect(await listCatalog(root)).toEqual([]);
  });
});
