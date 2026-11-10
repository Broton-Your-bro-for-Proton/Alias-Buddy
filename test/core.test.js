import assert from "node:assert/strict";
import test from "node:test";
import * as core from "../src/lib/core.js";

const r = (field, email) => ({ field, email });

test("addressOf reads mailbox strings", () => {
  assert.equal(core.addressOf("First Last <First@Example.com>"), "first@example.com");
  assert.equal(core.addressOf(" a@b.c "), "a@b.c");
});

test("canonical strips tags and Gmail dots", () => {
  assert.equal(core.canonical("Me+TB@real.example"), "me@real.example");
  assert.equal(core.canonical("m.e@googlemail.com"), "me@gmail.com");
  assert.equal(core.canonical("m.e@real.example"), "m.e@real.example");
});

test("isAllowed matches addresses and domains", () => {
  const list = ["mom@family.example", "@friends.example", "work.example"];
  assert.ok(core.isAllowed("Mom@Family.example", list));
  assert.ok(core.isAllowed("bob@friends.example", list));
  assert.ok(core.isAllowed("boss@work.example", list));
  assert.ok(!core.isAllowed("dad@family.example", list));
  assert.ok(!core.isAllowed("x@notwork.example", list));
  assert.ok(!core.isAllowed("x@y.z", [""]));
});

test("leaks finds protected addresses in any spelling, and whole addresses only", () => {
  const mine = new Set(["me@real.example", "me@gmail.com"]);
  assert.deepEqual(core.leaks(["Write to ME@real.example."], mine), ["me@real.example"]);
  assert.deepEqual(core.leaks(['<a href="mailto:me+news@real.example">'], mine), ["me+news@real.example"]);
  assert.deepEqual(core.leaks(["Delivered-To: m.e@googlemail.com"], mine), ["m.e@googlemail.com"]);
  assert.deepEqual(core.leaks(["home@real.example", "me@real.examples", undefined], mine), []);
});

test("checkMailboxSend reports exposed recipients", () => {
  const reverse = new Set(["ra1@sl.example"]);
  const result = core.checkMailboxSend([r("to", "peter@x.example"), r("cc", "mom@family.example")], reverse, [
    "mom@family.example",
  ]);
  assert.deepEqual(result.exposed.map(x => x.email), ["peter@x.example"]);
  assert.equal(result.mixed, false);
});

test("checkMailboxSend reports a mix of reverse aliases and other addresses", () => {
  const reverse = new Set(["ra1@sl.example"]);
  const result = core.checkMailboxSend([r("to", "ra1@sl.example"), r("cc", "mom@family.example")], reverse, [
    "mom@family.example",
  ]);
  assert.deepEqual(result.exposed, []);
  assert.equal(result.mixed, true);
  assert.equal(core.checkMailboxSend([r("to", "RA1@sl.example")], reverse, []).mixed, false);
});

test("checkMailboxSend accepts the owning alias next to its reverse aliases", () => {
  const reverse = new Set(["ra1@sl.example"]);
  const recipients = [r("to", "ra1@sl.example"), r("cc", "shop@alias.example")];
  const result = core.checkMailboxSend(recipients, reverse, [], new Set(["shop@alias.example"]));
  assert.deepEqual([result.exposed, result.mixed], [[], false]);
  assert.equal(core.checkMailboxSend(recipients, reverse, []).mixed, true);
});

test("rewriteForAlias maps contacts and keeps reverse aliases and the alias", () => {
  const contacts = new Map([["peter@x.example", "ra1@sl.example"], ["anna@y.example", "ra2@sl.example"]]);
  const { fields, missing, rows } = core.rewriteForAlias(
    [r("to", "Peter@x.example"), r("cc", "ra2@sl.example"), r("bcc", "shop@alias.example"), r("to", "new@z.example")],
    "shop@alias.example",
    contacts
  );
  assert.deepEqual(fields, { to: ["ra1@sl.example"], cc: ["ra2@sl.example"], bcc: ["shop@alias.example"] });
  assert.deepEqual(missing, [r("to", "new@z.example")]);
  assert.equal(rows.length, 3);
});

test("hasEmbeddedImages finds images Thunderbird would embed", () => {
  assert.ok(core.hasEmbeddedImages('<img src="data:image/png;base64,AAAA">'));
  assert.ok(core.hasEmbeddedImages("<IMG alt=x src=file:///c:/a.png>"));
  assert.ok(!core.hasEmbeddedImages('<img src="https://example.com/a.png">'));
  assert.ok(!core.hasEmbeddedImages('<img moz-do-not-send="true" src="data:image/png;base64,AAAA">'));
  assert.ok(!core.hasEmbeddedImages(undefined));
});

