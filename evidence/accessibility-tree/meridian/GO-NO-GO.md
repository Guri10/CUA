# Meridian GO / NO-GO — ADR 0001 targeting contract vs web-sample.interface-hiring.com

**Verdict: GO.**

Every critical control resolves to exactly one node using role + name + ordinal + within only. No CSS/XPath needed; ADR 0001 holds against this target.

## Per-target match counts

| Page | Target | Locator | Count | Verdict |
| --- | --- | --- | --- | --- |
| signon | operator field (textbox ordinal 0) | `role=textbox ordinal=0` | 1 | GO (1) |
| signon | password field (textbox ordinal 1) | `role=textbox ordinal=1` | 1 | GO (1) |
| signon | Sign On button | `role=button name="Sign On"` | 1 | GO (1) |
| member | balance values present & readable as `cell` nodes | `role=cell name="$"` | 20 | probe (20 present) |
| member | one share's balance cell scoped within its row | `role=cell name="$1,240.55" exact=true within{role=row name="100234-S0070 Share Draft"}` | 1 | GO (1) |
| member | one share row (name carries id/type/balance/status) | `role=row name="100234-S0070 Share Draft (Checking) $1,240.55"` | 1 | GO (1) |
| transfer | from combobox (ordinal 0) | `role=combobox ordinal=0` | 1 | GO (1) |
| transfer | to combobox (ordinal 1) | `role=combobox ordinal=1` | 1 | GO (1) |
| transfer | amount textbox (ordinal 0) | `role=textbox ordinal=0` | 1 | GO (1) |
| transfer | memo textbox (ordinal 1) | `role=textbox ordinal=1` | 1 | GO (1) |
| transfer | Continue button | `role=button name="Continue"` | 1 | GO (1) |
| hold | share combobox (ordinal 0) | `role=combobox ordinal=0` | 1 | GO (1) |
| hold | reason combobox (ordinal 1) | `role=combobox ordinal=1` | 1 | GO (1) |
| hold | notes textbox (ordinal 0) | `role=textbox ordinal=0` | 1 | GO (1) |
| hold | Continue button | `role=button name="Continue"` | 1 | GO (1) |

## Resolved node detail

- signon / operator field (textbox ordinal 0) (count 1):
  - textbox
- signon / password field (textbox ordinal 1) (count 1):
  - textbox
- signon / Sign On button (count 1):
  - button "Sign On"
- member / balance values present & readable as `cell` nodes (count 20):
  - 20 balance cells, e.g. $2,499.00, $1,240.55, $11.00
- member / one share's balance cell scoped within its row (count 1):
  - cell "$1,240.55"
- member / one share row (name carries id/type/balance/status) (count 1):
  - row "100234-S0070 Share Draft (Checking) $1,240.55 HOLD [HOLD]"
- transfer / from combobox (ordinal 0) (count 1):
  - combobox
- transfer / to combobox (ordinal 1) (count 1):
  - combobox
- transfer / amount textbox (ordinal 0) (count 1):
  - textbox
- transfer / memo textbox (ordinal 1) (count 1):
  - textbox
- transfer / Continue button (count 1):
  - button "Continue"
- hold / share combobox (ordinal 0) (count 1):
  - combobox
- hold / reason combobox (ordinal 1) (count 1):
  - combobox
- hold / notes textbox (ordinal 0) (count 1):
  - textbox
- hold / Continue button (count 1):
  - button "Continue"

## Comboboxes and options

- Transfer form combobox nodes (role `combobox`): 2
  - combobox (no name)
  - combobox (no name)
- Transfer form option nodes (role `option`) visible in tree: 40
  - option "100234-S0001 - Regular Shares ($2,499.00)" [selected]
  - option "100234-S0070 - Share Draft (Checking) ($1,240.55)"
  - option "100234-MMKT-3 - Money Market ($11.00)"
  - option "100234-MMKT-4 - Money Market ($25.00)"
  - option "100234-S0001-5 - Regular Shares ($23.00)"
  - option "100234-S0001-6 - Regular Shares ($40.00)"
  - option "100234-MMKT-7 - Money Market ($30.00)"
  - option "100234-MMKT-8 - Money Market ($15.00)"
  - option "100234-MMKT-9 - Money Market ($201.00)"
  - option "100234-MMKT-10 - Money Market ($20.00)"
  - option "100234-MMKT-11 - Money Market ($21.00)"
  - option "100234-S0001-12 - Regular Shares ($50.00)"
  - option "100234-S0001-13 - Regular Shares ($10.00)"
  - option "100234-S0001-14 - Regular Shares ($100.00)"
  - option "100234-CERT-15 - Certificate ($500.00)"
  - option "100234-MMKT-16 - Money Market ($25.00)"
  - option "100234-S0070-17 - Share Draft (Checking) ($50.00)"
  - option "100234-S0001-18 - Regular Shares ($11.00)"
  - option "100234-S0001-19 - Regular Shares ($99.00)"
  - option "100234-S0001-20 - Regular Shares ($25.00)"

## Evidence files

- signon.txt, menu.txt, member-100234.txt, transfer.txt, hold.txt (raw aria trees)
- _signon-controls.txt, _member-balances.txt, _transfer-controls.txt, _hold-controls.txt (diagnostics)