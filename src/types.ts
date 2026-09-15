// Shared types between code.ts (Figma sandbox) and the UI iframe.

// Layer-name tags persisted on the Figma node so the user's choices survive
// a rescan or a hand-off to another machine.
//   [localise:key.path]  → the layer is mapped to a Lokalise key
//   [localise-skip]      → the layer is dynamic / skipped (no localisation)
// The two tags are mutually exclusive — assigning a key removes the skip tag,
// and skipping removes any key tag.
export const TAG_RE = /^\[localise:([^\]]+)\]\s*/;
export const SKIP_RE = /^\[localise-skip\]\s*/;

function strip(name: string): string {
  return name.replace(TAG_RE, '').replace(SKIP_RE, '');
}

export function tagName(key: string, original: string): string {
  return `[localise:${key}] ${strip(original)}`;
}

export function skipTagName(original: string): string {
  return `[localise-skip] ${strip(original)}`;
}

export function clearTagName(original: string): string {
  return strip(original);
}

export interface Layer {
  id: string;           // Figma node ID — stable within a session
  text: string;         // current text content
  key: string | null;   // parsed [localise:...] tag; null = unmapped
  path: string;         // "Card > Body > Label" — context for AI key gen
  name: string;         // raw layer name (may include tag)
}

export interface ScanResult {
  frameId: string;
  frameName: string;
  layers: Layer[];
}

export type Mode = 'translate' | 'manage';

// ── UI → sandbox ─────────────────────────────────────────────────────────────
export type UIMsg =
  | { t: 'scan' }
  | { t: 'rename'; id: string; name: string }
  | { t: 'set-text'; id: string; characters: string }
  | { t: 'dupe-by-key'; frameId: string; lang: string; translations: Record<string, string> }
  | { t: 'dupe-by-order'; frameId: string; lang: string; translationsByNodeId: Record<string, string> }
  | { t: 'load-settings' }
  | { t: 'save-settings'; settings: Record<string, string> }
  | {
      t: 'http';
      requestId: string;
      url: string;
      method?: string;
      headers?: Record<string, string>;
      body?: string;
    };

// ── sandbox → UI ─────────────────────────────────────────────────────────────
export type PluginMsg =
  | { t: 'scan-result'; result: ScanResult }
  | { t: 'scan-empty' }
  | { t: 'renamed'; id: string; name: string }
  | { t: 'text-set'; id: string; characters: string }
  | { t: 'selection-changed'; nodeIds: string[] }
  | { t: 'duped'; frameName: string }
  | { t: 'settings'; settings: Record<string, string> }
  | { t: 'saved' }
  | { t: 'err'; message: string }
  | { t: 'http-result'; requestId: string; ok: boolean; status: number; body: string; headers?: Record<string, string> };

// ── Dynamic-text detection ───────────────────────────────────────────────────
// A text layer is "dynamic" if its content is purely numeric/unit/placeholder
// — e.g. "100 kcal", "25%", "{count}", "12:30". These come from the backend at
// runtime, so localising the static layer adds no value. We auto-ignore them
// at scan time.
//
// Heuristic: ignore layers that (a) contain no letters at all (pure digits /
// punct), OR (b) contain only digits + recognised units + whitespace +
// placeholders after stripping.
const UNIT_WORDS = /\b(?:kcal|cal|kj|kg|mg|mcg|ml|dl|cl|oz|lb|tsp|tbsp|cup|cups|min|mins|hrs?|hours?|sec|secs|steps?|bpm|km|mi|g|l|m|s|h)\b/gi;
const PLACEHOLDERS = /\{[^}]*\}|%[sd@]|%\d+\$[sd@]/g;

export function isDynamicText(raw: string): boolean {
  const s = raw.trim();
  if (s === '') return false;
  // Pure-placeholder strings like "{count}" are dynamic even without digits.
  const afterPlaceholders = s.replace(PLACEHOLDERS, '').trim();
  if (afterPlaceholders === '') return true;
  // If there are no digits anywhere, it's real copy (e.g. "Steps", "Welcome").
  if (!/\d/.test(s)) return false;
  // Strip units + % sign. What remains should be only digits/whitespace/punct.
  const stripped = afterPlaceholders
    .replace(UNIT_WORDS, '')
    .replace(/%/g, '')
    .trim();
  if (stripped === '') return true;
  return /^[\d\s.,:\-/]+$/.test(stripped);
}
