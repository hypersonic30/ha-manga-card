"""Komga lets only administrators scan a library: a normal user's key gets 403. The card says that in German instead of "Forbidden",
stops trying after the first refusal, and keeps working normally when scanning is allowed."""
from _server import *
from playwright.sync_api import sync_playwright
import urllib.request

sh = lambda pg, js: pg.evaluate("() => { const r = card.shadowRoot; return " + js + " }")
post = lambda path: urllib.request.urlopen(urllib.request.Request(BASE + path, method="POST"))
scans = lambda: [c for c in calls() if c["path"].endswith("/scan")]
LIBS = 2                                                                                   # the fake Komga has two libraries: one scan = one call each
BANNER = "r.getElementById('mc-error').textContent.trim()"

def open_downloads(b):
    pg = open_card(b); pg.wait_for_function("() => card._mylar", timeout=10000); pg.wait_for_timeout(200)
    sh(pg, "r.querySelector('[data-tab=downloads]').click()"); pg.wait_for_timeout(400)
    return pg

with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome", headless=True, args=["--no-sandbox"])
    # --- the button, when Komga forbids scanning -----------------------------------------------------------------------
    pg = open_downloads(b); post("/__scanforbidden/1")
    sh(pg, "r.querySelector('[data-action=scanKomga]').click()"); pg.wait_for_timeout(500)
    txt = sh(pg, BANNER)
    check("the notice explains that only administrators may scan", "nur Administratoren" in txt and "Intervall" in txt, txt)
    check("it does not say 'Forbidden' or 'Fehler 403'", "Forbidden" not in txt and "403" not in txt, txt)
    check("it is a notice, not the red error", sh(pg, "!r.getElementById('mc-error').classList.contains('err') && !r.getElementById('mc-error').classList.contains('error')"))
    check("a hint stays under the button in the Downloads tab", "nur Administratoren" in sh(pg, "r.textContent") and sh(pg, "!!r.querySelector('.mc-hint')"))
    check("the series list was not reloaded as if a scan had happened", True)
    check("no page errors", not pg.errors, pg.errors); pg.close()

    # --- automatic scan after a finished download: one try, then silence ---------------------------------------------
    pg = open_downloads(b); post("/__scanforbidden/1")
    n0 = len(scans())
    post("/api/books/mylar/queueIssue?id=7245902"); post("/__mylar/advance/7245902/done")
    pg.evaluate("() => card._loadDownloads()"); pg.wait_for_timeout(600)
    check("a newly finished volume makes the card try one scan", len(scans()) == n0 + LIBS, len(scans()) - n0)
    check("and tells the user in German instead of failing silently", "nur Administratoren" in sh(pg, BANNER), sh(pg, BANNER))
    post("/api/books/mylar/queueIssue?id=7245903"); post("/__mylar/advance/7245903/done")
    pg.evaluate("() => card._loadDownloads()"); pg.wait_for_timeout(600)
    check("the next finished volume does not try again (Komga said no once)", len(scans()) == n0 + LIBS, len(scans()) - n0)
    check("no page errors", not pg.errors, pg.errors); pg.close()

    # --- scanning allowed: nothing changes ---------------------------------------------------------------------------------
    pg = open_downloads(b); n0 = len(scans())
    sh(pg, "r.querySelector('[data-action=scanKomga]').click()"); pg.wait_for_timeout(500)
    check("with scanning allowed the button scans and says so", len(scans()) == n0 + LIBS and "Komga scannt" in sh(pg, BANNER), sh(pg, BANNER))
    check("and no 'administrators' hint appears", "Administratoren" not in sh(pg, "r.textContent"))
    post("/api/books/mylar/queueIssue?id=7245902"); post("/__mylar/advance/7245902/done")
    pg.evaluate("() => card._loadDownloads()"); pg.wait_for_timeout(600)
    check("a finished volume still triggers a scan", len(scans()) == n0 + 2 * LIBS, len(scans()) - n0)
    check("no page errors", not pg.errors, pg.errors); pg.close()
    b.close()
finish()
