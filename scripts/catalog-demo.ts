/**
 * A worked demonstration of the central claim: a second program discovering a
 * Capability and invoking it, knowing nothing but what the catalog publishes.
 *
 * This is the caller the stretch goal is about. It imports none of this
 * project's code — it speaks only HTTP and JSON, the way any other agent would.
 * It reads `GET /capabilities`, finds `account-lookup`, reads the input schema
 * the Contract publishes, invokes it by name with a typed argument, and prints
 * what came back. A run that ends in the account's type and balance is the JSON
 * Schema working rather than the schema described.
 *
 * It expects the catalog already running against a real ParaBank — see
 * `docs/capability-catalog.md` for the three commands that get there:
 *
 *   1. npm run parabank:start
 *   2. cp .env.example .env  (fill in PARABANK_USERNAME / PARABANK_PASSWORD)
 *   3. npm run serve         (in one terminal)
 *   4. npm run catalog:demo  (in another)
 *
 * Options: --url <catalog>   where the catalog is (default http://127.0.0.1:8788)
 *          --account <id>     which account to look up (default 12345)
 */
const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 1) {
  const token = process.argv[i]!;
  if (token.startsWith("--")) args.set(token.slice(2), process.argv[++i] ?? "");
}

const catalog = (args.get("url") ?? process.env["CATALOG_URL"] ?? "http://127.0.0.1:8788").replace(/\/+$/, "");
const account = args.get("account") ?? "12345";

interface CatalogEntry {
  readonly id: string;
  readonly version: number;
  readonly contract: {
    readonly summary: string;
    readonly inputs: { readonly properties: Record<string, { readonly type?: string; readonly description?: string }> };
  };
}

async function main(): Promise<number> {
  // 1. Discover. The caller reads the list and learns what it can invoke.
  console.log(`Reading the catalog at ${catalog} …\n`);
  const listed = await fetch(`${catalog}/capabilities`).catch((error: unknown) => {
    throw new Error(`Could not reach the catalog at ${catalog}. Is \`npm run serve\` running? (${String(error)})`);
  });
  if (!listed.ok) throw new Error(`The catalog answered ${listed.status} to GET /capabilities.`);
  const catalogEntries = (await listed.json()) as CatalogEntry[];

  console.log(`The catalog offers ${catalogEntries.length} Capabilit${catalogEntries.length === 1 ? "y" : "ies"}:`);
  for (const entry of catalogEntries) {
    console.log(`  - ${entry.id}@${entry.version}: ${entry.contract.summary}`);
  }
  console.log("");

  // 2. Choose, from the published Contract alone. The caller picks the lookup
  //    and reads its input schema — no knowledge of how it is recorded.
  const chosen = catalogEntries.find((entry) => entry.id === "account-lookup");
  if (chosen === undefined) {
    throw new Error("The catalog does not offer `account-lookup`. Has it been written to `capabilities/`?");
  }
  console.log(`Chose ${chosen.id}@${chosen.version}. Its Contract declares these inputs:`);
  for (const [name, schema] of Object.entries(chosen.contract.inputs.properties)) {
    console.log(`  - ${name} (${schema.type ?? "?"}): ${schema.description ?? ""}`);
  }
  console.log("");

  // 3. Invoke, by name, with a typed argument the schema asked for.
  console.log(`Invoking ${chosen.id} with { "accountId": "${account}" } …\n`);
  const invoked = await fetch(`${catalog}/capabilities/${chosen.id}/invoke`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ inputs: { accountId: account } }),
  });
  const result = (await invoked.json()) as { kind?: string; outputs?: unknown; name?: string; observed?: string };

  // 4. Read the discriminated result the same way a direct replay returns it.
  if (invoked.status === 200 && result.kind === "success") {
    console.log("Success. The Capability returned:");
    console.log(JSON.stringify(result.outputs, null, 2));
    return 0;
  }
  if (invoked.status === 200 && result.kind === "business-outcome") {
    console.log(`The application's answer was the Business Outcome "${result.name}".`);
    return 0;
  }
  console.error(`The invoke ended in ${invoked.status} ${result.kind ?? "(no kind)"}.`);
  console.error(JSON.stringify(result, null, 2));
  return 1;
}

process.exitCode = await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  return 1;
});

export {};
