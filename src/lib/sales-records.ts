import type Database from 'better-sqlite3';
import { formatProductName } from '@/lib/product-name';
import { formatCPUDisplay, formatGPUDisplay, formatScreenDisplay } from '@/lib/sku-display';

type Row = Record<string, unknown>;
export interface SalesFilters { search: string; dateFrom: string; dateTo: string; channel: string; warehouseId: string; status: string; }
export interface SalesMachine {
  id: string; recordId: string; recordNo: string; saleDate: string; outboundAt: string; saleChannel: string; saleOrderNo: string; trackingNo: string;
  status: string; inventoryId: string; sn: string; product: string; config: string; warehouseId: string; warehouseName: string;
  sellingPrice: number; purchasePrice: number; profit: number; itemType: 'sale' | 'exchange'; afterSaleId: string; originalInventoryId: string; actorName: string; remark: string;
}
export interface SalesOrder {
  id: string; recordNo: string; saleDate: string; saleChannel: string; saleOrderNo: string; trackingNo: string; status: string; actorName: string;
  quantity: number; amount: number; cost: number; profit: number; exchangeQuantity: number; cancelReason: string; cancelledAt: string; remark: string; items: SalesMachine[];
}
export interface SalesSummary { quantity: number; amount: number; cost: number; profit: number; orders: number; exchangeQuantity: number; }
const text = (value: unknown) => value === null || value === undefined ? '' : String(value);
const number = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : 0;
function object(value: unknown): Row { try { const parsed = typeof value === 'string' ? JSON.parse(value) : value; return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Row : {}; } catch { return {}; } }
function items(value: unknown): Row[] { try { const parsed = typeof value === 'string' ? JSON.parse(value) : value; return Array.isArray(parsed) ? parsed.filter(item => item && typeof item === 'object') as Row[] : []; } catch { return []; } }
const present = (row: Row) => Object.fromEntries(Object.entries(row).filter(([,value]) => value !== undefined && value !== null && value !== ''));
const deliveryType = (row: Row) => row.itemType === 'exchange' || row.afterSaleId ? 'exchange' : 'sale';
const deliveryKey = (row: Row) => [row.inventoryId || row.id,deliveryType(row),row.afterSaleId || ''].join('|');
function mergeSaleLines(legacy: Row[], normalized: Row[]) {
  const result = new Map<string,Row>();
  for (const line of legacy) {const key=deliveryKey(line);if(!result.has(key))result.set(key,line);}
  for (const row of normalized) {
    const snapshot=object(row.snapshot), merged={...present(snapshot),...present(row)};
    let key=deliveryKey(merged);
    // Early normalization migrations did not copy exchange markers. An unambiguous JSON
    // delivery is authoritative for its type; default 'sale' must not turn it into new revenue.
    if(!result.has(key)&&!merged.afterSaleId&&merged.itemType!=='exchange') {
      const candidates=[...result.entries()].filter(([,line])=>text(line.inventoryId||line.id)===text(merged.inventoryId||merged.id));
      if(candidates.length===1&&deliveryType(candidates[0][1])==='exchange') {
        const [legacyKey,legacyLine]=candidates[0];
        merged.itemType='exchange';merged.afterSaleId=legacyLine.afterSaleId;merged.originalInventoryId=legacyLine.originalInventoryId;key=legacyKey;
      }
    }
    result.set(key,{...present(result.get(key)||{}),...merged,itemType:deliveryType(merged)});
  }
  return [...result.values()];
}
export function salesProduct(item: Row) {
  return formatProductName({ brand: text(item.brand), model: text(item.model), year: text(item.year) }, '历史机型未记录');
}
export function readSalesFilters(params: URLSearchParams): SalesFilters {
  const result = { search: (params.get('search') || '').trim(), dateFrom: params.get('dateFrom') || '', dateTo: params.get('dateTo') || '', channel: params.get('channel') || '', warehouseId: params.get('warehouseId') || '', status: params.get('status') || '' };
  for (const value of [result.dateFrom, result.dateTo]) if (value && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value)) || new Date(value).toISOString().slice(0,10) !== value)) throw new Error('销售日期格式无效');
  if (result.dateFrom && result.dateTo && result.dateFrom > result.dateTo) throw new Error('开始日期不能晚于结束日期');
  if (result.status && !['completed', 'cancelled'].includes(result.status)) throw new Error('销售状态无效');
  return result;
}

