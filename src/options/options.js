import { SimpleLogin } from "../lib/api.js";
import { creationDomains, prefixFrom, templateProblem, templatesOf } from "../lib/core.js";
import { getSettings } from "../lib/settings.js";

const $ = id => document.getElementById(id);
const lines = text => text.split("\n").map(l => l.trim()).filter(Boolean);
const FLAGS = ["perDomain", "autoSwitch", "replyFromAlias", "autoIdentity"];

const settings = await getSettings();
$("apiUrl").value = settings.apiUrl;
$("apiKey").value = settings.apiKey;
$("protected").value = settings.protected.join("\n");
$("allowlist").value = settings.allowlist.join("\n");
$("templates").value = settings.creation.templates.join("\n");
for (const flag of FLAGS) {
  $(flag).checked = settings.creation[flag];
}

const showExample = () =>
  ($("example").textContent = templatesOf({ templates: lines($("templates").value) })
    .map(t => prefixFrom(t, "amazon.de"))
    .join(", "));
$("templates").addEventListener("input", showExample);
showExample();

function fill(select, items, chosen) {
  select.length = 1; // keep the "default" entry
  for (const { value, label } of items) {
    select.add(new Option(label, value, false, String(value) == String(chosen ?? "")));
  }
}

/** Loads the domains and mailboxes the account offers for new aliases. */
async function loadCreationChoices(current) {
  if (!current.apiKey) {
    return;
  }
  const sl = new SimpleLogin(current.apiUrl, current.apiKey);
  try {
    const [suffixes, mailboxes] = await Promise.all([sl.suffixes(), sl.mailboxes()]);
    const domains = creationDomains(suffixes).map(d => ({
      value: d.domain,
      label: `${d.domain} (${d.custom ? "your domain" : "SimpleLogin, adds a random word"})`,
    }));
    fill($("domain"), domains, current.creation.domain);
    fill($("mailboxId"), mailboxes.filter(m => m.verified !== false).map(m => ({ value: m.id, label: m.email })), current.creation.mailboxId);
    $("creationState").textContent = `${domains.length} domains and ${mailboxes.length} mailboxes available.`;
  } catch (e) {
    $("creationState").textContent = `Could not load the domains: ${e.message}`;
  }
}
loadCreationChoices(settings);

$("form").addEventListener("submit", async event => {
  event.preventDefault();
  const templates = templatesOf({ templates: lines($("templates").value) });
  const problem = templates.map(templateProblem).find(Boolean);
  if (problem) {
    $("result").textContent = `Not saved: ${problem}.`;
    return;
  }
  const next = {
    apiUrl: $("apiUrl").value.trim().replace(/\/+$/, ""),
    apiKey: $("apiKey").value.trim(),
    protected: lines($("protected").value),
    allowlist: lines($("allowlist").value),
    creation: {
      domain: $("domain").length > 1 ? $("domain").value : settings.creation.domain,
      mailboxId: $("mailboxId").length > 1 ? Number($("mailboxId").value) || null : settings.creation.mailboxId,
      templates,
      template: templates[0], // read by older versions
      ...Object.fromEntries(FLAGS.map(flag => [flag, $(flag).checked])),
    },
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
  // Saving also refreshes what the add-on knows, for example a mailbox added in SimpleLogin.
  await messenger.storage.local.set({ settings: next, cache: {} });
  Object.assign(settings, next);
  $("result").textContent = "Saved. Testing...";
  try {
    const mailboxes = await new SimpleLogin(next.apiUrl, next.apiKey).mailboxes();
    $("result").textContent = `Saved. Connected, protected mailboxes: ${mailboxes.map(m => m.email).join(", ")}`;
    await loadCreationChoices(next);
  } catch (e) {
    $("result").textContent = `Saved, but the test failed: ${e.message}`;
  }
});
