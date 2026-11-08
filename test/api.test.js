import assert from "node:assert/strict";
import test from "node:test";
import { ApiError, SimpleLogin, TOO_MANY, isOutage } from "../src/lib/api.js";

/** Replaces fetch with a handler that receives (method, path, body). */
function fake(handler) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const path = url.replace("https://sl.example", "");
    calls.push(path);
    const [status, body] = handler(init.method, path, init.body && JSON.parse(init.body), init.headers);
    return new Response(typeof body == "string" ? body : JSON.stringify(body), { status });
  };
  return calls;
}
const sl = new SimpleLogin("https://sl.example/", "key");

test("sends the API key in the Authentication header", async () => {
  let header;
  fake((m, p, b, headers) => ((header = headers.Authentication), [200, { mailboxes: [] }]));
  await sl.mailboxes();
  assert.equal(header, "key");
});

test("findAlias pages past a full page and stops at an empty one", async () => {
  const aliases = Array.from({ length: 25 }, (_, i) => ({ id: i, email: `x${i}shop@a.example`, mailboxes: [] }));
  aliases.push({ id: 99, email: "Shop@A.example", mailboxes: [{ email: "Me@real.example" }] });
  const calls = fake((m, p) => {
    const page = Number(/page_id=(\d+)/.exec(p)[1]);
    return [200, { aliases: aliases.slice(page * 20, page * 20 + 20) }];
  });
  const found = await sl.findAlias("shop@a.example");
  assert.deepEqual([found.id, found.email, found.mailboxes], [99, "shop@a.example", ["me@real.example"]]);
  assert.equal(calls.length, 2);
  fake(() => [200, { aliases: [] }]);
  assert.equal(await sl.findAlias("none@a.example"), null);
});

test("contacts reads both reverse alias fields and named contacts", async () => {
  fake((m, p) =>
    p.endsWith("page_id=0")
      ? [
          200,
          {
            contacts: [
              { contact: "a@x.example", reverse_alias_address: "RA1@sl.example" },
              { contact: "Bob <b@x.example>", reverse_alias: '"b at x.example" <ra2@sl.example>' },
            ],
          },
        ]
      : [200, { contacts: [] }]
  );
  assert.deepEqual(await sl.contacts(1), { "a@x.example": "ra1@sl.example", "b@x.example": "ra2@sl.example" });
});

test("errors carry status and message, odd answers fail", async () => {
  fake(() => [403, { error: "Please upgrade to create a reverse-alias" }]);
  await assert.rejects(sl.createContact(1, "a@x.example"), e => e instanceof ApiError && e.status == 403 && /upgrade/.test(e.message));
  fake(() => [200, "<html>maintenance</html>"]);
  await assert.rejects(sl.mailboxes(), e => e instanceof ApiError && /unexpected answer/.test(e.message));
  globalThis.fetch = async () => {
    throw new TypeError("network down");
  };
  await assert.rejects(sl.mailboxes(), e => e instanceof ApiError && e.status == 0);
});

test("contacts stops paging once the wanted addresses are found", async () => {
  const calls = fake((m, p) => {
    const page = Number(/page_id=(\d+)/.exec(p)[1]);
    const contacts = Array.from({ length: 20 }, (_, i) => ({ contact: `c${page}-${i}@x.example`, reverse_alias_address: `ra${page}-${i}@sl.example` }));
    return [200, { contacts }];
  });
  const result = await sl.contacts(1, ["ra1-5@sl.example"]);
  assert.equal(result["c1-5@x.example"], "ra1-5@sl.example");
  assert.equal(calls.length, 2);
});

test("isOutage covers network, rate limit and server errors only", () => {
  assert.ok(isOutage(new ApiError(0, "")));
  assert.ok(isOutage(new ApiError(429, "")));
  assert.ok(isOutage(new ApiError(503, "")));
  for (const status of [400, 401, 403, TOO_MANY]) {
    assert.ok(!isOutage(new ApiError(status, "")));
  }
});

