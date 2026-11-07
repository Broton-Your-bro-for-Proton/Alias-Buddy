export const DEFAULTS = { apiUrl: "https://app.simplelogin.io", apiKey: "", protected: [], allowlist: [] };

export async function getSettings() {
  return { ...DEFAULTS, ...(await messenger.storage.local.get("settings")).settings };
}
