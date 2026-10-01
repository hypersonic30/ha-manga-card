# Manga Card for Home Assistant (Komga)

A phone-first Lovelace card for reading manga and comics from a [Komga](https://komga.org) server: browse your library,
open a series, read volumes page by page — **right-to-left, left-to-right or scrolling (webtoons)** — and pick up where you stopped.
Reading progress is stored in Komga itself, so it follows you across devices - and everybody reads with their own Komga account (the integration's *People*, required since Books Integration 0.13.0), so nobody
overwrites anybody else's progress. UI language: German.

> [!IMPORTANT]
> Requires the **[Books Integration](https://github.com/hypersonic30/ha-books-integration)** (v0.9.1 or newer) with a Komga URL and
> API key entered in its settings; for searching and downloading also a [Mylar3](https://github.com/mylar3/mylar3) URL and API key.
> The integration proxies every request, so neither key ever reaches the browser.

## Features

- **Library** — all Komga libraries as chips, cover grid with unread badges, search (done by Komga), "Mehr laden" paging, and a
  **Weiterlesen** row with volumes in progress and the next unread volume of series you have started.
- **Series** — cover, status, publisher, language, summary, all volumes with progress; one button for *Lesen / Weiterlesen / Nochmal lesen*;
  mark the whole series read or unread.
- **Reader** — full-screen page reader: tap the left/right third, swipe, arrow keys or the slider. The direction comes from Komga's
  metadata (manga → right-to-left, comics → left-to-right, webtoons → scrolling) and can be changed per series; "Ganze Seite" or
  "Breite füllen". Pages ahead are preloaded, a finished volume offers **Weiter mit Band N**.
- **Progress** — saved to Komga a moment after you turn a page (and when you close the reader). Just opening a volume changes nothing.

## Search and download (optional, needs Mylar3)

With a Mylar3 configured in the integration, the card gets three tabs — **Bibliothek**, **Suchen**, **Downloads**. Without it the card is a plain reader.

- **Suchen** — searches ComicVine through Mylar (press Enter or "Suchen"; ComicVine is slow, so not while typing). Every hit shows publisher, year and
  volume count; the chips **Deutsch** and **Englisch** keep German or English publishers (ComicVine has no language field, so this is a publisher list; one active in both, like Tokyopop, shows under both). Your choice is remembered. **Hinzufügen** puts the
  series into Mylar and opens it. Series Mylar already follows are listed when the search is empty.
- **Series in Mylar** — tap a series (a hit that is already in Mylar, or one under "Deine Serien") and it **unfolds right below its row**, no popup: you
  stay in the search tab with the hits above and below. Every volume shows its state (*Nicht geladen, Wird gesucht, Lädt…, Fertig, Fehlgeschlagen*).
  **Laden** searches your indexers for that volume, **Nächste 5 Bände laden** queues five at a time (every volume is one indexer search, and indexers have
  hourly limits), **Abbrechen** takes a volume back. The screen reacts at once (Mylar can be slow while it waits between indexer searches); if Mylar
  refuses, the change is rolled back and the reason is shown. Nothing is downloaded until you ask — new series start with all volumes on *Nicht geladen*.
  Emptying the search field brings back "Deine Serien".
- **Downloads** — what is being searched, downloaded or finished (refreshes every 10 s while open). When Mylar has filed a new volume, the card asks
  Komga to scan its libraries, so it shows up in **Bibliothek** without waiting for Komga's own schedule. **Komga aktualisieren** does that on demand.

Covers of search hits load straight from ComicVine (your browser asks ComicVine for them).

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
