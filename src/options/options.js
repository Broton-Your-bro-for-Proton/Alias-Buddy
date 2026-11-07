import { SimpleLogin } from "../lib/api.js";
import { getSettings } from "../lib/settings.js";

const $ = id => document.getElementById(id);
const lines = text => text.split("\n").map(l => l.trim()).filter(Boolean);

const settings = await getSettings();
$("apiUrl").value = settings.apiUrl;
$("apiKey").value = settings.apiKey;
$("protected").value = settings.protected.join("\n");
$("allowlist").value = settings.allowlist.join("\n");

$("form").addEventListener("submit", async event => {
  event.preventDefault();
  const next = {
    apiUrl: $("apiUrl").value.trim().replace(/\/+$/, ""),
    apiKey: $("apiKey").value.trim(),
    protected: lines($("protected").value),
    allowlist: lines($("allowlist").value),
  };
  const url = new URL(next.apiUrl);
  const origins = [`${url.protocol}//${url.hostname}/*`]; // match patterns have no port
  // request() needs the click, so it comes before any other await.
  let granted;
  try {
    granted = await messenger.permissions.request({ origins });
  } catch {
    granted = await messenger.permissions.contains({ origins });
  }
  if (!granted) {
    $("result").textContent = `Not saved: access to ${next.apiUrl} was not granted.`;
    return;
  }
  await messenger.storage.local.set({ settings: next, cache: {} });
  $("result").textContent = "Saved. Testing...";
  try {
    const mailboxes = await new SimpleLogin(next.apiUrl, next.apiKey).mailboxes();
    $("result").textContent = `Saved. Connected, protected mailboxes: ${mailboxes.map(m => m.email).join(", ")}`;
  } catch (e) {
    $("result").textContent = `Saved, but the test failed: ${e.message}`;
  }
});
