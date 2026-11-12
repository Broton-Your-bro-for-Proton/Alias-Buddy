import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("the settings page links to Ko-fi statically, without a widget script", () => {
  const html = readFileSync(new URL("../src/options/options.html", import.meta.url), "utf8");
  assert.match(html, /<a class="support-link" href="https:\/\/ko-fi\.com\/hypercrisis" rel="noreferrer" target="_blank">/);
  assert.doesNotMatch(html, /ko-fi\.com\/cdn|kofiwidget/);
});
