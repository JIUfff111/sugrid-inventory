# 苹果笔记本 SKU 目录交付说明（MacBook Air / MacBook Pro）

- 交付日期：2026-10-26
- 产品类型：笔记本电脑
- 品牌：苹果
- 系列：MacBook Air 13 / 15、MacBook Pro 13 / 14 / 15 / 16、MacBook 12
- 年份范围：2016–2026
- 型号数：37（Air 14、Pro 23；含 MacBook 12 两条）
- 配置组合：78 条
- 别名：53 条
- 来源链接：48 个

## 1. 交付文件

| 文件 | 内容 |
| --- | --- |
| `sku-catalog-apple-2026-10-26.xlsx` | 主交付文件，含「说明」「SKU型号」「配置组合」「别名」「来源」「待核实与缺口」六个工作表 |
| `sku-models-apple-2026-10-26.csv` | 与「SKU型号」表头一致的 UTF-8（带 BOM）导出 |
| `sku-configurations-apple-2026-10-26.csv` | 与「配置组合」表头一致的 UTF-8（带 BOM）导出 |
| `sku-catalog/02-research/apple/apple-air.json` | Air / MacBook 12 原始调研记录 |
| `sku-catalog/02-research/apple/apple-pro.json` | Pro 原始调研记录 |
| `sku-catalog/02-research/apple/url-check-apple.json` | 48 个来源链接的 HTTP 可访问性检查结果 |

## 2. 覆盖范围

**MacBook Air（14 条）**
- Air 13：2018（Retina）、2019、2020（Intel）、2020（M1）、2022（M2）、2024（M3）、2025（M4）、2026（M5）
- Air 15：2023（M2）、2024（M3）、2025（M4）、2026（M5）
- MacBook 12：2016、2017

**MacBook Pro（23 条）**
- Pro 13：2016、2017、2018、2019、2020（Intel）、2020（M1）、2022（M2）
- Pro 14：2021（M1 Pro/Max）、2023（M2 Pro/Max）、2023（M3 系列）、2024（M4 系列）、2025（M5）、2026（M5 Pro/Max）
- Pro 15：2016、2017、2018、2019
- Pro 16：2019（Intel）、2021（M1 Pro/Max）、2023（M2 Pro/Max）、2023（M3 系列）、2024（M4 系列）、2026（M5 Pro/Max）

## 3. 口径说明

**年份**：`modelYear` 取上市年份。苹果同一机型常跨年销售（如 M1 Air 2020 年上市、2024 年才停产），只记上市年份，不按在售年份重复建行。

**命名**：`brand=苹果`，`model` 带屏幕尺寸、不带年份。同一年份有两代平台时（如 2020 Air 的 Intel 与 M1、2023 Pro 的 M2 与 M3），在 model 后加平台后缀区分，例如「MacBook Air 13（Intel）」「MacBook Pro 14（M3 系列）」，保证唯一键不冲突。显示名为「苹果 MacBook Air 13（M1） 2020」。

**配置**：`cpuOptions` 记芯片（含 CPU 核心数差异）；`ramOptions` 记统一内存容量（8/16/18/24/32/36/48/64/96/128GB）；`gpuOptions` 记「集成显卡（N 核 GPU）」；`storageOptions` 记 SSD 容量；`screenOptions` 记尺寸+分辨率+面板类型。

**配置组合**：只收官方标配组合（官网商城 SKU），不含 BTO 定制；每行有独立来源。

**分类**：本系统只有「轻薄本 / 游戏本」两类，MacBook Pro 14/16 归入「轻薄本」，在备注注明「高性能轻薄本」。

## 4. 来源与可访问性

48 个被引用链接的检查结果（2026-10-26）：**48 个全部可访问（HTTP 200）**，无死链。

来源类型：厂商官方 39（support.apple.com 技术规格页、apple.com.cn 商城）、媒体报道 8、产品库 1。

带中文的 Apple 商城链接已做百分号编码，保证在 Excel 超链接和脚本里都能正常打开。

## 5. 已知缺口

1. **待核实 10 条**：配置/来源缺口 5、需人工确认 5。典型：2017 款非视网膜 MacBook Air 未收录；M1 Air 的 128GB 版本在部分文案中存在矛盾；2025 年没有 16 英寸 M5 机型（已确认，未建行）；M4 Air 的 24GB 是否为标准 SKU 存疑。
2. **BTO 定制未收录**：苹果官网可定制内存/存储/芯片，本目录只收官方标配组合，定制机请按实物录入。
3. **屏幕尺寸与年份的交叉**：Pro 13 的 2020 年 Intel/M1 两代、Pro 14/16 的 2023 年 M2/M3 两代，均按平台分行，不要合并。
4. **价格不是采购价**：备注中的价格为首发价/官网价（人民币，含日期）。

## 6. 能否直接导入

不能直接导入。现有 `scripts/import-laptop-skus.py` 只识别旧版 ThinkPad/小米工作簿格式。建议先按「SKU型号」做字段映射，以「产品类型+品牌+型号+年份」去重检查，再导入预览、核对「待核实与缺口」，最后单独写库验证。

## 7. 验收自查

- 唯一键 `productType + brand + model + modelYear`：37 条，重复 0 条。
- 产品类型/品牌/型号/年份非空 100%，年份均为四位整数。
- 每个型号至少 1 个来源；48 个链接全部 HTTP 200。
- 配置组合与主表关联：78 条，悬空 modelKey 0 条。
- Excel 与 CSV 记录数：型号 37 = CSV 37 行 + 1 行表头；组合 78 = CSV 78 行 + 1 行表头。
- 中文、年份、多值字段（JSON 数组）在 CSV 重开后完整。
- 无 low 级记录；10 条不确定项全部进入「待核实与缺口」。
