type AfterSalesWorkflowRecord = {
  resolutionType: string;
  status: string;
  stockStatus?: string | null;
  reservedReplacementId?: string | null;
  replacementInventoryId?: string | null;
  shippedReplacementTrackingNo?: string | null;
  createdAt?: string | null;
  createdByName?: string | null;
  receivedAt?: string | null;
  receivedByName?: string | null;
  stockReceivedAt?: string | null;
  processingAt?: string | null;
  processingByName?: string | null;
  resolvedAt?: string | null;
};

export const AFTER_SALES_TYPES = [
  { value: 'repair', label: '维修' },
  { value: 'exchange', label: '换货' },
  { value: 'customer_return', label: '退货退款' },
] as const;

export function afterSalesTypeLabel(type: string) {
  return AFTER_SALES_TYPES.find(item => item.value === type)?.label ?? '类型未记录';
}

export function needsAfterSalesOriginalDisposition(record: AfterSalesWorkflowRecord) {
  return record.resolutionType === 'exchange' && record.status === 'resolved' && record.stockStatus === 'stored';
}

function originalMachineLocation(record: AfterSalesWorkflowRecord) {
  if (record.stockStatus === 'stored') return '在售后暂存';
  if (record.stockStatus === 'restocked') return '已转正式库存';
  if (record.status === 'created') return '尚未签收';
  if (record.status === 'resolved') {
    if (record.resolutionType === 'repair') return '已归还客户';
    if (record.resolutionType === 'customer_return') return '已转正式库存';
  }
  if (record.status === 'cancelled') {
    if (record.stockStatus === 'released') return record.resolutionType === 'exchange' ? '已归还客户' : '已解除暂存，去向未记录';
    if (!record.receivedAt && !record.stockReceivedAt) return '未登记签收';
  }
  return '机器去向未记录';
}

function workflowStep(record: AfterSalesWorkflowRecord) {
  const { resolutionType: type, status, reservedReplacementId } = record;
  if (status === 'created') return {
    stage: 'awaiting_receipt',
    label: '待签收',
    action: '确认收件',
    instruction: '实际收到机器后核对 SN，再确认收件。确认后机器进入售后暂存，机器状况可稍后补填。',
  } as const;

  if (status === 'received' || status === 'processing') {
    if (type === 'repair') return status === 'received' ? {
      stage: 'awaiting_repair',
      label: '待维修',
      action: '开始维修',
      instruction: '机器已签收。接手维修时确认开始，可同时填写交接备注。',
    } as const : {
      stage: 'repairing',
      label: '维修中',
      action: '确认已归还客户',
      instruction: '维修期间可保存进展。修好且实际归还客户后，再确认归还；机器恢复已售状态。',
    } as const;

    if (type === 'exchange') return reservedReplacementId ? {
      stage: 'awaiting_shipment',
      label: '替换机待发货',
      action: '登记替换机发货',
      instruction: '实际寄出后，核对替换机 SN 和寄出运单号。确认只会将替换机出库，原机继续留在售后暂存。',
    } as const : {
      stage: 'awaiting_replacement',
      label: '待预留替换机',
      action: '选择替换机',
      instruction: '从可用库存选择要寄给客户的机器。预留后机器仍在仓，其他业务暂不能占用。',
    } as const;

    if (type === 'customer_return') return status === 'received' ? {
      stage: 'awaiting_refund_review',
      label: '待核对退货',
      action: '开始核对退货',
      instruction: '接手时开始核对实物与原销售记录。当前动作只记录处理人，尚未确认退款或恢复库存。',
    } as const : {
      stage: 'awaiting_refund_completion',
      label: '待确认退款与入库',
      action: '确认退款并恢复库存',
      instruction: '确认已收到实物、检查合格并在原渠道完成退款后再操作。系统记录退款并恢复正式库存；不会代为付款。',
    } as const;
  }

  if (needsAfterSalesOriginalDisposition(record)) return {
    stage: 'awaiting_original_disposition',
    label: '替换机已发，原机待检查',
    action: '检查原机',
    instruction: '替换机已经出库。原机仍需检修时继续留在暂存；只有检查合格后才确认转入正式库存。',
  } as const;

  if (status === 'resolved') {
    if (type === 'repair') return { stage: 'resolved', label: '已归还客户', action: '查看结果', instruction: '维修工单已结束，可查看归还结果。' } as const;
    if (type === 'exchange') return { stage: 'resolved', label: '换货已办结', action: '查看结果', instruction: '工单已结束，可查看替换机发货记录与原机去向。' } as const;
    if (type === 'customer_return') return { stage: 'resolved', label: '退货退款已办结', action: '查看结果', instruction: '系统已记录退货结果，可查看退款记录和机器库存去向。' } as const;
    return { stage: 'resolved', label: '已办结', action: '查看结果', instruction: '可查看此历史工单已记录的结果。' } as const;
  }
  if (status === 'cancelled') return { stage: 'cancelled', label: '已取消', action: '查看记录', instruction: '此工单已取消，可查看取消记录。' } as const;
  return { stage: 'unknown', label: '进度未记录', action: '查看记录', instruction: '请查看此历史工单已记录的信息。' } as const;
}

function fallbackActivity(record: AfterSalesWorkflowRecord) {
  const created = { event: '登记售后', at: record.createdAt, by: record.createdByName };
  const received = { event: '确认收件', at: record.receivedAt ?? record.stockReceivedAt, by: record.receivedByName };
  switch (record.status) {
    case 'created': return created;
    case 'received': return received;
    case 'processing': return {
      event: record.resolutionType === 'repair' ? '开始维修'
        : record.resolutionType === 'customer_return' ? '开始核对退货'
        : record.resolutionType === 'exchange' && record.reservedReplacementId ? '预留替换机' : '开始处理',
      at: record.processingAt,
      by: record.processingByName,
    };
    case 'resolved': return {
      event: record.resolutionType === 'repair' ? '确认已归还客户'
        : record.resolutionType === 'customer_return' ? '退货退款办结'
        : record.resolutionType === 'exchange' && (record.shippedReplacementTrackingNo || record.replacementInventoryId) ? '换货发出' : '办结',
      at: record.resolvedAt,
      by: undefined,
    };
    case 'cancelled': return { event: '取消售后', at: record.resolvedAt, by: undefined };
    default: return created;
  }
}

export function getAfterSalesWorkflow(record: AfterSalesWorkflowRecord) {
  return {
    typeLabel: afterSalesTypeLabel(record.resolutionType),
    machineLocation: originalMachineLocation(record),
    ...workflowStep(record),
    ...fallbackActivity(record),
  };
}