test("sendProblems reports everything that carries the mailbox's identity", () => {
  assert.deepEqual(core.sendProblems({ attachVCard: false, newsgroups: "" }), []);
  const problems = core.sendProblems({
    attachVCard: true,
    attachPublicPGPKey: true,
    selectedEncryptionTechnology: { name: "S/MIME", signMessage: true },
    newsgroups: ["alt.test"],
  });
  assert.equal(problems.length, 4);
});

test("verifyAliasSend accepts a clean rewrite", () => {
  const contacts = new Map([["peter@x.example", "ra1@sl.example"]]);
  const problems = core.verifyAliasSend(
    { identityId: "id1", recipients: [r("to", "ra1@sl.example")], replyTo: [], attachVCard: false },
    { identityId: "id1", alias: "shop@alias.example", contacts, isProtected: () => false }
  );
  assert.deepEqual(problems, []);
});

test("verifyAliasSend reports every leak", () => {
  const contacts = new Map([["peter@x.example", "ra1@sl.example"]]);
  const problems = core.verifyAliasSend(
    {
      identityId: "id2",
      recipients: [r("to", "ra1@sl.example"), r("cc", "auto@cc.example")],
      replyTo: [r("replyTo", "me@real.example")],
      attachVCard: true,
      attachPublicPGPKey: true,
      selectedEncryptionTechnology: { name: "OpenPGP", signMessage: true },
    },
    { identityId: "id1", alias: "shop@alias.example", contacts, isProtected: e => e == "me@real.example" }
  );
  assert.equal(problems.length, 6);
});

test("pickMailboxIdentity prefers a keyless identity in the same account", () => {
  const keyed = { OpenPGP: { canSign: true, canEncrypt: true } };
  const identities = [
    { id: "a", accountId: "acc1", email: "me@real.example", encryptionCapabilities: keyed },
    { id: "b", accountId: "acc2", email: "Me@real.example", encryptionCapabilities: {} },
    { id: "c", accountId: "acc1", email: "me+tb@real.example" },
    { id: "d", accountId: "acc1", email: "other@real.example" },
  ];
  const pick = core.pickMailboxIdentity(identities, ["me@real.example"], "acc1");
  assert.equal(pick.identity.id, "c");
  assert.deepEqual(pick.candidates.map(i => i.id), ["a", "c", "b"]);
  assert.equal(core.pickMailboxIdentity(identities.slice(0, 1), ["me@real.example"], "acc1").identity, null);
});

test("fingerprint changes with every field the user can edit", () => {
  const base = { identityId: "id1", to: ["a@b.c"], subject: "Hi", body: "<p>x</p>" };
  const same = core.fingerprint({ ...base, attachVCard: true });
  assert.equal(core.fingerprint(base), same);
  for (const change of [{ to: ["x@y.z"] }, { subject: "Ho" }, { body: "<p>y</p>" }, { identityId: "id2" }]) {
    assert.notEqual(core.fingerprint({ ...base, ...change }), same);
  }
});

test("canonical treats Proton's domains as one mailbox", () => {
  assert.equal(core.canonical("Me@pm.me"), "me@proton.me");
  assert.equal(core.canonical("me+x@protonmail.ch"), "me@proton.me");
});

test("unfold lets leaks find an address split by an iCalendar fold", () => {
  const folded = "ATTENDEE;CN=Me;PARTSTAT=NEEDS-ACTION;ROLE=REQ-PARTICIPANT;RSVP=TRUE:mailto:me@r\r\n eal.example";
  const mine = new Set(["me@real.example"]);
  assert.deepEqual(core.leaks([folded], mine), []);
  assert.deepEqual(core.leaks([core.unfold(folded)], mine), ["me@real.example"]);
});

test("idsInDomains finds Message-IDs from the mailbox domain", () => {
  const ids = ["<a1.b2@real.example>", "<CAxyz@mail.gmail.com>", "x@other.example"];
  assert.deepEqual(core.idsInDomains(ids, new Set(["real.example", "gmail.com"])), ["<a1.b2@real.example>"]);
});

test("checkMailboxSend ignores Bcc for mixing, SimpleLogin never sees it", () => {
  const reverse = new Set(["ra1@sl.example"]);
  const result = core.checkMailboxSend([r("to", "ra1@sl.example"), r("bcc", "mom@family.example")], reverse, [
    "@family.example",
  ]);
  assert.deepEqual([result.exposed, result.mixed], [[], false]);
});

