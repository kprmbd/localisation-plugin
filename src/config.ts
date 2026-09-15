// Build-time configuration. No values live in this file — they are injected by
// build.mjs from config.local.json, which is git-ignored so that endpoints and
// the proxy key never enter version control.
//
// First-time setup on a new machine:
//   cp config.example.json config.local.json   # then fill in the three values
//
// build.mjs also generates manifest.json from manifest.template.json using the
// same config, so the plugin's networkAccess allowlist stays in sync with the
// endpoints compiled into the bundle.

declare const __CFG_PROXY_ORIGIN__: string;
declare const __CFG_PROXY_KEY__: string;
declare const __CFG_COPYSTUDIO_MCP_URL__: string;

// Origin of our Cloudflare Worker, which CORS-proxies api.lokalise.com.
export const PROXY_ORIGIN = __CFG_PROXY_ORIGIN__;

// Outer gate on the proxy. This ships inside the plugin bundle, so it is
// extractable and is NOT a credential — it only keeps scanners and drive-by
// traffic off the endpoint. The real gate is on the worker: it requires a
// Lokalise token that can see an allowlisted project. Must match the
// PROXY_KEY secret set via `wrangler secret put`.
export const PROXY_KEY = __CFG_PROXY_KEY__;

// Copy Studio MCP endpoint — translation and localisation-key generation.
export const COPYSTUDIO_MCP_URL = __CFG_COPYSTUDIO_MCP_URL__;
