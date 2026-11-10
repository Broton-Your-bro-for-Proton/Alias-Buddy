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
  searches: [], // alias search queries, to see which addresses reached SimpleLogin
  created: [], // aliases created through the API
  createDelay: 0, // milliseconds alias creation takes
  createStarted: 0, // creation requests received
  aliases: [
    { id: 1, email: "shop@alias.example", mailboxes: [{ id: 1, email: MINE }, { id: 2, email: PLAIN }] },
    { id: 2, email: "other@alias.example", mailboxes: [{ id: 1, email: MINE }, { id: 2, email: PLAIN }] },
    { id: 3, email: "keyed@alias.example", mailboxes: [{ id: 3, email: KEYED }] },
    // An alias on an own domain that has no Thunderbird identity yet.
    { id: 4, email: "promo@mine.example", mailboxes: [{ id: 1, email: MINE }, { id: 2, email: PLAIN }] },
    // Created by hand in the user's own scheme, without an Alias Buddy note.
    { id: 5, email: "shop.otto@mine.example", mailboxes: [{ id: 1, email: MINE }] },
    // Only for the overview: deleted there.
    { id: 6, email: "old.trash@mine.example", mailboxes: [{ id: 1, email: MINE }], note: "to delete", nb_forward: 3 },
    // Deleted in the overview while the user has an identity of their own for it.
    { id: 7, email: "gone@mine.example", mailboxes: [{ id: 1, email: MINE }] },
    // The user's own news category alias for heise.
    { id: 8, email: "news.heise@mine.example", mailboxes: [{ id: 1, email: MINE }] },
    // Only on the second mailbox, so a typed From on that mailbox's identity keeps the identity.
    { id: 9, email: "plain@mine.example", mailboxes: [{ id: 2, email: PLAIN }] },
  ],
  contacts: {
    1: [
      { id: 1, contact: "known@x.example", reverse_alias_address: "ra-known@sl.example" },
      { id: 3, contact: "known2@x.example", reverse_alias_address: "ra-known2@sl.example" },
      { id: 4, contact: "anna3@y.example", reverse_alias_address: "ra-anna3@sl.example" },
    ],
    2: [
      { id: 2, contact: "anna@y.example", reverse_alias_address: "ra-other@sl.example" },
      { id: 5, contact: "bea@y.example", reverse_alias_address: "ra-bea@sl.example" },
      // Exists after the user wrote to the alias from a mailbox.
      { id: 7, contact: PLAIN, reverse_alias_address: "ra-me2@sl.example" },
    ],
    4: [{ id: 6, contact: "dan@d.example", reverse_alias_address: "ra-dan@sl.example" }],
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
    api.searches.push(body.query);
    const query = body.query ?? "";
    const flag = ["enabled", "disabled", "pinned"].find(f => url.searchParams.has(f));
    const keep = a =>
      (a.email.includes(query) || (a.note ?? "").includes(query)) &&
      (!flag || (flag == "pinned" ? a.pinned : flag == "disabled" ? a.enabled === false : a.enabled !== false));
    return send(200, { aliases: paged(api.aliases.filter(keep)) });
  }
  if ((m = /^\/api\/aliases\/(\d+)(\/toggle)?$/.exec(url.pathname))) {
    const alias = api.aliases.find(a => a.id == m[1]);
    if (!alias) {
      return send(404, { error: "not found" });
    }
    if (m[2]) {
      alias.enabled = alias.enabled === false;
      return send(200, { enabled: alias.enabled });
    }
    if (req.method == "PATCH") {
      Object.assign(alias, body);
      return send(200, {});
    }
    if (req.method == "DELETE") {
      api.aliases.splice(api.aliases.indexOf(alias), 1);
      return send(200, { deleted: true });
    }
  }
  if ((m = /^\/api\/contacts\/(\d+)(\/toggle)?$/.exec(url.pathname))) {
    const [id, list] = Object.entries(api.contacts).find(([, l]) => l.some(c => c.id == m[1])) ?? [];
    const contact = list?.find(c => c.id == m[1]);
    if (!contact) {
      return send(404, { error: "not found" });
    }
    if (m[2]) {
      contact.block_forward = !contact.block_forward;
      return send(200, { block_forward: contact.block_forward });
    }
    list.splice(list.indexOf(contact), 1);
    return send(200, { deleted: true, alias: id });
  }
  if (req.method == "GET" && url.pathname == "/api/v5/alias/options") {
    return send(200, {
      can_create: true,
      suffixes: [".cat@aleeas.example", "@me.aleeas.example", "@mine.example"].map(suffix => ({
        suffix,
        signed_suffix: suffix + ".sig",
        is_custom: suffix.startsWith("@"),
        is_premium: false,
      })),
    });
  }
  if (req.method == "POST" && url.pathname == "/api/v3/alias/custom/new") {
    api.createStarted++;
    await sleep(api.createDelay);
    if (!body.signed_suffix?.endsWith(".sig")) {
      return send(400, { error: "invalid suffix" });
    }
    const email = body.alias_prefix + body.signed_suffix.slice(0, -4);
    if (api.aliases.some(a => a.email == email)) {
      return send(409, { error: email + " already exists" });
    }
    const all = [MINE, PLAIN, KEYED];
    const alias = { id: api.aliases.length + 10, email, note: body.note, mailboxes: body.mailbox_ids.map(id => ({ id, email: all[id - 1] })) };
    api.aliases.push(alias);
    api.created.push(alias);
    return send(201, alias);
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
  "mail.account.account1.identities": "id1,id2,id3,id4,id5,id6,id7,id8,id9,id10,id12,id13",
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
  ...identity("id10", "other@alias.example", { doCc: true, doCcList: MINE }),
  ...identity("id12", "gone@mine.example"),
  // On the user's own domain, but never created as an alias.
  ...identity("id13", "nobody@mine.example"),
};
fs.writeFileSync(
  path.join(profile, "user.js"),
  Object.entries(prefs)
    .map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`)
    .join("\n")
);
fs.mkdirSync(path.join(profile, "Mail", "Local Folders"), { recursive: true });
// A message whose Message-ID carries the mailbox domain, as Thunderbird writes it for the user's own messages.
fs.writeFileSync(
  path.join(profile, "Mail", "Local Folders", "Inbox"),
  [
    "From - Mon Jan 05 10:00:00 2026",
    "Message-ID: <own-1@real.example>",
    "Date: Mon, 05 Jan 2026 10:00:00 +0000",
    "From: Peter <peter@x.example>",
    "To: shop@alias.example",
    "Subject: Question",
    "",
    "Hello.",
    "",
    "",
    "From - Mon Jan 05 11:00:00 2026",
    "Message-ID: <sl-1@y.example>",
    "Date: Mon, 05 Jan 2026 11:00:00 +0000",
    "From: Bea <ra-bea@sl.example>",
    "To: other@alias.example",
    "Cc: Carol <ra-carol@sl.example>",
    "X-SimpleLogin-Envelope-To: other@alias.example",
    "Subject: Forwarded by SimpleLogin",
    "",
    "Hi.",
    "",
    "",
    "From - Mon Jan 05 12:00:00 2026",
    "Message-ID: <forged-1@evil.example>",
    "Date: Mon, 05 Jan 2026 12:00:00 +0000",
    "From: attacker@evil.example",
    "To: me2@real.example",
    "X-SimpleLogin-Envelope-To: shop@alias.example",
    "Subject: Pretends to come through SimpleLogin",
    "",
    "Hi.",
    "",
    "",
    "From - Mon Jan 05 13:00:00 2026",
    "Message-ID: <sl-2@d.example>",
    "Date: Mon, 05 Jan 2026 13:00:00 +0000",
    "From: Dan <ra-dan@sl.example>",
    "To: promo@mine.example",
    "X-SimpleLogin-Envelope-To: promo@mine.example",
    "Subject: Through an alias without an identity",
    "",
    "Hi.",
    "",
    "",
    // A reverse alias of shop@alias.example in a message that names another alias.
    "From - Mon Jan 05 14:00:00 2026",
    "Message-ID: <cross-1@x.example>",
    "Date: Mon, 05 Jan 2026 14:00:00 +0000",
    "From: Known <ra-known@sl.example>",
    "To: other@alias.example",
    "X-SimpleLogin-Envelope-To: other@alias.example",
    "Subject: Names the wrong alias",
    "",
    "Hi.",
    "",
    "",
    "From - Mon Jan 05 15:00:00 2026",
    "Message-ID: <noat-1@evil.example>",
    "Date: Mon, 05 Jan 2026 15:00:00 +0000",
    "From: attacker@evil.example",
    "To: me2@real.example",
    "X-SimpleLogin-Envelope-To: e",
    "Subject: Names no address",
    "",
    "Hi.",
    "",
    "",
    "From - Mon Jan 05 16:00:00 2026",
    "Message-ID: <nocache-1@z.example>",
    "Date: Mon, 05 Jan 2026 16:00:00 +0000",
    "From: Zed <ra-zed@sl.example>",
    "To: fresh.zed@alias.example",
    "X-SimpleLogin-Envelope-To: fresh.zed@alias.example",
    "Subject: Shown while SimpleLogin is down",
    "",
    "Hi.",
    "",
    "",
    // The user's own test mail to the alias, forwarded back by SimpleLogin.
    "From - Mon Jan 05 17:00:00 2026",
    "Message-ID: <self-1@real.example>",
    "Date: Mon, 05 Jan 2026 17:00:00 +0000",
    "From: Tester <ra-me2@sl.example>",
    "To: other@alias.example",
    "X-SimpleLogin-Envelope-To: other@alias.example",
    "Subject: Test to my alias",
    "",
    "Hi.",
    "",
    "",
  ].join("\n")
);

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
  async function compose(key, { to = "", cc = "", replyTo = "", body = "<p>Hello</p>", subject = "Test", from, attachment } = {}) {
    for (const w of composeWindows()) w.close();
    await until(() => !composeWindows().length, "old compose windows closed");
    const params = Cc["@mozilla.org/messengercompose/composeparams;1"].createInstance(Ci.nsIMsgComposeParams);
    const fields = Cc["@mozilla.org/messengercompose/composefields;1"].createInstance(Ci.nsIMsgCompFields);
    Object.assign(fields, { to, cc, replyTo, subject, body });
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
    const win = composeWindows()[0];
    if (from) {
      // As "Customize From Address" in the sender menu, then typing.
      win.MakeFromFieldEditable(true);
      win.document.getElementById("msgIdentity").value = from;
    }
    return win;
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
  /** Opens a reply to an Inbox message from the identity \`key\` and sends it. */
  async function reply(messageId, key) {
    const inbox = MailServices.accounts.getAccount("account1").incomingServer.rootFolder.getChildNamed("Inbox");
    let parsed = false;
    try {
      inbox.QueryInterface(Ci.nsIMsgLocalMailFolder).getDatabaseWithReparse({ QueryInterface: ChromeUtils.generateQI(["nsIUrlListener"]), OnStartRunningUrl() {}, OnStopRunningUrl() { parsed = true; } }, null);
      parsed = true;
    } catch {}
    await until(() => parsed || inbox.msgDatabase?.getMsgHdrForMessageID(messageId), "inbox parsed");
    const hdr = inbox.msgDatabase.getMsgHdrForMessageID(messageId);
    for (const w of composeWindows()) w.close();
    await until(() => !composeWindows().length, "old compose windows closed");
    MailServices.compose.OpenComposeWindow(null, hdr, inbox.getUriForMsg(hdr), Ci.nsIMsgCompType.Reply, Ci.nsIMsgCompFormat.Default, MailServices.accounts.getIdentity(key), null, null);
    await until(() => composeWindows()[0]?.composeEditorReady, "reply window ready", 30000);
    await sleep(500);
    const win = composeWindows()[0];
    if (win.getCurrentIdentityKey() != key) {
      const menu = win.document.getElementById("msgIdentity");
      menu.selectedItem = [...menu.menupopup.children].find(i => i.getAttribute("identitykey") == key);
      win.LoadIdentity(false);
    }
    win.goDoCommand("cmd_sendNow");
    return win;
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

  await check("alias: a reverse alias of your own address is blocked while the alias's contacts are still unknown", async () => {
    // Both belong to other@alias.example, whose contacts the add-on learns only while it sends.
    const mail = nextMail(4000);
    const after = await client.run(
      chrome(`const win = await send("id5", { from: "other@alias.example", to: "ra-bea@sl.example", cc: "ra-me2@sl.example" }); await sleep(3000); return state(win);`)
    );
    expect(await mail, null, "sent message");
    if (!/ra-me2@sl\.example is the reverse alias of your own address/.test(after.reason ?? "")) throw new Error(`blocked for another reason: ${after.reason}`);
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
  const popupShot = async (name, browserExpr = popup) => {
    if (!shots) {
      return;
    }
    const url = await client.run(
      chrome(`
        const browser = ${browserExpr};
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

  await check("other identity: an address on your own domain that is not an alias is blocked", () =>
    expectBlocked(`await send("id13", { to: "bob@x.example" })`, /nobody@mine\.example is on your SimpleLogin domain but is not an alias/)
  );

  await check("mailbox: sending an unknown reverse alias once accepts only that and still blocks the vCard", async () => {
    await expectBlocked(`await send("id6", { to: "ra-unknown@sl.example" })`, /ra-unknown@sl\.example looks like a reverse alias/);
    const mail = nextMail(5000);
    await client.run(
      chrome(`
        const win = composeWindows()[0];
        win.document.querySelector('[id$="-composeAction-toolbarbutton"]').click();
        await until(() => win.document.querySelector(".webextension-popup-browser"), "popup opened");
      `)
    );
    await client.run(inPage(popup, `await until(() => !doc.getElementById("sendOnce").hidden, "send button shown"); doc.getElementById("sendOnce").click();`));
    const after = await client.run(chrome(`await sleep(3000); return state(composeWindows()[0]);`));
    expect(await mail, null, "sent message");
    if (!/vCard/.test(after.reason ?? "")) throw new Error(`blocked for another reason: ${after.reason}`);
  });

  await check("mailbox: a second reason after sending once is shown and can be sent once on its own", async () => {
    await expectBlocked(`await send("id5", { to: "ra-unknown2@sl.example", body: "<p>Reach me at ${PLAIN}</p>" })`, /ra-unknown2@sl\.example looks like a reverse alias/);
    const sendOnce = async () => {
      await client.run(
        chrome(`
          const win = composeWindows()[0];
          win.document.querySelector('[id$="-composeAction-toolbarbutton"]').click();
          await until(() => win.document.querySelector(".webextension-popup-browser"), "popup opened");
        `)
      );
      return client.run(
        inPage(
          popup,
          `await until(() => !doc.body.dataset.used && !doc.getElementById("sendOnce").hidden, "fresh popup with the send button");
          doc.body.dataset.used = "1"; // a popup document left over from the first decision is not read again
          const text = doc.getElementById("summary").textContent;
          doc.getElementById("sendOnce").click();
          return text;`
        )
      );
    };
    const first = nextMail(5000);
    await sendOnce();
    const after = await client.run(chrome(`await sleep(3000); return state(composeWindows()[0]);`));
    expect(await first, null, "sent after the first decision");
    if (!/text contains me2@real\.example/.test(after.reason ?? "")) throw new Error(`blocked for another reason: ${after.reason}`);
    const second = nextMail();
    const shown = await sendOnce();
    if (!/text contains me2@real\.example/.test(shown)) throw new Error("popup showed: " + shown);
    expect((await second)?.to, ["ra-unknown2@sl.example"], "sent after the second decision");
  });

  const big = path.join(profile, "big.txt");
  fs.writeFileSync(big, "x".repeat(11 * 1024 * 1024));
  await check("alias: an attachment too large to check does not hide the other findings", () =>
    expectBlocked(
      `await send("id2", { to: "peter@x.example", body: "<p>Reach me at ${MINE}</p>", attachment: { path: ${JSON.stringify(big)}, name: "big.txt", type: "text/plain" } })`,
      /the text contains me@real\.example.*the attachment big\.txt cannot be checked/
    )
  );

  const utf16 = path.join(profile, "contacts.txt");
  fs.writeFileSync(utf16, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`Contact: ${MINE}\r\n`, "utf16le")]));
  await check("alias: a UTF-16 text attachment that names the real address is blocked", () =>
    expectBlocked(
      `await send("id2", { to: "peter@x.example", attachment: { path: ${JSON.stringify(utf16)}, name: "contacts.txt", type: "text/plain" } })`,
      /an attachment contains me@real\.example/
    )
  );

  await check("alias: a file Thunderbird embeds from a link is blocked", () =>
    expectBlocked(`await send("id2", { to: "peter@x.example", body: '<p><a href="data:text/plain;base64,SGk=">note</a></p>' })`, /embedded images or files/)
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

  await check("typed From: an existing alias sends through SimpleLogin like its identity", async () => {
    const mail = nextMail();
    await client.run(chrome(`await send("id5", { to: "eve@e.example", from: "Tester <promo@mine.example>" });`));
    const sent = await mail;
    if (!sent) throw new Error("nothing was sent");
    expect(sent.from, MINE, "envelope sender: the alias's mailbox");
    expect(sent.to.length == 1 && sent.to[0].startsWith("ra-"), true, "envelope recipient is a reverse alias, no automatic Cc");
    expect(header(sent, "To"), sent.to[0], "To header");
    expect((header(sent, "From") ?? "").includes(MINE), true, "From header names the mailbox, which SimpleLogin replaces");
    expect(header(sent, "Reply-To"), null, "Reply-To header");
  });

  await check("typed From: a new name on your own domain creates exactly that alias", async () => {
    const mail = nextMail();
    await client.run(chrome(`await send("id5", { to: "eve@e.example", from: "privat.eve@mine.example" });`));
    const sent = await mail;
    if (!sent) throw new Error("nothing was sent");
    expect(api.created.at(-1)?.email, "privat.eve@mine.example", "created alias");
    expect(sent.to.length == 1 && sent.to[0].startsWith("ra-"), true, "envelope recipient is a reverse alias");
  });

  await check("typed From: a new name is not created for a message that is blocked", async () => {
    const created = api.created.length;
    await expectBlocked(`await send("id5", { to: "eve@e.example", from: "privat.tim@mine.example", body: "<p>Reach me at ${MINE}</p>" })`, /contains me@real.example/);
    expect(api.created.length, created, "aliases created");
  });

  await check("typed From: on the mailbox identity itself the From header still becomes the mailbox", async () => {
    const mail = nextMail();
    await client.run(chrome(`await send("id5", { to: "eve@e.example", from: "plain@mine.example" });`));
    const sent = await mail;
    if (!sent) throw new Error("nothing was sent");
    expect(sent.from, PLAIN, "envelope sender");
    expect(sent.to.length == 1 && sent.to[0].startsWith("ra-"), true, "envelope recipient is a reverse alias, no automatic Cc");
    expect(header(sent, "From"), `Tester <${PLAIN}>`, "From header names the mailbox, which SimpleLogin replaces");
  });

  await check("typed From: an address on a domain that is not yours stays guarded", () =>
    expectBlocked(`await send("id5", { to: "bob@x.example", from: "someone@foreign.example" })`, /me2@real.example would be visible to bob/)
  );

  await check("typed From: blocked while SimpleLogin cannot tell whether it is an alias", async () => {
    api.down = true;
    try {
      await expectBlocked(`await send("id3", { to: "bob@x.example", from: "never.seen@mine.example" })`, /cannot tell whether never\.seen@mine\.example is an alias/);
    } finally {
      api.down = false;
    }
  });

  await check("typed From: a Reply-To with the real address blocks before the alias is created", async () => {
    const created = api.created.length;
    await expectBlocked(`await send("id5", { to: "eve@e.example", from: "privat.rt@mine.example", replyTo: "${PLAIN}" })`, /Reply-To contains me2@real\.example/);
    expect(api.created.length, created, "aliases created");
  });

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
    expect(sent.from, PLAIN, "envelope sender: the mailbox identity without automatic Cc/Bcc and Reply-To");
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
    expect([sent?.from, sent?.to], [PLAIN, [reverseOf("bob2@x.example")]], "envelope");
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

  await check("calendar: an alias invitation that names the real address is blocked", async () => {
    const mail = nextMail(4000);
    await calendarSend({ method: "REQUEST", identity: "id5", organizer: "shop@alias.example", attendee: MINE, to: ["bob3@x.example"] });
    expect(await mail, null, "sent message");
  });

  await check("alias: the identity's automatic Cc to the real mailbox is blocked", () =>
    expectBlocked(`await send("id10", { to: "peter@x.example" })`, /me@real\.example is a recipient of a message sent as other@alias\.example/)
  );

  await check("mailbox: Bcc next to a reverse alias is not a mix", async () => {
    const mail = nextMail();
    await client.run(chrome(`const win = await compose("id5", { to: "ra-known@sl.example" }); win.gMsgCompose.compFields.bcc = "mom@family.example"; win.awAddRecipients(win.gMsgCompose.compFields, "addr_bcc", "mom@family.example"); win.goDoCommand("cmd_sendNow");`));
    expect((await mail)?.to?.sort(), ["mom@family.example", "ra-known@sl.example"], "envelope recipients");
  });

  await check("alias: a reply that refers to a Message-ID with the mailbox domain is blocked", async () => {
    const mail = nextMail(4000);
    const after = await client.run(chrome(`const win = await reply("own-1@real.example", "id2"); await sleep(3000); return state(win);`));
    expect(await mail, null, "sent message");
    if (!/message whose ID ends in your mailbox domain/.test(after.reason ?? "")) throw new Error(`blocked for another reason: ${after.reason}`);
  });

  await check("mailbox: a reverse alias of an alias the mailbox does not own is blocked", () =>
    expectBlocked(`await send("id7", { to: "ra-known@sl.example" })`, /keyed@real\.example is not a mailbox of shop@alias\.example/)
  );

  await check("mailbox: a reply to a message SimpleLogin forwarded finds its reverse alias", async () => {
    const mail = nextMail();
    await client.run(chrome(`await reply("sl-1@y.example", "id5");`));
    expect((await mail)?.to, ["ra-bea@sl.example"], "envelope recipients");
    if (api.searches.includes("ra-carol@sl.example")) throw new Error("other recipients of the original were sent to the alias search");
  });

  await check("mailbox: a faked SimpleLogin header does not make a direct sender safe", async () => {
    const mail = nextMail(4000);
    const after = await client.run(chrome(`const win = await reply("forged-1@evil.example", "id5"); await sleep(3000); return state(win);`));
    expect(await mail, null, "sent message");
    if (!/would be visible to attacker@evil\.example/.test(after.reason ?? "")) throw new Error(`blocked for another reason: ${after.reason}`);
  });

  await check("alias: a mailing list with a description is expanded", async () => {
    const mail = nextMail();
    await client.run(
      chrome(`
        const book = MailServices.ab.getDirectory("jsaddrbook://abook.sqlite");
        const list = Cc["@mozilla.org/addressbook/directoryproperty;1"].createInstance(Ci.nsIAbDirectory);
        list.isMailList = true;
        list.dirName = "Team";
        list.listNickName = "team";
        list.description = "Team members";
        const added = book.addMailList(list);
        const card = Cc["@mozilla.org/addressbook/cardproperty;1"].createInstance(Ci.nsIAbCard);
        card.primaryEmail = "ml1@x.example";
        card.displayName = "List Member";
        added.addCard(card);
        await send("id2", { to: "Team <Team members>" });
      `)
    );
    expect((await mail)?.to, [reverseOf("ml1@x.example")], "the member's reverse alias");
  });

  await check("calendar: other identities send unchanged", async () => {
    const mail = nextMail();
    await calendarSend({ invited: "work@other.example", attendee: "work@other.example", organizer: "bob@x.example", to: ["bob@x.example"] });
    const sent = await mail;
    expect([sent?.from, sent?.to], ["work@other.example", ["bob@x.example"]], "envelope");
  });

  // ---- alias configurator (autoSwitch is turned on here, so it runs after the blocking checks)

  const identitiesFor = email =>
    client.run(chrome(`return MailServices.accounts.allIdentities.filter(i => i.email == ${JSON.stringify(email)}).map(i => [i.key, i.label]);`));
  const openPopup = () =>
    client.run(
      chrome(`
        const win = composeWindows()[0];
        win.document.querySelector('[id$="-composeAction-toolbarbutton"]').click();
        await until(() => win.document.querySelector(".webextension-popup-browser"), "popup opened");
      `)
    );
  const composeIdentity = () => client.run(chrome(`return composeWindows()[0].getCurrentIdentityKey();`));

  await check("settings: alias creation lists own domains, subdomains and SimpleLogin domains and saves the choices", async () => {
    await client.run(
      chrome(`
        const url = WebExtensionPolicy.getByID(args[0]).getURL("options/options.html");
        window.document.getElementById("tabmail").openTab("contentTab", { url });
        await sleep(1500);
      `),
      addon
    );
    const labels = await client.run(
      inPage(
        `window.document.getElementById("tabmail").currentTabInfo.browser`,
        `
        await until(() => doc.getElementById("domain").length > 1, "domains loaded");
        const labels = [...doc.getElementById("domain").options].slice(1).map(o => o.textContent);
        doc.getElementById("domain").value = "mine.example";
        doc.getElementById("autoSwitch").checked = true;
        doc.getElementById("form").requestSubmit();
        await until(() => doc.getElementById("result").textContent.startsWith("Saved. Connected"), "saved");
        doc.getElementById("domain").closest("section").scrollIntoView();
        return labels;
        `
      )
    );
    expect(
      labels,
      ["me.aleeas.example (your domain)", "mine.example (your domain)", "aleeas.example (SimpleLogin, adds a random word)"],
      "domain choices"
    );
  });
  await screenshot(client, "settings-creation");

  await check("popup: a new alias for the recipient's site is created, gets an identity and sends the message", async () => {
    const created = api.created.length;
    await client.run(chrome(`await compose("id5", { to: "news@shop.example" });`));
    await openPopup();
    const text = await client.run(
      inPage(popup, `await until(() => !doc.getElementById("suggestion").hidden, "suggestion shown"); return doc.getElementById("suggestionText").textContent + " " + doc.getElementById("useSuggestion").textContent;`)
    );
    if (!/No alias for shop\.example yet/.test(text) || !/shop\.[a-z0-9]{5}@mine\.example/.test(text)) throw new Error("suggestion: " + text);
    const names = await client.run(
      inPage(popup, `return [doc.getElementById("summary").textContent, doc.getElementById("useSuggestion").textContent, doc.getElementById("prefix").value].map(t => /shop\.[a-z0-9]{5}/.exec(t)?.[0]);`)
    );
    if (new Set(names).size != 1) throw new Error("the popup shows different planned names: " + names.join(", "));
    await popupShot("popup-configurator");
    // Switching the sender may close the popup, so the result is checked in the compose window.
    await client.run(inPage(popup, `doc.getElementById("useSuggestion").click();`));
    await client.run(
      chrome(`await until(() => /^shop\.[a-z0-9]{5}@mine\.example$/.test(MailServices.accounts.getIdentity(composeWindows()[0].getCurrentIdentityKey()).email), "switched to the new alias");`)
    );
    const alias = api.created[created];
    expect([api.created.length - created, alias?.note, alias?.mailboxes.map(m => m.email)], [1, "Alias Buddy: shop.example ({domain}.{random})", [MINE]], "created alias");
    expect((await identitiesFor(alias.email)).map(i => i[1]), ["Alias Buddy"], "identity created");
    const mail = nextMail();
    await client.run(chrome(`composeWindows()[0].goDoCommand("cmd_sendNow");`));
    const sent = await mail;
    const contact = (api.contacts[alias.id] ?? []).find(c => c.contact == "news@shop.example");
    expect([sent?.from, sent?.to], [MINE, [contact?.reverse_alias_address]], "sent as the new alias");
  });

  await check("popup: an existing alias is found by search and used", async () => {
    const before = (await identitiesFor("shop@alias.example")).length;
    await client.run(chrome(`await compose("id5", { to: "x@other.example" });`));
    await openPopup();
    await client.run(
      inPage(
        popup,
        `
        await until(() => !doc.getElementById("aliasPanel").hidden, "panel shown");
        const search = doc.getElementById("search");
        search.value = "shop@alias";
        search.dispatchEvent(new content.Event("input"));
        await until(() => doc.querySelector("#results button"), "results");
        doc.querySelector("#results button").click();
        `
      )
    );
    await client.run(chrome(`await until(() => composeWindows()[0].getCurrentIdentityKey() == "id2", "switched to the alias");`));
    expect([await composeIdentity(), (await identitiesFor("shop@alias.example")).length], ["id2", before], "existing identity used, none added");
  });

  await check("automatic: from the real mailbox to the same site, the message goes out as that site's alias", async () => {
    const created = api.created.length;
    const mail = nextMail();
    await client.run(chrome(`await send("id5", { to: "info@shop.example" });`));
    const sent = await mail;
    const alias = api.aliases.find(a => a.note == "Alias Buddy: shop.example ({domain}.{random})");
    const contact = Object.values(api.contacts[alias.id] ?? {}).find(c => c.contact == "info@shop.example");
    expect([sent?.from, sent?.to, api.created.length - created], [MINE, [contact?.reverse_alias_address], 0], "reused alias");
  });

  await check("automatic: a reply goes out as the alias the message came through, its identity is created", async () => {
    const mail = nextMail();
    const key = await client.run(
      chrome(`
        const inbox = MailServices.accounts.getAccount("account1").incomingServer.rootFolder.getChildNamed("Inbox");
        await until(() => inbox.msgDatabase?.getMsgHdrForMessageID("sl-2@d.example"), "message parsed");
        const hdr = inbox.msgDatabase.getMsgHdrForMessageID("sl-2@d.example");
        for (const w of composeWindows()) w.close();
        await until(() => !composeWindows().length, "old compose windows closed");
        MailServices.compose.OpenComposeWindow(null, hdr, inbox.getUriForMsg(hdr), Ci.nsIMsgCompType.Reply, Ci.nsIMsgCompFormat.Default, MailServices.accounts.getIdentity("id5"), null, null);
        await until(() => composeWindows()[0]?.composeEditorReady, "reply window ready", 30000);
        const win = composeWindows()[0];
        await until(() => MailServices.accounts.getIdentity(win.getCurrentIdentityKey()).email == "promo@mine.example", "sender switched to the alias");
        win.goDoCommand("cmd_sendNow");
        return win.getCurrentIdentityKey();
      `)
    );
    const sent = await mail;
    expect([sent?.from, sent?.to], [MINE, ["ra-dan@sl.example"]], "sent through SimpleLogin");
    expect((await identitiesFor("promo@mine.example")).map(i => i[0]), [key], "one identity created");
  });

  await check("automatic: a forward goes out as the alias the message came through", async () => {
    const mail = nextMail();
    await client.run(
      chrome(`
        const inbox = MailServices.accounts.getAccount("account1").incomingServer.rootFolder.getChildNamed("Inbox");
        const hdr = inbox.msgDatabase.getMsgHdrForMessageID("sl-2@d.example");
        for (const w of composeWindows()) w.close();
        await until(() => !composeWindows().length, "old compose windows closed");
        MailServices.compose.OpenComposeWindow(null, hdr, inbox.getUriForMsg(hdr), Ci.nsIMsgCompType.ForwardInline, Ci.nsIMsgCompFormat.Default, MailServices.accounts.getIdentity("id5"), null, null);
        await until(() => composeWindows()[0]?.composeEditorReady, "forward window ready", 30000);
        const win = composeWindows()[0];
        await until(() => MailServices.accounts.getIdentity(win.getCurrentIdentityKey()).email == "promo@mine.example", "sender switched to the alias");
        win.SetComposeDetails({ to: "friend@z.example" });
        await sleep(300);
        win.goDoCommand("cmd_sendNow");
      `)
    );
    const sent = await mail;
    const contact = (api.contacts[4] ?? []).find(c => c.contact == "friend@z.example");
    expect([sent?.from, sent?.to], [MINE, [contact?.reverse_alias_address]], "forwarded through SimpleLogin");
  });

  await check("automatic: a switch that would be blocked creates no alias", async () => {
    const created = api.created.length;
    await expectBlocked(
      `await send("id5", { to: "z@newsite.example", body: '<p>Hi</p><img src="data:image/png;base64,iVBORw0KGgo=">' })`,
      /Sending as the alias for newsite\.example failed: .*embedded images/
    );
    expect(api.created.length, created, "aliases created");
  });

  await check("automatic: a recipient of a new site gets a new alias on send", async () => {
    const created = api.created.length;
    const mail = nextMail();
    await client.run(chrome(`await send("id5", { to: "hello@fresh.example" });`));
    const sent = await mail;
    const alias = api.created[created];
    const contact = (api.contacts[alias?.id] ?? []).find(c => c.contact == "hello@fresh.example");
    expect([api.created.length - created, alias?.note, sent?.to], [1, "Alias Buddy: fresh.example ({domain}.{random})", [contact?.reverse_alias_address]], "new site alias");
  });

  await check("automatic: recipients of two sites are blocked, not switched", async () => {
    const created = api.created.length;
    await expectBlocked(`await send("id5", { to: "a@one.example", cc: "b@two.example" })`, /would be visible to a@one\.example, b@two\.example/);
    expect(api.created.length, created, "aliases created");
  });

  await check("popup: a planned switch is shown, sending from the real address stays possible", async () => {
    const created = api.created.length;
    await client.run(chrome(`await compose("id5", { to: "q@another.example" });`));
    await openPopup();
    const [summary, button] = await client.run(
      inPage(
        popup,
        `await until(() => !doc.getElementById("sendOnce").hidden, "button shown"); return [doc.getElementById("summary").textContent, doc.getElementById("sendOnce").textContent];`
      )
    );
    if (!/would show your real address\. On send it switches to the alias another\.[a-z0-9]{5}@mine\.example \(new\)/.test(summary)) throw new Error("summary: " + summary);
    expect([button, api.created.length - created], ["Send from my real address instead", 0], "button and nothing created");
  });

  await check("a send while a popup action is still running is not checked against the old state", async () => {
    api.createDelay = 3000;
    const started = api.createStarted;
    await client.run(chrome(`await compose("id3", { to: "r@race.example" });`));
    await openPopup();
    await client.run(inPage(popup, `await until(() => !doc.getElementById("aliasPanel").hidden, "panel"); doc.getElementById("create").click();`));
    for (let i = 0; i < 50 && api.createStarted == started; i++) await sleep(100);
    const mail = nextMail(6000);
    const after = await client.run(chrome(`const win = composeWindows()[0]; win.goDoCommand("cmd_sendNow"); await sleep(5000); return state(win);`));
    api.createDelay = 0;
    expect(await mail, null, "sent message");
    if (!/changed while it was checked/.test(after.reason ?? "")) throw new Error(`blocked for another reason: ${after.reason}`);
  });

  await check("automatic: a faked SimpleLogin header does not change the reply's sender", async () => {
    const key = await client.run(
      chrome(`
        const inbox = MailServices.accounts.getAccount("account1").incomingServer.rootFolder.getChildNamed("Inbox");
        const hdr = inbox.msgDatabase.getMsgHdrForMessageID("forged-1@evil.example");
        for (const w of composeWindows()) w.close();
        await until(() => !composeWindows().length, "old compose windows closed");
        MailServices.compose.OpenComposeWindow(null, hdr, inbox.getUriForMsg(hdr), Ci.nsIMsgCompType.Reply, Ci.nsIMsgCompFormat.Default, MailServices.accounts.getIdentity("id5"), null, null);
        await until(() => composeWindows()[0]?.composeEditorReady, "reply window ready", 30000);
        await sleep(3000);
        return composeWindows()[0].getCurrentIdentityKey();
      `)
    );
    expect(key, "id5", "sender unchanged");
  });

  await check("a template without random parts finds the alias the user created by hand", async () => {
    await client.run(
      chrome(`
        const url = WebExtensionPolicy.getByID(args[0]).getURL("options/options.html");
        window.document.getElementById("tabmail").openTab("contentTab", { url });
        await sleep(1500);
      `),
      addon
    );
    await client.run(
      inPage(
        `window.document.getElementById("tabmail").currentTabInfo.browser`,
        `
        await until(() => doc.getElementById("domain").length > 1, "domains loaded");
        doc.getElementById("templates").value = "shop.{domain}\\nnews.{domain}\\npromo.{random}";
        doc.getElementById("form").requestSubmit();
        await until(() => doc.getElementById("result").textContent.startsWith("Saved. Connected"), "saved");
        `
      )
    );
    const created = api.created.length;
    const mail = nextMail();
    await client.run(chrome(`await send("id5", { to: "info@otto.example" });`));
    const sent = await mail;
    const contact = (api.contacts[5] ?? []).find(c => c.contact == "info@otto.example");
    expect([sent?.to, api.created.length - created], [[contact?.reverse_alias_address], 0], "sent as shop.otto, nothing created");
  });

  await check("popup: another template finds the user's own alias of that category", async () => {
    const created = api.created.length;
    await client.run(chrome(`await compose("id5", { to: "x@heise.example" });`));
    await openPopup();
    const [before, after] = await client.run(
      inPage(
        popup,
        `
        await until(() => !doc.getElementById("templateRow").hidden, "templates offered");
        const suggestion = () => doc.getElementById("useSuggestion").textContent;
        const before = suggestion();
        const select = doc.getElementById("template");
        select.value = "news.{domain}";
        select.dispatchEvent(new content.Event("change"));
        await until(() => suggestion() != before, "suggestion for the news template");
        return [before, suggestion() + " / " + doc.getElementById("prefix").value];
        `
      )
    );
    await popupShot("popup-templates");
    expect([before, after], ["Create and use shop.heise@mine.example", "Use news.heise@mine.example / news.heise"], "suggestions per template");
    await client.run(inPage(popup, `doc.getElementById("useSuggestion").click();`));
    await client.run(
      chrome(`await until(() => MailServices.accounts.getIdentity(composeWindows()[0].getCurrentIdentityKey()).email == "news.heise@mine.example", "switched to the news alias");`)
    );
    expect(api.created.length - created, 0, "nothing created");
  });

  await check("popup: the chosen template also decides the switch on send", async () => {
    const created = api.created.length;
    await client.run(chrome(`await compose("id5", { to: "y@heise.example" });`));
    await openPopup();
    const summary = await client.run(
      inPage(
        popup,
        `
        await until(() => !doc.getElementById("templateRow").hidden, "templates offered");
        const select = doc.getElementById("template");
        select.value = "news.{domain}";
        select.dispatchEvent(new content.Event("change"));
        await until(() => /news\\.heise/.test(doc.getElementById("summary").textContent), "summary follows the template");
        return doc.getElementById("summary").textContent;
        `
      )
    );
    expect(
      summary,
      `Sending from ${PLAIN} would show your real address. On send it switches to the alias news.heise@mine.example, from the template news.{domain}.`,
      "summary"
    );
    const mail = nextMail();
    await client.run(chrome(`composeWindows()[0].goDoCommand("cmd_sendNow");`));
    const sent = await mail;
    const contact = (api.contacts[8] ?? []).find(c => c.contact == "y@heise.example");
    expect([sent?.to, api.created.length - created], [[contact?.reverse_alias_address], 0], "sent as news.heise");
  });

  await check("popup: recipients of several sites offer a choice of the site", async () => {
    const reverse = api.contacts[8].find(c => c.contact == "y@heise.example").reverse_alias_address;
    await client.run(chrome(`await compose("id5", { to: ${JSON.stringify(`${MINE}, a@first.example, ${reverse}`)} });`));
    await openPopup();
    const [sites, before, after] = await client.run(
      inPage(
        popup,
        `
        await until(() => !doc.getElementById("siteRow").hidden, "sites offered");
        const suggestion = () => doc.getElementById("useSuggestion").textContent;
        const sites = [...doc.getElementById("site").options].map(o => o.value);
        const before = suggestion();
        const select = doc.getElementById("site");
        select.value = "heise.example";
        select.dispatchEvent(new content.Event("change"));
        await until(() => suggestion() != before, "suggestion for the other site");
        return [sites, before, suggestion() + " / " + doc.getElementById("prefix").value];
        `
      )
    );
    await popupShot("popup-sites");
    expect(
      [sites, before, after],
      [["first.example", "heise.example"], "Create and use shop.first@mine.example", "Create and use shop.heise@mine.example / shop.heise"],
      "sites and suggestions"
    );
  });

  await check("popup: an alias of a template with random parts is found again for its site", async () => {
    const suggestionFor = async to => {
      await client.run(chrome(`await compose("id5", { to: ${JSON.stringify(to)} });`));
      await openPopup();
      return client.run(
        inPage(
          popup,
          `
          await until(() => !doc.getElementById("templateRow").hidden, "templates offered");
          const select = doc.getElementById("template");
          const before = doc.getElementById("useSuggestion").textContent;
          select.value = "promo.{random}";
          select.dispatchEvent(new content.Event("change"));
          await until(() => doc.getElementById("useSuggestion").textContent != before, "promo suggestion");
          return doc.getElementById("useSuggestion").textContent;
          `
        )
      );
    };
    const created = api.created.length;
    const first = await suggestionFor("y@tiedsite.example");
    if (!/^Create and use promo\.[a-z0-9]{5}@mine\.example$/.test(first)) throw new Error("first: " + first);
    await client.run(inPage(popup, `doc.getElementById("useSuggestion").click();`));
    await client.run(chrome(`await until(() => /^promo\./.test(MailServices.accounts.getIdentity(composeWindows()[0].getCurrentIdentityKey()).email), "switched");`));
    const alias = api.created[created];
    expect(alias?.note, "Alias Buddy: tiedsite.example (promo.{random})", "note names site and template");
    const second = await suggestionFor("z@tiedsite.example");
    expect([second, api.created.length - created], [`Use ${alias.email}`, 1], "found again, nothing more created");
  });

  // ---- received messages

  /** Opens an Inbox message in a tab and returns the add-on's button state once it settled. */
  const showMessage = (messageId, label) =>
    client.run(
      chrome(`
        const inbox = MailServices.accounts.getAccount("account1").incomingServer.rootFolder.getChildNamed("Inbox");
        await until(() => inbox.msgDatabase?.getMsgHdrForMessageID(args[0]), "message parsed");
        const hdr = inbox.msgDatabase.getMsgHdrForMessageID(args[0]);
        const tabmail = window.document.getElementById("tabmail");
        tabmail.openTab("mailMessageTab", { messageURI: inbox.getUriForMsg(hdr), background: false });
        const button = () => tabmail.currentTabInfo.chromeBrowser?.contentDocument?.querySelector('[id$="-messageDisplayAction-toolbarbutton"]');
        await until(() => button()?.getAttribute("label") == args[1], "button labeled " + args[1]);
        await sleep(300); // the label is set before the button is enabled or disabled
        return { label: button().getAttribute("label"), disabled: button().disabled };
      `),
      messageId,
      label
    );
  const messagePopup = `(window.document.querySelector(".webextension-popup-browser") ?? window.document.getElementById("tabmail").currentTabInfo.chromeBrowser.contentDocument.querySelector(".webextension-popup-browser"))`;

  await check("message: the button names the alias, blocks the sender and turns the alias off and on", async () => {
    expect(await showMessage("sl-1@y.example", "other@alias.example"), { label: "other@alias.example", disabled: false }, "button");
    await screenshot(client, "message-tab");
    await client.run(
      chrome(`
        window.document.getElementById("tabmail").currentTabInfo.chromeBrowser.contentDocument.querySelector('[id$="-messageDisplayAction-toolbarbutton"]').click();
        await until(() => ${messagePopup}, "popup opened");
      `)
    );
    const summary = () => `doc.getElementById("summary").textContent`;
    const click = (id, wanted) => `doc.getElementById("${id}").click(); await until(() => ${summary()}.includes(${JSON.stringify(wanted)}), ${JSON.stringify(wanted)});`;
    const first = await client.run(
      inPage(messagePopup, `await until(() => ${summary()}.startsWith("Came through"), "origin shown"); return ${summary()};`)
    );
    expect(first, "Came through your alias other@alias.example from bea@y.example.", "summary");
    await client.run(inPage(messagePopup, click("toggleContact", "(blocked)")));
    const bea = api.contacts[2].find(c => c.contact == "bea@y.example");
    const other = api.aliases.find(a => a.email == "other@alias.example");
    expect(bea.block_forward, true, "contact blocked in SimpleLogin");
    await client.run(inPage(messagePopup, click("toggleAlias", "(turned off)")));
    expect(other.enabled, false, "alias turned off in SimpleLogin");
    await popupShot("message-popup", messagePopup);
    const buttons = await client.run(
      inPage(messagePopup, `return [doc.getElementById("toggleContact").textContent, doc.getElementById("toggleAlias").textContent];`)
    );
    expect(buttons, ["Unblock bea@y.example", "Turn on other@alias.example"], "buttons offer the way back");
    await client.run(inPage(messagePopup, `${click("toggleContact", "@y.example.")} ${click("toggleAlias", "other@alias.example from")}`));
    expect([bea.block_forward, other.enabled], [false, true], "unblocked and on again");
  });

  await check("message: a faked SimpleLogin header is not confirmed, a direct message has no alias", async () => {
    expect(await showMessage("forged-1@evil.example", "Unconfirmed alias"), { label: "Unconfirmed alias", disabled: false }, "forged");
    expect(await showMessage("own-1@real.example", "No alias"), { label: "No alias", disabled: true }, "direct");
    // The sender is a reverse alias, but of shop@alias.example, not of the alias the header names.
    expect(await showMessage("cross-1@x.example", "Unconfirmed alias"), { label: "Unconfirmed alias", disabled: false }, "other alias's contact");
    const searches = api.searches.length;
    expect(await showMessage("noat-1@evil.example", "Unconfirmed alias"), { label: "Unconfirmed alias", disabled: false }, "no address");
    expect(api.searches.length - searches, 0, "searches for a header without an address");
  });

  await check("message: when SimpleLogin is down, the popup says so instead of calling the message unconfirmed", async () => {
    api.down = true;
    try {
      expect(await showMessage("nocache-1@z.example", "Alias"), { label: "Alias", disabled: false }, "button");
      await client.run(
        chrome(`
          window.document.getElementById("tabmail").currentTabInfo.chromeBrowser.contentDocument.querySelector('[id$="-messageDisplayAction-toolbarbutton"]').click();
          await until(() => ${messagePopup}, "popup opened");
        `)
      );
      const shown = await client.run(
        inPage(messagePopup, `await until(() => !doc.getElementById("error").hidden, "error shown"); return [doc.getElementById("summary").textContent, doc.getElementById("error").textContent];`)
      );
      expect(shown, ["Checking...", "SimpleLogin: maintenance. The add-on cannot tell whether fresh.zed@alias.example is an alias."], "popup");
    } finally {
      api.down = false;
    }
    await client.run(
      chrome(`
        const tabmail = window.document.getElementById("tabmail");
        for (const info of [...tabmail.tabInfo]) if (info.mode.name == "mailMessageTab") tabmail.closeTab(info);
      `)
    );
  });

  await check("address book: reverse aliases of sends and received messages are named after contact and alias", async () => {
    const cardOf = email =>
      client.run(
        chrome(`
          const find = () => MailServices.ab.directories.find(d => d.dirName == "Alias Buddy")?.childCards.find(c => c.primaryEmail == args[0]);
          await until(find, "card of " + args[0]);
          return find().displayName;
        `),
        email
      );
    // Shown in the message checks above.
    expect(await cardOf("ra-bea@sl.example"), "[other@alias.example] bea@y.example", "received message");
    // Confirmed, but its contact is the user's own mailbox: it must get no card.
    expect((await showMessage("self-1@real.example", "other@alias.example")).label, "other@alias.example", "own test mail confirmed");
    const mail = nextMail();
    await client.run(chrome(`await send("id2", { to: "carl@c.example" });`));
    const sent = await mail;
    const carl = api.contacts[1].find(c => c.contact == "carl@c.example").reverse_alias_address;
    // Cards are written one after another, so the own address would have come before this one.
    expect([sent?.to, await cardOf(carl)], [[carl], "[shop@alias.example] carl@c.example"], "alias send");
    const cards = await client.run(
      chrome(`return MailServices.ab.directories.find(d => d.dirName == "Alias Buddy").childCards.map(c => c.displayName + " " + c.primaryEmail);`)
    );
    expect(cards.filter(n => /real\.example|ra-me2/.test(n)), [], "cards that name a real address");
    await showMessage("sl-1@y.example", "other@alias.example");
    await screenshot(client, "message-named");
    await client.run(
      chrome(`
        const tabmail = window.document.getElementById("tabmail");
        for (const info of [...tabmail.tabInfo]) if (info.mode.name == "mailMessageTab") tabmail.closeTab(info);
      `)
    );
  });

  await check("a reverse alias of your own address next to another recipient is blocked", async () => {
    // Both belong to other@alias.example, whose mailbox sends: without the check it would go out.
    await expectBlocked(`await send("id5", { to: "ra-bea@sl.example", cc: "ra-me2@sl.example" })`, /ra-me2@sl\.example is the reverse alias of your own address/);
  });

  // ---- alias overview

  const overview = `window.document.getElementById("tabmail").currentTabInfo.browser`;
  const rowOf = email =>
    `[...doc.querySelectorAll("#aliases > tbody > tr:not(.contacts)")].find(r => r.querySelector(".address")?.textContent == ${JSON.stringify(email)})`;
  const buttonOf = (email, label) => `[...${rowOf(email)}.querySelectorAll("button")].find(b => b.textContent == ${JSON.stringify(label)})`;
  const listed = `await until(() => doc.getElementById("state").textContent.endsWith("shown."), "listed");`;
  const showAll = `
    doc.getElementById("search").value = "";
    const filter = doc.getElementById("filter");
    filter.value = "";
    filter.dispatchEvent(new content.Event("change"));
    ${listed}`;

  await check("overview: the toolbar button opens the list of all aliases", async () => {
    await client.run(
      chrome(`
        // Thunderbird's unified toolbar holds extension buttons as items named ext-<add-on id>.
        const selector = '#unifiedToolbarContent [item-id="ext-' + args[0] + '"]';
        // The button shows in the mail space, as a user would see it.
        window.document.getElementById("tabmail").switchToTab(0);
        await until(() => window.document.querySelector(selector)?.checkVisibility(), "toolbar button visible");
        const item = window.document.querySelector(selector);
        (item.querySelector("button") ?? item).click();
        await until(() => window.document.getElementById("tabmail").currentTabInfo.browser?.currentURI?.spec.endsWith("overview/overview.html"), "overview opened");
      `),
      addon
    );
    const emails = await client.run(inPage(overview, `${listed} return [...doc.querySelectorAll("#aliases .address")].map(e => e.textContent);`));
    for (const email of ["shop@alias.example", "promo@mine.example", "old.trash@mine.example"]) {
      if (!emails.includes(email)) throw new Error(`${email} missing in ${emails.join(", ")}`);
    }
  });
  await screenshot(client, "overview");
  if (shots) {
    // A long address stays on one line; Tidy up sits below the list.
    await client.run(inPage(overview, `${listed} doc.querySelector("#aliases .address").textContent = "newsletter.very-long-shop-name.k7f2x@subdomain.mine.example";`));
    await screenshot(client, "overview-long");
    await client.run(inPage(overview, `doc.querySelector("main > .panel:last-child").scrollIntoView(); await sleep(300);`));
    await screenshot(client, "overview-tidy");
    await client.run(inPage(overview, `doc.documentElement.scrollTop = 0; doc.querySelector("#aliases .address").textContent = "shop@alias.example";`));
  }

  await check("overview: search, disable, note, pin and unpin change the alias in SimpleLogin", async () => {
    await client.run(
      inPage(
        overview,
        `
        const search = doc.getElementById("search");
        search.value = "promo@";
        search.dispatchEvent(new content.Event("input"));
        await until(() => doc.querySelectorAll("#aliases .address").length == 1, "filtered");
        const row = ${rowOf("promo@mine.example")};
        row.querySelector('input[type="checkbox"]').click();
        await until(() => row.className == "disabled" && !row.querySelector(".off").hidden, "disabled");
        const note = row.querySelector('input[type="text"]');
        note.value = "Newsletter only";
        note.dispatchEvent(new content.Event("change"));
        await until(() => doc.getElementById("state").textContent == "Note of promo@mine.example saved.", "note saved");
        const pin = row.querySelector(".pin");
        pin.focus();
        pin.click();
        await until(() => pin.getAttribute("aria-pressed") == "true", "pinned");
        if (doc.activeElement != pin) throw new Error("focus lost after pinning");
        `
      )
    );
    const promo = api.aliases.find(a => a.email == "promo@mine.example");
    expect([promo.enabled, promo.note, promo.pinned], [false, "Newsletter only", true], "alias in SimpleLogin");
    const lists = await client.run(
      inPage(
        overview,
        `
        doc.getElementById("search").value = "";
        const filter = doc.getElementById("filter");
        const result = {};
        for (const value of ["disabled", "pinned"]) {
          filter.value = value;
          filter.dispatchEvent(new content.Event("change"));
          await until(() => doc.getElementById("state").textContent.endsWith("shown."), "filtered " + value);
          result[value] = [...doc.querySelectorAll("#aliases .address")].map(e => e.textContent);
        }
        ${rowOf("promo@mine.example")}.querySelector(".pin").click();
        await until(() => !${rowOf("promo@mine.example")}, "unpinned row leaves the pinned list");
        return result;
        `
      )
    );
    expect([lists, promo.pinned], [{ disabled: ["promo@mine.example"], pinned: ["promo@mine.example"] }, false], "filters and unpin");
    promo.enabled = true; // the checks below need it enabled again
  });

  await check("overview: Write refuses an alias that is turned off", async () => {
    const error = await client.run(
      inPage(
        overview,
        `
        ${showAll}
        const row = ${rowOf("shop.otto@mine.example")};
        row.querySelector('input[type="checkbox"]').click();
        await until(() => row.className == "disabled", "disabled");
        ${buttonOf("shop.otto@mine.example", "Write")}.click();
        await until(() => !doc.getElementById("error").hidden, "error shown");
        const text = doc.getElementById("error").textContent;
        row.querySelector('input[type="checkbox"]').click();
        await until(() => row.className == "", "enabled again");
        return text;
        `
      )
    );
    if (!/shop\.otto@mine\.example is turned off/.test(error)) throw new Error("error: " + error);
  });

  await check("overview: contacts of an alias can be blocked and deleted", async () => {
    await client.run(
      inPage(
        overview,
        `
        const row = ${rowOf("other@alias.example")};
        const toggle = ${buttonOf("other@alias.example", "Contacts")};
        toggle.click();
        await until(() => row.nextElementSibling?.querySelector("table"), "contacts shown");
        if (toggle.getAttribute("aria-expanded") != "true") throw new Error("aria-expanded not set");
        const contactRow = name => [...row.nextElementSibling.querySelectorAll("tbody tr")].find(r => r.cells[0].textContent == name);
        contactRow("bea@y.example").querySelector('input[type="checkbox"]').click();
        await until(() => contactRow("bea@y.example").querySelector('input[type="checkbox"]').checked, "blocked");
        const del = contactRow("anna@y.example").querySelector("button");
        del.click();
        await new Promise(r => content.setTimeout(r, 600));
        del.click();
        await until(() => !contactRow("anna@y.example"), "contact deleted");
        `
      )
    );
    expect(
      [api.contacts[2].find(c => c.contact == "bea@y.example").block_forward, api.contacts[2].some(c => c.contact == "anna@y.example")],
      [true, false],
      "contacts in SimpleLogin"
    );
  });
  await screenshot(client, "overview-contacts");

  await check("overview: a double click does not delete, a deliberate second click deletes the alias and its identity", async () => {
    await client.run(chrome(`for (const w of composeWindows()) w.close(); await until(() => !composeWindows().length, "closed");`));
    await client.run(inPage(overview, `${buttonOf("old.trash@mine.example", "Write")}.click();`));
    await client.run(chrome(`await until(() => composeWindows()[0]?.composeEditorReady, "compose opened", 30000); for (const w of composeWindows()) w.close();`));
    expect((await identitiesFor("old.trash@mine.example")).map(i => i[1]), ["Alias Buddy"], "identity created by Write");
    const label = await client.run(inPage(overview, `const del = ${buttonOf("old.trash@mine.example", "Delete")}; del.click(); del.click(); return del.textContent;`));
    expect([label, api.aliases.some(a => a.email == "old.trash@mine.example")], ["Confirm delete", true], "double click kept the alias");
    await sleep(600);
    await client.run(
      inPage(overview, `${buttonOf("old.trash@mine.example", "Confirm delete")}.click(); await until(() => !${rowOf("old.trash@mine.example")}, "row removed");`)
    );
    expect([api.aliases.some(a => a.email == "old.trash@mine.example"), await identitiesFor("old.trash@mine.example")], [false, []], "alias and its identity gone");
  });

  await check("overview: sending from your own identity of a deleted alias is blocked", async () => {
    const status = await client.run(
      inPage(
        overview,
        `
        const del = ${buttonOf("gone@mine.example", "Delete")};
        del.click();
        await new Promise(r => content.setTimeout(r, 600));
        del.click();
        await until(() => doc.getElementById("state").textContent.startsWith("gone@mine.example deleted"), "deleted");
        return doc.getElementById("state").textContent;
        `
      )
    );
    if (!/Remove its 1 identity/.test(status)) throw new Error("status: " + status);
    await expectBlocked(`await send("id12", { to: "bob@x.example" })`, /gone@mine\.example is no longer an alias/);
  });

  await check("calendar: a calendar email from your own identity of a deleted alias is dropped", async () => {
    const mail = nextMail(4000);
    await calendarSend({ identity: "id12", attendee: "gone@mine.example", organizer: "org@x.example", to: ["org@x.example"] });
    expect(await mail, null, "sent message");
  });

  await check("overview: Copy puts the address on the clipboard", async () => {
    const text = await client.run(
      inPage(overview, `${buttonOf("shop@alias.example", "Copy")}.click(); await until(() => doc.getElementById("state").textContent.startsWith("Copied"), "copied"); return doc.getElementById("state").textContent;`)
    );
    const clip = await client.run(
      chrome(`
        const t = Cc["@mozilla.org/widget/transferable;1"].createInstance(Ci.nsITransferable);
        t.init(null);
        t.addDataFlavor("text/plain");
        Services.clipboard.getData(t, Ci.nsIClipboard.kGlobalClipboard, null);
        const data = {};
        t.getTransferData("text/plain", data);
        return data.value.QueryInterface(Ci.nsISupportsString).data;
      `)
    );
    expect([text, clip], ["Copied shop@alias.example.", "shop@alias.example"], "clipboard");
  });

  await check("overview: Write opens a new message with the alias as sender", async () => {
    await client.run(chrome(`for (const w of composeWindows()) w.close(); await until(() => !composeWindows().length, "closed");`));
    await client.run(inPage(overview, `${buttonOf("shop@alias.example", "Write")}.click();`));
    const email = await client.run(
      chrome(`await until(() => composeWindows()[0]?.composeEditorReady, "compose opened", 30000); return MailServices.accounts.getIdentity(composeWindows()[0].getCurrentIdentityKey()).email;`)
    );
    expect(email, "shop@alias.example", "sender");
  });

  await check("overview: Tidy up removes the add-on's identities that no open message uses", async () => {
    const identities = () =>
      client.run(chrome(`return MailServices.accounts.allIdentities.map(i => [i.email, i.label]).sort();`));
    await client.run(chrome(`for (const w of composeWindows()) w.close(); await until(() => !composeWindows().length, "closed");`));
    await client.run(inPage(overview, `${showAll} ${buttonOf("news.heise@mine.example", "Write")}.click();`));
    await client.run(chrome(`await until(() => composeWindows()[0]?.composeEditorReady, "compose opened", 30000);`));
    const before = await identities();
    if (before.filter(i => i[1] == "Alias Buddy").length < 3) throw new Error("too few add-on identities to tidy: " + JSON.stringify(before));
    const status = await client.run(
      inPage(
        overview,
        `
        const tidy = [...doc.querySelectorAll("button")].find(b => b.textContent == "Tidy up");
        tidy.click();
        await sleep(600);
        tidy.click();
        await until(() => doc.getElementById("state").textContent.startsWith("Removed"), "tidied");
        return doc.getElementById("state").textContent;
        `
      )
    );
    const after = await identities();
    const kept = before.filter(i => i[1] != "Alias Buddy" || i[0] == "news.heise@mine.example");
    expect(after, kept, "only the add-on's identities that no open message uses are gone");
    expect(status, `Removed ${before.length - after.length} sender identities the add-on created. They come back when you use their alias.`, "status");
    expect(
      await client.run(chrome(`return MailServices.accounts.getIdentity(composeWindows()[0].getCurrentIdentityKey()).email;`)),
      "news.heise@mine.example",
      "the open message keeps its sender"
    );
  });

  await check("API down: an unknown identity is blocked", async () => {
    api.down = true;
    const mail = nextMail(4000);
    await client.run(chrome(`await send("id4", { to: "bob@x.example" }); await sleep(3000);`));
    api.down = false;
    expect(await mail, null, "sent message");
  });

  // Last, because it removes the API key.
  await check("no API key: the identity of a deleted alias is blocked", async () => {
    await client.run(
      chrome(`
        const url = WebExtensionPolicy.getByID(args[0]).getURL("options/options.html");
        window.document.getElementById("tabmail").openTab("contentTab", { url });
        await sleep(1500);
      `),
      addon
    );
    await client.run(
      inPage(
        `window.document.getElementById("tabmail").currentTabInfo.browser`,
        `
        await until(() => doc.getElementById("apiKey").value, "settings loaded");
        doc.getElementById("apiKey").value = "";
        doc.getElementById("form").requestSubmit();
        await until(() => /^Saved[.,] /.test(doc.getElementById("result").textContent) && !doc.getElementById("result").textContent.includes("Testing"), "saved");
        `
      )
    );
    await expectBlocked(`await send("id12", { to: "bob@x.example" })`, /Without the SimpleLogin API key/);
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
