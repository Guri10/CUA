import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { Chatbot, ChatResult, RunOptions } from "./chatbot.js";
import { startChatUi, type ChatServer } from "./serve.js";

/**
 * The chat server's two routes, over real HTTP with a fake chatbot in place of
 * the model — the same seam `chatbot.test.ts` uses. What matters here is that the
 * page is served, that a request reaches the chatbot with its run choices intact,
 * that a blank request is turned away, and that the server is a caller, not a
 * guardrail: it passes the flags through and returns whatever the chatbot said.
 */
describe("the chatbot server", () => {
  let server: ChatServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  const RESULT: ChatResult = {
    steps: [
      {
        invocation: { ref: "member-balance@1", inputs: { memberNumber: "100234" } },
        outcome: { kind: "success", outputs: { shares: [] } },
      },
    ],
    answer: "Here are the shares.",
    ranOut: false,
  };

  /** A chatbot that records how it was called and answers with a fixed result. */
  function fakeChatbot(result: ChatResult = RESULT): {
    bot: Chatbot;
    calls: { utterance: string; options: RunOptions }[];
  } {
    const calls: { utterance: string; options: RunOptions }[] = [];
    const bot: Chatbot = {
      async run(utterance, options = {}) {
        calls.push({ utterance, options });
        return result;
      },
      async ask(utterance) {
        return (await bot.run(utterance)).answer;
      },
    };
    return { bot, calls };
  }

  it("serves the chat page at GET /", async () => {
    const { bot } = fakeChatbot();
    server = await startChatUi({ chatbot: bot, port: 0 });

    const response = await fetch(`${server.url}/`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(html).toContain("MERIDIAN");
    expect(html).toContain("Confirm before posting");
  });

  it("runs the chatbot for POST /chat and returns the structured result", async () => {
    const { bot, calls } = fakeChatbot();
    server = await startChatUi({ chatbot: bot, port: 0 });

    const response = await fetch(`${server.url}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "balances for 100234" }),
    });
    const body = (await response.json()) as ChatResult;

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.utterance).toBe("balances for 100234");
    expect(body.answer).toBe("Here are the shares.");
    expect(body.steps[0]!.invocation.ref).toBe("member-balance@1");
  });

  it("passes the preview, confirm, and proceed choices through to the chatbot", async () => {
    const { bot, calls } = fakeChatbot();
    server = await startChatUi({ chatbot: bot, port: 0 });

    await fetch(`${server.url}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "transfer $1", preview: false, confirm: true, proceed: true }),
    });

    expect(calls[0]!.options).toEqual({ preview: false, confirmMutating: true, proceed: true });
  });

  it("passes a confirmed invocation through, so a proceed binds to the shown action", async () => {
    const { bot, calls } = fakeChatbot();
    server = await startChatUi({ chatbot: bot, port: 0 });

    const invocation = { ref: "funds-transfer@1", inputs: { memberNumber: "100234", amount: "1.00" } };
    await fetch(`${server.url}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "post it", proceed: true, invocation }),
    });

    expect(calls[0]!.options.confirmed).toEqual(invocation);
  });

  it("requires a JSON content-type for POST /chat", async () => {
    const { bot, calls } = fakeChatbot();
    server = await startChatUi({ chatbot: bot, port: 0 });

    const response = await fetch(`${server.url}/chat`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ message: "transfer $1" }),
    });

    expect(response.status).toBe(415);
    expect(calls).toHaveLength(0);
  });

  it("rejects a POST whose Host header is not loopback", async () => {
    const { bot, calls } = fakeChatbot();
    server = await startChatUi({ chatbot: bot, port: 0 });
    const port = Number(new URL(server.url).port);

    const status = await postWithHost(port, "attacker.example", JSON.stringify({ message: "transfer $1" }));

    expect(status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("defaults every run choice to false when the request omits them", async () => {
    const { bot, calls } = fakeChatbot();
    server = await startChatUi({ chatbot: bot, port: 0 });

    await fetch(`${server.url}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hi" }),
    });

    expect(calls[0]!.options).toEqual({ preview: false, confirmMutating: false, proceed: false });
  });

  it("turns away a blank or missing message with a 400", async () => {
    const { bot, calls } = fakeChatbot();
    server = await startChatUi({ chatbot: bot, port: 0 });

    const blank = await fetch(`${server.url}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "   " }),
    });
    const missing = await fetch(`${server.url}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(blank.status).toBe(400);
    expect(missing.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("answers an unknown route with a 404", async () => {
    const { bot } = fakeChatbot();
    server = await startChatUi({ chatbot: bot, port: 0 });

    const getChat = await fetch(`${server.url}/chat`); // GET, not POST
    const nowhere = await fetch(`${server.url}/nowhere`);

    expect(getChat.status).toBe(404);
    expect(nowhere.status).toBe(404);
  });

  it("links a run to the dashboard when a dashboard URL is given", async () => {
    const { bot } = fakeChatbot();
    server = await startChatUi({ chatbot: bot, port: 0, dashboardUrl: "http://127.0.0.1:8789" });

    const html = await (await fetch(`${server.url}/`)).text();

    expect(html).toContain("http://127.0.0.1:8789");
  });
});

/**
 * A raw POST with a chosen Host header — `fetch` pins Host to the address it
 * dials, so the rebinding guard is exercised with `node:http` instead.
 */
function postWithHost(port: number, host: string, body: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path: "/chat", method: "POST", headers: { host, "content-type": "application/json" } },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}
