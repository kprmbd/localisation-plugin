// CSV export — scenario 3 hands off to Localise via CSV import.
// Layout: key, en (source), [language columns…]. RFC 4180 quoting, UTF-8 BOM.

export interface Row {
  key: string;
  source: string;
  translations: Record<string, string>;
}

export function toCsv(rows: Row[], languages: string[]): string {
  const header = ['key', 'en', ...languages];
  const lines = [header.map(esc).join(',')];
  for (const r of rows) {
    const cells = [r.key, r.source, ...languages.map(l => r.translations[l] ?? '')];
    lines.push(cells.map(esc).join(','));
  }
  return '\uFEFF' + lines.join('\r\n');
}

function esc(v: string): string {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function download(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
