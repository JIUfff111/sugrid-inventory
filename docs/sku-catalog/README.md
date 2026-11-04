# SKU 目录（笔记本采购型号资料）

本目录集中存放「溯格」采购系统 SKU 选择器所需的笔记本型号资料。按 **说明 → 交付 → 调研 → 脚本** 分类，不再把所有文件堆在 `docs/` 根目录。

库存 SKU 型号和配置的录入/展示规则见 [`00-brief/inventory-sku-entry-standard.md`](00-brief/inventory-sku-entry-standard.md)。

需要外部 Agent 搜集新型号时，按 [`00-brief/sku-agent-handoff-standard.md`](00-brief/sku-agent-handoff-standard.md) 交付，并复制 [`00-brief/sku-agent-research-prompt.md`](00-brief/sku-agent-research-prompt.md) 的提示词。模板：[型号增量](00-brief/templates/sku-models-template.csv)、[配置组合](00-brief/templates/sku-configurations-template.csv)、[来源](00-brief/templates/sku-sources-template.csv)、[待核实项](00-brief/templates/sku-review-template.csv)、[README](00-brief/templates/README-template.md)。收到文件后先做目录去重和导入预览，不直接写数据库。

研究交付资料为追溯来源可保留 Xiaomi / Redmi 原始系列名；进入本项目内置 SKU 时，红米统一映射为「小米」品牌。

**当前规模**：16 个品牌线、659 个型号、1945 条配置组合，年份覆盖 2014–2026，每条型号均有可追溯来源（无 404 死链）。11-03 更新：整理 ThinkPad 98 个既有型号（来源为联想官方 PSREF 产品页，含 759 条 MTM 级配置组合及屏幕选项补齐）；天选 / 小米 / 红米配置变体已并入主表；宏碁掠夺者补录 9 条官方规格配置；新增全品牌交付汇总目录 [`01-deliverables/_交付汇总-2026-11-03/`](01-deliverables/_交付汇总-2026-11-03/README-交付说明-2026-11-03.md)（一份总表看全量，不必逐个品牌翻）。

## 克隆项目后可直接使用的内置 SKU

研究交付目录和采购页运行时的内置 SKU 是两个统计口径。当前跟踪的内置目录快照包含 **977 条有效 SKU 记录**，型号身份无重复；克隆仓库即可获得完整目录，无需另行导入 Excel，也无需连接原项目数据库。11-03 相对原内置目录的实际增量是 2 个 RedmiBook 型号、98 个 ThinkPad 屏幕选项及 2 项小米既有型号配置补充；11-04 又加入证据通过审核的 ThinkPad R14 Gen 2 (Intel) 1 个型号。补充包中的调研型号/配置数量不代表全部都是采购页新型号。

目录快照位于 `scripts/sku-catalog/builtin-sku-catalog.json`，只包含产品类型、品牌、型号、年份及按界面短格式清洗后的 CPU、内存、显卡、存储和屏幕选项，不包含数据库 ID、价格、创建人、库存和采购/销售数据。首次初始化空数据库时，`npm run db:init` 和应用服务会自动加载；已有数据库通过版本化迁移幂等合并新增内置型号和选项，不覆盖手工 SKU、价格、库存或采购/销售记录。原始长描述仍保留在 `01-deliverables/` 交付资料中供核验。

已有安装升级时，先停止服务，在 Git Bash / Bash 中运行以下生产部署命令；`&&` 保证任一步失败时停止，无需删除 `data/inventory.db`：

```bash
git pull --ff-only origin main &&
npm ci &&
npm run db:init &&
npm run build &&
npm run start -- --hostname 0.0.0.0 --port 3000
```

如果 Git 提示本地 `package-lock.json` 会被覆盖，先执行 `git stash push -m "backup-lock-before-update" -- package-lock.json` 保存旧锁，再重试上面的命令。旧锁保留在 stash 中，不要重新覆盖仓库的新锁。PowerShell 5 用户请使用 Git Bash 执行此命令链。

