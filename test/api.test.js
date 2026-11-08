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
  assert.deepEqual(await sl.findAlias("shop@a.example"), { id: 99, email: "shop@a.example", mailboxes: ["me@real.example"] });
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
