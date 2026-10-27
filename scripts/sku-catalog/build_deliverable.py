# -*- coding: utf-8 -*-
"""Build the SKU catalog deliverable (xlsx + csv + README) for one brand."""
import json, re, sys, csv
from pathlib import Path
from collections import Counter, defaultdict
from datetime import date
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

BASE = Path(r"C:\Pro\Zcode\inventory_mvp\web\docs\sku-catalog\02-research")
OUT = Path(r"C:\Pro\Zcode\inventory_mvp\web\docs\sku-catalog\01-deliverables")
brand_arg = sys.argv[1] if len(sys.argv) > 1 else "联想"
brands = brand_arg.split(",")
GROUP = sys.argv[3] if len(sys.argv) > 3 else brand_arg.split(",")[0]
DELIVERY_DATE = "2026-10-26"

data = json.loads((BASE / "_combined" / "sku-normalized.json").read_text(encoding="utf-8"))
_chk = BASE / GROUP / f"url-check-{GROUP}.json"
if not _chk.exists():
    _chk = BASE / f"url-check-{GROUP}.json"
urlcheck = json.loads(_chk.read_text(encoding="utf-8"))

models = [m for m in data["models"] if m["brand"] in brands]

# 接口页/站内搜索页不是稳定引用：换成描述性标题，并单独列入待核实
SRC_DESC = {
    "Api_": "产品参数接口页（建议替换为具体产品页）",
    "/search": "站内搜索页（建议替换为具体产品页）",
}

def is_weak_source(url):
    return "Api_" in url or "/search" in url

for m in models:
    for pat, desc in SRC_DESC.items():
        if pat in m["sourceUrl"]:
            m["sourceTitle"] = f'「{m["model"]} {m["modelYear"]}」{desc}'
keys = {f'{m["productType"]}|{m["brand"]}|{m["model"]}|{m["modelYear"]}' for m in models}
combos = [c for c in data["combos"] if c["modelKey"] in keys]
# 低置信数据不进可导入主表：从主表移除，改为待核实条目
LOW_ENTRIES = []
_low = [m for m in models if m.get("confidence") == "low"]
if _low:
    _low_keys = {f'{m["productType"]}|{m["brand"]}|{m["model"]}|{m["modelYear"]}' for m in _low}
    models = [m for m in models if m.get("confidence") != "low"]
    combos = [c for c in combos if c["modelKey"] not in _low_keys]
    keys = {f'{m["productType"]}|{m["brand"]}|{m["model"]}|{m["modelYear"]}' for m in models}
    for m in _low:
        LOW_ENTRIES.append({"model": f'{m["brand"]} {m["model"]} {m["modelYear"]}',
                            "issue": "置信度 low：来源不足或型号命名/配置存在冲突，未进入可导入主表。",
                            "suggestion": "补充厂商官方规格页或稳定电商 SKU 页后重新核验，再决定是否收录。",
                            "sourceUrl": m["sourceUrl"]})
    print("moved low-confidence models to uncertain:", len(LOW_ENTRIES))

aliases = [a for a in data["aliases"] if a["modelKey"] in keys]
ORIGIN_PREFIX = {"联想": "lenovo", "华硕": "asus", "戴尔": "dell", "Alienware": "dell", "惠普": "hp", "华为": "huawei", "荣耀": "honor", "苹果": "apple", "宏碁": "acer", "微星": "msi", "机械革命": "mechrevo", "神舟": "hasee"}
uncertain = [u for u in data["uncertain"]
             if any(u.get("origin", "").startswith(ORIGIN_PREFIX.get(b, b.lower())) for b in brands)]

CAT_ORDER = {"轻薄本": 0, "游戏本": 1}
models.sort(key=lambda m: (CAT_ORDER.get(m["category"], 9), m["modelYear"] or 0, m["model"]))
key_order = {f'{m["productType"]}|{m["brand"]}|{m["model"]}|{m["modelYear"]}': i for i, m in enumerate(models)}
combos.sort(key=lambda c: (key_order.get(c["modelKey"], 999), c["cpu"], c["ram"]))
alias_seen = set()
uniq_aliases = []
for a in aliases:
    k = (a["alias"], a["modelKey"])
    if k in alias_seen:
        continue
    alias_seen.add(k)
    uniq_aliases.append(a)
