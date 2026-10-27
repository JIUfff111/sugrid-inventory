# 华为笔记本 SKU 目录交付说明（MateBook 轻薄本）

- 交付日期：2026-10-26
- 产品类型：笔记本电脑
- 品牌：华为
- 系列：MateBook（12 英寸）、MateBook X / X Pro、MateBook E、MateBook D、MateBook 13/13s、14/14s、16/16s、MateBook GT 14
- 年份范围：2016–2026
- 型号数：32
- 配置组合：85 条
- 别名：31 条
- 来源链接：44 个

## 1. 交付文件

| 文件 | 内容 |
| --- | --- |
| `sku-catalog-huawei-2026-10-26.xlsx` | 主交付文件，含「说明」「SKU型号」「配置组合」「别名」「来源」「待核实与缺口」六个工作表 |
| `sku-models-huawei-2026-10-26.csv` | 与「SKU型号」表头一致的 UTF-8（带 BOM）导出 |
| `sku-configurations-huawei-2026-10-26.csv` | 与「配置组合」表头一致的 UTF-8（带 BOM）导出 |
| `sku-catalog/02-research/huawei/huawei-thinlight.json` | 原始调研记录 |
| `sku-catalog/02-research/huawei/url-check-huawei.json` | 45 个来源链接的 HTTP 可访问性检查结果 |

## 2. 覆盖范围（32 条，均为轻薄本）

- MateBook（12 英寸，2016）、MateBook X（2017）
- MateBook E：2017、2019、2022 各代（二合一）
- MateBook D 14 / D 16
- MateBook 13 / 13s、MateBook 14 / 14s（2019—2026 各代）
- MateBook 16 / 16s
- MateBook X Pro（2018—2024 各代）
- MateBook GT 14（2024，酷睿 Ultra + OLED）
- MateBook 14 鸿蒙版（2026，麒麟 X90）

## 3. 口径说明

**年份**：`modelYear` 取上市年份（四位整数）。华为同代同名情况较多（如 2022 款 X Pro 有 11 代/12 代两批、2025 与 2026 款 MateBook 14 并存），已按实际上市年份分行，并在备注说明判定依据。

**命名**：`brand=华为`，`model` 用官方系列名、不带年份（「MateBook 14」「MateBook X Pro」「MateBook D 16」「MateBook GT 14」），年份进 `modelYear`。显示名如「华为 MateBook 14 2024」。

**配置**：五个选项字段只写来源中有依据的值；英特尔版与锐龙版分别按来源记录；内存统一为容量，板载信息在备注。

**配置组合**：只收录来源证明确实销售的搭配，未做笛卡尔积；每行有独立来源。

**置信度**：high 27、medium 5。medium 主要是仅找到渠道页或社区来源的机型（MateBook 14 2024/2025、MateBook 16s 2022 等）。

## 4. 来源与可访问性

44 个被引用链接的检查结果（2026-10-26）：

- 可访问：42 个（含 7 个 302 跳转后正常）
- HTTP 405 拦截自动化（天极参数页）：2 个

来源类型：厂商官方 12、媒体报道 21、中关村在线产品库 6、太平洋/天极 3、百科 2。

**换源记录**：MateBook GT 14 2024 原来源 eet-china 文章连接超时，已替换为中关村在线产品库的 GT 14 详情页（含 5 个版本与报价），置信度降为 medium 并注明。

## 5. 已知缺口

1. **待核实 7 条**：配置/来源缺口 5、来源冲突 1、需人工确认 1。典型：D 15 未见独立国行规格页；X Pro 2022 的 11 代/12 代两批配置边界不清；MateBook Pro 2025、MateBook E Go 未收录。
2. **华为官网页面多为动态渲染**：部分产品页正文抓取不完整，规格以产品库/媒体交叉核验为准。
3. **无游戏本**：华为消费线没有独立游戏本，MateBook GT 14 按「轻薄本（独显全能）」归类。
4. **价格不是采购价**：配置组合备注中的价格为首发价/参考价（人民币，含日期）。

## 6. 能否直接导入

不能直接导入。现有 `scripts/import-laptop-skus.py` 只识别旧版 ThinkPad/小米工作簿格式。建议先按「SKU型号」做字段映射，以「产品类型+品牌+型号+年份」去重检查，再导入预览、核对「待核实与缺口」，最后单独写库验证。

## 7. 验收自查

- 唯一键 `productType + brand + model + modelYear`：32 条，重复 0 条。
- 产品类型/品牌/型号/年份非空 100%，年份均为四位整数。
- 每个型号至少 1 个来源；无 404 死链。
- 配置组合与主表关联：85 条，悬空 modelKey 0 条。
- Excel 与 CSV 记录数：型号 32 = CSV 32 行 + 1 行表头；组合 85 = CSV 85 行 + 1 行表头。
- 中文、年份、多值字段（JSON 数组）在 CSV 重开后完整。
- 无 low 级记录；7 条不确定项全部进入「待核实与缺口」。
