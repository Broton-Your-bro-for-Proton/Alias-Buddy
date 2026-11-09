// Decision logic without browser APIs, so node --test can run it.

export const norm = email => String(email ?? "").trim().toLowerCase();

/** Takes the address out of "Name <a@b.c>" or returns the input. */
export function addressOf(mailbox) {
  const match = /<([^<>]+)>\s*$/.exec(String(mailbox ?? ""));
  return norm(match ? match[1] : mailbox);
}

/**
 * The form a mail provider delivers to: without a +tag, and for Gmail without
 * dots and with gmail.com, so me+x@gmail.com and m.e@googlemail.com both count
 * as me@gmail.com.
 */
export function canonical(email) {
  let [local, domain] = norm(email).split(/@(?=[^@]*$)/);
  if (domain == null) {
    return local;
  }
  local = local.split("+")[0];
  if (domain == "gmail.com" || domain == "googlemail.com") {
    return `${local.replaceAll(".", "")}@gmail.com`;
  }
  if (PROTON.has(domain)) {
    return `${local}@proton.me`;
  }
  return `${local}@${domain}`;
}
const PROTON = new Set(["proton.me", "protonmail.com", "protonmail.ch", "pm.me"]);

/** Joins folded iCalendar lines (RFC 5545), so an address split by a fold is found. */
export const unfold = text => String(text ?? "").replace(/\r?\n[ \t]/g, "");

/** Message-IDs (as in In-Reply-To or References) whose domain is one of `domains`. */
export function idsInDomains(ids, domains) {
  return ids.filter(id => domains.has(norm(id).replace(/[<>\s]/g, "").split("@").pop()));
}

/** "a@b.c" matches that address, "@b.c" or "b.c" the whole domain. */
export function isAllowed(email, allowlist) {
  const address = norm(email);
  const domain = address.slice(address.lastIndexOf("@") + 1);
  return allowlist.some(entry => {
    const value = norm(entry);
    if (!value) {
      return false;
    }
    return value.includes("@") && !value.startsWith("@") ? value == address : value.replace(/^@/, "") == domain;
  });
}

/** Protected addresses, in any spelling the provider accepts, that occur in the texts. */
export function leaks(texts, protectedCanonical) {
  const found = new Set();
  for (const text of texts) {
    for (const token of String(text ?? "").match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) ?? []) {
      if (protectedCanonical.has(canonical(token))) {
        found.add(norm(token));
      }
    }
  }
  return [...found];
}

/**
 * A message from a real mailbox may only go to reverse aliases (SimpleLogin
 * then sends it as the alias) or to allowlisted addresses. SimpleLogin drops a
 * message that mixes reverse aliases with other addresses, except the alias
 * that owns them (reply all keeps it in Cc), so `owners` count as neither.
 */
export function checkMailboxSend(recipients, reverseAliases, allowlist, owners = new Set()) {
  const rest = recipients.filter(r => !owners.has(norm(r.email)));
  const viaAlias = rest.filter(r => reverseAliases.has(norm(r.email)));
  const exposed = rest.filter(r => !reverseAliases.has(norm(r.email)) && !isAllowed(r.email, allowlist));
  // SimpleLogin only sees To and Cc. Bcc goes out through the mailbox's own server.
  const headers = rest.filter(r => r.field != "bcc");
  const headersViaAlias = headers.filter(r => reverseAliases.has(norm(r.email)));
  return { viaAlias, exposed, mixed: headersViaAlias.length > 0 && headersViaAlias.length < headers.length };
}

/**
 * Replaces each recipient of a message sent as an alias with its reverse
 * alias. `contacts` maps a contact address to its reverse alias for this alias.
 * The alias itself and its reverse aliases stay as they are. Recipients
 * without a reverse alias are returned in `missing`.
 */
export function rewriteForAlias(recipients, alias, contacts) {
  const reverse = new Set(contacts.values());
  const fields = { to: [], cc: [], bcc: [] };
  const rows = [];
  const missing = [];
  for (const r of recipients) {
    const email = norm(r.email);
    const target = email == norm(alias) || reverse.has(email) ? email : contacts.get(email);
    if (target) {
      fields[r.field].push(target);
      rows.push({ field: r.field, email, via: target });
    } else {
      missing.push(r);
    }
  }
  return { fields, rows, missing };
}

/**
 * Checks the reverse aliases a real mailbox writes to. They must belong to one
 * alias (otherwise each contact sees the others' real addresses) and the
 * mailbox must be one of that alias's mailboxes (otherwise SimpleLogin rejects
 * it). Returns the reason to block, or null.
 */
