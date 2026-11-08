// End-to-end test in a real Thunderbird 153 with a scratch profile, driven by Marionette.
// A fake SMTP server records what Thunderbird actually sends, and a fake
// SimpleLogin API answers the add-on. By default it runs the disposable copy
// from `npm run setup:thunderbird`, never an installed Thunderbird.
//
// Usage: node test/e2e/run.mjs [path/to/thunderbird.exe]
// Env:   TB_BINARY, E2E_KEEP_PROFILE=1, E2E_SCREENSHOTS=<dir>

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { binaryFor } from "../../scripts/fetch-thunderbird.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const binary = process.argv[2] ?? process.env.TB_BINARY ?? binaryFor();
if (!fs.existsSync(binary)) {
  console.error(`Thunderbird not found at ${binary}. Run "npm run setup:thunderbird" first.`);
  process.exit(1);
}
const shots = process.env.E2E_SCREENSHOTS;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const MINE = "me@real.example";
// A second mailbox without traps, for the checks that send from a real address.
const PLAIN = "me2@real.example";
// A mailbox whose only identity has an OpenPGP key.
const KEYED = "keyed@real.example";

// ---- fake SMTP server ----------------------------------------------------------

const inbox = [];
const smtp = net.createServer(socket => {
  socket.setEncoding("utf8");
  let buffer = "";
  let mail = null;
  let inData = false;
  const reply = line => socket.write(`${line}\r\n`);
  reply("220 fake ESMTP");
  socket.on("data", chunk => {
    buffer += chunk;
    for (;;) {
      if (inData) {
        const end = buffer.indexOf("\r\n.\r\n");
        if (end < 0) {
          return;
        }
        mail.data = buffer.slice(0, end);
        buffer = buffer.slice(end + 5);
        inData = false;
        inbox.push(mail);
        reply("250 OK queued");
        continue;
      }
      const eol = buffer.indexOf("\r\n");
      if (eol < 0) {
        return;
      }
      const line = buffer.slice(0, eol);
      buffer = buffer.slice(eol + 2);
      const verb = line.slice(0, 4).toUpperCase();
      if (verb == "MAIL") {
        mail = { from: /<(.*?)>/.exec(line)[1], to: [] };
      } else if (verb == "RCPT") {
        mail.to.push(/<(.*?)>/.exec(line)[1]);
      } else if (verb == "DATA") {
        inData = true;
        reply("354 end with .");
        continue;
      } else if (verb == "QUIT") {
        reply("221 bye");
        socket.end();
        return;
      }
      reply("250 OK");
    }
  });
});

/** Header value of a recorded message, unfolded. */
function header(mail, name) {
  const head = mail.data.split("\r\n\r\n")[0].replace(/\r\n[ \t]+/g, " ");
  return new RegExp(`^${name}: (.*)$`, "mi").exec(head)?.[1] ?? null;
}

// ---- fake SimpleLogin API -------------------------------------------------------

