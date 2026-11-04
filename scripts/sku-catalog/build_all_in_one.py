# -*- coding: utf-8 -*-
"""把 01-deliverables/ 下各品牌交付件汇总成一份全品牌总表 + 全品牌 CSV。

用法（在 sku-catalog/ 目录下）：
    python ../../../scripts/sku-catalog/build_all_in_one.py

输入：01-deliverables/<brand>/<最新日期>/sku-models-*.csv、sku-configurations-*.csv
      02-research/_combined/sku-normalized.json（别名、待核实）
输出：01-deliverables/_交付汇总-2026-11-03/
      ├── sku-catalog-全品牌-2026-11-03.xlsx
      ├── sku-models-全品牌-2026-11-03.csv
      └── sku-configurations-全品牌-2026-11-03.csv
"""
import csv
import glob
import json
import os
import re
from collections import Counter, OrderedDict

import openpyxl
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

BASE = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ROOT = os.path.join(BASE, "docs", "sku-catalog")
DELIV = os.path.join(ROOT, "01-deliverables")
OUT_NAME = "_交付汇总-2026-11-03"
OUT = os.path.join(DELIV, OUT_NAME)
DELIVERY_DATE = "2026-11-03"

# 品牌线展示顺序（按规模与业务优先级）
BRAND_ORDER = [
    "联想", "ThinkPad", "华硕", "ROG", "小米", "红米", "宏碁", "机械革命",
    "戴尔", "微星", "惠普", "苹果", "华为", "荣耀", "神舟", "Alienware",
]

# 交付目录名 → 品牌线展示名
ORIGIN_BRAND = {
    "lenovo": "联想 / ThinkPad",
    "asus": "华硕 / ROG",
    "xiaomi": "小米 / 红米",
    "acer": "宏碁",
    "mechrevo": "机械革命",
    "dell": "戴尔 / Alienware",
    "msi": "微星",
    "hp": "惠普",
    "apple": "苹果",
    "huawei": "华为",
    "honor": "荣耀",
    "hasee": "神舟",
}

HDR_FILL = PatternFill("solid", fgColor="1F4E79")
HDR_FONT = Font(name="微软雅黑", size=10, bold=True, color="FFFFFF")
BODY_FONT = Font(name="微软雅黑", size=10)
THIN = Side(style="thin", color="BFBFBF")
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)


