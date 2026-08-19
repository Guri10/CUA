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
import { logInToParabank, type ParabankCredentials } from "./surface/parabank/login.js";
import type { Surface } from "./surface/surface.js";
import { capabilitiesDir, loadCapabilityRef } from "./capability/storage.js";
import { EvidenceRun, evidenceRunsDir } from "./evidence/run.js";
import { mandateFor } from "./policy/mandate.js";
import { openBrowserSurface } from "./policy/open-surface.js";
import { loadSurfaceProfile, surfacesDir } from "./policy/profile.js";
import { coerceTextValues, parseContractValues } from "./replay/contract-values.js";
import { describeMiss } from "./replay/describe.js";
import { replayCapability } from "./replay/replay.js";

const USAGE = `Usage:
  npm run replay -- --capability <id>[@<version>] --input <name>=<value> [options]

Options:
  --capability <ref>     Which Capability to replay. A bare id means its highest version.
  --input <name>=<value> One of the Contract's declared inputs. Repeatable.
  --variant <name>       Which Tenant's Recording to run. Defaults to the shared one.
  --base-url <url>       Where the application is. Defaults to $PARABANK_BASE_URL, then to the
                         Surface profile's own. The profile's allowlist still governs it.
  --headed               Show the browser window.
  --evidence-redaction <on|off>
                         Whether to mask Sensitive values in this run's evidence. On by
                         default. Secrets are never written under either setting.
`;

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
  // The Capability names its Surface profile; the profile is what says where
  // that installation is and which of its routes may be touched.
  const profile = await loadSurfaceProfile(surfacesDir(), capability.surface);

  // Normalised once, here. `absoluteUrl` strips a trailing slash and
  // `logInToParabank` concatenates raw, so a base URL ending in one would sign
  // in at `//index.htm` and replay Steps at `/overview.htm`. An override still
  // answers to the profile's allowed origins — the gate refuses it otherwise,
  // which is the point of the allowlist being checked-in rather than passed in.
  const baseUrl = (
    single(args, "base-url") ??
    process.env["PARABANK_BASE_URL"] ??
    profile.baseUrl
  ).replace(/\/+$/, "");
  const ident = `${capability.id}@${capability.version}`;

  // Decided before a browser exists, from two declared fields (ADR 0007). A
  // mutating Capability nobody has signed off does not get as far as a screen.
  const mandate = mandateFor(capability);
  if (!mandate.allowed) {
    process.stderr.write(`${mandate.reason}\n`);
    return 1;
  }
  // Kept as typed, before the Contract coerces them: these are the strings that
  // get substituted into Locators and so are the strings evidence has to
  // recognise as this run's own Sensitive values.
  const given = inputPairs(args.get("input") ?? []);
  const inputs = coerceTextValues(capability.contract.inputs, given, `Input to ${ident}`);
  // Checked here as well as inside the executor, and deliberately before a
  // browser exists: a mistyped input should cost a sentence, not a browser
  // launch and a sign-in. The executor keeps its own check because it is a
  // public seam and this is only one of its callers.
  parseContractValues(capability.contract.inputs, inputs, `This run's inputs for ${ident}`);

  const variant = single(args, "variant");
  const masking = maskingSetting(single(args, "evidence-redaction"));
  // Read before the browser launches, for the same reason the inputs are
  // checked there: a missing `.env` should cost a sentence, not a Chromium.
  const credentials = {
    username: required("PARABANK_USERNAME"),
    // ADR 0006 classes this a Secret: handed in at run time, never written.
    password: required("PARABANK_PASSWORD"),
  };

  // Opened before the browser is, so that signing in is logged too. The login
  // form is the one place this run types the application password, which makes
  // it the case ADR 0006's "no flag reaches a Secret" is really about.
  const evidence = await EvidenceRun.start({
    root: evidenceRunsDir(),
    label: `replay-${capability.id}`,
    about: {
      capability: ident,
      baseUrl,
      ...(variant === undefined ? {} : { variant }),
      // Prefixed rather than merged, so an input named `capability` cannot
      // quietly overwrite which Capability the log says ran.
      ...Object.fromEntries(Object.entries(given).map(([name, value]) => [`input.${name}`, value])),
    },
    redaction: {
      // ADR 0006's Secrets, in the only two forms this run holds them: the
      // password it was handed, and the session token ParaBank puts in its URLs
      // — which `stripSecrets` matches by pattern rather than by value.
      secrets: [credentials.password],
      // This run's own inputs. They are substituted into Locators, so they turn
      // up in fields that are Plain by position.
      sensitive: Object.values(given),
      masking,
    },
  });

  // Already gated, and already logged. There is no unwrapped Surface to reach
  // for, here or anywhere else — `no-ungated-surface.test.ts` keeps that true.
  const { surface, close } = await openBrowserSurface(profile, mandate, evidence, {
    headless: !args.has("headed"),
  });
  try {
    await establishSession(surface, baseUrl, credentials);

    const result = await replayCapability(surface, capability, inputs, {
      baseUrl,
      ...(variant === undefined ? {} : { variant }),
    });

    if (result.kind === "success") {
      await evidence.finish("success", {});
      // The declared outputs, in full. ADR 0006 masks a Sensitive value in
      // persisted evidence and never in what the caller asked for. What each
      // read returned is already in the log, masked, so it is not repeated
      // here — one copy, classified once.
      process.stdout.write(`${JSON.stringify(result.outputs, null, 2)}\n`);
      return 0;
    }

    // The backstop to the decorator's own capture. A run that took every Step
    // without ever missing and then found itself on a screen it could not name
    // has no failed Action to have triggered one; the decorator's capture wins
    // when there was one, because that is the screen that explains the run.
    await evidence.captureFailure(await surface.screenshot());
    await evidence.finish("hard-failure", {
      step: result.step,
      expected: result.expected,
      observed: result.observed,
      screen: result.url,
    });

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
  } catch (thrown) {
    // A Hard Failure by ADR 0005's definition — a state the run cannot
    // interpret or continue from — reached by something neither the Contract
    // nor the application accounted for: a browser that closed, a host that
    // went away. Recorded under the same name as any other, because a trail
    // that stops mid-sentence cannot be told apart from one never written.
    await evidence.finish("hard-failure", {
      observed: thrown instanceof Error ? thrown.message : String(thrown),
    });
    throw thrown;
  } finally {
    await close();
    // On stderr, because stdout is the caller's result and nothing else.
    process.stderr.write(`Evidence: ${evidence.directory}\n`);
  }
}

