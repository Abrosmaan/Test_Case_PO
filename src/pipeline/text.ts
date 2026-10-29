import { config } from '../config.js';

export const DATE_SRC = config.date;

/** dd.mm.yyyy → yyyy-mm-dd, or null if not a real date. */
export function toIsoDate(d: string, m: string, y: string): string | null {
  const iso = `${y}-${m}-${d}`;
  const t = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === iso ? iso : null;
}

export function formatDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

/** Finds `prefixSrc` followed by a date; returns ISO date and the exact quote span inside `text`. */
export function findDateAfter(text: string, prefixSrc: string, flags = 'iu') {
  const m = new RegExp(`(${prefixSrc})${DATE_SRC}`, flags).exec(text);
  if (!m) return null;
  const iso = toIsoDate(m[2]!, m[3]!, m[4]!);
  return iso ? { iso, quote: m[0], index: m.index } : null;
}
