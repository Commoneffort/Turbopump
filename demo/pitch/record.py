"""Records the pitch video's scenes from the live site (system Python with Playwright).

Frames come from Chrome's screencast (sharp JPEGs with their own timestamps), not from
Playwright's video recorder. Each scene lasts at least as long as its narration
(build/audio/durations.json). The desk scenes use the funded demo wallet as a burner wallet, on X1 testnet (the public
Solana devnet RPC rate-limits a recording machine too hard for a live trade).

  python3 record.py [scene ...]
"""
import base64
import json
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

APP = "https://turbopumpx.vercel.app"
HERE = Path(__file__).resolve().parent
BUILD = HERE / "build"
DUR = json.loads((BUILD / "audio" / "durations.json").read_text())
KEY = json.loads((HERE.parent.parent / "keys" / "seed" / "demo-video.json").read_text())
W, H, ZOOM = 1920, 1080, 1.2  # captured at 1920x1080, laid out as a 1600x900 window

CURSOR_JS = """
(() => {
  const add = () => {
    if (document.getElementById('__cursor')) return;
    if (location.protocol === 'file:') return;  // the cards have no pointer
    const c = document.createElement('div');
    c.id = '__cursor';
    c.style.cssText = 'position:fixed;left:960px;top:540px;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;' +
      'background:rgba(225,90,72,.35);border:2px solid #E15A48;z-index:2147483647;pointer-events:none;transition:transform .12s';
    document.body.appendChild(c);
    addEventListener('mousemove', e => { c.style.left = e.clientX + 'px'; c.style.top = e.clientY + 'px'; }, true);
    addEventListener('mousedown', () => c.style.transform = 'scale(.6)', true);
    addEventListener('mouseup', () => c.style.transform = 'scale(1)', true);
    // The public devnet RPC rate-limits this machine; its warning is not part of the product.
    const s = document.createElement('style'); s.textContent = '.banner.warn{display:none!important}' + (location.protocol === 'file:' ? '' : 'html{zoom:1.2}'); document.head.appendChild(s);
  };
  if (document.body) add(); else addEventListener('DOMContentLoaded', add);
})();
"""


def storage_js(network: str) -> str:
    # The network is set once per scene, so that the switch in the header can change it.
    return (f"localStorage.setItem('percolator-vaults:devnet-burner', '{json.dumps(KEY)}');"
            "localStorage.setItem('walletName', JSON.stringify('Devnet Burner'));"
            f"if (!sessionStorage.getItem('pitch')) {{ sessionStorage.setItem('pitch', '1'); localStorage.setItem('percolator-vaults:network', '{network}'); }}")


