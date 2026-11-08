const $ = id => document.getElementById(id);
const date = seconds => (seconds ? new Date(seconds * 1000).toLocaleDateString() : "");

function element(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

const say = text => ($("state").textContent = text);

/** Runs an action in the background; shows its error and returns undefined on failure, true for success without a value. */
async function act(type, args = {}) {
  $("error").hidden = true;
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
      button.textContent = `Confirm ${label.toLowerCase()}`;
      say(`Click again to ${label.toLowerCase()} ${target}.`);
      reset = setTimeout(() => {
        armedAt = 0;
        button.textContent = label;
      }, 5000);
      return;
    }
    if (Date.now() - armedAt < 500) {
      return;
    }
    clearTimeout(reset);
    armedAt = 0;
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
      await reload(); // the state in SimpleLogin is unknown now
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
        say(
          result.keptIdentities
            ? `${alias.email} deleted. Remove its ${result.keptIdentities} identity in the account settings, the add-on blocks sending from it.`
            : `${alias.email} deleted.`
        );
        await reload();
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

let page = 0;
let loading = 0;
async function load(reset) {
  const ticket = ++loading;
  if (reset) {
    page = 0;
    $("aliases").tBodies[0].replaceChildren();
  }
  say("Loading...");
  const aliases = await act("listAliases", { page, query: $("search").value.trim(), filter: $("filter").value });
  if (ticket != loading) {
    return;
  }
  if (aliases === undefined) {
    say("Could not load the aliases.");
    return;
  }
  $("aliases").tBodies[0].append(...aliases.map(aliasRow));
  const shown = $("aliases").tBodies[0].querySelectorAll("tr:not(.contacts)").length;
  say(shown ? `${shown} aliases shown.` : "No aliases found.");
  $("more").hidden = !aliases.length;
  page++;
}

/**
 * Loads the pages shown so far again. SimpleLogin pages by position, so after
 * a row left the list (deleted, or out of the filter) the next page would skip one.
 */
async function reload() {
  const pages = page;
  const status = $("state").textContent;
  await load(true);
  while (page < pages && !$("more").hidden) {
    await load(false);
  }
  say(status);
}

let searchTimer;
$("search").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => load(true), 300);
});
$("filter").addEventListener("change", () => load(true));
$("more").addEventListener("click", () => load(false));
$("settings").addEventListener("click", event => {
  event.preventDefault();
  messenger.runtime.openOptionsPage();
});

load(true);
