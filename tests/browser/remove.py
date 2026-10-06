"""The trash button of the Downloads tab: a wanted volume can be taken off the wanted list, or the whole series out of Mylar (asks first)."""
from _server import *
from playwright.sync_api import sync_playwright
import urllib.request

sh = lambda pg, js: pg.evaluate("() => { const r = card.shadowRoot; return " + js + " }")
post = lambda path: urllib.request.urlopen(urllib.request.Request(BASE + path, method="POST"))
mcalls = lambda cmd: [c for c in calls() if c["path"] == "mylar/" + cmd]
ROWS = "[...r.querySelectorAll('.mc-res .mc-vol-title')].map(e => e.textContent.trim())"
BOXES = "[...r.querySelectorAll('.mc-confirm input[type=checkbox]')].map(e => e.dataset.opt + (e.checked ? '=on' : '=off'))"

def open_downloads(b):
    pg = open_card(b); pg.wait_for_function("() => card._mylar", timeout=10000); pg.wait_for_timeout(200)           # (open_card resets the fake Mylar)
    post("/api/books/mylar/queueIssue?id=7245902"); post("/api/books/mylar/queueIssue?id=7245903")        # two wanted volumes of Attack on Titan
    sh(pg, "r.querySelector('[data-tab=downloads]').click()"); pg.wait_for_timeout(300)
    pg.evaluate("() => card._loadDownloads()"); pg.wait_for_timeout(500)
    return pg

def click(pg, sel, nth=0):
    pg.evaluate("([s, n]) => card.shadowRoot.querySelectorAll(s)[n].click()", [sel, nth]); pg.wait_for_timeout(250)

with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome", headless=True, args=["--no-sandbox"])
    pg = open_downloads(b)
    rows = sh(pg, ROWS)
    check("the two wanted volumes are listed", rows[:2] == ["Attack on Titan · Band 2", "Attack on Titan · Band 3"], rows)
    check("a finished volume has no trash button", sh(pg, "[...r.querySelectorAll('.mc-res')].filter(x => x.textContent.includes('Fertig') && x.querySelector('[data-action=askRemove]')).length") == 0)
    check("nothing is asked before the trash is tapped", sh(pg, "!r.querySelector('.mc-confirm')"))
    click(pg, "[data-action=askRemove]", 0)
    check("tapping the trash asks, 'not searching any more' is on, the series box is off", sh(pg, BOXES) == ["unqueue=on", "series=off"], sh(pg, BOXES))
    click(pg, "[data-action=cancelRemove]")
    check("cancel closes it and sends nothing", sh(pg, "!r.querySelector('.mc-confirm')") and not mcalls("unqueueIssue") and not mcalls("delComic"))
    click(pg, "[data-action=askRemove]", 0); click(pg, "[data-action=doRemove]"); pg.wait_for_timeout(400)
    check("volume 2 is taken off the wanted list at Mylar", [c["query"] for c in mcalls("unqueueIssue")][-1] == {"id": "7245902"}, mcalls("unqueueIssue"))
    check("only volume 3 is left wanted", sh(pg, ROWS)[0] == "Attack on Titan · Band 3", sh(pg, ROWS))
    check("the series was not removed", not mcalls("delComic"))
    check("a notice says so", "nicht mehr gesucht" in sh(pg, "r.getElementById('mc-error').textContent"), sh(pg, "r.getElementById('mc-error').textContent"))

    click(pg, "[data-action=askRemove]", 0)
    pg.evaluate("() => card.shadowRoot.querySelectorAll('.mc-confirm input')[1].click()"); pg.wait_for_timeout(100)
    check("the choice of the boxes is remembered", sh(pg, BOXES) == ["unqueue=on", "series=on"], sh(pg, BOXES))
    click(pg, "[data-action=doRemove]"); pg.wait_for_timeout(500)
    check("the whole series is removed at Mylar (one call, no unqueue for it)", [c["query"] for c in mcalls("delComic")] == [{"id": "72459"}] and len(mcalls("unqueueIssue")) == 1, (mcalls("delComic"), mcalls("unqueueIssue")))
    check("its rows are gone from the list", "Attack on Titan" not in " ".join(sh(pg, ROWS)), sh(pg, ROWS))
    check("the card forgot the series (it is no longer 'in Mylar')", pg.evaluate("() => !card._mylarIndex.some(s => String(s.id) === '72459')"))
    check("a notice says that files stay in Komga", "Komga" in sh(pg, "r.getElementById('mc-error').textContent"))
    check("no page errors", not pg.errors, pg.errors); pg.close()

    pg = open_downloads(b); post("/__mylar/fail/delComic/1")
    click(pg, "[data-action=askRemove]", 0); pg.evaluate("() => card.shadowRoot.querySelectorAll('.mc-confirm input')[1].click()"); click(pg, "[data-action=doRemove]"); pg.wait_for_timeout(400)
    check("a failure keeps the rows and the question, and the banner says what happened",
          len(sh(pg, ROWS)) >= 2 and sh(pg, "!!r.querySelector('.mc-confirm')") and "delComic" in sh(pg, "r.getElementById('mc-error').textContent"), sh(pg, "r.getElementById('mc-error').textContent"))
    post("/__mylar/fail/delComic/0"); pg.close()

    pg = open_downloads(b); click(pg, "[data-action=askRemove]", 0)
    pg.evaluate("() => card.shadowRoot.querySelectorAll('.mc-confirm input')[0].click()"); click(pg, "[data-action=doRemove]")
    check("with no box ticked nothing is sent", not mcalls("unqueueIssue") and not mcalls("delComic") and "Nichts" in sh(pg, "r.getElementById('mc-error').textContent")); pg.close()
    b.close()
finish()
