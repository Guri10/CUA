/**
 * Writes the hand-written Capabilities to `capabilities/`.
 *
 * The Capability is authored as a module so that its inputs and outputs are
 * declared once in Zod and the published JSON Schema is generated rather than
 * transcribed. It is committed as a file so that a reviewer reads a Capability
 * the way a calling agent does — as data, with no code to run.
 *
 * `npm run capability:write`. A test fails if a committed file has drifted from
 * the module that produced it.
 */
import { accountLookupCapability } from "../src/capability/parabank/account-lookup.js";
import { signOnCapability } from "../src/capability/meridian/sign-on.js";
import { memberLookupCapability } from "../src/capability/meridian/member-lookup.js";
import { memberBalanceCapability } from "../src/capability/meridian/member-balance.js";
import { fundsTransferCapability } from "../src/capability/meridian/funds-transfer.js";
import { placeHoldCapability } from "../src/capability/meridian/place-hold.js";
import { openShareCapability } from "../src/capability/meridian/open-share.js";
import { updateMemberCapability } from "../src/capability/meridian/update-member.js";
import { capabilitiesDir, saveCapability } from "../src/capability/storage.js";

const root = capabilitiesDir();

for (const capability of [
  accountLookupCapability(),
  signOnCapability(),
  memberLookupCapability(),
  memberBalanceCapability(),
  fundsTransferCapability(),
  placeHoldCapability(),
  openShareCapability(),
  updateMemberCapability(),
]) {
  console.log(`wrote ${await saveCapability(root, capability)}`);
}
