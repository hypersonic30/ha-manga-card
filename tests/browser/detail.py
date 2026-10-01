"""Series detail: metadata, volumes with progress, next-volume button, mark read/unread, covers survive re-renders."""
from _server import *
from playwright.sync_api import sync_playwright

dlg = lambda pg, js: pg.evaluate("() => { const d = card._detailDialog; return " + js + " }")

with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome", headless=True, args=["--no-sandbox"])
    pg = open_card(b)
    pg.evaluate("() => card.shadowRoot.querySelector('[data-action=openSeries][data-id=S1]').click()")
    pg.wait_for_function("() => card._detail !== null", timeout=10000); pg.wait_for_timeout(300)
    check("detail dialog opens", dlg(pg, "d.open"))
    txt = dlg(pg, "d.innerText")
    check("title, status, language and volume count shown", "Test Manga RTL" in txt and "Laufend" in txt and "DE" in txt and "3 Bände" in txt, txt[:200])
    check("author and summary shown", "Test Autor" in txt and "Zusammenfassung von Test Manga RTL" in txt)
    check("three volume rows", dlg(pg, "d.querySelectorAll('.mc-vol').length") == 3)
    check("fresh series offers 'Lesen' with the first volume", "Lesen · Test Manga RTL Band 1" in dlg(pg, "d.querySelector('[data-action=readNext]').textContent"))
    srcs = dlg(pg, "[...d.querySelectorAll('img')].map(i => i.getAttribute('src'))")
    check("covers of the series and every volume are loaded", len(srcs) == 4 and all(srcs), srcs)
    pg.evaluate("() => card._setHtml(card._detailDialog, card._detailDialog.innerHTML)")      # a rebuild must not lose the covers
    check("covers survive a re-render (regression: lost src)", dlg(pg, "[...d.querySelectorAll('img')].every(i => i.getAttribute('src'))"))
    pg.evaluate("() => card._onAction_closeDetail()"); pg.wait_for_timeout(200)
    check("close button closes it", not dlg(pg, "d.open"))
    pg.close()

    # progress states
    pg = open_card(b, wait=False)
    set_progress("S1B1", 8, True); set_progress("S1B2", 3)
    reload(pg)
    pg.evaluate("() => card.shadowRoot.querySelector('[data-action=openSeries][data-id=S1]').click()")
    pg.wait_for_function("() => card._detail !== null", timeout=10000); pg.wait_for_timeout(300)
    rows = dlg(pg, "[...d.querySelectorAll('.mc-vol')].map(r => r.querySelector('.mc-vol-sub').textContent)")
    check("volume states: read / page x of y / unread", rows[0] == "Gelesen" and rows[1] == "Seite 3 von 8" and rows[2] == "8 Seiten", rows)
    check("the volume in progress shows a meter", dlg(pg, "d.querySelectorAll('.mc-meter').length") == 1)
    label = dlg(pg, "d.querySelector('[data-action=readNext]').textContent")
    check("'Weiterlesen' targets the volume in progress", "Weiterlesen · Test Manga RTL Band 2" in label, label)
    pg.evaluate("() => card._detailDialog.querySelector('[data-action=readNext]').click()")
    pg.wait_for_function("() => card._reader", timeout=10000); pg.wait_for_timeout(300)
    check("it opens that volume at the saved page", pg.evaluate("() => card._reader.book.id") == "S1B2" and pg.evaluate("() => card._reader.i") == 2)
    pg.evaluate("() => card._readerDialog.close()"); pg.wait_for_timeout(500)

    pg.evaluate("() => card._detailDialog.querySelector('[data-action=markSeries][data-read=\"1\"]').click()"); pg.wait_for_timeout(700)
    check("'Alle gelesen' sends POST read-progress", any(c["method"] == "POST" and c["path"] == "v1/series/S1/read-progress" for c in calls()))
    check("every volume shows as read afterwards", dlg(pg, "[...d.querySelectorAll('.mc-vol-sub')].every(e => e.textContent === 'Gelesen')"))
    check("finished series: 'Nochmal lesen'", "Nochmal lesen" in dlg(pg, "d.querySelector('[data-action=readNext]').textContent"))
    pg.evaluate("() => card._detailDialog.querySelector('[data-action=markSeries][data-read=\"0\"]').click()"); pg.wait_for_timeout(700)
    check("'Alle ungelesen' sends DELETE read-progress", any(c["method"] == "DELETE" and c["path"] == "v1/series/S1/read-progress" for c in calls()))
    check("volumes are unread again", dlg(pg, "[...d.querySelectorAll('.mc-vol-sub')].every(e => e.textContent.endsWith('Seiten'))"))
    check("the library grid reflects it (badge back to 3)", pg.evaluate("() => [...card.shadowRoot.querySelectorAll('.mc-tile')].find(t => t.textContent.includes('Test Manga RTL')).querySelector('.mc-badge').textContent") == "3")
    check("no page errors", not pg.errors, pg.errors); pg.close(); b.close()
finish()
