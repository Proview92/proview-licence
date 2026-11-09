"""Smoke test for the licence portal: opens the sign-in screen and every main view without page errors.

Supabase is replaced by tests/fake-supabase.js (sample data, no network). Run from anywhere:
    python3 tests/smoke.py [--port 8769] [--shots DIR] [--fonts DIR]
--shots saves screenshots (dark / light / menu at bottom at 1440x900, 820x1180 and 390x844).
--fonts serves a local copy of the Plus Jakarta Sans files (font.css + woff2) instead of Google Fonts.
"""
import argparse, asyncio, functools, http.server, os, sys, threading
from pathlib import Path
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parent.parent
FAKE = (ROOT / "tests" / "fake-supabase.js").read_text()
VIEWS = ["customers", "expiring", "payments", "activity"]
SIZES = {"1440": (1440, 900), "820": (820, 1180), "390": (390, 844)}


def serve(port):
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a):
            pass
    h = functools.partial(Quiet, directory=str(ROOT))
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", port), h)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


async def routes(ctx, fonts):
    await ctx.route("https://esm.sh/**", lambda r: r.fulfill(body=FAKE, content_type="application/javascript"))
    async def font(r):
        if fonts:
            name = "font.css" if "googleapis" in r.request.url else r.request.url.rsplit("/", 1)[-1]
            f = Path(fonts) / name
            if f.exists():
                body = f.read_bytes()
                if name == "font.css":
                    body = body.replace(b"https://fonts.gstatic.com/s/plusjakartasans/v12/", b"https://fonts.gstatic.com/")
                return await r.fulfill(body=body, content_type="text/css" if name == "font.css" else "font/woff2")
        await r.abort()
    await ctx.route("https://fonts.googleapis.com/**", font)
    await ctx.route("https://fonts.gstatic.com/**", font)


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", 8769)))
    ap.add_argument("--shots")
    ap.add_argument("--fonts")
    a = ap.parse_args()
    srv = serve(a.port)
    url = f"http://127.0.0.1:{a.port}/index.html"
    fails = []
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])

        async def page_for(size, theme="dark", menu="side", signed_out=False):
            ctx = await b.new_context(viewport={"width": size[0], "height": size[1]})
            await routes(ctx, a.fonts)
            await ctx.add_init_script(f"""localStorage.setItem('pv.theme','{theme}');localStorage.setItem('pv.menu','{menu}');
                {'window.__PV_SIGNED_OUT=true;' if signed_out else ''}""")
            pg = await ctx.new_page()
            errs = []
            pg.on("pageerror", lambda e: errs.append(str(e)))
            await pg.goto(url)
            await pg.wait_for_timeout(400)
            return ctx, pg, errs

        def check(name, ok, errs):
            status = "ok " if ok and not errs else "FAIL"
            print(f"{status} {name}" + (f"  errors: {errs}" if errs else ""))
            if status == "FAIL":
                fails.append(name)

        # sign-in screen
        ctx, pg, errs = await page_for(SIZES["1440"], signed_out=True)
        check("sign-in screen", await pg.is_visible("#authForm") and await pg.is_hidden("#appView"), errs)
        await pg.click("#authSwap")
        check("create-account screen", await pg.is_visible("#lgPw2"), errs)
        await ctx.close()

        # every main view, dialogs and the two switches
        ctx, pg, errs = await page_for(SIZES["1440"])
        check("app shown when signed in", await pg.is_visible("#appView") and await pg.is_visible(".ccard"), errs)
        for v in VIEWS:
            await pg.click(f'.side .nav a[data-tab="{v}"]')
            await pg.wait_for_timeout(150)
            check(f"view {v}", await pg.is_visible(f'[data-view="{v}"]') and (await pg.text_content("#pageTitle")).lower() == v, errs)
        await pg.click('.side .nav a[data-tab="customers"]')
        await pg.click(".ccard [data-open] >> nth=0")
        check("customer page", await pg.is_visible(".cust.open"), errs)
        await pg.click(".cust [data-edit]")
        check("licence dialog", await pg.is_visible("#licDlg"), errs)
        await pg.keyboard.press("Escape")
        await pg.click("#themeBtn")
        check("light mode switch", await pg.get_attribute("html", "data-theme") == "light"
              and await pg.evaluate("localStorage.getItem('pv.theme')") == "light", errs)
        await pg.click("#navBtn")
        check("menu at bottom switch", await pg.evaluate("document.documentElement.classList.contains('menu-bottom')"), errs)
        await pg.click("#navBtn")
        await pg.click("#themeBtn")
        check("switches back", await pg.get_attribute("html", "data-theme") == "dark"
              and not await pg.evaluate("document.documentElement.classList.contains('menu-bottom')"), errs)
        await ctx.close()

        if a.shots:
            out = Path(a.shots); out.mkdir(parents=True, exist_ok=True)
            for mode, theme, menu in [("dark", "dark", "side"), ("light", "light", "side"), ("bottom", "dark", "bottom")]:
                for sz, dim in SIZES.items():
                    ctx, pg, errs = await page_for(dim, theme, menu)
                    await pg.wait_for_timeout(300)
                    await pg.screenshot(path=str(out / f"{mode}-{sz}.png"))
                    check(f"screenshot {mode}-{sz}", True, errs)
                    await ctx.close()
            for theme in ["dark", "light"]:
                ctx, pg, errs = await page_for(SIZES["1440"], theme, signed_out=True)
                await pg.screenshot(path=str(out / f"signin-{theme}-1440.png"))
                await ctx.close()
                ctx, pg, errs = await page_for(SIZES["390"], theme, signed_out=True)
                await pg.screenshot(path=str(out / f"signin-{theme}-390.png"))
                await ctx.close()
            ctx, pg, errs = await page_for(SIZES["1440"])
            for v in ["expiring", "payments", "activity"]:
                await pg.click(f'.side .nav a[data-tab="{v}"]'); await pg.wait_for_timeout(200)
                await pg.screenshot(path=str(out / f"page-{v}-1440.png"))
            await pg.click('.side .nav a[data-tab="customers"]')
            await pg.click(".ccard [data-open] >> nth=0"); await pg.wait_for_timeout(150)
            await pg.screenshot(path=str(out / "page-customer-1440.png"), full_page=True)
            await pg.click(".cust [data-edit]"); await pg.wait_for_timeout(150)
            await pg.screenshot(path=str(out / "dialog-licence-1440.png"))
            await pg.keyboard.press("Escape")
            await pg.click("#sideMe"); await pg.wait_for_timeout(150)
            await pg.screenshot(path=str(out / "account-menu-1440.png"))
            await pg.keyboard.press("Escape")
            await pg.click("#appView .collapsed, #collapseBtn"); await pg.wait_for_timeout(150)
            await pg.screenshot(path=str(out / "collapsed-1440.png"))
            await pg.click("#collapseBtn")
            check("extra screenshots", True, errs)
            await ctx.close()
        await b.close()
    srv.shutdown()
    print("PASS" if not fails else f"FAILED: {fails}")
    sys.exit(1 if fails else 0)


asyncio.run(main())
