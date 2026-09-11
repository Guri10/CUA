/**
 * The hidden password prompt for direct runs — replay and discover (#45).
 *
 * A direct run reads the Operator password the same two ways a served run does,
 * minus the portal: the in-memory store first (filled by an earlier sign-on in
 * the same process, or by the portal), and a hidden terminal prompt when the
 * store has nothing. The password is never a command-line argument — there is no
 * option that carries it, so it cannot land in a process listing or shell history
 * — and once typed it goes straight into the store as an ADR 0006 Secret, read
 * back by `sessionEstablisherFor` and never written.
 *
 * The prompt is a seam: `ensurePasswordInStore` takes it as an argument so the
 * precedence is tested without a TTY, and `terminalHiddenPrompt` is the real one
 * that reads from the terminal with the echo muted.
 */
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import type { SecretStore } from "../surface/secret-store.js";

/** Asks for a password without echoing it, resolving to what was typed. */
export type HiddenPrompt = (question: string) => Promise<string>;

export interface EnsurePasswordOptions {
  /** Where the password is read from and, when prompted, written to (#42). */
  readonly store: SecretStore;
  /** The non-secret operator id the password is keyed by. */
  readonly operator: string;
  /** Asked only when the store has no password for this operator. */
  readonly prompt: HiddenPrompt;
}

/**
 * Ensure the store holds the operator's password, prompting hidden when it does
 * not. Precedence is the store, then the prompt (#45): a stored password is used
 * as-is and the prompt is never reached; otherwise the prompt is asked exactly
 * once and its answer stored. A blank answer is refused rather than kept, so an
 * empty secret can never sign a run in and fail mystifyingly at the login form.
 */
export async function ensurePasswordInStore(options: EnsurePasswordOptions): Promise<void> {
  if (options.store.get(options.operator) !== undefined) return;

  const password = await options.prompt(`Password for MERIDIAN operator "${options.operator}": `);
  if (password === "") {
    throw new Error("No password entered.");
  }
  options.store.set(options.operator, password);
}

/**
 * The real hidden prompt: reads one line from the terminal without echoing it.
 *
 * The prompt string is written once, then the echoed keystrokes are swallowed by
 * a muted output stream, so the password never appears on screen or in the
 * terminal's scrollback. A newline is written after the answer so the next line
 * of output does not run on from the hidden entry.
 */
export function terminalHiddenPrompt(): HiddenPrompt {
  return (question) =>
    new Promise<string>((resolve, reject) => {
      let muted = false;
      const output = new Writable({
        write(chunk, _encoding, callback) {
          // Write the question, then nothing: once muted, the keystrokes the
          // readline echoes back are dropped instead of reaching the screen.
          if (!muted) process.stdout.write(chunk);
          callback();
        },
      });

      const rl = createInterface({ input: process.stdin, output, terminal: true });
      rl.on("error", reject);
      rl.question(question, (answer) => {
        rl.close();
        process.stdout.write("\n");
        resolve(answer);
      });
      // The question was written synchronously by `question` above; mute now so
      // only the typing that follows is hidden.
      muted = true;
    });
}
