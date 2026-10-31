import { INDONESIA_VOLCANOES } from './catalog.js';

// Pure parsing and joining for PVMBG's MAGMA Indonesia volcano pages. No
// network and no Cesium: the server proxy parses the HTML with these, and the
// client re-validates the proxy's JSON with them.

/** PVMBG activity levels, I (Normal) to IV (Awas). */
export const MAGMA_LEVELS = Object.freeze([
  // i18n-ignore: PVMBG level names are proper names, never translated
  Object.freeze({ level: 1, roman: 'I', label: 'Normal' }),
  // i18n-ignore: PVMBG level names are proper names, never translated
  Object.freeze({ level: 2, roman: 'II', label: 'Waspada' }),
  // i18n-ignore: PVMBG level names are proper names, never translated
  Object.freeze({ level: 3, roman: 'III', label: 'Siaga' }),
  // i18n-ignore: PVMBG level names are proper names, never translated
  Object.freeze({ level: 4, roman: 'IV', label: 'Awas' }),
]);

const ROMAN_LEVEL = Object.freeze({ I: 1, II: 2, III: 3, IV: 4 });
/** VONA colour code from the CSS class MAGMA paints the notice marker with. */
const VONA_COLORS = Object.freeze({
  success: 'GREEN',
  yellow: 'YELLOW',
  warning: 'ORANGE',
  danger: 'RED',
});
const COLOR_NAMES = new Set(Object.values(VONA_COLORS));

const NAME_MAX = 60;
const TEXT_MAX = 280;
const MAX_NOTICES = 50;
const MAX_LEVEL_ROWS = 200;
const HOUR_MS = 60 * 60 * 1000;
const VONA_WINDOW_MS = 24 * HOUR_MS;
const FUTURE_SKEW_MS = HOUR_MS;

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/g;

// Level headers and "Name - Province" rows, in document order.
const LEVEL_TOKENS =
  /Level (IV|III|II|I) \(\w+\)<\/a>|<td>([^<]{1,400})<a href="https:\/\/magma\.esdm\.go\.id\/v1\/gunung-api\/laporan/g;
const VONA_TITLE = /<p\s+class="timeline-title"/g;
const VONA_MARKER = /\bbg-(success|yellow|warning|danger)\b/;
const VONA_LINK =
  /<a\s+href="https:\/\/magma\.esdm\.go\.id\/vona\?code=([A-Z]{2,5})"[^>]*>([^<]*)<\/a>/;
const VONA_HEADING = /^(.+?)\s+-\s+(\d{4})(\d{2})(\d{2})\/(\d{2})(\d{2})Z$/;
const VONA_TEXT = /<p\s+class="timeline-text"[^>]*>([\s\S]*?)<\/p>/;

const NAMED_ENTITIES = Object.freeze({
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
});

