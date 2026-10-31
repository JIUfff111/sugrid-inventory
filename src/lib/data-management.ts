import db from '@/lib/db';
import { generateId, formatDateTime } from '@/lib/api-helpers';
import { hashPassword } from '@/lib/auth';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type DataResource = {
  key: string;
  label: string;
  table: string;
  fields: string[];
  writable: string[];
  searchFields: string[];
  orderBy: string;
  required?: string[];
  deletable?: boolean;
  hardDeletable?: boolean;
  creatable?: boolean;
};

/** Client supplied table names never reach SQL; every resource is defined here. */
export const DATA_RESOURCES: Record<string, DataResource> = {
  users: {
    key: 'users', label: '用户资料', table: 'users',
    fields: ['id', 'username', 'realName', 'role', 'status', 'isSystemAccount', 'createdAt', 'updatedAt', 'deletedAt', 'deletedBy'],
    writable: ['realName', 'role', 'status'], searchFields: ['username', 'realName', 'role', 'status'], orderBy: 'createdAt DESC', required: ['username', 'role', 'status'],
  },
  warehouses: {
    key: 'warehouses', label: '仓库', table: 'warehouses',
    fields: ['id', 'code', 'name', 'warehouseCode', 'warehouseName', 'address', 'remark', 'status', 'isDefault', 'createdBy', 'createdAt', 'updatedAt'],
    writable: ['name', 'address', 'remark', 'status'], searchFields: ['code', 'name', 'warehouseName', 'address', 'status'], orderBy: 'createdAt DESC', required: ['code', 'name', 'status'],
  },
  user_warehouses: {
    key: 'user_warehouses', label: '仓库权限', table: 'user_warehouses',
    fields: ['id', 'userId', 'warehouseId', 'createdBy', 'createdAt'],
    writable: ['userId', 'warehouseId'], searchFields: ['id', 'userId', 'warehouseId'], orderBy: 'createdAt DESC',
    required: ['userId', 'warehouseId'], hardDeletable: true,
  },
  suppliers: {
    key: 'suppliers', label: '供应商', table: 'suppliers',
    fields: ['id', 'supplierName', 'contactPerson', 'contactPhone', 'address', 'remark', 'status', 'deleted', 'createdBy', 'createdAt', 'updatedAt'],
    writable: ['supplierName', 'contactPerson', 'contactPhone', 'address', 'remark', 'status', 'deleted'], searchFields: ['supplierName', 'contactPerson', 'contactPhone', 'status'], orderBy: 'createdAt DESC', required: ['supplierName', 'status'],
  },
  sales_channels: {
    key: 'sales_channels', label: '销售渠道', table: 'sales_channels',
    fields: ['id', 'channelName', 'channelType', 'contactInfo', 'remark', 'status', 'usageCount', 'deleted', 'createdBy', 'createdAt', 'updatedAt'],
    writable: ['channelName', 'channelType', 'contactInfo', 'remark', 'status', 'deleted'], searchFields: ['channelName', 'channelType', 'status'], orderBy: 'createdAt DESC', required: ['channelName', 'status'],
  },
  skus: {
    key: 'skus', label: '内置 SKU', table: 'skus',
    fields: ['id', 'productType', 'brand', 'model', 'year', 'cpuOptions', 'ramOptions', 'gpuOptions', 'storageOptions', 'screenOptions', 'priceMin', 'priceMax', 'deleted', 'createdBy', 'createdAt', 'updatedAt'],
    writable: ['productType', 'brand', 'model', 'year', 'cpuOptions', 'ramOptions', 'gpuOptions', 'storageOptions', 'screenOptions', 'priceMin', 'priceMax', 'deleted'], searchFields: ['productType', 'brand', 'model', 'year'], orderBy: 'updatedAt DESC', required: ['productType', 'brand', 'model'],
  },
  manual_skus: {
    key: 'manual_skus', label: '手工 SKU', table: 'manual_skus',
    fields: ['id', 'productType', 'brand', 'model', 'year', 'isActive', 'deleted', 'createdBy', 'updatedBy', 'createdAt', 'updatedAt'],
    writable: ['productType', 'brand', 'model', 'year', 'isActive', 'deleted'], searchFields: ['productType', 'brand', 'model', 'year'], orderBy: 'updatedAt DESC', required: ['productType', 'brand', 'model'],
  },
  purchase_orders: {
    key: 'purchase_orders', label: '采购单', table: 'purchase_orders',
    fields: ['id', 'purchaseNo', 'supplierOrderNo', 'supplierId', 'supplierName', 'purchaseDate', 'purchasedBy', 'totalAmount', 'totalQuantity', 'isInbounded', 'remark', 'deleted', 'createdBy', 'createdAt', 'updatedAt'],
    writable: ['supplierOrderNo', 'remark'], deletable: false, creatable: false, searchFields: ['purchaseNo', 'supplierOrderNo', 'supplierName', 'purchaseDate', 'remark'], orderBy: 'createdAt DESC', required: ['purchaseNo', 'supplierId', 'supplierName', 'purchaseDate', 'purchasedBy'],
  },
  purchase_items: {
    key: 'purchase_items', label: '采购明细', table: 'purchase_items',
    fields: ['id', 'purchaseOrderId', 'productType', 'brand', 'model', 'year', 'cpu', 'ram', 'gpu', 'storage', 'screen', 'touchScreen', 'sn', 'purchasePrice', 'skuRemark', 'remark', 'skuId', 'manualSkuId', 'recordedBy', 'deleted', 'createdAt'],
    writable: ['skuRemark', 'remark'], creatable: false, searchFields: ['sn', 'brand', 'model', 'purchaseOrderId'], orderBy: 'createdAt DESC', required: ['purchaseOrderId', 'productType', 'brand', 'model', 'cpu', 'ram', 'storage', 'screen', 'sn', 'purchasePrice'],
  },
  inventory: {
    key: 'inventory', label: '库存机器', table: 'inventory',
    fields: ['id', 'purchaseOrderId', 'purchaseItemId', 'sn', 'productType', 'brand', 'model', 'year', 'cpu', 'ram', 'gpu', 'storage', 'screen', 'touchScreen', 'purchasePrice', 'supplierId', 'supplierName', 'status', 'warehouseId', 'inboundDate', 'soldDate', 'sellingPrice', 'saleChannel', 'saleOrderNo', 'profit', 'rentalRecordId', 'remark', 'skuRemark', 'manualSkuId', 'deleted', 'createdAt', 'updatedAt'],
    writable: ['remark', 'skuRemark'], deletable: false, creatable: false, searchFields: ['sn', 'brand', 'model', 'year', 'cpu', 'ram', 'gpu', 'storage', 'screen', 'supplierName', 'status', 'saleOrderNo'], orderBy: 'createdAt DESC', required: ['purchaseOrderId', 'purchaseItemId', 'sn', 'productType', 'brand', 'model', 'cpu', 'ram', 'storage', 'screen', 'purchasePrice', 'supplierId', 'supplierName', 'status', 'inboundDate'],
  },
  sales_records: {
    key: 'sales_records', label: '销售记录', table: 'sales_records',
    fields: ['id', 'recordNo', 'saleChannel', 'saleOrderNo', 'saleDate', 'items', 'totalQuantity', 'totalCost', 'totalAmount', 'totalProfit', 'remark', 'deleted', 'createdBy', 'createdAt', 'trackingNo', 'status', 'cancelledAt', 'cancelledBy', 'cancelReason'],
    writable: ['remark'], deletable: false, creatable: false, searchFields: ['recordNo', 'saleChannel', 'saleOrderNo', 'saleDate', 'trackingNo', 'status'], orderBy: 'createdAt DESC', required: ['recordNo', 'saleChannel', 'saleOrderNo', 'saleDate', 'items'],
  },
  sales_record_items: {
    key: 'sales_record_items', label: '销售明细', table: 'sales_record_items',
    fields: ['id', 'salesRecordId', 'saleRecordId', 'inventoryId', 'sn', 'purchasePrice', 'sellingPrice', 'profit', 'warehouseId', 'snapshot', 'afterSaleId', 'itemType', 'originalInventoryId', 'remark', 'createdAt'],
    writable: ['remark'], deletable: false, creatable: false, searchFields: ['sn', 'salesRecordId', 'inventoryId', 'itemType'], orderBy: 'createdAt DESC', required: ['salesRecordId', 'inventoryId', 'sn'],
  },
  rental_records: {
    key: 'rental_records', label: '租赁记录', table: 'rental_records',
    fields: ['id', 'rentalNo', 'inventoryId', 'sn', 'brand', 'model', 'config', 'purchasePrice', 'customerName', 'customerPhone', 'customerAddress', 'rentalStartDate', 'rentalEndDate', 'rentalType', 'rentalUnitPrice', 'rentalDuration', 'rentalTotalPrice', 'deposit', 'status', 'returnDate', 'returnType', 'sellingPrice', 'priceDifference', 'saleChannel', 'saleOrderNo', 'salesRecordId', 'remark', 'deleted', 'createdBy', 'createdAt', 'updatedAt'],
    writable: ['remark'], deletable: false, creatable: false, searchFields: ['rentalNo', 'sn', 'brand', 'model', 'customerName', 'customerPhone', 'status'], orderBy: 'createdAt DESC', required: ['rentalNo', 'inventoryId', 'sn', 'brand', 'model', 'config', 'purchasePrice', 'customerName', 'customerPhone', 'customerAddress', 'rentalStartDate', 'rentalEndDate', 'rentalType', 'rentalUnitPrice', 'rentalDuration', 'rentalTotalPrice', 'deposit'],
  },
  after_sale_records: {
    key: 'after_sale_records', label: '售后记录', table: 'after_sale_records',
    fields: ['id', 'afterSaleNo', 'inventoryId', 'sn', 'salesRecordId', 'saleOrderNo', 'customerName', 'customerPhone', 'issueType', 'issueDescription', 'resolutionType', 'replacementInventoryId', 'status', 'refundAmount', 'resolutionNote', 'resolvedAt', 'deleted', 'createdBy', 'createdAt', 'updatedAt', 'receivedAt', 'receivedBy', 'receivedCondition', 'receivedNote'],
    writable: ['resolutionNote'], deletable: false, creatable: false, searchFields: ['afterSaleNo', 'sn', 'saleOrderNo', 'customerName', 'customerPhone', 'issueType', 'status'], orderBy: 'createdAt DESC', required: ['afterSaleNo', 'inventoryId', 'sn', 'customerName', 'customerPhone', 'issueType', 'resolutionType'],
  },
  after_sale_stock: {
    key: 'after_sale_stock', label: '售后暂存', table: 'after_sale_stock',
    fields: ['id', 'afterSaleId', 'afterSaleRecordId', 'inventoryId', 'stockStatus', 'receivedAt', 'receivedBy', 'condition', 'note', 'createdAt', 'updatedAt'],
    writable: ['condition', 'note'], deletable: false, creatable: false, searchFields: ['inventoryId', 'afterSaleId', 'stockStatus', 'condition'], orderBy: 'createdAt DESC', required: ['afterSaleId', 'inventoryId', 'stockStatus'],
  },
  return_orders: {
    key: 'return_orders', label: '供应商退货', table: 'return_orders',
    fields: ['id', 'returnNo', 'items', 'purchaseOrderId', 'purchaseOrderNo', 'supplierId', 'supplierName', 'returnReason', 'returnDescription', 'refundAmount', 'status', 'completedAt', 'deleted', 'createdBy', 'createdAt', 'updatedAt'],
    writable: ['returnDescription'], deletable: false, creatable: false, searchFields: ['returnNo', 'purchaseOrderNo', 'supplierName', 'returnReason', 'status'], orderBy: 'createdAt DESC', required: ['returnNo', 'items', 'purchaseOrderId', 'purchaseOrderNo', 'supplierId', 'supplierName', 'returnReason', 'refundAmount'],
  },
  return_receipts: {
    key: 'return_receipts', label: '退货入库凭证', table: 'return_receipts',
    fields: ['id', 'receiptNo', 'returnOrderId', 'returnId', 'inventoryId', 'sn', 'status', 'receivedAt', 'receivedBy', 'condition', 'note', 'createdAt', 'salesRecordId', 'warehouseId', 'purchasePrice', 'reason', 'snapshot'],
    writable: ['condition', 'note'], deletable: false, creatable: false, searchFields: ['receiptNo', 'sn', 'inventoryId', 'status', 'reason'], orderBy: 'createdAt DESC', required: ['receiptNo', 'status'],
  },
  transfers: {
    key: 'transfers', label: '调拨单', table: 'transfers',
    fields: ['id', 'transferNo', 'sourceWarehouseId', 'targetWarehouseId', 'status', 'remark', 'createdBy', 'approvedBy', 'approvedAt', 'completedAt', 'createdAt', 'updatedAt'],
    writable: ['remark'], deletable: false, creatable: false, searchFields: ['transferNo', 'sourceWarehouseId', 'targetWarehouseId', 'status'], orderBy: 'createdAt DESC', required: ['transferNo', 'sourceWarehouseId', 'targetWarehouseId', 'status'],
  },
  transfer_items: {
    key: 'transfer_items', label: '调拨明细', table: 'transfer_items',
    fields: ['id', 'transferId', 'inventoryId', 'sn', 'status', 'remark', 'createdAt', 'updatedAt'],
    writable: ['remark'], deletable: false, creatable: false, searchFields: ['transferId', 'inventoryId', 'sn', 'status'], orderBy: 'createdAt DESC', required: ['transferId', 'inventoryId', 'sn', 'status'],
  },
  inventory_status_definitions: {
    key: 'inventory_status_definitions', label: '库存状态定义', table: 'inventory_status_definitions',
    fields: ['id', 'name', 'color', 'allowStockOperations', 'isActive', 'createdBy', 'updatedBy', 'createdAt', 'updatedAt'],
    writable: ['name', 'color', 'allowStockOperations', 'isActive'], searchFields: ['name', 'color'], orderBy: 'createdAt DESC', required: ['name', 'color'],
  },
  inventory_status_records: {
    key: 'inventory_status_records', label: '库存状态记录', table: 'inventory_status_records',
    fields: ['id', 'inventoryId', 'definitionId', 'definitionSnapshot', 'reason', 'location', 'responsiblePerson', 'expectedReturnDate', 'remark', 'warehouseId', 'createdBy', 'createdAt', 'closedAt', 'closedBy', 'resultNote', 'closingReferenceType', 'closingReferenceId'],
    writable: ['remark', 'resultNote'], deletable: false, creatable: false, searchFields: ['inventoryId', 'reason', 'location', 'responsiblePerson'], orderBy: 'createdAt DESC', required: ['inventoryId', 'definitionId', 'definitionSnapshot', 'reason', 'location', 'responsiblePerson', 'warehouseId', 'createdBy'],
  },
  label_templates: {
    key: 'label_templates', label: '标签模板', table: 'label_templates',
    fields: ['id', 'templateName', 'templateType', 'width', 'height', 'orientation', 'fields', 'isDefault', 'deleted', 'createdBy', 'createdAt', 'updatedAt'],
    writable: ['templateName', 'templateType', 'width', 'height', 'orientation', 'fields', 'isDefault', 'deleted'], searchFields: ['templateName', 'templateType', 'orientation'], orderBy: 'createdAt DESC', required: ['templateName', 'templateType', 'width', 'height', 'orientation', 'fields'],
  },
  login_events: {
    key: 'login_events', label: '登录记录', table: 'login_events',
    fields: ['id', 'userId', 'username', 'result', 'browser', 'os', 'createdAt'],
    writable: [], searchFields: ['userId', 'username', 'result', 'browser', 'os'], orderBy: 'createdAt DESC',
  },
  inventory_movements: {
    key: 'inventory_movements', label: '机器生命周期', table: 'inventory_movements',
    fields: ['id', 'inventoryId', 'sn', 'warehouseId', 'fromWarehouseId', 'toWarehouseId', 'movementType', 'statusFrom', 'statusTo', 'referenceType', 'referenceId', 'actorId', 'note', 'snapshot', 'createdAt'],
    writable: [], searchFields: ['inventoryId', 'sn', 'movementType', 'referenceType', 'referenceId', 'actorId', 'note'], orderBy: 'createdAt DESC',
  },
  data_management_audit: {
    key: 'data_management_audit', label: '数据操作记录', table: 'data_management_audit',
    fields: ['id', 'actorId', 'action', 'resource', 'recordId', 'recordCount', 'fileName', 'fileSha256', 'summary', 'createdAt'],
    writable: [], searchFields: ['actorId', 'action', 'resource', 'recordId', 'fileName'], orderBy: 'createdAt DESC',
  },
};

