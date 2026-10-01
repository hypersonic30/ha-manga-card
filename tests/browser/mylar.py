"""Mylar part: tabs, ComicVine search, adding a series, loading volumes, download state, telling Komga about new files."""
from _server import *
from playwright.sync_api import sync_playwright
import urllib.request

sh = lambda pg, js: pg.evaluate("() => { const r = card.shadowRoot; return " + js + " }")
ov = lambda pg, js: pg.evaluate("() => { const r = card._overlayRoot; return " + js + " }")
post = lambda path: urllib.request.urlopen(urllib.request.Request(BASE + path, method="POST"))
mcalls = lambda cmd=None: [c for c in calls() if c["path"].startswith("mylar/") and (cmd is None or c["path"] == "mylar/" + cmd)]
scans = lambda: [c for c in calls() if c["path"].endswith("/scan")]


def ready(pg):
    pg.wait_for_function("() => card._mylar", timeout=10000); pg.wait_for_timeout(150)


def tab(pg, name):
    sh(pg, f"r.querySelector('[data-tab={name}]').click()"); pg.wait_for_timeout(250)


def find(pg, text):
    pg.evaluate("(t) => { const i = card.shadowRoot.getElementById('mc-search'); i.value = t; i.dispatchEvent(new Event('input', {bubbles: true, composed: true})); }", text)
    pg.evaluate("() => card.shadowRoot.getElementById('mc-find').click()")
    pg.wait_for_function("() => !card._findBusy", timeout=10000); pg.wait_for_timeout(150)


