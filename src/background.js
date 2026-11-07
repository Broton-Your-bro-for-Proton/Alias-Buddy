import { ApiError, SimpleLogin } from "./lib/api.js";
import * as core from "./lib/core.js";
import { getSettings } from "./lib/settings.js";

const TTL = 10 * 60 * 1000;
const MAX_ATTACHMENT_SCAN = 10 * 1024 * 1024;
const status = new Map(); // tab id: last result, shown in the popup
const overrides = new Map(); // tab id: fingerprint of the blocked message the user sends once anyway
const rewritten = new Map(); // tab id: { alias, mailboxId } after a rewrite, in case the send does not finish

class Blocked extends Error {
  constructor(message, overridable = false) {
    super(message);
    this.overridable = overridable;
  }
}

// ---- cache: { owner, mailboxes: {at, value}, aliases: {email: {at, value}}, contacts: {aliasId: {address: reverse}} }

/** A fresh value, or the cached one when SimpleLogin cannot be reached. */
async function cached(entry, fetchValue) {
  if (entry && Date.now() - entry.at < TTL) {
    return entry;
  }
  try {
    return { at: Date.now(), value: await fetchValue() };
  } catch (e) {
    if (entry && e instanceof ApiError && e.status != 401) {
      return entry;
    }
    throw e;
  }
}

async function context() {
  const settings = await getSettings();
  const owner = `${settings.apiUrl}\n${settings.apiKey}`;
  let cache = (await messenger.storage.local.get("cache")).cache ?? {};
  if (cache.owner != owner) {
    cache = { owner };
  }
  cache.aliases ??= {};
  cache.contacts ??= {};
  return { settings, cache, sl: settings.apiKey ? new SimpleLogin(settings.apiUrl, settings.apiKey) : null };
}

/** Canonical forms of the user's real addresses. */
async function protectedAddresses(ctx) {
  const manual = ctx.settings.protected.map(core.canonical).filter(Boolean);
  if (!ctx.sl) {
    return new Set(manual);
  }
  try {
    ctx.cache.mailboxes = await cached(ctx.cache.mailboxes, async () =>
      (await ctx.sl.mailboxes()).map(m => core.norm(m.email))
    );
  } catch (e) {
    throw new Blocked(`SimpleLogin: ${e.message}. Without the mailbox list the add-on cannot tell which addresses are yours.`);
  }
  return new Set([...ctx.cache.mailboxes.value.map(core.canonical), ...manual]);
}

async function aliasFor(ctx, email) {
  if (!ctx.sl) {
    return null;
  }
  try {
    ctx.cache.aliases[email] = await cached(ctx.cache.aliases[email], () => ctx.sl.findAlias(email));
  } catch (e) {
    throw new Blocked(`SimpleLogin: ${e.message}. The add-on cannot tell whether ${email} is an alias.`);
  }
  return ctx.cache.aliases[email].value;
}

const contactsOf = (ctx, alias) => new Map(Object.entries((ctx.cache.contacts[alias.id] ??= {})));
const knownReverseAliases = ctx => new Set(Object.values(ctx.cache.contacts).flatMap(Object.values));

/** Aliases that own one of the reverse aliases among the recipients. */
function ownersOf(ctx, recipients) {
  const emails = new Set(recipients.map(r => r.email));
  const owners = new Set();
  for (const { value: alias } of Object.values(ctx.cache.aliases)) {
    if (alias && Object.values(ctx.cache.contacts[alias.id] ?? {}).some(ra => emails.has(ra))) {
      owners.add(alias.email);
    }
  }
  return owners;
}

async function refreshContacts(ctx, alias) {
  try {
    Object.assign((ctx.cache.contacts[alias.id] ??= {}), await ctx.sl.contacts(alias.id));
  } catch (e) {
    throw new Blocked(`SimpleLogin: ${e.message}`);
  }
}

