import { uniqueMachineScanTokens } from '@/lib/machine-scan';

export interface InventoryFilters {
  brand?: string;
  model?: string;
  inboundFrom?: string;
  inboundTo?: string;
  productType?: string;
  cpu?: string;
  ram?: string;
  storage?: string;
  gpu?: string;
  screen?: string;
  snContains?: string;
  itemNumberContains?: string;
  remarks?: string;
  touchScreen?: string;
}

const containsFilters: Array<[keyof InventoryFilters, string]> = [
  ['productType', 'i.productType'],
  ['cpu', 'i.cpu'],
  ['ram', 'i.ram'],
  ['storage', 'i.storage'],
  ['gpu', 'i.gpu'],
  ['screen', 'i.screen'],
  ['snContains', 'i.sn'],
  ['itemNumberContains', 'i.itemNumber'],
];

const stringFilterKeys: Array<keyof InventoryFilters> = [
  'brand', 'model', 'inboundFrom', 'inboundTo', 'productType', 'cpu', 'ram', 'storage', 'gpu', 'screen',
  'snContains', 'itemNumberContains', 'remarks', 'touchScreen',
];

function containsPattern(value: string) {
  return `%${value.replaceAll('!', '!!').replaceAll('%', '!%').replaceAll('_', '!_')}%`;
}

export function inventoryFiltersFromParams(searchParams: URLSearchParams): InventoryFilters {
  return Object.fromEntries(stringFilterKeys
    .map(key => [key, searchParams.get(key)?.trim() || undefined])
    .filter(([, value]) => value !== undefined)) as InventoryFilters;
}

export function validateInventoryQuery(searchParams: URLSearchParams) {
  for (const key of ['search', 'configSearch', ...stringFilterKeys]) {
    if ((searchParams.get(key) || '').length > 200) return `${key === 'configSearch' ? '配置搜索' : '筛选条件'}不能超过 200 个字符`;
  }
  const serials = uniqueMachineScanTokens(searchParams.getAll('sn').map(value => value.trim()).filter(Boolean));
  if (serials.length > 100) return '一次最多查询 100 个 SN';
  if (serials.some(value => value.length > 200)) return 'SN 长度不能超过 200 个字符';
  if (searchParams.get('touchScreen') && !['0', '1'].includes(searchParams.get('touchScreen')!)) return '触屏筛选值无效';
  const inboundFrom = searchParams.get('inboundFrom')?.trim() || '';
  const inboundTo = searchParams.get('inboundTo')?.trim() || '';
  const validDate = (value: string) => !value || /^\d{4}-\d{2}-\d{2}$/.test(value)
    && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
  if (!validDate(inboundFrom) || !validDate(inboundTo)) return '入库日期格式无效';
  if (inboundFrom && inboundTo && inboundFrom > inboundTo) return '入库日期范围无效，请检查开始和结束日期';
  return null;
}

export function getInventoryWhere(searchParams: URLSearchParams) {
  const search = searchParams.get('search')?.trim() || '';
  const status = searchParams.get('status')?.trim() || '';
  const configSearch = searchParams.get('configSearch')?.trim() || '';
  const serials = uniqueMachineScanTokens(searchParams.getAll('sn').map(value => value.trim()).filter(Boolean));
  const filters = inventoryFiltersFromParams(searchParams);
  const where = getWhere(search, status, filters, serials, configSearch, searchParams.get('searchMode')?.trim() || '');
  const customStatusId = searchParams.get('customStatusId')?.trim();
  if (customStatusId) {
    where.clause += ' AND EXISTS (SELECT 1 FROM inventory_status_records cr WHERE cr.id=i.currentStatusRecordId AND cr.definitionId=? AND cr.closedAt IS NULL)';
    where.params.push(customStatusId);
  }
  return where;
}

