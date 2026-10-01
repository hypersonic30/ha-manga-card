"""Library: chips, grid, badges, search, library filter, pagination, continue-reading row, error state."""
from _server import *
from playwright.sync_api import sync_playwright

shell = lambda pg, js: pg.evaluate("() => { const r = card.shadowRoot; return " + js + " }")
tiles = lambda pg: shell(pg, "r.querySelectorAll('#mc-body .mc-grid .mc-tile').length")

with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome", headless=True, args=["--no-sandbox"])
    pg = open_card(b)
    check("title from config", shell(pg, "r.getElementById('mc-title').textContent") == "Manga")
    chips = shell(pg, "[...r.querySelectorAll('.mc-chip')].map(c => c.textContent)")
    check("library chips: Alle + both libraries", chips == ["Alle", "Manga", "Comics"], chips)
    check("first page holds 60 of 73 series", tiles(pg) == 60, tiles(pg))
    check("section shows the total", "73" in shell(pg, "[...r.querySelectorAll('.mc-section')].pop().textContent"))
    more = shell(pg, "r.querySelector('[data-action=moreSeries]')?.textContent")
    check("'Mehr laden (13)' offered", more and "13" in more, more)
    pg.evaluate("() => card.shadowRoot.querySelector('[data-action=moreSeries]').click()"); pg.wait_for_timeout(500)
    check("more series load -> 73 tiles, button gone", tiles(pg) == 73 and shell(pg, "!r.querySelector('[data-action=moreSeries]')"), tiles(pg))
    badge = shell(pg, "[...r.querySelectorAll('.mc-tile')].find(t => t.textContent.includes('Test Manga RTL')).querySelector('.mc-badge')?.textContent")
    check("unread badge on the 3-volume series", badge == "3", badge)
    src = shell(pg, "r.querySelector('.mc-tile img')?.getAttribute('src')")
    check("covers are loaded through the proxy path", src and src.startswith("/api/books/komga/v1/series/") and src.endswith("/thumbnail"), src)
    check("no continue row without progress", shell(pg, "!r.querySelector('[data-action=continueBook]')"))

    # search
    pg.evaluate("() => { const i = card.shadowRoot.getElementById('mc-search'); i.value = 'manga'; i.dispatchEvent(new Event('input', {bubbles: true, composed: true})); }")
    pg.wait_for_timeout(800)
    check("search narrows to one series", tiles(pg) == 1, tiles(pg))
    check("search is done by Komga", any(c["path"] == "v1/series" and c["query"].get("search") == "manga" for c in calls()))
    pg.evaluate("() => { const i = card.shadowRoot.getElementById('mc-search'); i.value = 'zzzz'; i.dispatchEvent(new Event('input', {bubbles: true, composed: true})); }")
    pg.wait_for_timeout(800)
    check("no hit shows a friendly message", "Keine Serie gefunden" in shell(pg, "r.getElementById('mc-body').textContent"))
    pg.evaluate("() => { const i = card.shadowRoot.getElementById('mc-search'); i.value = ''; i.dispatchEvent(new Event('input', {bubbles: true, composed: true})); }")
    pg.wait_for_timeout(800)
    check("clearing the search restores the grid", tiles(pg) == 60, tiles(pg))

    # library filter
    pg.evaluate("() => [...card.shadowRoot.querySelectorAll('.mc-chip')].find(c => c.textContent === 'Comics').click()"); pg.wait_for_timeout(500)
    check("library chip filters (2 series in 'Comics')", tiles(pg) == 2, tiles(pg))
    check("filter is sent as library_id", any(c["query"].get("library_id") == "L2" for c in calls()))
    check("active chip is marked", shell(pg, "r.querySelector('.mc-chip.active').textContent") == "Comics")
    check("no page errors", not pg.errors, pg.errors); pg.close()

    # continue reading
    pg = open_card(b, wait=False)
    set_progress("S1B2", 4); set_progress("S2B1", 6, True)
    pg.evaluate("() => { card._loaded = false; card._initialLoad(); }")
    pg.wait_for_function("() => card._continue.length > 0", timeout=10000); pg.wait_for_timeout(200)
    txt = shell(pg, "r.querySelector('[data-action=continueBook]').textContent")
    check("continue row lists the book in progress with its page", "Seite 4/8" in txt and "Test Manga RTL" in txt, txt)
    check("the next unread volume of a finished one is offered too", shell(pg, "[...r.querySelectorAll('[data-action=continueBook]')].some(t => t.textContent.includes('Nächster Band'))"))
    pg.evaluate("() => card.shadowRoot.querySelector('[data-action=continueBook]').click()")
    pg.wait_for_function("() => card._readerDialog.open", timeout=10000); pg.wait_for_timeout(300)
    check("continue opens the reader at the saved page", pg.evaluate("() => card._reader.i") == 3 and "Seite 4" in pg.evaluate("() => card._readerDialog.querySelector('#mc-label').textContent"))
    pg.close()

    # Komga not reachable / not configured
    pg = open_card(b, wait=False)
    import urllib.request; urllib.request.urlopen(urllib.request.Request(BASE + "/__down/1", method="POST"))
    pg.evaluate("() => { card._loaded = false; card._initialLoad(); }"); pg.wait_for_timeout(700)
    err = shell(pg, "r.getElementById('mc-error').textContent")
    check("an unreachable Komga is explained, not silent", "Komga" in err and "not configured" in err, err)
    check("dismissing the error works", (pg.evaluate("() => card._onAction_dismissError()") or True) and shell(pg, "!r.getElementById('mc-error').textContent.trim()"))
    pg.close(); b.close()
finish()
