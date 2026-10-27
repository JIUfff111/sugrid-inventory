# SKU 目录（笔记本采购型号资料）

本目录集中存放「溯格」采购系统 SKU 选择器所需的笔记本型号资料。按 **说明 → 交付 → 调研 → 脚本** 分类，不再把所有文件堆在 `docs/` 根目录。

**当前规模**：11 个品牌批次、530 个型号、969 条配置组合，年份覆盖 2016–2026，每条型号均有可追溯来源（无 404 死链）。

## 目录结构

```
docs/sku-catalog/
├─ README.md                    ← 本文件（目录索引与规范）
├─ 00-brief/                    ← 任务说明与规范
│  └─ sku-catalog-research-brief.md
├─ 01-deliverables/             ← 交付文件，按品牌 / 日期分目录
│  ├─ lenovo/2026-10-26/
│  │  ├─ sku-catalog-lenovo-2026-10-26.xlsx
│  │  ├─ sku-models-lenovo-2026-10-26.csv
│  │  ├─ sku-configurations-lenovo-2026-10-26.csv
│  │  └─ README-sku-catalog-lenovo-2026-10-26.md
│  ├─ dell/2026-10-26/
│  │  ├─ sku-catalog-dell-2026-10-26.xlsx
│  │  ├─ sku-models-dell-2026-10-26.csv
│  │  ├─ sku-configurations-dell-2026-10-26.csv
│  │  └─ README-sku-catalog-dell-2026-10-26.md
│  ├─ asus/2026-10-26/
│  │  ├─ sku-catalog-asus-2026-10-26.xlsx
│  │  ├─ sku-models-asus-2026-10-26.csv
│  │  ├─ sku-configurations-asus-2026-10-26.csv
│  │  └─ README-sku-catalog-asus-2026-10-26.md
│  ├─ hp/2026-10-26/
│  │  ├─ sku-catalog-hp-2026-10-26.xlsx
│  │  ├─ sku-models-hp-2026-10-26.csv
│  │  ├─ sku-configurations-hp-2026-10-26.csv
│  │  └─ README-sku-catalog-hp-2026-10-26.md
│  ├─ huawei/2026-10-26/（xlsx + 2 CSV + README）
│  ├─ honor/2026-10-26/（xlsx + 2 CSV + README）
│  ├─ apple/2026-10-26/（xlsx + 2 CSV + README）
│  ├─ acer/2026-10-26/（xlsx + 2 CSV + README）
│  ├─ msi/2026-10-26/（xlsx + 2 CSV + README）
│  ├─ mechrevo/2026-10-26/（xlsx + 2 CSV + README）
│  └─ hasee/2026-10-26/（xlsx + 2 CSV + README）
├─ 02-research/                 ← 原始调研数据，按品牌分目录
│  ├─ lenovo/  (lenovo-thinlight.json、lenovo-gaming.json、url-check-lenovo.json)
│  ├─ dell/    (dell-thinlight.json、dell-gaming.json、url-check-dell.json)
│  ├─ asus/    (asus-thinlight.json、asus-gaming.json、asus-gaming-v2.json、url-check-asus.json)
│  ├─ hp/      (hp-thinlight.json、hp-gaming.json、url-check-hp.json)
│  ├─ huawei/  (huawei-thinlight.json、url-check-huawei.json)
│  ├─ honor/   (honor-thinlight.json、url-check-honor.json)
│  ├─ apple/   (apple-air.json、apple-pro.json、url-check-apple.json)
│  ├─ acer/    (acer-thinlight.json、acer-gaming.json、url-check-acer.json)
│  ├─ msi/     (msi-thinlight.json、msi-gaming.json、url-check-msi.json)
│  ├─ mechrevo/ (mechrevo.json、url-check-mechrevo.json)
│  ├─ hasee/   (hasee.json、url-check-hasee.json)
│  └─ _combined/sku-normalized.json   ← 各品牌合并后的归一化数据（生成物）
```

处理脚本放在项目的 `web/scripts/sku-catalog/`，与既有 `import-laptop-skus.py` 同域：

```
web/scripts/sku-catalog/
├─ normalize_skus.py     ← 合并各品牌 JSON、统一字段、去重
├─ fetch_titles.py       ← 回填缺失的来源标题（抓取页面 <title>）
├─ check_urls.py         ← 批量检查来源链接可访问性
├─ fix_combos.py         ← 组合去重与标题回填（一次性修复工具）
├─ build_deliverable.py  ← 生成 xlsx + CSV（按品牌输出到 01-deliverables）
└─ build_asus_gaming_v2.py ← 华硕游戏本数据补全脚本（一次性）
```

