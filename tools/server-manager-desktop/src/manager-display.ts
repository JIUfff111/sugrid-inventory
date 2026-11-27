export function formatBeijingDate(epochSeconds: number | null | undefined): string {
  return formatDateInTimeZone(epochSeconds, "Asia/Shanghai");
}

export function formatDateInTimeZone(
  epochSeconds: number | null | undefined,
  timeZone: string | null | undefined,
): string {
  if (epochSeconds == null || !Number.isFinite(epochSeconds) || !timeZone) return "时间未记录";
  const date = new Date(epochSeconds * 1000);
  if (Number.isNaN(date.getTime())) return "时间未记录";
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
  } catch {
    return "时间未记录";
  }
  const value = (part: string) => parts.find((item) => item.type === part)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")} ${value("hour")}:${value("minute")}:${value("second")}`;
}

export function timeZoneLabel(timeZone: string | null | undefined): string {
  if (timeZone === "Asia/Shanghai") return "北京时间";
  return timeZone || "时区未确认";
}

export function serviceStateLabel(state: string | null | undefined): string {
  switch (state) {
    case "running": return "运行中";
    case "stopped": return "已停止";
    case "not_installed": return "未安装";
    case "starting": return "启动中";
    case "stopping": return "停止中";
    case "paused": return "已暂停";
    default: return "状态待确认";
  }
}

export function serviceHealthLabel(state: string | null | undefined, healthy: boolean | undefined): string {
  if (state === "running") return healthy ? "业务健康检查通过" : "进程运行，业务健康检查未通过";
  return state === "not_installed" ? "尚未安装服务" : "服务未运行";
}

export function databaseIntegrityLabel(integrity: string | null | undefined): string {
  switch (integrity) {
    case "ok": return "完整性检查通过";
    case "failed": return "完整性检查未通过";
    case "missing": return "数据库不存在";
    case "checking": return "正在检查完整性";
    default: return "完整性尚未核验";
  }
}

export function maintenanceAccess(
  dashboardAllows: boolean,
  updaterAllows: boolean | null | undefined,
  operationHistoryError: string | null | undefined,
): boolean {
  return dashboardAllows && updaterAllows !== false && !operationHistoryError;
}

export function pausesUpdaterPolling(action: string): boolean {
  return action === "database-check" || action === "backup-export";
}

export function operationKindLabel(kind: string | null | undefined): string {
  switch (kind) {
    case "inventory_update": return "库存版本更新";
    case "manual_backup": return "手动备份";
    case "automatic_backup": return "自动备份";
    case "database_restore": return "数据库恢复";
    case "service_start": return "启动库存服务";
    case "service_stop": return "停止库存服务";
    case "maintenance": return "维护操作";
    default: return "其他操作";
  }
}

export function operationStateLabel(state: string | null | undefined): string {
  switch (state) {
    case "running": return "进行中";
    case "succeeded": return "成功";
    case "failed": return "失败";
    case "cancelled": return "已取消";
    case "recovered": return "中断待核实";
    case "idle": return "待命";
    default: return "状态待确认";
  }
}

export function operationStageLabel(stage: string | null | undefined): string {
  switch (stage) {
    case "copying": return "准备更新文件";
    case "verifying": return "校验备份或安装包";
    case "backing_up": return "备份数据库";
    case "retaining": return "清理过期自动备份";
    case "migrating": return "迁移测试副本";
    case "switching": return "切换库存版本";
    case "starting": return "启动库存服务";
    case "health_check": return "检查服务健康";
    case "rolling_back": return "恢复旧版本";
    case "rolled_back": return "已恢复旧版本";
    case "complete": return "已完成";
    case "idle": return "待命";
    default: return "处理中";
  }
}
