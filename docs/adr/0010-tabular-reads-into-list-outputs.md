# A table is read by a `readEach` verb into a list output; plain `read` stays scalar and strict

A `read` addresses one control and returns its text, and it treats several matches as `ambiguous` —
a miss, not a value (ADR 0001, ADR 0005). That is deliberate: for a single value, matching many rows
is how a Replay reads the wrong one and reports the wrong balance. But some answers are lists — a
member's shares, the lines of a statement — and a fixed Recording of single reads cannot return one:
the count is not known when the Recording is written, and a member with three shares and one with
fifty are the same Capability.

So there is a second read verb, `readEach`. It names the rows to iterate and a set of columns keyed
by the field each becomes, and it returns one record per row. Each column is resolved **within its
row**, so a field can only ever come from the row it was read beside. It binds a list output — an
array of records — the way a `read` binds a scalar. Plain `read` is left exactly as it was: one
control, one value, several matches still an error.

The rows a `readEach` iterates have no names to tell them apart, which is the one thing a stored
Locator cannot express. So the row is identified by position and its columns are read inside it
(`resolveLocatorIndicesWithin`), rather than by a Locator naming the row — because naming it is
impossible and parsing the row's concatenated text into fields would be inventing structure the
screen never had, which ADR 0001 bans.

## Considered Options

- **Overload `read` to return a list when many match.** Covers a flat list of one column, but not a
  record: a share is four correlated columns, and "read all balance cells" plus "read all type
  cells" only line up if every row has every cell. The moment one row is missing a cell the two
  lists misalign and each balance is paired with the wrong type — silently, which is exactly the
  failure `ambiguous` exists to prevent. It also erases the honest default that a bare `read`
  matching several things is a mistake.
- **Read each whole row as one string and split it into fields.** No new grouping primitive, but it
  turns `"100234-S0001 Regular Shares $2,499.00 HOLD"` into fields by string-splitting — inventing a
  structure by parsing, the CSS/XPath-shaped move ADR 0001 rules out.
- **Let a model disambiguate or assemble the list at replay time.** Replay runs with no model in the
  loop; the shape of what a run returns is decided once, at discovery, and frozen into the Contract.
  A model that picks or groups belongs to the discovery author or the chatbot orchestrating
  Capabilities, never to Replay.

## Consequences

A Business Outcome still carries only a name today, not data. The same "hold a list" capacity is what
a richer outcome — "several members matched, here they are" — would need to carry its candidates, but
that is a further step; this change is list-valued **success** only.

The output shape is no longer always text. A `read`-bound output is coerced from text to its declared
type; a `readEach`-bound output is already structured, so it bypasses that coercion and is validated
against its array-of-records schema instead. The recorder shapes the output from the columns the run
read rather than defaulting every output to a string, so discovery can author a list-returning
Capability end to end.

`readEach` is a read: read-only, permitted in a Surface profile's action list, and its returned
values are Sensitive by position in evidence exactly as a `read`'s are (ADR 0006). A run that reads a
table still declares success from a `waitFor` or a scalar read, so a `readEach` flow waits for its
table to arrive before reading it — the same checkpoint pattern every late-filling table already uses.