export function getWhere(
  search: string,
  status: string,
  filters: InventoryFilters = {},
  serials: string[] = [],
  configSearch = '',
  searchMode = '',
): { clause: string; params: (string | number)[] } {
  const conditions = ['i.deleted = 0'];
  const params: (string | number)[] = [];

  if (serials.length) {
    const placeholders = serials.map(() => '?').join(',');
    const normalizedSerials = serials.map(value => value.toLocaleLowerCase());
    conditions.push(`(lower(i.sn) IN (${placeholders}) OR lower(COALESCE(i.itemNumber,'')) IN (${placeholders}))`);
    params.push(...normalizedSerials, ...normalizedSerials);
  } else if (search && searchMode === 'machine') {
    const pattern = containsPattern(search);
    conditions.push("(i.sn LIKE ? ESCAPE '!' OR i.itemNumber LIKE ? ESCAPE '!' OR i.brand LIKE ? ESCAPE '!' OR i.model LIKE ? ESCAPE '!' OR i.productType LIKE ? ESCAPE '!')");
    params.push(pattern, pattern, pattern, pattern, pattern);
  } else if (search) {
    const pattern = containsPattern(search);
    conditions.push(`(
      i.sn LIKE ? ESCAPE '!' OR i.itemNumber LIKE ? ESCAPE '!' OR i.brand LIKE ? ESCAPE '!' OR i.model LIKE ? ESCAPE '!' OR i.year LIKE ? ESCAPE '!' OR
      i.cpu LIKE ? ESCAPE '!' OR i.ram LIKE ? ESCAPE '!' OR i.gpu LIKE ? ESCAPE '!' OR
      i.storage LIKE ? ESCAPE '!' OR i.screen LIKE ? ESCAPE '!' OR i.supplierName LIKE ? ESCAPE '!' OR
      po.purchaseNo LIKE ? ESCAPE '!' OR i.saleOrderNo LIKE ? ESCAPE '!' OR i.remark LIKE ? ESCAPE '!' OR
      i.skuRemark LIKE ? ESCAPE '!'
    )`);
    params.push(pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern,
      pattern, pattern, pattern, pattern, pattern, pattern);
  }

  if (configSearch) {
    const terms = configSearch.split(/\s+/).filter(Boolean);
    for (const term of terms) {
      const pattern = containsPattern(term);
      conditions.push("(i.cpu LIKE ? ESCAPE '!' OR i.ram LIKE ? ESCAPE '!' OR i.storage LIKE ? ESCAPE '!' OR i.gpu LIKE ? ESCAPE '!' OR i.screen LIKE ? ESCAPE '!')");
      params.push(pattern, pattern, pattern, pattern, pattern);
    }
  }

  if (status === 'current_stock') conditions.push("i.status IN ('in_stock','custom')");
  else if (status && status !== 'all') { conditions.push('i.status = ?'); params.push(status); }

  if (filters.brand) { conditions.push('i.brand = ?'); params.push(filters.brand); }
  if (filters.model) { conditions.push('i.model = ?'); params.push(filters.model); }
  if (filters.inboundFrom) { conditions.push('date(i.inboundDate) >= date(?)'); params.push(filters.inboundFrom); }
  if (filters.inboundTo) { conditions.push('date(i.inboundDate) <= date(?)'); params.push(filters.inboundTo); }

  for (const [key, column] of containsFilters) {
    const value = filters[key];
    if (value) {
      conditions.push(`${column} LIKE ? ESCAPE '!'`);
      params.push(containsPattern(value));
    }
  }
  if (filters.remarks) {
    conditions.push("(i.remark LIKE ? ESCAPE '!' OR i.skuRemark LIKE ? ESCAPE '!')");
    const pattern = containsPattern(filters.remarks);
    params.push(pattern, pattern);
  }
  if (filters.touchScreen) {
    conditions.push('i.touchScreen = ?');
    params.push(Number(filters.touchScreen));
  }

  return { clause: `WHERE ${conditions.join(' AND ')}`, params };
}
