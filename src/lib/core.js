// Decision logic without browser APIs, so node --test can run it.

export const norm = email => String(email ?? "").trim().toLowerCase();

/** Takes the address out of "Name <a@b.c>" or returns the input. */
export function addressOf(mailbox) {
  const match = /<([^<>]+)>\s*$/.exec(String(mailbox ?? ""));
  return norm(match ? match[1] : mailbox);
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

/** Protected addresses that occur in any of the texts. */
export function leaks(texts, protectedAddresses) {
  const haystack = texts.filter(Boolean).join("\n");
  return [...protectedAddresses].filter(address => {
    const escaped = address.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?<![\\w.+-])${escaped}(?![\\w-])`, "i").test(haystack);
  });
}

/**
 * A message from a real mailbox may only go to reverse aliases (SimpleLogin
 * then sends it as the alias) or to allowlisted addresses. SimpleLogin drops a
 * message that mixes reverse aliases with other addresses, so that is reported
 * too.
 */
export function checkMailboxSend(recipients, reverseAliases, allowlist) {
  const viaAlias = recipients.filter(r => reverseAliases.has(norm(r.email)));
  const exposed = recipients.filter(r => !reverseAliases.has(norm(r.email)) && !isAllowed(r.email, allowlist));
  return { viaAlias, exposed, mixed: viaAlias.length > 0 && viaAlias.length < recipients.length };
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

/** Checks the compose state after the rewrite, right before it is sent. */
export function verifyAliasSend(final, { identityId, alias, contacts, protectedAddresses }) {
  const allowed = new Set([norm(alias), ...contacts.values()]);
  const problems = [];
  if (final.identityId != identityId) {
    problems.push("the sender identity did not switch to the mailbox");
  }
  for (const r of final.recipients) {
    if (!allowed.has(norm(r.email))) {
      problems.push(`${r.email} is not a reverse alias of ${alias}`);
    }
  }
  for (const r of final.replyTo) {
    if (protectedAddresses.has(norm(r.email))) {
      problems.push(`Reply-To contains ${r.email}`);
    }
  }
  if (final.attachVCard) {
    problems.push("a vCard would be attached");
  }
  if (final.attachPublicPGPKey) {
    problems.push("the OpenPGP key would be attached");
  }
  const crypto = final.selectedEncryptionTechnology;
  if (crypto?.signMessage || crypto?.encryptBody) {
    problems.push(`${crypto.name} signing or encryption is on and would use the mailbox key`);
  }
  return problems;
}