/** Read snapshots once, before attaching one-to-many after-sales or movements. Never use live inventory prices. */
export function querySalesRecords(db: Database.Database, filters: SalesFilters) {
  const where = ['sr.deleted = 0']; const values: string[] = [];
  if (filters.dateFrom) { where.push('sr.saleDate >= ?'); values.push(filters.dateFrom); }
  if (filters.dateTo) { where.push('sr.saleDate <= ?'); values.push(filters.dateTo); }
  if (filters.channel) { where.push('sr.saleChannel = ?'); values.push(filters.channel); }
  if (filters.status) { where.push("COALESCE(sr.status,'completed') = ?"); values.push(filters.status); }
  const base = `FROM sales_records sr WHERE ${where.join(' AND ')}`;
  const records = db.prepare(`SELECT sr.*, COALESCE(u.realName,u.username,'未记录') AS actorName FROM sales_records sr LEFT JOIN users u ON u.id = sr.createdBy WHERE ${where.join(' AND ')} ORDER BY sr.saleDate DESC, sr.createdAt DESC, sr.id DESC`).all(...values) as Row[];
  const normalized = db.prepare(`SELECT si.*, COALESCE(au.realName,au.username) AS exchangeActorName FROM sales_record_items si LEFT JOIN after_sale_records ar ON ar.id=si.afterSaleId LEFT JOIN users au ON au.id=ar.createdBy WHERE si.salesRecordId IN (SELECT sr.id ${base}) ORDER BY si.createdAt, si.id`).all(...values) as Row[];
  const grouped = new Map<string, Row[]>();
  for (const line of normalized) { const list = grouped.get(text(line.salesRecordId)) || []; list.push(line); grouped.set(text(line.salesRecordId), list); }
  const warehouses = db.prepare('SELECT id, COALESCE(name,warehouseName) AS name FROM warehouses ORDER BY isDefault DESC, createdAt').all() as Array<{ id: string; name: string }>;
  const warehouseNames = new Map(warehouses.map(row => [row.id, row.name]));
  const machines: SalesMachine[] = [];
  const orders: SalesOrder[] = [];
  const terms = filters.search.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  for (const record of records) {
    const legacy = items(record.items);
    const rows = grouped.get(text(record.id)) || [];
    // Match legacy JSON to normalized entries by delivery identity, not SN alone (the same SN can be sold again).
    const sources = mergeSaleLines(legacy,rows);
    const matching: SalesMachine[] = [];
    for (const [index, source] of sources.entries()) {
      const warehouseId = text(source.warehouseId);
      if (filters.warehouseId && warehouseId !== filters.warehouseId) continue;
      const itemType = deliveryType(source);
      const product = salesProduct(source);
      const config = [formatCPUDisplay(text(source.cpu)), text(source.ram), text(source.storage), formatGPUDisplay(text(source.gpu)), formatScreenDisplay(text(source.screen))].filter(Boolean).join(' / ') || '历史配置未记录';
      const searchable = [source.sn, product, config, source.gpu, record.recordNo, record.saleOrderNo, record.trackingNo, record.saleChannel].map(text).join(' ').toLocaleLowerCase();
      if (!terms.every(term => searchable.includes(term))) continue;
      const line: SalesMachine = {
        id: text(source.id) || `${record.id}:${index}`, recordId: text(record.id), recordNo: text(record.recordNo), saleDate: text(record.saleDate), outboundAt: itemType === 'exchange' ? text(source.createdAt) || text(record.createdAt) : text(record.saleDate),
        saleChannel: text(record.saleChannel), saleOrderNo: text(record.saleOrderNo), trackingNo: text(record.trackingNo), status: text(record.status) || 'completed', inventoryId: text(source.inventoryId || source.id), sn: text(source.sn), product, config,
        warehouseId, warehouseName: warehouseNames.get(warehouseId) || '未记录', sellingPrice: number(source.sellingPrice), purchasePrice: number(source.purchasePrice), profit: source.profit == null ? number(source.sellingPrice) - number(source.purchasePrice) : number(source.profit),
        itemType, afterSaleId: text(source.afterSaleId), originalInventoryId: text(source.originalInventoryId), actorName: text(itemType === 'exchange' ? source.exchangeActorName || record.actorName : record.actorName), remark: text(source.remark),
      };
      matching.push(line); machines.push(line);
    }
    if (!matching.length) continue;
    const saleLines = matching.filter(line => line.itemType === 'sale');
    orders.push({ id: text(record.id), recordNo: text(record.recordNo), saleDate: text(record.saleDate), saleChannel: text(record.saleChannel), saleOrderNo: text(record.saleOrderNo), trackingNo: text(record.trackingNo), status: text(record.status) || 'completed', actorName: text(record.actorName), quantity: saleLines.length, amount: saleLines.reduce((sum,line) => sum + line.sellingPrice,0), cost: saleLines.reduce((sum,line) => sum + line.purchasePrice,0), profit: saleLines.reduce((sum,line) => sum + line.profit,0), exchangeQuantity: matching.length - saleLines.length, cancelReason: text(record.cancelReason), cancelledAt: text(record.cancelledAt), remark: text(record.remark), items: matching });
  }
  const summary = summarizeSales(machines);
  const groups = (key: 'saleDate' | 'saleChannel') => {
    const buckets = new Map<string, SalesMachine[]>();
    for (const line of machines) { const value = line[key]; const bucket = buckets.get(value) || []; bucket.push(line); buckets.set(value, bucket); }
    return Array.from(buckets, ([name, lines]) => ({ name, ...summarizeSales(lines) })).sort((a,b) => key === 'saleDate' ? b.name.localeCompare(a.name) : b.amount - a.amount);
  };
  const channels = (db.prepare('SELECT DISTINCT saleChannel AS name FROM sales_records WHERE deleted=0 ORDER BY saleChannel').all() as Array<{name: string}>).map(row => row.name);
  return { machines, orders, summary, byDate: groups('saleDate'), byChannel: groups('saleChannel'), warehouses, channels };
}
/** Suggestions come from every retained sale snapshot, including machines since returned or re-sold. */
export function salesSuggestions(db: Database.Database, query: string) {
  const history=querySalesRecords(db,{search:query,dateFrom:'',dateTo:'',channel:'',warehouseId:'',status:''});
  const unique=new Map<string,SalesMachine>();
  for(const line of history.machines) {const key=line.inventoryId||line.sn;if(!unique.has(key))unique.set(key,line);}
  const current=new Map((db.prepare(`SELECT i.id,i.status,w.name AS warehouseName,d.name AS customStatusName,d.color AS customStatusColor FROM inventory i LEFT JOIN warehouses w ON w.id=i.warehouseId LEFT JOIN inventory_status_records r ON r.id=i.currentStatusRecordId LEFT JOIN inventory_status_definitions d ON d.id=r.definitionId`).all() as Row[]).map(row=>[text(row.id),row]));
  const q=query.toLocaleLowerCase();
  const rank=(sn:string)=>sn.toLocaleLowerCase()===q?0:sn.toLocaleLowerCase().endsWith(q)?1:2;
  return [...unique.values()].sort((a,b)=>rank(a.sn)-rank(b.sn)||b.saleDate.localeCompare(a.saleDate)).map(line=>{
    const live=current.get(line.inventoryId);
    return {id:line.inventoryId||line.id,sn:line.sn,brand:'',model:line.product,cpu:line.config,warehouseName:live?.warehouseName||line.warehouseName,status:live?.status||'历史机器',customStatusName:live?.customStatusName||null,customStatusColor:live?.customStatusColor||null};
  });
}
export function summarizeSales(lines: SalesMachine[]): SalesSummary {
  const effective = lines.filter(line => line.status === 'completed' && line.itemType === 'sale');
  return { quantity: effective.length, amount: effective.reduce((sum,line) => sum + line.sellingPrice,0), cost: effective.reduce((sum,line) => sum + line.purchasePrice,0), profit: effective.reduce((sum,line) => sum + line.profit,0), orders: new Set(effective.map(line => line.recordId)).size, exchangeQuantity: lines.filter(line => line.itemType === 'exchange' && line.status === 'completed').length };
}
export function salesRecordDetail(db: Database.Database, id: string) {
  const all = querySalesRecords(db, { search:'',dateFrom:'',dateTo:'',channel:'',warehouseId:'',status:'' });
  const order = all.orders.find(row => row.id === id || row.recordNo === id);
  if (!order) return null;
  const afterSales = db.prepare(`SELECT a.*, ri.sn AS replacementSn FROM after_sale_records a LEFT JOIN inventory ri ON ri.id=a.replacementInventoryId WHERE a.salesRecordId=? AND a.deleted=0 ORDER BY a.createdAt, a.id`).all(order.id);
  const machineIds = [...new Set(order.items.map(line => line.inventoryId).filter(Boolean))];
  const movements = machineIds.length ? db.prepare(`SELECT m.*, COALESCE(u.realName,u.username,'未记录') AS actorName, COALESCE(fw.name,fw.warehouseName) AS fromWarehouseName, COALESCE(tw.name,tw.warehouseName) AS toWarehouseName FROM inventory_movements m LEFT JOIN users u ON u.id=m.actorId LEFT JOIN warehouses fw ON fw.id=m.fromWarehouseId LEFT JOIN warehouses tw ON tw.id=m.toWarehouseId WHERE m.inventoryId IN (${machineIds.map(() => '?').join(',')}) ORDER BY m.createdAt DESC, m.rowid DESC`).all(...machineIds) : [];
  return { order, afterSales, movements };
}

