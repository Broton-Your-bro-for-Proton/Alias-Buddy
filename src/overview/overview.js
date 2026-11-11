import * as core from "../lib/core.js";

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
    $("error").textContent = answer?.error ?? "No answer from the add-on.";
    $("error").hidden = false;
    return undefined;
  }
  return answer.value ?? true;
}

/**
 * A button that asks for a second click before it acts. The second click
 * counts only after half a second, so a double click cannot delete.
 */
function confirmButton(label, target, onConfirm) {
  const button = element("button", { type: "button", className: "btn btn-danger", textContent: label });
  button.setAttribute("aria-label", `${label} ${target}`);
  let armedAt = 0;
  let reset;
  button.addEventListener("click", async () => {
    if (!armedAt) {
      armedAt = Date.now();
      button.dataset.armed = "true";
      button.textContent = `Confirm ${label.toLowerCase()}`;
      say(`Click again to ${label.toLowerCase()} ${target}.`);
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
  const cell = element("td", { colSpan: 6 }, element("p", { className: "muted", textContent: "Loading contacts..." }));
  row.after(element("tr", { className: "contacts" }, cell));
  const result = await act("listContacts", { aliasId: alias.id });
  if (!result) {
    cell.replaceChildren(element("p", { className: "state-blocked", textContent: "Could not load the contacts." }));
    return;
  }
  const body = element("tbody");
  for (const contact of result.contacts) {
    const blocked = element("input", { type: "checkbox", checked: contact.blocked });
    blocked.setAttribute("aria-label", `Block mail from ${contact.email}`);
    blocked.addEventListener("change", async () => {
      const now = await act("toggleContact", { contactId: contact.id });
      blocked.checked = now === undefined ? !blocked.checked : now;
      if (now !== undefined) {
        say(`${contact.email} is ${now ? "blocked" : "no longer blocked"}.`);
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
        confirmButton("Delete", contact.email, async () => {
          if (await act("deleteContact", { aliasId: alias.id, contactId: contact.id, email: contact.email, reverse: contact.reverse })) {
            tr.remove();
            say(`Contact ${contact.email} deleted.`);
          }
        })
      )
    );
    body.append(tr);
  }
  const head = element(
    "thead",
    {},
    element("tr", {}, ...["Contact", "Reverse alias", "Last written to", "Blocked", ""].map(text => element("th", { scope: "col", textContent: text })))
  );
  cell.replaceChildren(
    result.contacts.length ? element("table", { className: "inner" }, head, body) : element("p", { className: "muted", textContent: "No contacts yet." }),
    ...(result.complete ? [] : [element("p", { className: "muted", textContent: "Only the first 1000 contacts are shown." })])
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

  const note = element("input", { type: "text", value: alias.note, placeholder: "Note" });
  note.setAttribute("aria-label", `Note for ${alias.email}`);
  note.addEventListener("change", async () => {
    if (await act("updateAlias", { id: alias.id, email: alias.email, fields: { note: note.value } })) {
      alias.note = note.value;
      say(`Note of ${alias.email} saved.`);
    } else {
      note.value = alias.note;
    }
  });

  const enabled = element("input", { type: "checkbox", checked: alias.enabled });
  enabled.setAttribute("aria-label", `${alias.email} receives mail`);
  enabled.addEventListener("change", async () => {
    const now = await act("toggleAlias", { id: alias.id, email: alias.email });
    if (now === undefined) {
      await load("quick", true); // the state in SimpleLogin is unknown now
      return;
    }
    alias.enabled = now;
    enabled.checked = now;
    showEnabled(row, alias);
    say(`${alias.email} is turned ${now ? "on" : "off"}.`);
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
  const contacts = button("Contacts", `Contacts of ${alias.email}`, b => showContacts(alias, row, b));
  contacts.setAttribute("aria-expanded", "false");
  const actions = element(
    "td",
    { className: "row-actions" },
    contacts,
    button("Write", `Write as ${alias.email}`, async () => {
      if (await act("composeAs", { email: alias.email })) {
        say(`New message as ${alias.email} opened.`);
      }
    }),
    button("Copy", `Copy ${alias.email}`, async () => {
      try {
        await navigator.clipboard.writeText(alias.email);
        say(`Copied ${alias.email}.`);
      } catch (e) {
        say(`Could not copy ${alias.email}: ${e.message}`);
      }
    }),
    confirmButton("Delete", alias.email, async () => {
      const result = await act("deleteAlias", { id: alias.id, email: alias.email });
      if (result) {
        await reload();
        say(
          result.keptIdentities
            ? `${alias.email} deleted. Remove its ${result.keptIdentities} identity in the account settings, the add-on blocks sending from it.`
            : `${alias.email} deleted.`
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
    return "not fully loaded yet";
  }
  const minutes = Math.round((Date.now() - at) / 60000);
  return minutes < 1 ? "just now" : minutes < 120 ? `${minutes} minutes ago` : `${Math.round(minutes / 60)} hours ago`;
}

/** Shows the current page of the local list. */
function render() {
  const view = core.viewAliases(aliases, { query: $("search").value, filter: $("filter").value, page, size: Number($("size").value) });
  page = view.page;
  $("aliases").tBodies[0].replaceChildren(...view.rows.map(aliasRow));
  $("pager").hidden = view.pages < 2;
  $("pageInfo").textContent = `Page ${view.page + 1} of ${view.pages}`;
  $("prev").disabled = view.page == 0;
  $("next").disabled = view.page == view.pages - 1;
  $("synced").textContent = `List updated ${age(syncedAt)}.`;
  return view;
}

const shownText = view => (view.total ? `${view.total} aliases, ${view.rows.length} shown.` : "No aliases found.");

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
  $("synced").textContent = `List updated ${age(syncedAt)}.`;
  if (store.error) {
    say(`Could not update the list: ${store.error}`);
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
      say(`${shownText(render())} ${found.added} came from the online search.`);
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
  say("Updating the list from SimpleLogin...");
  await load("full");
  $("update").disabled = false;
});
const tidy = confirmButton("Tidy up", "the sender list", async () => {
  const result = await act("tidyIdentities");
  if (result) {
    say(
      result.removed
        ? `Removed ${result.removed} sender identities the add-on created. They come back when you use their alias.`
        : "No sender identities of the add-on to remove."
    );
  }
});
$("tidy").replaceWith(tidy);

await load();
load("quick", true);
