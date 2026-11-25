// Translates the static text of the page it is loaded into, before the page's own module runs.
import { getLocale, localizeDom } from "./i18n.js";

document.documentElement.lang = getLocale();
localizeDom(document.documentElement, document);
