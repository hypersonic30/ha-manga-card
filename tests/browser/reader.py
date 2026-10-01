"""Reader: directions, taps/swipes/keys, slider, progress (debounced, only after real page turns), volume end, resume, settings, webtoon."""
from _server import *
from playwright.sync_api import sync_playwright

RD = "card._readerDialog"
cur = lambda pg: pg.evaluate("() => card._reader && card._reader.i")
label = lambda pg: pg.evaluate(f"() => {RD}.querySelector('#mc-label')?.textContent")
src = lambda pg: pg.evaluate(f"() => {RD}.querySelector('#mc-img')?.getAttribute('src')")


def open_book(pg, series, book):
    pg.evaluate("(s) => card._openSeries(s)", series)
    pg.wait_for_function("() => card._detail !== null", timeout=10000)
    pg.evaluate("(b) => card._detailDialog.querySelector(`[data-action=openBook][data-id=${b}]`).click()", book)
    pg.wait_for_function("() => card._reader && card._readerDialog.open", timeout=10000)
    pg.wait_for_function(f"() => !{RD}.querySelector('#mc-img') || {RD}.querySelector('#mc-img').getAttribute('src')", timeout=10000)
    pg.wait_for_timeout(200)


def zone(pg, side):
    pg.evaluate(f"(s) => {RD}.querySelector(`[data-action=zone][data-side=${{s}}]`).click()", side); pg.wait_for_timeout(200)


def key(pg, k):
    pg.evaluate(f"(k) => {RD}.dispatchEvent(new KeyboardEvent('keydown', {{key: k, bubbles: true}}))", k); pg.wait_for_timeout(200)


def swipe(pg, dx):
    pg.evaluate(f"""(dx) => {{ const st = {RD}.querySelector('#mc-stage'); const mk = (x) => new Touch({{identifier: 1, target: st, clientX: x, clientY: 300}});
        st.dispatchEvent(new TouchEvent('touchstart', {{touches: [mk(200)], bubbles: true}}));
        st.dispatchEvent(new TouchEvent('touchend', {{changedTouches: [mk(200 + dx)], touches: [], bubbles: true}})); }}""", dx)
    pg.wait_for_timeout(200)


def seek(pg, n):
    pg.evaluate(f"(n) => {{ const s = {RD}.querySelector('#mc-seek'); s.value = n; s.dispatchEvent(new Event('change', {{bubbles: true, composed: true}})); }}", n)
    pg.wait_for_timeout(250)


