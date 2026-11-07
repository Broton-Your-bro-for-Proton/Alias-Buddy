import { ApiError, SimpleLogin } from "./lib/api.js";
import * as core from "./lib/core.js";
import { getSettings } from "./lib/settings.js";

const TTL = 10 * 60 * 1000;
const status = new Map(); // tab id: last result, shown in the popup
const overrides = new Set(); // tab ids allowed to skip overridable checks once

class Blocked extends Error {
  constructor(message, overridable = false) {
    super(message);
    this.overridable = overridable;
  }
}

// ---- cache: { mailboxes: {at, value}, aliases: {email: {at, value}}, contacts: {aliasId: {address: reverse}} }

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
  const cache = (await messenger.storage.local.get("cache")).cache ?? {};
  cache.aliases ??= {};
  cache.contacts ??= {};
  return { settings, cache, sl: new SimpleLogin(settings.apiUrl, settings.apiKey) };
}

async function protectedAddresses(ctx) {
  try {
    ctx.cache.mailboxes = await cached(ctx.cache.mailboxes, async () =>
      (await ctx.sl.mailboxes()).map(m => core.norm(m.email))
    );
  } catch (e) {
    throw new Blocked(`SimpleLogin: ${e.message}. Without the mailbox list the add-on cannot tell which addresses are yours.`, true);
  }
  return new Set([...ctx.cache.mailboxes.value, ...ctx.settings.protected.map(core.norm).filter(Boolean)]);
}

async function aliasFor(ctx, email) {
  try {
    ctx.cache.aliases[email] = await cached(ctx.cache.aliases[email], () => ctx.sl.findAlias(email));
  } catch (e) {
    throw new Blocked(`SimpleLogin: ${e.message}. The add-on cannot tell whether ${email} is an alias.`, true);
  }
  return ctx.cache.aliases[email].value;
}

const contactsOf = (ctx, alias) => new Map(Object.entries((ctx.cache.contacts[alias.id] ??= {})));
const knownReverseAliases = ctx => new Set(Object.values(ctx.cache.contacts).flatMap(Object.values));

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
    if (!(e instanceof ApiError && e.status == 400)) {
      throw new Blocked(`SimpleLogin: ${e.message}`);
    }
    // The address may be a reverse alias of this alias, for example in a reply.
    await refreshContacts(ctx, alias);
    if (![...contactsOf(ctx, alias).values()].includes(email)) {
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

const bodyOf = details => (details.isPlainText ? { plainTextBody: details.plainTextBody } : { body: details.body });

// ---- the check that runs before every send ----------------------------------------

/**
 * Throws Blocked when the message must not go out. With `apply` false it only
 * reports what would happen, for the popup.
 */
async function check(tab, details, ctx, { override = false, apply = true } = {}) {
  const identity = await messenger.identities.get(details.identityId);
  const sender = core.norm(identity.email);
  const recipients = await recipientsOf(details);
  const texts = [details.subject, details.body, details.plainTextBody];
  const mine = await protectedAddresses(ctx);

  if (mine.has(sender)) {
    let result = core.checkMailboxSend(recipients, knownReverseAliases(ctx), ctx.settings.allowlist);
    if (result.exposed.length && details.relatedMessageId) {
      await learnFromOriginal(ctx, details.relatedMessageId);
      result = core.checkMailboxSend(recipients, knownReverseAliases(ctx), ctx.settings.allowlist);
    }
    if (result.mixed) {
      throw new Blocked("SimpleLogin drops a message that mixes reverse aliases with other addresses. Send two messages.");
    }
    if (result.exposed.length && !override) {
      const who = result.exposed.map(r => r.email).join(", ");
      throw new Blocked(`Your real address ${sender} would be visible to ${who}. Choose an alias as sender.`, true);
    }
    const leaked = result.viaAlias.length ? core.leaks(texts, mine) : [];
    if (leaked.length && !override) {
      throw new Blocked(`The message text contains your real address ${leaked.join(", ")}.`, true);
    }
    return { state: "mailbox", sender, rows: recipients.map(r => ({ ...r, via: r.email })) };
  }

  const alias = await aliasFor(ctx, sender);
  if (!alias) {
    return { state: "other", sender };
  }

  const identities = await messenger.identities.list();
  const isMailbox = i => alias.mailboxes.includes(core.norm(i.email));
  const mailbox = identities.find(i => i.accountId == identity.accountId && isMailbox(i)) ?? identities.find(isMailbox);
  if (!mailbox) {
    throw new Blocked(`No Thunderbird identity uses a mailbox of ${alias.email} (${alias.mailboxes.join(", ")}). Add one.`);
  }
  const leaked = core.leaks(texts, mine);
  if (leaked.length && !override) {
    throw new Blocked(`The message text contains your real address ${leaked.join(", ")}.`, true);
  }

  let plan = core.rewriteForAlias(recipients, alias.email, contactsOf(ctx, alias));
  if (!apply) {
    const pending = plan.missing.map(r => ({ ...r, via: null }));
    return { state: "alias", sender, mailbox: mailbox.email, rows: [...plan.rows, ...pending] };
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
    { identityId: mailbox.id, alias: alias.email, contacts: contactsOf(ctx, alias), protectedAddresses: mine }
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
  return { state: "alias", sender, mailbox: mailbox.email, rows: plan.rows, sent: true };
}

async function run(tab, details, options) {
  const ctx = await context();
  if (!ctx.settings.apiKey) {
    return { state: "unconfigured" };
  }
  try {
    return await check(tab, details, ctx, options);
  } finally {
    await messenger.storage.local.set({ cache: ctx.cache });
  }
}

function show(tabId, result) {
  status.set(tabId, result);
  const badge = { blocked: ["!", "#c62828"], alias: ["✓", "#2e7d32"], unconfigured: ["?", "#f9a825"] }[result.state];
  messenger.composeAction.setBadgeText({ tabId, text: badge?.[0] ?? "" });
  if (badge) {
    messenger.composeAction.setBadgeBackgroundColor({ tabId, color: badge[1] });
  }
}

function blockedResult(e) {
  const blocked = e instanceof Blocked ? e : new Blocked(`Unexpected error: ${e.message}`);
  return { state: "blocked", reason: blocked.message, overridable: blocked.overridable };
}

messenger.compose.onBeforeSend.addListener(async (tab, details) => {
  try {
    show(tab.id, await run(tab, details, { override: overrides.delete(tab.id) }));
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
    overrides.add(tabId);
    await messenger.compose.sendMessage(tabId);
  }
});
