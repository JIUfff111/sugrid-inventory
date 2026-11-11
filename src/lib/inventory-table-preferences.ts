export type InventoryTableColumnKey =
  | 'machine'
  | 'productType'
  | 'brand'
  | 'model'
  | 'year'
  | 'configuration'
  | 'cpu'
  | 'ram'
  | 'storage'
  | 'gpu'
  | 'screen'
  | 'touchScreen'
  | 'remarks'
  | 'machineRemark'
  | 'skuRemark'
  | 'serial'
  | 'sn'
  | 'itemNumber'
  | 'source'
  | 'supplier'
  | 'purchaseNo'
  | 'warehouse'
  | 'purchasePrice'
  | 'status'
  | 'statusOnly'
  | 'destination'
  | 'inbound'
  | 'inboundDate'
  | 'inboundDays';

export type InventoryTableDensity = 'compact' | 'normal' | 'comfortable';
export type InventoryTableFreeze = 'left' | 'none' | 'right';

export interface InventoryTableColumnPreference {
  key: InventoryTableColumnKey;
  visible: boolean;
  width: number;
  freeze: InventoryTableFreeze;
}

export interface InventoryTablePreferences {
  density: InventoryTableDensity;
  columns: InventoryTableColumnPreference[];
}

export const INVENTORY_TABLE_PREFERENCE_KEY = 'inventory-table-preferences:v3';
export const INVENTORY_TABLE_LEGACY_PREFERENCE_KEY = 'inventory-table-preferences:v2';
export const INVENTORY_TABLE_OLDER_LEGACY_PREFERENCE_KEY = 'inventory-table-preferences:v1';
export const INVENTORY_TABLE_COLUMN_MIN_WIDTH = 75;
export const INVENTORY_TABLE_COLUMN_MAX_WIDTH = 600;
export const INVENTORY_TABLE_MAX_FROZEN_COLUMNS = 4;
const LEGACY_REMARKS_DEFAULT_WIDTH = 190;

export const INVENTORY_TABLE_COLUMN_DEFINITIONS: ReadonlyArray<{
  key: InventoryTableColumnKey;
  label: string;
  defaultWidth: number;
  defaultVisible?: boolean;
}> = [
  { key: 'machine', label: '机器信息（汇总）', defaultWidth: 180 },
  { key: 'productType', label: '产品类型', defaultWidth: 120, defaultVisible: false },
  { key: 'brand', label: '品牌', defaultWidth: 110, defaultVisible: false },
  { key: 'model', label: '型号', defaultWidth: 160, defaultVisible: false },
  { key: 'year', label: '年份', defaultWidth: 85, defaultVisible: false },
  { key: 'configuration', label: '配置（汇总）', defaultWidth: 210 },
  { key: 'cpu', label: 'CPU', defaultWidth: 150, defaultVisible: false },
  { key: 'ram', label: '内存', defaultWidth: 100, defaultVisible: false },
  { key: 'storage', label: '硬盘', defaultWidth: 110, defaultVisible: false },
  { key: 'gpu', label: '显卡', defaultWidth: 150, defaultVisible: false },
  { key: 'screen', label: '屏幕', defaultWidth: 120, defaultVisible: false },
  { key: 'touchScreen', label: '触屏', defaultWidth: 90, defaultVisible: false },
  { key: 'remarks', label: '备注（汇总）', defaultWidth: 130 },
  { key: 'machineRemark', label: '机器备注', defaultWidth: 190, defaultVisible: false },
  { key: 'skuRemark', label: 'SKU 备注', defaultWidth: 190, defaultVisible: false },
  { key: 'serial', label: 'SN / 编号（汇总）', defaultWidth: 170 },
  { key: 'sn', label: 'SN / IMEI', defaultWidth: 165, defaultVisible: false },
  { key: 'itemNumber', label: '编号', defaultWidth: 120, defaultVisible: false },
  { key: 'source', label: '采购来源（汇总）', defaultWidth: 210, defaultVisible: false },
  { key: 'supplier', label: '供应商', defaultWidth: 150, defaultVisible: false },
  { key: 'purchaseNo', label: '采购单号', defaultWidth: 150, defaultVisible: false },
  { key: 'warehouse', label: '仓库', defaultWidth: 140 },
  { key: 'purchasePrice', label: '采购价', defaultWidth: 110 },
  { key: 'status', label: '状态与去向（汇总）', defaultWidth: 160 },
  { key: 'statusOnly', label: '状态', defaultWidth: 125, defaultVisible: false },
  { key: 'destination', label: '当前去向', defaultWidth: 170, defaultVisible: false },
  { key: 'inbound', label: '入库日期 / 库龄（汇总）', defaultWidth: 160 },
  { key: 'inboundDate', label: '入库日期', defaultWidth: 130, defaultVisible: false },
  { key: 'inboundDays', label: '库龄', defaultWidth: 100, defaultVisible: false },
];

