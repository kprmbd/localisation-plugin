/// <reference types="@figma/plugin-typings" />

import type { Layer, PluginMsg, ScanResult, UIMsg } from './types';
import { TAG_RE } from './types';

figma.showUI(__html__, { width: 380, height: 620, title: 'Lifesum Localise' });

// Stream Figma's selection to the UI so it can auto-filter the Manage list to
// the layer the designer is currently editing. The UI doesn't know which IDs
// belong to its scanned frame vs unrelated nodes — that filtering happens
// there. We just send every selected text node ID.
figma.on('selectionchange', () => {
  const ids: string[] = [];
  for (const n of figma.currentPage.selection) {
    if (n.type === 'TEXT') ids.push(n.id);
  }
  figma.ui.postMessage({ t: 'selection-changed', nodeIds: ids });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildPath(node: BaseNode): string {
  const parts: string[] = [];
  let cur: BaseNode | null = node.parent;
  while (cur && cur.type !== 'PAGE' && cur.type !== 'DOCUMENT') {
    if ('name' in cur) parts.unshift(cur.name as string);
    cur = cur.parent;
  }
  return parts.join(' > ');
}

function collectTextLayers(node: SceneNode, out: Layer[]): void {
  if (node.type === 'TEXT') {
    const match = node.name.match(TAG_RE);
    out.push({
      id: node.id,
      text: node.characters,
      key: match ? match[1] : null,
      path: buildPath(node),
      name: node.name,
    });
  }
  if ('children' in node) {
    for (const child of (node as ChildrenMixin).children) {
      collectTextLayers(child, out);
    }
  }
}

function* walkText(node: SceneNode): Iterable<TextNode> {
  if (node.type === 'TEXT') yield node;
  if ('children' in node) {
    for (const c of (node as ChildrenMixin).children) yield* walkText(c);
  }
}

async function loadFonts(node: SceneNode): Promise<void> {
  const fonts = new Map<string, FontName>();
  for (const t of walkText(node)) {
    for (let i = 0; i < t.characters.length; i++) {
      const f = t.getRangeFontName(i, i + 1);
      if (typeof f !== 'symbol' && 'family' in f) {
        fonts.set(`${f.family}::${f.style}`, f as FontName);
      }
    }
  }
  await Promise.all([...fonts.values()].map(f => figma.loadFontAsync(f)));
}

async function applyByKey(node: SceneNode, translations: Record<string, string>): Promise<void> {
  if (node.type === 'TEXT') {
    const match = node.name.match(TAG_RE);
    if (match) {
      const v = translations[match[1]];
      if (v) node.characters = v;
    }
  }
  if ('children' in node) {
    for (const c of (node as ChildrenMixin).children) await applyByKey(c, translations);
  }
}

async function applyByOrder(
  original: SceneNode,
  clone: SceneNode,
  translationsByNodeId: Record<string, string>,
): Promise<void> {
  const originals = [...walkText(original)];
  const clones = [...walkText(clone)];
  const len = Math.min(originals.length, clones.length);
  for (let i = 0; i < len; i++) {
    const v = translationsByNodeId[originals[i].id];
    if (v) clones[i].characters = v;
  }
}

function send(msg: PluginMsg): void {
  figma.ui.postMessage(msg);
}

// Normalise a fetch Response's headers to a lower-cased plain object.
// Figma's sandbox fetch is a shim: `headers` may be a real Headers, an
// iterable, a { get() } object, a plain object, or missing entirely. Never
// throws — callers treat the result as best-effort.
function readHeaders(h: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  try {
    const any = h as any;
    if (typeof any.forEach === 'function') {
      any.forEach((v: string, k: string) => { out[String(k).toLowerCase()] = String(v); });
    } else if (typeof any.entries === 'function') {
      for (const [k, v] of any.entries()) out[String(k).toLowerCase()] = String(v);
    } else if (typeof any.get === 'function') {
      // Can't enumerate — pull just the ones the MCP transport cares about.
      for (const k of ['mcp-session-id', 'content-type']) {
        const v = any.get(k);
        if (v != null) out[k] = String(v);
      }
    } else if (typeof any === 'object') {
      for (const k of Object.keys(any)) {
        const v = any[k];
        if (typeof v === 'string' || typeof v === 'number') out[String(k).toLowerCase()] = String(v);
      }
    }
  } catch (_) { /* best-effort */ }
  return out;
}

async function cloneAndPlace(frame: FrameNode, lang: string): Promise<FrameNode> {
  const clone = frame.clone();
  clone.name = `${frame.name} [${lang.toUpperCase()}]`;

  // Stagger: find existing translated siblings (same base name with [LANG]
  // suffix) and place to the right of the rightmost one. This avoids
  // N overlapping clones when the user creates frames for many languages.
  const prefix = `${frame.name} [`;
  let rightEdge = frame.x + frame.width;
  if (frame.parent && 'children' in frame.parent) {
    const siblings = (frame.parent as ChildrenMixin).children;
    for (const c of siblings) {
      if (c === frame || c === clone) continue;
      if (c.name.indexOf(prefix) !== 0) continue;
      if (!('x' in c) || !('width' in c)) continue;
      const edge = (c as LayoutMixin).x + (c as LayoutMixin).width;
      if (edge > rightEdge) rightEdge = edge;
    }
  }
  clone.x = rightEdge + 80;
  clone.y = frame.y;
  if (frame.parent) frame.parent.appendChild(clone);
  await loadFonts(clone);
  return clone;
}

// ─── Message handler ─────────────────────────────────────────────────────────

figma.ui.onmessage = async (msg: UIMsg) => {
  try {
    switch (msg.t) {
      case 'scan': {
        const selection = figma.currentPage.selection;
        if (selection.length === 0) {
          send({ t: 'scan-empty' });
          return;
        }
        const top = selection[0];
        const layers: Layer[] = [];
        if (top.type === 'TEXT') collectTextLayers(top, layers);
        else if ('children' in top) collectTextLayers(top, layers);

        const result: ScanResult = { frameId: top.id, frameName: top.name, layers };
        send({ t: 'scan-result', result });
        break;
      }

      case 'rename': {
        const node = figma.getNodeById(msg.id) as SceneNode | null;
        if (!node) return send({ t: 'err', message: `Layer not found.` });
        node.name = msg.name;
        send({ t: 'renamed', id: msg.id, name: msg.name });
        break;
      }

      case 'set-text': {
        // Used when the user assigns an existing Lokalise key — we replace the
        // Figma text with the Lokalise English source so the frame stays in
        // sync with the canonical copy.
        const node = figma.getNodeById(msg.id) as SceneNode | null;
        if (!node || node.type !== 'TEXT') return send({ t: 'err', message: 'Text node not found.' });
        await loadFonts(node);
        (node as TextNode).characters = msg.characters;
        send({ t: 'text-set', id: msg.id, characters: msg.characters });
        break;
      }

      case 'dupe-by-key': {
        const frame = figma.getNodeById(msg.frameId) as FrameNode | null;
        if (!frame) return send({ t: 'err', message: 'Frame not found.' });
        const clone = await cloneAndPlace(frame, msg.lang);
        await applyByKey(clone, msg.translations);
        figma.viewport.scrollAndZoomIntoView([clone]);
        send({ t: 'duped', frameName: clone.name });
        break;
      }

      case 'dupe-by-order': {
        const frame = figma.getNodeById(msg.frameId) as FrameNode | null;
        if (!frame) return send({ t: 'err', message: 'Frame not found.' });
        const clone = await cloneAndPlace(frame, msg.lang);
        await applyByOrder(frame, clone, msg.translationsByNodeId);
        figma.viewport.scrollAndZoomIntoView([clone]);
        send({ t: 'duped', frameName: clone.name });
        break;
      }

      case 'load-settings': {
        const stored = await figma.clientStorage.getAsync('settings') as Record<string, string> | undefined;
        send({ t: 'settings', settings: stored ?? {} });
        break;
      }

      case 'save-settings': {
        await figma.clientStorage.setAsync('settings', msg.settings);
        send({ t: 'saved' });
        break;
      }

      case 'http': {
        // UI iframe runs at null origin → most APIs block it. Sandbox fetch
        // (this block) runs in the plugin process with no CORS, provided the
        // domain is in manifest.json → networkAccess.allowedDomains.
        console.log('[http] →', msg.method ?? 'GET', msg.url);
        try {
          const init: RequestInit = { method: msg.method ?? 'GET' };
          if (msg.headers) init.headers = msg.headers;
          if (msg.body) init.body = msg.body;
          const res = await fetch(msg.url, init);
          const body = await res.text();
          console.log('[http] ←', res.status, `${body.length}b`);
          if (!res.ok) console.log('[http] body:', body.slice(0, 500));
          // Surface response headers — the MCP transport uses Mcp-Session-Id
          // and content-type (JSON vs SSE). Figma's sandbox fetch does NOT
          // return a standard Headers object, so probe every shape and treat
          // headers as best-effort: the MCP client works sessionless and
          // sniffs the body when these are missing.
          send({
            t: 'http-result',
            requestId: msg.requestId,
            ok: res.ok,
            status: res.status,
            body,
            headers: readHeaders(res.headers),
          });
        } catch (err) {
          let m: string;
          if (err instanceof Error) m = err.message;
          else if (typeof err === 'string') m = err;
          else {
            try { m = JSON.stringify(err); } catch { m = Object.prototype.toString.call(err); }
          }
          console.error('[http] ✗', msg.url, err, '→', m);
          send({ t: 'http-result', requestId: msg.requestId, ok: false, status: 0, body: m });
        }
        break;
      }
    }
  } catch (err) {
    send({ t: 'err', message: err instanceof Error ? err.message : String(err) });
  }
};
