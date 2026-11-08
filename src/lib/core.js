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
