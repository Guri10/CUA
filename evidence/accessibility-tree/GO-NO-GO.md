# Go / no-go on ADR 0001

**Verdict: GO.** ParaBank's accessibility tree is rich enough to identify controls by role and
accessible name. ADR 0001 stands as written, and ticket #3 can start.

The qualification is that the answer is not uniform across the application. Read-only content — the
part the flagship account-lookup Capability depends on — is well described. Form inputs are not
described at all. Both cases are already covered by ADR 0001's Locator definition, which is why this
is a go rather than a revision.

## What was captured

Snapshots in this directory, produced by `npm run capture:a11y` against
`parasoft/parabank` running locally:

| Screen | Snapshot | Named controls | Unnamed controls |
| --- | --- | --- | --- |
| Customer Login | `01-login.aria.yaml` | 33 | 3 |
| Accounts Overview | `02-accounts-overview.aria.yaml` | 37 | 1 |
| Account Details | `03-account-detail.aria.yaml` | 50 | 3 |

Counts are over interactive roles only, and come from `addressability.json`, which also lists each
control by name. Structural roles are excluded — an unnamed `list` says nothing about whether a Step
can find its target.

## Addressable by role and accessible name

- **Every navigation link.** `link "Accounts Overview"`, `link "Log Out"`, `link "Transfer Funds"`,
  and the rest of the left-hand menu all carry their visible text as their accessible name.
- **The login button.** `button "Log In"`.
- **Every heading.** `heading "Customer Login"`, `heading "Accounts Overview"`,
  `heading "Account Details"`, `heading "Account Activity"` — usable as Checkpoints confirming which
  screen the run has reached.
- **The account table on the overview.** Real `table` / `rowgroup` / `row` / `columnheader` / `cell`
  roles, not layout soup. Each cell's accessible name is its text, and each account number is a
  `link` whose name is the number itself — so navigating to a specific account is a Locator, not a
  URL construction.
- **The account detail fields.** Each is a `row` whose accessible name carries both the label and the
  value: `row "Balance: -$2300.00"`, `row "Account Number: 12345"`, `row "Account Type: CHECKING"`.
  Scoping a `cell` by its parent `row` reads the value directly. This is the single most important
  result here — reading a balance is the flagship Capability, and it is expressible.

This was the load-bearing worry, and it turned out better than expected. The table-based layout
feared in the spec is real in places, but the account tables are genuine semantic tables.

## Not addressable by name — role and ordinal only

- **The two login inputs.** They appear as bare `- textbox` with no accessible name. The words
  "Username" and "Password" sit in sibling `paragraph` elements, not in labels associated with the
  inputs, so nothing propagates to the accessibility tree. Lines 25–30 of `01-login.aria.yaml`:

  ```yaml
  - heading "Customer Login" [level=2]
  - paragraph: Username
  - textbox
  - paragraph: Password
  - textbox
  - button "Log In"
  ```

  These are reachable as the first and second `textbox` on the page. ADR 0001 already allows a
  Locator to be disambiguated by ordinal, so this stays inside the contract — but it is the weakest
  Locator in the system and the one most likely to break if the page gains another input.

- **Two comboboxes on the account detail page**, the activity-period and transaction-type filters.
  Same cause: no accessible name. Scoping by the parent `cell` does not help — both sit in a
  `cell "All"`, named for the selected value rather than the field. Only the enclosing row
  distinguishes them, `row "Activity Period: All"` from `row "Type: All"`. So these need a
  two-level scope, not one.

- **One unnamed link on every page** — the Parasoft logo image, which has no alt text. Not a control
  any Capability needs.

## Names that match more than one control

`link "About Us"`, `link "Services"`, `link "Products"`, and `link "Locations"` each appear twice on
every screen — once in the header navigation, once in the footer. The login screen adds
`link "Transfer Funds"` and `link "Read More"`, also twice each.

The account detail screen is the one that matters, because it carries an ambiguity inside the data
rather than in the chrome: `link "Funds Transfer Sent"` appears **four** times in the transaction
table, one per matching transaction, plus `option "All"` twice across the two filters. A Step that
wants a specific transaction cannot name it — it has to scope by the containing row, or index by
ordinal, and neither is stable if the transaction list reorders.

None of these are on the path of the account-lookup Capability, which reads a balance rather than a
transaction. But this is the first sight of a case ADR 0001's ordinal does not really solve: an
ordinal over rows of live data is a position in a result set, not a stable handle. Worth knowing
before a Capability is written that needs one.

## One finding beyond the ADR question

Every table in this application renders its structure immediately and fills it from a request that
finishes later. A snapshot taken when the screen reports itself loaded catches the structure with
the data missing. This was hit three separate times while capturing three screens:

- the detail screen's `cell "Balance:"` next to an empty cell;
- the overview's empty `rowgroup` where every account row should be;
- the detail screen's transaction table showing `paragraph: No transactions found.` above an empty
  rowgroup, on an account that has four transactions.

The third is the worst of them, and it is why the committed snapshots are taken after the screen
settles rather than after a named row appears. An empty rowgroup is visibly wrong on inspection.
"No transactions found." is not — it is a sentence the application also produces when the answer is
genuinely no transactions, so a Recording that read it would have recorded a plausible, wrong
answer. Waiting for a named row would not have caught it either, since the whole question is whether
any row exists.

The committed snapshots are stable: three consecutive captures produced byte-identical YAML.

Arriving at a screen is therefore not the same as the screen being ready to read, and the failure is
silent: nothing errors, the tree is simply thinner than it should be. A Checkpoint that confirms the
screen by matching its heading would have passed on all three bad captures.

This is the first concrete argument for Checkpoints asserting the data rather than the screen, and a
real instance of the Recoverable Condition category rather than a simulated one. It also sharpens
what a Business Outcome has to be careful about: "no transactions found" is exactly the kind of
screen ADR 0004 wants recognised as a legitimate answer, and this application shows that same screen
while it is still loading. A Terminal State predicate that matches on the message alone would report
an empty result as success.

## Consequence for what gets built next

Nothing in ADR 0001 changes. Two things are now known rather than assumed:

1. The Locator type needs the ordinal and parent-scoping fields from the start, not as a later
   addition — the login step cannot be expressed without an ordinal, and the detail screen's filters
   need scoping two levels up rather than one.
2. A Step that reads a value needs a Checkpoint that waits for the value, not just for the screen.
   A heading match is not enough, and its failure mode is silence rather than an error.
3. A Terminal State predicate for an empty result cannot be a message match alone — this
   application shows the empty-result message while still loading.

## A caveat on this evidence

The counts above come from `addressability.json`, derived by `src/surface/aria-snapshot.ts`, which
reads the snapshot YAML. Its first version silently dropped two line shapes — names containing a
colon, which YAML quotes as a key, and nodes with a trailing `[selected]` or `[level=2]` state — and
so undercounted. Both are fixed and covered by tests written against the real fragments.

The snapshots themselves are the primary evidence and were never affected; only the counts derived
from them were. Anything in this document can be checked against the YAML directly.