export const DATA_RESOURCE_KEYS = Object.keys(DATA_RESOURCES);
const SENSITIVE_FIELDS = new Set(['password', 'passwordhash', 'token', 'tokenhash', 'sessiontoken', 'rawtoken', 'accesstoken', 'refreshtoken', 'secret', 'sessioncookie', 'cookie']);

function isSensitiveField(key: string) {
  return SENSITIVE_FIELDS.has(key.replace(/[^a-z0-9]/gi, '').toLowerCase());
}

export function getResource(key: string) {
  return DATA_RESOURCES[key];
}

function sanitizeNested(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(item => sanitizeNested(item));
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      if (!isSensitiveField(key)) output[key] = sanitizeNested(nested);
    }
    return output;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try { return JSON.stringify(sanitizeNested(JSON.parse(trimmed))); } catch { /* keep opaque text unchanged */ }
    }
  }
  return value;
}

function nestedSensitivePaths(value: unknown, path: string): string[] {
  if (Array.isArray(value)) return value.flatMap((item, index) => nestedSensitivePaths(item, `${path}[${index}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, nested]) => isSensitiveField(key)
      ? [`${path}.${key}`]
      : nestedSensitivePaths(nested, `${path}.${key}`));
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try { return nestedSensitivePaths(JSON.parse(trimmed), path); } catch { /* keep opaque text unchanged */ }
    }
  }
  return [];
}

export function sanitizeRow(row: Record<string, unknown>) {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) if (!isSensitiveField(key)) output[key] = sanitizeNested(value);
  return output;
}

export function sanitizeRecord(record: Record<string, unknown>, resource: DataResource) {
  const output: Record<string, unknown> = {};
  for (const field of resource.fields) {
    if (!isSensitiveField(field) && Object.prototype.hasOwnProperty.call(record, field)) output[field] = sanitizeNested(record[field]);
  }
  return output;
}

export function normalizeValue(value: unknown) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

export function listResource(resource: DataResource, query: URLSearchParams) {
  const page = Math.max(1, Number.parseInt(query.get('page') || '1', 10) || 1);
  const pageSize = Math.min(100, Math.max(1, Number.parseInt(query.get('pageSize') || '20', 10) || 20));
  const { whereSql, params } = resourceWhere(resource, query);
  const total = Number((db.prepare(`SELECT COUNT(*) AS total FROM ${resource.table} ${whereSql}`).get(...params) as { total: number }).total || 0);
  const offset = (Math.min(page, Math.max(1, Math.ceil(total / pageSize))) - 1) * pageSize;
  const rows = db.prepare(`SELECT ${resource.fields.join(',')} FROM ${resource.table} ${whereSql} ORDER BY ${resource.orderBy} LIMIT ? OFFSET ?`).all(...params, pageSize, offset) as Record<string, unknown>[];
  return { items: rows.map(sanitizeRow), total, page: Math.floor(offset / pageSize) + 1, pageSize, totalPages: Math.ceil(total / pageSize) };
}

export function resourceWhere(resource: DataResource, query: URLSearchParams) {
  const where: string[] = [];
  const params: unknown[] = [];
  const search = query.get('search')?.trim() || '';
  if (search && resource.searchFields.length) {
    where.push('(' + resource.searchFields.map((field) => `CAST(${field} AS TEXT) LIKE ?`).join(' OR ') + ')');
    params.push(...resource.searchFields.map(() => `%${search}%`));
  }
  if (resource.fields.includes('deleted') && query.get('includeDeleted') !== '1') where.push('deleted = 0');
  if (resource.key === 'users' && query.get('includeDeleted') !== '1') where.push("status <> 'deleted'");
  for (const field of ['status', 'deleted', 'warehouseId'] as const) {
    const value = query.get(field);
    if (value !== null && value !== '' && resource.fields.includes(field)) { where.push(`${field} = ?`); params.push(value); }
  }
  const dateField = ['purchaseDate', 'saleDate', 'rentalStartDate', 'inboundDate', 'receivedAt', 'completedAt', 'createdAt', 'updatedAt']
    .find(field => resource.fields.includes(field));
  const dateFrom = query.get('dateFrom')?.trim();
  const dateTo = query.get('dateTo')?.trim();
  if (dateField && dateFrom) { where.push(`date(${dateField}) >= date(?)`); params.push(dateFrom); }
  if (dateField && dateTo) { where.push(`date(${dateField}) <= date(?)`); params.push(dateTo); }
  return { whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

export function recordExists(resource: DataResource, id: string) {
  return Boolean(db.prepare(`SELECT 1 FROM ${resource.table} WHERE id = ?`).get(id));
}

export function validateRecord(resource: DataResource, raw: Record<string, unknown>, mode: 'insert' | 'upsert' = 'insert') {
  const errors: string[] = [];
  for (const field of resource.required || []) {
    if ((mode === 'insert' || Object.prototype.hasOwnProperty.call(raw, field)) && (raw[field] === undefined || raw[field] === null || String(raw[field]).trim() === '')) errors.push(`缺少必填字段 ${field}`);
  }
  for (const field of Object.keys(raw)) {
    if (!resource.fields.includes(field) || isSensitiveField(field)) errors.push(`字段 ${field} 不允许导入`);
  }
  return errors;
}

/**
 * Import-only checks.  The generic resource API intentionally accepts a
 * field-shaped object, but an import must fail loudly when a file contains a
 * misspelled column, an authentication field, a duplicate natural key, or a
 * reference that cannot be resolved.  Silently dropping those fields would
 * make a migration appear successful while losing data.
 */
const IMPORT_UNIQUE_FIELDS: Record<string, string[]> = {
  users: ['username'],
  warehouses: ['code'],
  suppliers: ['supplierName'],
  sales_channels: ['channelName'],
  purchase_orders: ['purchaseNo'],
  purchase_items: ['sn'],
  inventory: ['sn'],
  sales_records: ['recordNo'],
  rental_records: ['rentalNo'],
  after_sale_records: ['afterSaleNo'],
  return_orders: ['returnNo'],
  return_receipts: ['receiptNo'],
  transfers: ['transferNo'],
  inventory_status_definitions: ['name'],
};

const IMPORT_FOREIGN_KEYS: Record<string, Record<string, { table: string; column?: string }>> = {
  user_warehouses: { userId: { table: 'users' }, warehouseId: { table: 'warehouses' }, createdBy: { table: 'users' } },
  warehouses: { createdBy: { table: 'users' } },
  suppliers: { createdBy: { table: 'users' } },
  sales_channels: { createdBy: { table: 'users' } },
  skus: { createdBy: { table: 'users' } },
  manual_skus: { createdBy: { table: 'users' }, updatedBy: { table: 'users' } },
  purchase_orders: { supplierId: { table: 'suppliers' }, purchasedBy: { table: 'users' }, createdBy: { table: 'users' } },
  purchase_items: {
    purchaseOrderId: { table: 'purchase_orders' }, skuId: { table: 'skus' },
    manualSkuId: { table: 'manual_skus' }, recordedBy: { table: 'users' },
  },
  inventory: {
    purchaseOrderId: { table: 'purchase_orders' }, purchaseItemId: { table: 'purchase_items' },
    supplierId: { table: 'suppliers' }, warehouseId: { table: 'warehouses' }, manualSkuId: { table: 'manual_skus' },
  },
  sales_records: { createdBy: { table: 'users' } },
  sales_record_items: {
    salesRecordId: { table: 'sales_records' }, saleRecordId: { table: 'sales_records' },
    inventoryId: { table: 'inventory' }, afterSaleId: { table: 'after_sale_records' }, originalInventoryId: { table: 'inventory' },
  },
  rental_records: { inventoryId: { table: 'inventory' }, salesRecordId: { table: 'sales_records' }, createdBy: { table: 'users' } },
  after_sale_records: {
    inventoryId: { table: 'inventory' }, salesRecordId: { table: 'sales_records' },
    replacementInventoryId: { table: 'inventory' }, createdBy: { table: 'users' },
  },
  after_sale_stock: {
    afterSaleId: { table: 'after_sale_records' }, afterSaleRecordId: { table: 'after_sale_records' },
    inventoryId: { table: 'inventory' }, receivedBy: { table: 'users' },
  },
  return_orders: { purchaseOrderId: { table: 'purchase_orders' }, supplierId: { table: 'suppliers' }, createdBy: { table: 'users' } },
  return_receipts: {
    returnOrderId: { table: 'return_orders' }, returnId: { table: 'return_orders' }, inventoryId: { table: 'inventory' },
    salesRecordId: { table: 'sales_records' }, warehouseId: { table: 'warehouses' }, receivedBy: { table: 'users' },
  },
  transfers: {
    sourceWarehouseId: { table: 'warehouses' }, targetWarehouseId: { table: 'warehouses' },
    createdBy: { table: 'users' }, approvedBy: { table: 'users' },
  },
  transfer_items: { transferId: { table: 'transfers' }, inventoryId: { table: 'inventory' } },
  inventory_status_definitions: { createdBy: { table: 'users' }, updatedBy: { table: 'users' } },
  inventory_status_records: {
    inventoryId: { table: 'inventory' }, definitionId: { table: 'inventory_status_definitions' },
    warehouseId: { table: 'warehouses' }, createdBy: { table: 'users' }, closedBy: { table: 'users' },
  },
  label_templates: { createdBy: { table: 'users' } },
  login_events: { userId: { table: 'users' } },
};

type ImportValidationContext = {
  mode: 'insert' | 'upsert';
  incomingIds: Map<string, Set<string>>;
  seenUnique: Map<string, Map<string, Map<string, string>>>;
  payloadRecords?: Map<string, Map<string, Record<string, unknown>>>;
};

function nonEmptyImportValue(value: unknown) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

export function validateImportRecord(
  resource: DataResource,
  raw: Record<string, unknown>,
  context: ImportValidationContext,
) {
  const errors = validateRecord(resource, raw, context.mode);
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  for (const [field, value] of Object.entries(raw)) {
    const paths = nestedSensitivePaths(value, field);
    for (const sensitivePath of paths) errors.push(`字段 ${sensitivePath} 包含认证敏感信息，不允许导入`);
  }

  for (const field of IMPORT_UNIQUE_FIELDS[resource.key] || []) {
    if (!nonEmptyImportValue(raw[field])) continue;
    const value = String(raw[field]).trim();
    const seenForResource = context.seenUnique.get(resource.key) || new Map<string, Map<string, string>>();
    const seenForField = seenForResource.get(field) || new Map<string, string>();
    const previousId = seenForField.get(value);
    if (previousId && previousId !== id) errors.push(`字段 ${field} 在导入文件中重复：${value}`);
    seenForResource.set(field, seenForField);
    context.seenUnique.set(resource.key, seenForResource);
    if (!previousId) seenForField.set(value, id || `row:${seenForField.size}`);

    const existing = db.prepare(`SELECT id FROM ${resource.table} WHERE ${field} = ?`).get(value) as { id?: string } | undefined;
    if (existing && !(context.mode === 'upsert' && id && existing.id === id)) {
      errors.push(`字段 ${field} 已存在：${value}`);
    }
  }

  for (const [field, foreignKey] of Object.entries(IMPORT_FOREIGN_KEYS[resource.key] || {})) {
    if (!nonEmptyImportValue(raw[field])) continue;
    const value = String(raw[field]).trim();
    const incoming = context.incomingIds.get(foreignKey.table);
    const existsInPayload = incoming?.has(value) || false;
    const existsInDatabase = Boolean(db.prepare(`SELECT 1 FROM ${foreignKey.table} WHERE id = ?`).get(value));
    if (!existsInPayload && !existsInDatabase) errors.push(`字段 ${field} 引用不存在的 ${foreignKey.table}：${value}`);
  }
  if (resource.key === 'user_warehouses' && nonEmptyImportValue(raw.warehouseId)) {
    const warehouseId = String(raw.warehouseId).trim();
    const incomingWarehouse = context.payloadRecords?.get('warehouses')?.get(warehouseId);
    const warehouse = incomingWarehouse || db.prepare('SELECT status FROM warehouses WHERE id = ?').get(warehouseId) as { status?: string } | undefined;
    if (warehouse && warehouse.status !== 'active') errors.push('只能给账号分配启用中的仓库');
  }
  if (resource.key === 'user_warehouses' && nonEmptyImportValue(raw.userId)) {
    const userId = String(raw.userId).trim();
    const incomingUser = context.payloadRecords?.get('users')?.get(userId);
    const user = incomingUser || db.prepare('SELECT role FROM users WHERE id = ?').get(userId) as { role?: string } | undefined;
    if (user?.role === 'admin') errors.push('管理员已拥有全部仓库权限，无需单独分配');
  }

  return [...new Set(errors)];
}

export type ExistingManagedUser = {
  id: string;
  role: string;
  status: string;
  isSystemAccount: number;
};

/** Shared user invariants for the data-management write and import paths. */
export function validateManagedUserMutation(data: Record<string, unknown>, existing?: ExistingManagedUser, hasIncomingWarehouseAssignment = false) {
  const errors: string[] = [];
  if (data.username !== undefined) {
    const username = String(data.username).trim();
    if (username.length < 3 || username.length > 64) errors.push('账号长度应为 3-64 个字符');
    if (!/^[\p{L}\p{N}._-]+$/u.test(username)) errors.push('账号只能包含中文、字母、数字、点、下划线或短横线');
    const conflict = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE AND id <> ?').get(username, existing?.id || '') as { id: string } | undefined;
    if (conflict) errors.push('账号已存在');
  }
  if (data.role !== undefined && !['admin', 'warehouse_manager'].includes(String(data.role))) errors.push('角色不受支持');
  if (data.status !== undefined && !['active', 'pending', 'rejected', 'disabled', 'deleted'].includes(String(data.status))) errors.push('账号状态不受支持');
  if (existing?.isSystemAccount && (data.role !== undefined || data.status !== undefined)) {
    if (data.role !== undefined && String(data.role) !== existing.role) errors.push('内置系统管理员的角色不能修改');
    if (data.status !== undefined && String(data.status) !== existing.status) errors.push('内置系统管理员的状态不能修改');
  }
  const role = String(data.role ?? existing?.role ?? 'warehouse_manager');
  const status = String(data.status ?? existing?.status ?? 'pending');
  if (role === 'warehouse_manager' && status === 'active' && existing && !hasIncomingWarehouseAssignment) {
    const assignment = db.prepare('SELECT COUNT(*) AS count FROM user_warehouses WHERE userId = ?').get(existing.id) as { count: number };
    if (!Number(assignment.count)) errors.push('分仓管启用前必须分配至少一个仓库');
  }
  if (existing && existing.role === 'admin' && existing.status === 'active' &&
      ((data.role !== undefined && String(data.role) !== 'admin') || (data.status !== undefined && String(data.status) !== 'active'))) {
    const admins = Number((db.prepare("SELECT COUNT(*) AS total FROM users WHERE role = 'admin' AND status = 'active'").get() as { total: number }).total || 0);
    if (admins <= 1) errors.push('必须保留至少一个有效管理员');
  }
  return errors;
}

export function writeAudit(actorId: string, action: string, resource: string, recordId: string | null, details: Record<string, unknown> = {}) {
  db.prepare(`INSERT INTO data_management_audit (id,actorId,action,resource,recordId,recordCount,fileName,fileSha256,summary,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(generateId('data_audit'), actorId, action, resource, recordId, Number(details.recordCount || 0), details.fileName || null, details.fileSha256 || null, JSON.stringify(details), formatDateTime());
}

export async function createBackup(actorId: string, reason: string) {
  const dbPath = process.env.INVENTORY_DB_PATH || path.join(process.cwd(), 'data', 'inventory.db');
  const backupDir = path.join(path.dirname(dbPath), 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const fileName = `inventory-${reason}-${new Date().toISOString().replace(/[:.]/g, '-')}.db`;
  const backupPath = path.join(backupDir, fileName);
  const backupFn = (db as unknown as { backup?: (destination: string) => Promise<void> }).backup;
  if (typeof backupFn !== 'function') throw new Error('当前 SQLite 驱动不支持安全备份');
  await backupFn.call(db, backupPath);
  const digest = createHash('sha256').update(fs.readFileSync(backupPath)).digest('hex');
  writeAudit(actorId, 'backup', 'database', null, { fileName, fileSha256: digest, reason });
  return { fileName, path: backupPath, sha256: digest };
}

export function parseCsv(text: string): Record<string, unknown>[] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { cell += '"'; i += 1; }
      else quoted = !quoted;
    } else if (char === ',' && !quoted) { row.push(cell); cell = ''; }
    else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell); if (row.some((value) => value !== '')) rows.push(row); row = []; cell = '';
    } else cell += char;
  }
  if (cell || row.length) { row.push(cell); if (row.some((value) => value !== '')) rows.push(row); }
  const headers = (rows.shift() || []).map((header, index) => index === 0 ? header.replace(/^\uFEFF/, '') : header);
  return rows.map((values) => Object.fromEntries(headers.map((key, index) => [key, values[index] ?? ''])));
}

