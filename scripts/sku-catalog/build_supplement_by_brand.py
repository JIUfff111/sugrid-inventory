# -*- coding: utf-8 -*-
"""把 11-03 这一批补充新增的 SKU 按品牌拆成独立交付件。

判定「新增」的方式：拿 `_backup-2026-11-03/` 里的补充前快照做基线，
当前品牌 JSON 中不在基线里的型号 / 配置组合即本次补充新增。

用法（在 sku-catalog/ 目录下）：
    python ../../scripts/sku-catalog/build_supplement_by_brand.py

输出：03-supplements/gapfill-2026-11-03/
      ├─ sku-catalog-gapfill-2026-11-03-汇总.xlsx     ← 全部补充合并
      ├─ README-sku-catalog-gapfill-2026-11-03.md
      └─ 分品牌/<slug>/  sku-catalog-<slug>-supplement-2026-11-03.xlsx + 2 CSV
"""
import csv
import json
import os
import re
from collections import Counter

import openpyxl
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

BASE = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ROOT = os.path.join(BASE, "docs", "sku-catalog")
RESEARCH = os.path.join(ROOT, "02-research")
BACKUP = os.path.join(ROOT, "_backup-2026-11-03")
OUT = os.path.join(ROOT, "03-supplements", "gapfill-2026-11-03")
DATE = "2026-11-03"

# 本次补充的 5 个品牌组：(slug, 品牌线展示名, 主题, [(调研文件, 是否全新)])
SUPPLEMENTS = [
    ("lenovo-thinkpad", "联想 / ThinkPad", "ThinkPad 全系 98 个型号接入（PSREF 官方 MTM 配置表）",
     [("lenovo/lenovo-thinkpad.json", True)]),
    ("asus-tianxuan", "华硕 / ROG", "天选系列 6 个空配置型号补齐",
     [("asus/asus-gaming-v2.json", False)]),
    ("xiaomi-redmi", "小米 / 红米", "小米 / 红米配置变体补齐 + 红米锐龙版 2 个型号补录",
     [("xiaomi/xiaomi-thinlight.json", False), ("xiaomi/redmi-thinlight.json", False)]),
    ("acer-predator", "宏碁", "掠夺者 / 暗影骑士官方规格配置补录",
     [("acer/acer-gaming.json", False)]),
    ("mechrevo", "机械革命", "耀世 18 Pro 配置补录",
     [("mechrevo/mechrevo.json", False)]),
]

# ---- 与 normalize_skus.py 保持一致的字段口径，保证补充件与主交付件逐行可对 ----
YEAR_TAIL = re.compile(r"[\s\-_]*((?:19|20)\d{2})\s*$")


def spaced(s):
    s = (s or "").replace("\u3000", " ").replace("\xa0", " ")
    return re.sub(r"\s+", " ", s).strip()


def norm_model(model, year):
    m = spaced(model)
    hit = YEAR_TAIL.search(m)
    if hit and year and int(hit.group(1)) == year:
        m = YEAR_TAIL.sub("", m).strip()
    return m


def norm_ram(values):
    out = []
    for v in values or []:
        v = spaced(str(v))
        if not v:
            continue
        m = re.match(r"^(\d+)\s*GB\b(.*)$", v, re.I)
        cap = f"{int(m.group(1))}GB" if m else v
        if cap not in out:
            out.append(cap)
    return out


def norm_gpu_list(values):
    out = []
    for v in values or []:
        if isinstance(v, dict):
            t = str(v.get("type", ""))
            val = "集成显卡" if ("集成" in t or "核显" in t) else spaced(v.get("name", ""))
        else:
            val = spaced(str(v))
            if val in ("集显", "核芯显卡", "集成显卡（核显）"):
                val = "集成显卡"
        if val and val not in out:
            out.append(val)
    return out


def norm_list(values):
    out = []
    for v in values or []:
        val = spaced(str(v))
        if val and val not in out:
            out.append(val)
    return out


def norm_model_rec(m):
    y = m.get("modelYear")
    if isinstance(y, str):
        mm = re.search(r"((?:19|20)\d{2})", y)
        y = int(mm.group(1)) if mm else None
    return dict(
        productType=m.get("productType") or "笔记本电脑",
        brand=spaced(m.get("brand", "")),
        model=norm_model(m.get("model", ""), y),
        modelYear=y,
        category=m.get("category", ""),
        cpuOptions=norm_list(m.get("cpuOptions")),
        ramOptions=norm_ram(m.get("ramOptions")),
        gpuOptions=norm_gpu_list(m.get("gpuOptions")),
        storageOptions=norm_list(m.get("storageOptions")),
        screenOptions=norm_list(m.get("screenOptions")),
        sourceUrl=m.get("sourceUrl", ""),
        sourceTitle=spaced(m.get("sourceTitle", "")),
        checkedAt=m.get("checkedAt") or DATE,
        confidence=m.get("confidence", ""),
        notes=spaced(m.get("notes", "")),
    )


