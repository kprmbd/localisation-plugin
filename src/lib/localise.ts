// Lokalise API client (app.lokalise.com — enterprise TMS, NOT localise.biz).
// Auth: X-Api-Token header.
// Docs: https://developers.lokalise.com/reference/
//
// DO NOT point API_BASE back at api.lokalise.com. That was tried and it fails
// every call with `Failed to fetch` and no status. X-Api-Token is a non-simple
// header, so the browser sends a CORS preflight first, and api.lokalise.com
// answers OPTIONS with 404 and no Access-Control-Allow-Origin — the real
// request never fires. Routing through sandboxFetch does NOT avoid this:
// manifest networkAccess gates which domains we may reach, it does not exempt
// us from CORS. So we go through our own Cloudflare Worker, which answers the
// preflight and forwards to Lokalise — see worker/worker.js.

import { sandboxFetch } from './bridge';
import { PROXY_ORIGIN, PROXY_KEY } from '../config';

const API_BASE = `${PROXY_ORIGIN}/api2`;

export interface LocaliseKey {
  id: string;
}

function authHeaders(apiKey: string): Record<string, string> {
  return { 'X-Api-Token': apiKey, 'X-Proxy-Key': PROXY_KEY };
}

// Single entry point for every Lokalise GET, so failures read the same way
// wherever they surface. Three cases the user can act on:
//   0   → never reached the proxy (offline, worker down, or manifest.json
//         changed and the plugin wasn't reloaded, so the domain is still blocked)
//   403 → the worker's gate said no (token can't see the allowed project)
//   503 → the worker is deployed but unconfigured (missing secret / allowlist)
async function lokaliseGet(apiKey: string, path: string, label: string): Promise<string> {
  const r = await sandboxFetch(`${API_BASE}${path}`, { headers: authHeaders(apiKey) });
  if (r.ok) return r.body;
  if (r.status === 0) {
    throw new Error(
      `${label}: couldn't reach the Lokalise proxy at ${PROXY_ORIGIN}. ` +
      `Check your connection; if manifest.json changed, reload the plugin.`,
    );
  }
  if (r.status === 403) {
    throw new Error(
      `${label}: the proxy rejected this request. Check the Lokalise API token ` +
      `in Settings — it needs access to the project the proxy allows.`,
    );
  }
  if (r.status === 503) {
    throw new Error(
      `${label}: the Lokalise proxy is deployed but not configured ` +
      `(PROXY_KEY / ALLOWED_PROJECT_IDS). See worker/wrangler.example.toml.`,
    );
  }
  throw new Error(`${label} ${r.status}: ${r.body.slice(0, 200)}`);
}

// Lokalise language ISO codes are project-specific (often "sv", "de",
// "pt_BR"). Our UI uses "SV", "PT-BR" etc — normalise to lowercase with
// underscores as a first pass.
function toLokaliseIso(code: string): string {
  return code.toLowerCase().replace(/-/g, '_');
}

interface LokaliseProject {
  project_id: string;
  name: string;
}

export interface LokaliseLanguage {
  lang_iso: string;     // e.g. "sv", "pt_BR", "nb_NO" — case is project-defined
  lang_name: string;    // e.g. "Swedish", "Portuguese (Brazil)"
}

interface LokaliseKeyName {
  ios?: string;
  android?: string;
  web?: string;
  other?: string;
}

interface LokaliseTranslation {
  language_iso: string;
  translation: string;
}

interface LokaliseKeyRow {
  key_id: number;
  key_name: LokaliseKeyName | string;
  translations?: LokaliseTranslation[];
}

function pickKeyName(kn: LokaliseKeyName | string): string | null {
  if (typeof kn === 'string') return kn;
  return kn.web ?? kn.other ?? kn.ios ?? kn.android ?? null;
}

async function firstProjectId(apiKey: string): Promise<string> {
  const body = await lokaliseGet(apiKey, '/projects', 'Lokalise /projects');
  const parsed = JSON.parse(body) as { projects?: LokaliseProject[] };
  const first = parsed.projects?.[0];
  if (!first) throw new Error('Lokalise: no projects found for this API token.');
  return first.project_id;
}

