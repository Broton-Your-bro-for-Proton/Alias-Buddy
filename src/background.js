import { ApiError, SimpleLogin, isOutage } from "./lib/api.js";
import * as core from "./lib/core.js";
import { getSettings } from "./lib/settings.js";

const TTL = 10 * 60 * 1000;
const MAX_STALE = 24 * 60 * 60 * 1000;
const CONTACTS_TTL = 24 * 60 * 60 * 1000;
const MAX_ATTACHMENT_SCAN = 10 * 1024 * 1024;
const status = new Map(); // tab id: last result, shown in the popup
const overrides = new Map(); // tab id: fingerprint of the blocked message the user sends once anyway
const rewritten = new Map(); // tab id: { alias, mailboxId } after a rewrite, in case the send does not finish
const chosenTemplates = new Map(); // tab id: the template picked in the popup, also used by the switch on send

class Blocked extends Error {
  constructor(message, overridable = false) {
    super(message);
    this.overridable = overridable;
  }
}

// ---- cache: { owner, mailboxes: {at, value: [{email, verified}]}, aliases: {email: {at, value}},
//               contacts: {aliasId: {address: reverse}}, contactsAt: {aliasId: time} }

/**
 * A fresh value, or during an outage (no connection, rate limit, server
 * error) the cached one if it is at most a day old.
 */
async function cached(entry, fetchValue) {
  if (entry && Date.now() - entry.at < TTL) {
    return entry;
  }
  try {
    return { at: Date.now(), value: await fetchValue() };
  } catch (e) {
    if (entry && isOutage(e) && Date.now() - entry.at < MAX_STALE) {
      return entry;
    }
    throw e;
  }
}

async function context() {
  const settings = await getSettings();
  const owner = `v3\n${settings.apiUrl}\n${settings.apiKey}`;
  let cache = (await messenger.storage.local.get("cache")).cache ?? {};
  if (cache.owner != owner) {
    cache = { owner };
  }
  cache.aliases ??= {};
  cache.contacts ??= {};
  cache.contactsAt ??= {};
  // Contacts can be deleted or regenerated in SimpleLogin, so they are refetched after a day.
  for (const [id, at] of Object.entries(cache.contactsAt)) {
    if (Date.now() - at > CONTACTS_TTL) {
      delete cache.contacts[id];
      delete cache.contactsAt[id];
    }
  }
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
      (await ctx.sl.mailboxes()).map(m => ({ id: m.id, email: core.norm(m.email), verified: m.verified !== false, default: !!m.default }))
    );
  } catch (e) {
    throw new Blocked(`SimpleLogin: ${e.message}. Without the mailbox list the add-on cannot tell which addresses are yours.`);
  }
  return new Set([...ctx.cache.mailboxes.value.map(m => core.canonical(m.email)), ...manual]);
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

/** The cached contacts of an alias, created on first use with its fill time. */
function contactMap(ctx, alias) {
  ctx.cache.contactsAt[alias.id] ??= Date.now();
  return (ctx.cache.contacts[alias.id] ??= {});
}
// A planned alias (id null) has no contacts yet.
const contactsOf = (ctx, alias) => (alias.id == null ? new Map() : new Map(Object.entries(contactMap(ctx, alias))));
const aliasById = (ctx, id) => Object.values(ctx.cache.aliases).find(e => e.value?.id == id)?.value ?? null;
/** The id of the alias a cached reverse alias belongs to. */
const ownerIdOf = (ctx, reverse) =>
  Object.keys(ctx.cache.contacts).find(id => Object.values(ctx.cache.contacts[id]).includes(reverse));
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

async function refreshContacts(ctx, alias, wanted) {
  try {
    Object.assign(contactMap(ctx, alias), await ctx.sl.contacts(alias.id, wanted));
  } catch (e) {
    throw new Blocked(`SimpleLogin: ${e.message}`);
  }
}

