import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fundsTransferCapability } from "../capability/meridian/funds-transfer.js";
import { memberLookupCapability } from "../capability/meridian/member-lookup.js";
import type { Capability } from "../capability/schema.js";
import { saveCapability } from "../capability/storage.js";
import { startCatalog, type CatalogServer, type InvokeCapability } from "../catalog/serve.js";
import { loadSurfaceProfile, surfacesDir, type RecoverableCondition } from "../policy/profile.js";
import { replayCapability } from "../replay/replay.js";
import { FakeSurface } from "../surface/fake-surface.js";
import {
  MERIDIAN_CAPTURED_BASE_URL as BASE,
  meridianMemberLookupScript,
  meridianTransferScript,
} from "../surface/meridian/fake-script.js";
import { catalogClient } from "./catalog-client.js";
import { createChatbot } from "./chatbot.js";
import type { IntentRouter, NextAction } from "./types.js";

/**
 * The chatbot end to end, against a real in-process catalog backed by the
 * FakeSurface — the same Replay the CLI runs, over the same HTTP the catalog
 * serves — with only the LLM intent-router stubbed. So everything the ticket
 * asks about is exercised for real: the invocation crosses the wire and drives a
 * run, the chain is two live invokes with the second holding the first's result,
 * and the plain-language answer is shaped from the structured result that came
 * back. The router is the one thing faked, because a mocked model is the only way
 * to make the test deterministic; the boundary it stands behind is exact.
 *
 * The shares and amount are the funds-transfer Capability's own known-good inputs
 * (they drive the captured `posted` script through to its confirmation); the
 * member number in the chain is not hard-coded but taken from what the lookup
 * returned, which is the whole point of "resolve, then act".
 */
const TRANSFER = {
  fromShare: "100234-S0001-14 - Regular Shares ($100.00)",
  toShare: "100234-S0001-6 - Regular Shares ($40.00)",
  amount: "1.00",
  memo: "rent",
} as const;

