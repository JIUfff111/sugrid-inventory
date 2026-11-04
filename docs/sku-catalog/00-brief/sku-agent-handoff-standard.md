# SKU 外部 Agent 交付标准

本文件是外部 Agent 为溯格补充型号资料时的唯一交接标准。目标是让 Codex 能先核对、去重、预览，再把确认后的增量并入内置 SKU；外部 Agent 不应直接改项目代码、数据库或 Git。

版本 1.0；生效日期：2026-11-04。内置目录快照会继续更新，交办时始终附上本次任务使用的当前版本。

## 开始前

交办时同时提供：

1. 本标准和 `sku-agent-research-prompt.md`。
2. 当前版本的 `scripts/sku-catalog/builtin-sku-catalog.json`，用于识别已有型号和选项。
3. 明确本次品牌、产品类型、年份 / 系列范围，以及指定的参考文件。

如果没有当前内置目录快照，Agent 必须在 README 标注“未能和运行目录去重”，不得声称交付内容都是新增 SKU；Codex 收到文件后会重新比对。

## 必交文件

按一个主题、一个日期创建交付文件夹，例如 `sku-catalog-lenovo-2026-11-10/`。CSV 使用 UTF-8 编码，逗号按 RFC 4180 引号规则处理；多值字段必须是合法 JSON 数组，不得用逗号拼接。

| 文件 | 用途 |
| --- | --- |
| `README.md` | 范围、统计、方法、去重基线、未解决问题和交付是否可进入导入预览 |
| `sku-models.csv` | **仅包含相对所给内置目录真正新增的型号或选项增量** |
| `sku-configurations.csv` | 有来源证据的实际配置组合，作为型号选项的依据；不是所有组合的笛卡尔积 |
| `sources.csv` | 来源链接、标题、发布方、覆盖字段和核验状态 |
| `review.csv` | 冲突、重复、低置信、超范围和不应导入的内容；无问题时保留表头并在 README 写明 0 条 |

可以附带原始 XLSX、PDF 或网页存档作为证据，但不能用它们代替上述 CSV。XLSX 若提供，须与 CSV 同口径，不能只交一份难以核对的图片或 PDF。

## CSV 字段

模板位于本目录的 `templates/`。不得改表头；确需额外字段时先放 README 的补充说明，并保留标准字段。

### `sku-models.csv`

```text
changeType,productType,brand,model,year,sourceBrand,sourceModel,sourceYearText,cpuOptions,ramOptions,gpuOptions,storageOptions,screenOptions,aliases,sourceIds,confidence,notes
```

- `changeType` 只能是 `new_model` 或 `add_options`。前者的选项数组是该型号完整的规范选项；后者的数组**只放尚未存在、待追加的选项**，没有增量填 `[]`。
- `productType,brand,model,year` 是项目内置目录值；唯一键为 `productType|brand|model|year`。年份使用四位整数；未知时留空并写明原因，不能用网页发布时间替代机型年份。
- `sourceBrand,sourceModel,sourceYearText` 保留来源原文，供比对，不参与内置目录唯一键。
- `cpuOptions`、`ramOptions`、`gpuOptions`、`storageOptions`、`screenOptions`、`aliases`、`sourceIds` 均为 JSON 数组文本。没有值写 `[]`，不能填 `null` 或自造占位值。
- `aliases` 仅用于研究时匹配别名和发现重复，不会写入当前内置目录快照。
- `confidence` 只能是 `high`、`medium`、`low`。`low` 不得放在 `sku-models.csv`，应只列入 `review.csv`。

### `sku-configurations.csv`

```text
configurationId,productType,brand,model,year,cpu,ram,gpu,storage,screen,cpuRaw,ramRaw,gpuRaw,storageRaw,screenRaw,sourceIds,confidence,notes
```

每行是一种有来源证据的实际销售组合。前五个配置字段使用标准化短值；`*Raw` 字段逐字保留来源信息，便于复核。`configurationId` 在本次交付中唯一；同一配置多来源时，`sourceIds` 用 JSON 数组列出多个来源。

### `sources.csv`

```text
sourceId,sourceUrl,sourceTitle,publisher,sourceType,checkedAt,accessStatus,fieldsCovered,notes
```

`sourceId` 在本批唯一，例如 `S001`。`checkedAt` 使用 `YYYY-MM-DD`。`fieldsCovered` 使用 JSON 数组，例如 `["model","cpu","screen"]`。优先厂商规格页、维护手册和 PSREF；来源打不开、内容仅为搜索摘要、页面与型号不匹配时应如实标记。