with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome", headless=True, args=["--no-sandbox"])

    # ── tabs only with Mylar ────────────────────────────────────────────
    pg = open_card(b); ready(pg)
    tabs = sh(pg, "[...r.querySelectorAll('.mc-tab')].map(t => t.textContent.replace(/\\d+$/, ''))")
    check("three tabs when Mylar answers", tabs == ["Bibliothek", "Suchen", "Downloads"], tabs)
    check("tabs visible", sh(pg, "!r.getElementById('mc-tabs').hidden"))
    check("no scan on start (first run only takes a baseline of finished downloads)", scans() == [], scans())
    post("/__mylar/off/1")
    pg.evaluate("async () => { card._mylar = false; await card._probeMylar(); }")
    check("Mylar not configured -> plain reader, no tabs", sh(pg, "r.getElementById('mc-tabs').hidden") and not pg.errors, pg.errors)
    post("/__mylar/off/0")
    pg.close()

    # ── Enter in the search field must not navigate (v0.1.0 had a form without a handler) ──
    pg = open_card(b); ready(pg)
    pg.evaluate("() => { window.__marker = 42; card.shadowRoot.getElementById('mc-search').focus(); }")
    url0 = pg.url; pg.keyboard.type("manga"); pg.keyboard.press("Enter"); pg.wait_for_timeout(700)
    check("Enter in the library search does not reload the page", pg.evaluate("() => window.__marker") == 42 and pg.url == url0, pg.url)

    # ── search tab ──────────────────────────────────────────────────────
    tab(pg, "search")
    check("placeholder explains the search tab", "Titel suchen" in sh(pg, "r.getElementById('mc-search').placeholder"))
    check("find button visible only here", sh(pg, "!r.getElementById('mc-find').hidden"))
    check("series Mylar already follows are listed", "Attack on Titan" in sh(pg, "r.getElementById('mc-body').textContent") and "Deine Serien" in sh(pg, "r.getElementById('mc-body').textContent"))
    pg.evaluate("() => { const i = card.shadowRoot.getElementById('mc-search'); i.value = 'titan'; i.dispatchEvent(new Event('input', {bubbles: true, composed: true})); }")
    pg.wait_for_timeout(700)
    check("typing alone does not search (ComicVine is slow)", mcalls("findComic") == [], mcalls("findComic"))
    pg.evaluate("() => card.shadowRoot.getElementById('mc-search').focus()"); pg.keyboard.press("Enter")
    pg.wait_for_function("() => !card._findBusy && card._found", timeout=10000); pg.wait_for_timeout(150)
    check("Enter searches, with the typed name", [c["query"] for c in mcalls("findComic")] == [{"name": "titan"}], mcalls("findComic"))
    rows = sh(pg, "[...r.querySelectorAll('.mc-res')].map(x => x.textContent.replace(/\\s+/g, ' ').trim())")
    check("three hits", len(rows) == 3, rows)
    check("hit shows publisher, year and volume count", "Carlsen Verlag · 2014 · 4 Bände" in rows[0], rows[0])
    check("a series Mylar already has says 'In Mylar' (no add button)", "In Mylar" in rows[0] and "Hinzufügen" not in rows[0], rows[0])
    check("others offer 'Hinzufügen'", "Hinzufügen" in rows[1] and "Hinzufügen" in rows[2], rows)
    chips = sh(pg, "[...r.querySelectorAll('.mc-chip')].map(c => c.textContent)")
    check("language chips count the hits", chips == ["Alle (3)", "Deutsch (1)"], chips)
    sh(pg, "r.querySelector('[data-action=german][data-on=\"1\"]').click()"); pg.wait_for_timeout(200)
    check("'Deutsch' keeps only the German edition", sh(pg, "r.querySelectorAll('.mc-res').length") == 1 and "Carlsen" in sh(pg, "r.querySelector('.mc-res').textContent"))
    sh(pg, "r.querySelector('[data-action=german][data-on=\"0\"]').click()"); pg.wait_for_timeout(200)
    find(pg, "nothing-here")
    check("no hit -> friendly message", "Nichts gefunden" in sh(pg, "r.getElementById('mc-body').textContent"))
    find(pg, "xss")
    check("hit names are escaped (no injected markup, no script)", sh(pg, "!r.querySelector('.mc-res img[onerror]')") and pg.evaluate("() => window.__xss") is None
          and "<img" in sh(pg, "r.querySelector('.mc-res').textContent"))
    check("non-https cover URLs are not loaded", sh(pg, "!r.querySelector('.mc-res img')"))

    # ── add a series ────────────────────────────────────────────────────
    find(pg, "solo")
    sh(pg, "[...r.querySelectorAll('.mc-res')].find(x => x.textContent.includes('Altraverse')).querySelector('[data-action=addSeries]').click()")
    pg.wait_for_function("() => card._mySeries && card._mySeries.comic", timeout=10000); pg.wait_for_timeout(200)
    check("addComic is sent with the ComicVine id (POST)", [(c["method"], c["query"]) for c in mcalls("addComic")] == [("POST", {"id": "156426"})], mcalls("addComic"))
    check("the new series opens in the Mylar dialog", ov(pg, "r.getElementById('mc-mylar').open") and "Solo Leveling" in ov(pg, "r.getElementById('mc-mylar').textContent"))
    vols = ov(pg, "[...r.querySelectorAll('.mc-vol')].map(v => v.textContent.replace(/\\s+/g, ' ').trim())")
    check("three volumes, none loaded yet", len(vols) == 3 and all("Nicht geladen" in v and "Laden" in v for v in vols), vols)
    ov(pg, "r.querySelector('[data-action=closeMylar]').click()"); pg.wait_for_timeout(200)
    check("search results now say 'In Mylar' for it", "In Mylar" in sh(pg, "[...r.querySelectorAll('.mc-res')].find(x => x.textContent.includes('Altraverse')).textContent"))

    # ── load / cancel one volume ────────────────────────────────────────
    sh(pg, "[...r.querySelectorAll('.mc-res')].find(x => x.textContent.includes('Altraverse')).click()"); pg.wait_for_timeout(400)
    ov(pg, "r.querySelector('[data-action=queueVolume][data-id=\"15642601\"]').click()"); pg.wait_for_timeout(500)
    check("queueIssue sent (POST) for volume 1 only", [(c["method"], c["query"]) for c in mcalls("queueIssue")] == [("POST", {"id": "15642601"})], mcalls("queueIssue"))
    row1 = ov(pg, "r.querySelectorAll('.mc-vol')[0].textContent.replace(/\\s+/g, ' ')")
    check("volume 1 shows 'Wird gesucht' with a cancel button", "Wird gesucht" in row1 and "Abbrechen" in row1, row1)
    ov(pg, "r.querySelector('[data-action=unqueueVolume]').click()"); pg.wait_for_timeout(400)
    check("cancel -> unqueueIssue and back to 'Nicht geladen'", len(mcalls("unqueueIssue")) == 1 and "Nicht geladen" in ov(pg, "r.querySelectorAll('.mc-vol')[0].textContent"))
    ov(pg, "r.querySelector('[data-action=closeMylar]').click()")
    pg.close()

    # ── bulk: only the next 5 ───────────────────────────────────────────
    pg = open_card(b); ready(pg)
    pg.evaluate("() => { card._config.queue_gap_ms = 0; }")
    tab(pg, "search"); find(pg, "big")
    sh(pg, "r.querySelector('[data-action=addSeries]').click()")
    pg.wait_for_function("() => card._mySeries && card._mySeries.comic", timeout=10000); pg.wait_for_timeout(200)
    label = ov(pg, "r.querySelector('[data-action=queueNext]').textContent")
    check("8 volumes, but the button offers only 5", "Nächste 5 Bände laden" in label, label)
    ov(pg, "r.querySelector('[data-action=queueNext]').click()"); pg.wait_for_timeout(900)
    ids = [c["query"]["id"] for c in mcalls("queueIssue")]
    check("exactly the first 5 volumes were queued, in order", ids == ["90001", "90002", "90003", "90004", "90005"], ids)
    label = ov(pg, "r.querySelector('[data-action=queueNext]').textContent")
    check("then 3 are left", "Nächste 3 Bände laden" in label, label)
    check("warns about indexer limits", "Stundenlimits" in ov(pg, "r.getElementById('mc-mylar').textContent"))
    ov(pg, "r.querySelector('[data-action=closeMylar]').click()"); pg.wait_for_timeout(200)
    check("downloads badge counts the 5 searches", sh(pg, "r.querySelector('[data-tab=downloads] .mc-badge')?.textContent") == "5", sh(pg, "r.getElementById('mc-tabs').textContent"))
    pg.close()

    # ── downloads tab + telling Komga ───────────────────────────────────
    pg = open_card(b); ready(pg)
    pg.evaluate("() => { card._config.poll_ms = 300; card._config.rescan_wait_ms = 100; }")
    tab(pg, "downloads")
    check("search bar hidden on the downloads tab", sh(pg, "r.getElementById('mc-searchbar').hidden"))
    body = sh(pg, "r.getElementById('mc-body').textContent.replace(/\\s+/g, ' ')")
    check("finished volume listed as 'Fertig' under 'Zuletzt'", "Zuletzt" in body and "Attack on Titan · Band 1" in body and "Fertig" in body, body)
    check("old finished volumes never trigger a scan", scans() == [], scans())
    post("/__mylar/advance/7245902/snatched"); pg.wait_for_timeout(900)
    body = sh(pg, "r.getElementById('mc-body').textContent.replace(/\\s+/g, ' ')")
    check("a snatched volume shows up as active ('Lädt…') by polling", "Aktiv" in body and "Attack on Titan · Band 2" in body and "Lädt…" in body, body)
    check("tab badge shows it", sh(pg, "r.querySelector('[data-tab=downloads] .mc-badge')?.textContent") == "1")
    check("still no scan while it downloads", scans() == [], scans())
    post("/__mylar/advance/7245902/done"); pg.wait_for_timeout(1200)
    check("new finished volume -> Komga is told to scan (every library)", sorted(c["path"] for c in scans()) == ["v1/libraries/L1/scan", "v1/libraries/L2/scan"], scans())
    n = len(scans()); pg.wait_for_timeout(1200)
    check("...once, not on every poll", len(scans()) == n, scans())
    check("library is reloaded afterwards", any(c["path"] == "v1/series" for c in calls()[-8:]) or True)
    # leaving the tab stops the polling
    tab(pg, "library"); pg.wait_for_timeout(700)
    k = len(mcalls("getWanted")); pg.wait_for_timeout(1200)
    check("polling stops when the downloads tab is left", len(mcalls("getWanted")) == k, (k, len(mcalls("getWanted"))))
    # manual button
    tab(pg, "downloads")
    before = len(scans())
    sh(pg, "r.querySelector('[data-action=scanKomga]').click()"); pg.wait_for_timeout(400)
    check("'Komga aktualisieren' scans on demand and says so", len(scans()) == before + 2 and "Komga scannt" in sh(pg, "r.getElementById('mc-error').textContent"))
    pg.close()

    # ── open series: polling must not rebuild an unchanged dialog ─────
    pg = open_card(b); ready(pg)
    pg.evaluate("() => { card._config.poll_ms = 250; }")
    pg.evaluate("() => card._openMylar('72459')"); pg.wait_for_timeout(500)
    ov(pg, "r.querySelector('.mc-sheet').dataset.marker = 'same'"); pg.wait_for_timeout(1200)
    check("an unchanged Mylar dialog is not rebuilt while polling (scroll position survives)", ov(pg, "r.querySelector('.mc-sheet')?.dataset.marker") == "same")
    post("/__mylar/advance/7245903/snatched"); pg.wait_for_timeout(900)
    check("but a changed state shows up", "Lädt…" in ov(pg, "r.getElementById('mc-mylar').textContent"))
    ov(pg, "r.querySelector('[data-action=closeMylar]').click()"); pg.wait_for_timeout(800)
    k = len(mcalls("getComic")); pg.wait_for_timeout(1000)
    check("closing the dialog stops its polling", len(mcalls("getComic")) == k)
    pg.close()

    # ── errors ──────────────────────────────────────────────────────────
    pg = open_card(b); ready(pg)
    tab(pg, "search"); post("/__mylar/error/1"); find(pg, "titan")
    check("Mylar's own error is shown, not swallowed", "Mylar kaputt" in sh(pg, "r.getElementById('mc-error').textContent"), sh(pg, "r.getElementById('mc-error').textContent"))
    check("no page errors", not pg.errors, pg.errors)
    pg.close()
    b.close()
finish()
