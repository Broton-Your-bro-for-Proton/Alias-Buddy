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
    $("error").textContent = answer?.error ?? "No answer from the add-on.";
    $("error").hidden = false;
    return null;
  }
  return answer.value ?? true;
}

const SUMMARY = {
  none: () => "Open a single message to see the alias it came through.",
  direct: () => "This message did not come through a SimpleLogin alias.",
  unconfirmed: o =>
    `This message names your alias ${o.named}, but its sender is not a contact of that alias, so it did not come through SimpleLogin.`,
  alias: o =>
    `Came through your alias ${o.alias.email}${o.alias.enabled ? "" : " (turned off)"} from ${o.contact?.email ?? o.sender}${o.contact?.blocked ? " (blocked)" : ""}.`,
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
    $("toggleContact").textContent = contact?.blocked ? `Unblock ${contact.email}` : `Block ${contact?.email}`;
    $("toggleAlias").textContent = alias.enabled ? `Turn off ${alias.email}` : `Turn on ${alias.email}`;
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