async function addContact(ctx, alias, email) {
  try {
    contactMap(ctx, alias)[email] = await ctx.sl.createContact(alias.id, email);
  } catch (e) {
    if (!(e instanceof ApiError) || e.status == 0) {
      throw new Blocked(`SimpleLogin: ${e.message}`);
    }
    // The address may be a reverse alias of this alias (a reply) or an
    // existing contact the plan no longer allows to create (403).
    await refreshContacts(ctx, alias, [email]);
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

/**
 * The alias a message arrived through: SimpleLogin names it in
 * X-SimpleLogin-Envelope-To, added after it removed all other headers. A
 * direct message could fake the header, so it counts only when the sender is
 * a reverse alias of that very alias.
 */
async function arrivedThrough(ctx, messageId) {
  const full = ctx.sl ? await messenger.messages.getFull(messageId).catch(() => null) : null;
  const named = full?.headers?.["x-simplelogin-envelope-to"]?.[0];
  const alias = named ? await aliasFor(ctx, core.addressOf(named)).catch(() => null) : null;
  if (!alias) {
    return null;
  }
  const sender = core.addressOf(full.headers.from?.[0]);
  await refreshContacts(ctx, alias, [sender]);
  return Object.values(contactMap(ctx, alias)).includes(sender) ? alias : null;
}

/** Learns the reverse aliases of the alias a replied-to message arrived through. */
async function learnFromOriginal(ctx, messageId, wanted) {
  const alias = await arrivedThrough(ctx, messageId);
  if (alias) {
    await refreshContacts(ctx, alias, wanted);
  }
}

/** Members of an address book mailing list, or null if there is none with this name. */
async function mailingListMembers(name) {
  for (const book of await messenger.addressBooks.list(true)) {
    const list = book.mailingLists?.find(l => l.name == name);
    if (list) {
      return (await messenger.mailingLists.listMembers(list.id)).map(c => c.properties.PrimaryEmail).filter(Boolean);
    }
  }
  return null;
}

async function recipientsOf(details, fields = ["to", "cc", "bcc"]) {
  const list = [];
  for (const field of fields) {
    for (const entry of [].concat(details[field] ?? [])) {
      if (typeof entry != "string") {
        throw new Blocked("A recipient is an address book entry the add-on cannot read.");
      }
      const parsed = await messenger.messengerUtilities.parseMailboxString(entry, { expandMailingLists: true });
      for (const { name, email } of parsed) {
        if (email?.includes("@")) {
          list.push({ field, email: core.norm(email) });
          continue;
        }
        // A list with a description shows as "Name <Description>", which Thunderbird does not expand here.
        const members = await mailingListMembers(name ?? email);
        if (!members) {
          throw new Blocked(`Cannot read the address "${entry}".`);
        }
        list.push(...members.map(m => ({ field, email: core.norm(m) })));
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
      if (textual && file.size > MAX_ATTACHMENT_SCAN) {
        throw new Error("it is too large to check");
      }
      if (textual) {
        texts.push(await file.text());
      }
    } catch (e) {
      throw new Blocked(`Cannot check the attachment ${attachment.name}: ${e.message}`, true);
    }
  }
  return texts;
}

/**
 * The Message-ID a reply carries as In-Reply-To. SimpleLogin maps known IDs in
 * References back and forth, but leaves In-Reply-To as it is, and Thunderbird
 * generated the IDs of the user's own messages with the mailbox domain.
 */
async function inReplyTo(messageId) {
  const message = messageId ? await messenger.messages.get(messageId).catch(() => null) : null;
  return message?.headerMessageId ? [message.headerMessageId] : [];
}

/** Leaks a contact would see in a message passing through SimpleLogin. */
async function softLeaks(tabId, details, mine, domain) {
  const found = core.leaks([details.subject, details.body, details.plainTextBody], mine).map(a => `the text contains ${a}`);
  found.push(...core.leaks(await attachmentTexts(tabId), mine).map(a => `an attachment contains ${a}`));
  if (!details.isPlainText && core.hasEmbeddedImages(details.body)) {
    found.push(`embedded images would carry the domain ${domain}, attach them as files instead`);
  }
  const domains = new Set([domain, ...[...mine].map(domainOf)]);
  if (core.idsInDomains(await inReplyTo(details.relatedMessageId), domains).length) {
    found.push(`the reply refers to a message whose ID ends in your mailbox domain, start a new message instead`);
  }
  return found;
}

/** The alias's mailboxes that SimpleLogin lists as verified, so it accepts mail from them. */
const verifiedMailboxes = (ctx, alias) => core.verifiedOf(alias.mailboxes, ctx.cache.mailboxes?.value);

const bodyOf = details => (details.isPlainText ? { plainTextBody: details.plainTextBody } : { body: details.body });
const domainOf = email => email.slice(email.lastIndexOf("@") + 1);

// ---- the check that runs before every send ----------------------------------------

async function checkMailbox(tab, details, ctx, { sender, recipients, mine, override }) {
  let result = core.checkMailboxSend(recipients, knownReverseAliases(ctx), ctx.settings.allowlist, ownersOf(ctx, recipients));
  if (result.exposed.length && details.relatedMessageId && ctx.sl) {
    await learnFromOriginal(ctx, details.relatedMessageId, result.exposed.map(r => r.email));
    result = core.checkMailboxSend(recipients, knownReverseAliases(ctx), ctx.settings.allowlist, ownersOf(ctx, recipients));
  }
  if (result.mixed) {
    throw new Blocked("SimpleLogin drops a message that mixes reverse aliases with other addresses. Send two messages.");
  }
  const ownership = core.ownerProblem(result.viaAlias, ra => ownerIdOf(ctx, ra), id => aliasById(ctx, id), sender);
  if (ownership) {
    throw new Blocked(ownership);
  }
  if (result.exposed.length && !override) {
    const who = result.exposed.map(r => r.email).join(", ");
    const reverseDomains = new Set([...knownReverseAliases(ctx)].map(domainOf));
    if (result.exposed.every(r => reverseDomains.has(domainOf(r.email)))) {
      throw new Blocked(
        `${who} looks like a reverse alias the add-on does not know yet, so it cannot tell whether it belongs to you. Reply from the alias, or send once if you are sure.`,
        true
      );
    }
    const blocked = new Blocked(`Your real address ${sender} would be visible to ${who}. Choose an alias as sender.`, true);
    blocked.exposed = result.exposed;
    throw blocked;
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
    const pick = core.pickMailboxIdentity(await messenger.identities.list(), verifiedMailboxes(ctx, alias), identity.accountId);
    if (!pick.candidates.length) {
      throw new Blocked(`No Thunderbird identity uses a verified mailbox of ${alias.email} (${alias.mailboxes.join(", ")}). Add one.`);
    }
    if (!pick.identity) {
      throw new Blocked(
        `The identity ${pick.candidates[0].email} has an OpenPGP key or S/MIME certificate, and signing would reveal it. Add a second identity for that address without keys.`
      );
    }
    mailbox = pick.identity;
  }
  const own = recipients.filter(r => isMine(r.email));
  if (own.length) {
    // A reverse alias for it would make SimpleLogin write the real address into the copy every contact gets.
    throw new Blocked(`Your real address ${own.map(r => r.email).join(", ")} is a recipient of a message sent as ${alias.email}. Remove it, for example the automatic Cc of the identity.`);
  }
  const hard = core.sendProblems({
    selectedEncryptionTechnology: details.selectedEncryptionTechnology,
    newsgroups: details.newsgroups,
    followupTo: details.followupTo,
  });
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
  const problems = [];
  try {
    await messenger.compose.setComposeDetails(tab.id, {
      identityId: mailbox.id,
      ...plan.fields,
      replyTo: details.replyTo ?? [],
      attachVCard: false,
      attachPublicPGPKey: false,
      ...bodyOf(details),
    });
    const final = await messenger.compose.getComposeDetails(tab.id);
    problems.push(
      ...core.verifyAliasSend(
        { ...final, recipients: await recipientsOf(final), replyTo: await recipientsOf(final, ["replyTo"]) },
        { identityId: mailbox.id, alias: alias.email, contacts: contactsOf(ctx, alias), isProtected: isMine }
      )
    );
    if (!override) {
      problems.push(...core.leaks([final.subject, final.body, final.plainTextBody], mine).map(a => `the text contains ${a}`));
    }
  } catch (e) {
    problems.push(`the rewrite failed (${e.message})`);
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
    try {
      return await checkMailbox(tab, details, ctx, { ...options, sender });
    } catch (e) {
      if (!e.exposed || !ctx.sl || !ctx.settings.creation.autoSwitch) {
        throw e;
      }
      return switchToSiteAlias(tab, details, ctx, { ...options, sender }, e);
    }
  }
  const alias = await aliasFor(ctx, resumed ? earlier.alias : sender);
  if (alias) {
    return checkAlias(tab, details, ctx, { ...options, alias, resumed });
  }
  // An identity for an alias that no longer exists would send directly, past SimpleLogin.
  if (ctx.sl && (identity.label == IDENTITY_LABEL || (await goneAliases()).includes(sender))) {
    throw new Blocked(`${sender} is no longer an alias in SimpleLogin, so a message from it would go out directly. Choose another sender.`);
  }
  const shown = [details.from && core.addressOf(details.from), ...(await recipientsOf(details, ["replyTo"])).map(r => r.email)];
  const exposedAs = shown.find(email => email && isMine(email));
  if (exposedAs) {
    return checkMailbox(tab, details, ctx, { ...options, sender: exposedAs });
  }
  return ctx.sl ? { state: "other", sender } : { state: "unconfigured" };
}

/**
 * Calendar emails (invitations, replies) that Thunderbird sends without a
 * compose window. Sent as an alias they are rerouted through SimpleLogin like
 * a message, from a real mailbox they follow the same rules.
 */
async function checkItip(ctx, { sender, actor, to, cc = [], bcc = [], subject, body, calendar: folded }) {
  const calendar = core.unfold(folded);
  const mine = await protectedAddresses(ctx);
  const isMine = email => mine.has(core.canonical(email));
  const recipients = to.map(email => ({ field: "to", email: core.norm(email) }));
  // As in a message, the identity decides first: an invitation to an alias
  // makes Thunderbird answer from the alias identity. A calendar acting for
  // an alias from a mailbox identity is found through the attendee or organizer.
  let alias = sender && !isMine(sender) ? await aliasFor(ctx, core.norm(sender)) : null;
  alias ??= actor ? await aliasFor(ctx, core.norm(actor)) : null;
  if (alias) {
    const own = recipients.filter(r => isMine(r.email));
    if (own.length) {
      throw new Blocked(`Your real address ${own.map(r => r.email).join(", ")} is a recipient of a calendar email sent as ${alias.email}.`);
    }
    const leaked = core.leaks([subject, body, calendar], mine);
    if (leaked.length) {
      throw new Blocked(`The calendar email contains your real address ${leaked.join(", ")}.`);
    }
    // Thunderbird does not sign calendar emails, so keys do not matter here. The
    // transport adds the identity's automatic Cc/Bcc and Reply-To, so it has to be without them.
    const plain = new Set(await messenger.aliasBuddyItip.plainIdentityIds());
    const identities = (await messenger.identities.list()).filter(i => plain.has(i.id));
    const pick = core.pickMailboxIdentity(identities, verifiedMailboxes(ctx, alias), null);
    const mailbox = pick.identity ?? pick.candidates[0];
    if (!mailbox) {
      throw new Blocked(
        `No identity for a verified mailbox of ${alias.email} is free of automatic Cc/Bcc and Reply-To. Add one for ${alias.mailboxes[0]} without them.`
      );
    }
    for (const r of core.rewriteForAlias(recipients, alias.email, contactsOf(ctx, alias)).missing) {
      await addContact(ctx, alias, r.email);
    }
    const plan = core.rewriteForAlias(recipients, alias.email, contactsOf(ctx, alias));
    if (plan.missing.length) {
      throw new Blocked(`No reverse alias for ${plan.missing.map(r => r.email).join(", ")}.`);
    }
    return { action: "rewrite", identityId: mailbox.id, to: plan.fields.to };
  }
  const shown = [sender, actor].find(email => email && isMine(email));
  if (shown) {
    const all = [
      ...recipients,
      ...cc.map(e => ({ field: "cc", email: core.addressOf(e) })),
      ...bcc.map(e => ({ field: "bcc", email: core.addressOf(e) })),
    ];
    const result = core.checkMailboxSend(all, knownReverseAliases(ctx), ctx.settings.allowlist, ownersOf(ctx, all));
    if (result.exposed.length || result.mixed) {
      const who = (result.exposed.length ? result.exposed : all).map(r => r.email).join(", ");
      throw new Blocked(
        `A calendar email from your real address ${shown} would go to ${who}. Answer from an alias: add an identity for the alias the invitation was sent to, or allow the organizer in the settings.`
      );
    }
    const leaked = result.viaAlias.length ? core.leaks([subject, body, calendar], mine) : [];
    if (leaked.length) {
      throw new Blocked(`The calendar email names your real address ${leaked.join(", ")}.`);
    }
  }
  return { action: "send" };
}

// One check at a time, so concurrent sends and previews do not overwrite each other's cache.
let queue = Promise.resolve();
function serialized(work) {
  const next = queue.then(async () => {
    const ctx = await context();
    try {
      return await work(ctx);
    } finally {
      await messenger.storage.local.set({ cache: ctx.cache });
    }
  });
  queue = next.catch(() => {});
  return next;
}
/**
 * Checks a message in the queue. A send waits behind popup actions and the
 * reply automation, which may change the sender meanwhile, and Thunderbird
 * sends what the window holds afterwards. So a send is checked only if the
 * window still holds what was sent.
 */
const run = (tab, details, options = {}) =>
  serialized(async ctx => {
    if (options.apply !== false && core.fingerprint(await messenger.compose.getComposeDetails(tab.id)) != core.fingerprint(details)) {
      throw new Blocked("The message changed while it was checked, for example by a sender change in the popup. Check it and send again.");
    }
    return check(tab, details, ctx, options);
  });

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

messenger.aliasBuddyItip.onSend.addListener(async request => {
  try {
    return await serialized(ctx => checkItip(ctx, request));
  } catch (e) {
    const { reason } = blockedResult(e);
    messenger.notifications.create({ type: "basic", title: "Alias Buddy: calendar email not sent", message: reason });
    return { action: "drop" };
  }
});

// ---- alias creation and choice ---------------------------------------------------

const IDENTITY_LABEL = "Alias Buddy";

/** Addresses of aliases deleted in the overview. Kept outside the cache, which saving the settings clears. */
const goneAliases = async () => (await messenger.storage.local.get("goneAliases")).goneAliases ?? [];

const creationNote = (site, template) => (site ? core.siteNote(site, template) : "Created by Alias Buddy");

// A signed suffix from SimpleLogin is valid for 10 minutes; it is reused for 5.
const SUFFIX_REUSE = 5 * 60 * 1000;
// The planned name per site, template and domain, so the popup, the preview
// and the creation show and use the same name until it is created. A suffix of
// a SimpleLogin domain carries a random word, so it is kept too while valid.
const plannedNames = new Map();

/** The default mailbox for new aliases: the one from the settings, else SimpleLogin's default. */
async function creationMailbox(ctx) {
  await protectedAddresses(ctx);
  const verified = ctx.cache.mailboxes.value.filter(m => m.verified);
  const chosen = verified.find(m => m.id == ctx.settings.creation.mailboxId) ?? verified.find(m => m.default) ?? verified[0];
  if (!chosen) {
    throw new Blocked("SimpleLogin lists no verified mailbox for new aliases.");
  }
  return chosen;
}

/** The existing alias tied to a site and template through its note, if aliases per site are on. */
async function siteAlias(ctx, site, template) {
  if (!site || !ctx.settings.creation.perDomain) {
    return null;
  }
  ctx.cache.sites ??= {};
  const key = `${site}\n${template}`;
  let entry;
  try {
    entry = await cached(ctx.cache.sites[key], () => ctx.sl.findSiteAlias(site, template));
  } catch (e) {
    throw new Blocked(`SimpleLogin: ${e.message}. The add-on cannot tell whether an alias for ${site} exists.`);
  }
  // Only a found alias is kept: one created on another device must be found next time.
  if (!entry.value) {
    delete ctx.cache.sites[key];
    return null;
  }
  ctx.cache.sites[key] = entry;
  ctx.cache.aliases[entry.value.email] = { at: Date.now(), value: entry.value };
  return entry.value;
}

/** Name and suffix for a new alias, from the given choices or the settings. */
async function newAliasPlan(ctx, site, { prefix, domain, template: chosen } = {}) {
  const template = chosen ?? ctx.settings.creation.template;
  const wanted = domain ?? ctx.settings.creation.domain;
  const key = `${site}\n${template}\n${wanted}`;
  const pinned = prefix ? null : plannedNames.get(key);
  let suffix = pinned && Date.now() - pinned.at < SUFFIX_REUSE ? pinned.suffix : null;
  if (!suffix) {
    let suffixes;
    try {
      suffixes = await ctx.sl.suffixes();
    } catch (e) {
      throw new Blocked(`SimpleLogin: ${e.message}`);
    }
    suffix = core.pickSuffix(suffixes, wanted);
    if (!suffix) {
      throw new Blocked(
        wanted
          ? `SimpleLogin does not offer ${wanted} for new aliases. Choose another domain.`
          : "SimpleLogin offers no domain for new aliases."
      );
    }
  }
  const name = prefix ? core.prefixFrom(prefix, site) : (pinned?.prefix ?? core.prefixFrom(template, site));
  if (!prefix) {
    plannedNames.set(key, { prefix: name, suffix, at: pinned?.suffix == suffix ? pinned.at : Date.now() });
  }
  // A name without random parts can be one the user created by hand before.
  const random = (!prefix && /\{(random|word)\}/.test(template)) || !suffix.suffix.startsWith("@");
  return { prefix: name, suffix, email: name + suffix.suffix, key, random };
}

/**
 * What a message to this site would be sent as, without creating anything:
 * the alias tied to the site, an existing alias with the planned name (for a
 * template without random parts, such as shop.{domain}), or a new one.
 */
async function planForSite(ctx, site, template = ctx.settings.creation.template) {
  // The note names site and template, so each category keeps its own alias
  // whatever the order of the templates.
  const tied = await siteAlias(ctx, site, template);
  if (tied) {
    return { alias: tied, email: tied.email, existing: true };
  }
  const plan = await newAliasPlan(ctx, site, { template });
  const named = plan.random ? null : await aliasFor(ctx, plan.email);
  if (named && !named.enabled) {
    throw new Blocked(`${named.email} exists but is turned off. Turn it on in the alias overview, or change the name template.`);
  }
  if (named) {
    return { alias: named, email: named.email, existing: true };
  }
  const mailbox = await creationMailbox(ctx);
  return { alias: null, email: plan.email, existing: false, mailbox: mailbox.email };
}

async function createAlias(ctx, site, choices = {}) {
  const mailboxId = choices.mailboxId ?? (await creationMailbox(ctx)).id;
  const template = choices.template ?? ctx.settings.creation.template;
  const tie = ctx.settings.creation.perDomain && site ? site : null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const plan = await newAliasPlan(ctx, site, choices);
    try {
      const alias = await ctx.sl.createAlias({
        prefix: plan.prefix,
        signed: plan.suffix.signed,
        mailboxIds: [mailboxId],
        note: creationNote(tie, template),
      });
      plannedNames.delete(plan.key);
      ctx.cache.aliases[alias.email] = { at: Date.now(), value: alias };
      if (tie) {
        (ctx.cache.sites ??= {})[`${site}\n${template}`] = { at: Date.now(), value: alias };
      }
      return alias;
    } catch (e) {
      // A request that timed out may still have created the alias.
      const created = e instanceof ApiError && e.status == 0 ? await ctx.sl.findAlias(plan.email).catch(() => null) : null;
      if (created) {
        plannedNames.delete(plan.key);
        ctx.cache.aliases[created.email] = { at: Date.now(), value: created };
        return created;
      }
      // A taken name is retried only while the name has random parts.
      if (!(plan.random && e instanceof ApiError && e.status == 409)) {
        throw new Blocked(`SimpleLogin could not create ${plan.email}: ${e.message}`);
      }
      plannedNames.delete(plan.key);
    }
  }
  throw new Blocked("SimpleLogin could not create an alias, every generated name was taken.");
}

/** The alias for a site: the one tied to it or named like the plan, else a new one. */
async function aliasForSite(ctx, site, template) {
  const plan = await planForSite(ctx, site, template);
  return plan.alias ?? createAlias(ctx, site, { template });
}

/**
 * Instead of blocking a real mailbox, sends as the alias for the recipients'
 * site: only when all exposed recipients share one site and no allowlisted
 * recipient would suddenly get an alias. All checks run on the planned alias
 * first, so nothing is created for a message that would be blocked anyway.
 * A failure can still be overridden to send from the real address on purpose.
 */
async function switchToSiteAlias(tab, details, ctx, options, blocked) {
  const sites = new Set(blocked.exposed.map(r => core.siteOf(r.email)));
  if (sites.size != 1 || options.recipients.some(r => core.isAllowed(r.email, ctx.settings.allowlist))) {
    throw blocked;
  }
  const [site] = sites;
  const template = knownTemplate(ctx, chosenTemplates.get(tab.id)) ?? ctx.settings.creation.template;
  try {
    const plan = await planForSite(ctx, site, template);
    const planned = plan.alias ?? { id: null, email: plan.email, mailboxes: [plan.mailbox] };
    const preview = await checkAlias(tab, details, ctx, { ...options, alias: planned, resumed: false, apply: false });
    if (!options.apply) {
      return { ...preview, state: "switch", sender: options.sender, alias: plan.email, existing: plan.existing, template };
    }
    const alias = plan.alias ?? (await createAlias(ctx, site, { template }));
    return await checkAlias(tab, details, ctx, { ...options, alias, resumed: false });
  } catch (e) {
    throw new Blocked(`Sending as the alias for ${site} failed: ${e.message}`, true);
  }
}

/** The Thunderbird identity for an alias, created next to its mailbox identity if allowed. */
async function ensureIdentity(ctx, alias, accountId) {
  const identities = await messenger.identities.list();
  const existing = identities.find(i => core.norm(i.email) == alias.email);
  if (existing) {
    return existing;
  }
  if (!ctx.settings.creation.autoIdentity) {
    throw new Blocked(`Thunderbird has no identity for ${alias.email}. Add one, or let the add-on create identities in the settings.`);
  }
  const mailbox = core.pickMailboxIdentity(identities, verifiedMailboxes(ctx, alias), accountId).candidates[0];
  if (!mailbox) {
    throw new Blocked(`No Thunderbird identity uses a verified mailbox of ${alias.email}, so the add-on cannot tell which account it belongs to.`);
  }
  const created = await messenger.identities.create(mailbox.accountId, { email: alias.email, name: mailbox.name, label: IDENTITY_LABEL });
  // Open compose windows list their senders from when they opened.
  await messenger.aliasBuddyCompose.refreshIdentities();
  return created;
}

async function useAlias(ctx, tabId, alias) {
  const details = await messenger.compose.getComposeDetails(tabId);
  const current = await messenger.identities.get(details.identityId);
  const identity = await ensureIdentity(ctx, alias, current.accountId);
  await messenger.compose.setComposeDetails(tabId, { identityId: identity.id });
  return alias.email;
}

/** What the popup offers for choosing or creating the sender alias. */
async function aliasPanel(ctx, tabId, wanted, wantedSite) {
  if (!ctx.sl) {
    return null;
  }
  const { templates } = ctx.settings.creation;
  const template = knownTemplate(ctx, wanted) ?? knownTemplate(ctx, chosenTemplates.get(tabId)) ?? templates[0];
  chosenTemplates.set(tabId, template);
  const details = await messenger.compose.getComposeDetails(tabId);
  const current = core.norm((await messenger.identities.get(details.identityId)).email);
  const mine = await protectedAddresses(ctx);
  const contacts = new Map(Object.values(ctx.cache.contacts).flatMap(c => Object.entries(c).map(([contact, reverse]) => [reverse, contact])));
  const sites = core.recipientSites(
    (await recipientsOf(details).catch(() => [])).map(r => r.email),
    {
      isMine: email => mine.has(core.canonical(email)),
      contactOf: email => contacts.get(email),
      reverseDomains: new Set([...contacts.keys()].map(domainOf)),
    }
  );
  const site = sites.includes(wantedSite) ? wantedSite : (sites[0] ?? "");
  // The recipient's site is only looked up for messages from a mailbox or an alias.
  const relevant = site && (mine.has(core.canonical(current)) || (await aliasFor(ctx, current).catch(() => null)));
  const plan = await newAliasPlan(ctx, site, { template });
  const mailbox = await creationMailbox(ctx);
  // A failing suggestion (for example an alias that is turned off) must not hide the other choices.
  let suggestion = null;
  if (relevant) {
    try {
      suggestion = await planForSite(ctx, site, template);
    } catch (e) {
      suggestion = { error: e.message };
    }
  }
  return {
    site,
    sites,
    templates,
    template,
    suggestion,
    prefix: plan.prefix,
    domains: core.creationDomains(await ctx.sl.suffixes()),
    domain: plan.suffix.suffix.slice(plan.suffix.suffix.lastIndexOf("@") + 1),
    mailboxId: mailbox.id,
    mailboxes: ctx.cache.mailboxes.value.filter(m => m.verified).map(m => ({ id: m.id, email: m.email })),
  };
}

/** A template the popup sent, if it is still in the settings (they may have changed meanwhile). */
const knownTemplate = (ctx, template) => (ctx.settings.creation.templates.includes(template) ? template : undefined);

const ALIAS_ACTIONS = {
  aliasPanel: (ctx, m) => aliasPanel(ctx, m.tabId, m.template, m.site),
  searchAliases: async (ctx, m) =>
    (await ctx.sl.searchAliases(m.query)).filter(a => a.enabled).map(a => ({ email: a.email, note: a.note })),
  useAlias: async (ctx, m) => {
    const alias = await aliasFor(ctx, core.norm(m.email));
    if (!alias) {
      throw new Blocked(`${m.email} is not one of your aliases.`);
    }
    return useAlias(ctx, m.tabId, alias);
  },
  useSuggestion: async (ctx, m) => useAlias(ctx, m.tabId, await aliasForSite(ctx, m.site, knownTemplate(ctx, m.template))),
  createAlias: async (ctx, m) =>
    useAlias(
      ctx,
      m.tabId,
      await createAlias(ctx, m.site, { prefix: m.prefix, domain: m.domain, mailboxId: m.mailboxId, template: knownTemplate(ctx, m.template) })
    ),
};

// ---- alias overview -------------------------------------------------------------

/** Drops what the cache knows about an alias after it changed in SimpleLogin; its contacts only when it is gone. */
function forgetAlias(ctx, email, id, { contacts = false } = {}) {
  delete ctx.cache.aliases[email];
  for (const [site, entry] of Object.entries(ctx.cache.sites ?? {})) {
    if (entry.value?.email == email) {
      delete ctx.cache.sites[site];
    }
  }
  if (contacts) {
    delete ctx.cache.contacts[id];
    delete ctx.cache.contactsAt[id];
  }
}

/** Turns an API error into a message the page can show. */
async function api(ctx, action) {
  if (!ctx.sl) {
    throw new Blocked("Add your SimpleLogin API key in the settings first.");
  }
  try {
    return await action();
  } catch (e) {
    throw new Blocked(`SimpleLogin: ${e.message}`);
  }
}

Object.assign(ALIAS_ACTIONS, {
  listAliases: (ctx, m) => api(ctx, () => ctx.sl.listAliases({ page: m.page, query: m.query, filter: m.filter })),
  toggleAlias: async (ctx, m) => {
    const enabled = await api(ctx, () => ctx.sl.toggleAlias(m.id));
    forgetAlias(ctx, m.email, m.id);
    return enabled;
  },
  updateAlias: async (ctx, m) => {
    await api(ctx, () => ctx.sl.updateAlias(m.id, m.fields));
    forgetAlias(ctx, m.email, m.id);
  },
  /**
   * Deletes the alias, removes the identities the add-on created for it and
   * remembers the address, so no identity can send from it past SimpleLogin.
   */
  deleteAlias: async (ctx, m) => {
    await api(ctx, () => ctx.sl.deleteAlias(m.id));
    forgetAlias(ctx, m.email, m.id, { contacts: true });
    const gone = await goneAliases();
    await messenger.storage.local.set({ goneAliases: [...new Set([...gone, core.norm(m.email)])] });
    let kept = 0;
    for (const identity of await messenger.identities.list()) {
      if (core.norm(identity.email) == core.norm(m.email)) {
        if (identity.label == IDENTITY_LABEL) {
          await messenger.identities.delete(identity.id);
        } else {
          kept++;
        }
      }
    }
    return { keptIdentities: kept };
  },
  /** All contacts of an alias (up to 1000), in one go. */
  listContacts: async (ctx, m) => {
    const contacts = [];
    for (let page = 0; page < 50; page++) {
      const found = await api(ctx, () => ctx.sl.contactsPage(m.aliasId, page));
      if (!found.length) {
        return { contacts, complete: true };
      }
      contacts.push(...found);
    }
    return { contacts, complete: false };
  },
  toggleContact: (ctx, m) => api(ctx, () => ctx.sl.toggleContact(m.contactId)),
  deleteContact: async (ctx, m) => {
    await api(ctx, () => ctx.sl.deleteContact(m.contactId));
    const contacts = ctx.cache.contacts[m.aliasId] ?? {};
    for (const [email, reverse] of Object.entries(contacts)) {
      if (email == m.email || reverse == m.reverse) {
        delete contacts[email];
      }
    }
  },
  /** Opens a new message with the alias as sender. */
  composeAs: async (ctx, m) => {
    const alias = await aliasFor(ctx, core.norm(m.email));
    if (!alias) {
      throw new Blocked(`${m.email} is not one of your aliases.`);
    }
    if (!alias.enabled) {
      throw new Blocked(`${alias.email} is turned off, so replies to it would not arrive. Turn it on first.`);
    }
    const identity = await ensureIdentity(ctx, alias, undefined);
    await messenger.compose.beginNew({ identityId: identity.id });
  },
});

const openOverview = () => messenger.tabs.create({ url: messenger.runtime.getURL("overview/overview.html") });
messenger.browserAction.onClicked.addListener(openOverview);

// A reply to or forward of a message that came through an alias goes out as that alias.
messenger.tabs.onCreated.addListener(async tab => {
  if (tab.type != "messageCompose") {
    return;
  }
  try {
    const details = await messenger.compose.getComposeDetails(tab.id);
    if (!["reply", "forward"].includes(details.type) || !details.relatedMessageId) {
      return;
    }
    await serialized(async ctx => {
      if (!ctx.sl || !ctx.settings.creation.replyFromAlias) {
        return;
      }
      const alias = await arrivedThrough(ctx, details.relatedMessageId);
      // The user may have picked a sender while this waited.
      const now = await messenger.compose.getComposeDetails(tab.id);
      if (now.identityId != details.identityId) {
        return;
      }
      const current = await messenger.identities.get(details.identityId);
      if (alias && core.norm(current.email) != alias.email) {
        const identity = await ensureIdentity(ctx, alias, current.accountId);
        await messenger.compose.setComposeDetails(tab.id, { identityId: identity.id });
      }
    });
  } catch (e) {
    console.warn("Alias Buddy: could not set the alias of the reply or forward", e);
  }
});

messenger.tabs.onRemoved.addListener(tabId => {
  status.delete(tabId);
  overrides.delete(tabId);
  rewritten.delete(tabId);
  chosenTemplates.delete(tabId);
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
  if (ALIAS_ACTIONS[message.type]) {
    try {
      return { ok: true, value: await serialized(ctx => ALIAS_ACTIONS[message.type](ctx, message)) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
  if (message.type == "openOverview") {
    await openOverview();
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
