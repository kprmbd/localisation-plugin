// Lifesum languages and channels.
//
// NOTE: translation and key generation now happen entirely in Copy Studio (see
// lib/copystudio.ts → the worker → Copy Studio's translate / generate-key
// tools), which applies the brand voice server-side. The plugin no longer
// builds a ToV system prompt, so the previously-baked tone-of-voice guide has
// been removed. What remains here is the picker metadata still used by the UI:
// LANGUAGES, LANG_CODES, CHANNELS, Channel, copyStudioLang.

// Static list of UI codes the picker offers. Each maps to a human-readable
// label used in the picker UI.
//   • Single Norwegian entry only — at runtime we resolve "NO" to whichever
//     Lokalise variant is populated (no, nb, nb_NO, nn).
//   • Czech added per project requirement (cs in Lokalise).
// At runtime we ALSO fetch Lokalise's /projects/{id}/languages and use those
// exact lang_iso values for translation lookups, so a Lokalise "pt_BR" or
// "ru_RU" resolves correctly even though our UI code is "PT-BR" / "RU".
export const LANGUAGES: Record<string, string> = {
  SV: 'Swedish',
  DE: 'German',
  NO: 'Norwegian',
  DK: 'Danish',
  ES: 'Spanish',
  'PT-BR': 'Brazilian Portuguese',
  FR: 'French',
  IT: 'Italian',
  NL: 'Dutch',
  FI: 'Finnish',
  PL: 'Polish',
  RU: 'Russian',
  CS: 'Czech',
};

export const LANG_CODES = Object.keys(LANGUAGES);

// UI code → Copy Studio language code. Most are just lowercased, with two
// exceptions: our "DK" is Copy Studio's "da", and Brazilian Portuguese keeps
// its region case ("pt-BR") to match Copy Studio's own key exactly.
export function copyStudioLang(uiCode: string): string {
  if (uiCode === 'DK') return 'da';
  if (uiCode === 'PT-BR') return 'pt-BR';
  return uiCode.toLowerCase();
}

export const CHANNELS = [
  { value: 'product', label: 'Product' },
  { value: 'site_app', label: 'Site / App' },
  { value: 'email_marketing', label: 'Email — Marketing' },
  { value: 'email_account', label: 'Email — Account' },
  { value: 'social', label: 'Social' },
  { value: 'linkedin', label: 'LinkedIn' },
] as const;
export type Channel = (typeof CHANNELS)[number]['value'];
