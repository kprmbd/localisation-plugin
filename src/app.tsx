import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Layer, Mode, PluginMsg, UIMsg } from './types';
import { clearTagName, isDynamicText, skipTagName, SKIP_RE, tagName, TAG_RE } from './types';
import { CHANNELS, LANG_CODES, LANGUAGES } from './lib/tov';
import { translate, generateKeysFor, testConnection } from './lib/copystudio';
import { getAllKeyTranslations, getProjectLanguages } from './lib/localise';
import { download, toCsv, type Row } from './lib/csv';
import { ui } from './ui-kit';

// ─── Types ────────────────────────────────────────────────────────────────────
interface Settings {
  copyStudioToken: string; // Copy Studio access token — AI translation + key generation
  localiseKey: string;
}
const EMPTY_SETTINGS: Settings = { copyStudioToken: '', localiseKey: '' };

type Screen =
  | { k: 'welcome' }
  | { k: 'mode-picker' }
  | { k: 'translate' }
  | { k: 'manage' }
  | { k: 'settings' };

// Translations are always keyed by Layer.id (stable within a session).
type LayerTranslations = Record<string, string>;           // layerId → text
type AllTranslations = Record<string, LayerTranslations>;  // lang → layerId → text

// Provenance of each layer's assigned key — drives the badge in the UI.
type KeySource = 'existing' | 'lokalise' | 'new';

// ─── Plugin messaging ────────────────────────────────────────────────────────
function send(msg: UIMsg): void {
  parent.postMessage({ pluginMessage: msg }, '*');
}

// How many languages to translate at once. Each language costs several HTTP
// round-trips (MCP handshake + tools/call per 20-string batch), so firing all
// 13 at once overwhelmed Copy Studio and some silently failed. A small pool is
// barely slower in practice and far more reliable.
const TRANSLATE_CONCURRENCY = 3;

// Run `fn` over `items` with at most `limit` in flight. Unlike Promise.all,
// this bounds the request fan-out. `fn` must handle its own errors — a throw
// here would abort the remaining work.
async function runPool<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workerCount = Math.min(limit, items.length);
  const workers: Array<Promise<void>> = [];
  for (let w = 0; w < workerCount; w++) {
    workers.push((async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        await fn(items[i]);
      }
    })());
  }
  await Promise.all(workers);
}

// Normalise a UI code ("SV", "PT-BR") to Lokalise ISO shape ("sv", "pt_br").
// This is only a *fallback* — when we have the project's actual language
// list from Lokalise, prefer `resolveLokaliseIso` which returns the EXACT
// iso (case + family preserved). Lokalise stores "pt_BR", "nb_NO", "ru_RU"
// — naive lowercase guessing misses those.
function toIso(code: string): string {
  return code.toLowerCase().replace(/-/g, '_');
}

// Pick the variant with the most populated translations across all keys.
// Used when a UI code maps to multiple Lokalise variants (e.g. "NO" could
// match "no", "nb", "nb_NO" — pick whichever the team actually filled in).
function pickRichestIso(
  candidates: string[],
  localiseMap: Record<string, Record<string, string>>,
): string {
  let best = candidates[0];
  let bestCount = -1;
  for (const c of candidates) {
    let count = 0;
    for (const perLang of Object.values(localiseMap)) {
      if (perLang[c]) count++;
    }
    if (count > bestCount) {
      bestCount = count;
      best = c;
    }
  }
  return best;
}

// Resolve a UI code (e.g. "NO", "PT-BR") to the EXACT Lokalise lang_iso.
// Strategy:
//   1. Case-insensitive exact match against project's lang_iso list.
//      Fixes "PT-BR" → "pt_BR" (Lokalise capitalises region) where naive
//      lowercase would miss.
//   2. Norwegian family — "NO" matches no/nb/nn/nb_NO/nn_NO; pick richest.
//   3. Same primary code — "DE" matches "de_DE" if "de" itself isn't there.
//   4. Fallback to lowercase normalisation.
function resolveLokaliseIso(
  uiCode: string,
  projectIsos: string[],
  localiseMap: Record<string, Record<string, string>>,
): string {
  const normalized = uiCode.toLowerCase().replace(/-/g, '_');
  const primary = normalized.split('_')[0];

  // 1. Case-insensitive exact match
  const exact = projectIsos.find(p => p.toLowerCase() === normalized);
  if (exact) return exact;

  // 2. Norwegian: "NO" → any of no/nb/nn (+ regional variants)
  if (primary === 'no') {
    const norwegian = projectIsos.filter(p => {
      const lp = p.toLowerCase();
      return /^(no|nb|nn)(_|$)/.test(lp);
    });
    if (norwegian.length > 0) return pickRichestIso(norwegian, localiseMap);
  }

  // 3. Same primary language — pick richest variant
  const sameFamily = projectIsos.filter(
    p => p.toLowerCase().split('_')[0] === primary,
  );
  if (sameFamily.length > 0) return pickRichestIso(sameFamily, localiseMap);

  // 4. Last resort
  return normalized;
}

// Pull the English source text from a Lokalise key's translations map, if any.
// Lokalise projects usually use `en`, but some use `en_US` / `en_GB` — match
// any iso starting with "en".
function englishFromLokalise(perLang: Record<string, string> | undefined): string | null {
  if (!perLang) return null;
  const exact = perLang['en'];
  if (exact) return exact;
  for (const [iso, text] of Object.entries(perLang)) {
    if (iso.toLowerCase().indexOf('en') === 0 && text) return text;
  }
  return null;
}

