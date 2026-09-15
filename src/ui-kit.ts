// Shared style tokens and helpers for the plugin UI.
// Kept as inline-style objects so the bundle doesn't need a CSS pipeline.

import type { CSSProperties } from 'react';

const c = {
  bg: '#ffffff',
  surface: '#f7f7f8',
  border: '#e5e7eb',
  text: '#111827',
  textMuted: '#6b7280',
  textXMuted: '#9ca3af',

  brand: '#6366f1',

  green: '#15803d',
  greenBg: '#f0fdf4',
  red: '#b91c1c',
  redBg: '#fef2f2',
  amber: '#b45309',
  amberBg: '#fffbeb',
  blue: '#1d4ed8',
  blueBg: '#eff6ff',
  purple: '#7c3aed',
  purpleBg: '#f5f3ff',
};

const col = (gap: number): CSSProperties => ({
  display: 'flex',
  flexDirection: 'column',
  gap,
});

const row = (gap: number): CSSProperties => ({
  display: 'flex',
  flexDirection: 'row',
  alignItems: 'center',
  gap,
});

const btnBase: CSSProperties = {
  padding: '7px 12px',
  fontSize: 12,
  fontWeight: 500,
  borderRadius: 6,
  cursor: 'pointer',
  border: `1px solid ${c.border}`,
  transition: 'background 0.15s, border-color 0.15s',
};

const btn = {
  primary: {
    ...btnBase,
    background: c.brand,
    color: '#fff',
    border: `1px solid ${c.brand}`,
  } as CSSProperties,
  ghost: {
    ...btnBase,
    background: c.bg,
    color: c.text,
  } as CSSProperties,
  purple: {
    ...btnBase,
    background: c.purple,
    color: '#fff',
    border: `1px solid ${c.purple}`,
  } as CSSProperties,
};

const input: CSSProperties = {
  padding: '7px 10px',
  fontSize: 12,
  borderRadius: 6,
  border: `1px solid ${c.border}`,
  background: c.bg,
  color: c.text,
  outline: 'none',
  fontFamily: 'inherit',
};

const select: CSSProperties = {
  ...input,
  appearance: 'auto',
  cursor: 'pointer',
};

const label: CSSProperties = {
  fontSize: 11,
  fontWeight: 500,
  color: c.textMuted,
};

const h2: CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  margin: 0,
  color: c.text,
};

const muted: CSSProperties = {
  fontSize: 11,
  color: c.textMuted,
};

const iconBtn: CSSProperties = {
  width: 24,
  height: 24,
  padding: 0,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 14,
  background: 'none',
  border: 'none',
  color: c.textMuted,
  borderRadius: 4,
  cursor: 'pointer',
};

export const ui = {
  c,
  col,
  row,
  btn,
  input,
  select,
  label,
  h2,
  muted,
  iconBtn,
};
