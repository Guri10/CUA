/**
 * The bridge from a Zod declaration to the JSON Schema published in a Contract.
 *
 * The point of declaring inputs and outputs in Zod is that one declaration
 * serves static types, runtime validation, the discovery tool definitions, and
 * the catalog entry a calling agent reads. This is the last of those: the
 * generated schema is embedded in the Capability file so that a caller reads
 * the Contract without importing any code.
 *
 * It is parsed on the way out rather than cast. Generation is the one moment a
 * malformed Contract could be introduced without anything noticing, and a cast
 * would be exactly the wrong tool at that moment.
 */
import { z } from "zod";
import { jsonSchemaObject, type JsonSchemaObject } from "./schema.js";

export function jsonSchemaFor(declaration: z.ZodType): JsonSchemaObject {
  return jsonSchemaObject.parse(z.toJSONSchema(declaration));
}
