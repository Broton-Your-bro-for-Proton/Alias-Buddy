import { templatesOf } from "./core.js";

export const CREATION_DEFAULTS = {
  domain: "", // empty: the first of the user's own domains, else the first SimpleLogin domain
  mailboxId: null, // null: the default mailbox in SimpleLogin
  template: "{domain}.{random}", // the default name template, always templates[0]
  perDomain: true, // reuse or create one alias per recipient domain, remembered in the alias note
  autoSwitch: false, // from a real mailbox to a new recipient: switch to that alias instead of blocking
  replyFromAlias: true, // a reply or forward goes out as the alias the message came through
  autoIdentity: true, // create the Thunderbird identity for an alias when it is needed
  addressBook: true, // keep reverse aliases in the address book "Alias Buddy", named after contact and alias
};

export const DEFAULTS = { apiUrl: "https://app.simplelogin.io", apiKey: "", protected: [], allowlist: [], creation: CREATION_DEFAULTS };

export async function getSettings() {
  const stored = (await messenger.storage.local.get("settings")).settings ?? {};
  const creation = { ...CREATION_DEFAULTS, ...stored.creation };
  creation.templates = templatesOf(creation);
  creation.template = creation.templates[0];
  return { ...DEFAULTS, ...stored, creation };
}