第 10 版迁移会输出清洗的型号记录数量，并在完成时显示实际数据库路径（如设置了 `INVENTORY_DB_PATH`，以该路径为准）。它只改 SKU 的 CPU、显卡、屏幕选项及变更时间，不覆盖型号身份、价格、采购销售快照和库存。无法解析的 JSON 或未知屏幕描述保留原值。`db:init` 不生成生产构建；出现 `Could not find a production build` 时，需要先成功执行 `npm run build`，再启动。

维护内置目录时，可从当前正式数据库**只读导出**有效 SKU 字段并更新跟踪文件：

```powershell
node scripts/export-builtin-skus.cjs --write
```

导出脚本只读取 `skus` 表的公开目录字段。更新后应在空白测试数据库运行 `node scripts/test-builtin-sku-seed.cjs`，确认记录数及幂等行为。

## 目录结构

```
docs/sku-catalog/
├─ README.md                    ← 本文件（目录索引与规范）
├─ 00-brief/                    ← 任务说明与规范
│  └─ sku-catalog-research-brief.md
├─ 01-deliverables/             ← 交付文件，按品牌 / 日期分目录
│  ├─ _交付汇总-2026-11-03/      ← 全品牌集中交付（对外只发这一个文件夹）
│  │  ├─ sku-catalog-全品牌-2026-11-03.xlsx       （6 表：说明/品牌统计/型号/配置/别名/待核实）
│  │  ├─ sku-models-全品牌-2026-11-03.csv
│  │  ├─ sku-configurations-全品牌-2026-11-03.csv
│  │  ├─ README-交付说明-2026-11-03.md
│  │  └─ 分品牌/                 （12 份单品牌工作簿副本）
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
│  ├─ hasee/2026-10-26/（xlsx + 2 CSV + README）
│  └─ xiaomi/2026-11-01/（小米 + 红米，2021 年起）
├─ 02-research/                 ← 主批次原始调研数据，按品牌分目录
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
│  ├─ xiaomi/  (xiaomi-thinlight.json、redmi-thinlight.json、url-check-xiaomi.json)
│  └─ _combined/sku-normalized.json   ← 各品牌合并后的归一化数据（生成物）
├─ 03-supplements/              ← 补充批次统一放这里，一个补充一个文件夹
│  ├─ asus-tianxuan-2026-11-01/        ← 天选型号补齐
│  │  ├─ sku-catalog-asus-2026-11-01-tianxuan-supplement.xlsx
│  │  ├─ …csv / README…
│  │  └─ research/
│  ├─ config-variants-2026-11-01/       ← 天选 / 拯救者 / 小米 / 红米 配置变体补齐
│  │  ├─ sku-catalog-config-variants-2026-11-01.xlsx
│  │  ├─ sku-models-config-variants-2026-11-01.csv
│  │  ├─ sku-configurations-config-variants-2026-11-01.csv
│  │  ├─ README-sku-catalog-config-variants-2026-11-01.md
│  │  └─ research/  （7 份补录 JSON、合并数据集、284 条链接检查）
│  └─ gapfill-2026-11-03/               ← 11-03 这批补充新增的 SKU（增量，按品牌分开放）
│     ├─ sku-catalog-gapfill-2026-11-03-汇总.xlsx   （5 品牌增量合并 + 品牌统计）
│     ├─ README-sku-catalog-gapfill-2026-11-03.md
│     └─ 分品牌/
│        ├─ lenovo-thinkpad/   （98 型号 / 759 配置 / 271 待核实）
│        ├─ asus-tianxuan/     （67 配置）
│        ├─ xiaomi-redmi/      （2 型号 / 75 配置）
│        ├─ acer-predator/     （9 配置）
│        └─ mechrevo/          （2 配置）
│  ├─ sku-catalog-thinkpad-r14-2026-11-04/  ← R14 中国特供系列补录（首按新交接标准交付）
│     ├─ README.md  sku-models.csv  sku-configurations.csv
│     ├─ sources.csv  review.csv     （1 可导入型号 / 2 配置 / 7 来源 / 7 review；另 2 型号待核实）
└─ _backup-2026-11-03/          ← 补充前的品牌 JSON 快照，用于 diff 出增量（勿删）
```

