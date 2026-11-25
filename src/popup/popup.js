import { sendOnceOffer } from "../lib/core.js";
import { t } from "../lib/i18n.js";

const $ = id => document.getElementById(id);
const [tab] = await messenger.tabs.query({ active: true, currentWindow: true });

const SUMMARY = {
  unconfigured: () => t("Not set up yet. Add your SimpleLogin API key in the settings."),
  other: p => t("{sender} is not a SimpleLogin address. The add-on leaves this message alone.", { sender: p.sender }),
  mailbox: p => t("Sending from your real address {sender}.", { sender: p.sender }),
  alias: p => t("Sending as {sender}. SimpleLogin receives it from {mailbox}.", { sender: p.sender, mailbox: p.mailbox }),
  switch: p =>
    (p.existing
      ? t("Sending from {sender} would show your real address. On send it switches to the alias {alias}, from the template {template}.", p)
      : t("Sending from {sender} would show your real address. On send it switches to the new alias {alias}, from the template {template}.", p)),
  blocked: p => t("This message would be blocked: {reason}", { reason: p.reason }),
};

let offer = null; // the block "send once" accepts
function render({ preview, last, found, accepted }) {
  offer = sendOnceOffer(preview, last, accepted);
  $("found").hidden = !found;
  $("found").textContent = found ?? "";
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
  $("last").textContent = lastBlocked ? t("Last send was blocked: {reason}", { reason: last.reason }) : "";
  $("sendOnce").hidden = !offer;
  $("sendOnce").textContent = preview.state == "switch" ? t("Send from my real address instead") : t("Send this message unchanged");
}

const refresh = async () => render(await messenger.runtime.sendMessage({ type: "preview", tabId: tab.id }));

/** Runs an alias action in the background, shows its error, refreshes the summary on success. */
async function act(type, args = {}) {
  $("aliasError").hidden = true;
  const buttons = [...document.querySelectorAll("#aliasPanel button, #aliasPanel select")];
  buttons.forEach(b => (b.disabled = true));
  const answer = await messenger.runtime.sendMessage({ type, tabId: tab.id, ...args }).finally(() => buttons.forEach(b => (b.disabled = false)));
  if (!answer?.ok) {
    $("aliasError").textContent = answer?.error ?? t("No answer from the add-on.");
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
  // "No alias yet" would contradict a sender that is already one of the site's aliases.
  $("suggestion").hidden = !panel.suggestion || (!panel.suggestion.existing && panel.matches.some(m => m.email == panel.sender));
  $("useSuggestion").hidden = !!panel.suggestion?.error;
  if (panel.suggestion?.error) {
    $("suggestionText").textContent = panel.suggestion.error;
  } else if (panel.suggestion) {
    $("suggestionText").textContent = panel.suggestion.existing
      ? t("Your alias for {site}:", { site: panel.site })
      : t("No alias for {site} yet. A new one would be:", { site: panel.site });
    $("useSuggestion").textContent = (panel.suggestion.existing ? t("Use {alias}", { alias: panel.suggestion.email }) : t("Create and use {alias}", { alias: panel.suggestion.email }));
  }
  if ($("search").value.trim().length < 2) {
    showAliases(panel.matches);
  }
  $("siteRow").hidden = panel.sites.length < 2;
  $("site").replaceChildren(...panel.sites.map(s => new Option(s, s, false, s == panel.site)));
  $("templateRow").hidden = panel.templates.length < 2;
  $("template").replaceChildren(...panel.templates.map(t => new Option(t, t, false, t == panel.template)));
  $("prefix").value = panel.prefix;
  $("domain").replaceChildren(
    ...panel.domains.map(d => new Option(d.random ? t("{domain} (adds a random word)", { domain: d.domain }) : d.domain, d.domain, false, d.domain == panel.domain))
  );
  $("mailbox").replaceChildren(...panel.mailboxes.map(m => new Option(t("to {mailbox}", { mailbox: m.email }), m.id, false, m.id == panel.mailboxId)));
}

/** Alias buttons under "Existing alias": search results, or the site's aliases while the search is empty. */
function showAliases(aliases) {
  $("results").replaceChildren(
    ...aliases.slice(0, 10).map(alias => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "btn choice";
      button.textContent = alias.note ? `${alias.email}  (${alias.note.split("\n")[0]})` : alias.email;
      button.addEventListener("click", () => choose("useAlias", { email: alias.email }));
      return button;
    })
  );
}

let searchTimer;
$("search").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    const query = $("search").value.trim();
    showAliases(query.length < 2 ? (panel?.matches ?? []) : ((await act("searchAliases", { query })) ?? []));
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
  // The block the user saw; a different one is not sent once.
  // A send blocked again rejects; the popup closes either way, the button shows the new reason.
  await messenger.runtime.sendMessage({ type: "sendOnce", tabId: tab.id, reason: offer }).catch(() => {});
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
