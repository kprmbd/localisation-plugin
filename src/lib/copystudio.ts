// Copy Studio client — translation + localisation-key generation.
//
// The plugin talks to the Copy Studio MCP server DIRECTLY, authenticating with
// a long-lived Copy Studio access token that the user pastes into Settings
// (same pattern as the Lokalise token). Copy Studio owns the brand voice,
// glossary and per-language register and runs the model server-side, so no LLM
// API key is involved anywhere in the plugin.
//
// Transport: MCP streamable-HTTP — initialize → (initialized) → tools/call.
// Handles session-based and sessionless servers, JSON or SSE responses.
// Requests go through sandboxFetch because the plugin iframe is a null origin.

import { sandboxFetch, type HttpResult } from './bridge';
import { copyStudioLang } from './tov';
import { COPYSTUDIO_MCP_URL } from '../config';

export { COPYSTUDIO_MCP_URL };
const MCP_PROTOCOL_VERSION = '2025-06-18';
// Strings per translate_copy call. Keep this HIGH: every call is a separate
// LLM invocation that re-sends the whole tone-of-voice system prompt, so the
// per-call overhead — both latency and Lovable credits — dominates. Halving
// the batch size roughly doubles the cost of translating the same frame.
// Reliability comes from retry + per-batch error tolerance below, not from
// small batches.
const BATCH_SIZE = 20;

export interface TranslateRequest {
  strings: Array<{ key: string; text: string }>;
  language: string; // UI code, e.g. "SV" / "PT-BR" — mapped to Copy Studio's code here
  channel: string;
  token: string;
  onProgress?: (done: number, total: number) => void;
}

export interface TranslateResult {
  key: string;
  translation: string;
}

// Translate strings into one language via Copy Studio's translate_copy tool.
// Every input key is returned (empty string if Copy Studio omitted a row).
export async function translate(req: TranslateRequest): Promise<TranslateResult[]> {
  const target = copyStudioLang(req.language);
  const out: TranslateResult[] = [];
  let done = 0;
  let okBatches = 0;
  let lastErr: unknown;

  for (let i = 0; i < req.strings.length; i += BATCH_SIZE) {
    const batch = req.strings.slice(i, i + BATCH_SIZE);
    try {
      const raw = await callTool(req.token, 'translate_copy', {
        target_language: target,
        channel: req.channel,
        strings: batch,
      });
      const data = parseJson(raw) as { translations?: Array<{ key?: unknown; translation?: unknown }> };
      const map = new Map<string, string>();
      for (const row of data.translations ?? []) {
        map.set(String(row.key ?? ''), String(row.translation ?? ''));
      }
      for (const s of batch) out.push({ key: s.key, translation: map.get(s.key) ?? '' });
      okBatches++;
    } catch (err) {
      // One bad batch shouldn't discard the whole language. Leave these rows
      // empty and carry on — re-running "Add missing translations" fills the
      // gaps, since the caller only ever fills empty cells.
      lastErr = err;
      for (const s of batch) out.push({ key: s.key, translation: '' });
    }

    done += batch.length;
    req.onProgress?.(done, req.strings.length);
  }

  // Nothing at all came back → report it as a failed language.
  if (okBatches === 0 && lastErr) throw lastErr;
  return out;
}

// ─── Key generation ──────────────────────────────────────────────────────────

export interface KeyGenResult {
  id: string;
  key: string;
  error?: string;
}

