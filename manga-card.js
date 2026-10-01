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

const CARD_VERSION = "0.1.0";
const CARD_TAG = "manga-card";
const EDITOR_TAG = "manga-card-editor";
const KOMGA = "books/komga/"; // hass.callApi() path (the Books integration proxies Komga here)
const KOMGA_URL = "/api/books/komga/"; // the same as a URL, for signing image paths
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

function errMessage(err) {
  if (!err) return "Unbekannter Fehler";
  if (typeof err === "string") return err;
  const body = err.body || {};
  return body.error || body.message || err.message || err.error || `Fehler ${err.status || ""}`.trim();
}

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
    }
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
      <form class="mc-searchbar" data-submit="search"><input type="search" id="mc-search" placeholder="Serie suchen" autocomplete="off" enterkeyhint="search" data-input="filter"></form>
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

  _handleChange = (ev) => {
    const el = ev.target.closest("[data-change]");
    if (!el) return;
    const handler = this[`_onChange_${el.dataset.change}`];
    if (typeof handler === "function") handler.call(this, el, ev);
  };

  // ── Networking ───────────────────────────────────────────────────────

  async _api(method, path, body) {
    try {
      return await this._hass.callApi(method, `${KOMGA}${path}`, body);
    } catch (err) {
      if (err?.status === 401 && this._hass?.connection?.refreshAccessToken) {
        try {
          await this._hass.connection.refreshAccessToken();
        } catch (_) {
          /* retry with whatever token we have */
        }
        return this._hass.callApi(method, `${KOMGA}${path}`, body);
      }
      throw err;
    }
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
    const body = this.shadowRoot.getElementById("mc-body");
    if (!body) return;
    const html = this._renderBody();
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
      : "";
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
      grid = `<div class="mc-empty">${this._filter ? "Keine Serie gefunden." : "Noch keine Mangas in Komga.<br>Sobald Dateien in der Bibliothek liegen, erscheinen sie hier."}</div>`;
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