const api = {
  down: false,
  forbid: false, // contact creation answers 403, as for a plan without reverse aliases
  posts: 0,
  aliases: [
    { id: 1, email: "shop@alias.example", mailboxes: [{ id: 1, email: MINE }] },
    { id: 2, email: "other@alias.example", mailboxes: [{ id: 1, email: MINE }] },
    { id: 3, email: "keyed@alias.example", mailboxes: [{ id: 3, email: KEYED }] },
  ],
  contacts: {
    1: [
      { id: 1, contact: "known@x.example", reverse_alias_address: "ra-known@sl.example" },
      { id: 3, contact: "known2@x.example", reverse_alias_address: "ra-known2@sl.example" },
    ],
    2: [{ id: 2, contact: "anna@y.example", reverse_alias_address: "ra-other@sl.example" }],
  },
};
let nextContact = 10;
const apiServer = http.createServer(async (req, res) => {
  const send = (status, body) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (api.down) {
    return send(503, { error: "maintenance" });
  }
  if (req.headers.authentication != "test-key") {
    return send(401, { error: "Wrong api key" });
  }
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
  }
  const body = raw ? JSON.parse(raw) : {};
  const url = new URL(req.url, "http://x");
  const page = Number(url.searchParams.get("page_id") ?? 0);
  const paged = list => list.slice(page * 20, page * 20 + 20);
  let m;
  if (req.method == "GET" && url.pathname == "/api/v2/mailboxes") {
    return send(200, {
      mailboxes: [
        { id: 1, email: MINE, default: true, verified: true },
        { id: 2, email: PLAIN, default: false, verified: true },
        { id: 3, email: KEYED, default: false, verified: true },
      ],
    });
  }
  if (req.method == "POST" && url.pathname == "/api/v2/aliases") {
    return send(200, { aliases: paged(api.aliases.filter(a => a.email.includes(body.query ?? ""))) });
  }
  if ((m = /^\/api\/aliases\/(\d+)\/contacts$/.exec(url.pathname))) {
    const list = (api.contacts[m[1]] ??= []);
    if (req.method == "GET") {
      return send(200, { contacts: paged(list) });
    }
    api.posts++;
    if (api.forbid) {
      return send(403, { error: "Please upgrade to create a reverse-alias" });
    }
    const email = body.contact.toLowerCase();
    if (Object.values(api.contacts).flat().some(c => c.reverse_alias_address == email)) {
      return send(400, { error: "You can't create contact for a reverse alias" });
    }
    const existing = list.find(c => c.contact == email);
    if (existing) {
      return send(200, { ...existing, existed: true });
    }
    const contact = { id: nextContact, contact: email, reverse_alias_address: `ra-${nextContact++}@sl.example` };
    list.push(contact);
    return send(201, { ...contact, existed: false });
  }
  send(404, { error: "not found" });
});

const listen = server => new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
const smtpPort = await listen(smtp);
const apiPort = await listen(apiServer);
const marionettePort = 2830;

