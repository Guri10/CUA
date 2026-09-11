# The Surface resolves every Locator against one perceived accessibility tree

A Locator is resolved by matching it against the parsed accessibility tree of a single perception —
the `nodes` a `snapshot()` returns — and the Surface acts on the node it resolved. Both halves of a
Replay use that one representation: acting (click, fill, select, read) and Checkpoint matching. The
real Surface no longer resolves actions through Playwright's `getByRole` element counting while
Checkpoints resolve through the parsed snapshot; those were two different "find this control"
mechanisms, and they disagreed.

They disagreed because Playwright computes an accessible name two different ways. `page.ariaSnapshot()`
prints a structural name — a content-less wrapper row is printed nameless — whereas `getByRole`'s
name filter matches on the name computed from an element's contents, so a legacy `<tr><td>` wrapping
a whole record matches any name its descendants' text contains. Resolving actions one way and
Checkpoints the other let one Locator mean two things: a read landed on a label cell against the live
page while the offline Checkpoint — and every unit test — saw the clean tree and passed. One
perceived tree, one resolver, removes the split by construction. It also keeps a Discovery Run
honest: the model chooses a Locator from the same tree Replay later resolves against, so what it saw
is what runs.

## Considered Options

- **Keep two resolvers; fix the affected Capability.** Rejected. Under substring name-matching the
  wrapper row's name is a superset of the inner row's, so no Locator — exact or scoped — can single
  out the inner row. The divergence is not fixable at the Capability level; it has to be removed at
  the Surface.
- **Unify on the live `getByRole` lens** — teach the Checkpoint and fake Surface to see the wrapper
  too. Rejected. It standardises on the noisier, content-derived name: every by-position read shifts,
  every captured tree needs regenerating, and the fast offline fake stops mirroring the parsed tree
  it is built from — trading a clean model for a messy one to enshrine a legacy-table artefact.
- **Drop to CDP for perception and node resolution.** Rejected for now. It is heavier and more
  Chromium-coupled engine code to own than Playwright's `ariaSnapshot`, and buys nothing once the
  Surface stops using `getByRole` to resolve. Revisit only if `ariaSnapshot` proves too lossy.

## Consequences

- The one genuinely new piece is mapping a resolved node back to a live element to click or type. It
  is built as a Playwright locator from the node's role/name/ordinal path, counted the way the tree
  counts — staying inside ADR 0001's vocabulary. Done carelessly, by re-counting through `getByRole`,
  it re-imports the exact divergence for clicks. Enforce in review: the acting handle must be derived
  from the resolved node, never re-found by a fresh `getByRole` count.
- Reads of static text come from the resolved node. A read of a typed-in input's *current value*
  still reads the live control, because the tree carries a control's label, not what was typed into
  it.
- `readEach` resolves through the same resolver as single reads, so list reads and single reads
  cannot drift onto different lenses.
- The fake Surface can no longer pass while the live page fails: both resolve through the one shared
  resolver. The fast, browser-free tests keep their value, and the resolver — a pure function over
  the parsed tree — is where the fast coverage concentrates; whole flows are covered by real-browser
  e2e.
- Ambiguity semantics are preserved. An ambiguous *action* Locator stays a miss a Terminal State can
  catch, which is how `MULTIPLE_MATCHES` is reached — a Business Outcome, not a crash. Where ambiguity
  is not a declared outcome it is a Hard Failure that names the Step, never a silent wrong pick.

## Verified

Traced against live MERIDIAN before building on it. On the member record, the identity row nests
inside a wrapper cell whose name concatenates the whole record: `getByRole("row", { name:
"Member No.:" })` matches two rows and its cell count puts the member number at ordinal 2, while
`page.ariaSnapshot()` leaves the wrapper nameless and puts it at ordinal 1. `member-lookup@1` read
ordinal 1 and returned the label `"Member No.:"`; a Discovery Run's `member-lookup@2` read the value
correctly at ordinal 2 but then failed its own Success Checkpoint, which resolves through the
snapshot lens where ordinal 2's sibling does not exist. Same page, two lenses — the divergence this
decision removes.
