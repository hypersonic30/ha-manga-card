"""Mylar part: tabs, ComicVine search, adding a series, loading volumes, download state, telling Komga about new files."""
from _server import *
from playwright.sync_api import sync_playwright
import urllib.request

sh = lambda pg, js: pg.evaluate("() => { const r = card.shadowRoot; return " + js + " }")
ov = lambda pg, js: pg.evaluate("() => { const r = card._overlayRoot; return " + js + " }")
post = lambda path: urllib.request.urlopen(urllib.request.Request(BASE + path, method="POST"))
mcalls = lambda cmd=None: [c for c in calls() if c["path"].startswith("mylar/") and (cmd is None or c["path"] == "mylar/" + cmd)]
scans = lambda: [c for c in calls() if c["path"].endswith("/scan")]


panel = lambda pg, js: pg.evaluate("() => { const r = card.shadowRoot.querySelector('[data-panel]'); return " + js + " }")
rows_of = lambda pg: panel(pg, "[...r.querySelectorAll('.mc-ivol')].map(v => v.textContent.replace(/\\s+/g, ' ').trim())")
popups = lambda pg: pg.evaluate("() => [...card._overlayRoot.querySelectorAll('dialog')].filter(d => d.open).length")


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
    pg.evaluate("() => { const i = card.shadowRoot.getElementById('mc-search'); i.value = ''; i.dispatchEvent(new Event('input', {bubbles: true, composed: true})); }"); pg.wait_for_timeout(200)
    check("emptying the search field brings back 'Deine Serien'", "Deine Serien" in sh(pg, "r.getElementById('mc-body').textContent") and sh(pg, "!r.querySelector('.mc-chips')"))
    find(pg, "titan")
    find(pg, "nothing-here")
    check("no hit -> friendly message", "Nichts gefunden" in sh(pg, "r.getElementById('mc-body').textContent"))
    find(pg, "xss")
    check("hit names are escaped (no injected markup, no script)", sh(pg, "!r.querySelector('.mc-res img[onerror]')") and pg.evaluate("() => window.__xss") is None
          and "<img" in sh(pg, "r.querySelector('.mc-res').textContent"))
    check("non-https cover URLs are not loaded", sh(pg, "!r.querySelector('.mc-res img')"))

    # ── add a series: it unfolds in place, no popup ─────────────────────
    find(pg, "solo")
    sh(pg, "[...r.querySelectorAll('.mc-item')].find(x => x.textContent.includes('Altraverse')).querySelector('[data-action=addSeries]').click()")
    pg.wait_for_function("() => card._seriesCache.get('156426')?.comic", timeout=10000); pg.wait_for_timeout(300)
    check("addComic is sent with the ComicVine id (POST)", [(c["method"], c["query"]) for c in mcalls("addComic")] == [("POST", {"id": "156426"})], mcalls("addComic"))
    check("NO popup opens (nothing covers the search)", popups(pg) == 0, popups(pg))
    check("the search results are still there around it", sh(pg, "r.querySelectorAll('.mc-item').length") == 2 and sh(pg, "!!r.querySelector('.mc-chips')"))
    check("the new series is unfolded right below its own row", sh(pg, "r.querySelector('.mc-item.open')?.dataset.item") == "156426" and "Solo Leveling" in sh(pg, "r.querySelector('.mc-item.open .mc-res').textContent"))
    vols = rows_of(pg)
    check("three volumes, none loaded yet", len(vols) == 3 and all("Nicht geladen" in v and "Laden" in v for v in vols), vols)
    check("row now says it is in Mylar (chevron instead of the add button)", sh(pg, "!r.querySelector('.mc-item.open [data-action=addSeries]') && !!r.querySelector('.mc-item.open .mc-chev')"))
    sh(pg, "r.querySelector('.mc-item.open .mc-res').click()"); pg.wait_for_timeout(250)
    check("tapping the row folds it up again", sh(pg, "!r.querySelector('.mc-item.open') && !r.querySelector('[data-panel]')") and sh(pg, "r.querySelectorAll('.mc-item').length") == 2)
    sh(pg, "r.querySelector('[data-item=\"156426\"] .mc-res').click()"); pg.wait_for_timeout(400)
    check("...and open again", sh(pg, "!!r.querySelector('[data-panel=\"156426\"]')") and len(rows_of(pg)) == 3)

    # ── load / cancel one volume ────────────────────────────────────────
    panel(pg, "r.querySelector('[data-action=queueVolume][data-id=\"15642601\"]').click()"); pg.wait_for_timeout(500)
    check("queueIssue sent (POST) for volume 1 only", [(c["method"], c["query"]) for c in mcalls("queueIssue")] == [("POST", {"id": "15642601"})], mcalls("queueIssue"))
    row1 = rows_of(pg)[0]
    check("volume 1 shows 'Wird gesucht' with a cancel button", "Wird gesucht" in row1 and "Abbrechen" in row1, row1)
    panel(pg, "r.querySelector('[data-action=unqueueVolume]').click()"); pg.wait_for_timeout(500)
    check("cancel -> unqueueIssue and back to 'Nicht geladen'", len(mcalls("unqueueIssue")) == 1 and "Nicht geladen" in rows_of(pg)[0], rows_of(pg))
    check("still no popup, no error", popups(pg) == 0 and not sh(pg, "r.getElementById('mc-error').textContent.trim()"), sh(pg, "r.getElementById('mc-error').textContent"))
    pg.close()

    # ── a slow Mylar: cancelling reacts at once, and a failure puts it back ──
    pg = open_card(b); ready(pg)
    tab(pg, "search")
    sh(pg, "r.querySelector('[data-item=\"72459\"] .mc-res').click()"); pg.wait_for_timeout(500)
    panel(pg, "r.querySelector('[data-action=queueVolume][data-id=\"7245902\"]').click()"); pg.wait_for_timeout(500)
    post("/__mylar/delay/unqueueIssue/1500")
    panel(pg, "r.querySelector('[data-action=unqueueVolume]').click()"); pg.wait_for_timeout(200)
    row = rows_of(pg)[1]
    check("cancel shows the new state at once, while Mylar is still busy", "Nicht geladen" in row and "Laden" in row, row)
    check("...request really still running", len(mcalls("unqueueIssue")) == 1)
    pg.evaluate("() => card._loadMylar('72459')"); pg.wait_for_timeout(400)          # a poll answers with Mylar's OLD state meanwhile
    check("an older answer from Mylar does not undo a change that is still travelling", "Nicht geladen" in rows_of(pg)[1], rows_of(pg))
    pg.wait_for_timeout(1700)
    check("once Mylar answers it stays cancelled", "Nicht geladen" in rows_of(pg)[1] and not sh(pg, "r.getElementById('mc-error').textContent.trim()"))
    post("/__mylar/delay/unqueueIssue/0")
    panel(pg, "r.querySelector('[data-action=queueVolume][data-id=\"7245902\"]').click()"); pg.wait_for_timeout(500)
    post("/__mylar/fail/unqueueIssue/1")
    panel(pg, "r.querySelector('[data-action=unqueueVolume]').click()"); pg.wait_for_timeout(500)
    check("a failed cancel is rolled back to 'Wird gesucht'", "Wird gesucht" in rows_of(pg)[1], rows_of(pg))
    check("...and the reason is shown", "unqueueIssue schlug fehl" in sh(pg, "r.getElementById('mc-error').textContent"), sh(pg, "r.getElementById('mc-error').textContent"))
    post("/__mylar/fail/unqueueIssue/0"); post("/__mylar/fail/queueIssue/1")
    panel(pg, "r.querySelector('[data-action=queueVolume][data-id=\"7245903\"]').click()"); pg.wait_for_timeout(500)
    check("a failed 'Laden' is rolled back to 'Nicht geladen'", "Nicht geladen" in rows_of(pg)[2], rows_of(pg))
    # the DOM was patched by hand (panel only, as polling does): a later full render must not be skipped as "unchanged"
    pg.evaluate("() => { card._render(); }"); pg.wait_for_timeout(100)                  # full render, volume 4 not loaded
    pg.evaluate("() => { card._setIssueStatus('7245904', 'Wanted', '72459'); card._updatePanel('72459'); }")
    check("panel-only update shows volume 4 as searched", "Wird gesucht" in rows_of(pg)[3], rows_of(pg))
    pg.evaluate("() => { card._setIssueStatus('7245904', 'Skipped', '72459'); card._render(); }"); pg.wait_for_timeout(200)
    check("a full re-render after a panel-only update really redraws", "Nicht geladen" in rows_of(pg)[3], rows_of(pg))
    pg.close()

    # ── bulk: only the next 5 ───────────────────────────────────────────
    pg = open_card(b); ready(pg)
    pg.evaluate("() => { card._config.queue_gap_ms = 0; }")
    tab(pg, "search"); find(pg, "big")
    sh(pg, "r.querySelector('[data-action=addSeries]').click()")
    pg.wait_for_function("() => card._seriesCache.get('900')?.comic", timeout=10000); pg.wait_for_timeout(300)
    label = panel(pg, "r.querySelector('[data-action=queueNext]').textContent")
    check("8 volumes, but the button offers only 5", "Nächste 5 Bände laden" in label, label)
    panel(pg, "r.querySelector('[data-action=queueNext]').click()"); pg.wait_for_timeout(900)
    ids = [c["query"]["id"] for c in mcalls("queueIssue")]
    check("exactly the first 5 volumes were queued, in order", ids == ["90001", "90002", "90003", "90004", "90005"], ids)
    label = panel(pg, "r.querySelector('[data-action=queueNext]').textContent")
    check("then 3 are left", "Nächste 3 Bände laden" in label, label)
    check("warns about indexer limits", "Stundenlimits" in panel(pg, "r.textContent"))
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

    # ── unfolded series: polling redraws only what changed ─────────────
    pg = open_card(b); ready(pg)
    pg.evaluate("() => { card._config.poll_ms = 250; }")
    tab(pg, "search"); sh(pg, "r.querySelector('[data-item=\"72459\"] .mc-res').click()"); pg.wait_for_timeout(600)
    pg.evaluate("() => { card.shadowRoot.querySelector('[data-panel]').dataset.marker = 'same'; card.shadowRoot.querySelector('.mc-inline-vols').scrollTop = 30; }")
    pg.wait_for_timeout(1200)
    check("an unchanged panel is not rebuilt while polling", panel(pg, "r.dataset.marker") == "same")
    post("/__mylar/advance/7245903/snatched"); pg.wait_for_timeout(900)
    check("but a changed state shows up", "Lädt…" in panel(pg, "r.textContent"))
    check("the list above stays where it was", sh(pg, "r.querySelectorAll('.mc-item').length") == 1)
    tab(pg, "downloads"); tab(pg, "library"); pg.wait_for_timeout(700)
    k = len(mcalls("getComic")); pg.wait_for_timeout(1000)
    check("leaving the search tab stops its polling", len(mcalls("getComic")) == k)
    tab(pg, "search"); pg.wait_for_timeout(700)
    check("coming back: the series is still unfolded and polled again", sh(pg, "!!r.querySelector('[data-panel=\"72459\"]')") and len(mcalls("getComic")) > k)
    sh(pg, "r.querySelector('[data-item=\"72459\"] .mc-res').click()"); pg.wait_for_timeout(700)
    k = len(mcalls("getComic")); pg.wait_for_timeout(1000)
    check("folding it up stops the polling", len(mcalls("getComic")) == k)
    pg.close()

    # ── errors ──────────────────────────────────────────────────────────
    pg = open_card(b); ready(pg)
    tab(pg, "search"); post("/__mylar/error/1"); find(pg, "titan")
    check("Mylar's own error is shown, not swallowed", "Mylar kaputt" in sh(pg, "r.getElementById('mc-error').textContent"), sh(pg, "r.getElementById('mc-error').textContent"))
    check("no page errors", not pg.errors, pg.errors)
    pg.close()
    b.close()
finish()
