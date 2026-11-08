const $ = id => document.getElementById(id);
const date = seconds => (seconds ? new Date(seconds * 1000).toLocaleDateString() : "");

function element(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

/** Runs an action in the background; shows its error and returns undefined on failure, true for success without a value. */
async function act(type, args = {}) {
  $("error").hidden = true;
  const answer = await messenger.runtime.sendMessage({ type, ...args });
  if (!answer?.ok) {
    $("error").textContent = answer?.error ?? "No answer from the add-on.";
    $("error").hidden = false;
    return undefined;
  }
  return answer.value ?? true;
}

/** A button that asks for a second click before it acts. */
function confirmButton(label, confirmLabel, onConfirm) {
  const button = element("button", { type: "button", className: "btn btn-danger", textContent: label });
  let armed = null;
  button.addEventListener("click", async () => {
    if (!armed) {
      button.textContent = confirmLabel;
      armed = setTimeout(() => {
        armed = null;
        button.textContent = label;
      }, 5000);
      return;
    }
    clearTimeout(armed);
    armed = null;
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

async function showContacts(alias, row) {
  const next = row.nextElementSibling;
  if (next?.classList.contains("contacts")) {
    next.remove();
    return;
  }
  const body = element("tbody");
  const cell = element("td", { colSpan: 6 }, element("p", { className: "muted", textContent: "Loading contacts..." }));
  const holder = element("tr", { className: "contacts" }, cell);
  row.after(holder);
  const contacts = [];
  for (let page = 0; page < 50; page++) {
    const found = await act("listContacts", { aliasId: alias.id, page });
    if (!found?.length) {
      break;
    }
    contacts.push(...found);
  }
  for (const contact of contacts) {
    const blocked = element("input", { type: "checkbox", checked: contact.blocked });
    blocked.setAttribute("aria-label", `Block mail from ${contact.email}`);
    blocked.addEventListener("change", async () => {
      const now = await act("toggleContact", { contactId: contact.id });
      blocked.checked = now ?? !blocked.checked;
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
        confirmButton("Delete", "Confirm delete", async () => {
          if ((await act("deleteContact", { aliasId: alias.id, contactId: contact.id, email: contact.email, reverse: contact.reverse })) !== undefined) {
            tr.remove();
          }
        })
      )
    );
    body.append(tr);
  }
  const head = element(
    "thead",
    {},
    element(
      "tr",
      {},
      ...["Contact", "Reverse alias", "Last written to", "Blocked", ""].map(text => element("th", { scope: "col", textContent: text }))
    )
  );
  cell.replaceChildren(
    contacts.length ? element("table", { className: "inner" }, head, body) : element("p", { className: "muted", textContent: "No contacts yet." })
  );
}

function aliasRow(alias) {
  const row = element("tr", { className: alias.enabled ? "" : "disabled" });
  const pin = element("button", { type: "button", className: "btn pin", textContent: alias.pinned ? "★" : "☆" });
  pin.setAttribute("aria-label", alias.pinned ? `Unpin ${alias.email}` : `Pin ${alias.email}`);
  pin.setAttribute("aria-pressed", String(alias.pinned));
  pin.addEventListener("click", async () => {
    if ((await act("updateAlias", { id: alias.id, email: alias.email, fields: { pinned: !alias.pinned } })) !== undefined) {
      alias.pinned = !alias.pinned;
      row.replaceWith(aliasRow(alias));
    }
  });

  const note = element("input", { type: "text", value: alias.note, placeholder: "Note" });
  note.setAttribute("aria-label", `Note for ${alias.email}`);
  note.addEventListener("change", async () => {
    if ((await act("updateAlias", { id: alias.id, email: alias.email, fields: { note: note.value } })) !== undefined) {
      alias.note = note.value;
    }
  });

  const enabled = element("input", { type: "checkbox", checked: alias.enabled });
  enabled.setAttribute("aria-label", `${alias.email} receives mail`);
  enabled.addEventListener("change", async () => {
    const now = await act("toggleAlias", { id: alias.id, email: alias.email });
    alias.enabled = now ?? alias.enabled;
    enabled.checked = alias.enabled;
    row.className = alias.enabled ? "" : "disabled";
  });

  const button = (label, onClick) => {
    const b = element("button", { type: "button", className: "btn", textContent: label });
    b.addEventListener("click", onClick);
    return b;
  };
  const actions = element(
    "td",
    { className: "row-actions" },
    button("Contacts", () => showContacts(alias, row)),
    button("Write", () => act("composeAs", { email: alias.email })),
    button("Copy", async () => {
      try {
        await navigator.clipboard.writeText(alias.email);
        $("state").textContent = `Copied ${alias.email}.`;
      } catch (e) {
        $("state").textContent = `Could not copy ${alias.email}: ${e.message}`;
      }
    }),
    confirmButton("Delete", "Confirm delete", async () => {
      if ((await act("deleteAlias", { id: alias.id, email: alias.email })) !== undefined) {
        row.nextElementSibling?.classList.contains("contacts") && row.nextElementSibling.remove();
        row.remove();
      }
    })
  );

  row.append(
    element("td", {}, pin),
    element("td", {}, element("div", { className: "alias", textContent: alias.email }), note),
    element("td", { textContent: alias.mailboxes.join(", ") }),
    element("td", { className: "muted", textContent: activityText(alias) }),
    element("td", {}, enabled),
    actions
  );
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
  $("state").textContent = "Loading...";
  const aliases = await act("listAliases", { page, query: $("search").value.trim(), filter: $("filter").value });
  if (ticket != loading || aliases === undefined) {
    return;
  }
  $("aliases").tBodies[0].append(...aliases.map(aliasRow));
  const shown = $("aliases").tBodies[0].querySelectorAll("tr:not(.contacts)").length;
  $("state").textContent = shown ? `${shown} aliases shown.` : "No aliases found.";
  $("more").hidden = !aliases.length;
  page++;
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
