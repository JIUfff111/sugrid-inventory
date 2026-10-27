# -*- coding: utf-8 -*-
"""Normalize the four research files into one SKU dataset."""
import json, re
from pathlib import Path
from collections import Counter, defaultdict

BASE = Path(r"C:\Pro\Zcode\inventory_mvp\web\docs\sku-catalog\02-research")
FILES = [
    ("lenovo/lenovo-thinlight.json", "轻薄本"),
    ("lenovo/lenovo-gaming.json", "游戏本"),
    ("asus/asus-thinlight.json", "轻薄本"),
    ("asus/asus-gaming-v2.json", "游戏本"),
    ("dell/dell-thinlight.json", "轻薄本"),
    ("dell/dell-gaming.json", "游戏本"),
    ("hp/hp-thinlight.json", "轻薄本"),
    ("hp/hp-gaming.json", "游戏本"),
    ("huawei/huawei-thinlight.json", "轻薄本"),
    ("honor/honor-thinlight.json", "轻薄本"),
    ("apple/apple-air.json", "轻薄本"),
    ("apple/apple-pro.json", "轻薄本"),
    ("acer/acer-thinlight.json", "轻薄本"),
    ("acer/acer-gaming.json", "游戏本"),
    ("msi/msi-thinlight.json", "轻薄本"),
    ("msi/msi-gaming.json", "游戏本"),
    ("mechrevo/mechrevo.json", "轻薄本"),
    ("hasee/hasee.json", "轻薄本"),
]

OFFICIAL = ("lenovo.com.cn", "asus.com.cn", "rog.asus.com.cn")
ZOL_SPEC = ("detail.zol.com.cn", "series/", "param", "product.yesky.com", "product.pconline.com.cn")

def domain(url: str) -> str:
    m = re.match(r"https?://([^/]+)", url or "")
    return (m.group(1).lower().removeprefix("www.") if m else "")

def spaced(s: str) -> str:
    s = (s or "").replace("\u3000", " ").replace("\xa0", " ")
    return re.sub(r"\s+", " ", s).strip()

YEAR_TAIL = re.compile(r"[\s\-_]*((?:19|20)\d{2})\s*$")

def norm_model(model: str, year):
    m = spaced(model)
    hit = YEAR_TAIL.search(m)
    if hit and int(hit.group(1)) == year:
        m = YEAR_TAIL.sub("", m).strip()
    return m

def norm_ram(values):
    out, detail = [], []
    for v in values or []:
        v = spaced(str(v))
        if not v:
            continue
        m = re.match(r"^(\d+)\s*GB\b(.*)$", v, re.I)
        if m:
            cap = f"{int(m.group(1))}GB"
            rest = m.group(2).strip(" ()（）")
            if rest and rest.lower() not in cap.lower():
                detail.append(f"{cap}（{rest}）")
        else:
            cap = v
        if cap not in out:
            out.append(cap)
    return out, detail

def norm_gpu(values):
    out = []
    for v in values or []:
        if isinstance(v, dict):
            t = str(v.get("type", ""))
            name = spaced(v.get("name", ""))
            val = "集成显卡" if "集成" in t or "核显" in t else name
        else:
            val = spaced(str(v))
            if val in ("集显", "核芯显卡", "集成显卡（核显）"):
                val = "集成显卡"
        if not val:
            continue
        if val not in out:
            out.append(val)
    return out

def norm_list(values):
    out = []
    for v in values or []:
        val = spaced(str(v))
        if val and val not in out:
            out.append(val)
    return out

def guess_source_type(url: str) -> str:
    d = domain(url)
    if any(d.endswith(x) for x in ("lenovo.com.cn", "asus.com.cn", "rog.asus.com.cn")):
        return "厂商官方"
    if "zol.com.cn" in d or "zol.com" in d:
        return "产品库（中关村在线）"
    if "pconline" in d or "yesky" in d or "pchome" in d:
        return "产品库（太平洋/天极/PChome）"
    if d in ("jd.com", "tmall.com", "taobao.com") or "jd.com" in d:
        return "电商页面"
    if "baike" in d:
        return "百科/资料站"
    return "媒体报道"