async function addContact(ctx, alias, email) {
  try {
    (ctx.cache.contacts[alias.id] ??= {})[email] = await ctx.sl.createContact(alias.id, email);
  } catch (e) {
    if (!(e instanceof ApiError) || e.status == 0) {
      throw new Blocked(`SimpleLogin: ${e.message}`);
    }
    // The address may be a reverse alias of this alias (a reply) or an
    // existing contact the plan no longer allows to create (403).
    await refreshContacts(ctx, alias);
    const contacts = contactsOf(ctx, alias);
    if (!contacts.has(email) && ![...contacts.values()].includes(email)) {
      throw new Blocked(
        knownReverseAliases(ctx).has(email)
          ? `${email} is a reverse alias of another alias. Send from that alias instead.`
          : `${email}: ${e.message}`
      );
    }
  }
}

/** Learns the reverse aliases of the aliases a replied-to message was sent to. */
async function learnFromOriginal(ctx, messageId) {
  const message = await messenger.messages.get(messageId).catch(() => null);
  if (!message) {
    return;
  }
  const addresses = [...message.recipients, ...message.ccList].map(core.addressOf);
  for (const email of new Set(addresses)) {
    const alias = await aliasFor(ctx, email).catch(() => null);
    if (alias) {
      await refreshContacts(ctx, alias);
    }
  }
}

async function recipientsOf(details, fields = ["to", "cc", "bcc"]) {
  const list = [];
  for (const field of fields) {
    for (const entry of [].concat(details[field] ?? [])) {
      if (typeof entry != "string") {
        throw new Blocked("A recipient is an address book entry the add-on cannot read.");
      }
      const parsed = await messenger.messengerUtilities.parseMailboxString(entry, { expandMailingLists: true });
      for (const { email } of parsed) {
        if (!email?.includes("@")) {
          throw new Blocked(`Cannot read the address "${entry}".`);
        }
        list.push({ field, email: core.norm(email) });
      }
    }
  }
  return list;
}

/** Texts of attachments that can carry headers or addresses, such as forwarded messages. */
async function attachmentTexts(tabId) {
  const texts = [];
  for (const attachment of await messenger.compose.listAttachments(tabId)) {
    try {
      const file = await messenger.compose.getAttachmentFile(attachment.id);
      const textual = /^(text|message)\//i.test(file.type) || /\.(eml|txt|vcf|ics|csv|html?|asc)$/i.test(attachment.name);
      if (textual && file.size <= MAX_ATTACHMENT_SCAN) {
        texts.push(await file.text());
      }
    } catch (e) {
      throw new Blocked(`Cannot check the attachment ${attachment.name}: ${e.message}`, true);
    }
  }
  return texts;
}

/** Leaks a contact would see in a message passing through SimpleLogin. */
async function softLeaks(tabId, details, mine, domain) {
  const found = core.leaks([details.subject, details.body, details.plainTextBody], mine).map(a => `the text contains ${a}`);
  found.push(...core.leaks(await attachmentTexts(tabId), mine).map(a => `an attachment contains ${a}`));
  if (!details.isPlainText && core.hasEmbeddedImages(details.body)) {
    found.push(`embedded images would carry the domain ${domain}, attach them as files instead`);
  }
  return found;
}

const bodyOf = details => (details.isPlainText ? { plainTextBody: details.plainTextBody } : { body: details.body });
const domainOf = email => email.slice(email.lastIndexOf("@") + 1);

// ---- the check that runs before every send ----------------------------------------

async function checkMailbox(tab, details, ctx, { sender, recipients, mine, override }) {
  let result = core.checkMailboxSend(recipients, knownReverseAliases(ctx), ctx.settings.allowlist, ownersOf(ctx, recipients));
  if (result.exposed.length && details.relatedMessageId && ctx.sl) {
    await learnFromOriginal(ctx, details.relatedMessageId);
    result = core.checkMailboxSend(recipients, knownReverseAliases(ctx), ctx.settings.allowlist, ownersOf(ctx, recipients));
  }
  if (result.mixed) {
    throw new Blocked("SimpleLogin drops a message that mixes reverse aliases with other addresses. Send two messages.");
  }
  if (result.exposed.length && !override) {
    const who = result.exposed.map(r => r.email).join(", ");
    throw new Blocked(`Your real address ${sender} would be visible to ${who}. Choose an alias as sender.`, true);
  }
  if (result.viaAlias.length) {
    const hard = core.sendProblems(details);
    if (hard.length) {
      throw new Blocked(`Not sent through SimpleLogin: ${hard.join("; ")}. Turn it off in this message.`);
    }
    const soft = override ? [] : await softLeaks(tab.id, details, mine, domainOf(sender));
    if (soft.length) {
      throw new Blocked(`Not sent through SimpleLogin: ${soft.join("; ")}.`, true);
    }
  }
  return { state: "mailbox", sender, rows: recipients.map(r => ({ ...r, via: r.email })) };
}