uniq_aliases.sort(key=lambda a: (key_order.get(a["modelKey"], 999), a["alias"]))

# downgrade models whose only source is an encyclopedia
for m in models:
    if "baike" in m["sourceUrl"] and m["confidence"] == "high":
        m["confidence"] = "medium"
        if "主来源为百科" not in m["notes"]:
            m["notes"] = (m["notes"] + "；主来源为百科（二手资料），建议用厂商官方页交叉核验").strip("；")

def display(m):
    return f'{m["brand"]} {m["model"]} {m["modelYear"]}'

def source_type(url):
    d = re.sub(r"^https?://", "", url).split("/")[0].lower().removeprefix("www.")
    OFFICIAL = ("lenovo.com.cn", "asus.com.cn", "rog.asus.com.cn", "hp.com", "hpstore.cn",
                "dell.com", "alienware.com", "huawei.com", "vmall.com", "honor.com",
                "hihonor.com", "apple.com", "mi.com", "msi.cn", "msi.com", "mechrevo.com", "hasee.com", "haseecomputer.com", "haseecomputer.net")
    if any(d == x or d.endswith("." + x) for x in OFFICIAL):
        return "厂商官方"
    if "zol.com" in d:
        return "产品库（中关村在线）"
    if "pconline" in d or "yesky" in d or "pchome" in d:
        return "产品库（太平洋/天极/PChome）"
    if "baike" in d:
        return "百科（二手资料）"
    if "jd.com" in d or "tmall.com" in d:
        return "电商页面"
    return "媒体报道"

# ---------- source aggregation ----------
src = {}
def touch(url, title, kind):
    if not url:
        return
    r = src.setdefault(url, {"title": "", "titles": Counter(), "kinds": set(), "count": 0, "date": ""})
    if title:
        r["titles"][title] += 1
    r["kinds"].add(kind)
    r["count"] += 1

for m in models:
    touch(m["sourceUrl"], m["sourceTitle"], "型号")
    if m["checkedAt"] > src[m["sourceUrl"]]["date"]:
        src[m["sourceUrl"]]["date"] = m["checkedAt"]
for c in combos:
    touch(c["sourceUrl"], c["sourceTitle"], "配置组合")

for url, r in src.items():
    r["title"] = r["titles"].most_common(1)[0][0] if r["titles"] else source_type(url) + " 页面"

def access(url):
    r = urlcheck.get(url)
    if not r:
        return "未检查"
    s = r.get("status")
    if s == 200 and ("Api_" in url or "/search" in url):
        return "可访问（接口/搜索页，非稳定引用，建议替换）"
    if s == 200:
        return "可访问（HTTP 200）"
    if 300 <= s < 400:
        return f"可访问（HTTP {s} 重定向）"
    if s in (401, 403, 412, 429):
        return f"可达，反爬拦截（HTTP {s}，需浏览器访问）"
    if s in (404, 410):
        return f"失效（HTTP {s}）"
    if s == 0:
        return "无法访问（" + r.get("error", "网络错误")[:40] + "）"
    return f"HTTP {s}"

# ---------- workbook ----------
wb = Workbook()
THIN = Side(style="thin", color="D9D9D9")
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)
HFILL = PatternFill("solid", fgColor="1F4E79")
HFONT = Font(name="微软雅黑", size=10, bold=True, color="FFFFFF")
BFONT = Font(name="微软雅黑", size=10)
LINKFONT = Font(name="微软雅黑", size=9, color="0563C1", underline="single")
TITLEFONT = Font(name="微软雅黑", size=16, bold=True, color="1F4E79")

