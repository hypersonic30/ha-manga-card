# Manga Card for Home Assistant (Komga)

A phone-first Lovelace card for reading manga and comics from a [Komga](https://komga.org) server: browse your library,
open a series, read volumes page by page — **right-to-left, left-to-right or scrolling (webtoons)** — and pick up where you stopped.
Reading progress is stored in Komga itself, so it follows you across devices. UI language: German.

> [!IMPORTANT]
> Requires the **[Books Integration](https://github.com/hypersonic30/ha-books-integration)** (v0.8.0 or newer) with a Komga URL and
> API key entered in its settings. The integration proxies every request, so the Komga API key never reaches the browser.

## Features

- **Library** — all Komga libraries as chips, cover grid with unread badges, search (done by Komga), "Mehr laden" paging, and a
  **Weiterlesen** row with volumes in progress and the next unread volume of series you have started.
- **Series** — cover, status, publisher, language, summary, all volumes with progress; one button for *Lesen / Weiterlesen / Nochmal lesen*;
  mark the whole series read or unread.
- **Reader** — full-screen page reader: tap the left/right third, swipe, arrow keys or the slider. The direction comes from Komga's
  metadata (manga → right-to-left, comics → left-to-right, webtoons → scrolling) and can be changed per series; "Ganze Seite" or
  "Breite füllen". Pages ahead are preloaded, a finished volume offers **Weiter mit Band N**.
- **Progress** — saved to Komga a moment after you turn a page (and when you close the reader). Just opening a volume changes nothing.

## Installation

1. HACS → ⋮ → Custom repositories → add this repo's URL, category **Dashboard**; install **Manga Card**; reload the browser
   (companion app: Settings → Companion App → Debugging → Reset frontend cache).
2. Install/update the Books integration and enter your Komga URL and an API key
   (Komga → Account Settings → API Keys; use a dedicated Komga user **without admin rights**).
3. Add the card to a dashboard:

```yaml
type: custom:manga-card
title: Manga        # optional
```

## Development

`manga-card.js` is a single file (no build step). Browser tests (real Chrome via Playwright, a small fake Komga) live in `tests/browser`:

```bash
pip install playwright && playwright install chrome
python tests/browser/run_all.py          # or one script, e.g. python tests/browser/reader.py
```
CI runs the same (`.github/workflows/validate.yml`).