test("ownerProblem requires one owning alias that the mailbox belongs to", () => {
  const owners = { "ra1@sl.example": 1, "ra2@sl.example": 1, "ra9@sl.example": 2 };
  const aliases = { 1: { email: "shop@alias.example", mailboxes: ["me@real.example"] }, 2: { email: "b@alias.example", mailboxes: ["me@real.example"] } };
  const check = (emails, sender) =>
    core.ownerProblem(emails.map(e => r("to", e)), ra => owners[ra], id => aliases[id], sender);
  assert.equal(check(["ra1@sl.example", "ra2@sl.example"], "Me+x@real.example"), null);
  assert.match(check(["ra1@sl.example", "ra9@sl.example"], "me@real.example"), /different aliases/);
  assert.match(check(["ra1@sl.example"], "other@real.example"), /not a mailbox of shop@alias\.example/);
  assert.equal(check([], "other@real.example"), null);
});

test("verifiedOf keeps verified mailboxes, all while unknown", () => {
  const known = [{ email: "a@x.example", verified: true }, { email: "b@x.example", verified: false }];
  assert.deepEqual(core.verifiedOf(["a@x.example", "b@x.example"], known), ["a@x.example"]);
  assert.deepEqual(core.verifiedOf(["a@x.example"], undefined), ["a@x.example"]);
});

test("siteOf keeps the registrable part of the domain", () => {
  assert.equal(core.siteOf("news@shop.amazon.de"), "amazon.de");
  assert.equal(core.siteOf("a@mail.bbc.co.uk"), "bbc.co.uk");
  assert.equal(core.siteOf("a@example.com"), "example.com");
});

test("prefixFrom fills the template with what SimpleLogin accepts", () => {
  const fixed = () => 0;
  assert.equal(core.prefixFrom("{domain}.{random}", "amazon.de", fixed), "amazon.aaaaa");
  assert.equal(core.prefixFrom("{word}-{domain}", "bbc.co.uk", fixed), "amber-bbc");
  assert.equal(core.prefixFrom("Mein Shop!!..{domain}", "x-y.de", fixed), "meinshop.x-y");
  assert.equal(core.prefixFrom("{nothing}", "", fixed), "nothing");
  assert.equal(core.prefixFrom("!!!", "", fixed), "aaaaaaaa");
});

test("pickSuffix prefers the plain suffix of an own domain", () => {
  const suffixes = [
    { suffix: ".cat@aleeas.example", custom: false },
    { suffix: "@me.aleeas.example", custom: true },
    { suffix: "@mine.example", custom: true },
  ];
  assert.equal(core.pickSuffix(suffixes, "mine.example").suffix, "@mine.example");
  assert.equal(core.pickSuffix(suffixes, "aleeas.example").suffix, ".cat@aleeas.example");
  assert.equal(core.pickSuffix(suffixes, "").suffix, "@me.aleeas.example");
  assert.equal(core.pickSuffix(suffixes, "unknown.example"), null);
  assert.deepEqual(
    core.creationDomains(suffixes).map(d => [d.domain, d.custom, d.random]),
    [["me.aleeas.example", true, false], ["mine.example", true, false], ["aleeas.example", false, true]]
  );
});

test("noteNamesSite matches site and template on a whole line, older ties belong to {domain}.{random}", () => {
  const note = "Shopping\n" + core.siteNote("amazon.de", "news.{domain}");
  assert.ok(core.noteNamesSite(note, "amazon.de", "news.{domain}"));
  assert.ok(!core.noteNamesSite(note, "amazon.de", "shop.{domain}"));
  assert.ok(!core.noteNamesSite("Alias Buddy: amazon.de.evil (news.{domain})", "amazon.de", "news.{domain}"));
  assert.ok(core.noteNamesSite("Alias Buddy: amazon.de", "amazon.de", "{domain}.{random}"));
  assert.ok(!core.noteNamesSite("Alias Buddy: amazon.de", "amazon.de", "shop.{domain}"));
  assert.ok(!core.noteNamesSite(null, "amazon.de", "shop.{domain}"));
});

test("templateProblem requires a placeholder", () => {
  assert.equal(core.templateProblem("shop.{domain}"), null);
  assert.equal(core.templateProblem("{word}.{word}"), null);
  assert.match(core.templateProblem("shop"), /every site would get the same name/);
});

