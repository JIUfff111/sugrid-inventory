# 微星笔记本 SKU 目录交付说明（轻薄本 / 游戏本）

- 交付日期：2026-10-26
- 产品类型：笔记本电脑
- 品牌：微星（MSI）
- 系列：现代 Modern、尊爵 Prestige、Summit、创造者 Creator；泰坦 Titan、强袭 Raider、绝影 Stealth、冲锋坦克 Vector、武士 Katana、侠客 Bravo
- 年份范围：2018–2026
- 型号数：56（轻薄本 24、游戏本 32）
- 配置组合：75 条
- 别名：57 条
- 来源链接：83 个

## 1. 交付文件

| 文件 | 内容 |
| --- | --- |
| `sku-catalog-msi-2026-10-26.xlsx` | 主交付文件，含「说明」「SKU型号」「配置组合」「别名」「来源」「待核实与缺口」六个工作表 |
| `sku-models-msi-2026-10-26.csv` | 与「SKU型号」表头一致的 UTF-8（带 BOM）导出 |
| `sku-configurations-msi-2026-10-26.csv` | 与「配置组合」表头一致的 UTF-8（带 BOM）导出 |
| `sku-catalog/02-research/msi/msi-thinlight.json` | 轻薄本原始调研记录 |
| `sku-catalog/02-research/msi/msi-gaming.json` | 游戏本原始调研记录 |
| `sku-catalog/02-research/msi/url-check-msi.json` | 88 个来源链接的 HTTP 可访问性检查结果 |

## 2. 覆盖范围

**轻薄本（24 条）**
- 现代 Modern 14（2019/2021/2022/2023/2024）、Modern 15（2019/2024）
- 尊爵 Prestige 14（2019、Evo 2021/2022、AI Evo 2024、AI+ Evo 2024/2026）、Prestige 15（2021）、Prestige 16 Evo（2023/2024/2025）、Prestige 16 AI+ Evo（2024）
- Summit：E15（2020）、E13 Flip Evo（2021）、E16 Flip Evo（2022/2023）、E14 Flip Evo（2023）
- 创造者 Creator M16（2024）

**游戏本（32 条）**
- 泰坦 Titan：GT75、GT76、GT77、18 Pro（2024）、18 Ultra AI（2025）、18 Max（2026）
- 强袭 Raider：GE75、GE66、GE76、GE68 HX / GE78 HX（2023）、18 HX AI（2025）
- 绝影 Stealth：GS65、GS75、GS66、GS76、15M、16 Studio（2023）、16 AI（2025）
- 冲锋坦克 Vector：GP66、GP76、GP78 HX、Vector 16 HX
- 武士 Katana：GF63、GF75、GF66、GF76、Katana 15（2023）、Katana 15 HX（2025）
- 侠客 Bravo：Bravo 15（2020/2023）、Bravo 17（2020）

## 3. 口径说明

**年份**：`modelYear` 取上市年份（四位整数）。

**命名**：`brand=微星`，`model` 用官方中文名 + 系列型号、不带年份（「泰坦 GT77」「强袭 GE76」「绝影 GS66」「冲锋坦克 GP76」「武士 GF63」「尊爵 Prestige 16 AI Evo」）；SKU 后缀（GE76 11UH 等）写在备注，不进 model。

**配置**：五个选项字段只写来源中有依据的值；内存统一为容量；显卡区分集成/独显并保留显存。

**配置组合**：只收录来源证明确实销售的搭配；本次有 4 条组合因来源不可访问且无法匹配到同型号替代页，已删除（Prestige 14 Evo 2022、Summit E14 Flip 2023、GE66 2020、Stealth 15M 2021 各 1 条）。

**置信度**：high 39、medium 17。

## 4. 来源与可访问性

83 个被引用链接的检查结果（2026-10-26）：

- HTTP 200 可访问：65 个
- HTTP 403 反爬拦截：18 个（msi.com / msi.cn 官方页对自动化请求返回 403，浏览器可正常打开）

来源类型：媒体报道 34、厂商官方 31（msi.cn / msi.com / storage-asset.msi.com 规格 PDF）、中关村在线产品库 14、电商页面 2、太平洋/天极 2。

**换源记录**：4 个型号的原始来源在本机网络不可达，已替换为微星官方规格 PDF 或中关村在线产品库页——尊爵 Prestige 14（2019）、尊爵 Prestige 16 Evo（2023）、强袭 GE68 HX（2023）、冲锋坦克 Vector 16 HX（2024）。替换后没有「无法访问」的引用链接。

## 5. 已知缺口

1. **待核实 15 条**：配置/来源缺口 12、年份不明 2、来源冲突 1。典型：2019 年 AMD 机型实为 Alpha 15（Bravo 15 为 2020 上市）；「泰坦 16 AI 2025」与海外 Vector 16 HX AI 命名是否对应；泰坦 18 Max 屏幕刷新率来源冲突。
2. **2026 款覆盖偏少**：仅 2 条（泰坦 18 Max、尊爵 Prestige 14 AI+ 2026），其余 2026 新品缺稳定规格页。
3. **微星官网反爬**：18 个官方链接需要浏览器打开，脚本只能记录 403。
4. **价格不是采购价**：备注中的价格为首发价/参考价（人民币，含日期）。

## 6. 能否直接导入

不能直接导入。现有 `scripts/import-laptop-skus.py` 只识别旧版 ThinkPad/小米工作簿格式。建议先按「SKU型号」做字段映射，以「产品类型+品牌+型号+年份」去重检查，再导入预览、核对「待核实与缺口」，最后单独写库验证。

## 7. 验收自查

- 唯一键 `productType + brand + model + modelYear`：56 条，重复 0 条。
- 产品类型/品牌/型号/年份非空 100%，年份均为四位整数。
- 每个型号至少 1 个来源；无「无法访问」的引用链接。
- 配置组合与主表关联：75 条，悬空 modelKey 0 条。
- Excel 与 CSV 记录数：型号 56 = CSV 56 行 + 1 行表头；组合 75 = CSV 75 行 + 1 行表头。
- 中文、年份、多值字段（JSON 数组）在 CSV 重开后完整。
- 无 low 级数据混入主表；15 条不确定项全部进入「待核实与缺口」。
