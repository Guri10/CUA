/**
 * The scripted screens the fake Surface answers ParaBank from.
 *
 * The trees are not invented. They are the accessibility snapshots the real
 * browser produced and ticket 2 committed under `evidence/`, read straight off
 * disk — so the fake answers from the same trees the application actually
 * served, ambiguities and unnamed inputs and all. A hand-written tree would
 * quietly describe the application we wish we had.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Script } from "../fake-surface.js";

/**
 * The address the committed snapshots were captured against. The fake replays
 * one recorded session, so its screens are only reachable at the addresses that
 * session used.
 */
export const PARABANK_CAPTURED_BASE_URL = "http://localhost:8080/parabank";

/**
 * The account the captured run opened. ParaBank seeds a different set of
 * account numbers into every fresh container, so this number belongs to the
 * evidence rather than to the application.
 */
const CAPTURED_ACCOUNT = "12345";

export function parabankScript(): Script {
  return {
    screens: [
      {
        name: "login",
        url: `${PARABANK_CAPTURED_BASE_URL}/index.htm`,
        tree: capturedTree("01-login"),
        transitions: [
          { when: { kind: "click", locator: { role: "button", name: "Log In" } }, to: "overview" },
        ],
      },
      {
        name: "overview",
        url: `${PARABANK_CAPTURED_BASE_URL}/overview.htm`,
        tree: capturedTree("02-accounts-overview"),
        transitions: [
          {
            when: {
              kind: "click",
              locator: { role: "link", name: CAPTURED_ACCOUNT, exact: true },
            },
            to: "account-detail",
          },
        ],
      },
      {
        name: "account-detail",
        url: `${PARABANK_CAPTURED_BASE_URL}/activity.htm?id=${CAPTURED_ACCOUNT}`,
        tree: capturedTree("03-account-detail"),
      },
    ],
  };
}

function capturedTree(slug: string): string {
  return readFileSync(join(evidenceDir(), `${slug}.aria.yaml`), "utf8");
}

/**
 * Walks up to the package root rather than counting `..` segments, because the
 * number of them differs between running from `src/` and running from a build
 * in `dist/`, and getting it wrong fails only at run time.
 */
function evidenceDir(): string {
  let directory = dirname(fileURLToPath(import.meta.url));

  for (;;) {
    if (existsSync(join(directory, "package.json"))) {
      return join(directory, "evidence", "accessibility-tree");
    }
    const parent = dirname(directory);
    if (parent === directory) {
      throw new Error(`Could not find the package root from ${import.meta.url}`);
    }
    directory = parent;
  }
}