function cleanText(raw, max) {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(CONTROL_CHARS, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** Minimal HTML unescape: the named entities above and numeric references. */
function unescapeHtml(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : '';
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** Stable join key: lowercase letters and digits only. */
export function volcanoKey(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Parse MAGMA's activity-level table.
 * @param {string} html
 * @returns {Array<{name:string, province:string, level:number}>|null} null when
 *   the page is not a string or yields no rows (a layout change, not "no data").
 */
export function parseMagmaLevels(html) {
  if (typeof html !== 'string') return null;
  /** @type {Map<string, {name:string, province:string, level:number}>} */
  const byKey = new Map();
  let level = 0;
  for (const match of html.matchAll(LEVEL_TOKENS)) {
    if (match[1]) {
      level = ROMAN_LEVEL[match[1]];
      continue;
    }
    if (!level || match[2] === undefined) continue;
    const label = cleanText(unescapeHtml(match[2]), 200);
    const split = label.indexOf(' - ');
    const name = cleanText(split < 0 ? label : label.slice(0, split), NAME_MAX);
    const province =
      split < 0 ? '' : cleanText(label.slice(split + 3), NAME_MAX);
    const key = volcanoKey(name);
    if (!key) continue;
    const known = byKey.get(key);
    if (!known || known.level < level)
      byKey.set(key, { name, province, level });
    if (byKey.size >= MAX_LEVEL_ROWS) break;
  }
  return byKey.size > 0 ? [...byKey.values()] : null;
}

/** "YYYYMMDD/HHmmZ" parts to epoch ms UTC, or null for an impossible date. */
function vonaTime(year, month, day, hour, minute) {
  if (year < 2000 || year > 2100 || hour > 23 || minute > 59) return null;
  const ms = Date.UTC(year, month - 1, day, hour, minute);
  const date = new Date(ms);
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
    ? ms
    : null;
}

/**
 * Parse MAGMA's VONA (aviation colour code) timeline.
 * @param {string} html
 * @returns {Array<{code:string, name:string, color:string, issuedAt:number, text:string}>}
 *   newest first, at most 50.
 */
export function parseVonaNotices(html) {
  if (typeof html !== 'string') return [];
  const starts = [...html.matchAll(VONA_TITLE)].map((match) => match.index);
  const notices = [];
  starts.forEach((start, index) => {
    const block = html.slice(start, starts[index + 1] ?? html.length);
    const link = VONA_LINK.exec(block);
    if (!link) return;
    const marker = VONA_MARKER.exec(block.slice(0, link.index));
    const color = marker ? VONA_COLORS[marker[1]] : undefined;
    if (!color) return;
    const heading = VONA_HEADING.exec(cleanText(unescapeHtml(link[2]), 200));
    if (!heading) return;
    const [, rawName, year, month, day, hour, minute] = heading;
    const issuedAt = vonaTime(
      Number(year),
      Number(month),
      Number(day),
      Number(hour),
      Number(minute),
    );
    const name = cleanText(rawName, NAME_MAX);
    if (issuedAt === null || !name) return;
    const body = VONA_TEXT.exec(block.slice(link.index + link[0].length));
    const text = body
      ? cleanText(
          unescapeHtml(body[1].replace(/<[^<>]{0,200}>/g, ' ')),
          TEXT_MAX,
        )
      : '';
    notices.push({ code: link[1], name, color, issuedAt, text });
  });
  return notices.sort((a, b) => b.issuedAt - a.issuedAt).slice(0, MAX_NOTICES);
}

/**
 * Join MAGMA levels and VONA notices onto the bundled volcano catalog.
 * @param {object} input
 * @param {Array<{name:string, province:string, level:number}>|null} input.levels
 * @param {Array<{code:string, name:string, color:string, issuedAt:number, text:string}>} input.notices
 * @param {ReadonlyArray<object>} [input.catalog]
 * @param {number} input.now - Epoch ms; VONA notices older than 24 h are dropped.
 * @returns {{volcanoes: Array<object>, unplaced: string[], noticeCount: number}}
 */
export function buildVolcanoSnapshot({
  levels,
  notices,
  catalog = INDONESIA_VOLCANOES,
  now,
}) {
  const levelByKey = new Map();
  for (const row of levels ?? []) levelByKey.set(volcanoKey(row.name), row);
  const latestNotice = new Map();
  for (const notice of notices ?? []) {
    if (now - notice.issuedAt > VONA_WINDOW_MS) continue;
    const key = volcanoKey(notice.name);
    const known = latestNotice.get(key);
    if (!known || known.issuedAt < notice.issuedAt)
      latestNotice.set(key, notice);
  }
  const placed = new Set();
  const volcanoes = catalog.map((entry) => {
    const id = volcanoKey(entry.name);
    placed.add(id);
    const notice = latestNotice.get(id);
    return {
      id,
      name: entry.name,
      province: entry.province,
      lat: entry.lat,
      lon: entry.lon,
      elevationM: entry.elevationM,
      level: levelByKey.get(id)?.level ?? null,
      vona: notice
        ? {
            color: notice.color,
            issuedAt: notice.issuedAt,
            text: notice.text,
            code: notice.code,
          }
        : null,
    };
  });
  const unplaced = [...levelByKey]
    .filter(([key]) => !placed.has(key))
    .map(([, row]) => row.name);
  return { volcanoes, unplaced, noticeCount: notices?.length ?? 0 };
}

/**
 * Client re-validation of the proxy body. Bad items are dropped; a body that is
 * structurally wrong yields null.
 * @param {unknown} payload - {fetchedAt, levels, notices, noticesStale}
 * @param {number} [now]
 * @returns {{volcanoes: Array<object>, unplaced: string[], noticeCount: number,
 *   fetchedAt: number|null, noticesStale: boolean}|null} `fetchedAt` is the
 *   proxy's fetch time (null when absent), `noticesStale` true only when the
 *   proxy says the VONA notices are out of date.
 */
export function volcanoRowsFromPayload(payload, now = Date.now()) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    return null;
  if (!Array.isArray(payload.levels)) return null;
  const levels = [];
  for (const raw of payload.levels.slice(0, MAX_LEVEL_ROWS)) {
    if (!raw || typeof raw !== 'object') continue;
    const name = cleanText(raw.name, NAME_MAX);
    if (!name || !Number.isInteger(raw.level)) continue;
    if (raw.level < 1 || raw.level > 4) continue;
    levels.push({
      name,
      province: cleanText(raw.province, NAME_MAX),
      level: raw.level,
    });
  }
  const notices = [];
  const rawNotices = Array.isArray(payload.notices) ? payload.notices : [];
  for (const raw of rawNotices.slice(0, MAX_NOTICES)) {
    if (!raw || typeof raw !== 'object') continue;
    const name = cleanText(raw.name, NAME_MAX);
    if (!name || !COLOR_NAMES.has(raw.color)) continue;
    if (typeof raw.code !== 'string' || !/^[A-Z]{2,5}$/.test(raw.code))
      continue;
    if (!Number.isFinite(raw.issuedAt) || raw.issuedAt > now + FUTURE_SKEW_MS)
      continue;
    notices.push({
      code: raw.code,
      name,
      color: raw.color,
      issuedAt: raw.issuedAt,
      text: cleanText(raw.text, TEXT_MAX),
    });
  }
  return {
    ...buildVolcanoSnapshot({ levels, notices, now }),
    fetchedAt: Number.isFinite(payload.fetchedAt) ? payload.fetchedAt : null,
    noticesStale: payload.noticesStale === true,
  };
}