def norm_combo_rec(c):
    mk = c.get("modelKey", "")
    parts = mk.split("|")
    gpu = spaced(c.get("gpu", ""))
    return dict(
        modelKey=mk,
        brand=parts[1] if len(parts) > 1 else "",
        model=parts[2] if len(parts) > 2 else "",
        modelYear=parts[3] if len(parts) > 3 else "",
        cpu=spaced(c.get("cpu", "")),
        ram=spaced(c.get("ram", "")),
        gpu="集成显卡" if gpu.startswith("集成") else gpu,
        storage=spaced(c.get("storage", "")),
        screen=spaced(c.get("screen", "")),
        sourceUrl=c.get("sourceUrl", ""),
        sourceTitle=spaced(c.get("sourceTitle", "")),
        confidence=c.get("confidence", ""),
        notes=spaced(c.get("notes", "")),
    )


def mkey(m):
    return "%s|%s|%s|%s" % (m["productType"], m["brand"], m["model"], m["modelYear"])


def quint(c):
    return (c["modelKey"], c["cpu"], c["ram"], c["gpu"], c["storage"], c["screen"])


HDR_FILL = PatternFill("solid", fgColor="1F4E79")
HDR_FONT = Font(name="微软雅黑", size=10, bold=True, color="FFFFFF")
BODY_FONT = Font(name="微软雅黑", size=10)
THIN = Side(style="thin", color="BFBFBF")
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)

M_FIELDS = ["型号唯一键", "产品类型", "品牌", "型号", "型号年份", "显示名", "分类",
            "CPU选项", "内存选项", "显卡选项", "存储选项", "屏幕选项",
            "来源链接", "来源标题", "核验日期", "置信度", "备注"]
C_FIELDS = ["组合编号", "型号唯一键", "显示名", "CPU", "内存", "显卡", "存储", "屏幕",
            "来源链接", "来源标题", "置信度", "备注"]


def load(p):
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def disp(m):
    return " ".join(str(x) for x in [m.get("brand", ""), m.get("model", ""), m.get("modelYear", "")] if x)


def write_sheet(ws, header, rows, widths, freeze="B2"):
    ws.append(header)
    for i, w in enumerate(widths, start=1):
        ws.column_dimensions[get_column_letter(i)].width = w
    for c in ws[1]:
        c.fill = HDR_FILL
        c.font = HDR_FONT
        c.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
        c.border = BORDER
    ws.row_dimensions[1].height = 34
    for r in rows:
        ws.append(r)
    for row in ws.iter_rows(min_row=2, max_row=ws.max_row, max_col=len(header)):
        for c in row:
            c.font = BODY_FONT
            c.alignment = Alignment(vertical="top", wrap_text=True)
            c.border = BORDER
    ws.freeze_panes = freeze
    ws.auto_filter.ref = "A1:%s%d" % (get_column_letter(len(header)), ws.max_row)


def diff_one(rel, is_new):
    """返回 (新增型号, 新增配置, 新增待核实)，均已按主交付件口径归一化。"""
    cur = load(os.path.join(RESEARCH, rel))
    if is_new:
        old = {}
    else:
        bp = os.path.join(BACKUP, "%s__%s" % (rel.split("/")[0], rel.split("/")[1]))
        old = load(bp) if os.path.exists(bp) else {}

    old_models = [norm_model_rec(m) for m in old.get("models", [])]
    old_keys = {mkey(m) for m in old_models}
    old_q = {quint(norm_combo_rec(c)) for c in old.get("configCombos", [])}
    old_u = {(spaced(u.get("model", "")), spaced(u.get("issue", ""))) for u in old.get("uncertain", [])}

    new_models = []
    for m in cur.get("models", []):
        rec = norm_model_rec(m)
        if mkey(rec) not in old_keys:
            new_models.append(rec)

    new_combos, seen = [], set()
    for c in cur.get("configCombos", []):
        rec = norm_combo_rec(c)
        q = quint(rec)
        if q in old_q or q in seen:
            continue
        seen.add(q)
        new_combos.append(rec)

    new_unc = []
    for u in cur.get("uncertain", []):
        sig = (spaced(u.get("model", "")), spaced(u.get("issue", "")))
        if sig in old_u:
            continue
        new_unc.append(dict(model=spaced(u.get("model", "")), issue=spaced(u.get("issue", "")),
                            suggestion=spaced(u.get("suggestion", "")), sourceUrl=u.get("sourceUrl", "")))
    return new_models, new_combos, new_unc


