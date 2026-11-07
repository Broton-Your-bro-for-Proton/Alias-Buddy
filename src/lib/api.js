// Minimal SimpleLogin API client. Docs: https://github.com/simple-login/app/blob/master/docs/api.md
import { addressOf, norm } from "./core.js";

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const PAGE = 20;
const MAX_PAGES = 50;

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
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new ApiError(response.status, data.error ?? `HTTP ${response.status}`);
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
      if (aliases.length < PAGE) {
        return null;
      }
    }
    throw new ApiError(0, `too many search results for ${email}`);
  }

  /** All contacts of an alias as { contact address: reverse alias }. */
  async contacts(aliasId) {
    const result = {};
    for (let page = 0; page < MAX_PAGES; page++) {
      const { contacts } = await this.call("GET", `/api/aliases/${aliasId}/contacts?page_id=${page}`);
      for (const c of contacts) {
        result[addressOf(c.contact)] = norm(c.reverse_alias_address ?? addressOf(c.reverse_alias));
      }
      if (contacts.length < PAGE) {
        return result;
      }
    }
    throw new ApiError(0, "too many contacts");
  }

  /** Creates the contact, or returns the existing one. */
  async createContact(aliasId, email) {
    const contact = await this.call("POST", `/api/aliases/${aliasId}/contacts`, { contact: email });
    return norm(contact.reverse_alias_address ?? addressOf(contact.reverse_alias));
  }
}