class Scene:
    def __init__(self, p, name, network):
        self.name = name
        self.browser = p.chromium.launch()
        self.ctx = self.browser.new_context(viewport={"width": W, "height": H})
        self.ctx.add_init_script(storage_js(network))
        self.ctx.add_init_script(CURSOR_JS)
        self.page = self.ctx.new_page()
        self.cdp = self.ctx.new_cdp_session(self.page)
        self.dir = BUILD / "frames" / name
        self.dir.mkdir(parents=True, exist_ok=True)
        for f in self.dir.glob("*"):
            f.unlink()
        self.frames = []  # (wall time, file)

    def _frame(self, ev):
        f = self.dir / f"{len(self.frames):05d}.jpg"
        f.write_bytes(base64.b64decode(ev["data"]))
        self.frames.append((time.time(), f.name))
        try:
            self.cdp.send("Page.screencastFrameAck", {"sessionId": ev["sessionId"]})
        except Exception:
            pass

    def start(self):
        self.cdp.on("Page.screencastFrame", self._frame)
        self.cdp.send("Page.startScreencast", {"format": "jpeg", "quality": 92, "maxWidth": 1920, "maxHeight": 1080, "everyNthFrame": 1})
        self.t0 = time.time()
        self.wait(300)

    def wait(self, ms):
        self.page.wait_for_timeout(ms)

    def move_to(self, loc):
        loc.scroll_into_view_if_needed()
        b = loc.bounding_box()
        self.page.mouse.move(b["x"] + b["width"] / 2, b["y"] + b["height"] / 2, steps=25)
        self.wait(250)

    def click(self, loc):
        self.move_to(loc)
        loc.click()
        self.wait(500)

    def type(self, loc, text):
        self.click(loc)
        loc.fill("")
        loc.type(text, delay=110)

    def scroll(self, px, ms=2500):
        steps = max(1, ms // 40)
        for _ in range(steps):
            self.page.mouse.wheel(0, px / steps)
            self.wait(40)

    def finish(self):
        left = DUR[self.name] + 1.0 - (time.time() - self.t0)
        if left > 0:
            self.wait(int(left * 1000))
        end = time.time()
        self.cdp.send("Page.stopScreencast")
        times = [t for t, _ in self.frames] + [end]
        lines = ["ffconcat version 1.0"]
        for i, (_, f) in enumerate(self.frames):
            lines += [f"file '{f}'", f"duration {max(times[i + 1] - times[i], 0.001):.3f}"]
        lines.append(f"file '{self.frames[-1][1]}'")
        (self.dir / "frames.txt").write_text("\n".join(lines) + "\n")
        self.browser.close()
        print(f"{self.name:8s} {end - self.t0:6.1f}s  {len(self.frames)} frames", flush=True)


def card(s):
    pass


def markets(s):
    s.wait(3500)
    s.scroll(330, 3000)
    s.wait(3500)
    s.scroll(-330, 2000)


def trade(s):
    pg = s.page
    s.move_to(pg.get_by_text("VAULT CAPACITY", exact=False).first)
    s.wait(3500)
    s.type(pg.locator("input[placeholder='0.00']").first, "0.5")
    s.wait(1800)
    s.click(pg.locator("button.submit"))
    pg.wait_for_selector(".toast", timeout=90000)
    print("  " + pg.locator(".toast").inner_text()[:120], flush=True)
    s.wait(1500)
    try:
        pg.wait_for_selector("text=No open positions.", state="detached", timeout=60000)
    except Exception:
        print("  position did not show in time", flush=True)
    s.move_to(pg.get_by_role("button", name="Positions").first)
    s.wait(3000)


def orders(s):
    pg = s.page
    s.wait(600)
    for name, hold in [("Limit", 1700), ("TP / SL", 1900), ("TWAP", 1900)]:
        s.click(pg.get_by_role("button", name=name, exact=True))
        s.wait(hold)
    s.click(pg.get_by_text("Indicators").first)
    s.wait(1800)
    pg.keyboard.press("Escape")
    pg.mouse.click(700, 420)


def earn(s):
    pg = s.page
    s.wait(800)
    s.click(pg.get_by_role("button", name="Earn", exact=True))
    s.wait(2500)
    s.move_to(pg.get_by_text("Deposit or withdraw").first)
    s.wait(1500)
    s.scroll(260, 2000)


def launch(s):
    pg = s.page
    s.wait(1500)
    doge = pg.locator("button", has_text="DOGE").first
    if doge.count():
        s.click(doge)
    s.wait(1500)
    s.move_to(pg.get_by_text("Opener's share of fees").first)
    s.wait(2500)


def copy(s):
    pg = s.page
    s.wait(1800)
    s.move_to(pg.get_by_role("button", name="Follow").first)
    s.wait(1500)
    s.move_to(pg.get_by_role("button", name="Copy", exact=True).first)
    s.wait(1200)
    s.scroll(300, 2000)


def proof(s):
    pg = s.page
    s.move_to(pg.get_by_text("FILLS", exact=False).first)
    s.wait(4000)
    s.click(pg.get_by_role("button", name="X1 testnet"))  # the page reloads on the other network
    pg.wait_for_selector("button.submit", timeout=60000)
    s.wait(2500)
    s.move_to(pg.locator(".net-switch").first)
    s.wait(2500)


SCENES = [
    # name, action, route, network, selector that says the page is ready
    ("title", card, f"file://{HERE}/card.html?k=title", "devnet", ".rows"),
    ("markets", markets, f"{APP}/#/markets", "devnet", "text=SOL-PERP"),
    ("trade", trade, f"{APP}/#/trade/SOL", "x1-testnet", "button.submit"),
    ("orders", orders, f"{APP}/#/trade/SOL", "x1-testnet", "button.submit"),
    ("earn", earn, f"{APP}/#/trade/SOL", "x1-testnet", "button.submit"),
    ("launch", launch, f"{APP}/#/launch", "devnet", "text=The rules every market gets"),
    ("copy", copy, f"{APP}/#/traders", "devnet", "text=Largest fall"),
    ("proof", proof, f"{APP}/#/markets", "devnet", "text=SOL-PERP"),
    ("outro", card, f"file://{HERE}/card.html?k=outro", "devnet", ".links"),
]

if __name__ == "__main__":
    only = set(sys.argv[1:])
    with sync_playwright() as p:
        for name, fn, url, network, ready in SCENES:
            if only and name not in only:
                continue
            s = Scene(p, name, network)
            s.page.goto(url, wait_until="domcontentloaded")
            s.page.wait_for_selector(ready, timeout=240000)
            s.wait(6000)  # prices, chart and tables settle before the scene starts
            s.start()
            fn(s)
            s.finish()