export function ownerProblem(viaAlias, ownerIdOf, aliasById, sender) {
  const ids = new Set(viaAlias.map(r => ownerIdOf(norm(r.email))));
  if (ids.size > 1) {
    return "The reverse aliases belong to different aliases, and each contact would see the others' real addresses. Send one message per alias.";
  }
  const owner = ids.size ? aliasById([...ids][0]) : null;
  if (owner && !owner.mailboxes.some(m => canonical(m) == canonical(sender))) {
    return `${sender} is not a mailbox of ${owner.email}, so SimpleLogin would reject the message. Send it from ${owner.mailboxes.join(" or ")}.`;
  }
  return null;
}

/** The alias's mailboxes SimpleLogin lists as verified; all of them while the list is unknown. */
export function verifiedOf(aliasMailboxes, knownMailboxes) {
  return knownMailboxes ? aliasMailboxes.filter(m => knownMailboxes.some(k => k.email == m && k.verified)) : aliasMailboxes;
}

/** Images Thunderbird embeds at send time. Their Content-ID carries the sender's domain. */
export function hasEmbeddedImages(body) {
  return /<img\b(?![^>]*\bmoz-do-not-send="true")[^>]*\bsrc\s*=\s*(?:"(?!https?:)|'(?!https?:)|(?!["']|https?:))/i.test(String(body ?? ""));
}

/**
 * Settings that would send the mailbox's identity along on the way through
 * SimpleLogin, which keeps attachments and MIME parts.
 */
export function sendProblems(details) {
  const problems = [];
  if (details.attachVCard) {
    problems.push("a vCard would be attached");
  }
  if (details.attachPublicPGPKey) {
    problems.push("the OpenPGP key would be attached");
  }
  const crypto = details.selectedEncryptionTechnology;
  if (crypto?.signMessage || crypto?.encryptBody) {
    problems.push(`${crypto.name} signing or encryption is on and would reveal the mailbox`);
  }
  if ([].concat(details.newsgroups ?? []).filter(Boolean).length || [].concat(details.followupTo ?? []).length) {
    problems.push("newsgroups cannot be posted through SimpleLogin");
  }
  return problems;
}

/** Checks the compose state after the rewrite, right before it is sent. */
export function verifyAliasSend(final, { identityId, alias, contacts, isProtected }) {
  const allowed = new Set([norm(alias), ...contacts.values()]);
  const problems = sendProblems(final);
  if (final.identityId != identityId) {
    problems.push("the sender identity did not switch to the mailbox");
  }
  for (const r of final.recipients) {
    if (!allowed.has(norm(r.email))) {
      problems.push(`${r.email} is not a reverse alias of ${alias}`);
    }
  }
  for (const r of final.replyTo) {
    if (isProtected(r.email)) {
      problems.push(`Reply-To contains ${r.email}`);
    }
  }
  return problems;
}

/**
 * The identity to send an alias's message from: one of its mailboxes, without
 * an OpenPGP key or S/MIME certificate, because Thunderbird decides about
 * signing only after the identity switch, too late for the final check.
 */
export function pickMailboxIdentity(identities, mailboxes, accountId) {
  const wanted = new Set(mailboxes.map(canonical));
  const candidates = identities
    .filter(i => wanted.has(canonical(i.email)))
    .sort((a, b) => (b.accountId == accountId) - (a.accountId == accountId));
  const keyless = i => !Object.values(i.encryptionCapabilities ?? {}).some(c => c?.canSign || c?.canEncrypt);
  return { identity: candidates.find(keyless) ?? null, candidates };
}

/** What a one-time override applies to: the message exactly as it was blocked. */
export function fingerprint(details) {
  const { identityId, from, to, cc, bcc, replyTo, subject, body, plainTextBody, isPlainText } = details;
  return JSON.stringify([identityId, from, to, cc, bcc, replyTo, subject, isPlainText ? plainTextBody : body]);
}

// ---- alias creation ------------------------------------------------------------

// Endings registered below a country code. A short list instead of the full
// public suffix list: a miss only splits one company into two sites.
const MULTI_PART = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "ltd.uk", "plc.uk",
  "com.au", "net.au", "org.au", "co.nz", "org.nz", "co.jp", "ne.jp", "or.jp",
  "co.kr", "co.in", "co.za", "co.il", "com.br", "com.mx", "com.ar", "com.tr",
  "com.cn", "com.hk", "com.tw", "com.sg", "com.my", "co.at", "or.at",
]);

/**
 * The registrable part of an address's domain, as a stand-in for "the site":
 * news.dhl.de gives dhl.de, mail.bbc.co.uk gives bbc.co.uk.
 */
export function siteOf(email) {
  const host = norm(email).split("@").pop().replace(/^\[|\]$/g, "");
  if (/^[\d.]+$|:/.test(host)) {
    return host; // an IP address has no site
  }
  const labels = host.split(".").filter(Boolean);
  return labels.slice(MULTI_PART.has(labels.slice(-2).join(".")) ? -3 : -2).join(".");
}