处理脚本放在项目的 `web/scripts/sku-catalog/`，与既有 `import-laptop-skus.py` 同域：

```
web/scripts/sku-catalog/
├─ normalize_skus.py     ← 合并各品牌 JSON、统一字段、去重
├─ fetch_titles.py       ← 回填缺失的来源标题（抓取页面 <title>）
├─ check_urls.py         ← 批量检查来源链接可访问性
├─ fix_combos.py         ← 组合去重与标题回填（一次性修复工具）
├─ build_deliverable.py  ← 生成 xlsx + CSV（按品牌输出到 01-deliverables）
├─ build_all_in_one.py   ← 汇总各品牌交付件为全品牌总表（输出到 _交付汇总-<日期>/）
├─ build_supplement_by_brand.py ← 按品牌拆出「本批补充新增」的 SKU（diff 备份快照，输出到 03-supplements/gapfill-<日期>/）
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
| 补充工作簿 | `sku-catalog-<brand>-<YYYY-MM-DD>-<topic>-supplement.xlsx` | `sku-catalog-asus-2026-11-01-tianxuan-supplement.xlsx` |
| 全品牌总表 | `sku-catalog-全品牌-<YYYY-MM-DD>.xlsx` | `sku-catalog-全品牌-2026-11-03.xlsx` |
| 分品牌补充件 | `sku-catalog-<slug>-supplement-<YYYY-MM-DD>.xlsx` | `sku-catalog-lenovo-thinkpad-supplement-2026-11-03.xlsx` |

品牌标识统一用英文小写：`lenovo` / `dell` / `asus` / `rog` / `hp` / `huawei` / `honor` / `apple` / `acer` / `msi` / `mechrevo` / `hasee` / `xiaomi`。

## 当前进度

| 品牌 | 状态 | 型号 | 组合 | 交付目录 |
| --- | --- | --- | --- | --- |
| 联想 + ThinkPad（小新 / YOGA / 拯救者 / ThinkPad 全系） | 已交付 | 188 | 937 | `01-deliverables/lenovo/2026-10-26/` |
| 戴尔 + Alienware | 已交付 | 62 | 97 | `01-deliverables/dell/2026-10-26/` |
| 华硕 + ROG（灵耀 / a豆 / 无畏 / 天选 / ROG） | 已交付 | 60 | 161 | `01-deliverables/asus/2026-10-26/` |
| 惠普（星 / 战66 / 幽灵 / 薄锐 / 星Book Pro / 暗影精灵 / 光影精灵） | 已交付 | 56 | 136 | `01-deliverables/hp/2026-10-26/` |
| 华为（MateBook） | 已交付 | 32 | 85 | `01-deliverables/huawei/2026-10-26/` |
| 荣耀（MagicBook） | 已交付 | 30 | 69 | `01-deliverables/honor/2026-10-26/` |
| 苹果（MacBook Air / Pro） | 已交付 | 37 | 78 | `01-deliverables/apple/2026-10-26/` |
| 宏碁（非凡 / 蜂鸟 / 暗影骑士 / 掠夺者） | 已交付 | 53 | 94 | `01-deliverables/acer/2026-10-26/` |
| 微星（现代 / 尊爵 / 泰坦 / 强袭 / 绝影 / 冲锋坦克 / 武士 / 侠客） | 已交付 | 56 | 75 | `01-deliverables/msi/2026-10-26/` |
| 机械革命（无界 / 蛟龙 / 极光 / 旷世 / 耀世） | 已交付 | 28 | 43 | `01-deliverables/mechrevo/2026-10-26/` |
| 神舟（战神 / 优雅 / 精盾） | 已交付 | 26 | 31 | `01-deliverables/hasee/2026-10-26/` |
| 小米 + 红米（2021 年起） | 已交付 | 31 | 139 | `01-deliverables/xiaomi/2026-11-01/` |
| **合计（16 个品牌线）** | **已交付** | **659** | **1945** | 待核实 468 条 |
| 全品牌汇总（对外交付入口，含以上全部品牌） | 已交付 | 659 | 1945 | `01-deliverables/_交付汇总-2026-11-03/` |
| **11-03 补充件（增量，按品牌分开）** | **已交付** | **100** | **912** | `03-supplements/gapfill-2026-11-03/分品牌/` |
| 配置变体补充：天选 / 拯救者 / 小米 / 红米（11-03 修订，含红米 2025 锐龙版补录；天选 / 小米 / 红米配置已并入上表对应品牌） | 已交付 | 89 | 412 | `03-supplements/config-variants-2026-11-01/` |

## 新增一个品牌的流程

1. 调研：把该品牌的轻薄本 / 游戏本数据写成 `02-research/<brand>/<brand>-thinlight.json`、`<brand>-gaming.json`（字段与现有文件一致）。
2. 归一化：`python scripts/sku-catalog/normalize_skus.py`（会把该品牌加入合并数据集并去重）。
3. 补标题：`python scripts/sku-catalog/fetch_titles.py`（抓取缺失的来源页面标题）。
4. 验链接：`python scripts/sku-catalog/check_urls.py "<中文品牌名>" <brand>`。
5. 出交付：`python scripts/sku-catalog/build_deliverable.py "<中文品牌名>" "" <brand>`，输出到 `01-deliverables/<brand>/<日期>/`。
6. 写该品牌的 `README-sku-catalog-<brand>-<日期>.md`，并更新本文件的「当前进度」。

## 导入交付 SKU

所有品牌交付完成后，可先对现有数据库执行只读预览，再导入缺失型号：

```powershell
python scripts/import-sku-deliverables.py --database data/inventory.db
python scripts/import-sku-deliverables.py --database data/inventory.db --apply
```

导入器会验证型号、配置组合和别名的关联；空配置选项会保留为空，不补造配置。预览按品牌显示新增量，并指出与现有 SKU 配置不同的记录。执行导入时先备份数据库，然后仅新增缺失型号到 `skus` 表，不改已有 SKU、库存或采购记录。完成后可重复运行，已存在型号会被跳过。

## 注意事项

- 工作簿被 Excel / WPS / 预览面板打开时，脚本无法覆盖同名文件（Windows 文件锁）。重新生成前请先关闭该文件。
- 交付文件里的多值字段：Excel 为 JSON 数组文本，CSV 同样为 JSON 数组文本（UTF-8 带 BOM），两者表头一致。
- 价格只是来源标注的首发价 / 参考价，不是采购价；采购价按实物录入。
- **对外交付只发 `01-deliverables/_交付汇总-2026-11-03/` 一个文件夹**（总表 + 2 份 CSV + 分品牌工作簿 + 说明）。单品牌目录保留作为权威溯源位置，不删。
- **只想看「11-03 这一批补了什么」，去 `03-supplements/gapfill-2026-11-03/分品牌/`**：每个品牌一个文件夹，只含本批新增（100 型号 / 912 配置），912 条已校验全部能在主交付件里命中。`_backup-2026-11-03/` 是算增量用的基线快照，勿删。
- 任一品牌重新出交付件后，要重跑 `build_all_in_one.py` 更新总表，否则汇总表会落后于品牌目录；`分品牌/` 的副本需手动重新拷贝。
- 型号数 659 与调研数据集 660 差 1 条：该条置信度为 low，按规则移入「待核实与缺口」，不进交付主表。待核实 468 条 = 各品牌工作簿「待核实」表去重后合计（含品牌级缺口描述），比合并数据集 `uncertain` 的 446 条多 22 条。