def write_sheet(ws, headers, rows, widths, link_cols=(), wrap_cols=(), freeze="B2",
                tab_color=None, center_cols=(), conf_col=None):
    ws.append(headers)
    for c in range(1, len(headers) + 1):
        cell = ws.cell(row=1, column=c)
        cell.fill, cell.font, cell.border = HFILL, HFONT, BORDER
        cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
    ws.row_dimensions[1].height = 34
    for r in rows:
        ws.append(r)
    for i, w in enumerate(widths, 1):
        ws.column_dimensions[get_column_letter(i)].width = w
    for row in ws.iter_rows(min_row=2, max_row=ws.max_row, max_col=len(headers)):
        for cell in row:
            cell.font = BFONT
            cell.border = BORDER
            horizontal = "center" if cell.column in center_cols else "left"
            cell.alignment = Alignment(horizontal=horizontal, vertical="top",
                                       wrap_text=(cell.column in wrap_cols))
            if cell.column in link_cols and isinstance(cell.value, str) and cell.value.startswith("http"):
                cell.hyperlink = cell.value
                cell.font = LINKFONT
                cell.alignment = Alignment(vertical="top")
    # 置信度色标
    if conf_col:
        fills = {"high": PatternFill("solid", fgColor="E2EFDA"),
                 "medium": PatternFill("solid", fgColor="FFF2CC"),
                 "low": PatternFill("solid", fgColor="FCE4E4")}
        for r in range(2, ws.max_row + 1):
            cell = ws.cell(row=r, column=conf_col)
            if cell.value in fills:
                cell.fill = fills[cell.value]
                cell.alignment = Alignment(horizontal="center", vertical="top")
    # 动态行高：按换行列的有效字符长度估算
    for r in range(2, ws.max_row + 1):
        lines = 1
        for c in wrap_cols:
            v = ws.cell(row=r, column=c).value
            if not v:
                continue
            s = str(v)
            eff = sum(2 if ord(ch) > 127 else 1 for ch in s)
            per_line = max(8, widths[c - 1] * 1.05)
            lines = max(lines, min(6, -(-eff // per_line)))
        ws.row_dimensions[r].height = max(20, min(120, 15 * lines + 6))
    ws.freeze_panes = freeze
    ws.auto_filter.ref = f"A1:{get_column_letter(len(headers))}{max(ws.max_row, 1)}"
    if tab_color:
        ws.sheet_properties.tabColor = tab_color

# --- 说明 ---
ws = wb.active
ws.title = "说明"
ws.column_dimensions["A"].width = 22
ws.column_dimensions["B"].width = 96
ws["A1"] = f"{' / '.join(brands)} 笔记本 SKU 型号目录（轻薄本 / 游戏本）"
ws["A1"].font = TITLEFONT
ws.merge_cells("A1:B1")
ws.row_dimensions[1].height = 30

cat_counts = Counter(m["category"] for m in models)
conf_counts = Counter(m["confidence"] for m in models)
year_counts = Counter(m["modelYear"] for m in models)
src_ok = sum(1 for u in src if urlcheck.get(u, {}).get("status") == 200)
src_blocked = sum(1 for u in src if urlcheck.get(u, {}).get("status") in (401, 403, 412, 429))

lines = [
    ("交付日期", f"{DELIVERY_DATE}（型号核验日期见「SKU型号」表的核验日期列）"),
    ("产品类型", "笔记本电脑"),
    ("品牌", " / ".join(brands)),
    ("覆盖分类", f"轻薄本 {cat_counts.get('轻薄本', 0)} 个型号；游戏本 {cat_counts.get('游戏本', 0)} 个型号"),
    ("年份范围", f"{min(year_counts)}–{max(year_counts)}（按上市/机型年份；参考既有 ThinkPad 目录 2016 起的口径）"),
    ("型号数", f"{len(models)} 条（唯一键 产品类型+品牌+型号+年份 无重复）"),
    ("配置组合数", f"{len(combos)} 条（仅收录来源证明确实销售的搭配，未做笛卡尔积）"),
    ("别名数", f"{len(uniq_aliases)} 条"),
    ("来源数", f"{len(src)} 个链接；可正常访问 {src_ok} 个，反爬拦截 {src_blocked} 个"),
    ("置信度分布", "；".join(f"{k} {v}" for k, v in conf_counts.items())),
    ("", ""),
    ("年份口径", "modelYear = 上市/机型年份（四位整数）。不把网页发布日期当型号年份；跨年同名的机型按实际上市时间归年，并在备注说明。"),
    ("型号命名", "model 字段不含年份；显示名 = 品牌 + 型号 + 年份，例如「联想 小新 Pro 16 2024」。"),
    ("配置口径", "各选项字段只收录来源中有依据的容量/型号，未用常见配置补齐；没有证据的留空。"),
    ("组合口径", "「配置组合」每行一个有来源依据的实际销售搭配，通过「型号唯一键」关联主表；未证实的搭配没有臆造。"),
    ("组合去重", "同一型号下 CPU/内存/显卡/存储/屏幕 五项完全相同的记录已合并为一行，重复来源写进备注。"),
    ("置信度规则", "high：厂商官方页 / 产品库规格页 / 电商规格页；medium：媒体报道、百科、系列汇总页；low：进入待核实清单，不混入主表。"),
    ("内存口径", "内存选项统一为容量（如 16GB），来源中的代数/频率标注保留在备注。"),
    ("价格口径", "价格不是必填字段；来源中的首发价/参考价写在「配置组合」备注，仅作参考，不是采购价。"),
    ("导入状态", "不能直接导入正式库：现有 import-laptop-skus.py 只识别旧版 ThinkPad/小米工作簿格式，本文件需先做字段映射与导入预览。"),
    ("未提供参考文件", "交接说明提到的两个参考文件，本次仅找到调研简报本身，另一份未在项目中找到；临时范围为 2016–2026 年该品牌消费级轻薄本与游戏本。"),
]
r = 2
LABELFILL = PatternFill("solid", fgColor="EAF1F8")
for k, v in lines:
    lab = ws.cell(row=r, column=1, value=k)
    lab.font = Font(name="微软雅黑", size=10, bold=True)
    lab.fill = LABELFILL
    lab.alignment = Alignment(vertical="top", wrap_text=True)
    c = ws.cell(row=r, column=2, value=v)
    c.font = BFONT
    c.alignment = Alignment(wrap_text=True, vertical="top")
    eff = sum(2 if ord(ch) > 127 else 1 for ch in str(v))
    lines_needed = max(1, min(3, -(-eff // 95)))
    ws.row_dimensions[r].height = 16 * lines_needed + 8
    r += 1
ws.sheet_properties.tabColor = "808080"

# --- SKU型号 ---
ws = wb.create_sheet("SKU型号")
headers = ["型号唯一键", "产品类型", "品牌", "型号", "型号年份", "显示名", "分类",
           "CPU选项", "内存选项", "显卡选项", "存储选项", "屏幕选项",
           "来源链接", "来源标题", "核验日期", "置信度", "备注"]
rows = []
for m in models:
    rows.append([
        f'{m["productType"]}|{m["brand"]}|{m["model"]}|{m["modelYear"]}',
        m["productType"], m["brand"], m["model"], m["modelYear"], display(m), m["category"],
        json.dumps(m["cpuOptions"], ensure_ascii=False),
        json.dumps(m["ramOptions"], ensure_ascii=False),
        json.dumps(m["gpuOptions"], ensure_ascii=False),
        json.dumps(m["storageOptions"], ensure_ascii=False),
        json.dumps(m["screenOptions"], ensure_ascii=False),
        m["sourceUrl"], m["sourceTitle"], m["checkedAt"], m["confidence"], m["notes"],
    ])
write_sheet(ws, headers, rows,
            [30, 11, 8, 22, 9, 24, 8, 34, 16, 34, 26, 40, 46, 40, 11, 9, 60],
            link_cols=(13,), wrap_cols=(8, 9, 10, 11, 12, 17),
            tab_color="1F4E79", center_cols=(2, 3, 5, 7, 15, 16), conf_col=16)
for i in range(2, ws.max_row + 1):
    ws.cell(row=i, column=5).number_format = "0"

# --- 配置组合 ---
ws = wb.create_sheet("配置组合")
headers = ["组合编号", "型号唯一键", "显示名", "CPU", "内存", "显卡", "存储", "屏幕",
           "来源链接", "来源标题", "置信度", "备注"]
rows = []
for i, c in enumerate(combos, 1):
    m = models[key_order.get(c["modelKey"], 0)] if c["modelKey"] in key_order else None
    rows.append([f"CFG-{i:04d}", c["modelKey"], display(m) if m else "",
                 c["cpu"], c["ram"], c["gpu"], c["storage"], c["screen"],
                 c["sourceUrl"], c["sourceTitle"], c["confidence"], c["notes"]])
write_sheet(ws, headers, rows, [11, 30, 24, 26, 14, 34, 26, 38, 46, 38, 9, 40],
            link_cols=(9,), wrap_cols=(4, 6, 8, 10, 12),
            tab_color="2E75B6", center_cols=(1, 5, 11), conf_col=11)

# --- 别名 ---
ws = wb.create_sheet("别名")
headers = ["别名", "型号唯一键", "显示名", "别名类型", "备注", "来源链接"]
rows = []
for a in uniq_aliases:
    m = models[key_order.get(a["modelKey"], 0)] if a["modelKey"] in key_order else None
    rows.append([a["alias"], a["modelKey"], display(m) if m else "", a["aliasType"],
                 a["note"], a.get("sourceUrl", "")])
write_sheet(ws, headers, rows, [26, 30, 24, 14, 30, 40], link_cols=(6,), wrap_cols=(5,),
            tab_color="548235", center_cols=(4,))

# --- 来源 ---
ws = wb.create_sheet("来源")
headers = ["来源编号", "来源标题", "来源链接", "来源类型", "覆盖字段", "关联记录数", "核验日期", "可访问性结果"]
rows = []
for i, (url, r0) in enumerate(sorted(src.items(), key=lambda kv: (-kv[1]["count"], kv[0])), 1):
    kinds = "、".join(sorted(r0["kinds"]))
    covered = "型号/年份/配置选项" if "型号" in r0["kinds"] else ""
    if "配置组合" in r0["kinds"]:
        covered = (covered + "；具体配置组合").strip("；")
    rows.append([f"SRC-{i:03d}", r0["title"], url, source_type(url), covered,
                 r0["count"], r0["date"] or DELIVERY_DATE, access(url)])
write_sheet(ws, headers, rows, [10, 52, 62, 20, 30, 11, 11, 30], link_cols=(3,), wrap_cols=(2,),
            tab_color="8B5E3C", center_cols=(1, 6, 7))
for i in range(2, ws.max_row + 1):
    ws.cell(row=i, column=6).number_format = "0"

# --- 待核实与缺口 ---
ws = wb.create_sheet("待核实与缺口")
headers = ["序号", "型号", "问题类型", "问题描述", "建议处理", "来源链接"]
def issue_type(text):
    if "冲突" in text or "矛盾" in text:
        return "来源冲突"
    if "年份" in text:
        return "年份不明"
    if "缺" in text or "无" in text or "未" in text:
        return "配置/来源缺口"
    return "需人工确认"
extra = list(LOW_ENTRIES)
no_combo = [m for m in models if not any(c["modelKey"] == f'{m["productType"]}|{m["brand"]}|{m["model"]}|{m["modelYear"]}' for c in combos)]
for m in no_combo:
    extra.append({"model": f'{m["brand"]} {m["model"]} {m["modelYear"]}',
                  "issue": "未检索到有来源依据的具体配置组合，主表仅保留 CPU/内存/显卡等独立选项。",
                  "suggestion": "补充官方规格页或京东自营 SKU 页中的实际搭配后再写入配置组合表。",
                  "sourceUrl": m["sourceUrl"]})
for m in models:
    if is_weak_source(m["sourceUrl"]):
        extra.append({"model": f'{m["brand"]} {m["model"]} {m["modelYear"]}',
                      "issue": "当前主来源为产品库接口页或站内搜索页，不是稳定可引用的产品页，链接可能随站点改版失效。",
                      "suggestion": "替换为该型号的具体产品规格页（ZOL 详情页/厂商官网）后重新核验。",
                      "sourceUrl": m["sourceUrl"]})
rows = []
all_u = uncertain + extra
for i, u in enumerate(all_u, 1):
    rows.append([i, u["model"], issue_type(u["issue"] + u["suggestion"]), u["issue"], u["suggestion"], u.get("sourceUrl", "")])
write_sheet(ws, headers, rows, [7, 30, 14, 70, 55, 46], link_cols=(6,), wrap_cols=(4, 5),
            tab_color="C00000", center_cols=(1, 3))

# --- save xlsx ---
FILE_KEY = {"联想": "lenovo", "华硕": "asus", "ROG": "rog", "戴尔": "dell", "Alienware": "dell"}.get(brands[0], GROUP.lower())
suffix = sys.argv[2] if len(sys.argv) > 2 else ""
DELIV_DIR = OUT / FILE_KEY / DELIVERY_DATE
DELIV_DIR.mkdir(parents=True, exist_ok=True)
xlsx = DELIV_DIR / f"sku-catalog-{FILE_KEY}-{DELIVERY_DATE}{suffix}.xlsx"
wb.save(xlsx)

# --- CSV ---
def dump_csv(path, headers, rows):
    with path.open("w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(headers)
        w.writerows(rows)

m_headers = ["型号唯一键", "产品类型", "品牌", "型号", "型号年份", "显示名", "分类",
             "CPU选项", "内存选项", "显卡选项", "存储选项", "屏幕选项",
             "来源链接", "来源标题", "核验日期", "置信度", "备注"]
m_rows = [[f'{m["productType"]}|{m["brand"]}|{m["model"]}|{m["modelYear"]}', m["productType"], m["brand"],
           m["model"], m["modelYear"], display(m), m["category"],
           json.dumps(m["cpuOptions"], ensure_ascii=False), json.dumps(m["ramOptions"], ensure_ascii=False),
           json.dumps(m["gpuOptions"], ensure_ascii=False), json.dumps(m["storageOptions"], ensure_ascii=False),
           json.dumps(m["screenOptions"], ensure_ascii=False),
           m["sourceUrl"], m["sourceTitle"], m["checkedAt"], m["confidence"], m["notes"]] for m in models]
dump_csv(DELIV_DIR / f"sku-models-{FILE_KEY}-{DELIVERY_DATE}.csv", m_headers, m_rows)

c_headers = ["组合编号", "型号唯一键", "显示名", "CPU", "内存", "显卡", "存储", "屏幕",
             "来源链接", "来源标题", "置信度", "备注"]
c_rows = []
for i, c in enumerate(combos, 1):
    m = models[key_order.get(c["modelKey"], 0)] if c["modelKey"] in key_order else None
    c_rows.append([f"CFG-{i:04d}", c["modelKey"], display(m) if m else "", c["cpu"], c["ram"],
                   c["gpu"], c["storage"], c["screen"], c["sourceUrl"], c["sourceTitle"],
                   c["confidence"], c["notes"]])
dump_csv(DELIV_DIR / f"sku-configurations-{FILE_KEY}-{DELIVERY_DATE}.csv", c_headers, c_rows)

print("xlsx:", xlsx)
print("models", len(models), "combos", len(combos), "aliases", len(uniq_aliases), "sources", len(src), "uncertain", len(all_u))
print("years:", dict(sorted(year_counts.items())))
print("conf:", dict(conf_counts))
