const $ = id => document.getElementById(id);
const [tab] = await messenger.tabs.query({ active: true, currentWindow: true });

const SUMMARY = {
  unconfigured: () => "Not set up yet. Add your SimpleLogin API key in the settings.",
  other: p => `${p.sender} is not a SimpleLogin address. The add-on leaves this message alone.`,
  mailbox: p => `Sending from your real address ${p.sender}.`,
  alias: p => `Sending as ${p.sender}. SimpleLogin receives it from ${p.mailbox}.`,
  blocked: p => `This message would be blocked: ${p.reason}`,
};

function render({ preview, last }) {
  $("summary").textContent = SUMMARY[preview.state](preview);
  $("summary").className = { alias: "state-ok", blocked: "state-blocked" }[preview.state] ?? "";
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
  $("sendOnce").hidden = !(preview.state == "blocked" && preview.overridable);
}

render(await messenger.runtime.sendMessage({ type: "preview", tabId: tab.id }));

$("sendOnce").addEventListener("click", async () => {
  await messenger.runtime.sendMessage({ type: "sendOnce", tabId: tab.id });
  window.close();
});
$("options").addEventListener("click", event => {
  event.preventDefault();
  messenger.runtime.openOptionsPage();
});
