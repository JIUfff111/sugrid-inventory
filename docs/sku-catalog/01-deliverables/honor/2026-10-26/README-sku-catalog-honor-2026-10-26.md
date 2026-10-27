# 荣耀笔记本 SKU 目录交付说明（MagicBook 轻薄本）

- 交付日期：2026-10-26
- 产品类型：笔记本电脑
- 品牌：荣耀（Honor）
- 系列：MagicBook 14/15、14 Pro、X 14 / X 15 / X 16、X 14 Pro / X 16 Pro / X 14 Plus、V 14、16 / 16 Pro、Pro 16、Pro 14、Art 14
- 年份范围：2018–2026
- 型号数：30
- 配置组合：69 条
- 别名：33 条
- 来源链接：43 个

## 1. 交付文件

| 文件 | 内容 |
| --- | --- |
| `sku-catalog-honor-2026-10-26.xlsx` | 主交付文件，含「说明」「SKU型号」「配置组合」「别名」「来源」「待核实与缺口」六个工作表 |
| `sku-models-honor-2026-10-26.csv` | 与「SKU型号」表头一致的 UTF-8（带 BOM）导出 |
| `sku-configurations-honor-2026-10-26.csv` | 与「配置组合」表头一致的 UTF-8（带 BOM）导出 |
| `sku-catalog/02-research/honor/honor-thinlight.json` | 原始调研记录 |
| `sku-catalog/02-research/honor/url-check-honor.json` | 43 个来源链接的 HTTP 可访问性检查结果 |

## 2. 覆盖范围（30 条，均为轻薄本）

- MagicBook 14：2018、2019、2020、2021、2022、2023
- MagicBook 15：2019、2020、2021
- MagicBook Pro（2019，16.1 英寸）、MagicBook 14 Pro（2023）
- MagicBook X 14（2021/2022）、X 15（2021）、X 16（2022/2024）、X 14 Pro（2023）、X 16 Pro（2023）、X 14 Plus（2026）
- MagicBook V 14（2021/2022）
- MagicBook 16 / 16 Pro（2021）、MagicBook 16（2026）
- MagicBook Pro 16（2024/2026）、MagicBook Pro 14（2025/2026）
- MagicBook Art 14（2024/2025）

## 3. 口径说明

**年份**：`modelYear` 取上市年份（四位整数）。荣耀 2020 年从华为独立，独立前的 MagicBook 仍归「荣耀」品牌，不并入华为。

**命名**：`brand=荣耀`，`model` 用官方系列名、不带年份（「MagicBook 14」「MagicBook X 14 Pro」「MagicBook Pro 16」「MagicBook Art 14」），年份进 `modelYear`。

**配置**：五个选项字段只写来源中有依据的值；内存统一为容量；显卡区分集成与独显（Pro 16 的 RTX 版本单独记录）。

**配置组合**：只收录来源证明确实销售的搭配；2026 款按官方页面建档（Pro 14/16、MagicBook 16、X 14 Plus），Pro 16 2026 已取消 RTX 独显，已在备注说明。

**置信度**：high 27、medium 3。

## 4. 来源与可访问性

43 个被引用链接的检查结果（2026-10-26）：

- HTTP 200 可访问：42 个
- HTTP 403 反爬拦截：1 个（浏览器可正常打开）

来源类型：厂商官方 14（honor.com / hihonor.com 规格页与发布会稿）、媒体报道 21、中关村在线产品库 6、太平洋/天极 2。

## 5. 已知缺口

1. **待核实 7 条**：配置/来源缺口 5、需人工确认 1、来源冲突 1。典型：Pro 16 2025 与 Art 14 2026 未获可靠规格页，未建条目；部分 2021 款 X 系列的不同内存版本缺独立 SKU 页。
2. **游戏本缺失**：荣耀没有独立游戏本，MagicBook Pro 16 的 RTX 版本按「轻薄本（独显全能）」归类。
3. **早期机型来源偏媒体**：2018–2020 的 MagicBook 14/15 主要靠媒体首发报道与产品库，缺官方存档页。
4. **价格不是采购价**：配置组合备注中的价格为首发价/参考价（人民币，含日期）。

## 6. 能否直接导入

不能直接导入。现有 `scripts/import-laptop-skus.py` 只识别旧版 ThinkPad/小米工作簿格式。建议先按「SKU型号」做字段映射，以「产品类型+品牌+型号+年份」去重检查，再导入预览、核对「待核实与缺口」，最后单独写库验证。

## 7. 验收自查

- 唯一键 `productType + brand + model + modelYear`：30 条，重复 0 条。
- 产品类型/品牌/型号/年份非空 100%，年份均为四位整数。
- 每个型号至少 1 个来源；无 404 死链。
- 配置组合与主表关联：69 条，悬空 modelKey 0 条。
- Excel 与 CSV 记录数：型号 30 = CSV 30 行 + 1 行表头；组合 69 = CSV 69 行 + 1 行表头。
- 中文、年份、多值字段（JSON 数组）在 CSV 重开后完整。
- 无 low 级记录；7 条不确定项全部进入「待核实与缺口」。