export function salesCsv(result: ReturnType<typeof querySalesRecords>, view: string) {
  const header = view === 'orders' ? ['销售日期','销售单号','平台单号','渠道','快递单号','状态','原始销售台数','原始售价合计','原始成本合计','原始毛利合计','换货交付台数','操作人','有效销售台数','计入销售额','计入出库成本','计入出库毛利'] : ['出库时间','销售单号','平台单号','渠道','快递单号','SN','机器','配置快照','出库仓库','交付类型','状态','售价快照','成本快照','毛利快照','操作人','有效销售台数','计入销售额','计入出库成本','计入出库毛利'];
  const rows = view === 'orders' ? result.orders.map(row => {const effective=row.status==='completed';return [row.saleDate,row.recordNo,row.saleOrderNo,row.saleChannel,row.trackingNo,row.status === 'cancelled' ? '已撤销':'有效',row.quantity,row.amount,row.cost,row.profit,row.exchangeQuantity,row.actorName,effective?row.quantity:0,effective?row.amount:0,effective?row.cost:0,effective?row.profit:0];}) : result.machines.map(row => {const effective=row.status==='completed'&&row.itemType==='sale';return [row.outboundAt,row.recordNo,row.saleOrderNo,row.saleChannel,row.trackingNo,row.sn,row.product,row.config,row.warehouseName,row.itemType === 'exchange' ? '换货交付（不计销售额）':'销售出库',row.status === 'cancelled' ? '已撤销':'有效',row.sellingPrice,row.purchasePrice,row.profit,row.actorName,effective?1:0,effective?row.sellingPrice:0,effective?row.purchasePrice:0,effective?row.profit:0];});
  // Quoting alone does not stop spreadsheet formula execution.
  const cell = (value: unknown) => { let valueText = text(value); if (/^[=+@\-\t\r]/.test(valueText)) valueText = `'${valueText}`; return `"${valueText.replaceAll('"','""')}"`; };
  return '\ufeff' + [header,...rows].map(row => row.map(cell).join(',')).join('\r\n');
}