async function checkAlias(tab, details, ctx, { identity, alias, resumed, recipients, mine, isMine, override, apply }) {
  let mailbox = identity;
  if (!resumed) {
    const pick = core.pickMailboxIdentity(await messenger.identities.list(), alias.mailboxes, identity.accountId);
    if (!pick.candidates.length) {
      throw new Blocked(`No Thunderbird identity uses a mailbox of ${alias.email} (${alias.mailboxes.join(", ")}). Add one.`);
    }
    if (!pick.identity) {
      throw new Blocked(
        `The identity ${pick.candidates[0].email} has an OpenPGP key or S/MIME certificate, and signing would reveal it. Add a second identity for that address without keys.`
      );
    }
    mailbox = pick.identity;
  }
  const hard = core.sendProblems({ newsgroups: details.newsgroups, followupTo: details.followupTo });
  if (hard.length) {
    throw new Blocked(`Not sent: ${hard.join("; ")}.`);
  }
  const soft = override ? [] : await softLeaks(tab.id, details, mine, domainOf(mailbox.email));
  if (soft.length) {
    throw new Blocked(`Not sent: ${soft.join("; ")}.`, true);
  }

  let plan = core.rewriteForAlias(recipients, alias.email, contactsOf(ctx, alias));
  if (!apply) {
    const pending = plan.missing.map(r => ({ ...r, via: null }));
    return { state: "alias", sender: alias.email, mailbox: mailbox.email, rows: [...plan.rows, ...pending] };
  }
  for (const r of plan.missing) {
    await addContact(ctx, alias, r.email);
  }
  plan = core.rewriteForAlias(recipients, alias.email, contactsOf(ctx, alias));
  if (plan.missing.length) {
    throw new Blocked(`No reverse alias for ${plan.missing.map(r => r.email).join(", ")}.`);
  }

  // Switching the identity lets Thunderbird apply the mailbox identity's
  // signature, Reply-To, automatic Cc/Bcc and vCard setting, so every field is
  // set explicitly in the same call and the result is checked afterwards.
  await messenger.compose.setComposeDetails(tab.id, {
    identityId: mailbox.id,
    ...plan.fields,
    replyTo: details.replyTo ?? [],
    attachVCard: false,
    attachPublicPGPKey: false,
    ...bodyOf(details),
  });
  const final = await messenger.compose.getComposeDetails(tab.id);
  const problems = core.verifyAliasSend(
    { ...final, recipients: await recipientsOf(final), replyTo: await recipientsOf(final, ["replyTo"]) },
    { identityId: mailbox.id, alias: alias.email, contacts: contactsOf(ctx, alias), isProtected: isMine }
  );
  if (!override) {
    problems.push(...core.leaks([final.subject, final.body, final.plainTextBody], mine).map(a => `the text contains ${a}`));
  }
  if (problems.length) {
    await messenger.compose.setComposeDetails(tab.id, {
      identityId: details.identityId,
      to: details.to,
      cc: details.cc,
      bcc: details.bcc,
      replyTo: details.replyTo ?? [],
      attachVCard: details.attachVCard,
      attachPublicPGPKey: details.attachPublicPGPKey,
      ...bodyOf(details),
    });
    throw new Blocked(`Not sent, the final check failed: ${problems.join("; ")}.`);
  }
  rewritten.set(tab.id, { alias: alias.email, mailboxId: mailbox.id });
  return { state: "alias", sender: alias.email, mailbox: mailbox.email, rows: plan.rows, sent: true };
}

