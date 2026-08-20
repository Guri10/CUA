/**
 * The command line. Two commands — `discover` and `replay` — with `serve` to
 * follow.
 *
 * Everything about establishing a session lives here rather than in the
 * executor. Logging in is a property of the application, not of any one
 * Capability: the day ParaBank's form gains a field, one description changes
 * instead of every Recording. ADR 0005 puts the same event mid-run — an expired
 * session — in the Surface profile, which is where it is now declared; what
 * stays here is the one part a checked-in file cannot hold, the credentials.
 * So this command hands the executor both a signed-in Surface and the means of
 * signing in again.
 *
 * Run with: npm run replay -- --capability account-lookup@1 --input accountId=12345
 */
import { logInToParabank, type ParabankCredentials } from "./surface/parabank/login.js";
import type { Surface } from "./surface/surface.js";
import { capabilitiesDir, listVersions, loadCapabilityRef, saveCapability } from "./capability/storage.js";
import { discover, type DiscoveryResult, type TakenStep } from "./discovery/discover.js";
import { recordCapability, type RecordingPlan } from "./discovery/record.js";
import { EvidenceRun, evidenceRunsDir } from "./evidence/run.js";
import { discoveryMandate, mandateFor } from "./policy/mandate.js";
import { openBrowserSurface } from "./policy/open-surface.js";
import { loadSurfaceProfile, surfacesDir, type SurfaceProfile } from "./policy/profile.js";
import { coerceTextValues, parseContractValues } from "./replay/contract-values.js";
import { describeAction, describeMiss } from "./replay/describe.js";
import { replayCapability } from "./replay/replay.js";

const SHARED_USAGE = `  --base-url <url>       Where the application is. Defaults to $PARABANK_BASE_URL, then to the
                         Surface profile's own. The profile's allowlist still governs it.
  --headed               Show the browser window.
  --evidence-redaction <on|off>
                         Whether to mask Sensitive values in this run's evidence. On by
                         default. Secrets are never written under either setting.
`;

const USAGE = `Usage:
  npm run discover -- --goal "..." [options]
  npm run replay -- --capability <id>[@<version>] --input <name>=<value> [options]

discover options:
  --goal <text>          What the run is trying to accomplish, in plain language.
  --entry <path>         Where the run starts. Defaults to /overview.htm.
  --surface <id>         Which Surface profile to run against. Defaults to parabank.
  --max-steps <n>        How many Actions the run may take. Defaults to 25.
  --timeout <seconds>    How long the whole run may take. Defaults to 300.
  --capability <id>      Save what the run worked out under this id, as its next version.
                         Without it the run explores and records nothing.
  --input <name>=<value> A value the run may use, under the name the Contract will declare
                         it as. Repeatable. Every one must be used, or nothing is saved.
  --output <name>        A value the run must come back with. Repeatable. Each is bound by
                         a read the model names.

replay options:
  --capability <ref>     Which Capability to replay. A bare id means its highest version.
  --input <name>=<value> One of the Contract's declared inputs. Repeatable.
  --variant <name>       Which Tenant's Recording to run. Defaults to the shared one.

Both:
${SHARED_USAGE}`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "discover") return await discoverCommand(parseArguments(rest, DISCOVER_OPTIONS));
  if (command === "replay") return await replayCommand(parseArguments(rest, REPLAY_OPTIONS));

  const complaint = command === undefined ? "No command given." : `Unknown command "${command}".`;
  process.stderr.write(`${complaint}\n\n${USAGE}`);
  return 2;
}

