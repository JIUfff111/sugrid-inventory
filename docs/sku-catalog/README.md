# SKU 目录（笔记本采购型号资料）

本目录集中存放「溯格」采购系统 SKU 选择器所需的笔记本型号资料。按 **说明 → 交付 → 调研 → 脚本** 分类，不再把所有文件堆在 `docs/` 根目录。

库存 SKU 型号和配置的录入/展示规则见 [`00-brief/inventory-sku-entry-standard.md`](00-brief/inventory-sku-entry-standard.md)。

**当前规模**：11 个品牌批次、530 个型号、969 条配置组合，年份覆盖 2016–2026，每条型号均有可追溯来源（无 404 死链）。

## 克隆项目后可直接使用的内置 SKU

研究交付目录和采购页运行时的内置 SKU 是两个统计口径。当前采购页内置目录共有 **970 条有效 SKU 记录**，按品牌、型号和年份区分；克隆仓库即可获得完整目录，无需另行导入 Excel，也无需连接原项目数据库。

目录快照位于 `scripts/sku-catalog/builtin-sku-catalog.json`，只包含产品类型、品牌、型号、年份及按界面短格式清洗后的 CPU、内存、显卡、存储和屏幕选项，不包含数据库 ID、价格、创建人、库存和采购/销售数据。首次初始化空数据库时，`npm run db:init` 和应用服务会自动加载；已有数据库运行 `npm run db:init` 时会幂等清洗已有 SKU 的配置字段，不覆盖型号、库存或业务记录。原始长描述仍保留在 `01-deliverables/` 交付资料中供核验。

已有安装升级时，先停止服务，再运行以下命令；无需删除 `data/inventory.db`：

```powershell
git pull origin main
npm run db:init
```

第 10 版迁移会输出清洗的型号记录数量，并在完成时显示实际数据库路径（如设置了 `INVENTORY_DB_PATH`，以该路径为准）。它只改 SKU 的 CPU、显卡、屏幕选项及变更时间，不覆盖型号身份、价格、采购销售快照和库存。无法解析的 JSON 或未知屏幕描述保留原值。迁移完成后重新启动服务；生产部署需要先 `npm run build`，再 `npm start`。

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