export function deletionReferences(resource: DataResource, id: string) {
  const relations: Record<string, Array<{ table: string; field: string; label: string }>> = {
    suppliers: [{ table: 'purchase_orders', field: 'supplierId', label: '采购单' }],
    warehouses: [
      { table: 'inventory', field: 'warehouseId', label: '库存机器' },
      { table: 'transfers', field: 'sourceWarehouseId', label: '调拨单（来源仓）' },
      { table: 'transfers', field: 'targetWarehouseId', label: '调拨单（目标仓）' },
      { table: 'user_warehouses', field: 'warehouseId', label: '账号仓库权限' },
    ],
    skus: [{ table: 'purchase_items', field: 'skuId', label: '采购明细' }],
    manual_skus: [
      { table: 'purchase_items', field: 'manualSkuId', label: '采购明细' },
      { table: 'inventory', field: 'manualSkuId', label: '库存机器' },
    ],
    purchase_orders: [
      { table: 'purchase_items', field: 'purchaseOrderId', label: '采购明细' },
      { table: 'inventory', field: 'purchaseOrderId', label: '库存机器' },
      { table: 'return_orders', field: 'purchaseOrderId', label: '供应商退货' },
    ],
    sales_records: [
      { table: 'sales_record_items', field: 'salesRecordId', label: '销售明细' },
      { table: 'rental_records', field: 'salesRecordId', label: '租赁记录' },
      { table: 'after_sale_records', field: 'salesRecordId', label: '售后记录' },
      { table: 'return_receipts', field: 'salesRecordId', label: '客户退货凭证' },
    ],
    after_sale_records: [
      { table: 'after_sale_stock', field: 'afterSaleId', label: '售后暂存记录' },
      { table: 'sales_record_items', field: 'afterSaleId', label: '换货交付明细' },
    ],
    return_orders: [
      { table: 'return_receipts', field: 'returnOrderId', label: '退货入库凭证' },
      { table: 'return_receipts', field: 'returnId', label: '退货入库凭证' },
    ],
    transfers: [{ table: 'transfer_items', field: 'transferId', label: '调拨明细' }],
    inventory_status_definitions: [{ table: 'inventory_status_records', field: 'definitionId', label: '机器状态记录' }],
  };
  const found: Array<{ label: string; count: number }> = [];
  for (const relation of relations[resource.key] || []) {
    const count = Number((db.prepare(`SELECT COUNT(*) AS total FROM ${relation.table} WHERE ${relation.field} = ?`).get(id) as { total: number }).total || 0);
    if (count) found.push({ label: relation.label, count });
  }
  return found;
}

