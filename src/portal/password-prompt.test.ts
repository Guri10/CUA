import { describe, expect, it } from "vitest";
import { SecretStore } from "../surface/secret-store.js";
import { ensurePasswordInStore, type HiddenPrompt } from "./password-prompt.js";

/**
 * The precedence a direct run (replay/discover) reads the operator password by
 * (#45): the store first, then a hidden prompt only when the store has nothing.
 * The prompt is the seam — a fake stands in for the terminal — so the rule can be
 * proven without a TTY: the store wins outright, the prompt is asked at most once,
 * and a blank answer is refused rather than stored as an empty secret.
 */
describe("ensuring the operator password is in the store", () => {
  /** A prompt that records its calls and answers with a fixed value. */
  function fakePrompt(answer = "typed-secret"): { prompt: HiddenPrompt; asked: string[] } {
    const asked: string[] = [];
    const prompt: HiddenPrompt = async (question) => {
      asked.push(question);
      return answer;
    };
    return { prompt, asked };
  }

  it("uses the stored password and never prompts when the store has one", async () => {
    const store = new SecretStore();
    store.set("super1", "already-there");
    const { prompt, asked } = fakePrompt();

    await ensurePasswordInStore({ store, operator: "super1", prompt });

    expect(asked).toEqual([]);
    expect(store.get("super1")).toBe("already-there");
  });

  it("prompts once and stores the answer when the store has none", async () => {
    const store = new SecretStore();
    const { prompt, asked } = fakePrompt("typed-secret");

    await ensurePasswordInStore({ store, operator: "super1", prompt });

    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("super1");
    expect(store.get("super1")).toBe("typed-secret");
  });

  it("refuses a blank answer rather than storing an empty secret", async () => {
    const store = new SecretStore();
    const { prompt } = fakePrompt("");

    await expect(ensurePasswordInStore({ store, operator: "super1", prompt })).rejects.toThrow(
      /no password entered/i,
    );
    expect(store.get("super1")).toBeUndefined();
  });
});
