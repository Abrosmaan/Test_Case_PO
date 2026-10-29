import { config } from '../config.js';

/** Any supported date as ONE capturing group: dd.mm.yyyy, dd.mm.yy, yyyy-mm-dd, «15 апреля 2026 г.», «"28" марта 2026 года». */
export const DATE_SRC = config.date;
/** The same date pattern without its capturing group, for use inside a larger pattern. */
export const DATE_NC = DATE_SRC.replace(/^\(/, '(?:');

const MONTHS = ['январ', 'феврал', 'март', 'апрел', 'ма', 'июн', 'июл', 'август', 'сентябр', 'октябр', 'ноябр', 'декабр'];

/** yyyy-mm-dd, or null if it is not a real calendar date (31.02.2026 is not 03.03.2026). */
export function isoIfReal(y: number, m: number, d: number): string | null {
  const iso = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const t = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === iso ? iso : null;
}

/** Text matched by DATE_SRC → ISO date, or null when it is not a real date. */
export function parseDate(text: string): string | null {
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (m) return isoIfReal(+m[1]!, +m[2]!, +m[3]!);
  m = /^(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})$/.exec(text);
  if (m) return isoIfReal(m[3]!.length === 2 ? 2000 + +m[3]! : +m[3]!, +m[2]!, +m[1]!);
  m = /^[«"“]?(\d{1,2})[»"”]?\s+(\p{L}+)\s+(\d{4})/u.exec(text);
  if (m) {
    const month = m[2]!.toLowerCase();
    // «ма» must be exactly «мая»/«май», not «марта».
    const i = MONTHS.findIndex((p) => (p === 'ма' ? /^ма[йя]$/.test(month) : month.startsWith(p)));
    return i < 0 ? null : isoIfReal(+m[3]!, i + 1, +m[1]!);
  }
  return null;
}

export function formatDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

/** Finds `prefixSrc` followed by a date; returns ISO date and the exact quote span inside `text`. */
export function findDateAfter(text: string, prefixSrc: string, flags = 'iu') {
  const m = new RegExp(`(${prefixSrc})${DATE_SRC}`, flags).exec(text);
  if (!m) return null;
  const iso = parseDate(m[2]!);
  return iso ? { iso, quote: m[0], index: m.index } : null;
}
