import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { accountLookupCapability } from "../capability/parabank/account-lookup.js";
import type { Capability } from "../capability/schema.js";
import { saveCapability } from "../capability/storage.js";
import type { ReplayResult } from "../replay/replay.js";
import { startCatalog, type CatalogServer, type InvokeCapability } from "./serve.js";

/**
 * The catalog over HTTP, tested through a Fake invoke so the two guarantees the
 * server owns — nothing invalid reaches a run, nothing mutating and unapproved
 * runs at all — are checked without a browser. The run itself is somebody
 * else's code; what matters here is what the server does around it.
 */
describe("Capability catalog server", () => {
  let root = "";
  let server: CatalogServer | undefined;

  /** A mutating draft: refused before any run, whatever the invoke would do. */
  function openAccountDraft(): Capability {
    const base = accountLookupCapability();
    return {
      ...base,
      id: "open-account",
      approval: "draft",
      contract: { ...base.contract, effects: "mutating" },
    };
  }

  /** Records every call, so a test can assert the run never started. */
  function recordingInvoke(result: ReplayResult): InvokeCapability & { readonly calls: unknown[] } {
    const calls: unknown[] = [];
    const invoke = (async (capability, inputs, options) => {
      calls.push({ id: capability.id, inputs, options });
      return result;
    }) as InvokeCapability & { calls: unknown[] };
    invoke.calls = calls;
    return invoke;
  }

  async function serve(invoke: InvokeCapability): Promise<string> {
    server = await startCatalog({ root, invoke, port: 0 });
    return server.url;
  }

  /** The JSON body, loosely typed: these tests assert on shape, not on types. */
  const bodyOf = (response: Response): Promise<Record<string, any>> =>
    response.json() as Promise<Record<string, any>>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cua-serve-"));
  });

  afterEach(async () => {
    await server?.close();
    server = undefined;
    await rm(root, { recursive: true, force: true });
  });

  it("lists every Capability with its Contract as JSON Schema", async () => {
    await saveCapability(root, accountLookupCapability());
    const url = await serve(recordingInvoke({ kind: "success", outputs: {} }));

    const response = await fetch(`${url}/capabilities`);
    const body = await bodyOf(response);

    expect(response.status).toBe(200);
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe("account-lookup");
    expect(body[0].contract.inputs.type).toBe("object");
    expect(body[0].contract.inputs.properties.accountId.type).toBe("string");
  });

  it("invokes by name with typed arguments and returns the result", async () => {
    await saveCapability(root, accountLookupCapability());
    const invoke = recordingInvoke({
      kind: "success",
      outputs: { accountType: "CHECKING", balance: "-$2300.00" },
    });
    const url = await serve(invoke);

    const response = await fetch(`${url}/capabilities/account-lookup/invoke`, {
      method: "POST",
      body: JSON.stringify({ inputs: { accountId: "12345" } }),
    });
    const body = await bodyOf(response);

    expect(response.status).toBe(200);
    expect(body).toEqual({
      kind: "success",
      outputs: { accountType: "CHECKING", balance: "-$2300.00" },
    });
    expect(invoke.calls).toEqual([{ id: "account-lookup", inputs: { accountId: "12345" }, options: {} }]);
  });

  it("returns a Business Outcome as an answer, in the same discriminated shape", async () => {
    await saveCapability(root, accountLookupCapability());
    const url = await serve(
      recordingInvoke({ kind: "business-outcome", name: "ACCOUNT_NOT_FOUND", step: "wait-for-link" }),
    );

    const response = await fetch(`${url}/capabilities/account-lookup/invoke`, {
      method: "POST",
      body: JSON.stringify({ inputs: { accountId: "99999" } }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      kind: "business-outcome",
      name: "ACCOUNT_NOT_FOUND",
      step: "wait-for-link",
    });
  });

  it("returns a Hard Failure as a 502, carrying the screen it could not interpret", async () => {
    await saveCapability(root, accountLookupCapability());
    const url = await serve(
      recordingInvoke({
        kind: "hard-failure",
        step: "read-balance",
        expected: "the account detail page",
        observed: "an error page",
        url: "http://localhost:8080/parabank/error.htm",
      }),
    );

    const response = await fetch(`${url}/capabilities/account-lookup/invoke`, {
      method: "POST",
      body: JSON.stringify({ inputs: { accountId: "12345" } }),
    });

    expect(response.status).toBe(502);
    expect((await bodyOf(response)).kind).toBe("hard-failure");
  });

  it("rejects invalid arguments against the Contract before any run starts", async () => {
    await saveCapability(root, accountLookupCapability());
    const invoke = recordingInvoke({ kind: "success", outputs: {} });
    const url = await serve(invoke);

    // accountId is required; sending none must fail against the Contract.
    const response = await fetch(`${url}/capabilities/account-lookup/invoke`, {
      method: "POST",
      body: JSON.stringify({ inputs: {} }),
    });

    expect(response.status).toBe(400);
    expect((await bodyOf(response)).error).toMatch(/Contract/i);
    expect(invoke.calls).toEqual([]);
  });

  it("refuses a mutating draft before any run starts", async () => {
    await saveCapability(root, openAccountDraft());
    const invoke = recordingInvoke({ kind: "success", outputs: {} });
    const url = await serve(invoke);

    const response = await fetch(`${url}/capabilities/open-account/invoke`, {
      method: "POST",
      body: JSON.stringify({ inputs: {} }),
    });

    expect(response.status).toBe(403);
    expect((await bodyOf(response)).error).toMatch(/draft/i);
    expect(invoke.calls).toEqual([]);
  });

  it("answers 400, not 404, for a reference that is not a reference", async () => {
    await saveCapability(root, accountLookupCapability());
    const url = await serve(recordingInvoke({ kind: "success", outputs: {} }));

    // `@latest` is the caller asking wrong, not a missing Capability.
    const response = await fetch(`${url}/capabilities/${encodeURIComponent("account-lookup@latest")}/invoke`, {
      method: "POST",
      body: JSON.stringify({ inputs: { accountId: "12345" } }),
    });

    expect(response.status).toBe(400);
  });

  it("answers 404 for a Capability that is not on disk", async () => {
    const url = await serve(recordingInvoke({ kind: "success", outputs: {} }));

    const response = await fetch(`${url}/capabilities/nope/invoke`, {
      method: "POST",
      body: JSON.stringify({ inputs: {} }),
    });

    expect(response.status).toBe(404);
  });

  it("rejects a body that is not a JSON object", async () => {
    await saveCapability(root, accountLookupCapability());
    const url = await serve(recordingInvoke({ kind: "success", outputs: {} }));

    const response = await fetch(`${url}/capabilities/account-lookup/invoke`, {
      method: "POST",
      body: "not json",
    });

    expect(response.status).toBe(400);
  });

  it("answers 404 for an unknown route", async () => {
    const url = await serve(recordingInvoke({ kind: "success", outputs: {} }));

    expect((await fetch(`${url}/`)).status).toBe(404);
  });
});
