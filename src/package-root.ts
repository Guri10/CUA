/**
 * The package root, found by walking up to the directory holding
 * `package.json` rather than by counting `..` segments — the number of them
 * differs between running from `src/` and running from a build in `dist/`, and
 * getting it wrong fails only at run time.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function packageRootFrom(moduleUrl: string): string {
  let directory = dirname(fileURLToPath(moduleUrl));

  for (;;) {
    if (existsSync(join(directory, "package.json"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`Could not find the package root from ${moduleUrl}`);
    directory = parent;
  }
}
