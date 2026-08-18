/**
 * What a read of one control gets back.
 *
 * The rule lives here, on its own, because both Surfaces have to answer it
 * identically. A read that meant "the typed value" in the fake and "the
 * accessible name" in the browser would let an interaction pass in one and fail
 * in the other, which is precisely the divergence having two implementations is
 * meant to rule out.
 *
 * It is answered entirely from the accessibility tree — no DOM property is
 * consulted, so a read means the same thing on a Surface that has no DOM at
 * all. That is not incidental: reading a field's value through the DOM is the
 * one place the portability claim would quietly break.
 */
import { descendantsOf, type AriaNode } from "./aria-snapshot.js";

export function readControlValue(nodes: readonly AriaNode[], control: number): string {
  const node = nodes[control];
  if (node === undefined) return "";

  // What has been typed into it: `- textbox: some-user`.
  if (node.text !== undefined) return node.text;

  // What has been chosen in it. The option's accessible name is its label — the
  // words on screen — rather than the value the markup carries underneath.
  const chosen = descendantsOf(nodes, control)
    .map((index) => nodes[index]!)
    .find((candidate) => candidate.role === "option" && candidate.selected === true);
  if (chosen !== undefined) return chosen.name ?? "";

  // Otherwise the control's own accessible name, which for a table cell is the
  // text it displays — the shape the account balance is read through.
  return node.name ?? "";
}
