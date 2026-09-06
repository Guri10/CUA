# MERIDIAN re-drive runbook (#46)

The read-only half of #46 is done in code: `sign-on`, `member-lookup`, and
`member-balance` are at **v2, approved**, verified by live replay against the
fixed engine (#43). This runbook covers the parts that need a human at the live
browser — the four mutating Capabilities and the full chatbot re-drive — because
a background agent cannot operate the handed-over browser window or perform a
supervisor post.

Prerequisites: `.env` filled (teller + supervisor operators, branch, base URL,
`ANTHROPIC_API_KEY`, `CHATBOT_API_KEY`), and the live target reachable.

## Why the mutating four need `--attended`

A Discovery Run holds `discoveryMandate()`, which refuses a mutating route
outright (ADR 0007). So the agent can drive the form up to the point of posting,
then the gate refuses; with `--attended` the browser window becomes yours, you
perform the post, and hand control back over the resume endpoint. The recorded
run then includes those human steps and is saved as a **draft** that will not
replay until you have read the Steps and approved it.

## 1. Re-discover the four mutating Capabilities (attended)

Run each from the repo root. Each prints a resume URL when the gate refuses;
after you complete the mutating step in the browser, resume with:

    curl -X POST http://127.0.0.1:8787/resume

Use real seed data (member `100234` has open shares; pick a supervisor operator
for the place-hold success path).

    # funds-transfer
    npm run discover -- --surface meridian --entry /members --attended \
      --goal "Transfer an amount from one of the member's shares to another and read the confirmation number." \
      --capability funds-transfer \
      --input memberNumber=100234 --input fromShare=<shareId> --input toShare=<shareId> \
      --input amount=1.00 \
      --output confirmationNumber --output posted

    # open-share
    npm run discover -- --surface meridian --entry /members --attended \
      --goal "Open a new share of the given type for the member with the given initial deposit, and read the new share id and confirmation." \
      --capability open-share \
      --input memberNumber=100234 --input shareType="Regular Shares" --input initialDeposit=5.00 \
      --output newShareId --output confirmationNumber

    # update-member (single-step, no review)
    npm run discover -- --surface meridian --entry /members --attended \
      --goal "Update the member's contact details and read the acknowledgement." \
      --capability update-member \
      --input memberNumber=100234 --input email=ada@example.test \
      --output email

    # place-hold — supervisor posts (RESTRICTED FUNCTION)
    # Sign on as the SUPERVISOR operator for this one (set MERIDIAN_OPERATOR /
    # MERIDIAN_PASSWORD to the supervisor, or supply the supervisor password at
    # the prompt) so the post is allowed rather than refused.
    npm run discover -- --surface meridian --entry /members --attended \
      --goal "Place a hold on one of the member's shares with the given reason and read the confirmation number." \
      --capability place-hold \
      --input memberNumber=100234 --input shareId=<shareId> --input reasonCode="FRAUD - Suspected fraud" \
      --output confirmationNumber

Each saves `capabilities/<id>/2.json` as a draft. Read the recorded Steps.

## 2. Verify each fresh version replays deterministically

    npm run replay -- --capability funds-transfer --input ...
    npm run replay -- --capability open-share    --input ...
    npm run replay -- --capability update-member --input ...
    npm run replay -- --capability place-hold    --input ...   # as teller -> SUPERVISOR_OVERRIDE_REQUIRED

Confirm the typed outputs are correct and the teller place-hold reports the
`SUPERVISOR_OVERRIDE_REQUIRED` Business Outcome.

## 3. Approve the fresh versions and clean up drafts

The read-only three were promoted by editing their modules
(`src/capability/meridian/<id>.ts`: `version: 2`, `approval: "approved"`), then
`npm run capability:write`, then deleting the superseded `<id>/1.json`. Do the
same for the four mutating modules once their v2 recordings are confirmed, or —
if you keep the discovered JSON directly — set `"approval": "approved"` in each
`capabilities/<id>/2.json` and delete the `1.json` draft. The catalog serves
approved-only, highest version each, so approving is what makes them visible.

## 4. Full chatbot re-drive (end-to-end demo)

Start the stack, sign on through the portal, then drive each request:

    npm run serve            # catalog :8788, dashboard :8789, chatbot :8790, portal :8791
    # open http://127.0.0.1:8791, sign on as the operator (teller, then supervisor as needed)
    # open http://127.0.0.1:8790 and ask, confirming each:

- member-lookup returns real values (member number + name, not labels)
- member-balance lists the member's shares
- a funds transfer posts and returns a confirmation number
- an open-share returns the new share id and confirmation
- an update-member acknowledges the change
- place-hold as **teller** -> `SUPERVISOR_OVERRIDE_REQUIRED`
- place-hold as **supervisor** -> posts a confirmation
- a lookup with no match -> `NOT_FOUND`
- a lookup matching several -> `MULTIPLE_MATCHES`

When all pass, #46's acceptance criteria are met.
