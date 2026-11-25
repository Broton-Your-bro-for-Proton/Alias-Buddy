// Gettext-style translation: the English text is the key, a catalog per language maps it to that language.
// A missing entry shows the English text. Placeholders are written {name}.

/** Every UI language besides English, with a catalog ./locales/<code>.js (the store's languages). */
export const LOCALES = [
  "af", "ar", "ast", "az", "bg", "bn", "bs", "ca", "cak", "cs", "da", "de", "dsb", "el", "es", "eu", "fa", "fi",
  "fr", "fy-NL", "ga-IE", "gu", "he", "hsb", "hu", "id", "it", "ja", "ka", "kab", "ko", "mk", "mn", "ms", "nb-NO",
  "nl", "nn-NO", "pa-IN", "pl", "pt-BR", "pt-PT", "ro", "ru", "sk", "sl", "sq", "sv-SE", "te", "th", "tr", "uk",
  "ur", "vi", "zh-CN", "zh-TW",
];

let locale = "en";
let catalog = null; // null = English

/** The supported locale for a language tag: the exact one (pt-BR), else the first of that language (pt), else English. */
export function matchLocale(tag) {
  const want = String(tag ?? "").replace("_", "-").toLowerCase();
  const base = want.split("-")[0];
  return LOCALES.find(l => l.toLowerCase() == want) ?? LOCALES.find(l => l.toLowerCase().split("-")[0] == base) ?? "en";
}

/** Loads the catalog of a language and switches to it. */
export async function loadLocale(lang) {
  locale = matchLocale(lang);
  try {
    catalog = locale == "en" ? null : (await import(`./locales/${locale}.js`)).default;
  } catch (e) {
    // A missing catalog must not stop the guard: the add-on then shows English.
    console.error("Alias Buddy: no UI texts for", locale, e);
    locale = "en";
    catalog = null;
  }
}

export const getLocale = () => locale;

export function t(text, params) {
  const out = catalog && Object.hasOwn(catalog, text) ? catalog[text] : text;
  return params ? out.replace(/\{(\w+)\}/g, (m, key) => (key in params ? String(params[key]) : m)) : out;
}

/** The key of a text node: trimmed, inner whitespace as single spaces. */
export const pageText = text => text.trim().replace(/\s+/g, " ");

/** Translates static text of a page: text nodes, the title and the title/placeholder/aria-label attributes. */
export function localizeDom(root, doc = root.ownerDocument ?? root) {
  if (!catalog) {
    return;
  }
  doc.title = t(doc.title);
  const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    // Text wrapped over several lines in the page counts with single spaces.
    const key = pageText(node.nodeValue);
    if (key && Object.hasOwn(catalog, key)) {
      const [, before, , after] = /^(\s*)([\s\S]*?)(\s*)$/.exec(node.nodeValue);
      node.nodeValue = before + catalog[key] + after;
    }
  }
  for (const el of root.querySelectorAll("[title], [placeholder], [aria-label]")) {
    for (const attr of ["title", "placeholder", "aria-label"]) {
      if (el.hasAttribute(attr)) {
        el.setAttribute(attr, t(el.getAttribute(attr)));
      }
    }
  }
}

// Thunderbird's language in the add-on; Node (the unit tests) stays English.
await loadLocale(globalThis.messenger?.i18n?.getUILanguage?.() ?? globalThis.browser?.i18n?.getUILanguage?.() ?? "en");