/**
 * Signing in before Step one.
 *
 * The executor is handed a Surface that already has a session and knows nothing
 * about how it got one — which is what keeps login out of every Recording.
 */
async function establishSession(
  surface: Surface,
  baseUrl: string,
  credentials: ParabankCredentials,
): Promise<void> {
  for (const action of logInToParabank(baseUrl, credentials)) {
    const result = await surface.perform(action);
    if (result.kind === "ok") continue;
    throw new Error(`Could not sign in to ${baseUrl}: ${describeMiss(result)}`);
  }
}

/**
 * `--evidence-redaction`, which is the only thing that moves ADR 0006's middle
 * kind. On unless told otherwise, and a value that is neither is refused rather
 * than read as "off" — the setting that writes real balances to disk is not one
 * to arrive at by typo.
 */
function maskingSetting(value: string | undefined): "on" | "off" {
  if (value === undefined || value === "on") return "on";
  if (value === "off") return "off";
  throw new Error(`--evidence-redaction takes "on" or "off", not "${value}".`);
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is not set. Copy .env.example to .env and fill it in.`);
  }
  return value;
}

/**
 * Every option there is, and whether it takes a value.
 *
 * Named rather than inferred, so that a misspelled option is refused instead of
 * collected and ignored. `--baseurl http://elsewhere` silently dropped is a run
 * against the wrong installation that reports success, which is worse than any
 * error message.
 */
const OPTIONS = {
  capability: "value",
  input: "value",
  variant: "value",
  "base-url": "value",
  headed: "flag",
  "evidence-redaction": "value",
} as const;

/**
 * `--name value`, `--name=value`, and `--flag`, collected so that a repeated
 * option keeps every occurrence — `--input` is given once per declared input.
 *
 * Both value forms, because `--input` intrinsically contains an `=` and the
 * joined form is the one a reader reaches for. Splitting at the first `=` only
 * is what keeps `--input=accountId=12345` meaning what it looks like.
 */
function parseArguments(argv: string[]): Map<string, string[]> {
  const args = new Map<string, string[]>();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("--")) throw new Error(`Unexpected argument "${token}".\n\n${USAGE}`);

    const joined = token.indexOf("=");
    const name = joined === -1 ? token.slice(2) : token.slice(2, joined);
    const takes = OPTIONS[name as keyof typeof OPTIONS];
    if (takes === undefined) throw new Error(`Unknown option "--${name}".\n\n${USAGE}`);

    if (takes === "flag") {
      if (joined !== -1) throw new Error(`--${name} takes no value.`);
      // Recorded as an empty value rather than as missing, so `has` answers it.
      args.set(name, [...(args.get(name) ?? []), ""]);
      continue;
    }

    const value = joined === -1 ? argv[++index] : token.slice(joined + 1);
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`--${name} needs a value.`);
    }
    args.set(name, [...(args.get(name) ?? []), value]);
  }

  return args;
}

function single(args: Map<string, string[]>, name: string): string | undefined {
  const values = args.get(name);
  if (values === undefined) return undefined;
  if (values.length > 1) throw new Error(`--${name} was given more than once.`);
  return values[0];
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
