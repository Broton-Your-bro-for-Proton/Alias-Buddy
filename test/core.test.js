import assert from "node:assert/strict";
import test from "node:test";
import * as core from "../src/lib/core.js";

const r = (field, email) => ({ field, email });

test("addressOf reads mailbox strings", () => {
  assert.equal(core.addressOf("First Last <First@Example.com>"), "first@example.com");
  assert.equal(core.addressOf(" a@b.c "), "a@b.c");
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

test("leaks finds whole addresses only", () => {
  const mine = new Set(["me@real.example"]);
  assert.deepEqual(core.leaks(["Write to ME@real.example."], mine), ["me@real.example"]);
  assert.deepEqual(core.leaks(['<a href="mailto:me@real.example">'], mine), ["me@real.example"]);
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

test("verifyAliasSend accepts a clean rewrite", () => {
  const contacts = new Map([["peter@x.example", "ra1@sl.example"]]);
  const problems = core.verifyAliasSend(
    { identityId: "id1", recipients: [r("to", "ra1@sl.example")], replyTo: [], attachVCard: false },
    { identityId: "id1", alias: "shop@alias.example", contacts, protectedAddresses: new Set(["me@real.example"]) }
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
    { identityId: "id1", alias: "shop@alias.example", contacts, protectedAddresses: new Set(["me@real.example"]) }
  );
  assert.equal(problems.length, 6);
});