test("findSiteAlias finds the enabled alias whose note names the site", async () => {
  fake((m, p, body) => {
    const page = Number(/page_id=(\d+)/.exec(p)[1]);
    assert.equal(body.query, "amazon.de");
    const aliases = [
      { id: 1, email: "a@x.example", note: "Alias Buddy: amazon.de", enabled: false, mailboxes: [] },
      { id: 2, email: "B@x.example", note: "old\nAlias Buddy: amazon.de", enabled: true, mailboxes: [{ email: "Me@real.example" }] },
    ];
    return [200, { aliases: page == 0 ? aliases : [] }];
  });
  const alias = await sl.findSiteAlias("amazon.de");
  assert.deepEqual([alias.id, alias.email, alias.mailboxes], [2, "b@x.example", ["me@real.example"]]);
});

test("suffixes and createAlias use the documented fields", async () => {
  let sent;
  fake((m, p, body) => {
    if (p == "/api/v5/alias/options") {
      return [200, { suffixes: [{ suffix: "@Mine.example", signed_suffix: "@mine.example.sig", is_custom: true }] }];
    }
    sent = body;
    return [201, { id: 7, email: "shop.ab12c@mine.example", mailboxes: [{ email: "me@real.example" }], note: body.note }];
  });
  assert.deepEqual(await sl.suffixes(), [{ suffix: "@mine.example", signed: "@mine.example.sig", custom: true }]);
  const alias = await sl.createAlias({ prefix: "shop.ab12c", signed: "@mine.example.sig", mailboxIds: [1], note: "n" });
  assert.deepEqual(sent, { alias_prefix: "shop.ab12c", signed_suffix: "@mine.example.sig", mailbox_ids: [1], note: "n" });
  assert.equal(alias.email, "shop.ab12c@mine.example");
});

test("alias management calls use the documented routes and fields", async () => {
  const calls = [];
  fake((method, path, body) => {
    calls.push([method, path, body ?? null]);
    if (path.startsWith("/api/v2/aliases")) {
      return [200, { aliases: [{ id: 3, email: "A@x.example", pinned: true, nb_forward: 4, latest_activity: { action: "reply", timestamp: 9, contact: { email: "C@y.example" } } }] }];
    }
    if (path.endsWith("/toggle") && path.includes("aliases")) return [200, { enabled: false }];
    if (path.endsWith("/toggle")) return [200, { block_forward: true }];
    if (path.includes("/contacts?")) {
      return [200, { contacts: [{ id: 8, contact: "c@y.example", reverse_alias_address: "RA@sl.example", block_forward: false, last_email_sent_timestamp: 5 }] }];
    }
    return [200, { deleted: true }];
  });
  const [alias] = await sl.listAliases({ page: 1, query: "x", filter: "disabled" });
  assert.deepEqual([alias.email, alias.pinned, alias.forwards, alias.latest], ["a@x.example", true, 4, { action: "reply", at: 9, contact: "c@y.example" }]);
  assert.equal(await sl.toggleAlias(3), false);
  await sl.updateAlias(3, { note: "n", pinned: false });
  await sl.deleteAlias(3);
  assert.deepEqual(await sl.contactsPage(3), [{ id: 8, email: "c@y.example", reverse: "ra@sl.example", blocked: false, lastSent: 5 }]);
  assert.equal(await sl.toggleContact(8), true);
  await sl.deleteContact(8);
  assert.deepEqual(calls.map(c => c[0] + " " + c[1]), [
    "POST /api/v2/aliases?page_id=1&disabled",
    "POST /api/aliases/3/toggle",
    "PATCH /api/aliases/3",
    "DELETE /api/aliases/3",
    "GET /api/aliases/3/contacts?page_id=0",
    "POST /api/contacts/8/toggle",
    "DELETE /api/contacts/8",
  ]);
  assert.deepEqual(calls[2][2], { note: "n", pinned: false });
});