// Generate a localisation key per layer via Copy Studio's generate_key tool.
// Copy Studio guarantees uniqueness against `existing_keys`; we also track a
// local `used` set and suffix-dedupe as a safety net across the batch.
export async function generateKeysFor(
  layers: Array<{ id: string; frameName: string; path: string; text: string }>,
  existingKeys: string[],
  token: string,
  onProgress?: (done: number, total: number) => void,
): Promise<KeyGenResult[]> {
  const results: KeyGenResult[] = [];
  const used = new Set(existingKeys);

  for (let i = 0; i < layers.length; i++) {
    const l = layers[i];
    try {
      const raw = await callTool(token, 'generate_key', {
        frame_name: l.frameName,
        layer_path: l.path,
        text: l.text,
        existing_keys: [...used],
      });
      const data = parseJson(raw) as { key?: unknown };
      const key = String(data.key ?? '').trim();
      if (!key) throw new Error('Copy Studio returned an empty key.');
      let candidate = key;
      let suffix = 2;
      while (used.has(candidate)) candidate = `${key}_${suffix++}`;
      used.add(candidate);
      results.push({ id: l.id, key: candidate });
    } catch (err) {
      results.push({ id: l.id, key: '', error: err instanceof Error ? err.message : String(err) });
    }
    onProgress?.(i + 1, layers.length);
  }

  return results;
}

// ─── Connection check ────────────────────────────────────────────────────────

// Cheap round-trip used by the Settings "Test connection" button: lists the
// server's tools, proving URL + token + protocol all work.
export async function testConnection(token: string): Promise<string[]> {
  // The token may have just been edited — never reuse a handshake made with
  // the old one.
  resetHandshake();
  const { sessionId } = await getHandshake(token);
  const res = await mcpPost(token, sessionId, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
    params: {},
  });
  const msg = res.message;
  if (!msg) throw new Error('empty response to tools/list');
  if (msg.error) throw new Error(msg.error.message || JSON.stringify(msg.error));
  const tools = (msg.result?.tools ?? []) as Array<{ name?: string }>;
  return tools.map(t => String(t.name ?? '')).filter(Boolean);
}

// ─── MCP transport ───────────────────────────────────────────────────────────

interface JsonRpcMessage {
  result?: any;
  error?: { message?: string };
  jsonrpc?: string;
}

// The handshake is done ONCE and reused, not per tool call. Re-handshaking
// every call tripled the HTTP round-trips (initialize + initialized +
// tools/call) for no benefit: the server is effectively sessionless from our
// side, since Figma's fetch doesn't expose the Mcp-Session-Id response header.
// If the server ever rejects a call for want of initialisation, callTool
// clears this and handshakes again.
let handshakePromise: Promise<{ sessionId: string | null }> | null = null;

function resetHandshake(): void {
  handshakePromise = null;
}

function getHandshake(token: string): Promise<{ sessionId: string | null }> {
  if (!handshakePromise) {
    handshakePromise = doHandshake(token).catch(err => {
      handshakePromise = null; // don't cache a failure
      throw err;
    });
  }
  return handshakePromise;
}

// initialize (+ initialized notification) → returns the session id, if any.
async function doHandshake(token: string): Promise<{ sessionId: string | null }> {
  const init = await mcpPost(token, null, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'lifesum-localise-plugin', version: '1.0.0' },
    },
  });
  const sessionId = init.sessionId;
  // Best-effort per spec; some servers require it, sessionless ones ignore it.
  await mcpPost(token, sessionId, {
    jsonrpc: '2.0',
    method: 'notifications/initialized',
  }).catch(() => {});
  return { sessionId };
}

// Retry transient failures. Translating many languages fans out a lot of
// requests, and Copy Studio can rate-limit or drop some; without this they
// surface as silently-missing languages.
const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 800;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Retryable: network-level failure (0), timeout, rate limit, server error.
// NOT retryable: 401/403 (bad token) or other 4xx (bad request) — those won't
// improve by trying again.
function isTransient(status: number | undefined): boolean {
  if (status === undefined) return false;
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

// Call one Copy Studio MCP tool and return the joined text of its result
// content (these tools return their JSON payload as text). Retries transient
// failures with exponential backoff.
async function callTool(token: string, name: string, args: unknown): Promise<string> {
  if (!token) throw new Error('Copy Studio token missing (Settings ⚙).');
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await callToolOnce(token, name, args);
    } catch (err) {
      lastErr = err;
      const status = (err as { status?: number }).status;
      // A stale/absent session shows up as 404 or a "not initialized" error —
      // re-handshake once and let the retry below re-issue the call.
      const message = err instanceof Error ? err.message.toLowerCase() : '';
      const needsInit = status === 404
        || message.indexOf('session') !== -1
        || message.indexOf('initial') !== -1;
      if (needsInit && attempt < MAX_ATTEMPTS) {
        resetHandshake();
        continue;
      }
      if (attempt === MAX_ATTEMPTS || !isTransient(status)) throw err;
      await sleep(RETRY_BASE_MS * Math.pow(2, attempt - 1));
    }
  }
  throw lastErr;
}

