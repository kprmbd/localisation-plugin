// Cloudflare Worker — CORS proxy + access gate for Lokalise.
//
// WHY THIS EXISTS (don't "simplify" it away by calling api.lokalise.com direct):
// The Figma plugin runs at origin "null". Lokalise auth needs the X-Api-Token
// header, which is non-simple, so the browser must send a CORS preflight first.
// api.lokalise.com answers OPTIONS with 404 and no Access-Control-Allow-Origin,
// so the preflight fails and the real request never fires — the plugin sees
// `Failed to fetch` with no status at all. Routing through the plugin sandbox
// does NOT help: manifest networkAccess gates which domains you may reach, it
// does not exempt you from CORS. This worker forwards to Lokalise and answers
// the preflight properly.
//
// ACCESS CONTROL — two layers, and only the second is real security:
//   1. X-Proxy-Key must match env.PROXY_KEY. The plugin bundle ships to every
//      user, so this key is extractable from it. Treat it as a filter for
//      scanners and drive-by traffic, NOT as authentication.
//   2. X-Api-Token must be a Lokalise token that can actually see a project in
//      env.ALLOWED_PROJECT_IDS. This is what makes a leaked URL + key useless:
//      you need a token that already has access to our project, and anyone
//      holding that can call api.lokalise.com directly anyway — the proxy hands
//      them nothing they didn't already have.
//
// The worker holds no upstream credentials of its own, so there is nothing to
// steal by reaching it. Forwarding is deliberately permissive on path and
// method so the plugin can later write keys back without touching this file.
//
// Copy Studio is NOT proxied here. The plugin talks to the Copy Studio MCP
// server directly — it answers preflights correctly — authenticating with a
// token the user pastes into plugin Settings. See src/lib/copystudio.ts.

const UPSTREAM = 'https://api.lokalise.com';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Api-Token, X-Proxy-Key',
  'Access-Control-Max-Age': '86400',
};

// Verified-token cache, keyed by SHA-256 of the token (never the raw value).
// Without this the gate would fire one upstream /projects call per request, and
// the plugin paginates 5000 keys at a time — that alone would eat Lokalise's
// rate limit (observed: 10 req/s, per token). Negative results are cached too,
// so a junk token can't be used to hammer upstream either.
const OK_TTL_MS = 5 * 60 * 1000;
const DENY_TTL_MS = 60 * 1000;
const MAX_CACHE_ENTRIES = 500;
const verdicts = new Map();

export default {
  async fetch(request, env) {
    // Preflight — the whole reason this worker exists. Answer before any gate:
    // browsers never attach custom headers to an OPTIONS preflight, so gating
    // it would fail every request before the real call could authenticate.
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const allowedProjects = parseIdList(env.ALLOWED_PROJECT_IDS);
    if (!env.PROXY_KEY || allowedProjects.size === 0) {
      // Fail closed: an unconfigured deploy is an open relay.
      return deny(503, 'Proxy is not configured (PROXY_KEY / ALLOWED_PROJECT_IDS).');
    }

    // Layer 1 — shared key.
    if (!safeEqual(request.headers.get('X-Proxy-Key') ?? '', env.PROXY_KEY)) {
      return deny(403, 'Forbidden.');
    }

    // Layer 2 — the token must reach an allowlisted project.
    const token = request.headers.get('X-Api-Token');
    if (!token) return deny(403, 'Missing X-Api-Token.');
    if (!(await tokenAllowed(token, allowedProjects))) {
      return deny(403, 'This Lokalise token has no access to an allowed project.');
    }

    const incoming = new URL(request.url);
    const target = UPSTREAM + incoming.pathname + incoming.search;

    const init = {
      method: request.method,
      headers: stripHopByHop(request.headers),
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer(),
      redirect: 'follow',
    };

    const upstream = await fetch(target, init);
    const headers = new Headers(upstream.headers);
    for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
    // Remove headers that would confuse the browser about encoding / length.
    headers.delete('content-encoding');
    headers.delete('content-length');

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  },
};

function deny(status, message) {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function parseIdList(raw) {
  const out = new Set();
  for (const part of (raw ?? '').split(',')) {
    const id = baseProjectId(part.trim());
    if (id) out.add(id);
  }
  return out;
}

// Lokalise addresses a branch as "{project_id}:{branch}". Compare on the base
// id so the allowlist covers every branch of an allowed project.
function baseProjectId(id) {
  return id.split(':')[0];
}

async function tokenAllowed(token, allowedProjects) {
  const key = await sha256Hex(token);
  const hit = verdicts.get(key);
  if (hit && hit.expires > Date.now()) return hit.ok;

  let ok = false;
  try {
    const r = await fetch(`${UPSTREAM}/api2/projects?limit=100`, {
      headers: { 'X-Api-Token': token },
    });
    if (r.ok) {
      const body = await r.json();
      ok = (body?.projects ?? []).some(p => allowedProjects.has(baseProjectId(p.project_id ?? '')));
    }
  } catch {
    // Upstream unreachable — deny, but with the short TTL so a Lokalise blip
    // doesn't lock the plugin out for long.
    ok = false;
  }

  if (verdicts.size >= MAX_CACHE_ENTRIES) verdicts.clear();
  verdicts.set(key, { ok, expires: Date.now() + (ok ? OK_TTL_MS : DENY_TTL_MS) });
  return ok;
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Constant-time compare so the shared key can't be recovered byte-by-byte.
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function stripHopByHop(headers) {
  const out = new Headers();
  // x-proxy-key is ours — Lokalise must never see it.
  const drop = new Set(['host', 'origin', 'referer', 'connection', 'cf-connecting-ip', 'x-proxy-key']);
  for (const [k, v] of headers.entries()) {
    if (!drop.has(k.toLowerCase())) out.set(k, v);
  }
  return out;
}
