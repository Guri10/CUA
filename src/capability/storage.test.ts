import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { accountLookupCapability } from "./parabank/account-lookup.js";
import {
  capabilityFile,
  loadCapability,
  loadCapabilityRef,
  parseCapabilityRef,
  saveCapability,
} from "./storage.js";

/**
 * One file per version, git as the version store — so that a change to a
 * Capability is reviewable as a diff and a new Discovery Run is a new file
 * rather than an edit to a live one.
 *
 * Tested against a real directory rather than a mocked filesystem: the thing
 * under test is the file layout, so faking the files would leave nothing.
 */
describe("Capability storage", () => {
  let root = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cua-capabilities-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("saves at one file per version and loads it back unchanged", async () => {
    const capability = accountLookupCapability();

    const path = await saveCapability(root, capability);

    expect(path).toBe(join(root, "account-lookup", "1.json"));
    expect(await loadCapability(root, "account-lookup", 1)).toEqual(capability);
  });

  it("writes a file a reviewer can read in a diff", async () => {
    await saveCapability(root, accountLookupCapability());

    const written = await readFile(capabilityFile(root, "account-lookup", 1), "utf8");

    expect(written.startsWith("{\n")).toBe(true);
    expect(written.endsWith("}\n")).toBe(true);
  });

  it("resolves an <id>@<version> reference to that version", async () => {
    await saveCapability(root, accountLookupCapability());
    await saveCapability(root, { ...accountLookupCapability(), version: 2 });

    const capability = await loadCapabilityRef(root, "account-lookup@1");

    expect(capability.version).toBe(1);
  });

  it("resolves a bare id to the highest version", async () => {
    // Numerically. Ten versions in and a lexicographic sort would quietly pin
    // every caller to version 9.
    for (const version of [1, 2, 10]) {
      await saveCapability(root, { ...accountLookupCapability(), version });
    }

    const capability = await loadCapabilityRef(root, "account-lookup");

    expect(capability.version).toBe(10);
  });

  it("refuses a reference whose version is not a version", () => {
    expect(() => parseCapabilityRef("account-lookup@latest")).toThrow(/account-lookup@latest/);
  });

  it("refuses to save a Capability that does not validate", async () => {
    // The recorder writes these files unattended, so the guard belongs on the
    // way in. A broken Capability that reached disk would be found by whoever
    // next tried to replay it.
    const broken = { ...accountLookupCapability(), recordings: [] };

    await expect(saveCapability(root, broken)).rejects.toThrow(/exactly one base/i);
  });

  it("refuses to load a file that does not validate, naming it", async () => {
    await mkdir(join(root, "account-lookup"), { recursive: true });
    await writeFile(capabilityFile(root, "account-lookup", 1), `{"id":"account-lookup"}\n`, "utf8");

    await expect(loadCapability(root, "account-lookup", 1)).rejects.toThrow(/1\.json/);
  });

  it("says which Capability is missing rather than which file", async () => {
    await expect(loadCapabilityRef(root, "transfer-funds")).rejects.toThrow(/transfer-funds/);
  });
});