def guess_confidence(url: str, src_type: str) -> str:
    d = domain(url)
    if src_type == "厂商官方":
        return "high"
    if src_type.startswith("产品库") and ("detail.zol.com.cn" in d or "product.yesky.com" in d or "product.pconline.com.cn" in d):
        return "high"
    if src_type == "电商页面":
        return "high"
    if src_type == "百科/资料站":
        return "medium"
    return "medium"

models, combos, aliases, uncertain = [], [], [], []
mem_notes = defaultdict(list)

for fname, category in FILES:
    data = json.loads((BASE / fname).read_text(encoding="utf-8"))
    src_models = data["models"]
    # local model key set for validation
    for m in src_models:
        year = m.get("modelYear")
        if isinstance(year, str):
            mm = re.search(r"((?:19|20)\d{2})", year)
            year = int(mm.group(1)) if mm else None
        model = norm_model(m.get("model", ""), year)
        ram, detail = norm_ram(m.get("ramOptions"))
        url = m.get("sourceUrl", "")
        stype = guess_source_type(url)
        conf = m.get("confidence") or guess_confidence(url, stype)
        rec = {
            "productType": "笔记本电脑",
            "brand": spaced(m.get("brand", "")),
            "model": model,
            "modelYear": year,
            "category": m.get("category") or category,
            "cpuOptions": norm_list(m.get("cpuOptions")),
            "ramOptions": ram,
            "gpuOptions": norm_gpu(m.get("gpuOptions")),
            "storageOptions": norm_list(m.get("storageOptions")),
            "screenOptions": norm_list(m.get("screenOptions")),
            "sourceUrl": url,
            "sourceTitle": spaced(m.get("sourceTitle", "")),
            "checkedAt": m.get("checkedAt") or "2026-10-23",
            "confidence": conf,
            "notes": spaced(m.get("notes", "")),
            "origin": fname,
        }
        models.append(rec)
        if detail:
            mem_notes[(rec["brand"], rec["model"], year)] = detail

    for c in data.get("configCombos", []):
        mk = c.get("modelKey", "")
        parts = mk.split("|")
        combos.append({
            "modelKey": mk,
            "brand": parts[1] if len(parts) > 1 else "",
            "model": parts[2] if len(parts) > 2 else "",
            "modelYear": parts[3] if len(parts) > 3 else "",
            "cpu": spaced(c.get("cpu", "")),
            "ram": spaced(c.get("ram", "")),
            "gpu": ("集成显卡" if spaced(c.get("gpu", "")).startswith("集成") else spaced(c.get("gpu", ""))),
            "storage": spaced(c.get("storage", "")),
            "screen": spaced(c.get("screen", "")),
            "sourceUrl": c.get("sourceUrl", ""),
            "sourceTitle": spaced(c.get("sourceTitle", c.get("priceInfo", ""))),
            "confidence": c.get("confidence") or guess_confidence(c.get("sourceUrl", ""), guess_source_type(c.get("sourceUrl", ""))),
            "notes": spaced(c.get("notes", "")),
            "origin": fname,
        })

    for a in data.get("aliases", []):
        aliases.append({
            "alias": spaced(a.get("alias", "")),
            "modelKey": a.get("modelKey", ""),
            "aliasType": spaced(a.get("aliasType", "")),
            "note": spaced(a.get("note", "")),
            "sourceUrl": a.get("sourceUrl", ""),
        })

    for u in data.get("uncertain", []):
        uncertain.append({
            "model": spaced(u.get("model") or u.get("item") or ""),
            "issue": spaced(u.get("issue") or u.get("reason") or u.get("problem") or ""),
            "suggestion": spaced(u.get("suggestion", "")),
            "sourceUrl": u.get("sourceUrl", ""),
            "origin": fname,
        })

# ---- validate & dedupe models ----
keys = [(m["productType"], m["brand"], m["model"], m["modelYear"]) for m in models]
dups = [k for k, n in Counter(keys).items() if n > 1]
print("models:", len(models), "unique:", len(set(keys)), "dups:", len(dups))
for k in dups:
    same = [m for m in models if (m["productType"], m["brand"], m["model"], m["modelYear"]) == k]
    print("  DUP", k, [s["origin"] for s in same], [bool(s["sourceUrl"]) for s in same])