// ---- profile ---------------------------------------------------------------

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "aliasbuddy-e2e-"));
const identity = (key, email, extra = {}) => ({
  [`mail.identity.${key}.useremail`]: email,
  [`mail.identity.${key}.fullName`]: "Tester",
  [`mail.identity.${key}.smtpServer`]: "smtp1",
  [`mail.identity.${key}.fcc`]: false,
  [`mail.identity.${key}.compose_html`]: true,
  ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [`mail.identity.${key}.${k}`, v])),
});
const prefs = {
  "marionette.port": marionettePort,
  "xpinstall.signatures.required": false,
  "extensions.experiments.enabled": true,
  "mail.shell.checkDefaultClient": false,
  "mail.provider.suppress_dialog_on_startup": true,
  "mail.spotlight.firstRunDone": true,
  "mail.winsearch.firstRunDone": true,
  "mailnews.start_page.enabled": false,
  "app.update.disabledForTesting": true,
  "datareporting.policy.dataSubmissionPolicyBypassNotification": true,
  "mailnews.sendInBackground": false,
  "mail.accountmanager.accounts": "account1",
  "mail.accountmanager.defaultaccount": "account1",
  "mail.accountmanager.localfoldersserver": "server1",
  "mail.account.account1.server": "server1",
  "mail.account.account1.identities": "id1,id2,id3,id4,id5,id6,id7,id8,id9",
  "mail.server.server1.type": "none",
  "mail.server.server1.hostname": "Local Folders",
  "mail.server.server1.userName": "nobody",
  "mail.server.server1.name": "Local Folders",
  "mail.server.server1.directory-rel": "[ProfD]Mail/Local Folders",
  "mail.smtpservers": "smtp1",
  "mail.smtp.defaultserver": "smtp1",
  "mail.smtpserver.smtp1.hostname": "127.0.0.1",
  "mail.smtpserver.smtp1.port": smtpPort,
  "mail.smtpserver.smtp1.authMethod": 1,
  "mail.smtpserver.smtp1.try_ssl": 0,
  // The mailbox identity carries every trap that switching to it could add.
  ...identity("id1", MINE, {
    htmlSigText: `Tester, ${MINE}`,
    reply_to: MINE,
    doCc: true,
    doCcList: "archive@real.example",
    attach_vcard: true,
  }),
  ...identity("id2", "shop@alias.example"),
  ...identity("id3", "work@other.example"),
  ...identity("id4", "fresh@alias.example"),
  ...identity("id5", PLAIN),
  ...identity("id6", PLAIN, { attach_vcard: true }),
  ...identity("id7", KEYED, { openpgp_key_id: "0123456789ABCDEF" }),
  ...identity("id8", "keyed@alias.example"),
  ...identity("id9", PLAIN, { doCc: true, doCcList: "archive2@x.example" }),
};
fs.writeFileSync(
  path.join(profile, "user.js"),
  Object.entries(prefs)
    .map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`)
    .join("\n")
);
fs.mkdirSync(path.join(profile, "Mail", "Local Folders"), { recursive: true });

// ---- marionette client -----------------------------------------------------

class Marionette {
  constructor(socket) {
    this.socket = socket;
    this.buffer = "";
    this.pending = new Map();
    this.nextId = 1;
    this.greeting = new Promise(resolve => (this.onGreeting = resolve));
    socket.setEncoding("utf8");
    socket.on("data", chunk => this.receive(chunk));
  }

  receive(chunk) {
    this.buffer += chunk;
    for (;;) {
      const colon = this.buffer.indexOf(":");
      if (colon < 0) {
        return;
      }
      const length = Number(this.buffer.slice(0, colon));
      const body = this.buffer.slice(colon + 1);
      if (Buffer.byteLength(body) < length) {
        return;
      }
      const bytes = Buffer.from(body);
      const packet = JSON.parse(bytes.subarray(0, length).toString());
      this.buffer = bytes.subarray(length).toString();
      if (!Array.isArray(packet)) {
        this.onGreeting(packet);
        continue;
      }
      const [, id, error, result] = packet;
      const { resolve, reject } = this.pending.get(id);
      this.pending.delete(id);
      error ? reject(new Error(`${error.error}: ${error.message}`)) : resolve(result);
    }
  }

  send(name, params = {}) {
    const id = this.nextId++;
    const json = JSON.stringify([0, id, name, params]);
    this.socket.write(`${Buffer.byteLength(json)}:${json}`);
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  async run(fn, ...args) {
    const script = `const [resolve, args] = [arguments[arguments.length - 1], [...arguments].slice(0, -1)];
      (${fn})(...args).then(value => resolve({ ok: true, value }), error => resolve({ ok: false, error: String(error) + "\\n" + error.stack }));`;
    const { value } = await this.send("WebDriver:ExecuteAsyncScript", { script, args, scriptTimeout: 120000 });
    if (!value.ok) {
      throw new Error(value.error);
    }
    return value.value;
  }
}

async function connect() {
  for (let i = 0; i < 120; i++) {
    try {
      const socket = await new Promise((resolve, reject) => {
        const s = net.connect(marionettePort, "127.0.0.1", () => resolve(s));
        s.on("error", reject);
      });
      const client = new Marionette(socket);
      await client.greeting;
      return client;
    } catch {
      await sleep(500);
    }
  }
  throw new Error("Marionette did not come up");
}

// ---- in-Thunderbird helpers (serialized into the chrome sandbox) ------------

const helpers = `
  const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  async function until(check, what, ms = 15000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      try { if (await check()) return; } catch {}
      await sleep(100);
    }
    throw new Error("Timed out: " + what);
  }
  const composeWindows = () => [...Services.wm.getEnumerator("msgcompose")];
  async function compose(key, { to = "", cc = "", body = "<p>Hello</p>", subject = "Test", from, attachment } = {}) {
    for (const w of composeWindows()) w.close();
    await until(() => !composeWindows().length, "old compose windows closed");
    const params = Cc["@mozilla.org/messengercompose/composeparams;1"].createInstance(Ci.nsIMsgComposeParams);
    const fields = Cc["@mozilla.org/messengercompose/composefields;1"].createInstance(Ci.nsIMsgCompFields);
    Object.assign(fields, { to, cc, subject, body });
    if (from) fields.from = from;
    if (attachment) {
      const a = Cc["@mozilla.org/messengercompose/attachment;1"].createInstance(Ci.nsIMsgAttachment);
      Object.assign(a, { url: PathUtils.toFileURI(attachment.path), name: attachment.name, contentType: attachment.type });
      fields.addAttachment(a);
    }
    params.composeFields = fields;
    params.identity = MailServices.accounts.getIdentity(key);
    params.type = Ci.nsIMsgCompType.New;
    params.format = Ci.nsIMsgCompFormat.HTML;
    MailServices.compose.OpenComposeWindowWithParams(null, params);
    await until(() => composeWindows()[0]?.composeEditorReady, "compose window ready", 30000);
    await sleep(500);
    return composeWindows()[0];
  }
  async function send(key, options) {
    const win = await compose(key, options);
    win.goDoCommand("cmd_sendNow");
    return win;
  }
  /**
   * Sends a calendar email through Thunderbird's own path (CalItipOutgoingMessage).
   * With \`invited\` the transport comes from X-MOZ-INVITED-ATTENDEE, as after
   * accepting an invitation; otherwise from the calendar identity \`identity\`.
   */
  function itip({ method = "REPLY", invited, identity, organizer, attendee, to }) {
    const mod = name => ChromeUtils.importESModule("resource:///modules/" + name + ".sys.mjs");
    const { CalEvent } = mod("CalEvent");
    const { CalAttendee } = mod("CalAttendee");
    const { CalItipOutgoingMessage } = mod("CalItipOutgoingMessage");
    const { CalItipEmailTransport } = mod("CalItipEmailTransport");
    const { cal } = mod("calendar/calUtils");
    const person = (email, status) => {
      const a = new CalAttendee();
      a.id = "mailto:" + email;
      if (status) a.participationStatus = status;
      return a;
    };
    const event = new CalEvent();
    event.id = "e2e-" + Math.random();
    event.title = "Meeting";
    event.startDate = cal.createDateTime("20261110T100000Z");
    event.endDate = cal.createDateTime("20261110T110000Z");
    const organizerAttendee = person(organizer);
    organizerAttendee.isOrganizer = true;
    event.organizer = organizerAttendee;
    const me = person(attendee, method == "REPLY" ? "ACCEPTED" : "NEEDS-ACTION");
    event.addAttendee(me);
    if (invited) event.setProperty("X-MOZ-INVITED-ATTENDEE", "mailto:" + invited);
    const transport = invited
      ? cal.itip.getImipTransport(event)
      : new CalItipEmailTransport(MailServices.accounts.getAccount("account1"), MailServices.accounts.getIdentity(identity));
    const sender = method == "REPLY" ? me : organizerAttendee;
    return new CalItipOutgoingMessage(method, to.map(e => person(e)), event, sender, { mode: Ci.calIItipItem.AUTO }).send(transport);
  }
  const state = win => ({
    open: !win.closed,
    identity: win.closed ? null : win.getCurrentIdentityKey(),
    to: win.closed ? null : win.gMsgCompose.compFields.to,
    reason: win.closed ? null : win.document.querySelector('[id$="-composeAction-toolbarbutton"]')?.getAttribute("tooltiptext"),
  });