### `review.csv`

```text
reviewId,recordType,sourceKey,field,observedValue,issueType,confidence,importDecision,reason,followUp
```

用于记录重复、年份歧义、来源冲突、推断规格、格式无法映射和超出范围等事项。`importDecision` 使用 `exclude`、`needs_review` 或 `already_exists`。待核实内容不能藏在 notes 里后仍混入可导入增量。

## 项目内置 SKU 规则

以下是可导入值的规则；来源原文仍保留在 `*Raw` 和来源表，不要为了缩短界面显示而抹掉证据。

| 字段 | 内置目录标准 |
| --- | --- |
| 产品类型 | 使用项目现有类型名。游戏本仍归 `笔记本电脑`，不得另设游戏本类型或分类型号。新增类型不在范围内时列入 `review.csv`。 |
| 品牌 / 型号 | 小米、Redmi、红米统一使用 `brand=小米`；正式系列名保留在 `model`，例如 `RedmiBook 14 锐龙版` 或 `Xiaomi Book Pro 14`。品牌单独存放，不要额外拼接品牌或年份；官方型号本身含品牌词时保留，完整展示名不得重复品牌或年份。 |
| 型号年份 | 与品牌和型号分别存储。只有来源能支持机型年份时才填写；不要把年份重复写入 `model`。 |
| CPU | AMD Ryzen 去冗余厂商词并用 `R` 简写，如 `R5-4650U`；传统 Intel Core i5/i7 使用 `I5-10210U`、`I7-12650H`；Core Ultra 使用 `Ultra 7 155H`；新命名 `Core 5 220H` 保持该写法。发生简写碰撞时写入 review，不要合并不同 CPU。 |
| 内存 | 内置选择项限 `8GB`、`16GB`、`24GB`、`32GB`。配置证据中出现其他容量时保留原文并放入 review，不得静默扩充内置选项。 |
| 显卡 | 独显仅留型号，如 `RTX 4060`、`RX 6800M`；去掉 NVIDIA / GeForce / Radeon 等冗余前缀、显存和“笔记本电脑 GPU”。所有核显统一为 `集显`。 |
| 存储 | 仅放有来源支持的容量与介质，如 `512GB SSD`；没有证据时用 `[]`，不得推断。 |
| 屏幕 | 内置值用分辨率短等级，如 `FHD`、`FHD+`、`2K`、`2.5K`、`2.8K`、`3.2K`、`4K`。尺寸、刷新率、色域和亮度保留在 `screenRaw`。分辨率不明确时不得猜测，列入 review；系统允许操作者自定义录入屏幕值。 |
| 手工 SKU | 手工 SKU 库与内置目录分开。外部 Agent 不应把手工 SKU 当作内置 SKU，不应把自由输入内容写进内置型号选项。 |

硬盘 / 存储选项可以为空。资料缺失不是填默认值的理由。

## 置信度与收录门槛

- `high`：厂商官方规格页、服务手册、PSREF 等直接支持具体型号 / 配置。
- `medium`：可访问的可靠零售、评测或产品数据库，并有第二个独立来源支持关键身份或配置；备注说明来源差异。
- `low`：推断、搜索摘要、同系列类推、来源缺失或明显冲突。只进入 `review.csv`，不进入可导入 CSV。
- 不得根据系列惯例推导内存、硬盘、屏幕、显卡或 CPU；不做笛卡尔积；不把一个销售标题推断为整个型号系列的完整配置范围。
- 价格、SN、IMEI、采购日期、供应商、库存数量、销售数据不属于 SKU 目录，不得交付为 SKU 字段。

## Codex 接收与导入流程

收到交付后，Codex 按以下顺序处理，不会直接信任文件中“已去重”或“可导入”的声明：

1. 检查文件名、表头、编码、JSON 数组语法、必填字段、来源 ID 引用和唯一键重复。
2. 对比当时仓库的内置目录，重新计算真正的新增型号、选项补充、已存在内容和冲突；同名不同年的型号分别处理。
3. 展示导入预览和 review 项，确认品牌映射、来源置信度、规格写法及新增/更新统计。
4. 仅将通过审核的增量合并到内置目录快照；更新下一个版本迁移，禁止改写正式数据库以完成 SKU 交付。
5. 在独立临时数据库测试空库初始化和已有库迁移，检查数量、幂等、保留手工 SKU、外键与完整性，再做浏览器验证。

外部 Agent 的交付是研究资料，不是直接写入运行数据库的授权。未通过校验的记录保留在 review，不得为了满足数量目标而强行导入。
