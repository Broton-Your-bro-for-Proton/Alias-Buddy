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