// ─── App ─────────────────────────────────────────────────────────────────────
export default function App() {
  const [settings, setSettings] = useState<Settings>(EMPTY_SETTINGS);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [screen, setScreen] = useState<Screen>({ k: 'welcome' });

  // Scanned frame
  const [frameId, setFrameId] = useState('');
  const [frameName, setFrameName] = useState('');
  const [layers, setLayers] = useState<Layer[]>([]);
  const [ignored, setIgnored] = useState<Set<string>>(new Set());
  const [keySource, setKeySource] = useState<Record<string, KeySource>>({});

  // Lokalise cache
  const [localiseKeys, setLocaliseKeys] = useState<string[]>([]);
  const [localiseMap, setLocaliseMap] = useState<Record<string, Record<string, string>>>({});
  const [localiseLoaded, setLocaliseLoaded] = useState(false);
  // UI code ("SV", "PT-BR") → exact Lokalise lang_iso ("sv", "pt_BR").
  // Populated when Lokalise data loads; before that, lookups fall back to
  // toIso() which works for simple codes but not for capitalised regions.
  const [lokaliseIsoMap, setLokaliseIsoMap] = useState<Record<string, string>>({});

  // Shared work state
  const [channel, setChannel] = useState('product');
  const [selectedLangs, setSelectedLangs] = useState<string[]>(['SV']);
  const [translations, setTranslations] = useState<AllTranslations>({});
  const [searchQuery, setSearchQuery] = useState('');

  // Manage-mode state
  const [sortNoKeysFirst, setSortNoKeysFirst] = useState(true);
  const [suggestions, setSuggestions] = useState<Record<string, string>>({});
  // Streamed from Figma — when the designer selects a text layer in the
  // canvas, we narrow the Manage list to that one row.
  const [selectedNodeIds, setSelectedNodeIds] = useState<Set<string>>(new Set());

  // Flow state
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<{ kind: 'ok' | 'err' | 'info'; text: string } | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  const hasCopyStudio = settings.copyStudioToken.trim().length > 0;
  const hasLocalise = settings.localiseKey.trim().length > 0;
  const activeLayers = useMemo(() => layers.filter(l => !ignored.has(l.id)), [layers, ignored]);
  const mapped = useMemo(() => activeLayers.filter(l => l.key), [activeLayers]);
  const unmapped = useMemo(() => activeLayers.filter(l => !l.key), [activeLayers]);

  // ── Load settings on mount ─────────────────────────────────────────────────
  useEffect(() => {
    send({ t: 'load-settings' });
  }, []);

  // ── Auto-pull Lokalise translations into local state ───────────────────────
  // Whenever Lokalise is loaded, mapped layers change, or the user toggles
  // languages, copy any Lokalise translation we have into the per-cell state.
  // Never overrides a user edit or AI result — only fills empty cells. This
  // means runTranslate's gap-fill logic naturally skips these (no AI re-call).
  useEffect(() => {
    if (!localiseLoaded) return;
    if (selectedLangs.length === 0 || mapped.length === 0) return;
    setTranslations(prev => {
      let changed = false;
      const next: AllTranslations = { ...prev };
      for (const layer of mapped) {
        const lokalised = localiseMap[layer.key!];
        if (!lokalised) continue;
        for (const lang of selectedLangs) {
          // Use the resolved Lokalise iso (e.g. "pt_BR", "nb_NO") so case
          // and regional variants don't cause false-empty cells. Fall back
          // to toIso() if the iso map isn't built yet (Lokalise still
          // loading) — auto-seed will re-run when it lands.
          const iso = lokaliseIsoMap[lang] ?? toIso(lang);
          const value = lokalised[iso];
          if (!value) continue;
          if (next[lang]?.[layer.id]) continue; // don't override
          next[lang] = { ...(next[lang] ?? {}), [layer.id]: value };
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [localiseLoaded, mapped, selectedLangs, localiseMap, lokaliseIsoMap]);

  // ── Plugin → UI messages ───────────────────────────────────────────────────
  useEffect(() => {
    const handler = (ev: MessageEvent) => {
      const msg = ev.data?.pluginMessage as PluginMsg | undefined;
      if (!msg) return;
      switch (msg.t) {
        case 'settings': {
          const s: Settings = {
            copyStudioToken: msg.settings.copyStudioToken ?? '',
            localiseKey: msg.settings.localiseKey ?? '',
          };
          setSettings(s);
          setSettingsLoaded(true);
          if (!s.copyStudioToken) setScreen({ k: 'settings' });
          break;
        }
        case 'saved':
          setStatus({ kind: 'ok', text: 'Settings saved.' });
          break;
        case 'scan-result': {
          const { result } = msg;
          setFrameId(result.frameId);
          setFrameName(result.frameName);
          setLayers(result.layers);

          // Three sources of "skip" on scan:
          //   1. Persisted [localise-skip] tag on the layer name (user
          //      previously marked it dynamic — definitive).
          //   2. Pure-dynamic regex match on the text ("100 kcal",
          //      "{count}"…) — fallback when no tag is present.
          //   3. Empty layers don't auto-skip; they fall through.
          // Seed provenance for already-keyed layers so the badge shows
          // "existing" instead of "new".
          const autoIgnore = new Set<string>();
          const ks: Record<string, KeySource> = {};
          for (const l of result.layers) {
            if (SKIP_RE.test(l.name)) autoIgnore.add(l.id);
            else if (isDynamicText(l.text)) autoIgnore.add(l.id);
            if (l.key) ks[l.id] = 'existing';
          }
          setIgnored(autoIgnore);
          setKeySource(ks);
          setSuggestions({});
          setTranslations({});
          setSearchQuery('');
          setStatus(autoIgnore.size > 0
            ? { kind: 'info', text: `Ignored ${autoIgnore.size} dynamic value${autoIgnore.size > 1 ? 's' : ''} (numbers, units, placeholders).` }
            : null);
          setScreen({ k: 'mode-picker' });
          break;
        }
        case 'scan-empty':
          setStatus({ kind: 'err', text: 'Select a frame in Figma, then click Scan.' });
          break;
        case 'renamed':
          setLayers(prev => prev.map(l =>
            l.id === msg.id
              ? { ...l, name: msg.name, key: TAG_RE.exec(msg.name)?.[1] ?? null }
              : l,
          ));
          // Keep `ignored` consistent with the new tag state. Skip-tagged
          // names go in; everything else (key tags, untagged) comes out.
          setIgnored(prev => {
            const n = new Set(prev);
            if (SKIP_RE.test(msg.name)) n.add(msg.id);
            else n.delete(msg.id);
            return n;
          });
          setSuggestions(prev => { const n = { ...prev }; delete n[msg.id]; return n; });
          break;
        case 'text-set':
          // Lokalise-driven text replacement landed — sync our local text.
          setLayers(prev => prev.map(l =>
            l.id === msg.id ? { ...l, text: msg.characters } : l,
          ));
          break;
        case 'selection-changed':
          setSelectedNodeIds(new Set(msg.nodeIds));
          break;
        case 'duped':
          setStatus({ kind: 'ok', text: `Created "${msg.frameName}".` });
          setBusy(null);
          break;
        case 'err':
          setStatus({ kind: 'err', text: msg.message });
          setBusy(null);
          break;
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  // ── Actions ────────────────────────────────────────────────────────────────
  const scan = useCallback(() => {
    setStatus(null);
    send({ t: 'scan' });
  }, []);

  const pickMode = useCallback((m: Mode) => {
    setScreen({ k: m });
  }, []);

  // ignore() and restore() persist the user's choice as a [localise-skip]
  // tag on the Figma layer name, so a rescan (or another designer opening
  // the same file) sees the same set of dynamic layers without having to
  // remark them. The local `ignored` set is updated optimistically; the
  // 'renamed' response will reconcile it from the canonical layer name.
  const ignore = useCallback((id: string) => {
    const l = layers.find(x => x.id === id);
    if (!l) return;
    setIgnored(prev => new Set([...prev, id]));
    send({ t: 'rename', id, name: skipTagName(l.name) });
  }, [layers]);
  const restore = useCallback((id: string) => {
    const l = layers.find(x => x.id === id);
    if (!l) return;
    setIgnored(prev => { const n = new Set(prev); n.delete(id); return n; });
    send({ t: 'rename', id, name: clearTagName(l.name) });
  }, [layers]);

  // assignKey tracks provenance so the UI can badge it, and when the key came
  // from Lokalise it also pushes the Lokalise English source back into Figma.
  const assignKey = useCallback((layerId: string, key: string, source: KeySource) => {
    const l = layers.find(x => x.id === layerId);
    if (!l || !key) return;
    send({ t: 'rename', id: layerId, name: tagName(key, l.name) });
    setKeySource(prev => ({ ...prev, [layerId]: source }));

    if (source === 'lokalise') {
      const enText = englishFromLokalise(localiseMap[key]);
      if (enText && enText !== l.text) {
        send({ t: 'set-text', id: layerId, characters: enText });
      }
    }
  }, [layers, localiseMap]);

  const rejectSuggestion = useCallback((id: string) => {
    setSuggestions(prev => { const n = { ...prev }; delete n[id]; return n; });
  }, []);

  const approveAllSuggestions = useCallback(() => {
    // Snapshot current suggestions and only act on layers still unmapped.
    for (const [id, key] of Object.entries(suggestions)) {
      const l = layers.find(x => x.id === id);
      if (!l || l.key || !key) continue;
      // 'new' — AI-suggested keys don't exist in Lokalise yet, so no text sync.
      send({ t: 'rename', id, name: tagName(key, l.name) });
      setKeySource(prev => ({ ...prev, [id]: 'new' }));
    }
    setStatus({ kind: 'ok', text: `Approved ${Object.keys(suggestions).length} suggested key${Object.keys(suggestions).length > 1 ? 's' : ''}.` });
  }, [suggestions, layers]);

  const toggleLang = useCallback((lang: string) => {
    setSelectedLangs(prev =>
      prev.includes(lang) ? prev.filter(l => l !== lang) : [...prev, lang],
    );
  }, []);

  const selectAllLangs = useCallback(() => setSelectedLangs(LANG_CODES), []);
  const clearLangs = useCallback(() => setSelectedLangs([]), []);

  const loadLocaliseData = useCallback(async () => {
    if (!hasLocalise) {
      setStatus({ kind: 'err', text: 'Missing Lokalise API token (Settings ⚙).' });
      return;
    }
    setBusy('loading-keys');
    setStatus({ kind: 'info', text: 'Loading Lokalise keys…' });
    try {
      // Fetch project languages and key translations in parallel. The
      // languages call is cheap (one page, ≤ a few dozen entries) so it
      // adds negligible time but lets us use Lokalise's exact lang_iso
      // values for translation lookups instead of guessing.
      const [projectLangs, all] = await Promise.all([
        getProjectLanguages(settings.localiseKey),
        getAllKeyTranslations(
          settings.localiseKey,
          loaded => setStatus({
            kind: 'info',
            text: `Loading Lokalise keys… ${loaded.toLocaleString()} so far`,
          }),
        ),
      ]);
      const keyNames = Object.keys(all.translations);
      setLocaliseKeys(keyNames);
      setLocaliseMap(all.translations);
      // Build UI-code → exact-Lokalise-iso map. Resolver handles case
      // (pt_BR), Norwegian variants (nb_NO), regional fallbacks (de_DE),
      // and uses translation density to pick the right variant.
      const projectIsos = projectLangs.map(l => l.lang_iso);
      const isoMap: Record<string, string> = {};
      for (const code of LANG_CODES) {
        isoMap[code] = resolveLokaliseIso(code, projectIsos, all.translations);
      }
      setLokaliseIsoMap(isoMap);
      setLocaliseLoaded(true);
      setStatus({
        kind: 'ok',
        text: `Loaded ${keyNames.length.toLocaleString()} Lokalise key${keyNames.length === 1 ? '' : 's'} · ${projectLangs.length} language${projectLangs.length === 1 ? '' : 's'}.`,
      });
    } catch (err) {
      setStatus({ kind: 'err', text: `Lokalise: ${err instanceof Error ? err.message : String(err)}` });
      setLocaliseLoaded(true);
    } finally {
      setBusy(null);
    }
  }, [hasLocalise, settings.localiseKey]);

  const autoGenerateKeyFor = useCallback(async (layerId: string) => {
    if (!hasCopyStudio) {
      setStatus({ kind: 'err', text: 'Copy Studio token required (Settings ⚙).' });
      return;
    }
    const layer = layers.find(l => l.id === layerId);
    if (!layer) return;
    setBusy(`key-${layerId}`);
    try {
      const existing = [...new Set([
        ...localiseKeys,
        ...layers.filter(l => l.key).map(l => l.key!),
        ...Object.values(suggestions),
      ])];
      const results = await generateKeysFor(
        [{ id: layer.id, frameName, path: layer.path, text: layer.text }],
        existing,
        settings.copyStudioToken,
      );
      const r = results[0];
      if (r?.key && !r.error) {
        setSuggestions(prev => ({ ...prev, [layerId]: r.key! }));
        setStatus({ kind: 'ok', text: `Suggested key: ${r.key}` });
      } else {
        setStatus({ kind: 'err', text: `Key generation failed: ${r?.error ?? 'unknown'}` });
      }
    } catch (err) {
      setStatus({ kind: 'err', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  }, [hasCopyStudio, layers, localiseKeys, suggestions, frameName, settings.copyStudioToken]);

  const autoGenerateAllKeys = useCallback(async () => {
    if (!hasCopyStudio || unmapped.length === 0) return;
    setBusy('keys');
    setProgress({ done: 0, total: unmapped.length });
    setStatus({ kind: 'info', text: `Generating ${unmapped.length} key${unmapped.length > 1 ? 's' : ''}…` });
    try {
      const existing = [...new Set([...localiseKeys, ...mapped.map(m => m.key!)])];
      const results = await generateKeysFor(
        unmapped.map(l => ({ id: l.id, frameName, path: l.path, text: l.text })),
        existing,
        settings.copyStudioToken,
        (done, total) => setProgress({ done, total }),
      );
      const next: Record<string, string> = {};
      let ok = 0, failed = 0;
      for (const r of results) {
        if (r.key && !r.error) { next[r.id] = r.key; ok++; }
        else failed++;
      }
      setSuggestions(prev => ({ ...prev, ...next }));
      if (failed === 0) setStatus({ kind: 'ok', text: `${ok} suggestion${ok > 1 ? 's' : ''} ready — approve all, or review each below.` });
      else if (ok === 0) setStatus({ kind: 'err', text: `Key generation failed: ${results[0]?.error ?? 'unknown'}` });
      else setStatus({ kind: 'info', text: `${ok} ready, ${failed} failed.` });
    } catch (err) {
      setStatus({ kind: 'err', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
      setProgress(null);
    }
  }, [hasCopyStudio, unmapped, mapped, localiseKeys, frameName, settings.copyStudioToken]);

  // Run translation for selected languages, in parallel.
  // Contract: never overrides existing cell values (Lokalise or user-edited) —
  // only fills gaps. Matches the "Add missing translations" user expectation.
  const runTranslate = useCallback(async (mode: 'translate' | 'manage') => {
    if (!hasCopyStudio) { setStatus({ kind: 'err', text: 'Copy Studio token required (Settings ⚙).' }); return; }
    if (selectedLangs.length === 0) { setStatus({ kind: 'err', text: 'Select at least one language.' }); return; }

    const sourceLayers = mode === 'translate'
      ? activeLayers.filter(l => l.text.trim() !== '')
      : mapped;
    if (sourceLayers.length === 0) {
      setStatus({ kind: 'err', text: mode === 'translate' ? 'No text layers.' : 'No mapped layers — assign keys first.' });
      return;
    }

    setBusy('translate');
    setProgress({ done: 0, total: selectedLangs.length });
    setStatus({ kind: 'info', text: `Translating ${selectedLangs.length} language${selectedLangs.length > 1 ? 's' : ''} in parallel…` });

    let done = 0;
    const results: AllTranslations = {};
    const failures: Array<{ lang: string; message: string }> = [];
    await runPool(selectedLangs, TRANSLATE_CONCURRENCY, async lang => {
      // Resolved Lokalise iso (project-exact case/region) — fixes the
      // "AI re-translates strings Lokalise already has" symptom that
      // showed up when our normalised "pt_br" missed Lokalise's "pt_BR".
      const iso = lokaliseIsoMap[lang] ?? toIso(lang);
      const seeded: LayerTranslations = {};

      // In manage mode: fill from Lokalise first. Never override.
      if (mode === 'manage') {
        for (const l of sourceLayers) {
          const existing = localiseMap[l.key!]?.[iso];
          if (existing) seeded[l.id] = existing;
        }
      }
      // Layer user edits win over both.
      const already = translations[lang] ?? {};
      for (const [id, t] of Object.entries(already)) {
        if (sourceLayers.some(l => l.id === id) && t) seeded[id] = t;
      }

      const need = sourceLayers.filter(l => !seeded[l.id]);
      if (need.length === 0) {
        results[lang] = seeded;
      } else {
        try {
          const out = await translate({
            strings: need.map(l => ({ key: l.id, text: l.text })),
            language: lang,
            channel,
            token: settings.copyStudioToken,
          });
          const merged: LayerTranslations = { ...seeded };
          for (const r of out) merged[r.key] = r.translation;
          results[lang] = merged;
        } catch (err) {
          // Keep whatever was seeded, but NEVER fail silently — a language that
          // errors here would otherwise just vanish from the review list.
          results[lang] = seeded;
          failures.push({
            lang,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
      done++;
      setProgress({ done, total: selectedLangs.length });
    });

    setTranslations(prev => ({ ...prev, ...results }));
    const okCount = selectedLangs.length - failures.length;
    if (failures.length === 0) {
      setStatus({ kind: 'ok', text: `Translated ${okCount} language${okCount > 1 ? 's' : ''} — missing values filled.` });
    } else {
      const names = failures.map(f => LANGUAGES[f.lang] ?? f.lang).join(', ');
      setStatus({
        kind: failures.length === selectedLangs.length ? 'err' : 'info',
        text: `${okCount} of ${selectedLangs.length} translated. Failed: ${names}. (${failures[0].message}) — press Translate again to retry just the missing ones.`,
      });
    }
    setBusy(null);
    setProgress(null);
  }, [hasCopyStudio, selectedLangs, activeLayers, mapped, channel, settings.copyStudioToken, localiseMap, translations, lokaliseIsoMap]);

  const editCell = useCallback((lang: string, layerId: string, text: string) => {
    setTranslations(prev => ({
      ...prev,
      [lang]: { ...(prev[lang] ?? {}), [layerId]: text },
    }));
  }, []);

  const createFrameFor = useCallback((lang: string, mode: 'translate' | 'manage') => {
    if (!frameId) return;
    const perLayer = translations[lang];
    if (!perLayer || Object.keys(perLayer).length === 0) {
      setStatus({ kind: 'err', text: `No translations for ${LANGUAGES[lang] ?? lang} yet.` });
      return;
    }
    setBusy('dupe');
    setStatus({ kind: 'info', text: `Duplicating ${lang} frame…` });
    if (mode === 'translate') {
      send({ t: 'dupe-by-order', frameId, lang, translationsByNodeId: perLayer });
    } else {
      const byKey: Record<string, string> = {};
      for (const l of layers) {
        if (l.key && perLayer[l.id]) byKey[l.key] = perLayer[l.id];
      }
      send({ t: 'dupe-by-key', frameId, lang, translations: byKey });
    }
  }, [frameId, translations, layers]);

  const createAllFrames = useCallback((mode: 'translate' | 'manage') => {
    if (!frameId) return;
    const langsWith = selectedLangs.filter(
      l => translations[l] && Object.keys(translations[l]).length > 0,
    );
    if (langsWith.length === 0) {
      setStatus({ kind: 'err', text: 'No translations to duplicate.' });
      return;
    }
    setBusy('dupe');
    setStatus({ kind: 'info', text: `Duplicating ${langsWith.length} frame${langsWith.length > 1 ? 's' : ''}…` });
    for (const l of langsWith) createFrameFor(l, mode);
  }, [frameId, selectedLangs, translations, createFrameFor]);

  const exportCsv = useCallback((mode: 'translate' | 'manage', opts?: { onlyNew?: boolean }) => {
    const langs = selectedLangs.filter(
      l => translations[l] && Object.keys(translations[l]).length > 0,
    );

    // Both `mapped` and `activeLayers` are derived from layers minus the
    // ignored set, so dynamic / skipped layers never reach the CSV. The
    // ignored set covers: regex auto-detected dynamic values, layers
    // tagged [localise-skip], and anything the user manually skipped.
    if (mode === 'manage') {
      let source = mapped;
      if (opts?.onlyNew) {
        // Lokalise import workflow: skip keys that already live in Lokalise
        // (provenance 'lokalise') and keys that were already in the Figma
        // frame ('existing'). Only push the genuinely new ones.
        source = source.filter(l => keySource[l.id] === 'new');
      }
      if (source.length === 0) {
        setStatus({ kind: 'err', text: opts?.onlyNew ? 'No new keys to export.' : 'No keys to export.' });
        return;
      }
      const rows: Row[] = source.map(m => {
        const perLang: Record<string, string> = {};
        for (const l of langs) perLang[l] = translations[l]?.[m.id] ?? '';
        return { key: m.key!, source: m.text, translations: perLang };
      });
      const csv = toCsv(rows, langs);
      const suffix = opts?.onlyNew ? '-new-keys' : '';
      download(`${safeName(frameName)}${suffix}.csv`, csv);
      setStatus({
        kind: 'ok',
        text: `Exported ${rows.length}${opts?.onlyNew ? ' new' : ''} key${rows.length > 1 ? 's' : ''}${langs.length ? ` × ${langs.length} lang${langs.length > 1 ? 's' : ''}` : ''}.`,
      });
      return;
    }

    // Translate mode: source + langs only.
    const source = activeLayers.filter(l => l.text.trim() !== '');
    if (source.length === 0) {
      setStatus({ kind: 'err', text: 'No text layers to export.' });
      return;
    }
    const header = ['source', ...langs];
    const esc = (v: string) => /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
    const lines = [header.map(esc).join(',')];
    for (const l of source) {
      const cells = [l.text, ...langs.map(lg => translations[lg]?.[l.id] ?? '')];
      lines.push(cells.map(esc).join(','));
    }
    const csv = '\uFEFF' + lines.join('\r\n');
    download(`${safeName(frameName)}.csv`, csv);
    setStatus({ kind: 'ok', text: `Exported ${source.length} string${source.length > 1 ? 's' : ''}${langs.length ? ` × ${langs.length} lang${langs.length > 1 ? 's' : ''}` : ''}.` });
  }, [selectedLangs, translations, mapped, activeLayers, frameName, keySource]);

  const saveSettings = useCallback((next: Settings) => {
    setSettings(next);
    setLocaliseLoaded(false);
    setLocaliseKeys([]);
    setLocaliseMap({});
    setLokaliseIsoMap({});
    send({
      t: 'save-settings',
      settings: {
        copyStudioToken: next.copyStudioToken,
        localiseKey: next.localiseKey,
      },
    });
  }, []);

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: ui.c.bg }}>
      <Header
        screen={screen}
        frameName={frameName}
        onBack={() => setScreen({ k: 'mode-picker' })}
        onHome={() => setScreen({ k: 'welcome' })}
        onSettings={() => setScreen({ k: 'settings' })}
      />

      {status && <StatusBar status={status} onDismiss={() => setStatus(null)} />}
      {progress && progress.total > 0 && <ProgressBar done={progress.done} total={progress.total} />}

      <div style={{ flex: 1, overflowY: 'auto', padding: 14 }}>
        {screen.k === 'settings' && (
          <SettingsScreen
            settings={settings}
            loaded={settingsLoaded}
            onSave={s => { saveSettings(s); if (settings.copyStudioToken || s.copyStudioToken) setScreen({ k: 'welcome' }); }}
          />
        )}

        {screen.k === 'welcome' && (
          <WelcomeScreen onScan={scan} hasCopyStudio={hasCopyStudio} busy={busy === 'scan'} />
        )}

        {screen.k === 'mode-picker' && (
          <ModePicker
            frameName={frameName}
            mapped={mapped.length}
            unmapped={unmapped.length}
            total={activeLayers.length}
            onPick={pickMode}
            onRescan={scan}
          />
        )}

        {screen.k === 'translate' && (
          <TranslateScreen
            layers={activeLayers}
            ignoredLayers={layers.filter(l => ignored.has(l.id))}
            onIgnore={ignore}
            onRestore={restore}
            channel={channel}
            onChannel={setChannel}
            selectedLangs={selectedLangs}
            onToggleLang={toggleLang}
            onSelectAllLangs={selectAllLangs}
            onClearLangs={clearLangs}
            translations={translations}
            onEditCell={editCell}
            busy={busy}
            hasCopyStudio={hasCopyStudio}
            progress={progress}
            searchQuery={searchQuery}
            onSearchQuery={setSearchQuery}
            onTranslate={() => runTranslate('translate')}
            onCreateFrameFor={(l) => createFrameFor(l, 'translate')}
            onCreateAllFrames={() => createAllFrames('translate')}
            onExportCsv={() => exportCsv('translate')}
          />
        )}

        {screen.k === 'manage' && (
          <ManageScreen
            frameName={frameName}
            layers={activeLayers}
            ignoredLayers={layers.filter(l => ignored.has(l.id))}
            keySource={keySource}
            selectedNodeIds={selectedNodeIds}
            onClearSelection={() => setSelectedNodeIds(new Set())}
            sortNoKeysFirst={sortNoKeysFirst}
            onToggleSort={() => setSortNoKeysFirst(v => !v)}
            suggestions={suggestions}
            onAssignKey={assignKey}
            onAutoGenerateKey={autoGenerateKeyFor}
            onAutoGenerateAll={autoGenerateAllKeys}
            onApproveAllSuggestions={approveAllSuggestions}
            onRejectSuggestion={rejectSuggestion}
            onIgnore={ignore}
            onRestore={restore}
            localiseKeys={localiseKeys}
            localiseMap={localiseMap}
            localiseLoaded={localiseLoaded}
            lokaliseIsoMap={lokaliseIsoMap}
            hasLocalise={hasLocalise}
            hasCopyStudio={hasCopyStudio}
            onLoad={loadLocaliseData}
            channel={channel}
            onChannel={setChannel}
            selectedLangs={selectedLangs}
            onToggleLang={toggleLang}
            onSelectAllLangs={selectAllLangs}
            onClearLangs={clearLangs}
            translations={translations}
            onEditCell={editCell}
            busy={busy}
            progress={progress}
            searchQuery={searchQuery}
            onSearchQuery={setSearchQuery}
            onTranslate={() => runTranslate('manage')}
            onCreateFrameFor={(l) => createFrameFor(l, 'manage')}
            onCreateAllFrames={() => createAllFrames('manage')}
            onExportCsv={(opts) => exportCsv('manage', opts)}
          />
        )}
      </div>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function safeName(s: string): string {
  return (s || 'localise-export').replace(/[^a-z0-9\-_]+/gi, '-').toLowerCase();
}

function matchesSearch(l: Layer, q: string): boolean {
  if (!q) return true;
  const ql = q.toLowerCase();
  if (l.text.toLowerCase().indexOf(ql) !== -1) return true;
  if (l.key && l.key.toLowerCase().indexOf(ql) !== -1) return true;
  return false;
}

// ─── Header ───────────────────────────────────────────────────────────────────
function Header({ screen, frameName, onBack, onHome, onSettings }: {
  screen: Screen;
  frameName: string;
  onBack: () => void;
  onHome: () => void;
  onSettings: () => void;
}) {
  const isScenario = screen.k === 'translate' || screen.k === 'manage';
  const showBack = isScenario || screen.k === 'settings';
  return (
    <div style={{
      padding: '10px 14px',
      borderBottom: `1px solid ${ui.c.border}`,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 8,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        {showBack ? (
          <button onClick={screen.k === 'settings' ? onHome : onBack} style={ui.iconBtn}>←</button>
        ) : null}
        <span style={{ fontWeight: 600, fontSize: 13 }}>Lifesum Localise</span>
        {isScenario && frameName && (
          <span style={{
            fontSize: 11, color: ui.c.textMuted,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            maxWidth: 140,
          }}>· {frameName}</span>
        )}
      </div>
      <button onClick={onSettings} style={ui.iconBtn} title="Settings">⚙</button>
    </div>
  );
}

// ─── StatusBar / ProgressBar ─────────────────────────────────────────────────
function StatusBar({ status, onDismiss }: { status: { kind: 'ok' | 'err' | 'info'; text: string }; onDismiss: () => void }) {
  const bg = status.kind === 'err' ? ui.c.redBg : status.kind === 'ok' ? ui.c.greenBg : ui.c.blueBg;
  const fg = status.kind === 'err' ? ui.c.red : status.kind === 'ok' ? ui.c.green : ui.c.blue;
  return (
    <div style={{
      padding: '7px 14px', fontSize: 11, background: bg, color: fg,
      display: 'flex', justifyContent: 'space-between', gap: 8,
      borderBottom: `1px solid ${ui.c.border}`,
    }}>
      <span style={{ flex: 1 }}>{status.text}</span>
      <button onClick={onDismiss} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', opacity: 0.6 }}>×</button>
    </div>
  );
}

function ProgressBar({ done, total }: { done: number; total: number }) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <div style={{ height: 2, background: ui.c.border }}>
      <div style={{ height: '100%', background: ui.c.brand, width: `${pct}%`, transition: 'width 0.2s' }} />
    </div>
  );
}

// ─── Settings screen ──────────────────────────────────────────────────────────
function SettingsScreen({ settings, loaded, onSave }: {
  settings: Settings;
  loaded: boolean;
  onSave: (s: Settings) => void;
}) {
  const [draft, setDraft] = useState(settings);
  useEffect(() => setDraft(settings), [settings]);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  const testCopyStudio = useCallback(async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const tools = await testConnection(draft.copyStudioToken.trim());
      const wanted = ['translate_copy', 'generate_key'];
      const missing = wanted.filter(w => tools.indexOf(w) === -1);
      setTestResult(missing.length === 0
        ? { ok: true, text: `Connected — ${tools.length} tools available.` }
        : { ok: false, text: `Connected, but missing: ${missing.join(', ')}.` });
    } catch (err) {
      setTestResult({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setTesting(false);
    }
  }, [draft.copyStudioToken]);

  return (
    <div style={ui.col(14)}>
      <h2 style={ui.h2}>Settings</h2>
      {!loaded && <div style={ui.muted}>Loading…</div>}
      <Field
        label="Copy Studio token"
        hint="Required for AI translation and key generation. Generate one in Copy Studio and paste it here. Copy Studio applies the Lifesum tone of voice and runs the model — no AI key needed."
        value={draft.copyStudioToken}
        onChange={v => { setDraft({ ...draft, copyStudioToken: v }); setTestResult(null); }}
        placeholder="…"
        type="password"
      />
      <div style={ui.row(8)}>
        <button
          style={{ ...ui.btn.ghost, padding: '5px 10px', fontSize: 11 }}
          onClick={testCopyStudio}
          disabled={testing || draft.copyStudioToken.trim() === ''}
        >
          {testing ? 'Testing…' : 'Test connection'}
        </button>
        {testResult && (
          <span style={{ fontSize: 11, color: testResult.ok ? ui.c.green : ui.c.red, flex: 1 }}>
            {testResult.ok ? '✓ ' : '✗ '}{testResult.text}
          </span>
        )}
      </div>
      <Field
        label="Lokalise API token"
        hint="Optional. Read-only — used to browse existing keys and pull translations. Uses the first project on the token."
        value={draft.localiseKey}
        onChange={v => setDraft({ ...draft, localiseKey: v })}
        placeholder="…"
        type="password"
      />
      <button style={ui.btn.primary} onClick={() => onSave(draft)}>Save</button>
    </div>
  );
}

function Field({ label, hint, value, onChange, placeholder, type = 'text' }: {
  label: string; hint?: string; value: string; onChange: (v: string) => void; placeholder?: string;
  type?: 'text' | 'password';
}) {
  return (
    <div style={ui.col(4)}>
      <label style={ui.label}>{label}</label>
      <input
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete="off"
        style={ui.input}
      />
      {hint && <div style={{ fontSize: 10, color: ui.c.textXMuted }}>{hint}</div>}
    </div>
  );
}

// ─── Welcome screen ───────────────────────────────────────────────────────────
function WelcomeScreen({ onScan, hasCopyStudio, busy }: { onScan: () => void; hasCopyStudio: boolean; busy: boolean }) {
  return (
    <div style={{ ...ui.col(16), textAlign: 'center', padding: '32px 8px' }}>
      <div style={{ fontSize: 40 }}>🖼</div>
      <div>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>Select a frame in Figma</div>
        <div style={{ fontSize: 12, color: ui.c.textMuted, lineHeight: 1.5 }}>
          Pick the frame you want to localise, then scan its text layers.
        </div>
      </div>
      <button style={{ ...ui.btn.primary, padding: '10px 14px' }} onClick={onScan} disabled={busy}>
        {busy ? 'Scanning…' : '🔍 Scan selection'}
      </button>
      {!hasCopyStudio && (
        <div style={{ fontSize: 11, color: ui.c.amber, background: ui.c.amberBg, padding: '8px 10px', borderRadius: 6 }}>
          Add your Copy Studio token in Settings (⚙) to enable AI translation.
        </div>
      )}
    </div>
  );
}

// ─── Mode picker ──────────────────────────────────────────────────────────────
function ModePicker({ frameName, mapped, unmapped, total, onPick, onRescan }: {
  frameName: string;
  mapped: number;
  unmapped: number;
  total: number;
  onPick: (m: Mode) => void;
  onRescan: () => void;
}) {
  const suggested: Mode = mapped > 0 ? 'manage' : 'translate';

  const options: Array<{ m: Mode; icon: string; title: string; blurb: string }> = [
    { m: 'translate', icon: '🌍', title: 'Translate', blurb: 'Translate every text layer into one or more languages. Edit, create frames, export CSV.' },
    { m: 'manage', icon: '🔑', title: 'Manage keys', blurb: 'Pick existing Lokalise keys or auto-generate new ones. Review translations, create frames, export CSV.' },
  ];

  return (
    <div style={ui.col(12)}>
      <div style={{ padding: '10px 12px', background: ui.c.surface, borderRadius: 6, border: `1px solid ${ui.c.border}` }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 2 }}>{frameName || '(unnamed)'}</div>
        <div style={{ fontSize: 11, color: ui.c.textMuted, display: 'flex', gap: 8 }}>
          <span>{total} text layer{total !== 1 ? 's' : ''}</span>
          {mapped > 0 && <span style={{ color: ui.c.green }}>· {mapped} with keys</span>}
          {unmapped > 0 && <span style={{ color: ui.c.amber }}>· {unmapped} without</span>}
        </div>
      </div>

      <div style={{ ...ui.col(8) }}>
        {options.map(o => (
          <button key={o.m} onClick={() => onPick(o.m)} style={{
            ...ui.col(4),
            alignItems: 'stretch',
            textAlign: 'left',
            padding: '12px',
            background: ui.c.bg,
            border: `1px solid ${suggested === o.m ? ui.c.brand : ui.c.border}`,
            borderRadius: 8,
            cursor: 'pointer',
            position: 'relative',
          }}>
            {suggested === o.m && (
              <div style={{
                position: 'absolute', top: 8, right: 8,
                fontSize: 9, fontWeight: 600, letterSpacing: '0.05em',
                background: ui.c.brand, color: '#fff',
                padding: '2px 6px', borderRadius: 3,
              }}>
                SUGGESTED
              </div>
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 18 }}>{o.icon}</span>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{o.title}</span>
            </div>
            <div style={{ fontSize: 11, color: ui.c.textMuted, lineHeight: 1.45 }}>{o.blurb}</div>
          </button>
        ))}
      </div>

      <button style={ui.btn.ghost} onClick={onRescan}>Rescan</button>
    </div>
  );
}

// ─── Language multi-picker ───────────────────────────────────────────────────
function LangMultiPicker({ selected, onToggle, onAll, onClear }: {
  selected: string[];
  onToggle: (lang: string) => void;
  onAll: () => void;
  onClear: () => void;
}) {
  return (
    <div style={ui.col(6)}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <label style={ui.label}>Languages ({selected.length}/{LANG_CODES.length})</label>
        <div style={ui.row(4)}>
          <button style={{ ...ui.btn.ghost, padding: '3px 8px', fontSize: 11 }} onClick={onAll}>All</button>
          <button style={{ ...ui.btn.ghost, padding: '3px 8px', fontSize: 11 }} onClick={onClear}>None</button>
        </div>
      </div>
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(2, 1fr)',
        gap: 4,
      }}>
        {LANG_CODES.map(l => {
          const on = selected.includes(l);
          return (
            <button key={l} onClick={() => onToggle(l)} style={{
              ...ui.row(6),
              padding: '6px 8px',
              fontSize: 11,
              borderRadius: 6,
              border: `1px solid ${on ? ui.c.brand : ui.c.border}`,
              background: on ? '#eef2ff' : ui.c.bg,
              color: on ? ui.c.brand : ui.c.text,
              cursor: 'pointer',
              textAlign: 'left',
            }}>
              <div style={{
                width: 12, height: 12, borderRadius: 3, flexShrink: 0,
                border: `1px solid ${on ? ui.c.brand : ui.c.textXMuted}`,
                background: on ? ui.c.brand : 'transparent',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: '#fff', fontSize: 10, lineHeight: 1,
              }}>{on ? '✓' : ''}</div>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {LANGUAGES[l]}
              </span>
              <span style={{ fontSize: 10, color: ui.c.textXMuted }}>{l}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── Search input ────────────────────────────────────────────────────────────
function SearchBox({ value, onChange, placeholder }: {
  value: string; onChange: (v: string) => void; placeholder: string;
}) {
  return (
    <div style={{ position: 'relative' }}>
      <input
        style={{ ...ui.input, width: '100%', boxSizing: 'border-box', paddingLeft: 28 }}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
      />
      <span style={{
        position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)',
        fontSize: 12, color: ui.c.textXMuted, pointerEvents: 'none',
      }}>🔎</span>
      {value && (
        <button
          onClick={() => onChange('')}
          style={{
            position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)',
            ...ui.iconBtn, width: 20, height: 20, fontSize: 13,
          }}
          title="Clear"
        >×</button>
      )}
    </div>
  );
}

// ─── Translate screen ────────────────────────────────────────────────────────
function TranslateScreen(p: {
  layers: Layer[];
  ignoredLayers: Layer[];
  onIgnore: (id: string) => void;
  onRestore: (id: string) => void;
  channel: string;
  onChannel: (v: string) => void;
  selectedLangs: string[];
  onToggleLang: (l: string) => void;
  onSelectAllLangs: () => void;
  onClearLangs: () => void;
  translations: AllTranslations;
  onEditCell: (lang: string, layerId: string, text: string) => void;
  busy: string | null;
  hasCopyStudio: boolean;
  progress: { done: number; total: number } | null;
  searchQuery: string;
  onSearchQuery: (v: string) => void;
  onTranslate: () => void;
  onCreateFrameFor: (lang: string) => void;
  onCreateAllFrames: () => void;
  onExportCsv: () => void;
}) {
  // Languages that actually have content — these can produce a frame.
  const translatedLangs = p.selectedLangs.filter(
    l => p.translations[l] && Object.keys(p.translations[l]).length > 0,
  );
  // Review shows EVERY selected language, so one that came back empty is
  // visible (and hand-editable) instead of silently disappearing.
  const reviewLangs = p.selectedLangs;
  const hasAny = translatedLangs.length > 0;
  const visibleLayers = p.layers.filter(l => matchesSearch(l, p.searchQuery));

  return (
    <div style={ui.col(14)}>
      <ScenarioHeader icon="🌍" title="Translate" />

      <SearchBox
        value={p.searchQuery}
        onChange={p.onSearchQuery}
        placeholder="Search text layers…"
      />

      <div style={ui.col(4)}>
        <SectionLabel text={`Text layers (${visibleLayers.length}${p.searchQuery ? ` of ${p.layers.length}` : ''})`} />
        {visibleLayers.length === 0 && (
          <div style={ui.muted}>{p.searchQuery ? 'No matches.' : 'No text layers in this frame.'}</div>
        )}
        <div style={ui.col(4)}>
          {visibleLayers.map(l => (
            <LayerCard
              key={l.id}
              primary={l.text || '(empty)'}
              subtitle={l.path}
              onIgnore={() => p.onIgnore(l.id)}
            />
          ))}
        </div>
      </div>

      <IgnoredList items={p.ignoredLayers} onRestore={p.onRestore} />

      <Divider />

      <Selector label="Tone channel" value={p.channel} onChange={p.onChannel} options={CHANNELS.map(c => ({ value: c.value, label: c.label }))} />
      <LangMultiPicker
        selected={p.selectedLangs}
        onToggle={p.onToggleLang}
        onAll={p.onSelectAllLangs}
        onClear={p.onClearLangs}
      />

      <button
        style={ui.btn.primary}
        onClick={p.onTranslate}
        disabled={!p.hasCopyStudio || p.busy !== null || p.layers.length === 0 || p.selectedLangs.length === 0}
      >
        {p.busy === 'translate'
          ? `⏳ ${p.progress?.done ?? 0}/${p.progress?.total ?? 0} language${(p.progress?.total ?? 0) > 1 ? 's' : ''}…`
          : p.selectedLangs.length === 0
            ? '🤖 Pick at least one language'
            : `🤖 Translate to ${p.selectedLangs.length} language${p.selectedLangs.length > 1 ? 's' : ''}`}
      </button>

      {hasAny && (
        <>
          <Divider />
          <SectionLabel
            text={`Review (${reviewLangs.length} language${reviewLangs.length > 1 ? 's' : ''}${
              translatedLangs.length < reviewLangs.length
                ? ` · ${reviewLangs.length - translatedLangs.length} empty`
                : ''
            })`}
          />
          {visibleLayers.map(layer => (
            <TranslationCard
              key={layer.id}
              layer={layer}
              langs={reviewLangs}
              translations={p.translations}
              onEditCell={p.onEditCell}
            />
          ))}

          <Divider />
          <div style={ui.col(6)}>
            <button style={ui.btn.primary} onClick={p.onCreateAllFrames} disabled={p.busy !== null}>
              ✨ Create {translatedLangs.length} frame{translatedLangs.length > 1 ? 's' : ''} (one per language)
            </button>
            <SectionLabel text="Or one at a time:" />
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 4 }}>
              {translatedLangs.map(l => (
                <button key={l} style={{ ...ui.btn.ghost, fontSize: 11 }} onClick={() => p.onCreateFrameFor(l)} disabled={p.busy !== null}>
                  ✨ {LANGUAGES[l]}
                </button>
              ))}
            </div>
            <button style={ui.btn.ghost} onClick={p.onExportCsv} disabled={p.busy !== null}>⬇ Export CSV</button>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Manage screen (3-step wizard) ───────────────────────────────────────────
// Step 1: assign keys (every layer needs a key, mapped from Lokalise or new)
// Step 2: review / fill translations (only mapped layers shown)
// Step 3: generate visuals (duplicate frame per language)
//
// Steps are clickable — the user can advance freely. Each step's pill shows a
// warning count when its prerequisites aren't satisfied.
type ManageStep = 1 | 2 | 3;

function ManageScreen(p: {
  frameName: string;
  layers: Layer[];
  ignoredLayers: Layer[];
  keySource: Record<string, KeySource>;
  selectedNodeIds: Set<string>;
  onClearSelection: () => void;
  sortNoKeysFirst: boolean;
  onToggleSort: () => void;
  suggestions: Record<string, string>;
  onAssignKey: (id: string, key: string, source: KeySource) => void;
  onAutoGenerateKey: (id: string) => void;
  onAutoGenerateAll: () => void;
  onApproveAllSuggestions: () => void;
  onRejectSuggestion: (id: string) => void;
  onIgnore: (id: string) => void;
  onRestore: (id: string) => void;
  localiseKeys: string[];
  localiseMap: Record<string, Record<string, string>>;
  localiseLoaded: boolean;
  lokaliseIsoMap: Record<string, string>;
  hasLocalise: boolean;
  hasCopyStudio: boolean;
  onLoad: () => void;
  channel: string;
  onChannel: (v: string) => void;
  selectedLangs: string[];
  onToggleLang: (l: string) => void;
  onSelectAllLangs: () => void;
  onClearLangs: () => void;
  translations: AllTranslations;
  onEditCell: (lang: string, layerId: string, text: string) => void;
  busy: string | null;
  progress: { done: number; total: number } | null;
  searchQuery: string;
  onSearchQuery: (v: string) => void;
  onTranslate: () => void;
  onCreateFrameFor: (lang: string) => void;
  onCreateAllFrames: () => void;
  onExportCsv: (opts?: { onlyNew?: boolean }) => void;
}) {
  const [step, setStep] = useState<ManageStep>(1);
  const [csvModalOpen, setCsvModalOpen] = useState(false);

  // Auto-load Lokalise data once when entering this screen, if configured.
  useEffect(() => {
    if (p.hasLocalise && !p.localiseLoaded) p.onLoad();
  }, []); // eslint-disable-line

  const selectionActive = p.selectedNodeIds.size > 0;
  const filtered = useMemo(() => {
    let list = p.layers;
    if (selectionActive) list = list.filter(l => p.selectedNodeIds.has(l.id));
    if (p.searchQuery) list = list.filter(l => matchesSearch(l, p.searchQuery));
    return list;
  }, [p.layers, p.searchQuery, p.selectedNodeIds, selectionActive]);

  const mappedActive = p.layers.filter(l => l.key);
  const unmappedActive = p.layers.filter(l => !l.key);
  const mappedCount = mappedActive.length;
  const unmappedCount = unmappedActive.length;
  const newKeyCount = mappedActive.filter(l => p.keySource[l.id] === 'new').length;

  // Missing-cell count powers Step 2's button + the stepper warning. Lokalise
  // auto-seed already populates these where it can — this is the AI's actual
  // workload.
  const missingCells = (() => {
    if (mappedCount === 0 || p.selectedLangs.length === 0) return mappedCount * p.selectedLangs.length;
    let n = 0;
    for (const l of mappedActive) {
      for (const lang of p.selectedLangs) {
        if (!p.translations[lang]?.[l.id]) n++;
      }
    }
    return n;
  })();
  const totalCells = mappedCount * p.selectedLangs.length;
  const filledCells = totalCells - missingCells;

  // Step 1's card list — both mapped and unmapped layers, sortable.
  const sortedForKeys = useMemo(() => {
    if (!p.sortNoKeysFirst) return filtered;
    return [...filtered].sort((a, b) => {
      const ak = !!a.key;
      const bk = !!b.key;
      if (ak === bk) return 0;
      return ak ? 1 : -1;
    });
  }, [filtered, p.sortNoKeysFirst]);

  // Step 2's card list — mapped only. No point trying to translate keyless layers.
  const mappedForReview = useMemo(() => filtered.filter(l => l.key), [filtered]);

  const pendingSuggestions = Object.keys(p.suggestions).filter(
    id => p.layers.some(l => l.id === id && !l.key),
  );

  const translatedLangs = p.selectedLangs.filter(
    l => p.translations[l] && Object.keys(p.translations[l]).length > 0,
  );

  return (
    <div style={ui.col(14)}>
      <ManageHeader frameName={p.frameName} onExportCsv={() => setCsvModalOpen(true)} />

      <Stepper
        step={step}
        onStep={setStep}
        issues={{ 1: unmappedCount, 2: missingCells, 3: 0 }}
      />

      {/* Lokalise warnings (visible across all steps) */}
      {!p.hasLocalise && (
        <div style={{ fontSize: 11, color: ui.c.amber, background: ui.c.amberBg, padding: '8px 10px', borderRadius: 6 }}>
          Add a Lokalise API token in Settings (⚙) to browse existing keys.
        </div>
      )}
      {p.hasLocalise && !p.localiseLoaded && (
        <div style={{
          fontSize: 11, color: ui.c.blue, background: ui.c.blueBg,
          padding: '8px 10px', borderRadius: 6,
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <Spinner />
          <span>Loading Lokalise keys and translations…</span>
        </div>
      )}

      {selectionActive && (
        <div style={{
          ...ui.row(8),
          padding: '8px 10px',
          background: ui.c.blueBg,
          border: `1px solid #bfdbfe`,
          borderRadius: 6,
        }}>
          <div style={{ flex: 1, fontSize: 11, color: ui.c.blue }}>
            🎯 {p.selectedNodeIds.size} layer{p.selectedNodeIds.size > 1 ? 's' : ''} selected in Figma — list filtered.
          </div>
          <button
            onClick={p.onClearSelection}
            style={{ ...ui.btn.ghost, padding: '4px 10px', fontSize: 11 }}
          >
            Show all
          </button>
        </div>
      )}

      {step !== 3 && (
        <SearchBox
          value={p.searchQuery}
          onChange={p.onSearchQuery}
          placeholder="Search by English copy or key…"
        />
      )}

      {/* === STEP 1 — Assign keys === */}
      {step === 1 && (
        <>
          <div style={{
            ...ui.row(8),
            padding: '8px 10px',
            background: ui.c.surface,
            border: `1px solid ${ui.c.border}`,
            borderRadius: 6,
          }}>
            <div style={{ flex: 1, fontSize: 11, color: ui.c.textMuted }}>
              {mappedCount} with keys · {unmappedCount} without
              {p.searchQuery && ` · ${filtered.length} match${filtered.length === 1 ? '' : 'es'}`}
            </div>
            <label style={{ ...ui.row(6), cursor: 'pointer', fontSize: 11, color: ui.c.text }}>
              <input
                type="checkbox"
                checked={p.sortNoKeysFirst}
                onChange={p.onToggleSort}
                style={{ margin: 0 }}
              />
              <span>No keys first</span>
            </label>
          </div>

          {unmappedCount > 0 && (
            <button
              style={ui.btn.purple}
              onClick={p.onAutoGenerateAll}
              disabled={!p.hasCopyStudio || p.busy !== null}
            >
              {p.busy === 'keys'
                ? `⏳ ${p.progress?.done ?? 0}/${p.progress?.total ?? 0}…`
                : `✨ Generate missing keys (${unmappedCount})`}
            </button>
          )}

          {pendingSuggestions.length > 0 && (
            <div style={{
              ...ui.row(8),
              padding: '8px 10px',
              background: ui.c.purpleBg,
              border: '1px solid #ddd6fe',
              borderRadius: 6,
            }}>
              <div style={{ flex: 1, fontSize: 11, color: ui.c.purple }}>
                ✨ {pendingSuggestions.length} AI suggestion{pendingSuggestions.length > 1 ? 's' : ''} waiting.
              </div>
              <button
                style={{ ...ui.btn.purple, padding: '4px 10px', fontSize: 11 }}
                onClick={p.onApproveAllSuggestions}
              >
                Approve all
              </button>
            </div>
          )}

          <div style={ui.col(4)}>
            {sortedForKeys.length === 0 && (
              <div style={ui.muted}>{p.searchQuery ? 'No matches.' : 'No text layers in this frame.'}</div>
            )}
            {sortedForKeys.map(l => (
              <ManageCard
                key={l.id}
                layer={l}
                source={p.keySource[l.id]}
                suggestion={p.suggestions[l.id]}
                localiseKeys={p.localiseKeys}
                localiseMap={p.localiseMap}
                localiseLoaded={p.localiseLoaded}
                lokaliseIsoMap={p.lokaliseIsoMap}
                busyForKey={p.busy === `key-${l.id}`}
                hasCopyStudio={p.hasCopyStudio}
                selectedLangs={p.selectedLangs}
                translations={p.translations}
                onEditCell={p.onEditCell}
                onAssignKey={(k, s) => p.onAssignKey(l.id, k, s)}
                onAutoGenerate={() => p.onAutoGenerateKey(l.id)}
                onRejectSuggestion={() => p.onRejectSuggestion(l.id)}
                onIgnore={() => p.onIgnore(l.id)}
                showTranslations={false}
              />
            ))}
          </div>

          <IgnoredList items={p.ignoredLayers} onRestore={p.onRestore} />

          <Divider />

          <StepActions
            warnText={
              unmappedCount > 0
                ? `${unmappedCount} layer${unmappedCount > 1 ? 's' : ''} still without a key — you can continue, but they won't be translated.`
                : null
            }
            primary={{ label: 'Continue to translations →', onClick: () => setStep(2) }}
          />
        </>
      )}

      {/* === STEP 2 — Translations === */}
      {step === 2 && (
        <>
          <Selector
            label="Tone channel"
            value={p.channel}
            onChange={p.onChannel}
            options={CHANNELS.map(c => ({ value: c.value, label: c.label }))}
          />
          <LangMultiPicker
            selected={p.selectedLangs}
            onToggle={p.onToggleLang}
            onAll={p.onSelectAllLangs}
            onClear={p.onClearLangs}
          />

          <button
            style={ui.btn.primary}
            onClick={p.onTranslate}
            disabled={!p.hasCopyStudio || missingCells === 0 || p.busy !== null}
          >
            {p.busy === 'translate'
              ? `⏳ ${p.progress?.done ?? 0}/${p.progress?.total ?? 0} language${(p.progress?.total ?? 0) > 1 ? 's' : ''}…`
              : missingCells === 0
                ? mappedCount === 0 || p.selectedLangs.length === 0
                  ? '🤖 Add missing translations'
                  : '🤖 All translations filled'
                : `🤖 Add missing translations (${missingCells} cell${missingCells > 1 ? 's' : ''})`}
          </button>

          <div style={{
            fontSize: 11, color: ui.c.textMuted,
            padding: '6px 10px',
            background: ui.c.surface,
            border: `1px solid ${ui.c.border}`,
            borderRadius: 6,
          }}>
            {mappedCount === 0
              ? 'No mapped keys yet — go back to Step 1 to assign keys.'
              : p.selectedLangs.length === 0
                ? 'Pick at least one language above.'
                : `${filledCells} of ${totalCells} cell${totalCells > 1 ? 's' : ''} filled.`}
          </div>

          <div style={ui.col(4)}>
            {mappedForReview.length === 0 && (
              <div style={ui.muted}>
                {p.searchQuery
                  ? 'No matching mapped layers.'
                  : 'No mapped layers — assign keys in Step 1.'}
              </div>
            )}
            {mappedForReview.map(l => (
              <ManageCard
                key={l.id}
                layer={l}
                source={p.keySource[l.id]}
                suggestion={p.suggestions[l.id]}
                localiseKeys={p.localiseKeys}
                localiseMap={p.localiseMap}
                localiseLoaded={p.localiseLoaded}
                lokaliseIsoMap={p.lokaliseIsoMap}
                busyForKey={p.busy === `key-${l.id}`}
                hasCopyStudio={p.hasCopyStudio}
                selectedLangs={p.selectedLangs}
                translations={p.translations}
                onEditCell={p.onEditCell}
                onAssignKey={(k, s) => p.onAssignKey(l.id, k, s)}
                onAutoGenerate={() => p.onAutoGenerateKey(l.id)}
                onRejectSuggestion={() => p.onRejectSuggestion(l.id)}
                onIgnore={() => p.onIgnore(l.id)}
                showTranslations={true}
              />
            ))}
          </div>

          <Divider />

          <StepActions
            warnText={
              missingCells > 0
                ? `${missingCells} translation${missingCells > 1 ? 's' : ''} still missing — you can continue, but those cells will be empty in generated frames.`
                : null
            }
            secondary={{ label: '← Back to keys', onClick: () => setStep(1) }}
            primary={{ label: 'Continue to visuals →', onClick: () => setStep(3) }}
          />
        </>
      )}

      {/* === STEP 3 — Generate visuals === */}
      {step === 3 && (
        <>
          <div style={{
            ...ui.col(4),
            padding: '12px',
            background: ui.c.surface,
            border: `1px solid ${ui.c.border}`,
            borderRadius: 6,
          }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>Ready to generate</div>
            <div style={{ fontSize: 11, color: ui.c.textMuted, lineHeight: 1.5 }}>
              {mappedCount} key{mappedCount === 1 ? '' : 's'} × {p.selectedLangs.length} language{p.selectedLangs.length === 1 ? '' : 's'} = {totalCells} cell{totalCells === 1 ? '' : 's'} ({filledCells} filled
              {missingCells > 0 && (
                <span style={{ color: ui.c.amber, fontWeight: 500 }}>, {missingCells} missing</span>
              )}
              ).
            </div>
            {translatedLangs.length === 0 && p.selectedLangs.length > 0 && (
              <div style={{ fontSize: 11, color: ui.c.amber }}>
                No translations yet — go back to Step 2.
              </div>
            )}
            {translatedLangs.length > 0 && translatedLangs.length < p.selectedLangs.length && (
              <div style={{ fontSize: 11, color: ui.c.amber }}>
                No content for {p.selectedLangs
                  .filter(l => !translatedLangs.includes(l))
                  .map(l => LANGUAGES[l] ?? l)
                  .join(', ')} — these won't get a frame. Re-run Step 2 to fill them.
              </div>
            )}
            {p.selectedLangs.length === 0 && (
              <div style={{ fontSize: 11, color: ui.c.amber }}>
                No languages selected — pick languages in Step 2.
              </div>
            )}
          </div>

          {translatedLangs.length > 0 && (
            <>
              <button
                style={ui.btn.primary}
                onClick={p.onCreateAllFrames}
                disabled={p.busy !== null}
              >
                ✨ Create {translatedLangs.length} frame{translatedLangs.length > 1 ? 's' : ''} (one per language)
              </button>
              <SectionLabel text="Or one at a time:" />
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 4 }}>
                {translatedLangs.map(l => (
                  <button key={l} style={{ ...ui.btn.ghost, fontSize: 11 }} onClick={() => p.onCreateFrameFor(l)} disabled={p.busy !== null}>
                    ✨ {LANGUAGES[l]}
                  </button>
                ))}
              </div>
            </>
          )}

          <Divider />

          <StepActions
            secondary={{ label: '← Back to translations', onClick: () => setStep(2) }}
          />
        </>
      )}

      {csvModalOpen && (
        <CsvModal
          allCount={mappedCount}
          newCount={newKeyCount}
          onExportAll={() => p.onExportCsv()}
          onExportNew={() => p.onExportCsv({ onlyNew: true })}
          onClose={() => setCsvModalOpen(false)}
        />
      )}
    </div>
  );
}

// ─── Manage header (frame name + Export CSV) ─────────────────────────────────
function ManageHeader({ frameName, onExportCsv }: {
  frameName: string;
  onExportCsv: () => void;
}) {
  return (
    <div style={{
      ...ui.row(8),
      padding: '10px 12px',
      background: ui.c.surface,
      borderRadius: 6,
      border: `1px solid ${ui.c.border}`,
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 9, fontWeight: 600,
          color: ui.c.textXMuted,
          letterSpacing: '0.06em', textTransform: 'uppercase',
          marginBottom: 2,
        }}>
          🔑 Manage keys
        </div>
        <div style={{
          fontSize: 13, fontWeight: 600,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {frameName || '(unnamed frame)'}
        </div>
      </div>
      <button
        onClick={onExportCsv}
        style={{ ...ui.btn.ghost, padding: '6px 10px', fontSize: 11, flexShrink: 0 }}
        title="Export CSV for Lokalise import"
      >
        ⬇ Export CSV
      </button>
    </div>
  );
}

// ─── Stepper ─────────────────────────────────────────────────────────────────
function Stepper({ step, onStep, issues }: {
  step: ManageStep;
  onStep: (n: ManageStep) => void;
  issues: Record<ManageStep, number>;
}) {
  const items: Array<{ n: ManageStep; label: string }> = [
    { n: 1, label: 'Assign keys' },
    { n: 2, label: 'Translations' },
    { n: 3, label: 'Generate' },
  ];
  return (
    <div style={{
      display: 'flex',
      gap: 4,
      padding: 4,
      background: ui.c.surface,
      borderRadius: 8,
      border: `1px solid ${ui.c.border}`,
    }}>
      {items.map(it => {
        const active = step === it.n;
        const issueCount = issues[it.n];
        return (
          <button key={it.n} onClick={() => onStep(it.n)} style={{
            flex: 1,
            padding: '6px 4px',
            border: 'none',
            borderRadius: 6,
            background: active ? ui.c.bg : 'transparent',
            color: active ? ui.c.text : ui.c.textMuted,
            cursor: 'pointer',
            boxShadow: active ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{
                fontSize: 11,
                fontWeight: 600,
                width: 16, height: 16,
                borderRadius: 99,
                background: active ? ui.c.brand : ui.c.border,
                color: active ? '#fff' : ui.c.textMuted,
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                lineHeight: 1,
              }}>{it.n}</span>
              {issueCount > 0 && (
                <span style={{
                  fontSize: 9, fontWeight: 600,
                  color: ui.c.amber,
                  background: ui.c.amberBg,
                  border: '1px solid #fde68a',
                  padding: '0 5px', borderRadius: 99,
                  lineHeight: '14px',
                }}>{issueCount}</span>
              )}
            </div>
            <div style={{ fontSize: 10, fontWeight: 500 }}>{it.label}</div>
          </button>
        );
      })}
    </div>
  );
}

// ─── Step actions (back / continue + warning text) ───────────────────────────
function StepActions({ warnText, primary, secondary }: {
  warnText?: string | null;
  primary?: { label: string; onClick: () => void };
  secondary?: { label: string; onClick: () => void };
}) {
  return (
    <div style={ui.col(6)}>
      {warnText && (
        <div style={{
          fontSize: 11, color: ui.c.amber, background: ui.c.amberBg,
          padding: '8px 10px', borderRadius: 6, border: '1px solid #fde68a',
        }}>
          ⚠ {warnText}
        </div>
      )}
      <div style={ui.row(6)}>
        {secondary && (
          <button style={{ ...ui.btn.ghost, flex: 1 }} onClick={secondary.onClick}>
            {secondary.label}
          </button>
        )}
        {primary && (
          <button style={{ ...ui.btn.primary, flex: secondary ? 2 : 1 }} onClick={primary.onClick}>
            {primary.label}
          </button>
        )}
      </div>
    </div>
  );
}

// ─── CSV export modal ────────────────────────────────────────────────────────
// Asks whether the export should include only the keys that were generated
// in this session (provenance 'new') or every mapped key. For Lokalise import
// the "new only" path is the common one — existing keys are already there.
function CsvModal({ allCount, newCount, onExportAll, onExportNew, onClose }: {
  allCount: number;
  newCount: number;
  onExportAll: () => void;
  onExportNew: () => void;
  onClose: () => void;
}) {
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(17,24,39,0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
        padding: 16,
      }}
      onClick={onClose}
    >
      <div
        style={{
          ...ui.col(12),
          background: ui.c.bg,
          padding: 16,
          borderRadius: 8,
          border: `1px solid ${ui.c.border}`,
          boxShadow: '0 10px 30px rgba(0,0,0,0.2)',
          width: '100%',
          maxWidth: 320,
        }}
        onClick={e => e.stopPropagation()}
      >
        <div style={ui.col(4)}>
          <h3 style={ui.h2}>Export CSV for Lokalise</h3>
          <div style={{ fontSize: 12, color: ui.c.textMuted, lineHeight: 1.5 }}>
            Upload only the keys that are new to Lokalise, or include every key in the frame?
          </div>
        </div>
        <div style={ui.col(6)}>
          <button
            style={{ ...ui.btn.primary, opacity: newCount === 0 ? 0.5 : 1 }}
            onClick={() => { onExportNew(); onClose(); }}
            disabled={newCount === 0}
          >
            New keys only ({newCount})
          </button>
          <button
            style={{ ...ui.btn.ghost, opacity: allCount === 0 ? 0.5 : 1 }}
            onClick={() => { onExportAll(); onClose(); }}
            disabled={allCount === 0}
          >
            All keys ({allCount})
          </button>
          <button
            style={{ ...ui.btn.ghost, opacity: 0.7 }}
            onClick={onClose}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Manage card (unified: source + key + translations) ──────────────────────
function ManageCard({
  layer, source, suggestion, localiseKeys, localiseMap, localiseLoaded,
  lokaliseIsoMap,
  busyForKey, hasCopyStudio,
  selectedLangs, translations,
  onEditCell,
  onAssignKey, onAutoGenerate, onRejectSuggestion, onIgnore,
  showTranslations = true,
}: {
  layer: Layer;
  source: KeySource | undefined;
  suggestion?: string;
  localiseKeys: string[];
  localiseMap: Record<string, Record<string, string>>;
  localiseLoaded: boolean;
  // UI code → exact Lokalise iso, e.g. "PT-BR" → "pt_BR". Used to look up
  // the right translation variant when checking whether a cell is sourced
  // from Lokalise (otherwise capital-region variants show as "missing").
  lokaliseIsoMap: Record<string, string>;
  busyForKey: boolean;
  hasCopyStudio: boolean;
  selectedLangs: string[];
  translations: AllTranslations;
  onEditCell: (lang: string, layerId: string, text: string) => void;
  onAssignKey: (key: string, source: KeySource) => void;
  onAutoGenerate: () => void;
  onRejectSuggestion: () => void;
  onIgnore: () => void;
  showTranslations?: boolean;
}) {
  // Start with key panel open when unmapped or a suggestion is waiting.
  const [keyPanelOpen, setKeyPanelOpen] = useState(!layer.key || !!suggestion);
  const [search, setSearch] = useState('');
  const [typed, setTyped] = useState('');
  const [suggestionDraft, setSuggestionDraft] = useState(suggestion ?? '');
  useEffect(() => {
    setSuggestionDraft(suggestion ?? '');
    if (suggestion) setKeyPanelOpen(true);
  }, [suggestion]);

  const isMapped = !!layer.key;

  // Lokalise picker filter: match the key name OR any of its translations
  // (designers usually remember the English copy, not the dotted key path).
  // 5000+ keys × all-language values is too big to render — slice after
  // filtering and show a count hint when there's overflow.
  const PICKER_MAX = 100;
  const matches = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return localiseKeys;
    return localiseKeys.filter(k => {
      if (k.toLowerCase().indexOf(q) !== -1) return true;
      const m = localiseMap[k];
      if (!m) return false;
      for (const v of Object.values(m)) {
        if (v && v.toLowerCase().indexOf(q) !== -1) return true;
      }
      return false;
    });
  }, [search, localiseKeys, localiseMap]);
  const visibleMatches = matches.slice(0, PICKER_MAX);
  const overflow = matches.length - visibleMatches.length;

  return (
    <div style={{
      borderRadius: 6,
      background: isMapped ? ui.c.bg : ui.c.amberBg,
      border: `1px solid ${isMapped ? ui.c.border : '#fde68a'}`,
      overflow: 'hidden',
    }}>
      {/* Header: source + key + badge + ignore */}
      <div style={{ padding: '8px 10px', ...ui.col(3) }}>
        <div style={ui.row(6)}>
          <div style={{ width: 7, height: 7, borderRadius: 99, background: isMapped ? ui.c.green : ui.c.amber, flexShrink: 0 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            {layer.path && <div style={{ fontSize: 10, color: ui.c.textXMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{layer.path}</div>}
            <div style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {layer.text || '(empty)'}
            </div>
            {isMapped && (
              <div style={{ ...ui.row(4), marginTop: 2 }}>
                <span style={{ fontSize: 10, color: ui.c.green, fontFamily: 'monospace', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {layer.key}
                </span>
                <ProvenanceBadge source={source} />
              </div>
            )}
          </div>
          <div style={ui.row(4)}>
            <button onClick={() => setKeyPanelOpen(e => !e)} style={{ ...ui.btn.ghost, padding: '3px 8px', fontSize: 11 }}>
              {keyPanelOpen ? '✕' : isMapped ? 'Change' : 'Set key'}
            </button>
            <button
              onClick={onIgnore}
              style={{ ...ui.btn.ghost, padding: '3px 8px', fontSize: 11 }}
              title="Mark as dynamic — skip localisation"
            >
              Skip
            </button>
          </div>
        </div>
      </div>

      {/* Key assignment panel */}
      {keyPanelOpen && (
        <div style={{
          borderTop: `1px solid ${isMapped ? ui.c.border : '#fde68a'}`,
          padding: '8px 10px',
          ...ui.col(6),
          background: ui.c.surface,
        }}>
          {suggestion && (
            <div style={ui.col(4)}>
              <div style={{ fontSize: 10, fontWeight: 600, color: ui.c.purple, letterSpacing: '0.05em', textTransform: 'uppercase' }}>
                ✨ AI suggestion — edit if needed
              </div>
              <input
                style={{ ...ui.input, borderColor: '#c4b5fd', fontFamily: 'monospace' }}
                value={suggestionDraft}
                onChange={e => setSuggestionDraft(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && suggestionDraft.trim()) {
                    onAssignKey(suggestionDraft.trim(), 'new');
                    setKeyPanelOpen(false);
                  }
                }}
              />
              <div style={ui.row(6)}>
                <button
                  style={{ ...ui.btn.purple, flex: 1, opacity: suggestionDraft.trim() ? 1 : 0.4 }}
                  disabled={!suggestionDraft.trim()}
                  onClick={() => { onAssignKey(suggestionDraft.trim(), 'new'); setKeyPanelOpen(false); }}
                >
                  ✓ Use this key
                </button>
                <button style={{ ...ui.btn.ghost, padding: '6px 10px', fontSize: 11 }} onClick={onRejectSuggestion}>Skip</button>
              </div>
              <Divider />
            </div>
          )}

          <button
            style={ui.btn.purple}
            onClick={onAutoGenerate}
            disabled={!hasCopyStudio || busyForKey}
          >
            {busyForKey ? '⏳ Generating…' : '✨ Auto-generate key with AI'}
          </button>

          <div style={ui.col(3)}>
            <label style={ui.label}>Or type a key</label>
            <div style={ui.row(6)}>
              <input
                style={{ ...ui.input, flex: 1 }}
                value={typed}
                onChange={e => setTyped(e.target.value)}
                placeholder="e.g. onboarding.welcome_title"
                onKeyDown={e => {
                  if (e.key === 'Enter' && typed.trim()) {
                    onAssignKey(typed.trim(), 'new');
                    setKeyPanelOpen(false);
                  }
                }}
              />
              <button
                style={{ ...ui.btn.primary, opacity: typed.trim() ? 1 : 0.4 }}
                disabled={!typed.trim()}
                onClick={() => { onAssignKey(typed.trim(), 'new'); setKeyPanelOpen(false); }}
              >
                Use
              </button>
            </div>
          </div>

          {localiseLoaded && localiseKeys.length > 0 && (
            <div style={ui.col(3)}>
              <label style={ui.label}>Or pick an existing Lokalise key</label>
              <input
                style={ui.input}
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search by key name or English text…"
              />
              <div style={{
                fontSize: 10, color: ui.c.textXMuted,
                display: 'flex', justifyContent: 'space-between', gap: 8,
              }}>
                <span>
                  {search
                    ? `${matches.length} match${matches.length === 1 ? '' : 'es'} of ${localiseKeys.length}`
                    : `${localiseKeys.length} keys total`}
                </span>
                {overflow > 0 && (
                  <span style={{ color: ui.c.amber }}>
                    Showing first {visibleMatches.length} — refine search
                  </span>
                )}
              </div>
              <div style={{ maxHeight: 200, overflowY: 'auto', ...ui.col(1) }}>
                {visibleMatches.length === 0
                  ? <div style={{ fontSize: 11, color: ui.c.textMuted, padding: '4px 0' }}>No matching keys.</div>
                  : visibleMatches.map(k => {
                    const en = localiseMap[k] && (localiseMap[k]['en'] || Object.values(localiseMap[k])[0]);
                    return (
                      <button key={k} onClick={() => { onAssignKey(k, 'lokalise'); setKeyPanelOpen(false); }} style={{
                        width: '100%', textAlign: 'left', padding: '4px 6px', borderRadius: 4,
                        background: 'none', border: 'none', cursor: 'pointer',
                      }}
                        onMouseEnter={e => e.currentTarget.style.background = ui.c.border}
                        onMouseLeave={e => e.currentTarget.style.background = 'none'}
                      >
                        <div style={{ fontSize: 11, fontFamily: 'monospace', color: ui.c.text }}>{k}</div>
                        {en && <div style={{ fontSize: 10, color: ui.c.textMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>→ {en}</div>}
                      </button>
                    );
                  })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Inline translations panel — hidden in step 1 of the manage wizard */}
      {showTranslations && isMapped && selectedLangs.length > 0 && (
        <div style={{
          borderTop: `1px solid ${ui.c.border}`,
          padding: '8px 10px',
          ...ui.col(4),
          background: ui.c.bg,
        }}>
          <SectionLabel text={`Translations (${selectedLangs.length})`} />
          {selectedLangs.map(l => {
            const value = translations[l]?.[layer.id] ?? '';
            const iso = lokaliseIsoMap[l] ?? toIso(l);
            const lokaliseValue = layer.key ? localiseMap[layer.key]?.[iso] : undefined;
            // Cell originated from Lokalise if its current value still matches
            // the Lokalise translation (user hasn't edited or AI hasn't replaced).
            const fromLokalise = !!lokaliseValue && lokaliseValue === value;
            return (
              <div key={l} style={ui.col(2)}>
                <div style={{
                  fontSize: 10, fontWeight: 600, color: ui.c.textMuted,
                  letterSpacing: '0.05em', textTransform: 'uppercase',
                  display: 'flex', alignItems: 'center', gap: 6,
                }}>
                  <span style={{ flex: 1 }}>{LANGUAGES[l]} ({l})</span>
                  {fromLokalise && (
                    <span style={{
                      fontSize: 9, fontWeight: 600, letterSpacing: '0.04em',
                      background: ui.c.blueBg, color: ui.c.blue,
                      border: '1px solid #bfdbfe',
                      padding: '1px 5px', borderRadius: 3,
                    }}>Lokalise</span>
                  )}
                  {!value && <span style={{ color: ui.c.amber, fontWeight: 500 }}>missing</span>}
                </div>
                <textarea
                  style={{
                    ...ui.input,
                    fontFamily: 'inherit',
                    resize: 'vertical',
                    minHeight: 30,
                    width: '100%',
                    boxSizing: 'border-box',
                  }}
                  value={value}
                  onChange={e => onEditCell(l, layer.id, e.target.value)}
                  placeholder={`${LANGUAGES[l]}…`}
                  rows={1}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Provenance badge ────────────────────────────────────────────────────────
// existing → no badge (just the key, in green)
// lokalise → blue pill
// new      → purple pill
function ProvenanceBadge({ source }: { source: KeySource | undefined }) {
  if (!source || source === 'existing') return null;
  const style = source === 'lokalise'
    ? { bg: ui.c.blueBg, fg: ui.c.blue, border: '#bfdbfe', label: 'Lokalise' }
    : { bg: ui.c.purpleBg, fg: ui.c.purple, border: '#ddd6fe', label: 'New' };
  return (
    <span style={{
      fontSize: 9,
      fontWeight: 600,
      letterSpacing: '0.04em',
      textTransform: 'uppercase',
      background: style.bg,
      color: style.fg,
      border: `1px solid ${style.border}`,
      padding: '1px 5px',
      borderRadius: 3,
      flexShrink: 0,
    }}>{style.label}</span>
  );
}

// ─── Translation card (Translate screen) ─────────────────────────────────────
function TranslationCard({ layer, langs, translations, onEditCell }: {
  layer: Layer;
  langs: string[];
  translations: AllTranslations;
  onEditCell: (lang: string, layerId: string, text: string) => void;
}) {
  if (langs.length === 0) return null;
  return (
    <div style={{
      ...ui.col(6),
      padding: '10px',
      background: ui.c.surface,
      borderRadius: 6,
      border: `1px solid ${ui.c.border}`,
    }}>
      <div style={ui.col(2)}>
        {layer.key && (
          <div style={{ fontSize: 10, color: ui.c.green, fontFamily: 'monospace' }}>{layer.key}</div>
        )}
        <div style={{ fontSize: 12, color: ui.c.text, fontWeight: 500 }}>{layer.text || '(empty)'}</div>
      </div>
      <div style={ui.col(4)}>
        {langs.map(l => {
          const value = translations[l]?.[layer.id] ?? '';
          return (
            <div key={l} style={ui.col(2)}>
              <div style={{
                fontSize: 10, fontWeight: 600, color: ui.c.textMuted,
                letterSpacing: '0.05em', textTransform: 'uppercase',
                display: 'flex', justifyContent: 'space-between',
              }}>
                <span>{LANGUAGES[l]} ({l})</span>
                {!value && <span style={{ color: ui.c.amber, fontWeight: 500 }}>missing</span>}
              </div>
              <textarea
                style={{
                  ...ui.input,
                  fontFamily: 'inherit',
                  resize: 'vertical',
                  minHeight: 32,
                  width: '100%',
                  boxSizing: 'border-box',
                }}
                value={value}
                onChange={e => onEditCell(l, layer.id, e.target.value)}
                placeholder={`${LANGUAGES[l]}…`}
                rows={1}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Small shared components ─────────────────────────────────────────────────
function ScenarioHeader({ icon, title }: { icon: string; title: string }) {
  return (
    <div style={{
      padding: '8px 12px', background: ui.c.surface, borderRadius: 6,
      border: `1px solid ${ui.c.border}`, display: 'flex', gap: 10, alignItems: 'center',
    }}>
      <span style={{ fontSize: 18 }}>{icon}</span>
      <span style={{ fontWeight: 600, fontSize: 13 }}>{title}</span>
    </div>
  );
}

function SectionLabel({ text, color }: { text: string; color?: string }) {
  return (
    <div style={{
      fontSize: 11, fontWeight: 600,
      color: color ?? ui.c.textMuted,
      textTransform: 'uppercase', letterSpacing: '0.05em',
    }}>{text}</div>
  );
}

function Divider() {
  return <div style={{ height: 1, background: ui.c.border, margin: '4px 0' }} />;
}

function Spinner({ size = 12, color }: { size?: number; color?: string }) {
  const stroke = color ?? ui.c.blue;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={{ flexShrink: 0 }}>
      <circle cx="12" cy="12" r="9" fill="none" stroke={stroke} strokeOpacity="0.2" strokeWidth="3" />
      <path d="M12 3 a9 9 0 0 1 9 9" fill="none" stroke={stroke} strokeWidth="3" strokeLinecap="round">
        <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.8s" repeatCount="indefinite" />
      </path>
    </svg>
  );
}

function LayerCard({ primary, subtitle, onIgnore }: { primary: string; subtitle?: string; onIgnore: () => void }) {
  return (
    <div style={{ ...ui.row(8), padding: '6px 10px', background: ui.c.surface, borderRadius: 6, border: `1px solid ${ui.c.border}` }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        {subtitle && <div style={{ fontSize: 10, color: ui.c.textXMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{subtitle}</div>}
        <div style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{primary}</div>
      </div>
      <button
        onClick={onIgnore}
        style={{ ...ui.btn.ghost, padding: '3px 8px', fontSize: 11 }}
        title="Mark as dynamic — skip localisation"
      >
        Skip
      </button>
    </div>
  );
}

function IgnoredList({ items, onRestore }: { items: Layer[]; onRestore: (id: string) => void }) {
  if (items.length === 0) return null;
  return (
    <div style={ui.col(4)}>
      <SectionLabel text={`Skipped — dynamic (${items.length})`} color={ui.c.textXMuted} />
      {items.map(l => {
        // Auto = our regex flagged it as a dynamic value (numbers, units,
        // placeholders). Manual = user clicked Skip on real copy.
        const auto = isDynamicText(l.text);
        return (
          <div key={l.id} style={{
            ...ui.row(8), padding: '6px 10px', borderRadius: 6, opacity: 0.6,
            border: `1px solid ${ui.c.border}`, background: ui.c.surface,
          }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 11, color: ui.c.textMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {l.text || l.name}
              </div>
              <div style={{ fontSize: 9, color: ui.c.textXMuted, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                {auto ? 'auto-detected dynamic' : 'marked dynamic'}
              </div>
            </div>
            <button
              onClick={() => onRestore(l.id)}
              style={{ ...ui.btn.ghost, padding: '2px 8px', fontSize: 11 }}
              title="Mark as static — include in localisation"
            >
              Localise
            </button>
          </div>
        );
      })}
    </div>
  );
}

function Selector({ label, value, onChange, options }: {
  label: string; value: string; onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <div style={ui.col(4)}>
      <label style={ui.label}>{label}</label>
      <select style={ui.select} value={value} onChange={e => onChange(e.target.value)}>
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}
