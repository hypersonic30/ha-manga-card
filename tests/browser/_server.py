"""Test setup: a static server for the card + a small fake Komga behind /api/books/komga/ (127.0.0.1:8322).

Every test script starts with `from _server import *`. The fake keeps reading progress in memory and records every request
(`calls()`), so tests can assert what the card sent to Komga. `reset()` restores the initial state.
"""
import http.server, json, os, re, sys, threading, urllib.parse
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
CARD = os.path.abspath(os.path.join(HERE, "..", "..", "manga-card.js"))
PORT = 8322
PAGE_JPG = open(os.path.join(HERE, "page.jpg"), "rb").read()


def _book(bid, series, number, pages, w=800, h=1200):
    return {"id": bid, "seriesId": series["id"], "seriesTitle": series["name"], "name": f"{series['name']} v{number:02d}", "number": number,
            "metadata": {"title": f"{series['name']} Band {number}", "number": str(number)}, "readProgress": None,
            "media": {"pagesCount": pages, "status": "READY"}, "_w": w, "_h": h}


def _fresh():
    series = [
        {"id": "S1", "name": "Test Manga RTL", "libraryId": "L1", "dir": "RIGHT_TO_LEFT", "vols": 3, "pages": 8},
        {"id": "S2", "name": "Test Comic LTR", "libraryId": "L2", "dir": "LEFT_TO_RIGHT", "vols": 2, "pages": 6},
        {"id": "S3", "name": "Webtoon Test", "libraryId": "L2", "dir": "WEBTOON", "vols": 1, "pages": 12},
    ] + [{"id": f"F{n:02d}", "name": f"Filler {n:02d}", "libraryId": "L1", "dir": "RIGHT_TO_LEFT", "vols": 1, "pages": 3} for n in range(1, 71)]
    books = {}
    for s in series:
        for v in range(1, s["vols"] + 1):
            b = _book(f"{s['id']}B{v}", s, v, s["pages"], 800, 4000 if s["dir"] == "WEBTOON" else 1200)
            books[b["id"]] = b
    return series, books


class State:
    lock = threading.Lock()
    series, books, log = _fresh()[0], _fresh()[1], []
    down = False


def reset():
    with State.lock:
        State.series, State.books = _fresh()
        State.log = []
        State.down = False


def calls():
    with State.lock:
        return list(State.log)


def _series_json(s):
    bs = [b for b in State.books.values() if b["seriesId"] == s["id"]]
    read = sum(1 for b in bs if b["readProgress"] and b["readProgress"]["completed"])
    prog = sum(1 for b in bs if b["readProgress"] and not b["readProgress"]["completed"])
    return {"id": s["id"], "name": s["name"], "libraryId": s["libraryId"], "booksCount": len(bs), "booksReadCount": read,
            "booksInProgressCount": prog, "booksUnreadCount": len(bs) - read - prog,
            "metadata": {"title": s["name"], "status": "ONGOING", "language": "de", "publisher": "Test Verlag", "readingDirection": s["dir"],
                         "summary": f"Zusammenfassung von {s['name']}."},
            "booksMetadata": {"authors": [{"name": "Test Autor", "role": "writer"}], "summary": ""}}


def _book_json(b):
    return {k: v for k, v in b.items() if not k.startswith("_")}


def _page(content, size, number):
    return {"content": content[number * size:(number + 1) * size], "totalElements": len(content), "number": number, "size": size}


