const movementLabels: Record<string, string> = {
  asset_change: '资产配置变更',
  custom_status_start: '登记库存状态',
  custom_status_end: '结束库存状态',
  opening_balance: '历史库存初始化',
  purchase_in: '采购入库',
  purchase_inbound: '采购入库',
  sale: '销售出库',
  sale_out: '销售出库',
  sale_cancel: '撤销销售出库',
  sales_return: '客户退货入库',
  supplier_return: '供应商退货出库',
  supplier_return_out: '供应商退货出库',
  rental_out: '租赁出库',
  rental_return: '租赁归还入库',
  after_sale_created: '登记售后',
  after_sale_receive: '售后收机暂存',
  after_sale_condition: '更新售后核验信息',
  after_sale_start_processing: '开始售后处理',
  after_sale_progress: '更新售后处理进展',
  after_sale_reserve: '售后换货预留',
  after_sale_reservation_release: '解除售后换货预留',
  after_sale_release: '售后维修交付',
  after_sale_restock: '售后转正式库存',
  after_sale_cancel: '取消售后',
  exchange_in: '换货原机入库',
  exchange_out: '换货机交付',
  transfer_in: '调拨入库',
  transfer_out: '调拨出库',
};

export function inventoryMovementLabel(movementType: string | null | undefined) {
  const value = movementType?.trim() || '';
  if (!value) return '机器事件';
  return movementLabels[value] || (/^[a-z][a-z0-9_]*$/i.test(value) ? '其他机器事件' : value);
}