def read_csv(path):
    with open(path, encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def latest_dirs():
    """每个品牌目录取日期最新的那份交付件。"""
    picked = []
    for brand_dir in sorted(os.listdir(DELIV)):
        dpath = os.path.join(DELIV, brand_dir)
        if not os.path.isdir(dpath) or brand_dir.startswith("_") or brand_dir.startswith("config-"):
            continue
        dates = [d for d in os.listdir(dpath) if re.match(r"^\d{4}-\d{2}-\d{2}$", d)]
        if not dates:
            continue
        picked.append((brand_dir, max(dates)))
    return picked


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


def main():
    os.makedirs(OUT, exist_ok=True)
    os.makedirs(os.path.join(OUT, "分品牌"), exist_ok=True)

    # ---------- 1. 汇总各品牌 CSV ----------
    models, combos, srcs = OrderedDict(), [], set()
    picked_info = []
    for brand_dir, date in latest_dirs():
        mpath = os.path.join(DELIV, brand_dir, date, "sku-models-%s-%s.csv" % (brand_dir, date))
        cpath = os.path.join(DELIV, brand_dir, date, "sku-configurations-%s-%s.csv" % (brand_dir, date))
        if not (os.path.exists(mpath) and os.path.exists(cpath)):
            print("跳过（缺文件）:", brand_dir, date)
            continue
        ms = read_csv(mpath)
        cs = read_csv(cpath)
        added_m = 0
        for m in ms:
            k = m["型号唯一键"]
            if k not in models:
                models[k] = m
                added_m += 1
        combos.extend(cs)
        picked_info.append((brand_dir, date, len(ms), len(cs), added_m))
        print("%-10s %s  型号 %3d（新增 %3d）  配置 %4d" % (brand_dir, date, len(ms), added_m, len(cs)))

    # ---------- 2. 排序 ----------
    border_rank = {b: i for i, b in enumerate(BRAND_ORDER)}

    def mkey(m):
        return (border_rank.get(m["品牌"], 99), m["品牌"], m["型号"], str(m["型号年份"]))

    models_sorted = sorted(models.values(), key=mkey)
    order = {m["型号唯一键"]: i for i, m in enumerate(models_sorted)}

    # 配置去重（同型号五元组）
    seen, combos_u = set(), []
    for c in combos:
        sig = (c["型号唯一键"], c["CPU"], c["内存"], c["显卡"], c["存储"], c["屏幕"])
        if sig in seen:
            continue
        seen.add(sig)
        combos_u.append(c)
    combos_u.sort(key=lambda c: (order.get(c["型号唯一键"], 99999), c["CPU"], c["内存"], c["存储"], c["屏幕"]))

    # ---------- 3. 全品牌 CSV ----------
    m_fields = ["型号唯一键", "产品类型", "品牌", "型号", "型号年份", "显示名", "分类",
                "CPU选项", "内存选项", "显卡选项", "存储选项", "屏幕选项",
                "来源链接", "来源标题", "核验日期", "置信度", "备注"]
    models_csv = os.path.join(OUT, "sku-models-全品牌-%s.csv" % DELIVERY_DATE)
    with open(models_csv, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=m_fields, extrasaction="ignore")
        w.writeheader()
        for m in models_sorted:
            w.writerow(m)

    c_fields = ["组合编号", "型号唯一键", "品牌", "显示名", "CPU", "内存", "显卡", "存储", "屏幕",
                "来源链接", "来源标题", "置信度", "备注"]
    combos_csv = os.path.join(OUT, "sku-configurations-全品牌-%s.csv" % DELIVERY_DATE)
    combo_rows = []
    with open(combos_csv, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=c_fields, extrasaction="ignore")
        w.writeheader()
        for i, c in enumerate(combos_u, start=1):
            row = dict(c)
            row["组合编号"] = "CFG-%04d" % i
            row["品牌"] = c["型号唯一键"].split("|")[1]
            w.writerow(row)
            combo_rows.append(row)

    # ---------- 4. 别名 / 待核实（直接取各品牌工作簿，保证与单品牌交付件一致） ----------
    alias_rows, unc_rows = [], []
    seen_alias, seen_unc = set(), set()
    for brand_dir, date, _, _, _ in picked_info:
        p = os.path.join(DELIV, brand_dir, date, "sku-catalog-%s-%s.xlsx" % (brand_dir, date))
        if not os.path.exists(p):
            continue
        label = ORIGIN_BRAND.get(brand_dir, brand_dir)
        wb = openpyxl.load_workbook(p, read_only=True, data_only=True)
        if "别名" in wb.sheetnames:
            for r in wb["别名"].iter_rows(min_row=2, values_only=True):
                if not r or not r[0]:
                    continue
                sig = (r[0], r[1])
                if sig in seen_alias:
                    continue
                seen_alias.add(sig)
                alias_rows.append([x or "" for x in (list(r) + [""] * 6)[:6]])
        for name in wb.sheetnames:
            if "待核实" not in name:
                continue
            for r in wb[name].iter_rows(min_row=2, values_only=True):
                if not r or not r[1]:
                    continue
                # 品牌工作簿列：序号 / 型号 / 问题类型 / 问题描述 / 建议处理 / 来源链接
                v = (list(r) + [""] * 6)[:6]
                sig = (v[1], v[3])
                if sig in seen_unc:
                    continue
                seen_unc.add(sig)
                unc_rows.append([label, v[1] or "", v[2] or "", v[3] or "",
                                 v[4] or "", v[5] or "", "%s/%s" % (brand_dir, date)])
        wb.close()
    for i, r in enumerate(unc_rows, start=1):
        r.insert(0, i)

    # ---------- 5. 统计 ----------
    by_brand_m = Counter(m["品牌"] for m in models_sorted)
    by_brand_c = Counter(c["品牌"] for c in combo_rows)
    conf_m = Counter(m["置信度"] for m in models_sorted)
    conf_c = Counter(c["置信度"] for c in combo_rows)
    for m in models_sorted:
        if m.get("来源链接"):
            srcs.add(m["来源链接"])
    for c in combo_rows:
        if c.get("来源链接"):
            srcs.add(c["来源链接"])

    stat_rows = []
    for b in BRAND_ORDER:
        if not by_brand_m.get(b):
            continue
        ms = [m for m in models_sorted if m["品牌"] == b]
        cs = [c for c in combo_rows if c["品牌"] == b]
        stat_rows.append([
            b,
            "笔记本电脑",
            len(ms),
            len(cs),
            sum(1 for x in ms if x["置信度"] == "high"),
            sum(1 for x in ms if x["置信度"] == "medium"),
            sum(1 for x in ms if x["置信度"] == "low"),
            len({x["来源链接"] for x in ms if x.get("来源链接")}) or len({x["来源链接"] for x in cs if x.get("来源链接")}),
        ])
    stat_rows.append(["合计", "笔记本电脑", len(models_sorted), len(combo_rows),
                      sum(1 for x in models_sorted if x["置信度"] == "high"),
                      sum(1 for x in models_sorted if x["置信度"] == "medium"),
                      sum(1 for x in models_sorted if x["置信度"] == "low"), len(srcs)])

    years = [int(m["型号年份"]) for m in models_sorted if str(m["型号年份"]).isdigit()]
    cats = Counter(m["分类"] for m in models_sorted)
    cat_txt = "；".join("%s %d 个" % (k, v) for k, v in cats.most_common())

    # ---------- 6. 生成 xlsx ----------
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "说明"
    ws.column_dimensions["A"].width = 16
    ws.column_dimensions["B"].width = 110
    info = [
        ("", ""),
        ("交付日期", DELIVERY_DATE + "（逐条核验日期见「SKU型号」表的核验日期列）"),
        ("产品类型", "笔记本电脑（消费级轻薄本 / 游戏本 / 商务本）"),
        ("品牌线数", "%d 个：%s" % (len(stat_rows) - 1, "、".join(r[0] for r in stat_rows[:-1]))),
        ("覆盖分类", cat_txt),
        ("年份范围", "%d–%d" % (min(years), max(years)) if years else ""),
        ("型号数", "%d 条（唯一键 产品类型+品牌+型号+年份，无重复）" % len(models_sorted)),
        ("配置组合数", "%d 条（仅收录来源证明确实销售的搭配，未做笛卡尔积）" % len(combo_rows)),
        ("别名数", "%d 条" % len(alias_rows)),
        ("来源数", "%d 个去重链接" % len(srcs)),
        ("置信度分布（型号）", " / ".join("%s %d" % (k, v) for k, v in conf_m.most_common())),
        ("置信度分布（配置）", " / ".join("%s %d" % (k, v) for k, v in conf_c.most_common())),
        ("待核实条目", "%d 条（见「待核实与缺口」表，未混入主表）" % len(unc_rows)),
        ("", ""),
        ("本文件定位", "全品牌合集，用于横向比价与一次性查阅；单品牌正式交付件仍保留在 01-deliverables/<品牌>/<日期>/ 下，内容与合集逐行一致。"),
        ("本次合并日期", "各品牌选取其最新一版交付件：小米取 2026-11-01（与 2026-10-26 版内容逐行相同），其余品牌取 2026-10-26。"),
        ("年份口径", "modelYear = 上市/机型年份（四位整数）。不把网页发布日期当型号年份；跨年同名的机型按实际上市时间归年，并在备注说明。"),
        ("型号命名", "model 字段不含年份；显示名 = 品牌 + 型号 + 年份，例如「联想 小新 Pro 16 2024」。"),
        ("配置口径", "各选项字段只收录来源中有依据的容量/型号，未用常见配置补齐；没有证据的留空。"),
        ("组合口径", "「配置组合」每行一个有来源依据的实际销售搭配，通过「型号唯一键」关联主表；未证实的搭配没有臆造。"),
        ("组合去重", "同一型号下 CPU/内存/显卡/存储/屏幕 五项完全相同的记录已合并为一行，重复来源写进备注。"),
        ("置信度规则", "high：厂商官方页 / 产品库规格页 / 电商规格页；medium：媒体报道、百科、系列汇总页；low：进入待核实清单，不混入主表。"),
        ("内存口径", "内存选项统一为容量（如 16GB），来源中的代数/频率标注保留在备注。"),
        ("价格口径", "价格不是必填字段；来源中的首发价/参考价写在「配置组合」备注，仅作参考，不是采购价。"),
        ("导入状态", "不能直接导入正式库：现有 import-laptop-skus.py 只识别旧版 ThinkPad/小米工作簿格式，本文件需先做字段映射与导入预览。"),
    ]
    for k, v in info:
        ws.append([k, v])
    ws["A1"] = "溯格 · 笔记本 SKU 目录 全品牌交付件"
    ws["A1"].font = Font(name="微软雅黑", size=14, bold=True, color="1F4E79")
    ws.merge_cells("A1:B1")
    for r in range(2, ws.max_row + 1):
        a, b = ws.cell(r, 1), ws.cell(r, 2)
        a.font = Font(name="微软雅黑", size=10, bold=True, color="1F4E79")
        b.font = BODY_FONT
        a.alignment = Alignment(vertical="top")
        b.alignment = Alignment(vertical="top", wrap_text=True)

    ws2 = wb.create_sheet("品牌统计")
    write_sheet(ws2,
                ["品牌线", "产品类型", "型号数", "配置组合数", "high", "medium", "low", "来源链接数"],
                stat_rows, [16, 12, 10, 12, 9, 10, 8, 12], freeze="A2")
    for c in ws2[ws2.max_row]:
        c.font = Font(name="微软雅黑", size=10, bold=True)

    ws3 = wb.create_sheet("SKU型号")
    write_sheet(ws3, m_fields, [[m.get(k, "") for k in m_fields] for m in models_sorted],
                [34, 11, 10, 24, 9, 30, 9, 40, 22, 26, 30, 40, 46, 46, 11, 9, 60])

    ws4 = wb.create_sheet("配置组合")
    write_sheet(ws4, c_fields, [[c.get(k, "") for k in c_fields] for c in combo_rows],
                [11, 34, 10, 30, 26, 9, 28, 16, 26, 46, 46, 9, 52])

    ws5 = wb.create_sheet("别名")
    write_sheet(ws5, ["别名", "型号唯一键", "显示名", "别名类型", "备注", "来源链接"],
                alias_rows, [30, 34, 30, 12, 24, 46])

    ws6 = wb.create_sheet("待核实与缺口")
    write_sheet(ws6, ["序号", "品牌线", "型号", "问题类型", "问题描述", "建议处理", "来源链接", "来源文件"],
                unc_rows, [7, 18, 30, 12, 60, 60, 40, 34], freeze="C2")

    xlsx = os.path.join(OUT, "sku-catalog-全品牌-%s.xlsx" % DELIVERY_DATE)
    wb.save(xlsx)

    print("\n=== 汇总完成 ===")
    print("型号 %d / 配置 %d / 别名 %d / 待核实 %d / 来源 %d"
          % (len(models_sorted), len(combo_rows), len(alias_rows), len(unc_rows), len(srcs)))
    print("品牌分布:", dict(by_brand_m))
    print("输出:", xlsx)


if __name__ == "__main__":
    main()
