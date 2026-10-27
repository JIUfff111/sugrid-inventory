# -*- coding: utf-8 -*-
"""Dedupe identical combos and backfill combo source titles."""
import json, re, ssl, time, urllib.request
from pathlib import Path
from collections import defaultdict

BASE = Path(r"C:\Pro\Zcode\inventory_mvp\web\docs\sku-catalog\02-research")
p = BASE / "_combined" / "sku-normalized.json"
data = json.loads(p.read_text(encoding="utf-8"))

# 1) dedupe combos with identical model + five config fields
groups = defaultdict(list)
for c in data["combos"]:
    sig = (c["modelKey"], c["cpu"], c["ram"], c["gpu"], c["storage"], c["screen"])
    groups[sig].append(c)

merged, removed = [], 0
for sig, rows in groups.items():
    keep = rows[0]
    if len(rows) > 1:
        removed += len(rows) - 1
        extra = []
        for r in rows[1:]:
            if r["sourceUrl"] and r["sourceUrl"] != keep["sourceUrl"]:
                extra.append(f'补充来源：{r["sourceTitle"] or r["sourceUrl"]}')
            if r["notes"] and r["notes"] not in keep["notes"]:
                extra.append(r["notes"])
        if extra:
            keep = dict(keep)
            keep["notes"] = "；".join([x for x in dict.fromkeys([keep["notes"]] + extra) if x])
    merged.append(keep)

data["combos"] = merged
print("combos:", len(groups), "removed duplicates:", removed)

# 2) backfill titles from models sharing the same URL
url_title = {}
for m in data["models"]:
    if m["sourceUrl"] and m["sourceTitle"]:
        url_title.setdefault(m["sourceUrl"], m["sourceTitle"])

missing = {}
for c in data["combos"]:
    if c["sourceTitle"]:
        continue
    if c["sourceUrl"] in url_title:
        c["sourceTitle"] = url_title[c["sourceUrl"]]
    else:
        missing[c["sourceUrl"]] = True

print("still missing titles for urls:", len(missing))

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")
ctx = ssl.create_default_context(); ctx.check_hostname = False; ctx.verify_mode = ssl.CERT_NONE

def fetch_title(url):
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "text/html,*/*"})
        with urllib.request.urlopen(req, timeout=12, context=ctx) as r:
            raw = r.read(100000)
    except Exception:
        return ""
    text = None
    for enc in ("utf-8", "gb18030"):
        try:
            text = raw.decode(enc)
            if "<title" in text.lower():
                break
        except Exception:
            continue
    if not text:
        return ""
    m = re.search(r"<title[^>]*>(.*?)</title>", text, re.S | re.I)
    if not m:
        return ""
    return re.sub(r"\s+", " ", m.group(1)).strip()[:120]

fetched = {}
for i, url in enumerate(missing, 1):
    fetched[url] = fetch_title(url)
    time.sleep(0.3)
    if i % 10 == 0:
        print("  fetched", i, "/", len(missing), flush=True)

for c in data["combos"]:
    if not c["sourceTitle"]:
        t = fetched.get(c["sourceUrl"], "")
        if not t:
            dom = re.sub(r"^https?://([^/]+).*", r"\1", c["sourceUrl"])
            t = f'{dom} 配置页'
        c["sourceTitle"] = t

print("remaining empty combo titles:", sum(1 for c in data["combos"] if not c["sourceTitle"]))
p.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
print("sample:", [c["sourceTitle"][:50] for c in data["combos"] if "zol" in c["sourceUrl"]][:3])