class H(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def translate_path(self, path):
        p = path.split("?")[0]
        return CARD if p == "/manga-card.js" else os.path.join(HERE, p.lstrip("/") or "page.html")

    def _send(self, status, body=b"", ctype="application/json"):
        if not isinstance(body, bytes):
            body = json.dumps(body).encode()
        self.send_response(status); self.send_header("Content-Type", ctype); self.send_header("Content-Length", str(len(body))); self.end_headers()
        if body and self.command != "HEAD":
            self.wfile.write(body)

    def _komga(self, method):
        url = urllib.parse.urlparse(self.path); path = url.path[len("/api/books/komga/"):]
        q = {k: v[0] for k, v in urllib.parse.parse_qs(url.query).items()}
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length)) if length else None
        with State.lock:
            if State.down:
                return self._send(503, {"error": "Komga is not configured"})
            State.log.append({"method": method, "path": path, "query": q, "body": body})
            size, number = int(q.get("size", 20)), int(q.get("page", 0))
            if method == "GET":
                if path == "v1/libraries":
                    return self._send(200, [{"id": "L1", "name": "Manga"}, {"id": "L2", "name": "Comics"}])
                if path == "v1/series":
                    items = [s for s in State.series if (not q.get("library_id") or s["libraryId"] == q["library_id"])
                             and (not q.get("search") or q["search"].lower() in s["name"].lower())]
                    return self._send(200, _page([_series_json(s) for s in items], size, number))
                m = re.fullmatch(r"v1/series/(\w+)", path)
                if m: return self._send(200, _series_json(next(s for s in State.series if s["id"] == m.group(1))))
                m = re.fullmatch(r"v1/series/(\w+)/books", path)
                if m:
                    return self._send(200, _page([_book_json(b) for b in State.books.values() if b["seriesId"] == m.group(1)], 500, 0))
                if re.fullmatch(r"v1/(series|books)/\w+/thumbnail", path): return self._send(200, PAGE_JPG, "image/jpeg")
                if path == "v1/books" and q.get("read_status") == "IN_PROGRESS":
                    items = [b for b in State.books.values() if b["readProgress"] and not b["readProgress"]["completed"]]
                    return self._send(200, _page([_book_json(b) for b in items], size, 0))
                if path == "v1/books/ondeck":
                    items = []
                    for s in State.series:
                        bs = [b for b in State.books.values() if b["seriesId"] == s["id"]]
                        if any(b["readProgress"] and not b["readProgress"]["completed"] for b in bs): continue
                        done = [b for b in bs if b["readProgress"] and b["readProgress"]["completed"]]
                        todo = [b for b in bs if not b["readProgress"]]
                        if done and todo: items.append(_book_json(todo[0]))
                    return self._send(200, _page(items, size, 0))
                m = re.fullmatch(r"v1/books/(\w+)/pages", path)
                if m:
                    b = State.books[m.group(1)]
                    return self._send(200, [{"number": n, "fileName": f"{n:03d}.jpg", "mediaType": "image/jpeg", "width": b["_w"], "height": b["_h"]}
                                            for n in range(1, b["media"]["pagesCount"] + 1)])
                if re.fullmatch(r"v1/books/\w+/pages/\d+", path): return self._send(200, PAGE_JPG, "image/jpeg")
                m = re.fullmatch(r"v1/books/(\w+)/next", path)
                if m:
                    b = State.books[m.group(1)]; later = [x for x in State.books.values() if x["seriesId"] == b["seriesId"] and x["number"] > b["number"]]
                    return self._send(200, _book_json(later[0])) if later else self._send(404, {"status": 404})
            if method == "PATCH":
                m = re.fullmatch(r"v1/books/(\w+)/read-progress", path)
                if m:
                    State.books[m.group(1)]["readProgress"] = {"page": body["page"], "completed": body["completed"]}
                    return self._send(204)
            if method in ("POST", "DELETE"):
                m = re.fullmatch(r"v1/series/(\w+)/read-progress", path)
                if m:
                    for b in State.books.values():
                        if b["seriesId"] == m.group(1):
                            b["readProgress"] = {"page": b["media"]["pagesCount"], "completed": True} if method == "POST" else None
                    return self._send(204)
        self._send(404, {"error": f"unhandled {method} {path}"})

    def do_GET(self):
        if self.path.startswith("/__calls"):
            return self._send(200, calls())
        if self.path.startswith("/api/books/komga/"):
            return self._komga("GET")
        super().do_GET()

    def do_POST(self):
        if self.path.startswith("/__reset"):
            reset(); return self._send(200, {"ok": True})
        if self.path.startswith("/__down"):
            State.down = self.path.endswith("/1"); return self._send(200, {"ok": True})
        if self.path.startswith("/__progress/"):                       # test helper: preset reading progress "book/page/completed"
            bid, page, done = self.path.split("/")[2:5]
            with State.lock: State.books[bid]["readProgress"] = {"page": int(page), "completed": done == "1"}
            return self._send(200, {"ok": True})
        self._komga("POST")

    def do_PATCH(self):
        self._komga("PATCH")

    def do_DELETE(self):
        self._komga("DELETE")


srv = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()
BASE = f"http://127.0.0.1:{PORT}"


fails = []


def check(name, cond, extra=""):
    print(("PASS " if cond else "FAIL ") + name, "" if cond else f"\n      {extra}")
    if not cond:
        fails.append(name)


def finish():
    print("ALL PASSED" if not fails else f"FAILED: {fails}")
    sys.exit(1 if fails else 0)


def open_card(browser, viewport=(420, 860), wait=True):
    """Fresh state, fresh page, card mounted with the stub hass; waits until the library has loaded."""
    reset()
    pg = browser.new_page(viewport={"width": viewport[0], "height": viewport[1]})
    pg.errors = []
    pg.on("pageerror", lambda e: pg.errors.append(str(e)))
    pg.goto(BASE + "/page.html")
    pg.evaluate("""() => { localStorage.clear(); const c = document.createElement('manga-card'); c.setConfig({type: 'custom:manga-card'});
        document.body.appendChild(c); c.hass = window.hassStub; window.card = c; }""")
    if wait:
        pg.wait_for_function("() => card._loaded && !card._loading && card._series.length > 0", timeout=15000)
        pg.wait_for_timeout(150)
    return pg


def set_progress(book, page, completed=False):
    import urllib.request
    urllib.request.urlopen(urllib.request.Request(f"{BASE}/__progress/{book}/{page}/{1 if completed else 0}", method="POST"))


def patches():
    return [c for c in calls() if c["method"] == "PATCH"]


def reload(pg):
    """Reload the library and wait until it is really done (progress presets must be visible before the test continues)."""
    pg.evaluate("async () => { card._loaded = false; await card._initialLoad(); }")
    pg.wait_for_timeout(150)
