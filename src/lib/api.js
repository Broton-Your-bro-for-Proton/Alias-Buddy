// Minimal SimpleLogin API client. Paging stops at the first empty page, because
// page sizes differ between servers.
// Docs: https://github.com/simple-login/app/blob/master/docs/api.md
import { addressOf, norm } from "./core.js";

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
        return { id: alias.id, email: norm(alias.email), mailboxes: alias.mailboxes.map(m => norm(m.email)) };
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

  /** Creates the contact, or returns the existing one. */
  async createContact(aliasId, email) {
    const contact = await this.call("POST", `/api/aliases/${aliasId}/contacts`, { contact: email });
    return norm(contact.reverse_alias_address ?? addressOf(contact.reverse_alias));
  }
}