async function callToolOnce(token: string, name: string, args: unknown): Promise<string> {
  const { sessionId } = await getHandshake(token);

  const res = await mcpPost(token, sessionId, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name, arguments: args },
  });

  const msg = res.message;
  if (!msg) throw new Error('empty response to tools/call');
  if (msg.error) throw new Error(msg.error.message || JSON.stringify(msg.error));
  const result = msg.result || {};
  const out = extractText(result);
  if (result.isError) throw new Error(out || 'tool returned isError');
  if (!out) throw new Error(`Copy Studio returned no content for ${name}.`);
  return out;
}

// POST one JSON-RPC message. Returns the parsed message (null for
// notifications / empty 202 bodies) plus the session id to carry forward.
async function mcpPost(
  token: string,
  sessionId: string | null,
  payload: unknown,
): Promise<{ message: JsonRpcMessage | null; sessionId: string | null }> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'accept': 'application/json, text/event-stream',
    'MCP-Protocol-Version': MCP_PROTOCOL_VERSION,
    'Authorization': `Bearer ${token}`,
  };
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;

  const r: HttpResult = await sandboxFetch(COPYSTUDIO_MCP_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });

  const sid = r.headers['mcp-session-id'] || sessionId || null;
  if (!r.ok) {
    const err = r.status === 401 || r.status === 403
      ? new Error(`Copy Studio rejected the token (${r.status}). Check the token in Settings ⚙.`)
      : new Error(`Copy Studio HTTP ${r.status}: ${r.body.slice(0, 200)}`);
    // Tag with the status so callTool can decide whether a retry is worthwhile.
    (err as Error & { status?: number }).status = r.status;
    throw err;
  }

  let message: JsonRpcMessage | null = null;
  if (r.body.trim()) message = parseBody(r.body);
  return { message, sessionId: sid };
}

// Parse a response body into a JSON-RPC message. We sniff the body rather than
// trusting content-type: Figma's sandbox fetch may not expose response headers
// at all, so JSON vs SSE has to be detectable from the payload itself.
function parseBody(body: string): JsonRpcMessage {
  const t = body.trim();
  if (t.charAt(0) === '{' || t.charAt(0) === '[') {
    try {
      return JSON.parse(t);
    } catch {
      // Fall through — some servers prefix JSON with SSE framing.
    }
  }
  return parseSse(body);
}

// Extract the JSON-RPC object from an SSE stream (event: message / data: {…}).
function parseSse(body: string): JsonRpcMessage {
  const dataLines: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const m = /^data:\s?(.*)$/.exec(line);
    if (m) dataLines.push(m[1]);
  }
  const candidates = dataLines.length ? [dataLines.join('\n'), ...dataLines] : [];
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      const o = JSON.parse(candidates[i]);
      if (o && (o.result || o.error || o.jsonrpc)) return o;
    } catch { /* keep scanning */ }
  }
  throw new Error('could not parse SSE response');
}

// Join the text parts of an MCP tool result's content array.
function extractText(result: any): string {
  if (!result) return '';
  if (Array.isArray(result.content)) {
    return result.content
      .filter((c: any) => c && c.type === 'text' && typeof c.text === 'string')
      .map((c: any) => c.text)
      .join('\n')
      .trim();
  }
  if (typeof result.text === 'string') return result.text.trim();
  return '';
}

// Parse a tool's text payload as JSON, tolerating a prose/fence wrapper.
function parseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    const a = s.indexOf('{');
    const b = s.lastIndexOf('}');
    if (a !== -1 && b !== -1 && b > a) return JSON.parse(s.slice(a, b + 1));
    throw new Error('Copy Studio tool did not return JSON');
  }
}
