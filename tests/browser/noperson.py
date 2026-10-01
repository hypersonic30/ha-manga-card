"""A Home Assistant user without a person in the integration gets 403 no_person: the card says so in German, not in the integration's English."""
from _server import *
from playwright.sync_api import sync_playwright
import urllib.request

with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome", headless=True, args=["--no-sandbox"])
    pg = open_card(b)
    msg = pg.evaluate("() => errMessage({status: 403, body: {code: 'no_person', error: 'No person is set up for your Home Assistant user.'}})")
    check("no_person is translated into a German hint", msg.startswith("Für dein Konto ist keine Person angelegt") and "Person hinzufügen" in msg, msg)
    other = pg.evaluate("() => errMessage({status: 503, body: {error: 'Komga is not configured'}})")
    check("other errors keep their own text", other == "Komga is not configured", other)
    pg.close()
    # the whole card: library load fails with 403 no_person -> the banner explains
    reset()
    urllib.request.urlopen(urllib.request.Request(BASE + "/__noperson/1", method="POST"))
    pg = b.new_page(viewport={"width": 420, "height": 860}); pg.errors = []; pg.on("pageerror", lambda e: pg.errors.append(str(e)))
    pg.goto(BASE + "/page.html")
    pg.evaluate("""() => { localStorage.clear(); const c = document.createElement('manga-card'); c.setConfig({type: 'custom:manga-card'});
        document.body.appendChild(c); c.hass = window.hassStub; window.card = c; }""")
    pg.wait_for_timeout(1200)
    banner = pg.evaluate("() => card.shadowRoot.getElementById('mc-error').textContent")
    check("the card shows the German hint instead of an empty library", "keine Person angelegt" in banner and "Verwalter" in banner, banner)
    check("no tabs, no page errors", pg.evaluate("() => card.shadowRoot.getElementById('mc-tabs').hidden") and not pg.errors, pg.errors)
    b.close()
finish()