/**
 * The sites a message goes to, in recipient order, to choose an alias for:
 * a known reverse alias stands for its contact, the user's own addresses and
 * unknown reverse aliases are left out.
 */
export function recipientSites(emails, { isMine, contactOf, reverseDomains }) {
  const sites = new Set();
  for (const email of emails) {
    const real = contactOf(email) ?? email;
    if (!isMine(real) && !(real == email && reverseDomains.has(email.split("@").pop()))) {
      sites.add(siteOf(real));
    }
  }
  return [...sites].filter(Boolean);
}

/**
 * The address book card of a reverse alias: Thunderbird shows its name instead
 * of the reverse alias. It starts with the alias, so typing the contact's
 * address does not silently complete to the card.
 */
export const reverseAliasCard = (contact, alias) => ({
  DisplayName: `[${alias}] ${contact}`,
  Notes: `Reverse alias for ${contact} through your alias ${alias}. Kept by Alias Buddy.`,
});

const WORDS = ["amber", "brook", "cedar", "dune", "ember", "fern", "grove", "harbor", "isle", "juniper", "kite", "lark",
  "meadow", "nova", "orbit", "pine", "quartz", "river", "stone", "tide", "umber", "vale", "willow", "zephyr"];

/**
 * An alias prefix from a template. {domain} is the site's name without its
 * ending, {random} five random letters and digits, {word} a random word.
 * The result only uses what SimpleLogin accepts: a-z, 0-9, dot, dash, underscore.
 */
export function prefixFrom(template, site, random = Math.random) {
  const pick = chars => chars[Math.floor(random() * chars.length)];
  const name = site.split(".")[0] ?? "";
  const filled = String(template || "{domain}.{random}")
    .replaceAll("{domain}", name)
    .replace(/\{random\}/g, () => Array.from({ length: 5 }, () => pick("abcdefghijkmnpqrstuvwxyz23456789")).join(""))
    .replace(/\{word\}/g, () => pick(WORDS));
  const clean = filled
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "")
    .replace(/[._-]{2,}/g, m => m[0])
    .slice(0, 40)
    .replace(/^[._-]+|[._-]+$/g, "");
  return clean || Array.from({ length: 8 }, () => pick("abcdefghijkmnpqrstuvwxyz23456789")).join("");
}

const domainOfSuffix = suffix => suffix.slice(suffix.lastIndexOf("@") + 1);

/**
 * The suffix to create an alias with: the one for `domain` (the plain
 * "@domain" of an own domain first), or without a choice the first own domain,
 * else the first SimpleLogin domain.
 */
export function pickSuffix(suffixes, domain) {
  if (domain) {
    const matching = suffixes.filter(s => domainOfSuffix(s.suffix) == norm(domain));
    return matching.find(s => s.suffix.startsWith("@")) ?? matching[0] ?? null;
  }
  return suffixes.find(s => s.custom) ?? suffixes[0] ?? null;
}

/** The domains offered for new aliases, own ones first, each once. */
export function creationDomains(suffixes) {
  const seen = new Map();
  for (const s of suffixes) {
    const domain = domainOfSuffix(s.suffix);
    if (!seen.has(domain)) {
      seen.set(domain, { domain, custom: s.custom, random: !s.suffix.startsWith("@") });
    }
  }
  return [...seen.values()].sort((a, b) => b.custom - a.custom);
}

// The template of version 0.3, whose site ties carried no template.
const FIRST_DEFAULT_TEMPLATE = "{domain}.{random}";

/** The line in an alias note that ties it to a site and the template (category) it was made with. */
export const siteNote = (site, template) => `Alias Buddy: ${site} (${template})`;

/** Whether a note ties its alias to this site and template. Older ties without a template belong to {domain}.{random}. */
export function noteNamesSite(note, site, template) {
  return String(note ?? "")
    .split(/\r?\n/)
    .map(line => line.trim())
    .some(line => line == siteNote(site, template) || (template == FIRST_DEFAULT_TEMPLATE && line == `Alias Buddy: ${site}`));
}

/** Why a name template cannot be used, or null. Each one needs a placeholder, or every site would get the same name. */
export function templateProblem(template) {
  if (!/\{(domain|random|word)\}/.test(template)) {
    return `${template} has no {domain}, {random} or {word}, so every site would get the same name`;
  }
  return null;
}

/**
 * The name templates of the creation settings, the default first. Settings
 * from before the list kept a single template.
 */
export function templatesOf(creation) {
  const list = (creation.templates ?? [creation.template]).map(t => String(t ?? "").trim()).filter(Boolean);
  return list.length ? [...new Set(list)] : ["{domain}.{random}"];
}
