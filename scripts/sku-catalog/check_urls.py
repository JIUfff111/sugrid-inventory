# -*- coding: utf-8 -*-
"""Check HTTP accessibility of source URLs (per brand) with concurrency."""
import json, ssl, sys, urllib.request, urllib.error
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed

BASE = Path(r"C:\Pro\Zcode\inventory_mvp\web\docs\sku-catalog\02-research")
brand_arg = sys.argv[1] if len(sys.argv) > 1 else "联想"
brands = brand_arg.split(",")
group = sys.argv[2] if len(sys.argv) > 2 else brand_arg.replace(",", "-")
data = json.loads((BASE / "_combined" / "sku-normalized.json").read_text(encoding="utf-8"))

keys = {f'{m["productType"]}|{m["brand"]}|{m["model"]}|{m["modelYear"]}'
        for m in data["models"] if m["brand"] in brands}
urls = sorted({m["sourceUrl"] for m in data["models"] if m["brand"] in brands and m["sourceUrl"]}
              | {c["sourceUrl"] for c in data["combos"] if c["modelKey"] in keys and c["sourceUrl"]})

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")
ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

def check(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "text/html,*/*"})
    try:
        with urllib.request.urlopen(req, timeout=10, context=ctx) as r:
            r.read(2048)
            return url, {"status": r.status, "ok": True, "final": r.geturl()}
    except urllib.error.HTTPError as e:
        return url, {"status": e.code, "ok": e.code < 500, "final": url, "error": f"HTTP {e.code}"}
    except Exception as e:
        return url, {"status": 0, "ok": False, "final": url, "error": type(e).__name__ + ": " + str(e)[:80]}

res = {}
with ThreadPoolExecutor(max_workers=12) as ex:
    futs = [ex.submit(check, u) for u in urls]
    for i, f in enumerate(as_completed(futs), 1):
        u, r = f.result()
        res[u] = r
        if i % 20 == 0:
            print(f"  checked {i}/{len(urls)}", flush=True)

ok = sum(1 for r in res.values() if r["ok"])
print(f"{group}: {len(urls)} urls, ok {ok}, failed {len(urls)-ok}")
for u, r in res.items():
    if not r["ok"]:
        print("  FAIL", r["status"], r.get("error", ""), u[:110])

(BASE / f"url-check-{group}.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
