import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { catalogClient } from "./catalog-client.js";

/**
 * The catalog client against replies that are not the JSON the catalog is
 * supposed to send — the case a wrong `--catalog` port or a catalog that died
 * mid-reply produces. The chatbot's whole job is to answer in plain language, so
 * a bad body must come back as a `rejected` outcome it can report, never as a
 * thrown parse error. A real Fake-Surface catalog exercises the happy paths in
 * `chatbot.test.ts`; this pins the ugly ones with a stub server.
 */
describe("the catalog client against malformed replies", () => {
  let server: Server | undefined;

  /** A stub catalog that answers every request with one fixed status and body. */
  async function stub(status: number, body: string, contentType = "text/html"): Promise<string> {
    server = createServer((_incoming, outgoing) => {
      outgoing.writeHead(status, { "content-type": contentType });
      outgoing.end(body);
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server!.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    return `http://127.0.0.1:${port}`;
  }

  afterEach(async () => {
    if (server !== undefined) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  it("turns a non-JSON error page into a rejected outcome instead of throwing", async () => {
    const url = await stub(502, "<html><body>Bad Gateway</body></html>");
    const client = catalogClient(url);

    const outcome = await client.invoke({ ref: "member-lookup", inputs: { q: "100234" } });

    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") {
      expect(outcome.status).toBe(502);
      expect(outcome.error).toContain("Bad Gateway");
    }
  });

  it("does not read a 200 whose body has no outcome kind as a success", async () => {
    const url = await stub(200, "not json at all");
    const client = catalogClient(url);

    const outcome = await client.invoke({ ref: "member-lookup", inputs: {} });

    // A 200 is only a success if it carries the shape a success has; a stray one
    // that does not is a rejection, not a silent empty success.
    expect(outcome.kind).toBe("rejected");
  });

  it("throws a clear error when the catalog list is not the JSON array it should be", async () => {
    const url = await stub(200, "<html>nope</html>");
    const client = catalogClient(url);

    await expect(client.list()).rejects.toThrow(/JSON array/i);
  });
});
