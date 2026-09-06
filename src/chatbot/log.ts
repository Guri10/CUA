/**
 * A per-query chatbot log, separate from the deterministic replay evidence under
 * `evidence/runs/`.
 *
 * The evidence runs answer "what did this one replay do, step by step" — and they
 * redact inputs to [SENSITIVE], so they cannot answer "which Capabilities did one
 * chatbot utterance invoke, and with what inputs did the model call them". This
 * log answers exactly that: one file per utterance, holding the request, the
 * chain the router built, the real inputs each step was called with, and how each
 * ended. It is a debugging aid, not a deliverable — unredacted on purpose so it
 * can be trusted for what was invoked, and therefore never committed (see
 * `.gitignore`). The one thing it will not write is a Secret (ADR 0006): the
 * password never reaches a Capability's inputs, but any key that looks like one
 * is dropped here as a belt-and-braces guard.
 *
 * Writing is best-effort: a log that fails to write must never fail the chat
 * request it was recording, so a write error is swallowed after a one-line
 * warning. Files are named by timestamp so they sort in run order.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { packageRootFrom } from "../package-root.js";
import type { ChatResult, RunOptions } from "./chatbot.js";
import type { Step } from "./types.js";

/** The folder chatbot query logs are written to. */
export function chatbotLogsDir(): string {
  return join(packageRootFrom(import.meta.url), "chatbot-logs");
}

/** One completed chatbot query, as the log records it. */
export interface ChatLogEntry {
  /** The utterance the caller sent. */
  readonly utterance: string;
  /** The run choices the caller set (preview / confirm / proceed). */
  readonly options: RunOptions;
  /** The structured result — the chain, the answer, and any pause. */
  readonly result: ChatResult;
}

/** Called once per completed chatbot query, to record what it invoked. */
export type ChatLogger = (entry: ChatLogEntry) => void;

/**
 * A `ChatLogger` that writes one JSON file per query into `dir`. Best-effort:
 * a write failure is warned about, not thrown, so logging never breaks a chat.
 */
export function fileChatLogger(dir: string): ChatLogger {
  return (entry) => {
    try {
      mkdirSync(dir, { recursive: true });
      const at = new Date().toISOString();
      const file = join(dir, `${at.replace(/[:.]/g, "-")}.json`);
      writeFileSync(file, `${JSON.stringify(record(at, entry), null, 2)}\n`, "utf8");
    } catch (thrown) {
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      process.stderr.write(`chatbot log not written: ${message}\n`);
    }
  };
}

/** The on-disk shape: the query, its choices, and the chain flattened for reading. */
function record(at: string, entry: ChatLogEntry): unknown {
  const { result } = entry;
  return {
    at,
    utterance: entry.utterance,
    preview: entry.options.preview === true,
    confirm: entry.options.confirmMutating === true,
    proceed: entry.options.proceed === true,
    answer: result.answer,
    ranOut: result.ranOut,
    ...(result.pending !== undefined
      ? { pending: { ref: result.pending.ref, reason: result.pending.reason, inputs: safeInputs(result.pending.invocation.inputs) } }
      : {}),
    steps: result.steps.map(stepRecord),
  };
}

/** One step: which Capability, the inputs it was called with, and how it ended. */
function stepRecord(step: Step): unknown {
  return {
    ref: step.invocation.ref,
    ...(step.invocation.variant !== undefined ? { variant: step.invocation.variant } : {}),
    inputs: safeInputs(step.invocation.inputs),
    outcome: step.outcome,
  };
}

/**
 * Inputs as invoked, minus any key that reads like a Secret. The chatbot never
 * puts a password in a Capability's inputs (the session carries it), so this only
 * ever guards against a future input named like one — never the normal case.
 */
function safeInputs(inputs: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(inputs)) {
    out[key] = /password|secret|token/i.test(key) ? "[REDACTED]" : value;
  }
  return out;
}
