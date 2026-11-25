import { t } from "../lib/i18n.js";
const $ = id => document.getElementById(id);
const [tab] = await messenger.tabs.query({ active: true, currentWindow: true });

/** Runs an action in the background and shows its error; null on failure. */
async function act(type, args = {}) {
  $("error").hidden = true;
  const buttons = [...document.querySelectorAll("button")];
  buttons.forEach(b => (b.disabled = true));
  let answer;
  try {
    answer = await messenger.runtime.sendMessage({ type, tabId: tab.id, ...args });
  } catch (e) {
    answer = { ok: false, error: e.message };
  }
  buttons.forEach(b => (b.disabled = false));
  if (!answer?.ok) {
    $("error").textContent = answer?.error ?? t("No answer from the add-on.");
    $("error").hidden = false;
    return null;
  }
  return answer.value ?? true;
}

const SUMMARY = {
  none: () => t("Open a single message to see the alias it came through."),
  direct: () => t("This message did not come through a SimpleLogin alias."),
  unconfirmed: o =>
    t("This message names your alias {alias}, but its sender is not a contact of that alias, so it did not come through SimpleLogin.", { alias: o.named }),
  alias: o =>
    t("Came through your alias {alias} from {sender}.", {
      alias: o.alias.enabled ? o.alias.email : t("{alias} (turned off)", { alias: o.alias.email }),
      sender: o.contact?.blocked ? t("{sender} (blocked)", { sender: o.contact.email }) : (o.contact?.email ?? o.sender),
    }),
};

let origin = null;
async function load() {
  const loaded = await act("messageOrigin");
  if (!loaded) {
    return;
  }
  origin = loaded;
  $("summary").textContent = SUMMARY[origin.state](origin);
  $("summary").className = origin.state == "unconfirmed" ? "state-blocked" : "";
  $("choices").hidden = origin.state != "alias";
  if (origin.state == "alias") {
    const { alias, contact } = origin;
    $("toggleContact").hidden = !contact;
    $("toggleContact").textContent = contact?.blocked ? t("Unblock {address}", { address: contact.email }) : t("Block {address}", { address: contact?.email });
    $("toggleAlias").textContent = alias.enabled ? t("Turn off {alias}", { alias: alias.email }) : t("Turn on {alias}", { alias: alias.email });
  }
}

$("toggleContact").addEventListener("click", async () => {
  if ((await act("toggleContact", { contactId: origin.contact.id })) !== null) {
    await load();
  }
});
$("toggleAlias").addEventListener("click", async () => {
  if ((await act("toggleAlias", { id: origin.alias.id, email: origin.alias.email })) !== null) {
    await load();
  }
});
$("overview").addEventListener("click", async event => {
  event.preventDefault();
  await messenger.runtime.sendMessage({ type: "openOverview" });
  window.close();
});

await load();
