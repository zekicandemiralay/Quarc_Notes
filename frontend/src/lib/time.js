// The server stores UTC timestamps as "YYYY-MM-DD HH:MM:SS(.mmm)"; the app
// keeps ISO strings locally (sortable together with local edit times).
const SERVER_TS = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(\.\d+)?$/;

export function isServerTs(value) {
  return typeof value === 'string' && SERVER_TS.test(value);
}

export function toIso(value) {
  if (!value) return new Date().toISOString();
  if (isServerTs(value)) return `${value.replace(' ', 'T')}Z`;
  return value;
}

const UNITS = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
];

// "5 minutes ago" / "5 dakika önce", via the browser's own localization.
export function relativeTime(value, lang = 'en') {
  const then = new Date(toIso(value)).getTime();
  if (!Number.isFinite(then)) return '';
  const seconds = Math.round((then - Date.now()) / 1000);
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' });
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit);
  }
  return rtf.format(0, 'second');
}