`;

function chrome(body) {
  return `async function (...args) { ${helpers}\n${body} }`;
}

// ---- tests -------------------------------------------------------------------

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`ok   ${name}`);
  } catch (e) {
    results.push({ name, ok: false });
    console.log(`FAIL ${name}\n     ${e.message.split("\n").join("\n     ")}`);
  }
}
const expect = (actual, wanted, what) => {
  if (JSON.stringify(actual) != JSON.stringify(wanted)) {
    throw new Error(`${what}: ${JSON.stringify(actual)} != ${JSON.stringify(wanted)}`);
  }
};

/** Waits for the next message on the fake SMTP server, or null. */
async function nextMail(ms = 15000) {
  const start = inbox.length;
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (inbox.length > start) {
      return inbox[start];
    }
    await sleep(100);
  }
  return null;
}

/** Runs body inside the page shown in a browser element, as a frame script. */
function inPage(browserExpr, body) {
  const page = `async () => {
    const sleep = ms => new Promise(r => content.setTimeout(r, ms));
    async function until(check, what, ms = 15000) {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        try { if (await check()) return; } catch {}
        await sleep(100);
      }
      throw new Error("Timed out: " + what);
    }
    const doc = content.document;
    ${body}
  }`;
  return chrome(`
    const browser = ${browserExpr};
    const result = new Promise(resolve => {
      const listener = message => {
        browser.messageManager.removeMessageListener("aliasbuddy-test", listener);
        resolve(message.data);
      };
      browser.messageManager.addMessageListener("aliasbuddy-test", listener);
    });
    const script = "(" + args[0] + ")().then(v => sendAsyncMessage('aliasbuddy-test', { v: v ?? null }), e => sendAsyncMessage('aliasbuddy-test', { e: String(e) }))";
    browser.messageManager.loadFrameScript("data:," + encodeURIComponent(script), false);
    const answer = await Promise.race([result, sleep(60000).then(() => ({ e: "frame script did not report back" }))]);
    if (answer.e) throw new Error(answer.e);
    return answer.v;
  `).replace("args[0]", JSON.stringify(page));
}

/** Screenshot of the main window, or with `compose` of the newest window. */
async function screenshot(client, name, { compose = false } = {}) {
  if (!shots) {
    return;
  }
  fs.mkdirSync(shots, { recursive: true });
  const main = (await client.send("WebDriver:GetWindowHandle")).value;
  if (compose) {
    const result = await client.send("WebDriver:GetWindowHandles");
    const handles = result.value ?? result;
    await client.send("WebDriver:SwitchToWindow", { handle: handles.at(-1) });
  }
  const { value } = await client.send("WebDriver:TakeScreenshot", { full: false });
  fs.writeFileSync(path.join(shots, `${name}.png`), Buffer.from(value, "base64"));
  await client.send("WebDriver:SwitchToWindow", { handle: main });
}

const tb = spawn(binary, ["-profile", profile, "-no-remote", "-marionette", "-remote-allow-system-access"], {
  stdio: "ignore",
  env: { ...process.env, MOZ_CRASHREPORTER_DISABLE: "1" },
});
let client;
try {
  client = await connect();
  await client.send("WebDriver:NewSession", { capabilities: {} });
  await client.send("WebDriver:SetTimeouts", { script: 300000 });
  await client.send("Marionette:SetContext", { value: "chrome" });
  await client.send("WebDriver:SetWindowRect", { x: 0, y: 0, width: 1400, height: 900 });
  await client.run(chrome(`await until(() => window.document.getElementById("tabmail"), "main window", 60000);`));

  const installed = await client.send("Addon:Install", { path: path.join(root, "src"), temporary: true });
  const addon = installed.value ?? installed.addon ?? installed;
  console.log(`installed ${addon}`);
  // A test cannot click the permission prompt, so the local API origin is granted up front.
  await client.run(
    chrome(`
      const { ExtensionPermissions } = ChromeUtils.importESModule("resource://gre/modules/ExtensionPermissions.sys.mjs");
      const policy = WebExtensionPolicy.getByID(args[0]);
      await until(() => policy.extension, "extension started");
      await ExtensionPermissions.add(args[0], { permissions: [], origins: ["http://127.0.0.1/*"] }, policy.extension);
      const url = policy.getURL("options/options.html");
      window.document.getElementById("tabmail").openTab("contentTab", { url });
      await sleep(1500);
    `),
    addon
  );

  await check("settings page saves and tests the connection", async () => {
    const text = await client.run(
      inPage(
        `window.document.getElementById("tabmail").currentTabInfo.browser`,
        `
        await until(() => doc.getElementById("apiUrl").value, "settings loaded");
        doc.getElementById("apiUrl").value = "http://127.0.0.1:${apiPort}";
        doc.getElementById("apiKey").value = "test-key";
        doc.getElementById("allowlist").value = "@family.example";
        doc.getElementById("form").requestSubmit();
        await until(() => doc.getElementById("result").textContent.startsWith("Saved."), "saved");
        await until(() => !doc.getElementById("result").textContent.includes("Testing"), "tested");
        return doc.getElementById("result").textContent;
        `
      )
    );
    expect(text, `Saved. Connected, protected mailboxes: ${MINE}, ${PLAIN}, ${KEYED}`, "result");
  });
  await screenshot(client, "settings");

  await check("alias: recipients become reverse aliases, the mailbox sends, no trap leaks", async () => {
    const mail = nextMail();
    await client.run(chrome(`await send("id2", { to: "Peter <peter@x.example>", cc: "known@x.example" });`));
    const sent = await mail;
    if (!sent) throw new Error("nothing was sent");
    expect(sent.from, MINE, "envelope sender");
    expect(sent.to.sort(), ["ra-10@sl.example", "ra-known@sl.example"], "envelope recipients");
    expect(header(sent, "To"), "ra-10@sl.example", "To header");
    expect(header(sent, "Cc"), "ra-known@sl.example", "Cc header");
    expect(header(sent, "Reply-To"), null, "Reply-To header");
    const body = sent.data.split("\r\n\r\n").slice(1).join("\n");
    if (body.includes(MINE)) throw new Error("the mailbox signature reached the body");
    if (/text\/(x-)?vcard/i.test(sent.data)) throw new Error("a vCard was attached");
    expect(api.posts, 2, "contacts created or looked up");
  });

  await check("alias: a known contact needs no API call", async () => {
    const mail = nextMail();
    await client.run(chrome(`await send("id2", { to: "peter@x.example" });`));
    const sent = await mail;
    expect(sent?.to, ["ra-10@sl.example"], "envelope recipients");
    expect(api.posts, 2, "contact API calls");
  });

  await check("alias: replying to its own reverse alias keeps it", async () => {
    const mail = nextMail();
    await client.run(chrome(`await send("id2", { to: "ra-known@sl.example" });`));
    expect((await mail)?.to, ["ra-known@sl.example"], "envelope recipients");
  });

  await check("alias: a reverse alias of another alias is blocked", async () => {
    const mail = nextMail(4000);
    const after = await client.run(
      chrome(`const win = await send("id2", { to: "ra-other@sl.example" }); await sleep(3000); return state(win);`)
    );
    expect(await mail, null, "sent message");
    expect([after.open, after.identity, after.to], [true, "id2", "ra-other@sl.example"], "compose window unchanged");
    if (!/reverse alias/.test(after.reason)) throw new Error(`blocked for another reason: ${after.reason}`);
  });

  await check("alias: the real address in the text blocks the message", async () => {
    const mail = nextMail(4000);
    const after = await client.run(
      chrome(`const win = await send("id2", { to: "peter@x.example", body: "<p>Reach me at ${MINE}</p>" }); await sleep(3000); return state(win);`)
    );
    expect(await mail, null, "sent message");
    expect(after.open, true, "compose window open");
  });

  await check("mailbox: a normal recipient is blocked", async () => {
    const mail = nextMail(4000);
    const after = await client.run(
      chrome(`const win = await send("id5", { to: "peter@x.example" }); await sleep(3000); return state(win);`)
    );
    expect(await mail, null, "sent message");
    expect(after.open, true, "compose window open");
  });

  const popup = `[...Services.wm.getEnumerator("msgcompose")][0].document.querySelector(".webextension-popup-browser")`;
  // A popup is its own window that closes on focus loss, so its content is drawn directly.
  const popupShot = async name => {
    if (!shots) {
      return;
    }
    const url = await client.run(
      chrome(`
        const browser = ${popup};
        await sleep(800); // the popup resizes to its content first
        const bitmap = await browser.browsingContext.currentWindowGlobal.drawSnapshot(null, 1, "white");
        const canvas = window.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.getContext("2d").drawImage(bitmap, 0, 0);
        return canvas.toDataURL("image/png");
      `)
    );
    fs.writeFileSync(path.join(shots, `${name}.png`), Buffer.from(url.split(",")[1], "base64"));
  };
  await screenshot(client, "compose-blocked", { compose: true });
  await check("popup explains the block and sends once unchanged", async () => {
    const mail = nextMail();
    const text = await client.run(
      chrome(`
        const win = composeWindows()[0];
        const button = win.document.querySelector('[id$="-composeAction-toolbarbutton"]');
        if (!button) throw new Error("compose action button missing");
        button.click();
        await until(() => win.document.querySelector(".webextension-popup-browser"), "popup opened");
      `)
    ).then(() =>
      client.run(
        inPage(
          popup,
          `
          await until(() => !doc.getElementById("sendOnce").hidden, "send button shown");
          return doc.body.innerText;
          `
        )
      )
    );
    if (!text.includes("would be visible to peter@x.example")) throw new Error("popup text: " + text);
    await popupShot("popup-blocked");
    await client.run(inPage(popup, `doc.getElementById("sendOnce").click();`));
    const sent = await mail;
    expect(sent?.to, ["peter@x.example"], "sent unchanged");
    expect(sent?.from, PLAIN, "envelope sender");
  });

  await check("popup previews the reverse aliases of an alias", async () => {
    const posts = api.posts;
    await client.run(
      chrome(`
        const win = await compose("id2", { to: "peter@x.example", cc: "new@z.example" });
        win.document.querySelector('[id$="-composeAction-toolbarbutton"]').click();
        await until(() => win.document.querySelector(".webextension-popup-browser"), "popup opened");
      `)
    );
    const text = await client.run(
      inPage(popup, `await until(() => !doc.getElementById("rows").hidden, "rows shown"); return doc.body.innerText;`)
    );
    await popupShot("popup-alias");
    for (const part of ["Sending as shop@alias.example", "ra-10@sl.example", "new reverse alias on send"]) {
      if (!text.includes(part)) throw new Error("popup text: " + text);
    }
    expect(api.posts, posts, "the preview created no contact");
  });

  await check("mailbox: a known reverse alias passes unchanged", async () => {
    const mail = nextMail();
    await client.run(chrome(`await send("id5", { to: "ra-known@sl.example" });`));
    expect((await mail)?.to, ["ra-known@sl.example"], "envelope recipients");
  });

  await check("mailbox: mixing a reverse alias with an allowed address is blocked", async () => {
    const mail = nextMail(4000);
    await client.run(chrome(`await send("id5", { to: "ra-known@sl.example", cc: "mom@family.example" }); await sleep(3000);`));
    expect(await mail, null, "sent message");
  });

  await check("other identity: not a SimpleLogin address, sent unchanged", async () => {
    const mail = nextMail();
    await client.run(chrome(`await send("id3", { to: "bob@x.example" });`));
    expect((await mail)?.from, "work@other.example", "envelope sender");
  });

  /** Sends with the given script and expects nothing on the wire and the window still open. */
  const expectBlocked = async (script, reason) => {
    const mail = nextMail(4000);
    const after = await client.run(chrome(`const win = ${script}; await sleep(3000); return state(win);`));
    expect(await mail, null, "sent message");
    expect(after.open, true, "compose window open");
    if (!reason.test(after.reason ?? "")) throw new Error(`blocked for another reason: ${after.reason}`);
  };

  await check("mailbox: a vCard on the way through SimpleLogin is blocked", () =>
    expectBlocked(`await send("id6", { to: "ra-known@sl.example" })`, /vCard/)
  );

  await check("mailbox: reply all that keeps the alias in Cc passes", async () => {
    const mail = nextMail();
    await client.run(chrome(`await send("id5", { to: "ra-known@sl.example", cc: "shop@alias.example" });`));
    expect((await mail)?.to?.sort(), ["ra-known@sl.example", "shop@alias.example"], "envelope recipients");
  });

  await check("alias: an existing contact is found when creating contacts is not allowed", async () => {
    api.forbid = true;
    const mail = nextMail();
    await client.run(chrome(`await send("id2", { to: "known2@x.example" });`));
    api.forbid = false;
    expect((await mail)?.to, ["ra-known2@sl.example"], "envelope recipients");
  });

  await check("alias: a mailbox identity with an OpenPGP key is not used", () =>
    expectBlocked(`await send("id8", { to: "peter@x.example" })`, /OpenPGP key or S\/MIME/)
  );

  const eml = path.join(profile, "forwarded.eml");
  fs.writeFileSync(eml, `Delivered-To: ${MINE}\r\nFrom: shop@x.example\r\nSubject: Order\r\n\r\nThanks.\r\n`);
  await check("alias: a forwarded message that names the real address is blocked", () =>
    expectBlocked(
      `await send("id2", { to: "peter@x.example", attachment: { path: ${JSON.stringify(eml)}, name: "Order.eml", type: "message/rfc822" } })`,
      /an attachment contains me@real.example/
    )
  );

  await check("alias: an embedded image is blocked", () =>
    expectBlocked(`await send("id2", { to: "peter@x.example", body: '<p>Hi</p><img src="data:image/png;base64,iVBORw0KGgo=">' })`, /embedded images/)
  );

  await check("other identity: a customized From with the real address is blocked", () =>
    expectBlocked(`await send("id3", { to: "bob@x.example", from: "Tester <${PLAIN}>" })`, /me2@real.example would be visible to bob/)
  );

  const calendarSend = options => client.run(chrome(`return itip(${JSON.stringify(options)});`));
  const reverseOf = email => Object.values(api.contacts[1]).find(c => c.contact == email)?.reverse_alias_address;
  /** The delivered message must not name a real address anywhere but in the From header, which SimpleLogin replaces. */
  const expectClean = sent => {
    const rest = sent.data.replace(/^From: .*$/m, "");
    for (const address of [MINE, PLAIN]) {
      if (rest.includes(address)) throw new Error(`${address} in the delivered message`);
    }
  };

  await check("calendar: accepting an invitation to an alias answers through SimpleLogin", async () => {
    const mail = nextMail();
    await calendarSend({ invited: "shop@alias.example", attendee: "shop@alias.example", organizer: "org@x.example", to: ["org@x.example"] });
    const sent = await mail;
    if (!sent) throw new Error("nothing was sent");
    expect(sent.from, MINE, "envelope sender");
    expect(sent.to, [reverseOf("org@x.example")], "only the organizer's reverse alias, no automatic Cc");
    if (!/ATTENDEE[^\r\n]*shop@alias\.example/i.test(sent.data)) throw new Error("calendar part lost the alias attendee");
    expectClean(sent);
    const id1 = await client.run(chrome(`const i = MailServices.accounts.getIdentity("id1"); return [i.doCc, i.replyTo];`));
    expect(id1, [true, MINE], "mailbox identity settings restored");
  });

  await check("calendar: an invitation organized as an alias goes through SimpleLogin", async () => {
    const mail = nextMail();
    await calendarSend({ method: "REQUEST", identity: "id5", organizer: "shop@alias.example", attendee: "bob2@x.example", to: ["bob2@x.example"] });
    const sent = await mail;
    expect([sent?.from, sent?.to], [MINE, [reverseOf("bob2@x.example")]], "envelope");
    expectClean(sent);
  });

  await check("calendar: a reply from the real mailbox to the organizer is dropped", async () => {
    const mail = nextMail(4000);
    await calendarSend({ invited: PLAIN, attendee: PLAIN, organizer: "org@x.example", to: ["org@x.example"] });
    expect(await mail, null, "sent message");
  });

  await check("calendar: an allowed organizer gets the reply from the real mailbox", async () => {
    const mail = nextMail();
    await calendarSend({ invited: PLAIN, attendee: PLAIN, organizer: "mom@family.example", to: ["mom@family.example"] });
    expect((await mail)?.to, ["mom@family.example"], "envelope recipients");
  });

  await check("calendar: the identity's automatic Cc is checked too", async () => {
    const mail = nextMail(4000);
    await calendarSend({ identity: "id9", attendee: PLAIN, organizer: "mom@family.example", to: ["mom@family.example"] });
    expect(await mail, null, "sent message");
  });

  await check("calendar: other identities send unchanged", async () => {
    const mail = nextMail();
    await calendarSend({ invited: "work@other.example", attendee: "work@other.example", organizer: "bob@x.example", to: ["bob@x.example"] });
    const sent = await mail;
    expect([sent?.from, sent?.to], ["work@other.example", ["bob@x.example"]], "envelope");
  });

  await check("API down: an unknown identity is blocked", async () => {
    api.down = true;
    const mail = nextMail(4000);
    await client.run(chrome(`await send("id4", { to: "bob@x.example" }); await sleep(3000);`));
    api.down = false;
    expect(await mail, null, "sent message");
  });

  if (results.some(r => !r.ok)) {
    const log = await client.run(
      chrome(`
        return Services.console.getMessageArray()
          .map(m => m.message ?? String(m))
          .filter(t => !t.startsWith("[JavaScript Warning") && !t.includes("CSS"))
          .slice(-25);
      `)
    );
    console.log(["console:", ...log].join("\n  "));
  }
} catch (e) {
  console.log(`FAIL harness\n     ${e.stack}`);
  results.push({ name: "harness", ok: false });
} finally {
  try {
    await client?.send("Marionette:Quit", { flags: ["eForceQuit"] });
  } catch {}
  setTimeout(() => tb.kill(), 3000).unref();
  await new Promise(r => tb.once("exit", r));
  smtp.close();
  apiServer.close();
  if (!process.env.E2E_KEEP_PROFILE) {
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  } else {
    console.log(`profile kept at ${profile}`);
  }
}

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
