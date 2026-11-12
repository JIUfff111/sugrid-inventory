import { INVENTORY_TABLE_COLUMN_DEFINITIONS, type InventoryTableColumnKey } from '@/lib/inventory-table-preferences';
import { formatProductName } from '@/lib/product-name';

export type InventoryExportRow = Record<string, unknown> & {
  id: string;
  productType: string;
  brand: string;
  model: string;
  year: string | number | null;
  cpu: string | null;
  ram: string | null;
  storage: string | null;
  gpu: string | null;
  screen: string | null;
  touchScreen: number | null;
  sn: string;
  itemNumber: string | null;
  remark: string | null;
  skuRemark: string | null;
  supplierName: string | null;
  purchaseNo: string | null;
  warehouseName: string | null;
  purchasePrice: number | null;
  status: string;
  customStatusName: string | null;
  customStatusLocation: string | null;
  afterSaleStockStatus: string | null;
  saleChannel: string | null;
  inboundDate: string;
  inboundDays: number;
};

export const INVENTORY_EXPORT_COLUMNS: ReadonlyArray<{ key: InventoryTableColumnKey; label: string }> =
  INVENTORY_TABLE_COLUMN_DEFINITIONS.map(({ key, label }) => ({ key, label }));

const STATUS_LABELS: Record<string, string> = {
  in_stock: '在库', sold: '已售', returning: '退货中', renting: '租赁中', reserved: '已预留',
  returned: '已退货', after_sale: '售后中', on_way: '在途', custom: '自定义状态',
};

function destination(row: InventoryExportRow) {
  if (row.status === 'after_sale') return row.afterSaleStockStatus === 'stored' ? '售后暂存 · 不计入正式库存' : '售后处理中 · 待收机或处理';
  if (row.status === 'sold') return row.saleChannel ? `已交付 · ${row.saleChannel}` : '已销售出库';
  if (row.status === 'renting') return '租赁出库 · 待归还';
  if (row.status === 'returning') return `供应商退货办理中 · ${row.supplierName || '原供应商'}`;
  if (row.status === 'returned') return `已退回 · ${row.supplierName || '原供应商'}`;
  if (row.status === 'custom') return row.customStatusLocation || '已登记自定义状态';
  return row.warehouseName || '原归属仓库';
}

export function inventoryExportValue(key: InventoryTableColumnKey, row: InventoryExportRow) {
  const status = row.customStatusName && (row.status === 'custom' || row.status === 'returning')
    ? `${row.status === 'returning' ? '退货中 · ' : ''}${row.customStatusName}`
    : STATUS_LABELS[row.status] || row.status || '未知';
  const configurations = [row.cpu, row.ram, row.storage, row.gpu, row.screen, row.touchScreen ? '触屏' : ''].filter(Boolean).join(' · ');
  const remarks = [row.remark && `机器备注：${row.remark}`, row.skuRemark && `SKU备注：${row.skuRemark}`].filter(Boolean).join('；');
  const source = [row.supplierName, row.purchaseNo].filter(Boolean).join(' · ');
  const serial = [row.sn, row.itemNumber && `编号：${row.itemNumber}`].filter(Boolean).join(' · ');
  const inbound = `${row.inboundDate || '-'} · 库龄 ${Number(row.inboundDays || 0)} 天`;
  const values: Record<InventoryTableColumnKey, unknown> = {
    machine: formatProductName(row, '未命名商品'), productType: row.productType, brand: row.brand, model: row.model, year: row.year,
    configuration: configurations, cpu: row.cpu, ram: row.ram, storage: row.storage, gpu: row.gpu, screen: row.screen,
    touchScreen: row.touchScreen == null ? '' : Number(row.touchScreen) ? '是' : '否',
    remarks, machineRemark: row.remark, skuRemark: row.skuRemark, serial, sn: row.sn, itemNumber: row.itemNumber,
    source, supplier: row.supplierName, purchaseNo: row.purchaseNo, warehouse: row.warehouseName,
    purchasePrice: row.purchasePrice, status: `${status} · ${destination(row)}`, statusOnly: status, destination: destination(row),
    inbound, inboundDate: row.inboundDate, inboundDays: row.inboundDays,
  };
  return values[key] ?? '';
}

function csvCell(value: unknown) {
  const text = value == null ? '' : String(value);
  const safe = typeof value === 'string' && /^[\t\r\n ]*[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

export function inventoryRowsToCsv(rows: InventoryExportRow[], columns: InventoryTableColumnKey[]) {
  const labels = new Map(INVENTORY_EXPORT_COLUMNS.map(column => [column.key, column.label]));
  return `\ufeff${[columns.map(key => csvCell(labels.get(key) || key)), ...rows.map(row => columns.map(key => csvCell(inventoryExportValue(key, row))))]
    .map(line => line.join(',')).join('\r\n')}`;
}