def build_group(slug, label, topic, files):
    models, combos, unc = [], [], []
    for rel, is_new in files:
        m, c, u = diff_one(rel, is_new)
        models.extend(m)
        combos.extend(c)
        unc.extend(u)

    # 跨文件再按唯一键 / 五元组去重
    seen_m, mm = set(), []
    for m in models:
        if mkey(m) not in seen_m:
            seen_m.add(mkey(m))
            mm.append(m)
    models = mm
    seen_c, cc = set(), []
    for c in combos:
        if quint(c) not in seen_c:
            seen_c.add(quint(c))
            cc.append(c)
    combos = sorted(cc, key=lambda c: (c["modelKey"], c["cpu"], c["storage"], c["screen"]))

    m_rows = []
    for m in sorted(models, key=lambda x: (str(x["model"]), str(x["modelYear"]))):
        m_rows.append([
            mkey(m), m["productType"], m["brand"], m["model"], m["modelYear"] or "", disp(m), m["category"],
            json.dumps(m["cpuOptions"], ensure_ascii=False),
            json.dumps(m["ramOptions"], ensure_ascii=False),
            json.dumps(m["gpuOptions"], ensure_ascii=False),
            json.dumps(m["storageOptions"], ensure_ascii=False),
            json.dumps(m["screenOptions"], ensure_ascii=False),
            m["sourceUrl"], m["sourceTitle"], m["checkedAt"], m["confidence"], m["notes"],
        ])

    c_rows = []
    for i, c in enumerate(combos, start=1):
        c_rows.append([
            "SUP-%04d" % i, c["modelKey"], disp(c),
            c["cpu"], c["ram"], c["gpu"], c["storage"], c["screen"],
            c["sourceUrl"], c["sourceTitle"], c["confidence"], c["notes"],
        ])

    u_rows = [[i, u["model"], u["issue"], u["suggestion"], u["sourceUrl"]]
              for i, u in enumerate(unc, start=1)]

    return dict(slug=slug, label=label, topic=topic, models=m_rows, combos=c_rows,
                unc=u_rows)