export const INVENTORY_TABLE_COLUMN_GROUPS: ReadonlyArray<{
  summary: InventoryTableColumnKey;
  details: InventoryTableColumnKey[];
}> = [
  { summary: 'machine', details: ['productType', 'brand', 'model', 'year'] },
  { summary: 'configuration', details: ['cpu', 'ram', 'storage', 'gpu', 'screen', 'touchScreen'] },
  { summary: 'remarks', details: ['machineRemark', 'skuRemark'] },
  { summary: 'serial', details: ['sn', 'itemNumber'] },
  { summary: 'source', details: ['supplier', 'purchaseNo'] },
  { summary: 'status', details: ['statusOnly', 'destination'] },
  { summary: 'inbound', details: ['inboundDate', 'inboundDays'] },
];

export function inventoryTablePreferenceStorageKey(userId: string) {
  return `${INVENTORY_TABLE_PREFERENCE_KEY}:${encodeURIComponent(userId)}`;
}

export function legacyInventoryTablePreferenceStorageKey(userId: string) {
  return `${INVENTORY_TABLE_LEGACY_PREFERENCE_KEY}:${encodeURIComponent(userId)}`;
}

export function olderLegacyInventoryTablePreferenceStorageKey(userId: string) {
  return `${INVENTORY_TABLE_OLDER_LEGACY_PREFERENCE_KEY}:${encodeURIComponent(userId)}`;
}

export function clampInventoryTableColumnWidth(value: unknown, fallback: number) {
  const width = Number(value);
  if (!Number.isFinite(width)) return fallback;
  return Math.min(INVENTORY_TABLE_COLUMN_MAX_WIDTH, Math.max(INVENTORY_TABLE_COLUMN_MIN_WIDTH, Math.round(width)));
}

export function createDefaultInventoryTablePreferences(): InventoryTablePreferences {
  return {
    density: 'normal',
    columns: INVENTORY_TABLE_COLUMN_DEFINITIONS.map(({ key, defaultWidth, defaultVisible }) => ({
      key,
      visible: defaultVisible !== false,
      width: defaultWidth,
      freeze: key === 'machine' ? 'left' : 'none',
    })),
  };
}

export function normalizeInventoryTablePreferences(value: unknown): InventoryTablePreferences {
  const defaults = createDefaultInventoryTablePreferences();
  if (!value || typeof value !== 'object') return defaults;

  const candidate = value as Partial<InventoryTablePreferences>;
  const rawColumns = Array.isArray(candidate.columns) ? candidate.columns : [];
  const known = new Map(INVENTORY_TABLE_COLUMN_DEFINITIONS.map((definition) => [definition.key, definition]));
  const seen = new Set<InventoryTableColumnKey>();
  const columns: InventoryTableColumnPreference[] = [];

  for (const raw of rawColumns) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Partial<InventoryTableColumnPreference>;
    if (typeof item.key !== 'string' || !known.has(item.key as InventoryTableColumnKey)) continue;
    const key = item.key as InventoryTableColumnKey;
    if (seen.has(key)) continue;
    seen.add(key);
    const fallback = defaults.columns.find((column) => column.key === key)!;
    columns.push({
      key,
      visible: typeof item.visible === 'boolean' ? item.visible : fallback.visible,
      width: clampInventoryTableColumnWidth(item.width, fallback.width),
      freeze: item.freeze === 'left' || item.freeze === 'right' ? item.freeze : 'none',
    });
  }

  for (const fallback of defaults.columns) {
    if (!seen.has(fallback.key)) columns.push(fallback);
  }

  if (!columns.some((column) => column.visible)) columns[0].visible = true;

  let frozenCount = 0;
  for (const column of columns) {
    if (!column.visible || column.freeze === 'none') continue;
    frozenCount += 1;
    if (frozenCount > INVENTORY_TABLE_MAX_FROZEN_COLUMNS) column.freeze = 'none';
  }

  return {
    density: candidate.density === 'compact' || candidate.density === 'comfortable' ? candidate.density : 'normal',
    columns,
  };
}