// Fetch the project's enabled languages so we can use Lokalise's EXACT
// lang_iso values for translation lookups. Without this we'd be guessing
// (e.g. "PT-BR" → "pt_br") and miss translations stored under "pt_BR" or
// "nb_NO". Returns up to 1000 languages — Lokalise's documented max per
// project is far below that.
export async function getProjectLanguages(
  apiKey: string,
): Promise<LokaliseLanguage[]> {
  const pid = await firstProjectId(apiKey);
  const body = await lokaliseGet(
    apiKey,
    `/projects/${pid}/languages?limit=1000`,
    'Lokalise /languages',
  );
  const parsed = JSON.parse(body) as { languages?: LokaliseLanguage[] };
  return parsed.languages ?? [];
}

// Lokalise's `/keys` endpoint caps `limit` at 5000 per page. To fetch every
// key for projects larger than that, we paginate via `?page=N`. The bridge
// doesn't expose response headers (where Lokalise puts the page count), so we
// rely on a partial-page-means-done heuristic: if a page returns fewer rows
// than the limit, we've reached the end.
//
// MAX_PAGES is a safety cap so a misbehaving response can't pin the loop.
// 100 × 5000 = 500k keys, well above any realistic project.
const PAGE_LIMIT = 5000;
const MAX_PAGES = 100;

async function fetchAllKeyRows(
  apiKey: string,
  pid: string,
  includeTranslations: boolean,
  onProgress?: (loaded: number) => void,
): Promise<LokaliseKeyRow[]> {
  const out: LokaliseKeyRow[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const params = new URLSearchParams({
      limit: String(PAGE_LIMIT),
      page: String(page),
    });
    if (includeTranslations) params.set('include_translations', '1');
    const body = await lokaliseGet(
      apiKey,
      `/projects/${pid}/keys?${params.toString()}`,
      `Lokalise keys page ${page}`,
    );
    const parsed = JSON.parse(body) as { keys?: LokaliseKeyRow[] };
    const rows = parsed.keys ?? [];
    for (const row of rows) out.push(row);
    onProgress?.(out.length);
    if (rows.length < PAGE_LIMIT) break;
  }
  return out;
}

export async function listKeys(
  apiKey: string,
  onProgress?: (loaded: number) => void,
): Promise<LocaliseKey[]> {
  const pid = await firstProjectId(apiKey);
  const rows = await fetchAllKeyRows(apiKey, pid, false, onProgress);
  const out: LocaliseKey[] = [];
  for (const row of rows) {
    const name = pickKeyName(row.key_name);
    if (name) out.push({ id: name });
  }
  return out;
}

// One-shot: fetch every key with every translation across every language.
// Used by "Manage keys" mode so we can show all Lokalise translations for a
// key the user picked, without round-tripping once per language.
// Returns:
//   translations: { keyName: { langIso: text } }
//   languages: sorted unique list of language ISOs found
export async function getAllKeyTranslations(
  apiKey: string,
  onProgress?: (loaded: number) => void,
): Promise<{ translations: Record<string, Record<string, string>>; languages: string[] }> {
  const pid = await firstProjectId(apiKey);
  const rows = await fetchAllKeyRows(apiKey, pid, true, onProgress);
  const out: Record<string, Record<string, string>> = {};
  const langSet = new Set<string>();
  for (const row of rows) {
    const name = pickKeyName(row.key_name);
    if (!name) continue;
    const perLang: Record<string, string> = {};
    for (const t of row.translations ?? []) {
      if (!t || !t.language_iso) continue;
      langSet.add(t.language_iso);
      if (t.translation) perLang[t.language_iso] = t.translation;
    }
    out[name] = perLang;
  }
  return { translations: out, languages: [...langSet].sort() };
}

export async function getTranslations(
  apiKey: string,
  locale: string,
  onProgress?: (loaded: number) => void,
): Promise<Record<string, string>> {
  const pid = await firstProjectId(apiKey);
  const iso = toLokaliseIso(locale);
  const rows = await fetchAllKeyRows(apiKey, pid, true, onProgress);
  const out: Record<string, string> = {};
  for (const row of rows) {
    const name = pickKeyName(row.key_name);
    if (!name) continue;
    const t = row.translations?.find(x => x.language_iso.toLowerCase() === iso);
    if (t && t.translation) out[name] = t.translation;
  }
  return out;
}
