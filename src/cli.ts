/**
 * The command line. One command today — `replay` — with `discover` and `serve`
 * to follow.
 *
 * Everything about establishing a session lives here rather than in the
 * executor. Logging in is a property of the application, not of any one
 * Capability: the day ParaBank's form gains a field, one description changes
 * instead of every Recording. ADR 0005 puts the same event mid-run — an expired
 * session, a login interstitial — in the Surface profile for the same reason,
 * and ticket 7 is where this wiring moves when that profile exists.
 *
 * Run with: npm run replay -- --capability account-lookup@1 --input accountId=12345
 */
import { logInToParabank } from "./surface/parabank/login.js";
import { PlaywrightSurface } from "./surface/playwright-surface.js";
import { capabilitiesDir, loadCapabilityRef } from "./capability/storage.js";
import { coerceTextValues, parseContractValues } from "./replay/contract-values.js";
import { replayCapability } from "./replay/replay.js";

const USAGE = `Usage:
  npm run replay -- --capability <id>[@<version>] --input <name>=<value> [options]

Options:
  --capability <ref>     Which Capability to replay. A bare id means its highest version.
  --input <name>=<value> One of the Contract's declared inputs. Repeatable.
  --variant <name>       Which Tenant's Recording to run. Defaults to the shared one.
  --base-url <url>       Where the application is. Defaults to $PARABANK_BASE_URL.
  --headed               Show the browser window.
`;

/**
 * The only Surface profile there is. Ticket 7 replaces this with a described
 * one; naming it here rather than assuming it means a Capability recorded
 * against something else fails with a sentence instead of a wrong login.
 */
const PARABANK = "parabank";

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command !== "replay") {
    const complaint = command === undefined ? "No command given." : `Unknown command "${command}".`;
    process.stderr.write(`${complaint}\n\n${USAGE}`);
    return 2;
  }

  const args = parseArguments(rest);
  const ref = single(args, "capability");
  if (ref === undefined) {
    process.stderr.write(`--capability is required.\n\n${USAGE}`);
    return 2;
  }

  const capability = await loadCapabilityRef(capabilitiesDir(), ref);
  if (capability.surface !== PARABANK) {
    throw new Error(
      `Capability "${ref}" runs against the "${capability.surface}" Surface, and only "${PARABANK}" is described so far.`,
    );
  }

  const baseUrl =
    single(args, "base-url") ??
    process.env["PARABANK_BASE_URL"] ??
    "http://localhost:8080/parabank";
  const ident = `${capability.id}@${capability.version}`;
  const inputs = coerceTextValues(
    capability.contract.inputs,
    inputPairs(args.get("input") ?? []),
    `Input to ${ident}`,
  );
  // Checked here as well as inside the executor, and deliberately before a
  // browser exists: a mistyped input should cost a sentence, not a browser
  // launch and a sign-in. The executor keeps its own check because it is a
  // public seam and this is only one of its callers.
  parseContractValues(capability.contract.inputs, inputs, `This run's inputs for ${ident}`);

  const variant = single(args, "variant");

  const surface = await PlaywrightSurface.launch({ headless: !args.has("headed") });
  try {
    await establishSession(surface, baseUrl);

    const result = await replayCapability(surface, capability, inputs, {
      baseUrl,
      ...(variant === undefined ? {} : { variant }),
    });

    if (result.kind === "success") {
      // The declared outputs, in full. ADR 0006 masks a Sensitive value in
      // persisted evidence and never in what the caller asked for.
      process.stdout.write(`${JSON.stringify(result.outputs, null, 2)}\n`);
      return 0;
    }

    process.stderr.write(
      [
        `${ident} stopped at Step "${result.step}".`,
        `  expected: ${result.expected}`,
        `  observed: ${result.observed}`,
        `  screen:   ${result.url}`,
        "",
      ].join("\n"),
    );
    return 1;
  } finally {
    await surface.close();
  }
}

/**
 * Signing in before Step one.
 *
 * The executor is handed a Surface that already has a session and knows nothing
 * about how it got one — which is what keeps login out of every Recording.
 */
async function establishSession(surface: PlaywrightSurface, baseUrl: string): Promise<void> {
  const credentials = {
    username: required("PARABANK_USERNAME"),
    // ADR 0006 classes this a Secret: handed in at run time, never written.
    password: required("PARABANK_PASSWORD"),
  };

  for (const action of logInToParabank(baseUrl, credentials)) {
    const result = await surface.perform(action);
    if (result.kind === "ok") continue;
    throw new Error(
      `Could not sign in to ${baseUrl}: ${result.kind} for ${result.locator.role} control.`,
    );
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is not set. Copy .env.example to .env and fill it in.`);
  }
  return value;
}

/**
 * `--name value` and `--flag`, collected so that a repeated option keeps every
 * occurrence — `--input` is given once per declared input.
 */
function parseArguments(argv: string[]): Map<string, string[]> {
  const args = new Map<string, string[]>();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("--")) throw new Error(`Unexpected argument "${token}".\n\n${USAGE}`);

    const name = token.slice(2);
    // A flag standing on its own — `--headed` — is recorded as an empty value
    // rather than being missing, so `has` answers it and `single` does not
    // mistake it for an option that was given a value.
    const next = argv[index + 1];
    const takesValue = next !== undefined && !next.startsWith("--");
    if (takesValue) index += 1;

    args.set(name, [...(args.get(name) ?? []), takesValue ? next : ""]);
  }

  return args;
}

function single(args: Map<string, string[]>, name: string): string | undefined {
  const values = args.get(name);
  if (values === undefined) return undefined;
  if (values.length > 1) throw new Error(`--${name} was given more than once.`);
  return values[0] === "" ? undefined : values[0];
}

/** `--input accountId=12345`, split at the first `=` so a value may contain one. */
function inputPairs(values: string[]): Record<string, string> {
  return Object.fromEntries(
    values.map((pair) => {
      const at = pair.indexOf("=");
      if (at < 1) throw new Error(`--input takes <name>=<value>, not "${pair}".`);
      return [pair.slice(0, at), pair.slice(at + 1)];
    }),
  );
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