export function migrateLegacyInventoryTablePreferences(value: unknown) {
  const preferences = normalizeInventoryTablePreferences(value);
  const matchesLegacyDefault = preferences.density === 'normal'
    && preferences.columns.length === INVENTORY_TABLE_COLUMN_DEFINITIONS.length
    && preferences.columns.every((column, index) => {
      const definition = INVENTORY_TABLE_COLUMN_DEFINITIONS[index];
      const wasVisibleByDefault = column.key === 'source'
        ? true
        : column.key === 'warehouse'
          ? false
          : definition.defaultVisible !== false;
      const wasDefaultWidth = column.key === 'remarks'
        ? column.width === LEGACY_REMARKS_DEFAULT_WIDTH
        : column.width === definition.defaultWidth;
      return column.key === definition.key
        && column.visible === wasVisibleByDefault
        && wasDefaultWidth
        && column.freeze === 'none';
    });

  return matchesLegacyDefault ? createDefaultInventoryTablePreferences() : migrateStoredInventoryTablePreferences(preferences);
}

export function migrateCurrentInventoryTablePreferences(value: unknown) {
  const preferences = migrateStoredInventoryTablePreferences(value);
  const defaults = createDefaultInventoryTablePreferences();
  const matchesPreviousDefault = preferences.density === defaults.density
    && preferences.columns.length === defaults.columns.length
    && preferences.columns.every((column, index) => {
      const currentDefault = defaults.columns[index];
      return column.key === currentDefault.key
        && column.visible === currentDefault.visible
        && column.width === currentDefault.width
        && column.freeze === 'none';
    });

  return matchesPreviousDefault ? defaults : preferences;
}

export function migrateStoredInventoryTablePreferences(value: unknown) {
  const preferences = normalizeInventoryTablePreferences(value);
  const remarks = preferences.columns.find((column) => column.key === 'remarks');
  if (remarks?.width === LEGACY_REMARKS_DEFAULT_WIDTH) {
    remarks.width = INVENTORY_TABLE_COLUMN_DEFINITIONS.find((column) => column.key === 'remarks')!.defaultWidth;
  }
  return preferences;
}

export function setInventoryTableColumnVisibility(
  preferences: InventoryTablePreferences,
  key: InventoryTableColumnKey,
  visible: boolean,
) {
  const detailsGroup = INVENTORY_TABLE_COLUMN_GROUPS.find((group) => group.details.includes(key));
  const summaryGroup = INVENTORY_TABLE_COLUMN_GROUPS.find((group) => group.summary === key);
  const columns = preferences.columns.map((column) => {
    if (column.key === key) return { ...column, visible };
    if (!visible && summaryGroup?.details.includes(column.key)) return { ...column, visible: false };
    if (visible && detailsGroup?.summary === column.key) return { ...column, visible: false };
    if (visible && summaryGroup?.details.includes(column.key)) return { ...column, visible: false };
    return column;
  });
  return normalizeInventoryTablePreferences({ ...preferences, columns });
}

export function setInventoryTableColumnWidth(
  preferences: InventoryTablePreferences,
  key: InventoryTableColumnKey,
  width: number,
): InventoryTablePreferences {
  const column = preferences.columns.find((item) => item.key === key);
  if (!column) return preferences;
  const nextWidth = clampInventoryTableColumnWidth(width, column.width);
  if (nextWidth === column.width) return preferences;
  return {
    ...preferences,
    columns: preferences.columns.map((item) => item.key === key ? { ...item, width: nextWidth } : item),
  };
}

export function getInventoryTableFrozenOffsets(
  columns: InventoryTableColumnPreference[],
  options: { selectionWidth?: number; actionsWidth?: number } = {},
) {
  const offsets: Partial<Record<InventoryTableColumnKey, { left?: number; right?: number }>> = {};
  const visible = columns.filter((column) => column.visible);
  let left = options.selectionWidth || 0;
  for (const column of visible) {
    if (column.freeze !== 'left') continue;
    offsets[column.key] = { ...offsets[column.key], left };
    left += clampInventoryTableColumnWidth(column.width, 160);
  }

  let right = options.actionsWidth || 0;
  for (const column of [...visible].reverse()) {
    if (column.freeze !== 'right') continue;
    offsets[column.key] = { ...offsets[column.key], right };
    right += clampInventoryTableColumnWidth(column.width, 160);
  }
  return offsets;
}