async function replayCommand(args: Map<string, string[]>): Promise<number> {
  const ref = single(args, "capability");
  if (ref === undefined) {
    process.stderr.write(`--capability is required.\n\n${USAGE}`);
    return 2;
  }

  const capability = await loadCapabilityRef(capabilitiesDir(), ref);
  // The Capability names its Surface profile; the profile is what says where
  // that installation is and which of its routes may be touched.
  const profile = await loadSurfaceProfile(surfacesDir(), capability.surface);
  const baseUrl = resolveBaseUrl(args, profile);
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
  const credentials = credentialsFromEnv();

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
      // ADR 0005's middle class, wired the way the ADR splits it: the profile
      // says which screens are interruptions, and this command — the one place
      // holding credentials — says how to answer the one that needs a session.
      recoverableConditions: profile.recoverableConditions,
      reestablishSession: () => establishSession(surface, baseUrl, credentials),
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

    if (result.kind === "business-outcome") {
      // Not a failure, and so no error text: the application worked correctly
      // and this is the answer it gave. ADR 0005 keeps it out of `catch` on the
      // calling side, and the exit code keeps it out of the failure column on
      // this one.
      //
      // The screen is captured all the same, and by this branch rather than
      // only by the decorator underneath. An outcome recognised because a Step
      // missed already has a picture; one recognised at the end of the
      // Recording never missed anything, so without this the two kinds of
      // Business Outcome would leave different amounts of evidence behind. The
      // capture is idempotent, so the decorator's wins when there was one.
      await evidence.captureFailure(await surface.screenshot());
      await evidence.finish("business-outcome", { outcome: result.name, step: result.step });
      process.stdout.write(`${JSON.stringify({ outcome: result.name }, null, 2)}\n`);
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
 * The Discovery Run: a goal in plain language, and a model driving the
 * application until it is met.
 *
 * The shape is deliberately the same as a replay: resolve the profile, decide
 * the mandate before a browser exists, open the one gated and logged Surface,
 * sign in, then hand over. What differs is only who decides the next Action.
 */
async function discoverCommand(args: Map<string, string[]>): Promise<number> {
  const goal = single(args, "goal");
  if (goal === undefined) {
    process.stderr.write(`--goal is required.\n\n${USAGE}`);
    return 2;
  }

  const profile = await loadSurfaceProfile(surfacesDir(), single(args, "surface") ?? "parabank");
  const baseUrl = resolveBaseUrl(args, profile);

  const entry = single(args, "entry") ?? "/overview.htm";
  const maxSteps = wholeNumber(single(args, "max-steps"), "--max-steps", 25);
  const timeoutMs = wholeNumber(single(args, "timeout"), "--timeout", 300) * 1_000;
  const masking = maskingSetting(single(args, "evidence-redaction"));

  // What the run may use and what it owes back, declared before it starts
  // rather than read off whatever it happened to do. The model is told both,
  // and the recorder holds it to them.
  const given = inputPairs(args.get("input") ?? []);
  const outputs = args.get("output") ?? [];
  const plan = await recordingPlan(args, { goal, profile, baseUrl, inputs: given, outputs });

  const credentials = credentialsFromEnv();

  const evidence = await EvidenceRun.start({
    root: evidenceRunsDir(),
    label: "discover",
    // The goal is written as the operator typed it, and it is the one field
    // here nobody classified. It goes through the Plain path, so a Secret in it
    // is still stripped, and a declared input quoted inside it is masked like
    // any other occurrence of that value — but a number the operator typed into
    // the goal and did not declare is not. Left that way knowingly: masking it
    // would need a rule for recognising an account number in free text, and ADR
    // 0007 rejects exactly that kind of heuristic for the policy gate. The goal
    // is also the one thing a reviewer needs in order to read the run at all.
    about: {
      goal,
      entry,
      baseUrl,
      surface: profile.id,
      maxSteps: String(maxSteps),
      ...(plan === undefined ? {} : { capability: `${plan.id}@${plan.version}` }),
      // Prefixed, so an input named `goal` cannot quietly overwrite what the
      // log says the run was for.
      ...Object.fromEntries(Object.entries(given).map(([name, value]) => [`input.${name}`, value])),
    },
    redaction: {
      secrets: [credentials.password],
      // This run's declared inputs, exactly as a replay's are. A Discovery Run
      // used to have none — it was the thing that worked out what the inputs
      // should be — and an account number the model picked off the screen and
      // put in a Locator went into evidence unmasked because there was nothing
      // to recognise it against. Now the operator names them up front, so there
      // is.
      sensitive: Object.values(given),
      masking,
    },
  });

  // ADR 0007, and the reason a Discovery Run is safe to point at an application
  // nobody has taught it: it explores with no mandate to change anything, and a
  // refusal becomes an Intervention Request rather than a retry.
  const { surface, close } = await openBrowserSurface(profile, discoveryMandate(), evidence, {
    headless: !args.has("headed"),
  });

  try {
    await establishSession(surface, baseUrl, credentials);

    // Imported here rather than at the top of the file, and this is the whole
    // reason: `cli.ts` serves both commands, so a static import would load the
    // Anthropic SDK into the process a `npm run replay` runs in. "No model on
    // the replay path" is the claim this project is built on, and a claim that
    // holds for the module graph but not for the process is not the claim.
    const { modelDecider } = await import("./discovery/model.js");

    let taken = 0;
    const decide = modelDecider({ goal, entry, inputs: given, outputs });
    const result = await discover(surface, decide, {
      // The model has no `navigate` verb, so reaching the entry point is the
      // loop's own first Step. From there it moves the way an operator does, by
      // clicking what is on the screen.
      entryUrl: `${baseUrl}${entry}`,
      maxSteps,
      timeoutMs,
      // Printed as it happens. A run takes minutes, and a terminal that says
      // nothing for four of them is indistinguishable from one that has hung.
      onStep: (step) => process.stderr.write(showStep((taken += 1), step)),
    });

    return await reportDiscovery(result, evidence, surface, plan);
  } catch (thrown) {
    await evidence.finish("hard-failure", {
      observed: thrown instanceof Error ? thrown.message : String(thrown),
    });
    throw thrown;
  } finally {
    await close();
    process.stderr.write(`Evidence: ${evidence.directory}\n`);
  }
}

/**
 * One Step, as the operator reads it: what was done, what came back, and the
 * model's own sentence for why.
 *
 * The reason is printed here and written nowhere. ADR 0006 persists a filtered
 * transcript — the Actions taken and their results, not the reasoning — because
 * a sentence saying "the balance is $1,234.56" is exactly what field-level
 * masking cannot catch. The evidence log underneath has already recorded the
 * Action and the result; this line is the half that stays on the terminal.
 */
function showStep(number: number, step: TakenStep): string {
  const outcome = step.result.kind === "ok" ? "ok" : describeMiss(step.result);
  return [
    `${String(number).padStart(3)}. ${describeAction(step.action)}`,
    `     → ${outcome}`,
    `     ↳ ${step.reason}`,
    "",
  ].join("\n");
}

/** What the run amounted to, on the terminal and in the log. */
async function reportDiscovery(
  result: DiscoveryResult,
  evidence: EvidenceRun,
  surface: Surface,
  plan: RecordingPlan | undefined,
): Promise<number> {
  const steps = String(result.steps.length);

  if (result.kind === "goal-reached") {
    if (plan === undefined) {
      // An exploration run: no id to save under, so nothing is written and the
      // run is worth exactly what the operator saw on the terminal.
      await evidence.finish("success", { steps });
      process.stdout.write(`${result.summary}\n`);
      return 0;
    }

    const recorded = recordCapability(plan, result.steps);
    if (recorded.kind === "unrecordable") {
      // The model reached the goal and the run cannot be turned into anything
      // repeatable — an ordinary outcome of pointing a model at an application,
      // and a failure of what the operator asked for, so it is reported as one.
      await evidence.finish("stopped", { steps, because: "unrecordable" });
      process.stderr.write(
        [
          "The goal was reached, but the run cannot be saved as a Capability:",
          ...recorded.reasons.map((reason) => `  - ${reason}`),
          "",
        ].join("\n"),
      );
      return 1;
    }

    const path = await saveCapability(capabilitiesDir(), recorded.capability);
    await evidence.finish("success", { steps, capability: `${plan.id}@${plan.version}` });
    process.stdout.write(`${result.summary}\n`);
    // On stderr, with what it does not yet know. A recorded Capability declares
    // success and nothing else: a run that succeeded never saw the not-found
    // screen, so ADR 0004's Business Outcomes cannot be derived from it, and
    // until somebody adds them every other ending is a Hard Failure.
    process.stderr.write(
      [
        `Recorded ${plan.id}@${plan.version} → ${path}`,
        "  It is a draft, and declares no Business Outcomes: a run that ends anywhere",
        "  other than success will report a Hard Failure until you add them.",
        "",
      ].join("\n"),
    );
    return 0;
  }

  // Every other ending is one a person has to look at, so every other ending
  // gets the screen it ended on. The decorator underneath captures at an Action
  // that missed, but neither of these is that: the gate refuses before dispatch
  // so a refusal never reaches it, and a run that used up its Steps never
  // missed anything at all. Without this, the two endings that most need a
  // picture are the two without one.
  await evidence.captureFailure(await surface.screenshot());

  if (result.kind === "intervention-request") {
    // ADR 0007's escalation, and not a failure: the run stopped exactly where
    // it was supposed to, and it stopped for a person rather than for a retry.
    await evidence.finish("intervention-request", { steps, reason: result.reason });
    process.stderr.write(
      [
        "Stopped for a person to decide.",
        `  at:     ${describeAction(result.at.action)}`,
        `  reason: ${result.reason}`,
        "",
      ].join("\n"),
    );
    return 1;
  }

  await evidence.finish("stopped", { steps, because: result.because });
  process.stderr.write(`The goal was not reached: ${result.because}, after ${steps} Steps.\n`);
  return 1;
}

/**
 * What the run will be saved as, or nothing at all.
 *
 * A Discovery Run without `--capability` is exploration: it drives the
 * application, prints what it did, and writes no file. Naming an id is what
 * turns it into a recording session, and the version is always the next one —
 * a fresh run that worked something out is a new version rather than an edit to
 * the one callers are already replaying.
 *
 * The effects are read-only and not a guess. A Discovery Run holds
 * `discoveryMandate()`, which refuses a mutating route outright (ADR 0007), so
 * nothing the run did can have changed data and there is nothing else the
 * recorded Contract could honestly say. A mutating Capability is #12's, and it
 * arrives through the escalation path rather than through an unattended run.
 */
async function recordingPlan(
  args: Map<string, string[]>,
  about: {
    goal: string;
    profile: SurfaceProfile;
    baseUrl: string;
    inputs: Record<string, string>;
    outputs: string[];
  },
): Promise<RecordingPlan | undefined> {
  const id = single(args, "capability");
  if (id === undefined) {
    // Refused rather than ignored. Both options exist for the recorder, and a
    // run that declares what it will return and then saves nothing has spent a
    // browser, a sign-in, and a model call to print one sentence.
    if (about.outputs.length > 0 || Object.keys(about.inputs).length > 0) {
      throw new Error("--input and --output need --capability, which is what says where to save.");
    }
    return undefined;
  }

  const versions = await listVersions(capabilitiesDir(), id);

  return {
    id,
    version: (versions.at(-1) ?? 0) + 1,
    surface: about.profile.id,
    // The goal as the operator typed it. It is already the one-line description
    // of what this Capability does, which is exactly what the Contract's
    // summary is for.
    summary: about.goal,
    effects: "read-only",
    baseUrl: about.baseUrl,
    inputs: about.inputs,
    outputs: about.outputs,
  };
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

/**
 * Where the application is, normalised once for both commands.
 *
 * `absoluteUrl` strips a trailing slash and `logInToParabank` concatenates raw,
 * so a base URL ending in one would sign in at `//index.htm` and take Steps at
 * `/overview.htm`. An override still answers to the profile's allowed origins —
 * the gate refuses it otherwise, which is the point of the allowlist being
 * checked-in rather than passed in.
 */
function resolveBaseUrl(args: Map<string, string[]>, profile: SurfaceProfile): string {
  const given = single(args, "base-url") ?? process.env["PARABANK_BASE_URL"] ?? profile.baseUrl;
  return given.replace(/\/+$/, "");
}

/**
 * Read before a browser launches, for the same reason inputs are checked there:
 * a missing `.env` should cost a sentence, not a Chromium.
 */
function credentialsFromEnv(): ParabankCredentials {
  return {
    username: required("PARABANK_USERNAME"),
    // ADR 0006 classes this a Secret: handed in at run time, never written.
    password: required("PARABANK_PASSWORD"),
  };
}

/** A count or a duration from the command line, refused rather than coerced. */
function wholeNumber(value: string | undefined, option: string, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${option} takes a whole number of at least 1, not "${value}".`);
  }
  return parsed;
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is not set. Copy .env.example to .env and fill it in.`);
  }
  return value;
}

/**
 * Every option each command takes, and whether it takes a value.
 *
 * Named rather than inferred, so that a misspelled option is refused instead of
 * collected and ignored. `--baseurl http://elsewhere` silently dropped is a run
 * against the wrong installation that reports success, which is worse than any
 * error message.
 *
 * Split per command rather than pooled, so that `--capability` on a discovery
 * run is refused too. An option that belongs to the other command is just as
 * misspelled as one that belongs to neither.
 */
const SHARED = {
  "base-url": "value",
  headed: "flag",
  "evidence-redaction": "value",
} as const;

const REPLAY_OPTIONS = {
  ...SHARED,
  capability: "value",
  input: "value",
  variant: "value",
} as const;

const DISCOVER_OPTIONS = {
  ...SHARED,
  goal: "value",
  entry: "value",
  surface: "value",
  "max-steps": "value",
  timeout: "value",
  capability: "value",
  input: "value",
  output: "value",
} as const;

type Options = Record<string, "value" | "flag">;

/**
 * `--name value`, `--name=value`, and `--flag`, collected so that a repeated
 * option keeps every occurrence — `--input` is given once per declared input.
 *
 * Both value forms, because `--input` intrinsically contains an `=` and the
 * joined form is the one a reader reaches for. Splitting at the first `=` only
 * is what keeps `--input=accountId=12345` meaning what it looks like.
 */
function parseArguments(argv: string[], options: Options): Map<string, string[]> {
  const args = new Map<string, string[]>();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("--")) throw new Error(`Unexpected argument "${token}".\n\n${USAGE}`);

    const joined = token.indexOf("=");
    const name = joined === -1 ? token.slice(2) : token.slice(2, joined);
    const takes = options[name];
    if (takes === undefined) throw new Error(`Unknown option "--${name}" for this command.\n\n${USAGE}`);

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
