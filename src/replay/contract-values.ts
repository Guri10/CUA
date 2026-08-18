/**
 * The Contract as a boundary, checked in both directions.
 *
 * A caller's inputs are validated before anything touches a screen, and the
 * values a run extracted are validated before they are handed back. Both use
 * the JSON Schema the Contract publishes, because that is the artefact a
 * calling agent reads — validating against anything else would mean the
 * document and the check could disagree.
 *
 * Zod reads that schema back the other way (`fromJSONSchema`), so the system
 * still has one validator rather than a second one with its own opinions about
 * draft versions.
 */
import { z } from "zod";
import type { JsonSchemaObject } from "../capability/schema.js";

/**
 * Values against the schema that declares them.
 *
 * `subject` is what the message calls them — "This run's inputs" — so that a
 * caller who typed an account id wrong is told which side of the Contract
 * failed and which field it was.
 */
export function parseContractValues(
  schema: JsonSchemaObject,
  values: Readonly<Record<string, unknown>>,
  subject: string,
): Record<string, unknown> {
  // The Contract's schema is validated as a JSON Schema object rather than
  // typed as one, so this is the cast from "checked shape" to Zod's own JSON
  // Schema type. Nothing is assumed here that `jsonSchemaObject` did not check.
  const result = z.fromJSONSchema(schema as z.core.JSONSchema.BaseSchema).safeParse(values);
  if (result.success) return result.data as Record<string, unknown>;

  const reasons = result.error.issues
    .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n");
  throw new Error(`${subject} do not match the Contract:\n${reasons}`);
}

/**
 * Text as the types the Contract declares.
 *
 * Everything reaching this system arrives as text: a `--input` argument, or the
 * accessible name of the control a `read` Step addressed. The Contract is the
 * only thing that says what that text means, so it is what does the converting.
 *
 * Validation is a separate step on purpose. This turns `"10"` into `10`; saying
 * whether `10` is allowed is `parseContractValues`'s job, and keeping them
 * apart means a field this cannot convert is reported here, by name, rather
 * than as a type error about a value nobody recognises.
 */
export function coerceTextValues(
  schema: JsonSchemaObject,
  text: Readonly<Record<string, string>>,
  subject: string,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(text).map(([name, value]) => {
      const declared = schema.properties[name];
      // Undeclared. `parseContractValues` refuses it and names it; converting
      // it against a type nobody declared would only obscure that.
      if (declared === undefined) return [name, value];
      return [name, coerce(declared["type"], value, `${subject} "${name}"`)];
    }),
  );
}

function coerce(type: unknown, value: string, subject: string): unknown {
  switch (type) {
    case "string":
      return value;

    case "number":
    case "integer": {
      // Not `Number`, which reads "" as 0 and " 12 " as 12. A Contract
      // declaring a number is asking for one, not for whatever coerces.
      const parsed = /^-?\d+(\.\d+)?$/.test(value.trim()) ? Number(value.trim()) : Number.NaN;
      if (Number.isNaN(parsed)) throw new Error(`${subject} is declared ${type}, but got "${value}".`);
      return parsed;
    }

    case "boolean":
      if (value === "true") return true;
      if (value === "false") return false;
      throw new Error(`${subject} is declared boolean, but got "${value}".`);

    default:
      // An array, an object, or a Contract that declares no type at all. A read
      // returns the text of one control, and turning that into a structure
      // would be inventing something that was never on the screen.
      throw new Error(
        `${subject} is declared ${JSON.stringify(type)}, which cannot be read out of text.`,
      );
  }
}
