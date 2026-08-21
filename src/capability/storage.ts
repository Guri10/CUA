/**
 * Capabilities on disk: one JSON file per version, git as the version store.
 *
 * A change to a Capability is then reviewable in a normal code review, and a
 * new Discovery Run produces a new file rather than editing one that callers
 * are already running. A Tenant override is not a version — it is a patch
 * inside the existing file, resolved by `resolveRecording`.
 *
 * Every write is validated before it lands and every read is validated after,
 * because the recorder writes these files unattended and a broken Capability
 * that reached disk would otherwise be found by whoever next tried to replay
 * it.
 */
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import { packageRootFrom } from "../package-root.js";
import { capabilitySchema, type Capability } from "./schema.js";

/** Where this repository keeps its committed Capabilities. */
export function capabilitiesDir(): string {
  return join(packageRootFrom(import.meta.url), "capabilities");
}

export function capabilityFile(root: string, id: string, version: number): string {
  return join(root, id, `${version}.json`);
}

/**
 * How a Capability is named on a command line and in a catalog: `<id>@<v>`, or
 * a bare id meaning the highest version there is.
 */
export interface CapabilityRef {
  readonly id: string;
  readonly version?: number;
}

export function parseCapabilityRef(ref: string): CapabilityRef {
  const at = ref.lastIndexOf("@");
  if (at === -1) return { id: ref };

  const id = ref.slice(0, at);
  const version = Number(ref.slice(at + 1));
  if (!Number.isInteger(version) || version < 1) {
    throw new Error(`"${ref}" is not a Capability reference; expected <id> or <id>@<version>.`);
  }
  return { id, version };
}

export async function saveCapability(root: string, capability: unknown): Promise<string> {
  const validated = validate(capability, "This Capability");

  const path = capabilityFile(root, validated.id, validated.version);
  await mkdir(join(root, validated.id), { recursive: true });
  // Indented, key order as declared, and newline-terminated: the file is meant
  // to be read in a diff, and a one-line JSON blob would make every change look
  // like a rewrite.
  await writeFile(path, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
  return path;
}

export async function loadCapability(
  root: string,
  id: string,
  version: number,
): Promise<Capability> {
  const path = capabilityFile(root, id, version);

  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch {
    throw new Error(`No Capability "${id}@${version}" at ${path}.`);
  }

  return validate(JSON.parse(contents), path);
}

/** Every version of one Capability on disk, lowest first. */
export async function listVersions(root: string, id: string): Promise<number[]> {
  let files: string[];
  try {
    files = await readdir(join(root, id));
  } catch {
    return [];
  }

  return files
    .filter((file) => file.endsWith(".json"))
    .map((file) => Number(file.slice(0, -".json".length)))
    // Numerically. Ten versions in, a lexicographic sort would pin every caller
    // to version 9.
    .filter((version) => Number.isInteger(version) && version > 0)
    .sort((left, right) => left - right);
}

/**
 * Every Capability id on disk, one per directory that holds at least one
 * version, sorted. The catalog reads this and loads each id's highest version;
 * an id with a directory but no valid version file is left out rather than
 * surfaced as a broken entry.
 */
export async function listCapabilities(root: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const ids: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const versions = await listVersions(root, entry.name);
    if (versions.length > 0) ids.push(entry.name);
  }
  return ids.sort();
}

export async function loadCapabilityRef(root: string, ref: string): Promise<Capability> {
  const { id, version } = parseCapabilityRef(ref);
  if (version !== undefined) return loadCapability(root, id, version);

  const versions = await listVersions(root, id);
  const latest = versions.at(-1);
  if (latest === undefined) throw new Error(`No Capability "${id}" under ${root}.`);
  return loadCapability(root, id, latest);
}

function validate(value: unknown, subject: string): Capability {
  const result = capabilitySchema.safeParse(value);
  if (result.success) return result.data;

  const reasons = result.error.issues
    .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n");
  throw new Error(`${subject} is not a valid Capability:\n${reasons}`);
}
