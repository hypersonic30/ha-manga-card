/*!
 * Manga Card — a Home Assistant Lovelace card for reading manga and comics
 * from a Komga server: library, series, volumes, a page reader (right-to-left,
 * left-to-right, scrolling) and reading progress that stays in Komga.
 *
 * Requires the companion "Books" integration
 * (https://github.com/hypersonic30/ha-books-integration) with a Komga URL and
 * API key configured: it proxies every request, so the Komga API key never
 * reaches the browser. Built phone-first for the Home Assistant companion app.
 *
 * License: MIT
 */
"use strict";

// ─────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────

const CARD_VERSION = "0.3.2";
const CARD_TAG = "manga-card";
const EDITOR_TAG = "manga-card-editor";
const KOMGA = "books/komga/"; // hass.callApi() path (the Books integration proxies Komga here)
const KOMGA_URL = "/api/books/komga/"; // the same as a URL, for signing image paths
const MYLAR = "books/mylar/"; // the Books integration proxies Mylar3 here (search / add / download)
const POLL_MS = 10000; // refresh rate of the downloads tab and of an open Mylar series
const BULK_VOLUMES = 5; // "load the next volumes" queues this many (every volume is one indexer search)
const BULK_GAP_MS = 1500;
const SEEN_KEY = "mc-pp-seen"; // finished downloads we already told Komga about
// Publishers whose editions are German (ComicVine has no language field).
const GERMAN_PUBLISHERS = /verlag|carlsen|altraverse|egmont|tokyopop|kaz[eé]\b|cross ?cult|reprodukt|manga cult|dani books|hayabusa|splitter|feest|schwarzer turm|ehapa/i;
// ... and the English-language ones (a publisher active in both, like Tokyopop, counts for both chips).
const ENGLISH_PUBLISHERS = /\b(viz|kodansha comics|yen press|dark horse|seven seas|vertical|square enix|udon|del rey|titan|ablaze|denpa|j-novel|digital manga|one peace|tokyopop|inklore|comikey|marvel|dc comics|idw|image|boom|dynamite|oni press|usa)\b/i;
const LANGS = [["all", "Alle"], ["de", "Deutsch"], ["en", "Englisch"]];
const LANG_KEY = "mc-lang"; // the chosen language chip is remembered
const inLanguage = (hit, lang) => {
  const pub = hit.publisher || "";
  return lang === "de" ? GERMAN_PUBLISHERS.test(pub) : lang === "en" ? ENGLISH_PUBLISHERS.test(pub) : true;
};
const ISSUE_STATUS = {
  Skipped: "Nicht geladen", Wanted: "Wird gesucht", Snatched: "Lädt…", Downloaded: "Fertig",
  Archived: "Archiviert", Failed: "Fehlgeschlagen", Ignored: "Ignoriert",
};
const SIGN_EXPIRY_SECONDS = 24 * 3600;
const PAGE_SIZE = 60;
const SEEK_DEBOUNCE_MS = 1200;

const DIRECTIONS = {
  rtl: "Rechts → links",
  ltr: "Links → rechts",
  scroll: "Scrollen",
};

const DEFAULT_CONFIG = { title: "Manga" };

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function qs(params) {
  const q = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  return q ? `?${q}` : "";
}

function errStatus(err) {
  return err?.status ?? err?.status_code; // the test stub throws {status}, Home Assistant {status_code}
}

const NO_PERSON_TEXT = "Für dein Konto ist keine Person angelegt. Bitte den Verwalter, dich in der Books-Integration hinzuzufügen (Einstellungen → Geräte & Dienste → Books → Person hinzufügen).";

function errMessage(err) {
  if (!err) return "Unbekannter Fehler";
  if (typeof err === "string") return err;
  const body = err.body || {};
  if (body.code === "no_person") return NO_PERSON_TEXT; // the integration needs a person for every user of the card
  return body.error || body.message || err.message || err.error || `Fehler ${errStatus(err) || ""}`.trim();
}