## 命名规范

| 类型 | 命名 | 示例 |
| --- | --- | --- |
| 主工作簿 | `sku-catalog-<brand>-<YYYY-MM-DD>.xlsx` | `sku-catalog-lenovo-2026-10-26.xlsx` |
| 型号 CSV | `sku-models-<brand>-<YYYY-MM-DD>.csv` | `sku-models-dell-2026-10-26.csv` |
| 组合 CSV | `sku-configurations-<brand>-<YYYY-MM-DD>.csv` | `sku-configurations-dell-2026-10-26.csv` |
| 交付说明 | `README-sku-catalog-<brand>-<YYYY-MM-DD>.md` | `README-sku-catalog-lenovo-2026-10-26.md` |
| 调研原始数据 | `<brand>-<thinlight\|gaming>.json` | `lenovo-thinlight.json` |
| 链接检查 | `url-check-<brand>.json` | `url-check-dell.json` |

品牌标识统一用英文小写：`lenovo` / `dell` / `asus` / `rog` / `hp` / `huawei` / `honor` / `apple` / `acer` / `msi` / `mechrevo` / `hasee`。

## 当前进度

| 品牌 | 状态 | 型号 | 组合 | 交付目录 |
| --- | --- | --- | --- | --- |
| 联想（小新 / YOGA / 拯救者） | 已交付 | 90 | 178 | `01-deliverables/lenovo/2026-10-26/` |
| 戴尔 + Alienware | 已交付 | 62 | 97 | `01-deliverables/dell/2026-10-26/` |
| 华硕 + ROG（灵耀 / a豆 / 无畏 / 天选 / ROG） | 已交付 | 60 | 94 | `01-deliverables/asus/2026-10-26/` |
| 惠普（星 / 战66 / 幽灵 / 薄锐 / 星Book Pro / 暗影精灵 / 光影精灵） | 已交付 | 56 | 136 | `01-deliverables/hp/2026-10-26/` |
| 华为（MateBook） | 已交付 | 32 | 85 | `01-deliverables/huawei/2026-10-26/` |
| 荣耀（MagicBook） | 已交付 | 30 | 69 | `01-deliverables/honor/2026-10-26/` |
| 苹果（MacBook Air / Pro） | 已交付 | 37 | 78 | `01-deliverables/apple/2026-10-26/` |
| 宏碁（非凡 / 蜂鸟 / 暗影骑士 / 掠夺者） | 已交付 | 53 | 85 | `01-deliverables/acer/2026-10-26/` |
| 微星（现代 / 尊爵 / 泰坦 / 强袭 / 绝影 / 冲锋坦克 / 武士 / 侠客） | 已交付 | 56 | 75 | `01-deliverables/msi/2026-10-26/` |
| 机械革命（无界 / 蛟龙 / 极光 / 旷世 / 耀世） | 已交付 | 28 | 41 | `01-deliverables/mechrevo/2026-10-26/` |
| 神舟（战神 / 优雅 / 精盾） | 已交付 | 26 | 31 | `01-deliverables/hasee/2026-10-26/` |
| **合计（11 个品牌批次）** | **已交付** | **530** | **969** | 待核实 180 条 |

## 新增一个品牌的流程

1. 调研：把该品牌的轻薄本 / 游戏本数据写成 `02-research/<brand>/<brand>-thinlight.json`、`<brand>-gaming.json`（字段与现有文件一致）。
2. 归一化：`python web/scripts/sku-catalog/normalize_skus.py`（会把该品牌加入合并数据集并去重）。
3. 补标题：`python web/scripts/sku-catalog/fetch_titles.py`（抓取缺失的来源页面标题）。
4. 验链接：`python web/scripts/sku-catalog/check_urls.py "<中文品牌名>" <brand>`。
5. 出交付：`python web/scripts/sku-catalog/build_deliverable.py "<中文品牌名>" "" <brand>`，输出到 `01-deliverables/<brand>/<日期>/`。
6. 写该品牌的 `README-sku-catalog-<brand>-<日期>.md`，并更新本文件的「当前进度」。

## 注意事项

- 工作簿被 Excel / WPS / 预览面板打开时，脚本无法覆盖同名文件（Windows 文件锁）。重新生成前请先关闭该文件。
- 交付文件里的多值字段：Excel 为 JSON 数组文本，CSV 同样为 JSON 数组文本（UTF-8 带 BOM），两者表头一致。
- 价格只是来源标注的首发价 / 参考价，不是采购价；采购价按实物录入。
