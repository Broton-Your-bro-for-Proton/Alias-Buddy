import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { LOCALES, matchLocale } from "../src/lib/i18n.js";
import { uiKeys } from "../scripts/i18n-keys.mjs";

const placeholders = s => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join();
const read = file => JSON.parse(readFileSync(new URL(file, import.meta.url), "utf8"));

test("every language has a complete catalog with the same placeholders", async () => {
  const keys = uiKeys();
  for (const code of LOCALES) {
    const { default: catalog } = await import(`../src/lib/locales/${code}.js`);
    for (const key of keys) {
      const value = catalog[key];
      assert.ok(typeof value == "string" && value.trim(), `${code}: missing ${key}`);
      assert.equal(placeholders(value), placeholders(key), `${code}: ${key}`);
      assert.ok(!value.includes("—"), `${code}: em dash in ${key}`);
    }
    assert.deepEqual(Object.keys(catalog).filter(key => !keys.includes(key)), [], `${code}: keys no UI text uses`);
  }
});

test("every language has the manifest strings", () => {
  const en = Object.keys(read("../src/_locales/en/messages.json")).sort();
  for (const code of LOCALES) {
    assert.deepEqual(Object.keys(read(`../src/_locales/${code.replace("-", "_")}/messages.json`)).sort(), en, code);
  }
});

test("a language tag finds its catalog, a region falls back to the language", () => {
  assert.equal(matchLocale("pt-BR"), "pt-BR");
  assert.equal(matchLocale("pt"), "pt-BR");
  assert.equal(matchLocale("de-AT"), "de");
  assert.equal(matchLocale("zh_TW"), "zh-TW");
  assert.equal(matchLocale("en-US"), "en");
});
