// Minimal SimpleLogin API client. Paging stops at the first empty page, because
// page sizes differ between servers.
// Docs: https://github.com/simple-login/app/blob/master/docs/api.md
import { addressOf, noteNamesSite, norm } from "./core.js";

/** The parts of an alias the add-on uses. */
const aliasInfo = a => ({
  id: a.id,
  email: norm(a.email),
  mailboxes: (a.mailboxes ?? []).map(m => norm(m.email)),
  note: a.note ?? "",
  enabled: a.enabled !== false,
  pinned: !!a.pinned,
  forwards: a.nb_forward ?? 0,
  replies: a.nb_reply ?? 0,
  blocks: a.nb_block ?? 0,
  latest: a.latest_activity
    ? { action: a.latest_activity.action, at: a.latest_activity.timestamp, contact: norm(a.latest_activity.contact?.email) }
    : null,
});

/** The parts of a contact the overview shows. */
const contactInfo = c => ({
  id: c.id,
  email: addressOf(c.contact),
  reverse: norm(c.reverse_alias_address ?? addressOf(c.reverse_alias)),
  blocked: !!c.block_forward,
  lastSent: c.last_email_sent_timestamp ?? null,
});

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const MAX_PAGES = 500;
/** Status of an ApiError when paging gave up; unlike 0 (unreachable) it is no outage. */
export const TOO_MANY = -1;

/** Errors after which an older answer may stand in: no connection, rate limit, server trouble. */
export const isOutage = e => e instanceof ApiError && (e.status == 0 || e.status == 429 || e.status >= 500);

export class SimpleLogin {
  constructor(url, key) {
    this.url = url.replace(/\/+$/, "");
    this.key = key;
  }

  async call(method, path, body) {
    let response;
    try {
      response = await fetch(this.url + path, {
        method,
        headers: { Authentication: this.key, ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15000),
      });
    } catch (e) {
      throw new ApiError(0, `cannot reach ${this.url} (${e.message})`);
    }
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      throw new ApiError(response.status, data?.error ?? `HTTP ${response.status}`);
    }
    if (!data || typeof data != "object") {
      throw new ApiError(response.status, `unexpected answer from ${this.url}`);
    }
    return data;
  }

  async mailboxes() {
    return (await this.call("GET", "/api/v2/mailboxes")).mailboxes;
  }

  /** The alias with exactly this address, or null. */
  async findAlias(email) {
    for (let page = 0; page < MAX_PAGES; page++) {
      const { aliases } = await this.call("POST", `/api/v2/aliases?page_id=${page}`, { query: email });
      const alias = aliases.find(a => norm(a.email) == norm(email));
      if (alias) {
        return aliasInfo(alias);
      }
      if (!aliases.length) {
        return null;
      }
    }
    throw new ApiError(TOO_MANY, `too many search results for ${email}`);
  }

  /**
   * Contacts of an alias as { contact address: reverse alias }. With `wanted`
   * (contact addresses or reverse aliases) it stops as soon as all are found.
   */
  async contacts(aliasId, wanted = []) {
    const result = {};
    const missing = new Set(wanted.map(norm));
    for (let page = 0; page < MAX_PAGES; page++) {
      const { contacts } = await this.call("GET", `/api/aliases/${aliasId}/contacts?page_id=${page}`);
      for (const c of contacts) {
        const contact = addressOf(c.contact);
        result[contact] = norm(c.reverse_alias_address ?? addressOf(c.reverse_alias));
        missing.delete(contact);
        missing.delete(result[contact]);
      }
      if (!contacts.length || (wanted.length && !missing.size)) {
        return result;
      }
    }
    throw new ApiError(TOO_MANY, "too many contacts to search");
  }

  /** Aliases matching a search (address, note or name), one page. */
  async searchAliases(query, page = 0) {
    return this.listAliases({ query, page });
  }

  /** One page of aliases, optionally searched and filtered to enabled, disabled or pinned ones. */
  async listAliases({ page = 0, query = "", filter = "" } = {}) {
    const flag = ["enabled", "disabled", "pinned"].includes(filter) ? `&${filter}` : "";
    const { aliases } = await this.call("POST", `/api/v2/aliases?page_id=${page}${flag}`, { query });
    return aliases.map(aliasInfo);
  }

  /** Enables a disabled alias or disables an enabled one; returns whether it is enabled now. */
  async toggleAlias(id) {
    return (await this.call("POST", `/api/aliases/${id}/toggle`)).enabled;
  }

  /** Changes the note, name or pin of an alias. */
  async updateAlias(id, fields) {
    await this.call("PATCH", `/api/aliases/${id}`, fields);
  }

  async deleteAlias(id) {
    await this.call("DELETE", `/api/aliases/${id}`);
  }

  /** One page of an alias's contacts, with their block state. */
  async contactsPage(aliasId, page = 0) {
    const { contacts } = await this.call("GET", `/api/aliases/${aliasId}/contacts?page_id=${page}`);
    return contacts.map(contactInfo);
  }

  /** Blocks or unblocks mail from a contact; returns whether it is blocked now. */
  async toggleContact(id) {
    return (await this.call("POST", `/api/contacts/${id}/toggle`)).block_forward;
  }

  async deleteContact(id) {
    await this.call("DELETE", `/api/contacts/${id}`);
  }

  /** The enabled alias whose note ties it to the site, or null. */
  async findSiteAlias(site) {
    for (let page = 0; page < MAX_PAGES; page++) {
      const aliases = await this.searchAliases(site, page);
      const alias = aliases.find(a => a.enabled && noteNamesSite(a.note, site));
      if (alias || !aliases.length) {
        return alias ?? null;
      }
    }
    throw new ApiError(TOO_MANY, `too many search results for ${site}`);
  }

  /** Suffixes the user may create aliases with: own domains, subdomains and SimpleLogin domains. */
  async suffixes() {
    const { suffixes } = await this.call("GET", "/api/v5/alias/options");
    return suffixes.map(s => ({ suffix: norm(s.suffix), signed: s.signed_suffix, custom: !!s.is_custom }));
  }

  async createAlias({ prefix, signed, mailboxIds, note }) {
    const body = { alias_prefix: prefix, signed_suffix: signed, mailbox_ids: mailboxIds, note };
    return aliasInfo(await this.call("POST", "/api/v3/alias/custom/new", body));
  }

  /** Creates the contact, or returns the existing one. */
  async createContact(aliasId, email) {
    const contact = await this.call("POST", `/api/aliases/${aliasId}/contacts`, { contact: email });
    return norm(contact.reverse_alias_address ?? addressOf(contact.reverse_alias));
  }
}
