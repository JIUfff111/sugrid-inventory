# -*- coding: utf-8 -*-
"""Fill missing source titles by fetching <title> from the page itself."""
import json, re, ssl, time, urllib.request, urllib.error
from pathlib import Path

BASE = Path(r"C:\Pro\Zcode\inventory_mvp\web\docs\sku-catalog\02-research")
p = BASE / "_combined" / "sku-normalized.json"
data = json.loads(p.read_text(encoding="utf-8"))
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")
ctx = ssl.create_default_context(); ctx.check_hostname = False; ctx.verify_mode = ssl.CERT_NONE

def fetch_title(url):
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "text/html,*/*"})
        with urllib.request.urlopen(req, timeout=15, context=ctx) as r:
            raw = r.read(120000)
    except Exception:
        return ""
    text = None
    for enc in ("utf-8", "gb18030", "gbk"):
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
    t = re.sub(r"\s+", " ", m.group(1)).strip()
    t = t.replace("&nbsp;", " ").replace("&amp;", "&")
    return t[:120]

DESC = {
    "detail.zol.com.cn": "产品参数页 - 中关村在线",
    "shop.zol.com": "商品页 - ZOL商城",
    "nb.zol.com.cn": "行情/评测页 - 中关村在线",
    "m.zol.com.cn": "文章页 - 中关村在线",
    "s.zol.com.cn": "搜索/列表页 - 中关村在线",
    "shop.lenovo.com.cn": "商品页 - 联想商城",
    "s.lenovo.com.cn": "站内搜索页 - 联想商城",
    "www.lenovo.com.cn": "产品/知识库页 - 联想官网",
    "product.yesky.com": "产品参数页 - 天极产品库",
}

todo = {}
for m in data["models"]:
    if not m["sourceTitle"] or m["sourceTitle"].startswith("http"):
        todo[m["sourceUrl"]] = (m["brand"], m["model"], m["modelYear"])

print("fetch titles for", len(todo), "urls")
titles = {}
for i, url in enumerate(todo, 1):
    t = fetch_title(url)
    titles[url] = t
    if i % 10 == 0:
        print(f"  {i}/{len(todo)}", flush=True)
    time.sleep(0.3)

for m in data["models"]:
    u = m["sourceUrl"]
    if u in titles:
        t = titles[u]
        if not t:
            dom = re.sub(r"^https?://([^/]+).*", r"\1", u)
            desc = next((v for k, v in DESC.items() if k in dom), "产品页面")
            t = f'「{m["model"]} {m["modelYear"]}」{desc}'
        m["sourceTitle"] = t

# ---- backfill combo titles: reuse model titles by URL, then fetch ----
url_map = {}
for m in data["models"]:
    if m["sourceUrl"] and m["sourceTitle"]:
        url_map.setdefault(m["sourceUrl"], m["sourceTitle"])

missing_c = {}
for c in data["combos"]:
    if c.get("sourceTitle"):
        continue
    if c["sourceUrl"] in url_map:
        c["sourceTitle"] = url_map[c["sourceUrl"]]
    else:
        missing_c[c["sourceUrl"]] = True

print("combo titles still missing urls:", len(missing_c))
for i, url in enumerate(missing_c, 1):
    t = fetch_title(url)
    if not t:
        dom = re.sub(r"^https?://([^/]+).*", r"\1", url)
        t = f"{dom} 配置页"
    url_map[url] = t
    if i % 10 == 0:
        print("  combo title", i, "/", len(missing_c), flush=True)
    time.sleep(0.2)

for c in data["combos"]:
    if not c.get("sourceTitle"):
        c["sourceTitle"] = url_map.get(c["sourceUrl"], "")

p.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
got = sum(1 for t in titles.values() if t)
print("fetched ok:", got, "fallback:", len(titles) - got)
for u, t in list(titles.items())[:8]:
    print("  ", (t or "(fallback)")[:80], "|", u[:60])