bad = [m for m in models if not m["brand"] or not m["model"] or not isinstance(m["modelYear"], int) or not m["sourceUrl"]]
print("invalid core fields:", len(bad))
for b in bad[:5]:
    print("  ", b["brand"], b["model"], b["modelYear"], b["sourceUrl"])

# attach memory detail
for m in models:
    d = mem_notes.get((m["brand"], m["model"], m["modelYear"]))
    if d:
        m["notes"] = (m["notes"] + "；内存标注：" + "、".join(dict.fromkeys(d))).strip("；")

# combo model key validity
mkeys = {f'{m["productType"]}|{m["brand"]}|{m["model"]}|{m["modelYear"]}' for m in models}
bad_combo = [c for c in combos if c["modelKey"] not in mkeys]
print("combos:", len(combos), "dangling:", len(bad_combo))
for c in bad_combo[:12]:
    print("  ", c["modelKey"], c["origin"])

# ---- carry over source titles from the previous normalized file ----
_prev_path = BASE / "_combined" / "sku-normalized.json"
_old_models, _old_combos = {}, {}
if _prev_path.exists():
    try:
        _prev = json.loads(_prev_path.read_text(encoding="utf-8"))
        _old_models = {f'{m["productType"]}|{m["brand"]}|{m["model"]}|{m["modelYear"]}': m.get("sourceTitle", "")
                       for m in _prev.get("models", [])}
        _old_combos = {(c["modelKey"], c["cpu"], c["ram"], c["gpu"], c["storage"], c["screen"]): c.get("sourceTitle", "")
                       for c in _prev.get("combos", [])}
    except Exception:
        pass

for m in models:
    if not m["sourceTitle"]:
        m["sourceTitle"] = _old_models.get(f'{m["productType"]}|{m["brand"]}|{m["model"]}|{m["modelYear"]}', "")

# ---- repair combo model keys that carry a redundant year suffix ----
_keys = {f'{m["productType"]}|{m["brand"]}|{m["model"]}|{m["modelYear"]}' for m in models}
for c in combos:
    if c["modelKey"] in _keys:
        continue
    parts = c["modelKey"].split("|")
    if len(parts) == 4:
        fixed = f'{parts[0]}|{parts[1]}|{re.sub(r"\s*((?:19|20)\d{2})$", "", parts[2]).strip()}|{parts[3]}'
        if fixed in _keys:
            c["modelKey"] = fixed

for c in combos:
    if not c["sourceTitle"]:
        c["sourceTitle"] = _old_combos.get((c["modelKey"], c["cpu"], c["ram"], c["gpu"], c["storage"], c["screen"]), "")

# ---- dedupe combos: same model + same five config fields = one row ----
_groups = {}
for c in combos:
    sig = (c["modelKey"], c["cpu"], c["ram"], c["gpu"], c["storage"], c["screen"])
    _groups.setdefault(sig, []).append(c)
_deduped = []
for sig, rows in _groups.items():
    keep = dict(rows[0])
    if len(rows) > 1:
        extra = []
        for r in rows[1:]:
            if r["sourceUrl"] and r["sourceUrl"] != keep["sourceUrl"]:
                extra.append("补充来源：" + (r["sourceTitle"] or r["sourceUrl"]))
            if r["notes"] and r["notes"] not in keep["notes"]:
                extra.append(r["notes"])
        if extra:
            keep["notes"] = "；".join(x for x in dict.fromkeys([keep["notes"]] + extra) if x)
    _deduped.append(keep)
combos = _deduped
print("combos after dedupe:", len(combos))

out = {"models": models, "combos": combos, "aliases": aliases, "uncertain": uncertain}
(BASE / "_combined" / "sku-normalized.json").write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")

print("\nbys brand/category:", dict(Counter((m["brand"], m["category"]) for m in models)))
print("years:", dict(sorted(Counter(m["modelYear"] for m in models).items())))
print("confidence:", dict(Counter(m["confidence"] for m in models)))
print("no combos models:", sum(1 for m in models if not any(c["modelKey"] == f'{m["productType"]}|{m["brand"]}|{m["model"]}|{m["modelYear"]}' for c in combos)))
