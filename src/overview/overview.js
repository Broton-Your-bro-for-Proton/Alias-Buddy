import * as core from "../lib/core.js";
import { t } from "../lib/i18n.js";

const $ = id => document.getElementById(id);
const date = seconds => (seconds ? new Date(seconds * 1000).toLocaleDateString() : "");

function element(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

const say = text => ($("state").textContent = text);

/** Runs an action in the background; shows its error and returns undefined on failure, true for success without a value. */
async function act(type, args = {}, quiet = false) {
  if (!quiet) {
    $("error").hidden = true;
  }
  let answer;
  try {
    answer = await messenger.runtime.sendMessage({ type, ...args });
  } catch (e) {
    answer = { ok: false, error: e.message };
  }
  if (!answer?.ok) {
    $("error").textContent = answer?.error ?? t("No answer from the add-on.");
    $("error").hidden = false;
    return undefined;
  }
  return answer.value ?? true;
}

const deleteTexts = name => ({
  aria: t("Delete {name}", { name }),
  confirm: t("Confirm delete"),
  hint: t("Click again to delete {name}.", { name }),
});

/**
 * A button that asks for a second click before it acts. The second click
 * counts only after half a second, so a double click cannot delete.
 */
function confirmButton(label, { aria, confirm, hint }, onConfirm) {
  const button = element("button", { type: "button", className: "btn btn-danger", textContent: label });
  button.setAttribute("aria-label", aria);
  let armedAt = 0;
  let reset;
  button.addEventListener("click", async () => {
    if (!armedAt) {
      armedAt = Date.now();
      button.dataset.armed = "true";
      button.textContent = confirm;
      say(hint);
      reset = setTimeout(() => {
        armedAt = 0;
        delete button.dataset.armed;
        button.textContent = label;
      }, 5000);
      return;
    }
    if (Date.now() - armedAt < 500) {
      return;
    }
    clearTimeout(reset);
    armedAt = 0;
    delete button.dataset.armed;
    button.disabled = true;
    await onConfirm();
    button.disabled = false;
    button.textContent = label;
  });
  return button;
}

function activityText(alias) {
  const counts = `${alias.forwards} received, ${alias.replies} sent, ${alias.blocks} blocked`;
  return alias.latest ? `${counts}. Last: ${alias.latest.action} ${alias.latest.contact} on ${date(alias.latest.at)}` : counts;
}

async function showContacts(alias, row, toggle) {
  const next = row.nextElementSibling;
  if (next?.classList.contains("contacts")) {
    next.remove();
    toggle.setAttribute("aria-expanded", "false");
    return;
  }
  toggle.setAttribute("aria-expanded", "true");
  const cell = element("td", { colSpan: 6 }, element("p", { className: "muted", textContent: t("Loading contacts...") }));
  row.after(element("tr", { className: "contacts" }, cell));
  const result = await act("listContacts", { aliasId: alias.id });
  if (!result) {
    cell.replaceChildren(element("p", { className: "state-blocked", textContent: t("Could not load the contacts.") }));
    return;
  }
  const body = element("tbody");
  for (const contact of result.contacts) {
    const blocked = element("input", { type: "checkbox", checked: contact.blocked });
    blocked.setAttribute("aria-label", t("Block mail from {address}", { address: contact.email }));
    blocked.addEventListener("change", async () => {
      const now = await act("toggleContact", { contactId: contact.id });
      blocked.checked = now === undefined ? !blocked.checked : now;
      if (now !== undefined) {
        say(now ? t("{address} is blocked.", { address: contact.email }) : t("{address} is no longer blocked.", { address: contact.email }));
      }
    });
    const tr = element(
      "tr",
      {},
      element("td", { textContent: contact.email }),
      element("td", { textContent: contact.reverse }),
      element("td", { textContent: date(contact.lastSent) }),
      element("td", {}, blocked),
      element(
        "td",
        {},
        confirmButton(t("Delete"), deleteTexts(contact.email), async () => {
          if (await act("deleteContact", { aliasId: alias.id, contactId: contact.id, email: contact.email, reverse: contact.reverse })) {
            tr.remove();
            say(t("Contact {address} deleted.", { address: contact.email }));
          }
        })
      )
    );
    body.append(tr);
  }
  const head = element(
    "thead",
    {},
    element("tr", {}, ...[t("Contact"), t("Reverse alias"), t("Last written to"), t("Blocked"), ""].map(text => element("th", { scope: "col", textContent: text })))
  );
  cell.replaceChildren(
    result.contacts.length ? element("table", { className: "inner" }, head, body) : element("p", { className: "muted", textContent: t("No contacts yet.") }),
    ...(result.complete ? [] : [element("p", { className: "muted", textContent: t("Only the first 1000 contacts are shown.") })])
  );
}

function showPin(pin, alias) {
  pin.textContent = alias.pinned ? "★" : "☆";
  pin.setAttribute("aria-label", alias.pinned ? `Unpin ${alias.email}` : `Pin ${alias.email}`);
  pin.setAttribute("aria-pressed", String(alias.pinned));
}

function showEnabled(row, alias) {
  row.className = alias.enabled ? "" : "disabled";
  row.querySelector(".off").hidden = alias.enabled;
}

function aliasRow(alias) {
  const row = element("tr");
  const pin = element("button", { type: "button", className: "btn pin" });
  showPin(pin, alias);
  pin.addEventListener("click", async () => {
    // Busy instead of disabled: a disabled button would lose the keyboard focus.
    if (pin.getAttribute("aria-busy") == "true") {
      return;
    }
    const pinned = !alias.pinned;
    pin.setAttribute("aria-busy", "true");
    const done = await act("updateAlias", { id: alias.id, email: alias.email, fields: { pinned } });
    pin.removeAttribute("aria-busy");
    if (done) {
      alias.pinned = pinned;
      showPin(pin, alias);
      if ($("filter").value == "pinned") {
        await reload();
      }
    }
  });

  const note = element("input", { type: "text", value: alias.note, placeholder: t("Note") });
  note.setAttribute("aria-label", t("Note for {alias}", { alias: alias.email }));
  note.addEventListener("change", async () => {
    if (await act("updateAlias", { id: alias.id, email: alias.email, fields: { note: note.value } })) {
      alias.note = note.value;
      say(t("Note of {alias} saved.", { alias: alias.email }));
    } else {
      note.value = alias.note;
    }
  });

  const enabled = element("input", { type: "checkbox", checked: alias.enabled });
  enabled.setAttribute("aria-label", t("{alias} receives mail", { alias: alias.email }));
  enabled.addEventListener("change", async () => {
    const now = await act("toggleAlias", { id: alias.id, email: alias.email });
    if (now === undefined) {
      await load("quick", true); // the state in SimpleLogin is unknown now
      return;
    }
    alias.enabled = now;
    enabled.checked = now;
    showEnabled(row, alias);
    say(now ? t("{alias} is turned on.", { alias: alias.email }) : t("{alias} is turned off.", { alias: alias.email }));
    if ($("filter").value == "enabled" || $("filter").value == "disabled") {
      await reload();
    }
  });

  const button = (label, name, onClick) => {
    const b = element("button", { type: "button", className: "btn", textContent: label });
    b.setAttribute("aria-label", name);
    b.addEventListener("click", () => onClick(b));
    return b;
  };
  const contacts = button(t("Contacts"), t("Contacts of {alias}", { alias: alias.email }), b => showContacts(alias, row, b));
  contacts.setAttribute("aria-expanded", "false");
  const actions = element(
    "td",
    { className: "row-actions" },
    contacts,
    button(t("Write"), t("Write as {alias}", { alias: alias.email }), async () => {
      if (await act("composeAs", { email: alias.email })) {
        say(t("New message as {alias} opened.", { alias: alias.email }));
      }
    }),
    button(t("Copy"), t("Copy {alias}", { alias: alias.email }), async () => {
      try {
        await navigator.clipboard.writeText(alias.email);
        say(t("Copied {alias}.", { alias: alias.email }));
      } catch (e) {
        say(t("Could not copy {alias}: {error}", { alias: alias.email, error: e.message }));
      }
    }),
    confirmButton(t("Delete"), deleteTexts(alias.email), async () => {
      const result = await act("deleteAlias", { id: alias.id, email: alias.email });
      if (result) {
        await reload();
        say(
          result.keptIdentities
            ? t("{alias} deleted. Remove its {identity} identity in the account settings, the add-on blocks sending from it.", { alias: alias.email, identity: result.keptIdentities })
            : t("{alias} deleted.", { alias: alias.email })
        );
      }
    })
  );

  const off = element("span", { className: "off muted", textContent: " (off)" });
  row.append(
    element("td", {}, pin),
    element("td", {}, element("div", { className: "alias" }, element("span", { className: "address", textContent: alias.email }), off), note),
    element("td", { textContent: alias.mailboxes.join(", ") }),
    element("td", { className: "muted", textContent: activityText(alias) }),
    element("td", {}, enabled),
    actions
  );
  showEnabled(row, alias);
  return row;
}

let aliases = [];
let syncedAt = 0;
let page = 0;

function age(at) {
  if (!at) {
    return t("not fully loaded yet");
  }
  const minutes = Math.round((Date.now() - at) / 60000);
  return minutes < 1 ? t("just now") : minutes < 120 ? t("{count} minutes ago", { count: minutes }) : t("{count} hours ago", { count: Math.round(minutes / 60) });
}

/** Shows the current page of the local list. */
function render() {
  const view = core.viewAliases(aliases, { query: $("search").value, filter: $("filter").value, page, size: Number($("size").value) });
  page = view.page;
  $("aliases").tBodies[0].replaceChildren(...view.rows.map(aliasRow));
  $("pager").hidden = view.pages < 2;
  $("pageInfo").textContent = t("Page {page} of {pages}", { page: view.page + 1, pages: view.pages });
  $("prev").disabled = view.page == 0;
  $("next").disabled = view.page == view.pages - 1;
  $("synced").textContent = t("List updated {age}.", { age: age(syncedAt) });
  return view;
}

const shownText = view => (view.total ? t("{total} aliases, {shown} shown.", { total: view.total, shown: view.rows.length }) : t("No aliases found."));

/**
 * Loads the local list from the add-on, after a quick or full sync if asked. A quiet
 * load runs behind the user's back: it redraws only when the list changed and keeps
 * the status line, so a message or an open contact list stays.
 */
async function load(sync, quiet = false) {
  const store = await act("aliasStore", { sync }, quiet);
  if (store === undefined) {
    return;
  }
  const changed = JSON.stringify(store.aliases) != JSON.stringify(aliases);
  aliases = store.aliases;
  syncedAt = store.at;
  // Not while the user works in a row: an armed Delete, open contacts or a note being typed.
  const busy = document.querySelector("#aliases [data-armed], #aliases tr.contacts, #aliases input:focus");
  const view = !quiet || (changed && !busy) ? render() : null;
  $("synced").textContent = t("List updated {age}.", { age: age(syncedAt) });
  if (store.error) {
    say(t("Could not update the list: {error}", { error: store.error }));
  } else if (!quiet) {
    say(shownText(view));
  }
}

// Rows change their alias in place, so after an edit the page is redrawn even when the list looks the same.
const reload = async () => {
  await load(undefined, true);
  render();
};

let searchTimer;
let searching = 0;
$("search").addEventListener("input", () => {
  page = 0;
  say(shownText(render()));
  clearTimeout(searchTimer);
  const query = $("search").value.trim();
  if (query.length < 2) {
    return;
  }
  // Also asks SimpleLogin, for aliases the local list does not have yet.
  searchTimer = setTimeout(async () => {
    const ticket = ++searching;
    const found = await act("searchOnline", { query }, true);
    if (!found || ticket != searching) {
      return;
    }
    await load(undefined, true);
    if (found.added) {
      say(t("{shown} {count} came from the online search.", { shown: shownText(render()), count: found.added }));
    }
  }, 600);
});
$("filter").addEventListener("change", () => {
  page = 0;
  say(shownText(render()));
});
$("size").addEventListener("change", () => {
  page = 0;
  render();
});
$("prev").addEventListener("click", () => {
  page--;
  render();
});
$("next").addEventListener("click", () => {
  page++;
  render();
});
$("update").addEventListener("click", async () => {
  $("update").disabled = true;
  say(t("Updating the list from SimpleLogin..."));
  await load("full");
  $("update").disabled = false;
});
const tidy = confirmButton(t("Tidy up"), { aria: t("Tidy up the sender list"), confirm: t("Confirm tidy up"), hint: t("Click again to tidy up the sender list.") }, async () => {
  const result = await act("tidyIdentities");
  if (result) {
    say(
      result.removed
        ? t("Removed {count} sender identities the add-on created. They come back when you use their alias.", { count: result.removed })
        : t("No sender identities of the add-on to remove.")
    );
  }
});
$("tidy").replaceWith(tidy);

await load();
load("quick", true);
