const $ = id => document.getElementById(id);
const [tab] = await messenger.tabs.query({ active: true, currentWindow: true });

const SUMMARY = {
  unconfigured: () => "Not set up yet. Add your SimpleLogin API key in the settings.",
  other: p => `${p.sender} is not a SimpleLogin address. The add-on leaves this message alone.`,
  mailbox: p => `Sending from your real address ${p.sender}.`,
  alias: p => `Sending as ${p.sender}. SimpleLogin receives it from ${p.mailbox}.`,
  switch: p =>
    `Sending from ${p.sender} would show your real address. On send it switches to the alias ${p.alias}${p.existing ? "" : " (new)"}, from the template ${p.template}.`,
  blocked: p => `This message would be blocked: ${p.reason}`,
};

function render({ preview, last }) {
  $("summary").textContent = SUMMARY[preview.state](preview);
  $("summary").className = { alias: "state-ok", switch: "state-ok", blocked: "state-blocked" }[preview.state] ?? "";
  const body = $("rows").tBodies[0];
  body.replaceChildren();
  for (const row of preview.rows ?? []) {
    const tr = body.insertRow();
    tr.insertCell().textContent = row.field;
    tr.insertCell().textContent = row.email;
    const via = tr.insertCell();
    via.textContent = row.via == row.email ? "directly" : row.via ?? "new reverse alias on send";
    via.className = row.via ? "" : "pending";
  }
  $("rows").hidden = !body.rows.length;
  const lastBlocked = last?.state == "blocked" && last.reason != preview.reason;
  $("last").hidden = !lastBlocked;
  $("last").textContent = lastBlocked ? `Last send was blocked: ${last.reason}` : "";
  $("sendOnce").hidden = !((preview.state == "blocked" && preview.overridable) || preview.state == "switch");
  $("sendOnce").textContent = preview.state == "switch" ? "Send from my real address instead" : "Send this message unchanged";
}

const refresh = async () => render(await messenger.runtime.sendMessage({ type: "preview", tabId: tab.id }));

/** Runs an alias action in the background, shows its error, refreshes the summary on success. */
async function act(type, args = {}) {
  $("aliasError").hidden = true;
  const buttons = [...document.querySelectorAll("#aliasPanel button, #aliasPanel select")];
  buttons.forEach(b => (b.disabled = true));
  const answer = await messenger.runtime.sendMessage({ type, tabId: tab.id, ...args }).finally(() => buttons.forEach(b => (b.disabled = false)));
  if (!answer?.ok) {
    $("aliasError").textContent = answer?.error ?? "No answer from the add-on.";
    $("aliasError").hidden = false;
    return null;
  }
  return answer.value;
}

async function choose(type, args) {
  if ((await act(type, args)) != null) {
    await refresh();
    await loadPanel(panel?.template, panel?.site);
  }
}

let panel = null;
async function loadPanel(template, site) {
  const loaded = await act("aliasPanel", { template, site });
  if (!loaded) {
    // Keep what was shown, so the other choices stay usable.
    if (panel) {
      $("template").value = panel.template;
      $("site").value = panel.site;
    }
    $("aliasPanel").hidden = !panel;
    return;
  }
  panel = loaded;
  $("aliasPanel").hidden = false;
  $("suggestion").hidden = !panel.suggestion;
  $("useSuggestion").hidden = !!panel.suggestion?.error;
  if (panel.suggestion?.error) {
    $("suggestionText").textContent = panel.suggestion.error;
  } else if (panel.suggestion) {
    $("suggestionText").textContent = panel.suggestion.existing
      ? `Your alias for ${panel.site}:`
      : `No alias for ${panel.site} yet. A new one would be:`;
    $("useSuggestion").textContent = `${panel.suggestion.existing ? "Use" : "Create and use"} ${panel.suggestion.email}`;
  }
  $("siteRow").hidden = panel.sites.length < 2;
  $("site").replaceChildren(...panel.sites.map(s => new Option(s, s, false, s == panel.site)));
  $("templateRow").hidden = panel.templates.length < 2;
  $("template").replaceChildren(...panel.templates.map(t => new Option(t, t, false, t == panel.template)));
  $("prefix").value = panel.prefix;
  $("domain").replaceChildren(
    ...panel.domains.map(d => new Option(d.random ? `${d.domain} (adds a random word)` : d.domain, d.domain, false, d.domain == panel.domain))
  );
  $("mailbox").replaceChildren(...panel.mailboxes.map(m => new Option(`to ${m.email}`, m.id, false, m.id == panel.mailboxId)));
}

let searchTimer;
$("search").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    const query = $("search").value.trim();
    const found = query.length < 2 ? [] : (await act("searchAliases", { query })) ?? [];
    $("results").replaceChildren(
      ...found.slice(0, 8).map(alias => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "btn choice";
        button.textContent = alias.note ? `${alias.email}  (${alias.note.split("\n")[0]})` : alias.email;
        button.addEventListener("click", () => choose("useAlias", { email: alias.email }));
        return button;
      })
    );
  }, 300);
});

// The chosen template also decides the switch on send, so the summary follows it.
$("template").addEventListener("change", async () => {
  await loadPanel($("template").value, panel?.site);
  await refresh();
});
$("site").addEventListener("change", () => loadPanel(panel?.template, $("site").value));
$("useSuggestion").addEventListener("click", () => choose("useSuggestion", { site: panel.site, template: panel.template }));
$("create").addEventListener("click", () =>
  choose("createAlias", {
    site: panel.site,
    prefix: $("prefix").value.trim(),
    template: panel.template,
    domain: $("domain").value,
    mailboxId: Number($("mailbox").value),
  })
);
$("sendOnce").addEventListener("click", async () => {
  await messenger.runtime.sendMessage({ type: "sendOnce", tabId: tab.id });
  window.close();
});
$("overview").addEventListener("click", async event => {
  event.preventDefault();
  await messenger.runtime.sendMessage({ type: "openOverview" });
  window.close();
});
$("options").addEventListener("click", event => {
  event.preventDefault();
  messenger.runtime.openOptionsPage();
});

await refresh();
await loadPanel();