def write_group(g, outdir):
    os.makedirs(outdir, exist_ok=True)
    base = "supplement-%s" % DATE
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "说明"
    ws.column_dimensions["A"].width = 16
    ws.column_dimensions["B"].width = 100
    rows = [
        ("", ""),
        ("补充主题", g["topic"]),
        ("补充日期", DATE),
        ("品牌线", g["label"]),
        ("新增型号", "%d 条" % len(g["models"])),
        ("新增配置组合", "%d 条" % len(g["combos"])),
        ("新增待核实", "%d 条" % len(g["unc"])),
        ("", ""),
        ("本文件范围", "只含 11-03 这一批补充新增的记录，不含该品牌原有型号。完整型号清单见 01-deliverables/%s/ 或全品牌汇总。" % g["slug"].split("-")[0]),
        ("增量判定", "以 _backup-2026-11-03/ 的补充前快照为基线，当前调研文件中不在基线内的型号与配置组合即为新增。"),
        ("配置去重", "同一型号下 CPU/内存/显卡/存储/屏幕 五项完全相同只保留一条。"),
        ("置信度规则", "high：厂商官方页 / PSREF 产品页 / 产品库规格页；medium：媒体报道、百科、系列汇总页。"),
        ("如何并入", "这些记录已并入各品牌主交付件（01-deliverables/<brand>/<date>/），本目录是补充过程的独立存档，便于单独核对该批次做了什么。"),
    ]
    for r in rows:
        ws.append(list(r))
    ws["A1"] = "SKU 补充件 · %s · %s" % (g["label"], DATE)
    ws["A1"].font = Font(name="微软雅黑", size=14, bold=True, color="1F4E79")
    ws.merge_cells("A1:B1")
    for r in range(2, ws.max_row + 1):
        a, b = ws.cell(r, 1), ws.cell(r, 2)
        a.font = Font(name="微软雅黑", size=10, bold=True, color="1F4E79")
        b.font = BODY_FONT
        a.alignment = Alignment(vertical="top")
        b.alignment = Alignment(vertical="top", wrap_text=True)

    write_sheet(wb.create_sheet("新增型号"), M_FIELDS, g["models"],
                [34, 11, 10, 26, 9, 30, 9, 40, 22, 26, 30, 40, 46, 46, 11, 9, 60])
    write_sheet(wb.create_sheet("新增配置组合"), C_FIELDS, g["combos"],
                [11, 34, 30, 26, 9, 28, 16, 26, 46, 46, 9, 52])
    if g["unc"]:
        write_sheet(wb.create_sheet("新增待核实"), ["序号", "型号", "问题类型", "建议处理", "来源链接"],
                    g["unc"], [7, 30, 14, 60, 40])

    xlsx = os.path.join(outdir, "sku-catalog-%s-%s.xlsx" % (g["slug"], base))
    wb.save(xlsx)

    with open(os.path.join(outdir, "sku-models-%s-%s.csv" % (g["slug"], base)),
              "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(M_FIELDS)
        w.writerows(g["models"])
    with open(os.path.join(outdir, "sku-configurations-%s-%s.csv" % (g["slug"], base)),
              "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(C_FIELDS)
        w.writerows(g["combos"])
    return xlsx


def main():
    os.makedirs(OUT, exist_ok=True)
    groups = []
    for slug, label, topic, files in SUPPLEMENTS:
        g = build_group(slug, label, topic, files)
        outdir = os.path.join(OUT, "分品牌", slug)
        write_group(g, outdir)
        groups.append(g)
        print("%-18s 型号 %3d  配置 %4d  待核实 %2d  → 分品牌/%s/"
              % (label, len(g["models"]), len(g["combos"]), len(g["unc"]), slug))

    # ---- 汇总表 ----
    all_m, all_c, all_u = [], [], []
    for g in groups:
        all_m.extend(g["models"])
        all_c.extend(g["combos"])
        for r in g["unc"]:
            all_u.append([g["label"]] + list(r[1:]))

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "说明"
    ws.column_dimensions["A"].width = 16
    ws.column_dimensions["B"].width = 100
    tot_m = sum(len(g["models"]) for g in groups)
    tot_c = sum(len(g["combos"]) for g in groups)
    tot_u = sum(len(g["unc"]) for g in groups)
    for r in [("", ""),
              ("补充批次", "2026-11-03 重点系列补充（天选 / 小米 / 红米 / ThinkPad 优先）"),
              ("补充日期", DATE),
              ("覆盖品牌线", "、".join(g["label"] for g in groups)),
              ("新增型号合计", "%d 条" % tot_m),
              ("新增配置组合合计", "%d 条" % tot_c),
              ("新增待核实合计", "%d 条" % tot_u),
              ("", ""),
              ("本文件范围", "只含本批次补充新增的记录；各品牌原有型号不在此列，完整清单见 01-deliverables/ 各品牌目录。"),
              ("分品牌文件", "见同目录 分品牌/<slug>/，每个品牌一份 xlsx + 2 份 CSV。"),
              ("增量判定", "以 _backup-2026-11-03/ 的补充前快照为基线做 diff，可复现、可核对。"),
              ("已并入主表", "是。各品牌主交付件已包含这些记录，本目录是补充过程的独立存档与交付凭证。"),
              ("口径", "型号唯一键＝产品类型|品牌|型号|年份；配置按 CPU/内存/显卡/存储/屏幕 五元组去重；置信度 high 为官方页/规格页。")]:
        ws.append(list(r))
    ws["A1"] = "SKU 补充件汇总 · 2026-11-03"
    ws["A1"].font = Font(name="微软雅黑", size=14, bold=True, color="1F4E79")
    ws.merge_cells("A1:B1")
    for r in range(2, ws.max_row + 1):
        a, b = ws.cell(r, 1), ws.cell(r, 2)
        a.font = Font(name="微软雅黑", size=10, bold=True, color="1F4E79")
        b.font = BODY_FONT
        a.alignment = Alignment(vertical="top")
        b.alignment = Alignment(vertical="top", wrap_text=True)

    stat = [["品牌线", "补充主题", "新增型号", "新增配置组合", "新增待核实", "分品牌目录"]]
    for g in groups:
        stat.append([g["label"], g["topic"], len(g["models"]), len(g["combos"]),
                     len(g["unc"]), "分品牌/%s/" % g["slug"]])
    stat.append(["合计", "", tot_m, tot_c, tot_u, ""])
    ws2 = wb.create_sheet("品牌统计")
    write_sheet(ws2, stat[0], stat[1:], [18, 52, 10, 12, 12, 26], freeze="A2")
    for c in ws2[ws2.max_row]:
        c.font = Font(name="微软雅黑", size=10, bold=True)

    write_sheet(wb.create_sheet("新增型号"), M_FIELDS, all_m,
                [34, 11, 10, 26, 9, 30, 9, 40, 22, 26, 30, 40, 46, 46, 11, 9, 60])
    write_sheet(wb.create_sheet("新增配置组合"), C_FIELDS, all_c,
                [11, 34, 30, 26, 9, 28, 16, 26, 46, 46, 9, 52])
    write_sheet(wb.create_sheet("新增待核实"), ["品牌线", "型号", "问题类型", "建议处理", "来源链接"],
                all_u, [18, 30, 14, 60, 40], freeze="B2")

    xlsx = os.path.join(OUT, "sku-catalog-gapfill-%s-汇总.xlsx" % DATE)
    wb.save(xlsx)

    print("\n=== 汇总 ===")
    print("新增型号 %d / 新增配置 %d / 新增待核实 %d" % (tot_m, tot_c, tot_u))
    print("输出:", OUT)


if __name__ == "__main__":
    main()