/**
 * Throws Blocked when the message must not go out. With `apply` false it only
 * reports what would happen, for the popup.
 */
async function check(tab, details, ctx, { override = false, apply = true } = {}) {
  const identity = await messenger.identities.get(details.identityId);
  const sender = core.norm(identity.email);
  const recipients = await recipientsOf(details);
  const mine = await protectedAddresses(ctx);
  const isMine = email => mine.has(core.canonical(email));
  const options = { identity, recipients, mine, isMine, override, apply };
  if (!ctx.sl && !mine.size) {
    return { state: "unconfigured" };
  }

  // A rewritten message whose send did not finish (a later prompt, an SMTP
  // error) is still the alias's message.
  const earlier = rewritten.get(tab.id);
  const resumed = earlier?.mailboxId == details.identityId;
  if (!resumed && isMine(sender)) {
    return checkMailbox(tab, details, ctx, { ...options, sender });
  }
  const alias = await aliasFor(ctx, resumed ? earlier.alias : sender);
  if (alias) {
    return checkAlias(tab, details, ctx, { ...options, alias, resumed });
  }
  const shown = [details.from && core.addressOf(details.from), ...(await recipientsOf(details, ["replyTo"])).map(r => r.email)];
  const exposedAs = shown.find(email => email && isMine(email));
  if (exposedAs) {
    return checkMailbox(tab, details, ctx, { ...options, sender: exposedAs });
  }
  return ctx.sl ? { state: "other", sender } : { state: "unconfigured" };
}

// One check at a time, so concurrent sends and previews do not overwrite each other's cache.
let queue = Promise.resolve();
function run(tab, details, options) {
  const next = queue.then(async () => {
    const ctx = await context();
    try {
      return await check(tab, details, ctx, options);
    } finally {
      await messenger.storage.local.set({ cache: ctx.cache });
    }
  });
  queue = next.catch(() => {});
  return next;
}

function show(tabId, result) {
  status.set(tabId, result);
  const badge = { blocked: ["!", "#f1afba"], alias: ["✓", "#b49a64"], unconfigured: ["?", "#697789"] }[result.state];
  messenger.composeAction.setBadgeText({ tabId, text: badge?.[0] ?? "" });
  messenger.composeAction.setTitle({ tabId, title: result.reason ? `Alias Buddy: ${result.reason}` : "Alias Buddy" });
  if (badge) {
    messenger.composeAction.setBadgeBackgroundColor({ tabId, color: badge[1] });
    messenger.composeAction.setBadgeTextColor({ tabId, color: "#0f1217" });
  }
}

function blockedResult(e) {
  const blocked = e instanceof Blocked ? e : new Blocked(`Unexpected error: ${e.message}`);
  return { state: "blocked", reason: blocked.message, overridable: blocked.overridable };
}

messenger.compose.onBeforeSend.addListener(async (tab, details) => {
  const allowed = overrides.get(tab.id);
  overrides.delete(tab.id);
  try {
    show(tab.id, await run(tab, details, { override: allowed == core.fingerprint(details) }));
    return {};
  } catch (e) {
    const result = blockedResult(e);
    show(tab.id, result);
    messenger.notifications.create({ type: "basic", title: "Alias Buddy: message not sent", message: result.reason });
    return { cancel: true };
  }
});

messenger.tabs.onRemoved.addListener(tabId => {
  status.delete(tabId);
  overrides.delete(tabId);
  rewritten.delete(tabId);
});

messenger.runtime.onMessage.addListener(async message => {
  const { tabId } = message;
  if (message.type == "preview") {
    const details = await messenger.compose.getComposeDetails(tabId);
    let preview;
    try {
      preview = await run({ id: tabId }, details, { apply: false });
    } catch (e) {
      preview = blockedResult(e);
    }
    return { preview, last: status.get(tabId) };
  }
  if (message.type == "sendOnce") {
    overrides.set(tabId, core.fingerprint(await messenger.compose.getComposeDetails(tabId)));
    try {
      await messenger.compose.sendMessage(tabId);
    } finally {
      overrides.delete(tabId);
    }
  }
});
