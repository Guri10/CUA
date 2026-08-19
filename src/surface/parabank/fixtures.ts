/**
 * Injecting the things ParaBank does that a run has to survive.
 *
 * ADR 0005 splits what can happen to a run into three, and two of the three
 * cannot be produced on demand by asking the application nicely: a session does
 * not expire when it would be convenient, and a container that is behaving does
 * not serve a 500. These intercept the requests instead — the response is
 * replaced or held up on its way back to the page, and everything above the
 * network sees exactly what it would see on the day it happens for real.
 *
 * They belong to the browser Surface rather than to any test, for the same
 * reason `fake-script.ts` does: this is Playwright, and Playwright lives here.
 * Each returns the means of stopping, so a run that injected a condition does
 * not leave it lying around for the next one.
 *
 * The Business Outcome is the one class with nothing here, deliberately. An
 * account nobody holds is a question the application can simply be asked, and a
 * simulated answer to it would prove nothing about what ParaBank really says.
 */
import type { Page, Route } from "playwright";

/** Undoes one injection. Calling it twice is harmless. */
export type StopInjecting = () => Promise<void>;

/**
 * The next request for `path` ends the session and comes back as the screen
 * ParaBank serves once it has; every request after it is served normally.
 *
 * The interception redirects that one request to the application's own logout
 * rather than fabricating a login screen. Two things follow, and both are the
 * point. The bytes are ParaBank's, so a Surface profile condition that matches
 * them matches the real thing rather than the screen it was written against.
 * And the session really is gone, so a run that carries on afterwards has
 * genuinely signed in again rather than been allowed to pretend.
 */
export async function expireSessionOnce(
  page: Page,
  options: { readonly baseUrl: string; readonly path: string },
): Promise<StopInjecting> {
  const pattern = pathPattern(options.path);
  let served = false;

  const handler = async (route: Route): Promise<void> => {
    if (served) return await route.fallback();

    // The shot is spent only once the logout has actually answered. A fixture
    // whose fetch failed would otherwise have used up its one interception
    // without injecting anything, and a run that then sailed through would look
    // exactly like a run that absorbed the condition.
    const response = await route.fetch({ url: `${options.baseUrl}/logout.htm` }).catch((thrown) => {
      throw new Error(`Could not end the session at ${options.baseUrl}/logout.htm: ${thrown}`);
    });
    served = true;

    await route.fulfill({ response });
  };

  await page.route(pattern, handler);
  return () => page.unroute(pattern, handler);
}

/**
 * Every response held back by `ms` before it is allowed through.
 *
 * Nothing about the screens changes — this is the application being slow rather
 * than wrong, which is the whole distinction. A Step waiting for a control is
 * what absorbs it, and a delay longer than that Step's timeout is what does
 * not.
 */
export async function delayEveryResponse(
  page: Page,
  options: { readonly ms: number },
): Promise<StopInjecting> {
  const pattern = /.*/;
  /**
   * Requests currently being held. Awaited on the way out, so that none
   * outlives the run that injected it and surfaces inside the next one.
   */
  const held = new Set<Promise<void>>();

  const handler = (route: Route): void => {
    const holding = (async () => {
      await new Promise((resume) => setTimeout(resume, options.ms));
      // A request whose page has already moved on cannot be continued, and
      // there is nothing to do about that: the response it was waiting for is
      // one nobody is waiting for any more.
      await route.continue().catch(() => undefined);
    })();
    held.add(holding);
    void holding.finally(() => held.delete(holding));
  };

  await page.route(pattern, handler);
  return async () => {
    await page.unroute(pattern, handler);
    await Promise.all([...held]);
  };
}

/**
 * Every request for `path` answered with a server error.
 *
 * The body is deliberately nothing anybody declared. A screen matching no
 * Terminal State and no Recoverable Condition is a Hard Failure, and the point
 * of injecting one is that a run must stop on it rather than read its own
 * success into an empty page.
 */
export async function failWithServerError(
  page: Page,
  options: { readonly path: string },
): Promise<StopInjecting> {
  const pattern = pathPattern(options.path);

  const handler = async (route: Route): Promise<void> => {
    await route.fulfill({
      status: 500,
      contentType: "text/html",
      body: `<html><body><p>An internal error has occurred.</p></body></html>`,
    });
  };

  await page.route(pattern, handler);
  return () => page.unroute(pattern, handler);
}

/**
 * A route as the Surface profile writes one, matched wherever it appears in a
 * URL. ParaBank rewrites its own links with a `;jsessionid=` segment, so the
 * path is not reliably the end of what arrives here.
 */
function pathPattern(path: string): RegExp {
  return new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
}