with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome", headless=True, args=["--no-sandbox"])

    # ---- right-to-left volume
    pg = open_card(b)
    open_book(pg, "S1", "S1B1")
    check("opens on page 1 with the page image", cur(pg) == 0 and src(pg).endswith("/v1/books/S1B1/pages/1"), src(pg))
    check("footer shows the page and total", label(pg) == "Seite 1" and "8 Seiten" in pg.evaluate(f"() => {RD}.querySelector('.mc-r-foot').innerText"))
    check("RTL: the slider runs right-to-left", pg.evaluate(f"() => {RD}.querySelector('#mc-seek').getAttribute('dir')") == "rtl")
    pg.wait_for_timeout(1600)
    check("merely opening a volume writes nothing to Komga", patches() == [], patches())
    zone(pg, "left");  check("RTL: tapping the LEFT side goes forward", cur(pg) == 1 and src(pg).endswith("/pages/2"), (cur(pg), src(pg)))
    zone(pg, "left");  zone(pg, "right")
    check("RTL: tapping the RIGHT side goes back", cur(pg) == 1, cur(pg))
    key(pg, "ArrowLeft"); check("RTL: arrow left = forward", cur(pg) == 2, cur(pg))
    key(pg, "ArrowRight"); check("RTL: arrow right = back", cur(pg) == 1, cur(pg))
    key(pg, " ");  check("space = forward", cur(pg) == 2, cur(pg))
    swipe(pg, 120); check("RTL: swiping right goes forward", cur(pg) == 3, cur(pg))
    swipe(pg, -120); check("RTL: swiping left goes back", cur(pg) == 2, cur(pg))
    swipe(pg, 30); check("a short swipe does nothing", cur(pg) == 2, cur(pg))
    seek(pg, 6); check("the slider jumps to a page", cur(pg) == 5 and label(pg) == "Seite 6", (cur(pg), label(pg)))
    pg.wait_for_timeout(1700)
    ps = patches()
    check("progress is saved once, debounced, not completed", len(ps) == 1 and ps[0]["path"] == "v1/books/S1B1/read-progress" and ps[0]["body"] == {"page": 6, "completed": False}, ps)

    # ---- finishing a volume
    seek(pg, 8); pg.wait_for_timeout(300)
    check("reaching the last page completes the volume right away", any(c["body"] == {"page": 8, "completed": True} for c in patches()), patches())
    zone(pg, "left"); pg.wait_for_timeout(500)
    end = pg.evaluate(f"() => ({{shown: !{RD}.querySelector('#mc-end').hidden, text: {RD}.querySelector('#mc-end').innerText}})")
    check("stepping past the end shows the volume-end screen", end["shown"] and "Weiter mit Test Manga RTL Band 2" in end["text"], end)
    pg.evaluate(f"() => {RD}.querySelector('[data-action=nextVolume]').click()"); pg.wait_for_timeout(800)
    check("'Weiter mit' opens the next volume on page 1", pg.evaluate("() => card._reader.book.id") == "S1B2" and cur(pg) == 0 and "/books/S1B2/" in src(pg), src(pg))
    seek(pg, 8); zone(pg, "left"); pg.wait_for_timeout(300)
    pg.evaluate(f"() => {RD}.querySelector('[data-action=nextVolume]').click()"); pg.wait_for_timeout(800)
    seek(pg, 8); zone(pg, "left"); pg.wait_for_timeout(500)
    end = pg.evaluate(f"() => ({{shown: !{RD}.querySelector('#mc-end').hidden, text: {RD}.querySelector('#mc-end').innerText, next: !!{RD}.querySelector('[data-action=nextVolume]')}})")
    check("the last volume ends the series (no 'next' button)", end["shown"] and "Ende der Serie" in end["text"] and not end["next"], end)
    pg.evaluate(f"() => {RD}.querySelector('[data-action=hideEnd]').click()"); pg.wait_for_timeout(200)
    check("'Zurück zur letzten Seite' hides the end screen", pg.evaluate(f"() => {RD}.querySelector('#mc-end').hidden"))
    pg.evaluate("() => card._readerDialog.close()"); pg.wait_for_timeout(500)
    check("no page errors", not pg.errors, pg.errors); pg.close()

    # ---- opening and closing without reading must leave Komga's progress untouched (paged and scrolling)
    pg = open_card(b)
    open_book(pg, "S1", "S1B1"); pg.wait_for_timeout(300)
    pg.evaluate("() => card._readerDialog.close()"); pg.wait_for_timeout(600)
    check("open + close without reading writes nothing (paged)", patches() == [], patches())
    open_book(pg, "S3", "S3B1"); pg.wait_for_timeout(900)
    pg.evaluate("() => card._readerDialog.close()"); pg.wait_for_timeout(600)
    check("open + close without reading writes nothing (scrolling)", patches() == [], patches()); pg.close()

    # ---- closing flushes the pending progress; resume rules
    pg = open_card(b)
    open_book(pg, "S1", "S1B1"); zone(pg, "left"); zone(pg, "left")
    pg.evaluate("() => card._readerDialog.close()"); pg.wait_for_timeout(500)
    check("closing right after a page turn still saves it", any(c["body"] == {"page": 3, "completed": False} for c in patches()), patches())
    pg.close()
    pg = open_card(b, wait=False); set_progress("S1B2", 5); set_progress("S1B1", 8, True); reload(pg)
    open_book(pg, "S1", "S1B2"); check("an unfinished volume resumes on its saved page", cur(pg) == 4 and label(pg) == "Seite 5", (cur(pg), label(pg)))
    pg.evaluate("() => card._readerDialog.close()"); pg.wait_for_timeout(300)
    open_book(pg, "S1", "S1B1"); check("a finished volume starts again at page 1", cur(pg) == 0, cur(pg)); pg.close()

    # ---- settings: direction, fit, chrome
    pg = open_card(b)
    open_book(pg, "S1", "S1B1")
    pg.evaluate(f"() => {RD}.querySelector('[data-action=toggleMenu]').click()")
    check("the settings menu opens", not pg.evaluate(f"() => {RD}.querySelector('#mc-menu').hidden"))
    pg.evaluate(f"() => {RD}.querySelector('[data-action=setDir][data-dir=ltr]').click()"); pg.wait_for_timeout(400)
    check("switching to left-to-right: slider direction follows, taps are mirrored",
          pg.evaluate(f"() => {RD}.querySelector('#mc-seek').getAttribute('dir')") is None)
    zone(pg, "right"); check("LTR: tapping the RIGHT side goes forward", cur(pg) == 1, cur(pg))
    check("the choice is remembered per series", pg.evaluate("() => localStorage.getItem('mc-dir-S1')") == "ltr")
    pg.evaluate("() => card._readerDialog.close()"); pg.wait_for_timeout(300)
    open_book(pg, "S1", "S1B1"); check("the volume resumes where it was left (page 2)", cur(pg) == 1, cur(pg))
    zone(pg, "right"); check("and the remembered direction is applied again (LTR: right = forward)", cur(pg) == 2, cur(pg))
    pg.evaluate(f"() => {RD}.querySelector('[data-action=toggleMenu]').click()")
    pg.evaluate(f"() => {RD}.querySelector('[data-action=setFit][data-fit=width]').click()")
    check("'Breite füllen' switches the fit and is remembered", pg.evaluate(f"() => {RD}.querySelector('#mc-rd').classList.contains('fit-width')") and pg.evaluate("() => localStorage.getItem('mc-fit')") == "width")
    pg.evaluate(f"() => {RD}.querySelector('.mc-zone.mid').click()")
    check("tapping the middle hides the controls", pg.evaluate(f"() => {RD}.querySelector('#mc-rd').classList.contains('chrome-hidden')"))
    pg.evaluate(f"() => {RD}.querySelector('.mc-zone.mid').click()")
    check("tapping again shows them", not pg.evaluate(f"() => {RD}.querySelector('#mc-rd').classList.contains('chrome-hidden')"))
    check("no page errors", not pg.errors, pg.errors); pg.close()

    # ---- left-to-right comic
    pg = open_card(b)
    open_book(pg, "S2", "S2B1")
    zone(pg, "right"); check("LTR comic: right side = forward", cur(pg) == 1, cur(pg))
    key(pg, "ArrowRight"); check("LTR comic: arrow right = forward", cur(pg) == 2, cur(pg))
    swipe(pg, -120); check("LTR comic: swiping left = forward", cur(pg) == 3, cur(pg))
    zone(pg, "left"); check("LTR comic: left side = back", cur(pg) == 2, cur(pg)); pg.close()

    # ---- webtoon / scrolling
    pg = open_card(b)
    open_book(pg, "S3", "S3B1")
    info = pg.evaluate(f"() => ({{pages: {RD}.querySelectorAll('.mc-wt-page').length, imgs: {RD}.querySelectorAll('.mc-wt-page img').length, paged: !!{RD}.querySelector('#mc-img')}})")
    check("a WEBTOON series opens in scroll mode with one slot per page", info["pages"] == 12 and not info["paged"], info)
    pg.wait_for_timeout(600)
    n = pg.evaluate(f"() => {RD}.querySelectorAll('.mc-wt-page img').length")
    check("only the pages near the viewport are loaded (lazy)", 1 <= n < 12, n)
    pg.wait_for_timeout(1700)
    check("scroll mode alone does not write progress", patches() == [], patches())
    pg.evaluate(f"() => {{ const s = {RD}.querySelector('#mc-scroll'); s.scrollTop = s.scrollHeight; }}"); pg.wait_for_timeout(1500)
    check("scrolling to the end loads the last page and completes the volume",
          pg.evaluate(f"() => !!{RD}.querySelector('.mc-wt-page[data-n=\"12\"] img')") and any(c["body"] and c["body"].get("completed") for c in patches()), patches())
    check("no page errors", not pg.errors, pg.errors); pg.close()
    b.close()
finish()
