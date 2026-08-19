/**
 * Whether the end-to-end runs hide the browser window.
 *
 * Headless by default, because that is what a machine with no display can run.
 * `HEADED=1 npm run test:e2e` shows the window, which is how you watch a run
 * against a real ParaBank and see which screen it was on when something went
 * wrong — the same reason escalation runs headed, one ticket later.
 */
export function headless(): boolean {
  return process.env["HEADED"] !== "1";
}