describe("the chatbot over the catalog", () => {
  let root = "";
  let server: CatalogServer | undefined;
  let recoverableConditions: readonly RecoverableCondition[] = [];

  const approved = (capability: Capability): Capability => ({ ...capability, approval: "approved" });

  /** A one-shot router that plays a fixed sequence of actions, then stops. */
  function scriptedRouter(actions: readonly NextAction[]): IntentRouter {
    let turn = 0;
    return async () => actions[turn++] ?? { kind: "done" };
  }

  /**
   * The run itself: the real Replay against a FakeSurface, the script chosen from
   * what was asked, exactly as a live catalog would reach one of these endings.
   */
  const invoke: InvokeCapability = async (capability, inputs) => {
    if (capability.id === "member-lookup") {
      const q = String(inputs["q"] ?? "");
      const outcome = q === "999999" ? "none" : q === "o" ? "multiple" : "unique";
      return replayCapability(new FakeSurface(meridianMemberLookupScript(outcome)), capability, inputs, {
        baseUrl: BASE,
        recoverableConditions,
      });
    }
    if (capability.id === "funds-transfer") {
      return replayCapability(new FakeSurface(meridianTransferScript("posted")), capability, inputs, {
        baseUrl: BASE,
        recoverableConditions,
      });
    }
    throw new Error(`the test invoke does not drive "${capability.id}"`);
  };

  async function chatbotAsking(router: IntentRouter): Promise<(utterance: string) => Promise<string>> {
    server = await startCatalog({ root, invoke, port: 0 });
    const bot = createChatbot({ client: catalogClient(server.url), router });
    return (utterance) => bot.ask(utterance);
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cua-chatbot-"));
    await saveCapability(root, approved(memberLookupCapability()));
    await saveCapability(root, approved(fundsTransferCapability()));
    recoverableConditions = (await loadSurfaceProfile(surfacesDir(), "meridian")).recoverableConditions;
  });

  afterEach(async () => {
    await server?.close();
    server = undefined;
    await rm(root, { recursive: true, force: true });
  });

  it("turns a request into one invocation with typed args and reports the result", async () => {
    const ask = await chatbotAsking(
      scriptedRouter([
        { kind: "invoke", invocation: { ref: "member-lookup", inputs: { by: "Member Number", q: "100234" } } },
      ]),
    );

    const answer = await ask("look up member 100234");

    expect(answer).toMatch(/done/i);
    expect(answer).toContain("memberNumber: 100234");
    expect(answer).toContain("name: Lovelace, Ada");
  });

  it("chains resolve-then-act, carrying the resolved member number into the transfer", async () => {
    // The second action reads the first's result from history — a real chain, not
    // a pre-baked member number. This is "resolve a member, then act on them".
    const router: IntentRouter = async (_utterance, _catalog, history) => {
      if (history.length === 0) {
        return { kind: "invoke", invocation: { ref: "member-lookup", inputs: { by: "Last Name", q: "Lovelace" } } };
      }
      const resolved = history[0]!.outcome;
      if (history.length === 1 && resolved.kind === "success") {
        return {
          kind: "invoke",
          invocation: { ref: "funds-transfer", inputs: { memberNumber: resolved.outputs["memberNumber"], ...TRANSFER } },
        };
      }
      return { kind: "done" };
    };

    const answer = await (await chatbotAsking(router))("transfer $1 for Lovelace from shares 14 to 6");

    // The act's confirmation, not the resolve's member — the chain reports where
    // it ended.
    expect(answer).toContain("confirmationNumber: CN480243");
  });

  it("stops the chain and asks the caller to narrow when a name matches several", async () => {
    const router: IntentRouter = async (_utterance, _catalog, history) => {
      if (history.length === 0) {
        return { kind: "invoke", invocation: { ref: "member-lookup", inputs: { by: "Last Name", q: "o" } } };
      }
      // Would act next, but the resolve was ambiguous, so the loop never gets here.
      return { kind: "invoke", invocation: { ref: "funds-transfer", inputs: { memberNumber: "x", ...TRANSFER } } };
    };

    const answer = await (await chatbotAsking(router))("transfer $1 for someone called o");

    expect(answer).toMatch(/narrow/i);
    expect(answer).toMatch(/member number/i);
  });

  it("reports a clean 'no such member' when the lookup misses", async () => {
    const ask = await chatbotAsking(
      scriptedRouter([
        { kind: "invoke", invocation: { ref: "member-lookup", inputs: { by: "Member Number", q: "999999" } } },
      ]),
    );

    expect(await ask("look up member 999999")).toMatch(/couldn't find/i);
  });

  it("says it couldn't finish rather than passing off a mid-chain success as the answer", async () => {
    // A router that keeps invoking and never says "done": each lookup succeeds,
    // so the loop runs to its cap. The answer must not be the last success dressed
    // up as "Done" — it must own that the request wasn't finished.
    const forever = scriptedRouter(
      Array.from({ length: 10 }, (): NextAction => ({
        kind: "invoke",
        invocation: { ref: "member-lookup", inputs: { by: "Member Number", q: "100234" } },
      })),
    );

    const answer = await (await chatbotAsking(forever))("keep looking that up forever");

    expect(answer).toMatch(/couldn't finish/i);
    expect(answer).not.toMatch(/done/i);
    expect(answer).not.toContain("memberNumber: 100234");
  });

  it("reports the success when a chain finishes exactly at the step cap", async () => {
    // Exactly MAX_STEPS (6) successful invocations, then the scripted router is
    // done. The chain fills the cap but does not want to cross it, so its final
    // result is the answer — not the "couldn't finish" a chain that wanted more
    // earns. Before the fix, the 6th success set ranOut unconditionally and this
    // legitimate completion was reported as a failure.
    const exactlyAtCap = scriptedRouter(
      Array.from({ length: 6 }, (): NextAction => ({
        kind: "invoke",
        invocation: { ref: "member-lookup", inputs: { by: "Member Number", q: "100234" } },
      })),
    );

    const answer = await (await chatbotAsking(exactlyAtCap))("look that up right up to the limit");

    expect(answer).toMatch(/done/i);
    expect(answer).toContain("memberNumber: 100234");
    expect(answer).not.toMatch(/couldn't finish/i);
  });

  it("relays the catalog's escalation for a mutating draft, enforcing no guardrail of its own", async () => {
    // A mutating draft on disk, invoked by ref — bypassing catalog discovery,
    // which lists approved-only. The chatbot does not refuse it; it invokes it
    // and relays serve's 403, which is the point of "serve is the only boundary".
    await saveCapability(root, { ...fundsTransferCapability(), id: "transfer-draft", approval: "draft" });
    const ask = await chatbotAsking(
      scriptedRouter([
        {
          kind: "invoke",
          invocation: { ref: "transfer-draft", inputs: { memberNumber: "100234", ...TRANSFER } },
        },
      ]),
    );

    const answer = await ask("post this draft transfer");

    expect(answer).toMatch(/sign off/i);
    expect(answer).toMatch(/draft/i);
  });
});