test("siteOf handles subdomains, country endings and IP addresses", () => {
  assert.equal(core.siteOf("a@news.dhl.de"), "dhl.de");
  assert.equal(core.siteOf("a@mail.ing.nl"), "ing.nl");
  assert.equal(core.siteOf("a@shop.example.com.au"), "example.com.au");
  assert.equal(core.siteOf("a@[1.2.3.4]"), "1.2.3.4");
  assert.equal(core.siteOf("a@localhost"), "localhost");
});

test("prefixFrom never ends in a dot after cutting at 40 characters", () => {
  const prefix = core.prefixFrom("amazon." + "x".repeat(32) + ".tail", "amazon.de", () => 0);
  assert.ok(prefix.length <= 40 && !/[._-]$/.test(prefix), prefix);
});

test("templatesOf keeps the list, the default first, and reads the single template of older settings", () => {
  assert.deepEqual(core.templatesOf({ template: "shop.{domain}" }), ["shop.{domain}"]);
  assert.deepEqual(core.templatesOf({ template: "x", templates: [" shop.{domain} ", "", "news.{domain}", "shop.{domain}"] }), ["shop.{domain}", "news.{domain}"]);
  assert.deepEqual(core.templatesOf({ templates: [] }), ["{domain}.{random}"]);
});

test("recipientSites lists each site once, maps known reverse aliases and leaves out own and unknown ones", () => {
  const sites = core.recipientSites(
    ["me@real.example", "a@news.shop.example", "ra-1@sl.example", "b@shop.example", "ra-2@sl.example", "c@other.co.uk"],
    {
      isMine: email => email == "me@real.example",
      contactOf: email => ({ "ra-1@sl.example": "peter@heise.example" })[email],
      reverseDomains: new Set(["sl.example"]),
    }
  );
  assert.deepEqual(sites, ["shop.example", "heise.example", "other.co.uk"]);
});

test("reverseAliasCard starts with the alias and names the contact, never more", () => {
  assert.deepEqual(core.reverseAliasCard("bea@y.example", "other@alias.example"), {
    DisplayName: "[other@alias.example] bea@y.example",
    Notes: "Reverse alias for bea@y.example through your alias other@alias.example. Kept by Alias Buddy.",
  });
});

test("hasEmbeddedImages finds every image, background and link Thunderbird embeds", () => {
  assert.ok(core.hasEmbeddedImages('<img moz-do-not-send="false" src="https://example.com/a.png">'));
  assert.ok(core.hasEmbeddedImages('<body background="data:image/png;base64,AAAA"><p>x</p></body>'));
  assert.ok(core.hasEmbeddedImages('<a href="data:text/plain;base64,AAAA">file</a>'));
  assert.ok(core.hasEmbeddedImages("<a moz-do-not-send='false' href='https://example.com/a.pdf'>file</a>"));
  assert.ok(!core.hasEmbeddedImages('<a href="https://example.com/">site</a><a href="mailto:x@y.z">mail</a>'));
  assert.ok(!core.hasEmbeddedImages('<img data-src="data:x" src="https://example.com/a.png">'));
});

test("decodeText reads UTF-16 with and without a byte order mark", () => {
  const text = "Contact: me@real.example";
  const le = Buffer.from(text, "utf16le");
  const be = Buffer.from(le).swap16();
  assert.equal(core.decodeText(new Uint8Array(le)), text);
  assert.equal(core.decodeText(new Uint8Array([0xff, 0xfe, ...le])), text);
  assert.equal(core.decodeText(new Uint8Array([0xfe, 0xff, ...be])), text);
  assert.equal(core.decodeText(new Uint8Array(be)), text);
  assert.equal(core.decodeText(new TextEncoder().encode("café " + text)), "café " + text);
});

test("hasEmbeddedImages treats an empty moz-do-not-send as unset and ignores names inside quoted values", () => {
  assert.ok(core.hasEmbeddedImages('<img moz-do-not-send="" src="data:image/png;base64,AAAA">'));
  assert.ok(core.hasEmbeddedImages('<img alt=" src=https://x" src="data:image/png;base64,AAAA">'));
  assert.ok(!core.hasEmbeddedImages('<img alt=" src=data:x" src="https://example.com/a.png">'));
});

test("decodeText finds an address in UTF-16 without a byte order mark that is mostly not Latin", () => {
  const text = "\u9023\u7d61\u5148".repeat(600) + " me@real.example";
  assert.ok(core.decodeText(new Uint8Array(Buffer.from(text, "utf16le"))).includes("me@real.example"));
  assert.ok(core.decodeText(new Uint8Array(Buffer.from(text, "utf16le").swap16())).includes("me@real.example"));
});
