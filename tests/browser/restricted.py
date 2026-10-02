"""Child protection: Mylar is closed for a restricted person (403 restricted): the card stays a plain reader, no tabs, no error banner."""
from _server import *
from playwright.sync_api import sync_playwright
import urllib.request

with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome", headless=True, args=["--no-sandbox"])
    for flag, label in ((1, "restricted"), (0, "not restricted")):
        reset()
        urllib.request.urlopen(urllib.request.Request(BASE + f"/__restricted/{flag}", method="POST"))
        pg = b.new_page(viewport={"width": 420, "height": 860}); pg.errors = []; pg.on("pageerror", lambda e: pg.errors.append(str(e)))
        pg.goto(BASE + "/page.html")
        pg.evaluate("""() => { localStorage.clear(); const c = document.createElement('manga-card'); c.setConfig({type: 'custom:manga-card'});
            document.body.appendChild(c); c.hass = window.hassStub; window.card = c; }""")
        pg.wait_for_timeout(1200)
        tabs_hidden = pg.evaluate("() => card.shadowRoot.getElementById('mc-tabs').hidden")
        banner = pg.evaluate("() => card.shadowRoot.getElementById('mc-error').textContent.trim()")
        shows_library = pg.evaluate("() => card.shadowRoot.querySelectorAll('[data-action=openSeries], .mc-tile, .mc-card').length > 0 || /Series|Serie|Berserk|Manga/i.test(card.shadowRoot.textContent)")
        if flag:
            check("[restricted] no Mylar tabs", tabs_hidden)
            check("[restricted] no error banner", banner == "", banner)
            check("[restricted] the Komga library is still there", shows_library)
        else:
            check("[not restricted] the Mylar tabs are there", not tabs_hidden)
        check(f"[{label}] no page errors", not pg.errors, pg.errors)
        pg.close()
    b.close()
finish()
