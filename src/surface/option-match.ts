/**
 * Whether a declared value identifies a select option, when the option's
 * visible label decorates a stable id with extra text.
 *
 * MERIDIAN's share dropdowns read `100234-S0001-12 - Regular Shares ($50.00)` —
 * a stable id, then a type, then a *live balance*. A caller cannot hand back the
 * whole label because the balance drifts between the run that recorded it and
 * the run that replays it, so the value that has to bind and to select is the id
 * alone. Exact equality (what `selectOption({ label })` and the recorder's
 * `expressionFor` do) never recognises the id inside the decorated label; this
 * rule does, without the corruption a bare substring would cause.
 *
 * The rule: the value matches the label when they are equal, or when the label
 * begins with the value followed by a word boundary (whitespace or end). The
 * boundary is what keeps `100234-S0001-1` from matching `100234-S0001-12`: the
 * character after the shorter id is `2`, not a space. It is deliberately not a
 * substring test — that is the rewrite `expressionFor`'s comment warns against —
 * and it is scoped to choosing among a control's own options, never to
 * parameterising arbitrary text.
 *
 * Both Surfaces and the recorder call this so the value that binds at record
 * time is the value that selects at replay time; the two drifting apart is how
 * a Recording would save clean and replay onto the wrong share.
 */
export function optionMatches(label: string, value: string): boolean {
  const l = label.trim().toLowerCase();
  const v = value.trim().toLowerCase();
  if (v === "") return false;
  if (l === v) return true;
  if (!l.startsWith(v)) return false;
  const next = l.charAt(v.length);
  return next === "" || /\s/.test(next);
}
