# MERIDIAN re-drive runbook (#46)

The read-only half of #46 is done in code: `sign-on`, `member-lookup`, and
`member-balance` are at **v2, approved**, verified by live replay against the
fixed engine (#43). This runbook covers the parts that need a human at the live
browser — the four mutating Capabilities and the full chatbot re-drive — because
a background agent cannot operate the handed-over browser window or perform a
supervisor post.

Prerequisites: `.env` filled (`ANTHROPIC_API_KEY`, `CHATBOT_API_KEY`, branch, base
URL), and the live target reachable. Two credential paths (#51): the CLI
`discover` / `replay` steps below (Parts 1–6) still read the operator and password
from the environment — `MERIDIAN_OPERATOR` / `MERIDIAN_PASSWORD`, or a hidden
prompt, with the supervisor steps overriding them inline — so they are unchanged by
the login gate. The served chatbot re-drive (Part 7) is **gated**: it ignores the
env password entirely and takes the operator + password at the sign-on portal.
`MERIDIAN_SESSION_IDLE_MINUTES` (default 15) sets the served session's idle timeout.

## Live-data gotchas (read first)

Checked against member `100234` on the live target:

- **Pick an OPEN share.** The member has ~32 shares; many get left on **HOLD** by
  prior place-hold runs. The transfer and hold dropdowns list held shares too, so
  it is on you to choose an OPEN one. A held share as a transfer source returns
  `SOURCE_ON_HOLD` and breaks the success recording.
- **The dropdown label is the whole string, with the balance:** e.g.
  `100234-S0001-12 - Regular Shares ($55.00)`, not the bare id. Any `--input`
  share value must match that whole option text.
- **The balance in the label drifts.** Every transfer changes the source and
  destination balances, so the `($X.00)` part changes. In an attended run just
  select the share **visually** in the dropdown; for a later replay, re-read the
  current label first (`npm run replay -- --capability member-balance --input
  memberNumber=100234`) and use the current string, or the `select` step misses.
- **Use different shares for the transfer and the hold.** Holding a share makes it
  HOLD; reusing it as a transfer source then fails.

## How an attended run hands over

Every mutating run is the same shape:

1. The agent **automatically** does the read-only part — signs on, opens member
   inquiry, searches, and opens the member record — up to the **"MEMBER RECORD"**
   screen.
2. It then tries to open the mutating form. That is a mutating route, so the
   policy gate **refuses and hands you the browser**; the terminal prints an
   Intervention Request with a resume URL. **That is your cue.**
3. **You** do the whole mutating flow in the (headed) window, ending on the final
   confirmation screen.
4. Hand control back: `curl -X POST http://127.0.0.1:8787/resume`
5. The agent reads the confirmation and saves `capabilities/<id>/2.json` (draft).

## 1. funds-transfer

    npm run discover -- --surface meridian --entry /members --attended \
      --goal "Open the member's record, start a funds transfer between two of their shares, complete it, and read the confirmation number." \
      --capability funds-transfer \
      --input memberNumber=100234 \
      --input fromShare="100234-S0001-12 - Regular Shares ($55.00)" \
      --input toShare="100234-MMKT-16 - Money Market ($25.00)" \
      --input amount=1.00 --input memo="" \
      --output confirmationNumber --output posted

Agent auto-does: search 100234 -> open record. **HANDOVER at "MEMBER RECORD".** Then you:

1. Click the **"Funds Transfer"** link.
2. **From Share** -> select an **OPEN** Regular share, e.g. `100234-S0001-12 - Regular Shares (...)`.
3. **To Share** -> select a different OPEN share, e.g. `100234-MMKT-16 - Money Market (...)`.
4. **Amount** -> `1.00`. **Memo** -> leave blank.
5. **"Continue"** -> on **"CONFIRM FUNDS TRANSFER"** click **"Post Transfer"**.
6. Wait for **"TRANSFER POSTED"** (shows a Confirmation number).
7. `curl -X POST http://127.0.0.1:8787/resume`

## 2. open-share

    npm run discover -- --surface meridian --entry /members --attended \
      --goal "Open the member's record, open a new share of the given type with the given deposit, and read the new share id and confirmation." \
      --capability open-share \
      --input memberNumber=100234 --input shareType="MMKT - Money Market" --input initialDeposit=25.00 \
      --output newShareId --output confirmationNumber

**HANDOVER at "MEMBER RECORD".** Then you:

1. Click **"Open New Share"**.
2. **Share Type** -> `MMKT - Money Market` (options: `S0001 - Regular Shares`,
   `S0070 - Share Draft (Checking)`, `MMKT - Money Market`, `CERT - Certificate`).
3. **Initial Deposit** -> `25.00` (too low triggers `MINIMUM_DEPOSIT`).
4. **"Continue"** -> on **"CONFIRM NEW SHARE"** click **"Open Share"**.
5. Wait for **"SHARE OPENED"** (Confirmation + New Share ID).
6. `curl -X POST http://127.0.0.1:8787/resume`

## 3. update-member

    npm run discover -- --surface meridian --entry /members --attended \
      --goal "Open the member's record, update their contact information, and confirm the update was saved." \
      --capability update-member \
      --input memberNumber=100234 --input email="ada@example.test" --input phone="555-0155" \
      --input mailingAddress="1 Analytical Engine Way" \
      --output email

**HANDOVER at "MEMBER RECORD".** Then you:

1. Click **"Update Member Information"**.
2. **Email** -> `ada@example.test`; **Phone** -> `555-0155`; **Address** -> `1 Analytical Engine Way`.
3. **"Save Changes"** -> wait for **"MEMBER INFORMATION UPDATED"**. (Single step, no review page.)
4. `curl -X POST http://127.0.0.1:8787/resume`

## 4. place-hold — sign on as SUPERVISOR

Use the supervisor operator so the handed-over session can post:

    MERIDIAN_OPERATOR="$MERIDIAN_SUPERVISOR_OPERATOR" MERIDIAN_PASSWORD="$MERIDIAN_SUPERVISOR_PASSWORD" \
    npm run discover -- --surface meridian --entry /members --attended \
      --goal "Open the member's record, place a hold on one of their shares with the given reason, and read the confirmation number." \
      --capability place-hold \
      --input memberNumber=100234 \
      --input shareId="100234-MMKT-22 - Money Market ($25.00)" \
      --input reasonCode="FRAUD - Suspected fraud" --input notes="" \
      --output confirmationNumber

**HANDOVER at "MEMBER RECORD"** (you are signed on as supervisor). Then you:

1. Click **"Place Account Hold"**.
2. **Share** -> select an **OPEN** share **different from the transfer one**, e.g. `100234-MMKT-22 - Money Market (...)`.
3. **Reason Code** -> `FRAUD - Suspected fraud` (options: `FRAUD - Suspected fraud`,
   `LEGAL - Legal / levy`, `DECEASED - Member deceased`). **Notes** -> blank.
4. **"Continue"** -> on **"CONFIRM ACCOUNT HOLD"** click **"Apply Hold"**.
5. Wait for **"ACCOUNT HOLD APPLIED"** (Confirmation number).
6. `curl -X POST http://127.0.0.1:8787/resume`

As a **teller** this same flow stops at the review with `SUPERVISOR_OVERRIDE_REQUIRED`
— that is the teller path you demo in Part D, not something you record here.

## 5. Verify each fresh version replays

Re-read current labels first (balances drift), then replay with the current strings:

    npm run replay -- --capability member-balance --input memberNumber=100234   # get current OPEN labels
    npm run replay -- --capability funds-transfer --input memberNumber=100234 --input fromShare="<current>" --input toShare="<current>" --input amount=1.00 --input memo=""
    npm run replay -- --capability open-share    --input memberNumber=100234 --input shareType="MMKT - Money Market" --input initialDeposit=25.00
    npm run replay -- --capability update-member --input memberNumber=100234 --input email="ada@example.test" --input phone="555-0155" --input mailingAddress="1 Analytical Engine Way"
    npm run replay -- --capability place-hold    --input memberNumber=100234 --input shareId="<current OPEN share>" --input reasonCode="FRAUD - Suspected fraud" --input notes="   # as TELLER -> SUPERVISOR_OVERRIDE_REQUIRED"

Confirm the typed outputs, and that the teller place-hold reports
`SUPERVISOR_OVERRIDE_REQUIRED`.

## 6. Approve the four and clean up drafts

For each of the four modules `src/capability/meridian/<id>.ts`, set `version: 2`
and `approval: "approved"`, then:

    npm run capability:write
    rm capabilities/funds-transfer/1.json capabilities/open-share/1.json capabilities/update-member/1.json capabilities/place-hold/1.json
    npm test    # if the "committed as the file" test fails, bump its version to 2 in each of the four *.test.ts

(Or, to keep the discovered JSON directly: set `"approval": "approved"` in each
`capabilities/<id>/2.json` and delete the `1.json`. The catalog serves
approved-only, highest version.)

## 7. Full chatbot re-drive (end-to-end demo)

    npm run serve    # catalog :8788, dashboard :8789, chatbot :8790, portal :8791

The served surface is **gated** (#51): nothing works until you sign on at the
portal, and the operator you sign on as is who every invoke acts as.

1. **Confirm the gate is closed.** Before signing on, open `http://127.0.0.1:8790`
   and ask anything — it refuses ("You're not signed on…"); as a hard check,
   `curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8788/capabilities`
   returns `401`.
2. **Sign on** at `http://127.0.0.1:8791` as **teller1** (operator + branch +
   password — the password is entered here, never the environment). The catalog and
   chatbot unlock.
3. Open `http://127.0.0.1:8790` and drive each, confirming:
   - member-lookup returns real values (number + name, not labels)
   - member-balance lists shares
   - a transfer posts (confirmation number)
   - an open-share returns new share id + confirmation
   - an update-member acknowledges — give email, phone, **and** address; it writes
     all three in one form, there is no partial update
   - an ambiguous share ("transfer from a Regular Share to a Money Market") ->
     the chatbot reads balances and **asks which share**, rather than guessing
   - place-hold as **teller** -> `SUPERVISOR_OVERRIDE_REQUIRED`
   - a no-match lookup -> `NOT_FOUND`
   - a several-match lookup -> `MULTIPLE_MATCHES`
4. **Supervisor post.** One operator holds the process per boot, so to post the
   hold you **restart** `serve`, sign on at the portal as **super1** (no
   command-line change), and re-run the place-hold — it posts a confirmation number
   instead of the override refusal.
5. **Session lifecycle (optional to show).** While signed on, a second portal
   sign-on as a *different* operator is refused until restart; **Sign off** on the
   portal (or letting the idle timeout lapse) locks the chatbot again until you
   sign back on.

When all pass, tick #46's boxes and close it.