export function toCsv(rows: Record<string, unknown>[]) {
  const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const escape = (value: unknown) => {
    const text = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return '\uFEFF' + [headers, ...rows.map((row) => headers.map((header) => row[header]))].map((line) => line.map(escape).join(',')).join('\r\n');
}

export function importPayload(resourceKey: string | null, content: unknown) {
  if (typeof content === 'string') {
    const trimmed = content.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return importPayload(resourceKey, JSON.parse(trimmed));
      } catch {
        // Invalid JSON can still be a CSV file whose first cell starts with a brace.
      }
    }
    if (resourceKey && getResource(resourceKey)) return [{ resource: resourceKey, records: parseCsv(content) }];
    return [];
  }
  if (Array.isArray(content)) {
    return resourceKey && getResource(resourceKey) ? [{ resource: resourceKey, records: content }] : [];
  }
  if (typeof content === 'object' && content !== null && !Array.isArray(content)) {
    const bundle = content as Record<string, unknown>;
    if (resourceKey) {
      const resources = bundle.resources && typeof bundle.resources === 'object' ? bundle.resources as Record<string, unknown> : null;
      const selected = resources?.[resourceKey];
      if (Array.isArray(selected)) return [{ resource: resourceKey, records: selected }];
      return [{ resource: resourceKey, records: Array.isArray(bundle.records) ? bundle.records : [bundle] }];
    }
    return Object.entries(bundle.resources || bundle).filter(([key, value]) => getResource(key) && Array.isArray(value)).map(([resource, records]) => ({ resource, records: records as unknown[] }));
  }
  return [];
}

export function userImportDefaults(resource: DataResource, data: Record<string, unknown>) {
  if (resource.key !== 'users') return data;
  return { ...data, isSystemAccount: 0, status: 'pending', password: hashPassword(randomBytes(24).toString('base64url')) };
}

export function dbIntegrityErrors() {
  const foreignKeys = db.pragma('foreign_key_check') as unknown[];
  const integrity = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
  return { foreignKeys, integrity, ok: foreignKeys.length === 0 && integrity.every((row) => row.integrity_check === 'ok') };
}