function volumeNumber(n) {
  const f = parseFloat(n);
  return Number.isNaN(f) ? Infinity : f;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function debounce(fn, wait) {
  let t = null;
  const wrapped = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
  wrapped.flush = (...args) => {
    clearTimeout(t);
    fn(...args);
  };
  wrapped.cancel = () => clearTimeout(t);
  return wrapped;
}

function store(key, value) {
  try {
    if (value === undefined) return window.localStorage.getItem(key);
    window.localStorage.setItem(key, value);
  } catch (_) {
    /* private mode / blocked storage: remembering is a convenience, never required */
  }
  return null;
}

/** Komga's readingDirection → what the reader does. */
function directionFromKomga(value) {
  if (value === "LEFT_TO_RIGHT") return "ltr";
  if (value === "VERTICAL" || value === "WEBTOON") return "scroll";
  return "rtl"; // RIGHT_TO_LEFT, and the safe default for manga when unset
}

function bookTitle(book) {
  const title = book?.metadata?.title || book?.name || "";
  const n = book?.metadata?.number || book?.number;
  return title || (n ? `Band ${n}` : "Band");
}

function isCompleted(book) {
  return !!book?.readProgress?.completed;
}

function pct(book) {
  const p = book?.readProgress;
  const total = book?.media?.pagesCount || 0;
  if (!p || !total) return 0;
  return p.completed ? 100 : Math.round((100 * p.page) / total);
}

// ─────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────

const STYLE = `
<style>
  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  :host {
    display: block;
    --mc-radius-lg: 26px;
    --mc-radius-md: 16px;
    --mc-radius-sm: 10px;
    --mc-accent-rgb: 10, 132, 255;
    --mc-accent: var(--primary-color, rgb(var(--mc-accent-rgb)));
    --mc-soft: rgba(128, 128, 128, 0.10);
    --mc-line: rgba(128, 128, 128, 0.18);
    font-family: var(--paper-font-body1_-_font-family, -apple-system, "SF Pro Text", "Segoe UI", system-ui, sans-serif);
  }
  ha-card {
    position: relative; overflow: hidden; border-radius: var(--mc-radius-lg);
    background: color-mix(in srgb, var(--card-background-color, #1c1c1e) 55%, transparent);
    backdrop-filter: blur(26px) saturate(160%); -webkit-backdrop-filter: blur(26px) saturate(160%);
    border: 1px solid color-mix(in srgb, var(--divider-color, #8e8e93) 55%, transparent);
    box-shadow: 0 20px 45px rgba(0, 0, 0, 0.16), inset 0 1px 1px rgba(255, 255, 255, 0.12);
  }
  .mc-root { position: relative; display: flex; flex-direction: column; color: var(--primary-text-color); }
  .mc-header { padding: 18px 18px 6px; font-size: 1.35em; font-weight: 700; letter-spacing: -0.01em; }
  .mc-error { display: flex; align-items: center; gap: 8px; margin: 10px 16px 0; padding: 10px 14px; border-radius: var(--mc-radius-sm);
    color: white; font-size: 0.9em; background: color-mix(in srgb, var(--error-color, #db4437) 85%, transparent); }
  .mc-error button { margin-left: auto; background: none; border: none; color: inherit; font-size: 1.1em; cursor: pointer; }
  .mc-body { padding: 8px 16px 18px; display: flex; flex-direction: column; gap: 14px; }
  .mc-searchbar { display: flex; gap: 8px; padding: 6px 16px 0; }
  .mc-searchbar input { flex: 1; min-height: 44px; padding: 0 16px; border-radius: 999px; font: inherit; font-size: 1em;
    color: var(--primary-text-color); background: var(--mc-soft); border: 1px solid var(--mc-line); }
  .mc-chips { display: flex; gap: 6px; overflow-x: auto; padding-bottom: 2px; scrollbar-width: none; }
  .mc-chip { flex: 0 0 auto; min-height: 36px; padding: 6px 14px; border-radius: 999px; cursor: pointer; font: inherit; font-size: 0.88em;
    border: 1px solid var(--mc-line); background: var(--mc-soft); color: var(--primary-text-color); }
  .mc-chip.active { background: color-mix(in srgb, var(--mc-accent) 90%, transparent); color: white; border-color: transparent; }
  .mc-section { font-size: 0.78em; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--secondary-text-color); margin-top: 2px; }
  .mc-row { display: flex; gap: 12px; overflow-x: auto; padding-bottom: 6px; scrollbar-width: none; }
  .mc-row .mc-tile { flex: 0 0 104px; }
  .mc-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(104px, 1fr)); gap: 14px 12px; }
  .mc-tile { cursor: pointer; min-width: 0; -webkit-tap-highlight-color: transparent; }
  .mc-cover { position: relative; aspect-ratio: 2 / 3; border-radius: var(--mc-radius-sm); overflow: hidden; background: var(--mc-soft);
    box-shadow: 0 6px 16px rgba(0,0,0,0.22); }
  .mc-cover img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
  .mc-cover-fallback { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; padding: 8px; text-align: center;
    font-size: 0.75em; color: var(--secondary-text-color); }
  .mc-badge { position: absolute; top: 6px; right: 6px; min-width: 22px; height: 22px; padding: 0 6px; border-radius: 999px; z-index: 2;
    display: flex; align-items: center; justify-content: center; font-size: 0.72em; font-weight: 700; color: white; background: var(--mc-accent); }
  .mc-badge.done { background: #34c759; }
  .mc-progressbar { position: absolute; left: 0; right: 0; bottom: 0; height: 4px; background: rgba(0,0,0,0.35); z-index: 2; }
  .mc-progressbar > div { height: 100%; background: var(--mc-accent); }
  .mc-tile-title { margin-top: 6px; font-size: 0.82em; font-weight: 600; line-height: 1.25; display: -webkit-box; -webkit-line-clamp: 2;
    -webkit-box-orient: vertical; overflow: hidden; }
  .mc-tile-sub { font-size: 0.72em; color: var(--secondary-text-color); margin-top: 2px; }
  .mc-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 44px; padding: 0 18px; border: none; cursor: pointer;
    border-radius: 999px; font: inherit; font-size: 0.95em; font-weight: 600; color: white;
    background: color-mix(in srgb, var(--mc-accent) 92%, transparent); box-shadow: 0 2px 8px rgba(var(--mc-accent-rgb), 0.35); }
  .mc-btn:disabled { opacity: 0.5; }
  .mc-btn.secondary { color: var(--primary-text-color); background: var(--mc-soft); border: 1px solid var(--mc-line); box-shadow: none; }
  .mc-btn.round { width: 44px; min-width: 44px; padding: 0; }
  .mc-btn.block { width: 100%; }
  .mc-empty, .mc-loading { text-align: center; padding: 28px 12px; color: var(--secondary-text-color); font-size: 0.9em; line-height: 1.5; }
  .mc-hint { font-size: 0.8em; color: var(--secondary-text-color); line-height: 1.45; }

  /* dialogs live in an overlay on <body> (see _ensureSkeleton) */
  dialog.mc-dialog { padding: 0; border: none; width: 100vw; height: 100dvh; max-width: none; max-height: none; margin: 0;
    background: var(--card-background-color, #1c1c1e); color: var(--primary-text-color);
    font-family: -apple-system, "SF Pro Text", "Segoe UI", system-ui, sans-serif; }
  dialog.mc-dialog::backdrop { background: rgba(0, 0, 0, 0.7); }
  .mc-sheet { position: relative; height: 100%; overflow-y: auto; padding: calc(56px + env(safe-area-inset-top)) 18px calc(24px + env(safe-area-inset-bottom)); }
  .mc-close { position: absolute; top: calc(10px + env(safe-area-inset-top)); right: 12px; z-index: 5; }
  .mc-detail-top { display: flex; gap: 14px; }
  .mc-detail-top .mc-cover { flex: 0 0 110px; }
  .mc-detail-title { font-size: 1.25em; font-weight: 700; line-height: 1.2; }
  .mc-detail-sub { color: var(--secondary-text-color); font-size: 0.88em; margin-top: 4px; }
  .mc-pills { display: flex; gap: 5px; flex-wrap: wrap; margin-top: 8px; }
  .mc-pill { font-size: 0.72em; font-weight: 700; padding: 3px 9px; border-radius: 999px; background: color-mix(in srgb, var(--primary-text-color) 12%, transparent); }
  .mc-pill.ok { background: color-mix(in srgb, #34c759 35%, transparent); }
  .mc-actions { display: flex; flex-direction: column; gap: 8px; margin: 14px 0; }
  .mc-actions-row { display: flex; gap: 8px; }
  .mc-actions-row .mc-btn { flex: 1; }
  .mc-summary { font-size: 0.9em; line-height: 1.5; color: var(--secondary-text-color); margin-bottom: 10px; }
  .mc-vols { display: flex; flex-direction: column; gap: 8px; }
  .mc-vol { display: flex; gap: 12px; align-items: center; padding: 8px; border-radius: var(--mc-radius-sm); cursor: pointer; background: var(--mc-soft); }
  .mc-vol .mc-cover { flex: 0 0 52px; box-shadow: none; }
  .mc-vol-main { flex: 1; min-width: 0; }
  .mc-vol-title { font-weight: 600; font-size: 0.92em; }
  .mc-vol-sub { font-size: 0.76em; color: var(--secondary-text-color); margin-top: 2px; }
  .mc-meter { height: 4px; border-radius: 4px; background: rgba(128,128,128,0.25); margin-top: 6px; overflow: hidden; }
  .mc-meter > div { height: 100%; background: var(--mc-accent); }

  /* reader */
  .mc-reader { position: relative; width: 100%; height: 100%; background: #000; color: #fff; overflow: hidden; touch-action: manipulation; }
  .mc-r-top, .mc-r-foot { position: absolute; left: 0; right: 0; z-index: 6; display: flex; align-items: center; gap: 10px;
    background: linear-gradient(rgba(0,0,0,0.85), rgba(0,0,0,0)); transition: opacity 0.2s ease; }
  .mc-r-top { top: 0; padding: calc(8px + env(safe-area-inset-top)) 12px 22px; }
  .mc-r-foot { bottom: 0; padding: 22px 16px calc(10px + env(safe-area-inset-bottom)); flex-direction: column; align-items: stretch; gap: 6px;
    background: linear-gradient(rgba(0,0,0,0), rgba(0,0,0,0.85)); }
  .mc-reader.chrome-hidden .mc-r-top, .mc-reader.chrome-hidden .mc-r-foot { opacity: 0; pointer-events: none; }
  .mc-r-title { flex: 1; min-width: 0; font-size: 0.9em; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .mc-r-top .mc-btn.secondary { background: rgba(255,255,255,0.16); color: #fff; border-color: transparent; }
  .mc-r-menu { position: absolute; z-index: 7; top: calc(60px + env(safe-area-inset-top)); left: 12px; right: 12px; padding: 12px; border-radius: var(--mc-radius-md);
    background: rgba(28,28,30,0.96); display: flex; flex-direction: column; gap: 10px; }
  .mc-r-menu .mc-hint { color: rgba(255,255,255,0.65); }
  .mc-r-menu .row { display: flex; gap: 6px; flex-wrap: wrap; }
  .mc-r-menu .mc-chip { color: #fff; background: rgba(255,255,255,0.12); border-color: transparent; }
  .mc-r-menu .mc-chip.active { background: var(--mc-accent); }
  .mc-r-view { position: absolute; inset: 0; }
  .mc-r-stage { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; overflow: auto; }
  .mc-r-stage img { display: block; width: 100%; height: 100%; object-fit: contain; user-select: none; -webkit-user-drag: none; }
  .mc-reader.fit-width .mc-r-stage { align-items: flex-start; }
  .mc-reader.fit-width .mc-r-stage img { width: 100%; height: auto; }
  .mc-zone { position: absolute; top: 0; bottom: 0; z-index: 3; }
  .mc-zone.left { left: 0; width: 34%; } .mc-zone.right { right: 0; width: 34%; } .mc-zone.mid { left: 34%; width: 32%; }
  .mc-r-foot-row { display: flex; align-items: center; gap: 10px; font-size: 0.8em; font-variant-numeric: tabular-nums; }
  .mc-r-foot input[type=range] { width: 100%; accent-color: var(--mc-accent); height: 26px; }
  .mc-scroll { position: absolute; inset: 0; overflow-y: auto; -webkit-overflow-scrolling: touch; background: #000; }
  .mc-wt { width: 100%; max-width: 900px; margin: 0 auto; }
  .mc-wt-page { width: 100%; background: #111; }
  .mc-wt-page img { display: block; width: 100%; height: auto; }
  .mc-end { position: absolute; inset: 0; z-index: 8; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px;
    background: rgba(0,0,0,0.86); text-align: center; padding: 24px; }
  .mc-tabs { display: flex; gap: 6px; padding: 4px 16px 0; }
  .mc-tab { flex: 1; min-height: 40px; border-radius: 999px; cursor: pointer; font: inherit; font-size: 0.9em; font-weight: 600;
    color: var(--primary-text-color); background: var(--mc-soft); border: 1px solid var(--mc-line); }
  .mc-tab.active { background: color-mix(in srgb, var(--mc-accent) 90%, transparent); color: white; border-color: transparent; }
  .mc-tab .mc-badge { position: static; display: inline-flex; margin-left: 6px; vertical-align: middle; }
  .mc-searchbar .mc-btn { min-height: 44px; }
  .mc-notice { margin: 10px 16px 0; padding: 10px 14px; border-radius: var(--mc-radius-sm); font-size: 0.9em; background: var(--mc-soft); border: 1px solid var(--mc-line); }
  .mc-list { display: flex; flex-direction: column; gap: 8px; }
  .mc-res { display: flex; gap: 12px; align-items: center; padding: 8px; border-radius: var(--mc-radius-sm); background: var(--mc-soft); }
  .mc-res .mc-cover { flex: 0 0 52px; box-shadow: none; }
  .mc-res .mc-btn { min-height: 38px; padding: 0 14px; font-size: 0.85em; white-space: nowrap; }
  .mc-item { display: flex; flex-direction: column; }
  .mc-item .mc-res { cursor: default; }
  .mc-item .mc-res[data-action] { cursor: pointer; -webkit-tap-highlight-color: transparent; }
  .mc-chev { flex: 0 0 auto; width: 28px; text-align: center; font-size: 1.5em; line-height: 1; color: var(--secondary-text-color); transition: transform 0.2s ease; }
  .mc-item.open .mc-chev { transform: rotate(90deg); }
  .mc-item.open .mc-res { border-bottom-left-radius: 0; border-bottom-right-radius: 0; background: color-mix(in srgb, var(--mc-accent) 14%, var(--mc-soft)); }
  .mc-panel { display: flex; flex-direction: column; gap: 10px; padding: 12px; background: var(--mc-soft); border-radius: 0 0 var(--mc-radius-sm) var(--mc-radius-sm);
    border-top: 1px solid var(--mc-line); animation: mc-unfold 0.18s ease; }
  @keyframes mc-unfold { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: none; } }
  .mc-panel .mc-pills { margin-top: 0; }
  .mc-inline-vols { display: flex; flex-direction: column; gap: 2px; max-height: 52vh; overflow-y: auto; margin: 0 -4px; padding: 0 4px; }
  .mc-ivol { display: grid; grid-template-columns: 4.6em 1fr auto auto; align-items: center; gap: 8px; padding: 6px 0; border-top: 1px solid var(--mc-line); }
  .mc-ivol:first-child { border-top: none; }
  .mc-ivol-n { font-weight: 600; font-size: 0.9em; }
  .mc-ivol-d { font-size: 0.74em; color: var(--secondary-text-color); }
  .mc-ivol .mc-btn { min-height: 34px; padding: 0 12px; font-size: 0.82em; }
  .mc-status { font-size: 0.72em; font-weight: 700; padding: 3px 9px; border-radius: 999px; white-space: nowrap;
    background: color-mix(in srgb, var(--primary-text-color) 12%, transparent); }
  .mc-status.wanted, .mc-status.snatched { background: color-mix(in srgb, var(--mc-accent) 35%, transparent); }
  .mc-status.done { background: color-mix(in srgb, #34c759 35%, transparent); }
  .mc-status.failed { background: color-mix(in srgb, var(--error-color, #db4437) 40%, transparent); }
  .mc-end .mc-title { font-size: 1.15em; font-weight: 700; }
</style>`;

// ─────────────────────────────────────────────────────────────────────────
// The card
// ─────────────────────────────────────────────────────────────────────────

class MangaCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = { ...DEFAULT_CONFIG };
    this._hass = null;
    this._connected = false;
    this._skeletonReady = false;
    this._signed = new Map(); // image path -> Promise<signed path>
    this._signedCache = new Map(); // image path -> signed path (resolved)
    this._error = null;

    // Library
    this._libraries = [];
    this._libraryId = null;
    this._filter = "";
    this._series = [];
    this._seriesTotal = 0;
    this._seriesPage = 0;
    this._loading = false;
    this._loaded = false;
    this._continue = []; // in-progress / on-deck books
    this._searchToken = 0;

    // Detail
    this._detailId = null;
    this._detail = null; // { series, books }

    // Mylar (search / add / download) - only when the integration has a Mylar configured
    this._tab = "library"; // library | search | downloads
    this._mylar = false; // true once Mylar answered
    this._mylarIndex = []; // series Mylar follows
    this._findDraft = "";
    this._findQuery = "";
    this._found = null; // ComicVine hits of the last search
    this._findBusy = false;
    this._findToken = 0;
    this._lang = LANGS.some(([id]) => id === store(LANG_KEY)) ? store(LANG_KEY) : "all";
    this._adding = new Set();
    this._open = null; // Mylar series unfolded in the search tab
    this._seriesCache = new Map(); // Mylar series id -> { comic, issues }
    this._pending = new Set(); // issue ids whose change is still travelling to Mylar
    this._dl = { wanted: [], history: [], loaded: false };
    this._ppSeen = null; // Set of finished downloads Komga was told about
    this._queueing = false;
    this._notice = null;

    // Reader
    this._reader = null;
    this._saveProgress = debounce(() => this._persistProgress(), SEEK_DEBOUNCE_MS);
  }

  // ── Home Assistant lifecycle ────────────────────────────────────────

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first && this._connected) this._initialLoad();
  }

  get hass() {
    return this._hass;
  }

  setConfig(config) {
    if (!config) throw new Error("Invalid configuration");
    this._config = { ...DEFAULT_CONFIG, ...config };
    if (this._connected) this._render();
  }

  getCardSize() {
    return 8;
  }

  static getConfigElement() {
    return document.createElement(EDITOR_TAG);
  }

  static getStubConfig() {
    return { title: "Manga" };
  }

  connectedCallback() {
    this._connected = true;
    clearTimeout(this._overlayCleanupTimer);
    this._ensureSkeleton();
    if (!this._overlay.isConnected) document.body.appendChild(this._overlay);
    for (const root of [this.shadowRoot, this._overlayRoot]) {
      root.addEventListener("click", this._handleClick);
      root.addEventListener("input", this._handleInput);
      root.addEventListener("change", this._handleChange);
      root.addEventListener("submit", this._handleSubmit);
    }
    this._render();
    if (this._hass) this._initialLoad();
  }

  disconnectedCallback() {
    this._connected = false;
    for (const root of [this.shadowRoot, this._overlayRoot]) {
      if (!root) continue;
      root.removeEventListener("click", this._handleClick);
      root.removeEventListener("input", this._handleInput);
      root.removeEventListener("change", this._handleChange);
      root.removeEventListener("submit", this._handleSubmit);
    }
    this._stopPoll();
    // A re-insert comes back within the same frame; only a card that is really gone releases its overlay.
    clearTimeout(this._overlayCleanupTimer);
    this._overlayCleanupTimer = setTimeout(() => {
      if (!this._connected && !this._readerDialog?.open) this._overlay?.remove();
    }, 30000);
  }

  // ── Skeleton ─────────────────────────────────────────────────────────

  _ensureSkeleton() {
    if (this._skeletonReady) return;
    this._skeletonReady = true;
    this.shadowRoot.innerHTML = `${STYLE}<ha-card><div class="mc-root">
      <div class="mc-header" id="mc-title"></div>
      <div id="mc-error"></div>
      <div class="mc-tabs" id="mc-tabs" hidden></div>
      <form class="mc-searchbar" id="mc-searchbar" data-submit="search"><input type="search" id="mc-search" placeholder="Serie suchen" autocomplete="off" enterkeyhint="search" data-input="filter"><button type="submit" class="mc-btn" id="mc-find" hidden>Suchen</button></form>
      <div class="mc-body" id="mc-body"></div>
    </div></ha-card>`;

    // Dialogs live in an overlay attached to <body>: HA's dashboard layouts detach and re-insert cards, and a
    // modal <dialog> moved like that silently drops out of the top layer (the reader would look "closed").
    this._overlay = document.createElement("div");
    this._overlay.className = "manga-card-overlay";
    this._overlayRoot = this._overlay.attachShadow({ mode: "open" });
    this._overlayRoot.innerHTML = `${STYLE}<dialog class="mc-dialog" id="mc-detail"></dialog><dialog class="mc-dialog" id="mc-reader"></dialog>`;
    document.body.appendChild(this._overlay);
    this._detailDialog = this._overlayRoot.getElementById("mc-detail");
    this._readerDialog = this._overlayRoot.getElementById("mc-reader");
    this._detailDialog.addEventListener("close", () => {
      this._detailId = null;
      this._detail = null;
    });
    this._readerDialog.addEventListener("close", () => this._closeReader());
    this._readerDialog.addEventListener("keydown", (ev) => this._onReaderKey(ev));
  }

  // ── Events (data-action="x" → _onAction_x) ─────────────────────────

  _handleClick = (ev) => {
    const el = ev.target.closest("[data-action]");
    if (!el) return;
    const handler = this[`_onAction_${el.dataset.action}`];
    if (typeof handler === "function") {
      ev.preventDefault();
      handler.call(this, el, ev);
    }
  };

  _handleInput = (ev) => {
    const el = ev.target.closest("[data-input]");
    if (!el) return;
    const handler = this[`_onInput_${el.dataset.input}`];
    if (typeof handler === "function") handler.call(this, el, ev);
  };

  // A form without a handler navigates on Enter - inside a dashboard that reloads the whole page.
  _handleSubmit = (ev) => {
    const form = ev.target.closest("[data-submit]");
    if (!form) return;
    ev.preventDefault();
    const handler = this[`_onSubmit_${form.dataset.submit}`];
    if (typeof handler === "function") handler.call(this, form, ev);
  };

  _handleChange = (ev) => {
    const el = ev.target.closest("[data-change]");
    if (!el) return;
    const handler = this[`_onChange_${el.dataset.change}`];
    if (typeof handler === "function") handler.call(this, el, ev);
  };

  // ── Networking ───────────────────────────────────────────────────────

  async _call(prefix, method, path, body) {
    try {
      return await this._hass.callApi(method, `${prefix}${path}`, body);
    } catch (err) {
      if (errStatus(err) === 401 && this._hass?.connection?.refreshAccessToken) {
        try {
          await this._hass.connection.refreshAccessToken();
        } catch (_) {
          /* retry with whatever token we have */
        }
        return this._hass.callApi(method, `${prefix}${path}`, body);
      }
      throw err;
    }
  }

  _api(method, path, body) {
    return this._call(KOMGA, method, path, body);
  }

  /** Mylar answers HTTP 200 with {"success": false, ...} for its own errors. */
  async _my(method, cmd, params) {
    const res = await this._call(MYLAR, method, `${cmd}${qs(params || {})}`);
    if (res && !Array.isArray(res) && res.success === false) throw new Error(res.error?.message || "Mylar-Fehler");
    return res;
  }

  _sign(path) {
    if (!this._signed.has(path)) {
      const p = this._hass
        .callWS({ type: "auth/sign_path", path, expires: SIGN_EXPIRY_SECONDS })
        .then((r) => {
          this._signedCache.set(path, r.path);
          return r.path;
        })
        .catch((err) => {
          this._signed.delete(path);
          throw err;
        });
      this._signed.set(path, p);
    }
    return this._signed.get(path);
  }

  _setError(err, context) {
    this._error = context ? `${context}: ${errMessage(err)}` : errMessage(err);
    console.error("[manga-card]", context || "", err); // eslint-disable-line no-console
    this._renderError();
  }

  _onAction_dismissError() {
    this._error = null;
    this._renderError();
  }

  // ── Library ──────────────────────────────────────────────────────────

  async _initialLoad() {
    if (this._loaded) return;
    this._loaded = true;
    try {
      this._libraries = (await this._api("GET", "v1/libraries")) || [];
      await Promise.all([this._loadSeries(true), this._loadContinue()]);
      this._probeMylar();
    } catch (err) {
      this._loaded = false;
      this._loading = false;
      this._setError(err, "Komga");
      this._render();
    }
  }

  async _loadSeries(reset) {
    if (reset) {
      this._seriesPage = 0;
      this._series = [];
    }
    const token = ++this._searchToken;
    this._loading = true;
    this._render();
    const res = await this._api("GET", `v1/series${qs({
      library_id: this._libraryId, search: this._filter, page: this._seriesPage, size: PAGE_SIZE, sort: "metadata.titleSort,asc",
    })}`);
    if (token !== this._searchToken) return; // a newer search replaced this one
    this._series = reset ? res.content : [...this._series, ...res.content];
    this._seriesTotal = res.totalElements;
    this._loading = false;
    this._render();
  }

  async _loadContinue() {
    const [reading, deck] = await Promise.all([
      this._api("GET", `v1/books${qs({ read_status: "IN_PROGRESS", sort: "readProgress.readDate,desc", size: 12 })}`).catch(() => null),
      this._api("GET", `v1/books/ondeck${qs({ size: 12 })}`).catch(() => null),
    ]);
    const seen = new Set();
    this._continue = [...(reading?.content || []), ...(deck?.content || [])].filter((b) => !seen.has(b.id) && seen.add(b.id));
    this._render();
  }

  _onInput_filter(el) {
    if (this._tab === "search") {
      this._findDraft = el.value; // ComicVine is slow and rate limited: search on Enter / the button, not while typing
      if (!el.value.trim() && this._found !== null) { // emptied the field: back to "Deine Serien"
        this._found = null;
        this._findQuery = "";
        this._findToken++; // a search still running must not bring its hits back
        this._findBusy = false;
        this._render();
      }
      return;
    }
    this._filter = el.value.trim();
    clearTimeout(this._filterTimer);
    this._filterTimer = setTimeout(() => this._loadSeries(true).catch((e) => this._setError(e, "Suche")), 350);
  }

  _onAction_library(el) {
    this._libraryId = el.dataset.id || null;
    this._loadSeries(true).catch((e) => this._setError(e, "Bibliothek"));
  }

  _onAction_moreSeries() {
    this._seriesPage += 1;
    this._loadSeries(false).catch((e) => this._setError(e, "Bibliothek"));
  }

  // ── Rendering ────────────────────────────────────────────────────────

  _render() {
    if (!this._skeletonReady) return;
    const title = this.shadowRoot.getElementById("mc-title");
    if (title) title.textContent = this._config.title || "Manga";
    this._renderError();
    this._renderTabs();
    const body = this.shadowRoot.getElementById("mc-body");
    if (!body) return;
    const html = this._tab === "search" ? this._renderSearch() : this._tab === "downloads" ? this._renderDownloads() : this._renderBody();
    if (body._html !== html) {
      body._html = html;
      this._setHtml(body, html);
    }
  }

  _renderError() {
    const el = this.shadowRoot?.getElementById("mc-error");
    if (!el) return;
    el.innerHTML = this._error
      ? `<div class="mc-error"><span>${esc(this._error)}</span><button data-action="dismissError" aria-label="Schließen">✕</button></div>`
      : this._notice ? `<div class="mc-notice">${esc(this._notice)}</div>` : "";
  }

  _renderBody() {
    if (!this._loaded && !this._error) return `<div class="mc-loading">Bibliothek wird geladen…</div>`;
    const chips = this._libraries.length > 1
      ? `<div class="mc-chips"><button class="mc-chip ${this._libraryId ? "" : "active"}" data-action="library" data-id="">Alle</button>${this._libraries
          .map((l) => `<button class="mc-chip ${this._libraryId === l.id ? "active" : ""}" data-action="library" data-id="${esc(l.id)}">${esc(l.name)}</button>`)
          .join("")}</div>`
      : "";
    const cont = this._continue.length && !this._filter
      ? `<div class="mc-section">Weiterlesen</div><div class="mc-row">${this._continue.map((b) => this._bookTile(b)).join("")}</div>`
      : "";
    let grid;
    if (this._loading && !this._series.length) grid = `<div class="mc-loading">Lädt…</div>`;
    else if (!this._series.length) {
      grid = `<div class="mc-empty">${this._filter ? "Keine Serie gefunden." : `Noch keine Mangas in Komga.<br>${this._mylar ? "Im Tab „Suchen“ findest du welche und lädst sie herunter." : "Sobald Dateien in der Bibliothek liegen, erscheinen sie hier."}`}</div>`;
    } else {
      grid = `<div class="mc-grid">${this._series.map((s) => this._seriesTile(s)).join("")}</div>`;
      if (this._series.length < this._seriesTotal) {
        grid += `<button class="mc-btn secondary block" data-action="moreSeries" ${this._loading ? "disabled" : ""}>Mehr laden (${this._seriesTotal - this._series.length})</button>`;
      }
    }
    return `${chips}${cont}<div class="mc-section">Bibliothek${this._seriesTotal ? ` · ${this._seriesTotal}` : ""}</div>${grid}`;
  }

  _cover(path, title, extra = "") {
    return `<div class="mc-cover"><div class="mc-cover-fallback">${esc(title)}</div><img data-src="${esc(KOMGA_URL + path)}" alt="" loading="lazy" onerror="this.remove()">${extra}</div>`;
  }

  _seriesTile(s) {
    const unread = s.booksUnreadCount || 0;
    const badge = unread > 0 ? `<span class="mc-badge">${unread}</span>` : s.booksCount ? `<span class="mc-badge done">✓</span>` : "";
    return `<div class="mc-tile" data-action="openSeries" data-id="${esc(s.id)}">
      ${this._cover(`v1/series/${s.id}/thumbnail`, s.metadata?.title || s.name, badge)}
      <div class="mc-tile-title">${esc(s.metadata?.title || s.name)}</div>
      <div class="mc-tile-sub">${s.booksCount} ${s.booksCount === 1 ? "Band" : "Bände"}</div></div>`;
  }

  _bookTile(b) {
    const p = pct(b);
    const bar = p > 0 && p < 100 ? `<div class="mc-progressbar"><div style="width:${p}%"></div></div>` : "";
    const sub = b.readProgress && !b.readProgress.completed ? `Seite ${b.readProgress.page}/${b.media?.pagesCount}` : "Nächster Band";
    return `<div class="mc-tile" data-action="continueBook" data-id="${esc(b.id)}" data-series="${esc(b.seriesId)}">
      ${this._cover(`v1/books/${b.id}/thumbnail`, b.seriesTitle, bar)}
      <div class="mc-tile-title">${esc(b.seriesTitle || bookTitle(b))}</div>
      <div class="mc-tile-sub">${esc(bookTitle(b))} · ${sub}</div></div>`;
  }

  // Rebuilding markup drops the signed src of every <img data-src>; load them again.
  _setHtml(el, html) {
    el.innerHTML = html;
    this._hydrate(el);
  }

  /** Polling re-renders often; only touch the DOM (and the scroll position) when something changed. */
  _setIfChanged(el, html) {
    if (el._html === html) return;
    el._html = html;
    this._setHtml(el, html);
  }

  _hydrate(root) {
    root.querySelectorAll("img[data-src]").forEach((img) => {
      const path = img.dataset.src;
      const cached = this._signedCache.get(path);
      if (cached) {
        if (img.getAttribute("src") !== cached) img.setAttribute("src", cached);
        return;
      }
      this._sign(path).then((signed) => img.setAttribute("src", signed)).catch(() => img.remove());
    });
  }

  // ── Mylar: tabs, search, add, download ───────────────────────────────

  /** Does Mylar answer? Without a Mylar in the integration's settings (503 "not configured") the card stays a plain reader. */
  async _probeMylar() {
    try {
      const idx = await this._my("GET", "getIndex");
      this._mylarIndex = idx.data || [];
      this._mylar = true;
    } catch (err) {
      const notConfigured = errStatus(err) === 503 && /not configured/i.test(errMessage(err));
      this._mylar = !notConfigured; // configured but unreachable right now: show the tabs, they explain what is wrong
      if (!notConfigured) this._setError(err, "Mylar");
    }
    this._render();
    if (this._mylar) this._loadDownloads().catch(() => {}); // fills the tab badge and notices volumes that finished while the card was closed
  }

  _renderTabs() {
    const el = this.shadowRoot.getElementById("mc-tabs");
    if (!el) return;
    el.hidden = !this._mylar;
    const bar = this.shadowRoot.getElementById("mc-searchbar");
    const input = this.shadowRoot.getElementById("mc-search");
    const find = this.shadowRoot.getElementById("mc-find");
    if (bar) bar.hidden = this._tab === "downloads";
    if (find) find.hidden = this._tab !== "search";
    if (input) input.placeholder = this._tab === "search" ? "Titel suchen, z. B. Attack on Titan" : "Serie suchen";
    if (!this._mylar) return;
    const active = this._activeDownloads();
    const html = [["library", "Bibliothek"], ["search", "Suchen"], ["downloads", "Downloads"]]
      .map(([id, label]) => `<button class="mc-tab ${this._tab === id ? "active" : ""}" data-action="tab" data-tab="${id}">${label}${
        id === "downloads" && active ? `<span class="mc-badge">${active}</span>` : ""}</button>`)
      .join("");
    if (el._html !== html) {
      el._html = html;
      el.innerHTML = html;
    }
  }

  _onAction_tab(el) {
    this._tab = el.dataset.tab;
    const input = this.shadowRoot.getElementById("mc-search");
    if (input) input.value = this._tab === "search" ? this._findDraft : this._tab === "library" ? this._filter : "";
    if (this._tab === "downloads") {
      this._loadDownloads().catch((e) => this._setError(e, "Downloads"));
      this._startPoll();
    } else if (this._tab === "search" && this._open) {
      this._loadMylar(this._open).catch(() => {});
      this._startPoll();
    }
    this._render();
  }

  _onSubmit_search() {
    if (this._tab === "search") this._runFind();
  }

  async _runFind() {
    const q = this._findDraft.trim();
    if (q.length < 2) return;
    const token = ++this._findToken;
    this._findQuery = q;
    this._findBusy = true;
    this._found = null;
    this._render();
    try {
      const res = await this._my("GET", "findComic", { name: q });
      if (token === this._findToken) this._found = Array.isArray(res) ? res : [];
    } catch (err) {
      if (token === this._findToken) {
        this._found = [];
        this._setError(err, "Suche");
      }
    }
    if (token === this._findToken) {
      this._findBusy = false;
      this._render();
    }
  }

  _onAction_lang(el) {
    this._lang = el.dataset.lang;
    store(LANG_KEY, this._lang);
    this._render();
  }

  _ext(url, title, cls = "") {
    // ComicVine covers load straight from ComicVine (they are not in Komga or Mylar's cache).
    return `<div class="mc-cover ${cls}"><div class="mc-cover-fallback">${esc(title)}</div>${
      /^https:\/\//.test(url || "") ? `<img src="${esc(url)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ""}</div>`;
  }

  _renderSearch() {
    if (this._findBusy) return `<div class="mc-loading">Suche bei ComicVine… (kann einen Moment dauern)</div>`;
    const mine = new Set(this._mylarIndex.map((s) => String(s.id)));
    if (this._found === null) {
      const rows = this._mylarIndex
        .map((s) => this._itemRow({
          id: String(s.id), name: s.name, cover: s.imageURL, mine: true,
          sub: s.status === "Loading" ? "Wird angelegt…" : [s.publisher, s.year, `${s.totalIssues ?? "?"} Bände`].filter(Boolean).join(" · "),
        }))
        .join("");
      return `<div class="mc-hint">Gib oben einen Titel ein und tippe auf „Suchen“. Du wählst dann die Ausgabe (Verlag, Jahr, Bandzahl) und lädst die Bände einzeln herunter.</div>
        ${rows ? `<div class="mc-section">Deine Serien</div><div class="mc-list">${rows}</div>` : ""}`;
    }
    const all = this._found;
    const shown = all.filter((r) => inLanguage(r, this._lang)).slice(0, 60);
    const chips = `<div class="mc-chips">${LANGS.map(([id, label]) =>
      `<button class="mc-chip ${this._lang === id ? "active" : ""}" data-action="lang" data-lang="${id}">${label} (${all.filter((r) => inLanguage(r, id)).length})</button>`).join("")}</div>`;
    if (!shown.length) {
      const what = { de: "deutsche", en: "englische" }[this._lang];
      return `${chips}<div class="mc-empty">${all.length ? `Keine ${what} Ausgabe gefunden. Tippe auf „Alle“.` : `Nichts gefunden für „${esc(this._findQuery)}“.`}</div>`;
    }
    const rows = shown.map((r) => this._itemRow({
      id: String(r.comicid), name: r.name, cover: r.comicthumb || r.comicimage, mine: mine.has(String(r.comicid)), badge: true,
      sub: [r.publisher, r.comicyear, `${r.issues} ${Number(r.issues) === 1 ? "Band" : "Bände"}`].filter(Boolean).join(" · "),
    }));
    return `${chips}<div class="mc-list">${rows.join("")}</div>`;
  }

  /**
   * One series in the search tab - a search hit or a series Mylar follows. Series Mylar knows unfold right below their row
   * (no popup: you stay where you are, with the hits above and below); everything else offers "Hinzufügen".
   */
  _itemRow(r) {
    const open = r.mine && this._open === r.id;
    const busy = this._adding.has(r.id);
    const right = r.mine
      ? `${r.badge ? `<span class="mc-status done">In Mylar</span>` : ""}<span class="mc-chev">›</span>`
      : `<button class="mc-btn" data-action="addSeries" data-id="${esc(r.id)}" ${busy ? "disabled" : ""}>${busy ? "Wird angelegt…" : "Hinzufügen"}</button>`;
    return `<div class="mc-item ${open ? "open" : ""}" data-item="${esc(r.id)}">
      <div class="mc-res" ${r.mine ? `data-action="toggleSeries" data-id="${esc(r.id)}" role="button" aria-expanded="${open}"` : ""}>${this._ext(r.cover, r.name)}
        <div class="mc-vol-main"><div class="mc-vol-title">${esc(r.name)}</div><div class="mc-vol-sub">${esc(r.sub)}</div></div>${right}</div>
      ${open ? `<div class="mc-panel" data-panel="${esc(r.id)}">${this._panelHtml(r.id)}</div>` : ""}</div>`;
  }

  async _onAction_addSeries(el) {
    const id = el.dataset.id;
    if (this._adding.has(id)) return;
    this._adding.add(id);
    this._render();
    try {
      await this._my("POST", "addComic", { id });
      this._mylarIndex = (await this._my("GET", "getIndex")).data || [];
      this._adding.delete(id);
      this._open = id; // unfold it in place
      this._render();
      this._revealItem(id);
      await this._loadMylar(id);
      this._startPoll();
    } catch (err) {
      this._adding.delete(id);
      this._render();
      this._setError(err, "Hinzufügen");
    }
  }

  _revealItem(id) {
    const item = [...this.shadowRoot.querySelectorAll("[data-item]")].find((n) => n.dataset.item === id);
    item?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }

  // ── Mylar series: volumes and their download state (unfolded under the row) ─

  _onAction_toggleSeries(el) {
    const id = el.dataset.id;
    this._open = this._open === id ? null : id;
    this._render();
    if (!this._open) return;
    this._revealItem(id);
    this._loadMylar(id).catch((err) => {
      this._open = null;
      this._render();
      this._setError(err, "Serie laden");
    });
    this._startPoll();
  }

  async _loadMylar(id) {
    const res = await this._my("GET", "getComic", { id });
    const d = res.data || {};
    const issues = [...(d.issues || [])].sort((a, b) => volumeNumber(a.number) - volumeNumber(b.number));
    // A change that is still travelling to Mylar (optimistic) must not be undone by an older answer.
    const old = this._seriesCache.get(id);
    for (const i of issues) {
      const mine = old?.issues.find((o) => String(o.id) === String(i.id));
      if (mine && this._pending.has(String(i.id))) i.status = mine.status;
    }
    this._seriesCache.set(id, { comic: (d.comic || [])[0] || null, issues }); // comic is empty while Mylar still fetches it from ComicVine
    this._updatePanel(id);
  }

  _panelHtml(id) {
    const d = this._seriesCache.get(id);
    if (!d || !d.comic) return `<div class="mc-loading">${d ? "Serie wird angelegt…" : "Lädt…"}</div>`;
    const { comic, issues } = d;
    const count = (st) => issues.filter((i) => i.status === st).length;
    const todo = issues.filter((i) => i.status === "Skipped" || i.status === "Failed").length;
    const pills = [
      `<span class="mc-pill">${issues.length} Bände</span>`,
      count("Downloaded") ? `<span class="mc-pill ok">${count("Downloaded")} fertig</span>` : "",
      count("Wanted") + count("Snatched") ? `<span class="mc-pill">${count("Wanted") + count("Snatched")} in Arbeit</span>` : "",
      comic.publishYear ? `<span class="mc-pill">${esc(comic.publishYear)}</span>` : "",
    ].join("");
    const rows = issues.map((i) => {
      const st = i.status || "Skipped";
      const busy = this._pending.has(String(i.id));
      const cls = st === "Downloaded" ? "done" : st === "Wanted" ? "wanted" : st === "Snatched" ? "snatched" : st === "Failed" ? "failed" : "";
      let act = "";
      if (st === "Skipped" || st === "Failed") act = `<button class="mc-btn secondary" data-action="queueVolume" data-id="${esc(i.id)}" ${busy ? "disabled" : ""}>Laden</button>`;
      else if (st === "Wanted") act = `<button class="mc-btn secondary" data-action="unqueueVolume" data-id="${esc(i.id)}" ${busy ? "disabled" : ""}>${busy ? "…" : "Abbrechen"}</button>`;
      const date = i.releaseDate && i.releaseDate !== "0000-00-00" ? i.releaseDate : i.issueDate && i.issueDate !== "0000-00-00" ? i.issueDate : "";
      return `<div class="mc-ivol"><span class="mc-ivol-n">Band ${esc(i.number)}</span><span class="mc-ivol-d">${esc(date)}</span>
        <span class="mc-status ${cls}">${esc(ISSUE_STATUS[st] || st)}</span>${act}</div>`;
    });
    return `<div class="mc-pills">${pills}</div>
      <button class="mc-btn block" data-action="queueNext" ${todo && !this._queueing ? "" : "disabled"}>${
        this._queueing ? "Wird angestoßen…" : todo ? `Nächste ${Math.min(todo, BULK_VOLUMES)} Bände laden` : "Alles geladen oder in Arbeit"}</button>
      <div class="mc-hint">Jeder Band löst eine Suche bei deinen Indexern aus (die haben Stundenlimits), darum immer nur ein paar auf einmal.</div>
      <div class="mc-inline-vols">${rows.join("") || `<div class="mc-empty">Mylar kennt noch keine Bände.</div>`}</div>`;
  }

  /** Redraw only the unfolded panel: the list above it and the scroll position of the volume list stay put. */
  _updatePanel(id) {
    const el = [...this.shadowRoot.querySelectorAll("[data-panel]")].find((n) => n.dataset.panel === id);
    if (!el) return;
    const list = el.querySelector(".mc-inline-vols");
    const top = list ? list.scrollTop : 0;
    this._setIfChanged(el, this._panelHtml(id));
    const body = this.shadowRoot.getElementById("mc-body");
    if (body) body._html = null; // the DOM no longer matches the last full render
    const again = el.querySelector(".mc-inline-vols");
    if (again && top) again.scrollTop = top;
  }

  _setIssueStatus(id, status, sid = this._open) {
    const issue = this._seriesCache.get(sid)?.issues.find((i) => String(i.id) === String(id));
    if (issue) issue.status = status;
  }

  _issueStatus(id, sid = this._open) {
    return this._seriesCache.get(sid)?.issues.find((i) => String(i.id) === String(id))?.status;
  }

  /** The screen reacts at once; Mylar can be slow while it works through its indexer pauses. A failure puts things back. */
  async _queue(ids) {
    if (this._queueing) return;
    const sid = this._open;
    this._queueing = true;
    const before = new Map(ids.map((id) => [String(id), this._issueStatus(id, sid)]));
    ids.forEach((id) => {
      this._setIssueStatus(id, "Wanted", sid);
      this._pending.add(String(id));
    });
    this._updatePanel(sid);
    const gap = this._config.queue_gap_ms ?? BULK_GAP_MS;
    let sent = 0;
    try {
      for (; sent < ids.length; sent++) {
        if (sent) await sleep(gap); // spread the indexer searches out
        await this._my("POST", "queueIssue", { id: ids[sent] }); // answers at once, Mylar searches in the background
        this._pending.delete(String(ids[sent]));
        this._updatePanel(sid);
      }
    } catch (err) {
      ids.slice(sent).forEach((id) => {
        this._setIssueStatus(id, before.get(String(id)), sid);
        this._pending.delete(String(id));
      });
      this._setError(err, "Download");
    }
    this._queueing = false;
    this._updatePanel(sid);
    this._loadDownloads().catch(() => {}); // the downloads badge
    this._startPoll();
    this._pollSoon();
  }

  _onAction_queueVolume(el) {
    return this._queue([el.dataset.id]);
  }

  _onAction_queueNext() {
    const ids = (this._seriesCache.get(this._open)?.issues || []).filter((i) => i.status === "Skipped" || i.status === "Failed").slice(0, BULK_VOLUMES).map((i) => i.id);
    return ids.length ? this._queue(ids) : undefined;
  }

  async _onAction_unqueueVolume(el) {
    const sid = this._open;
    const id = String(el.dataset.id);
    if (this._pending.has(id)) return;
    this._setIssueStatus(id, "Skipped", sid);
    this._pending.add(id);
    this._updatePanel(sid);
    try {
      await this._my("POST", "unqueueIssue", { id });
    } catch (err) {
      this._setIssueStatus(id, "Wanted", sid);
      this._setError(err, "Abbrechen");
    }
    this._pending.delete(id);
    this._updatePanel(sid);
    this._loadDownloads().catch(() => {});
  }

  // ── Downloads ────────────────────────────────────────────────────────

  async _loadDownloads() {
    const [wanted, history] = await Promise.all([this._my("GET", "getWanted"), this._my("GET", "getHistory")]);
    this._dl = { wanted: wanted.issues || [], history: history.data || [], loaded: true };
    this._render();
    this._checkFinished(this._dl.history).catch(() => {});
  }

  /** One row per volume: still searched, being downloaded, or finished. Mylar's history says "Post-Processed" when a volume is filed. */
  _downloadRows() {
    const rows = [];
    const byIssue = new Map();
    for (const h of [...this._dl.history].sort((a, b) => String(b.DateAdded).localeCompare(String(a.DateAdded)))) {
      const prev = byIssue.get(h.IssueID);
      if (!prev || (h.Status === "Post-Processed" && prev.Status !== "Post-Processed")) byIssue.set(h.IssueID, h);
    }
    const wantedIds = new Set(this._dl.wanted.map((w) => String(w.IssueID)));
    for (const w of this._dl.wanted) {
      rows.push({ state: "wanted", title: w.ComicName, vol: w.Issue_Number, at: w.DateAdded, provider: "" });
    }
    for (const h of byIssue.values()) {
      if (wantedIds.has(String(h.IssueID))) continue;
      const state = h.Status === "Post-Processed" ? "done" : h.Status === "Snatched" ? "snatched" : "failed";
      rows.push({ state, title: h.ComicName, vol: h.Issue_Number, at: h.DateAdded, provider: h.Provider || "", raw: h.Status });
    }
    const order = { wanted: 0, snatched: 1, failed: 2, done: 3 };
    return rows.sort((a, b) => order[a.state] - order[b.state] || String(b.at).localeCompare(String(a.at))).slice(0, 40);
  }

  _activeDownloads() {
    return this._dl.wanted.length + this._downloadRows().filter((r) => r.state === "snatched").length;
  }

  _renderDownloads() {
    const actions = `<div class="mc-actions-row"><button class="mc-btn secondary" data-action="refreshDownloads">Aktualisieren</button>
      <button class="mc-btn secondary" data-action="scanKomga">Komga aktualisieren</button></div>`;
    if (!this._dl.loaded) return `${actions}<div class="mc-loading">Lädt…</div>`;
    const rows = this._downloadRows();
    if (!rows.length) return `${actions}<div class="mc-empty">Noch keine Downloads.<br>Im Tab „Suchen“ eine Serie hinzufügen und Bände laden.</div>`;
    const label = { wanted: "Wird gesucht", snatched: "Lädt…", done: "Fertig", failed: "Fehlgeschlagen" };
    const line = (r) => {
      const stuck = r.state === "snatched" && Date.now() - new Date(String(r.at).replace(" ", "T")).getTime() > 15 * 60 * 1000;
      const sub = [r.provider, r.at, stuck ? "wartet schon länger – schau in Mylar nach" : ""].filter(Boolean).join(" · ");
      return `<div class="mc-res"><div class="mc-vol-main"><div class="mc-vol-title">${esc(r.title)} · Band ${esc(r.vol)}</div>
        <div class="mc-vol-sub">${esc(sub)}</div></div><span class="mc-status ${r.state}">${label[r.state]}</span></div>`;
    };
    const active = rows.filter((r) => r.state === "wanted" || r.state === "snatched");
    const past = rows.filter((r) => r.state === "done" || r.state === "failed");
    return `${actions}${active.length ? `<div class="mc-section">Aktiv</div><div class="mc-list">${active.map(line).join("")}</div>` : ""}${
      past.length ? `<div class="mc-section">Zuletzt</div><div class="mc-list">${past.map(line).join("")}</div>` : ""}`;
  }

  _onAction_refreshDownloads() {
    this._loadDownloads().catch((e) => this._setError(e, "Downloads"));
  }

  async _onAction_scanKomga() {
    try {
      await this._scanKomga();
      this._setNotice("Komga scannt die Bibliothek. Neue Bände erscheinen gleich im Tab „Bibliothek“.");
    } catch (err) {
      this._setError(err, "Komga");
    }
  }

  _setNotice(text) {
    this._notice = text;
    this._renderError();
    clearTimeout(this._noticeTimer);
    this._noticeTimer = setTimeout(() => {
      this._notice = null;
      this._renderError();
    }, 5000);
  }

  /** Ask Komga to look at its libraries now (cheap: unchanged folders are skipped). */
  async _scanKomga() {
    const libs = this._libraries.length ? this._libraries : (await this._api("GET", "v1/libraries")) || [];
    await Promise.all(libs.map((l) => this._api("POST", `v1/libraries/${l.id}/scan`)));
    clearTimeout(this._rescanTimer);
    this._rescanTimer = setTimeout(() => {
      this._loadSeries(true).catch(() => {});
      this._loadContinue().catch(() => {});
    }, this._config.rescan_wait_ms ?? 6000);
  }

  /**
   * A finished download ("Post-Processed") is a new file in the library folder: tell Komga once. Already finished volumes are
   * remembered (the first run only takes a baseline), so old history never triggers a scan.
   */
  async _checkFinished(history) {
    if (!history) history = (await this._my("GET", "getHistory")).data || [];
    const done = history.filter((h) => h.Status === "Post-Processed").map((h) => `${h.IssueID}|${h.DateAdded}`);
    if (this._ppSeen === null) {
      const raw = store(SEEN_KEY);
      try {
        this._ppSeen = new Set(raw === null ? done : JSON.parse(raw));
      } catch (_) {
        this._ppSeen = new Set(done);
      }
      if (raw === null) store(SEEN_KEY, JSON.stringify([...this._ppSeen]));
    }
    const fresh = done.filter((k) => !this._ppSeen.has(k));
    if (!fresh.length) return;
    fresh.forEach((k) => this._ppSeen.add(k));
    store(SEEN_KEY, JSON.stringify([...this._ppSeen]));
    await this._scanKomga();
  }

  // ── Polling (only while something on screen can change) ──────────────

  _startPoll() {
    if (this._pollTimer || !this._connected) return;
    this._pollTimer = setInterval(() => this._poll(), this._config.poll_ms ?? POLL_MS);
  }

  _stopPoll() {
    clearInterval(this._pollTimer);
    this._pollTimer = null;
  }

  _pollSoon() {
    clearTimeout(this._pollSoonTimer);
    this._pollSoonTimer = setTimeout(() => this._poll(), 3000);
  }

  async _poll() {
    const open = this._tab === "search" ? this._open : null;
    if (!this._connected || (this._tab !== "downloads" && !open)) return this._stopPoll();
    try {
      const jobs = [];
      if (this._tab === "downloads") jobs.push(this._loadDownloads());
      if (open) jobs.push(this._loadMylar(open));
      await Promise.all(jobs);
    } catch (_) {
      /* a failed refresh is retried by the next tick; the screen keeps its last state */
    }
  }

  // ── Series detail ────────────────────────────────────────────────────

  async _onAction_openSeries(el) {
    await this._openSeries(el.dataset.id);
  }

  async _openSeries(id) {
    this._detailId = id;
    this._detail = null;
    this._renderDetail();
    if (!this._detailDialog.open) this._detailDialog.showModal();
    try {
      const [series, books] = await Promise.all([
        this._api("GET", `v1/series/${id}`),
        this._api("GET", `v1/series/${id}/books${qs({ size: 500, sort: "metadata.numberSort" })}`),
      ]);
      if (this._detailId !== id) return;
      this._detail = { series, books: books.content };
      this._renderDetail();
    } catch (err) {
      this._detailDialog.close();
      this._setError(err, "Serie laden");
    }
  }

  _renderDetail() {
    const d = this._detail;
    const close = `<button class="mc-btn secondary round mc-close" data-action="closeDetail" aria-label="Schließen">✕</button>`;
    if (!d) {
      this._setHtml(this._detailDialog, `<div class="mc-sheet">${close}<div class="mc-loading">Lädt…</div></div>`);
      return;
    }
    const { series, books } = d;
    const m = series.metadata || {};
    const next = this._nextBook(books);
    const allRead = books.length > 0 && books.every(isCompleted);
    const started = books.some((b) => b.readProgress);
    const pills = [
      m.status ? `<span class="mc-pill">${esc({ ONGOING: "Laufend", ENDED: "Abgeschlossen", HIATUS: "Pausiert", ABANDONED: "Eingestellt" }[m.status] || m.status)}</span>` : "",
      m.publisher ? `<span class="mc-pill">${esc(m.publisher)}</span>` : "",
      m.language ? `<span class="mc-pill">${esc(String(m.language).toUpperCase())}</span>` : "",
      `<span class="mc-pill">${books.length} ${books.length === 1 ? "Band" : "Bände"}</span>`,
      allRead ? `<span class="mc-pill ok">Gelesen</span>` : "",
    ].join("");
    const summary = m.summary || series.booksMetadata?.summary || "";
    const readLabel = !started ? "Lesen" : allRead ? "Nochmal lesen" : "Weiterlesen";
    this._setHtml(this._detailDialog, `<div class="mc-sheet">${close}
      <div class="mc-detail-top">${this._cover(`v1/series/${series.id}/thumbnail`, m.title || series.name)}
        <div><div class="mc-detail-title">${esc(m.title || series.name)}</div>
          <div class="mc-detail-sub">${esc((series.booksMetadata?.authors || []).map((a) => a.name).filter(Boolean).join(", "))}</div>
          <div class="mc-pills">${pills}</div></div></div>
      <div class="mc-actions">
        ${books.length ? `<button class="mc-btn block" data-action="readNext">${readLabel}${next ? ` · ${esc(bookTitle(next.book))}` : ""}</button>` : ""}
        <div class="mc-actions-row">
          <button class="mc-btn secondary" data-action="markSeries" data-read="1">Alle gelesen</button>
          <button class="mc-btn secondary" data-action="markSeries" data-read="0">Alle ungelesen</button></div>
      </div>
      ${summary ? `<div class="mc-summary">${esc(summary)}</div>` : ""}
      <div class="mc-section" style="margin-bottom:8px">Bände</div>
      <div class="mc-vols">${books.map((b) => this._volRow(b)).join("") || `<div class="mc-empty">Keine Bände gefunden.</div>`}</div></div>`);
  }

  _volRow(b) {
    const p = pct(b);
    const state = isCompleted(b) ? "Gelesen" : b.readProgress ? `Seite ${b.readProgress.page} von ${b.media?.pagesCount}` : `${b.media?.pagesCount ?? "?"} Seiten`;
    return `<div class="mc-vol" data-action="openBook" data-id="${esc(b.id)}">
      ${this._cover(`v1/books/${b.id}/thumbnail`, bookTitle(b))}
      <div class="mc-vol-main"><div class="mc-vol-title">${esc(bookTitle(b))}</div><div class="mc-vol-sub">${esc(state)}</div>
        ${p > 0 && p < 100 ? `<div class="mc-meter"><div style="width:${p}%"></div></div>` : ""}</div>
      <span>${isCompleted(b) ? "✓" : "›"}</span></div>`;
  }

  /** First volume that is in progress, else the first unread one, else null. */
  _nextBook(books) {
    const inProgress = books.find((b) => b.readProgress && !b.readProgress.completed);
    if (inProgress) return { book: inProgress };
    const unread = books.find((b) => !b.readProgress);
    return unread ? { book: unread } : null;
  }

  _onAction_closeDetail() {
    this._detailDialog.close();
  }

  _onAction_readNext() {
    const d = this._detail;
    if (!d || !d.books.length) return;
    const pick = this._nextBook(d.books)?.book || d.books[0];
    this._openReader(d.series, d.books, pick);
  }

  _onAction_openBook(el) {
    const d = this._detail;
    const book = d?.books.find((b) => b.id === el.dataset.id);
    if (book) this._openReader(d.series, d.books, book);
  }

  async _onAction_markSeries(el) {
    const d = this._detail;
    if (!d) return;
    try {
      await this._api(el.dataset.read === "1" ? "POST" : "DELETE", `v1/series/${d.series.id}/read-progress`);
      await this._refreshDetail();
    } catch (err) {
      this._setError(err, "Markieren");
    }
  }

  async _refreshDetail() {
    const id = this._detailId;
    if (!id) return;
    const [series, books] = await Promise.all([
      this._api("GET", `v1/series/${id}`),
      this._api("GET", `v1/series/${id}/books${qs({ size: 500, sort: "metadata.numberSort" })}`),
    ]);
    if (this._detailId !== id) return;
    this._detail = { series, books: books.content };
    this._renderDetail();
    this._loadSeries(true).catch(() => {});
    this._loadContinue().catch(() => {});
  }

  async _onAction_continueBook(el) {
    try {
      const [series, books] = await Promise.all([
        this._api("GET", `v1/series/${el.dataset.series}`),
        this._api("GET", `v1/series/${el.dataset.series}/books${qs({ size: 500, sort: "metadata.numberSort" })}`),
      ]);
      const book = books.content.find((b) => b.id === el.dataset.id);
      if (book) this._openReader(series, books.content, book);
    } catch (err) {
      this._setError(err, "Öffnen");
    }
  }

  // ── Reader ───────────────────────────────────────────────────────────

  async _openReader(series, books, book) {
    let pages;
    try {
      pages = await this._api("GET", `v1/books/${book.id}/pages`);
    } catch (err) {
      this._setError(err, "Seiten laden");
      return;
    }
    if (!pages?.length) {
      this._setError("Dieser Band enthält keine lesbaren Seiten.", "Lesen");
      return;
    }
    const saved = store(`mc-dir-${series.id}`);
    const resume = book.readProgress && !book.readProgress.completed ? book.readProgress.page - 1 : 0;
    this._reader = {
      series, books, book, pages,
      i: Math.max(0, Math.min(pages.length - 1, resume)),
      dir: DIRECTIONS[saved] ? saved : directionFromKomga(series.metadata?.readingDirection),
      fit: store("mc-fit") === "width" ? "width" : "height",
      menu: false, chrome: true, end: null,
      dirty: false, // nothing is written to Komga until the reader really turns a page (opening a volume must not touch its progress)
      settling: false,
    };
    this._renderReader();
    if (!this._readerDialog.open) this._readerDialog.showModal();
    this._readerDialog.focus();
    this._showPage(this._reader.i, true);
  }

  _renderReader() {
    const r = this._reader;
    if (!r) return;
    const last = r.pages.length;
    const scroll = r.dir === "scroll";
    const rtl = r.dir === "rtl";
    this._readerDialog.innerHTML = `<div class="mc-reader fit-${r.fit} ${r.chrome ? "" : "chrome-hidden"}" id="mc-rd">
      <div class="mc-r-top">
        <button class="mc-btn secondary round" data-action="closeReader" aria-label="Schließen">✕</button>
        <div class="mc-r-title">${esc(r.series.metadata?.title || r.series.name)} · ${esc(bookTitle(r.book))}</div>
        <button class="mc-btn secondary round" data-action="toggleMenu" aria-label="Einstellungen">⚙</button>
      </div>
      <div class="mc-r-menu" id="mc-menu" ${r.menu ? "" : "hidden"}>
        <div class="mc-hint">Leserichtung</div>
        <div class="row">${Object.entries(DIRECTIONS).map(([k, label]) => `<button class="mc-chip ${r.dir === k ? "active" : ""}" data-action="setDir" data-dir="${k}">${label}</button>`).join("")}</div>
        <div class="mc-hint">Anzeige</div>
        <div class="row"><button class="mc-chip ${r.fit === "height" ? "active" : ""}" data-action="setFit" data-fit="height">Ganze Seite</button>
          <button class="mc-chip ${r.fit === "width" ? "active" : ""}" data-action="setFit" data-fit="width">Breite füllen</button></div>
      </div>
      <div class="mc-r-view" id="mc-view">${scroll ? `<div class="mc-scroll" id="mc-scroll"><div class="mc-wt">${r.pages.map((p) =>
        `<div class="mc-wt-page" data-n="${p.number}" style="aspect-ratio:${p.width || 2} / ${p.height || 3}"></div>`).join("")}</div></div>`
        : `<div class="mc-r-stage" id="mc-stage"><img id="mc-img" alt="" draggable="false"></div>
           <div class="mc-zone left" data-action="zone" data-side="left"></div><div class="mc-zone mid" data-action="toggleChrome"></div>
           <div class="mc-zone right" data-action="zone" data-side="right"></div>`}</div>
      <div class="mc-r-foot">
        <div class="mc-r-foot-row"><span id="mc-label"></span><span style="margin-left:auto">${r.pages.length} Seiten</span></div>
        <input type="range" min="1" max="${last}" step="1" value="${r.i + 1}" id="mc-seek" data-input="seek" data-change="seek" ${rtl ? 'dir="rtl"' : ""} aria-label="Seite">
      </div>
      <div class="mc-end" id="mc-end" hidden></div></div>`;
    this._wireReaderGestures();
    if (scroll) this._setupScroll();
  }

  _wireReaderGestures() {
    const stage = this._readerDialog.querySelector("#mc-stage");
    if (!stage) return;
    let x0 = null;
    let y0 = null;
    stage.addEventListener("touchstart", (ev) => {
      x0 = ev.touches[0].clientX;
      y0 = ev.touches[0].clientY;
    }, { passive: true });
    stage.addEventListener("touchend", (ev) => {
      if (x0 === null) return;
      const dx = ev.changedTouches[0].clientX - x0;
      const dy = ev.changedTouches[0].clientY - y0;
      x0 = null;
      if (Math.abs(dx) > 50 && Math.abs(dy) < 90 && Math.abs(dx) > Math.abs(dy) * 1.5) this._stepSide(dx < 0 ? "right" : "left");
    }, { passive: true });
  }

  /** Move to the neighbour page on the given SIDE of the current one - what a tap/swipe/arrow means depends on the reading direction. */
  _stepSide(side) {
    const r = this._reader;
    if (!r || r.dir === "scroll") return;
    const forward = (r.dir === "rtl") === (side === "left");
    this._step(forward ? 1 : -1);
  }

  _step(delta) {
    const r = this._reader;
    if (!r) return;
    if (r.end) {
      if (delta < 0) this._hideEnd();
      return;
    }
    const target = r.i + delta;
    if (target >= r.pages.length) {
      r.i = r.pages.length - 1;
      r.dirty = true;
      this._persistProgress();
      this._showEnd();
      return;
    }
    if (target < 0) return;
    this._showPage(target);
  }

  async _showPage(i, first = false) {
    const r = this._reader;
    if (!r) return;
    r.i = i;
    this._updateFooter();
    if (r.dir === "scroll") {
      if (first) {
        // placing the view on the saved page makes the observers fire for other pages on the way: ignore them
        r.settling = true;
        this._scrollToPage(i);
        setTimeout(() => { if (this._reader === r) r.settling = false; }, 500);
      } else {
        r.dirty = true;
        this._saveProgress();
      }
      return;
    }
    const img = this._readerDialog.querySelector("#mc-img");
    if (!img) return;
    try {
      const url = await this._pageUrl(r.book.id, i + 1);
      if (!this._reader || this._reader.i !== i) return; // the user already moved on
      // decode first, then swap: no blank flash between pages
      const next = new Image();
      next.src = url;
      await next.decode().catch(() => {});
      if (!this._reader || this._reader.i !== i) return;
      img.src = url;
      const stage = this._readerDialog.querySelector("#mc-stage");
      if (stage) stage.scrollTop = 0;
    } catch (err) {
      this._setError(err, "Seite laden");
    }
    this._preload(i);
    if (!first) {
      r.dirty = true;
      this._saveProgress();
      if (i === r.pages.length - 1) this._persistProgress(); // reaching the last page completes the volume
    }
  }

  _pageUrl(bookId, n) {
    return this._sign(`${KOMGA_URL}v1/books/${bookId}/pages/${n}`);
  }

  _preload(i) {
    const r = this._reader;
    if (!r) return;
    for (const j of [i + 1, i + 2, i - 1]) {
      if (j < 0 || j >= r.pages.length) continue;
      this._pageUrl(r.book.id, j + 1).then((u) => { const im = new Image(); im.src = u; }).catch(() => {});
    }
  }

  _updateFooter() {
    const r = this._reader;
    const label = this._readerDialog.querySelector("#mc-label");
    if (label) label.textContent = `Seite ${r.i + 1}`;
    const seek = this._readerDialog.querySelector("#mc-seek");
    if (seek && Number(seek.value) !== r.i + 1) seek.value = r.i + 1;
  }

  _onInput_seek(el) {
    const label = this._readerDialog.querySelector("#mc-label");
    if (label) label.textContent = `Seite ${el.value}`;
  }

  _onChange_seek(el) {
    const r = this._reader;
    if (!r) return;
    const i = Number(el.value) - 1;
    if (r.dir === "scroll") {
      r.settling = true;
      this._scrollToPage(i);
      r.i = i;
      r.dirty = true;
      this._saveProgress();
      setTimeout(() => { if (this._reader === r) r.settling = false; }, 500);
    } else {
      this._showPage(i);
    }
  }

  // Webtoon / scrolling mode ------------------------------------------------

  _setupScroll() {
    const r = this._reader;
    const container = this._readerDialog.querySelector("#mc-scroll");
    if (!container) return;
    this._loadObserver?.disconnect();
    this._seenObserver?.disconnect();
    this._loadObserver = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting || e.target.dataset.loaded) continue;
        e.target.dataset.loaded = "1";
        const n = Number(e.target.dataset.n);
        this._pageUrl(r.book.id, n).then((u) => {
          const img = document.createElement("img");
          img.alt = "";
          img.src = u;
          e.target.appendChild(img);
          e.target.style.aspectRatio = "auto";
        }).catch(() => { e.target.dataset.loaded = ""; });
      }
    }, { root: container, rootMargin: "1500px 0px" });
    this._seenObserver = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting || r.settling) continue;
        const idx = Number(e.target.dataset.n) - 1;
        if (idx !== r.i) {
          r.i = idx;
          r.dirty = true;
          this._updateFooter();
          this._saveProgress();
          if (idx === r.pages.length - 1) this._persistProgress();
        }
      }
    }, { root: container, threshold: 0.6 });
    container.querySelectorAll(".mc-wt-page").forEach((el) => {
      this._loadObserver.observe(el);
      this._seenObserver.observe(el);
    });
    container.addEventListener("click", () => this._onAction_toggleChrome());
  }

  _scrollToPage(i) {
    const el = this._readerDialog.querySelector(`.mc-wt-page[data-n="${i + 1}"]`);
    if (el) el.scrollIntoView({ block: "start" });
  }

  // Reader chrome / settings ---------------------------------------------------

  _onAction_zone(el) {
    this._stepSide(el.dataset.side);
  }

  _onAction_toggleChrome() {
    const r = this._reader;
    if (!r) return;
    r.chrome = !r.chrome;
    r.menu = false;
    this._readerDialog.querySelector("#mc-rd")?.classList.toggle("chrome-hidden", !r.chrome);
    const menu = this._readerDialog.querySelector("#mc-menu");
    if (menu) menu.hidden = true;
  }

  _onAction_toggleMenu() {
    const r = this._reader;
    if (!r) return;
    r.menu = !r.menu;
    const menu = this._readerDialog.querySelector("#mc-menu");
    if (menu) menu.hidden = !r.menu;
  }

  _onAction_setDir(el) {
    const r = this._reader;
    if (!r || !DIRECTIONS[el.dataset.dir]) return;
    r.dir = el.dataset.dir;
    store(`mc-dir-${r.series.id}`, r.dir);
    r.menu = false;
    this._renderReader();
    this._showPage(r.i, true);
  }

  _onAction_setFit(el) {
    const r = this._reader;
    if (!r) return;
    r.fit = el.dataset.fit === "width" ? "width" : "height";
    store("mc-fit", r.fit);
    r.menu = false;
    this._readerDialog.querySelector("#mc-rd").className = `mc-reader fit-${r.fit} ${r.chrome ? "" : "chrome-hidden"}`;
    const menu = this._readerDialog.querySelector("#mc-menu");
    if (menu) menu.hidden = true;
  }

  _onReaderKey(ev) {
    const r = this._reader;
    if (!r) return;
    if (ev.key === "ArrowRight") this._stepSide("right");
    else if (ev.key === "ArrowLeft") this._stepSide("left");
    else if (ev.key === " " || ev.key === "PageDown") this._step(1);
    else if (ev.key === "PageUp") this._step(-1);
    else return;
    ev.preventDefault();
  }

  // End of a volume ------------------------------------------------------------------

  async _showEnd() {
    const r = this._reader;
    const end = this._readerDialog.querySelector("#mc-end");
    if (!r || !end) return;
    r.end = true;
    let next = null;
    try {
      next = await this._api("GET", `v1/books/${r.book.id}/next`);
    } catch (_) {
      next = null; // 404: last volume
    }
    r.nextBook = next;
    end.innerHTML = `<div class="mc-title">${next ? "Band zu Ende" : "Ende der Serie"}</div>
      <div class="mc-hint">${esc(r.series.metadata?.title || r.series.name)} · ${esc(bookTitle(r.book))}</div>
      ${next ? `<button class="mc-btn" data-action="nextVolume">Weiter mit ${esc(bookTitle(next))}</button>` : ""}
      <button class="mc-btn secondary" data-action="hideEnd">Zurück zur letzten Seite</button>
      <button class="mc-btn secondary" data-action="closeReader">Schließen</button>`;
    end.hidden = false;
  }

  _hideEnd() {
    const r = this._reader;
    if (!r) return;
    r.end = null;
    const end = this._readerDialog.querySelector("#mc-end");
    if (end) end.hidden = true;
  }

  _onAction_hideEnd() {
    this._hideEnd();
  }

  async _onAction_nextVolume() {
    const r = this._reader;
    if (!r?.nextBook) return;
    await this._persistProgress();
    const books = r.books.map((b) => (b.id === r.book.id ? { ...b, readProgress: { page: r.pages.length, completed: true } } : b));
    const next = books.find((b) => b.id === r.nextBook.id) || r.nextBook;
    this._openReader(r.series, books, { ...next, readProgress: null });
  }

  // Progress ---------------------------------------------------------------------------

  async _persistProgress() {
    const r = this._reader;
    if (!r) return;
    this._saveProgress.cancel();
    if (!r.dirty) return;
    const page = r.i + 1;
    const completed = page >= r.pages.length;
    // keep the lists honest without waiting for the server
    r.book.readProgress = { ...(r.book.readProgress || {}), page, completed };
    try {
      await this._api("PATCH", `v1/books/${r.book.id}/read-progress`, { page, completed });
    } catch (err) {
      this._setError(err, "Fortschritt speichern");
    }
  }

  _onAction_closeReader() {
    this._readerDialog.close();
  }

  async _closeReader() {
    const r = this._reader;
    if (!r) return;
    await this._persistProgress();
    this._loadObserver?.disconnect();
    this._seenObserver?.disconnect();
    this._reader = null;
    this._readerDialog.innerHTML = "";
    if (this._detailId) this._refreshDetail().catch(() => {});
    else this._loadContinue().catch(() => {});
    this._loadSeries(true).catch(() => {});
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Editor
// ─────────────────────────────────────────────────────────────────────────

class MangaCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = { ...DEFAULT_CONFIG, ...config };
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (this._form) this._form.hass = hass;
  }

  _render() {
    if (!this._form) {
      this._form = document.createElement("ha-form");
      this._form.computeLabel = (s) => ({ title: "Titel" }[s.name] || s.name);
      this._form.addEventListener("value-changed", (ev) => {
        this._config = { ...this._config, ...ev.detail.value };
        this.dispatchEvent(new CustomEvent("config-changed", { detail: { config: this._config }, bubbles: true, composed: true }));
      });
      this.appendChild(this._form);
    }
    this._form.hass = this._hass;
    this._form.schema = [{ name: "title", selector: { text: {} } }];
    this._form.data = this._config;
  }
}

customElements.define(CARD_TAG, MangaCard);
customElements.define(EDITOR_TAG, MangaCardEditor);

window.customCards = window.customCards || [];
window.customCards.push({
  type: CARD_TAG,
  name: "Manga Card",
  description: "Mangas und Comics aus Komga: Bibliothek, Leser (rechts→links, links→rechts, Scrollen) und Lesefortschritt",
  preview: false,
  documentationURL: "https://github.com/hypersonic30/ha-manga-card",
});

console.info(`%c MANGA-CARD %c ${CARD_VERSION} `, "color:white;background:#0a84ff;font-weight:700", "color:#0a84ff"); // eslint-disable-line no-console
