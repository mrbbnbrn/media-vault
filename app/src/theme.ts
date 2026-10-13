// Accent colour handling. The app is always dark; only the accent changes.

export const ACCENTS: { name: string; hex: string }[] = [
  { name: 'Teal', hex: '#2ec4b6' },
  { name: 'Blue', hex: '#5b9cf0' },
  { name: 'Violet', hex: '#a78bfa' },
  { name: 'Amber', hex: '#e8a54b' },
  { name: 'Rose', hex: '#f07a8c' },
  { name: 'Lime', hex: '#9ccc54' },
];

export const DEFAULT_ACCENT = '#2ec4b6';
const GROUND = '#0d0e10';

export function isHex(s: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(s);
}

function rgb(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}

/** Blend `hex` over `base`: t = 0 gives base, t = 1 gives hex. */
export function mix(hex: string, base: string, t: number): string {
  const a = rgb(hex);
  const b = rgb(base);
  return '#' + a.map((v, i) => Math.round(b[i] + (v - b[i]) * t).toString(16).padStart(2, '0')).join('');
}

/** WCAG relative luminance, 0..1. */
export function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Text colour that stays readable on top of the accent. */
export function onAccent(hex: string): string {
  return luminance(hex) > 0.18 ? '#0a1214' : '#ffffff';
}

export function accentVars(accent: string): Record<string, string> {
  const a = isHex(accent) ? accent.toLowerCase() : DEFAULT_ACCENT;
  return {
    '--accent': a,
    '--on-accent': onAccent(a),
    '--accent-soft': mix(a, GROUND, 0.16),
    '--accent-soft-2': mix(a, GROUND, 0.1),
    '--accent-border': mix(a, GROUND, 0.35),
    '--accent-text': mix(a, '#ffffff', 0.55),
    '--accent-ring': a + '99',
  };
}

export function applyAccent(accent: string): void {
  const root = document.documentElement;
  for (const [k, v] of Object.entries(accentVars(accent))) root.style.setProperty(k, v);
}

export function formatBytes(n: number | null): string {
  if (n == null) return '';
  if (n < 1e6) return `${Math.max(1, Math.round(n / 1e3))} KB`;
  if (n < 1e9) return `${(n / 1e6).toFixed(0)} MB`;
  return `${(n / 1e9).toFixed(n < 1e10 ? 1 : 0)} GB`;
}
