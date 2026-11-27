import { useCallback, useEffect, useRef, useState } from "react";
import { InventoryUpdates, type InventoryCache } from "./InventoryUpdates";
import {
  databaseIntegrityLabel,
  formatBeijingDate,
  formatDateInTimeZone,
  operationKindLabel,
  operationStageLabel,
  operationStateLabel,
  pausesUpdaterPolling,
  serviceHealthLabel,
  serviceStateLabel,
  timeZoneLabel,
} from "./manager-display";
import { Badge, Button, FluentProvider, Spinner, webLightTheme } from "@fluentui/react-components";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import {
  Activity,
  AlertCircle,
  ArrowDownToLine,
  CheckCircle2,
  Database,
  ExternalLink,
  FileClock,
  HardDrive,
  LayoutDashboard,
  LoaderCircle,
  Play,
  RefreshCw,
  ScrollText,
  Server,
  Settings,
  ShieldCheck,
  Square,
} from "lucide-react";
import "./integrated.css";

type PageKey = "overview" | "service" | "database" | "updates" | "logs" | "settings";
type IconComponent = typeof LayoutDashboard;

interface BackupSummary {
  name: string;
  size: number;
  modifiedAt: number;
  verified: boolean;
  canExport: boolean;
}

interface OperationSummary {
  operationId: string | null;
  kind: string;
  stage: string;
  state: string;
  error: string | null;
  inventoryVersion: string | null;
  startedAt: number | null;
  finishedAt: number | null;
}

interface BackupScheduleSummary {
  time: string;
  timeZone: string;
  nextRunAt: number | null;
  lastRunAt: number | null;
}

interface DatabaseCheck {
  integrity: string;
  foreignKeyViolations: number;
  checkedAt: number;
}

interface Dashboard {
  managerVersion: string;
  serviceHostVersion: string | null;
  inventoryVersion: string | null;
  updaterAvailable: boolean;
  canManage: boolean;
  serviceInstalled: boolean;
  serviceState: string;
  servicePid: number | null;
  healthy: boolean;
  serviceUrl: string;
  port: number;
  databasePath: string;
  databaseExists: boolean;
  databaseIntegrity: string;
  operationHistory: OperationSummary[];
  operationHistoryError: string | null;
  backupSchedule: BackupScheduleSummary | null;
  backupDirectory: string;
  backups: BackupSummary[];
  statusMessage: string;
}

interface UpdateInfo {
  currentVersion: string;
  latestVersion: string | null;
  releaseUrl: string | null;
  releaseNotes: string | null;
  installerAvailable: boolean;
  updateAvailable: boolean;
  message: string;
}

interface UpdaterStatus {
  available: boolean;
  canManage: boolean;
  updaterProtocol: number | null;
  inventoryVersion: string | null;
  operationId: string | null;
  stage: string | null;
  state: string | null;
  backupName: string | null;
  error: string | null;
  operationHistoryError: string | null;
}

const NAV: Array<{ key: PageKey; title: string; icon: IconComponent }> = [
  { key: "overview", title: "概览", icon: LayoutDashboard },
  { key: "service", title: "库存服务", icon: Server },
  { key: "database", title: "数据库与备份", icon: Database },
  { key: "updates", title: "版本更新", icon: ArrowDownToLine },
  { key: "logs", title: "运行状态", icon: ScrollText },
  { key: "settings", title: "固定配置", icon: Settings },
];

const TITLES: Record<PageKey, string> = {
  overview: "服务概览",
  service: "库存服务",
  database: "数据库与备份",
  updates: "版本更新",
  logs: "运行状态",
  settings: "固定配置",
};

function formatSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function errorText(error: unknown) {
  return typeof error === "string" ? error : error instanceof Error ? error.message : "操作失败，请查看本机服务日志。";
}

export function IntegratedApp() {
  const [page, setPage] = useState<PageKey>("overview");
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [databaseCheck, setDatabaseCheck] = useState<DatabaseCheck | null>(null);
  const [inventoryCache, setInventoryCache] = useState<InventoryCache>({ state: "idle", version: null, message: "正在读取本机缓存状态。" });
  const [prefetchBusy, setPrefetchBusy] = useState(false);
  const cacheReadOnLaunch = useRef(false);
  const prefetchOnLaunch = useRef(false);
  const cacheRequestId = useRef(0);
  const pollingPaused = useRef(false);
  const maintenanceAvailable = Boolean(dashboard?.canManage && !dashboard.operationHistoryError);

  const refresh = useCallback(async (quiet = false) => {
    if (quiet && pollingPaused.current) return;
    if (!quiet) setBusy("refresh");
    try {
      const next = await invoke<Dashboard>("integrated_dashboard");
      if (!pollingPaused.current) setDashboard(next);
      if (!quiet) setError("");
    } catch (reason) {
      if (!quiet) setError(errorText(reason));
    } finally {
      if (!quiet) setBusy("");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(true), 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const prefetchInventory = useCallback(async () => {
    const requestId = ++cacheRequestId.current;
    setPrefetchBusy(true);
    setInventoryCache((previous) => ({ state: "checking", version: previous.version, message: "正在查找并下载最新正式库存包，当前库存服务不会中断。" }));
    try {
      const result = await invoke<InventoryCache>("integrated_prefetch_inventory");
      if (requestId === cacheRequestId.current) setInventoryCache(result);
    } catch (reason) {
      if (requestId === cacheRequestId.current) setInventoryCache({ state: "failed", version: null, message: errorText(reason) });
    } finally {
      if (requestId === cacheRequestId.current) setPrefetchBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!dashboard) return;
    if (dashboard.updaterAvailable && !dashboard.inventoryVersion && !prefetchOnLaunch.current) {
      prefetchOnLaunch.current = true;
      cacheReadOnLaunch.current = true;
      void prefetchInventory();
    } else if (!cacheReadOnLaunch.current) {
      cacheReadOnLaunch.current = true;
      const requestId = ++cacheRequestId.current;
      void invoke<InventoryCache>("integrated_cached_inventory")
        .then((result) => { if (requestId === cacheRequestId.current) setInventoryCache(result); })
        .catch((reason) => { if (requestId === cacheRequestId.current) setInventoryCache({ state: "failed", version: null, message: errorText(reason) }); });
    }
  }, [dashboard, prefetchInventory]);

  async function runAction(label: string, action: () => Promise<Dashboard>) {
    setBusy(label);
    setError("");
    setNotice("");
    try {
      const next = await action();
      setDashboard(next);
      setNotice(label === "backup" ? "数据库备份已创建并完成校验。" : label === "restore" ? "数据库已恢复，服务健康检查通过。" : label === "start" ? "库存服务已启动并通过健康检查。" : "库存服务已停止。");
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy("");
    }
  }

  async function queueMaintenance(label: string, action: () => Promise<UpdaterStatus>) {
    setBusy(label);
    setError("");
    setNotice("");
    try {
      const result = await action();
      setPage("updates");
      setNotice(result.operationId ? "维护任务已开始，请查看库存版本页的进度。" : "维护操作已完成。");
      void refresh(true);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy("");
    }
  }

  async function createBackup() {
    await queueMaintenance("backup", () => invoke<UpdaterStatus>("integrated_create_backup"));
  }

  async function checkUpdate() {
    setBusy("update-check");
    setError("");
    try {
      const result = await invoke<UpdateInfo>("integrated_check_update");
      setUpdate(result);
    } catch (reason) {
      setError(errorText(reason));
      setUpdate(null);
    } finally {
      setBusy("");
    }
  }

  async function installUpdate() {
    if (!update?.latestVersion) return;
    const confirmed = window.confirm(`下载管理器版本 ${update.latestVersion} 的安装包？Windows 将要求管理员确认；现有库存包和数据库会保留。`);
    if (!confirmed) return;
    setBusy("update-install");
    setError("");
    try {
      await invoke("integrated_install_update", { version: update.latestVersion });
    } catch (reason) {
      setError(errorText(reason));
      setBusy("");
    }
  }

  async function restoreBackup(backup: BackupSummary) {
    const confirmed = window.confirm(`将数据库恢复到 ${formatBeijingDate(backup.modifiedAt)} 的备份？\n\n备份时间之后录入或修改的业务数据会从当前数据库中消失。恢复前会保存一份当前数据库，库存服务也会短暂停止。\n\n请确认已通知正在使用系统的同事。继续恢复吗？`);
    if (!confirmed) return;
    await queueMaintenance("restore", () => invoke<UpdaterStatus>("integrated_restore_backup", { name: backup.name }));
  }

  async function exportBackup(backup: BackupSummary) {
    if (!backup.verified || !dashboard?.canManage) return;
    const destination = await save({
      defaultPath: backup.name,
      filters: [{ name: "SQLite 数据库备份", extensions: ["db"] }],
    });
    if (!destination) return;
    pollingPaused.current = true;
    setBusy("backup-export");
    setError("");
    setNotice("");
    try {
      await invoke("integrated_export_backup", { name: backup.name, destination });
      setNotice("备份已导出，并通过完整性、外键和 SHA-256 校验。");
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      pollingPaused.current = false;
      setBusy("");
      void refresh(true);
    }
  }

  async function checkDatabase() {
    if (!maintenanceAvailable) return;
    pollingPaused.current = true;
    setBusy("database-check");
    setError("");
    setNotice("");
    try {
      const result = await invoke<DatabaseCheck>("integrated_check_database");
      setDatabaseCheck(result);
      setNotice(
        result.integrity === "ok" && result.foreignKeyViolations === 0
          ? "数据库完整性与外键检查均已通过。"
          : `检查完成：${databaseIntegrityLabel(result.integrity)}，发现 ${result.foreignKeyViolations} 条外键问题。`,
      );
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      pollingPaused.current = false;
      setBusy("");
      void refresh(true);
    }
  }

  async function openInventory() {
    setBusy("open-inventory");
    setError("");
    try {
      await invoke("integrated_open_inventory");
      setNotice("库存系统已在独立窗口打开。");
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy("");
    }
  }

  function renderOverview() {
    return <div className="integrated-stack">
      <section className={`integrated-service-banner ${dashboard?.healthy ? "is-healthy" : "is-warning"}`}>
        <div className="integrated-banner-icon">{dashboard?.healthy ? <CheckCircle2 size={24} /> : <AlertCircle size={24} />}</div>
        <div className="integrated-banner-copy"><span>Windows 服务 · {serviceStateLabel(dashboard?.serviceState)}</span><strong>{dashboard?.statusMessage ?? "正在连接本机服务…"}</strong></div>
        <div className="integrated-banner-actions"><Button appearance="secondary" icon={<RefreshCw size={16} />} onClick={() => void refresh()} disabled={Boolean(busy)}>刷新状态</Button>{dashboard?.canManage && dashboard.serviceInstalled && dashboard.serviceState !== "running" ? <Button appearance="primary" icon={<Play size={15} />} onClick={() => void runAction("start", () => invoke<Dashboard>("integrated_start_service"))} disabled={Boolean(busy)}>启动服务</Button> : null}</div>
      </section>
      <section className="integrated-metrics">
        <Metric icon={Server} label="库存版本" value={dashboard?.inventoryVersion ?? "旧版 · 待核验"} detail={`管理器 ${dashboard?.managerVersion ?? "—"} · 服务宿主 ${dashboard?.serviceHostVersion ?? "—"}`} />
        <Metric icon={Database} label="数据库完整性" value={dashboard ? databaseIntegrityLabel(dashboard.databaseIntegrity) : "正在读取"} detail={dashboard?.databasePath ?? "%ProgramData%\\SUGRID\\Inventory\\data\\inventory.db"} />
        <Metric icon={HardDrive} label="已验证备份" value={`${dashboard?.backups.filter((backup) => backup.verified).length ?? 0}`} detail={dashboard?.backupDirectory ?? "%ProgramData%\\SUGRID\\Inventory\\backups"} />
      </section>
      <section className="integrated-section"><div className="integrated-section-heading"><div><h2>常用操作</h2><span>直接管理本机库存服务</span></div></div><div className="integrated-action-grid">
        {dashboard?.canManage ? <ActionTile icon={dashboard?.serviceState === "running" ? Square : Play} title={dashboard?.serviceState === "running" ? "停止库存服务" : "启动库存服务"} detail={dashboard?.serviceState === "running" ? "局域网用户会暂时无法访问" : "启动 Windows 服务并检查数据库"} onClick={() => void runAction(dashboard?.serviceState === "running" ? "stop" : "start", () => invoke<Dashboard>(dashboard?.serviceState === "running" ? "integrated_stop_service" : "integrated_start_service"))} disabled={!dashboard.serviceInstalled || Boolean(busy)} /> : null}
        {dashboard?.canManage ? <ActionTile icon={HardDrive} title="创建数据库备份" detail="由后台更新服务创建 SQLite 一致性备份" onClick={() => void createBackup()} disabled={!dashboard.serviceInstalled || !maintenanceAvailable || Boolean(busy)} /> : null}
        <ActionTile icon={ExternalLink} title="打开库存系统" detail="在独立窗口打开本机库存页面" onClick={() => void openInventory()} disabled={!dashboard?.healthy || Boolean(busy)} />
        <ActionTile icon={ArrowDownToLine} title={dashboard?.inventoryVersion ? "检查库存版本" : "安装库存系统"} detail="库存系统与管理器分别发布和更新" onClick={() => setPage("updates")} disabled={Boolean(busy)} />
      </div></section>
      <section className="integrated-section"><div className="integrated-section-heading"><div><h2>最近数据库备份</h2><span>只显示文件名、大小和校验状态</span></div><Button appearance="subtle" onClick={() => setPage("database")}>查看全部</Button></div><BackupTable backups={(dashboard?.backups ?? []).slice(0, 4)} onRestore={(backup) => void restoreBackup(backup)} busy={Boolean(busy)} canRestore={maintenanceAvailable} /></section>
    </div>;
  }

  function renderService() {
    const running = dashboard?.serviceState === "running";
    return (
      <div className="integrated-stack">
        <section className="integrated-section">
          <div className="integrated-section-heading">
            <div><h2>库存业务服务</h2><span>Windows 服务随系统开机运行</span></div>
            <Badge appearance="tint" className={dashboard?.healthy ? "integrated-badge-good" : "integrated-badge-muted"}>{dashboard?.healthy ? "业务健康" : serviceStateLabel(dashboard?.serviceState)}</Badge>
          </div>
          <dl className="integrated-details">
            <div><dt>服务名称</dt><dd>SUGRIDInventory</dd></div>
            <div><dt>运行状态</dt><dd>{serviceStateLabel(dashboard?.serviceState)}</dd></div>
            <div><dt>进程 PID</dt><dd>{dashboard?.servicePid ?? "—"}</dd></div>
            <div><dt>服务端口</dt><dd>{dashboard?.port ?? 3000}</dd></div>
            <div><dt>库存版本</dt><dd>{dashboard?.inventoryVersion ?? "旧版，业务版本待核验"}</dd></div>
            <div><dt>服务宿主版本</dt><dd>{dashboard?.serviceHostVersion ?? "待核验"}</dd></div>
            <div><dt>管理器版本</dt><dd>{dashboard?.managerVersion ?? "待核验"}</dd></div>
            <div><dt>业务健康接口</dt><dd>{serviceHealthLabel(dashboard?.serviceState, dashboard?.healthy)}</dd></div>
            <div><dt>数据库完整性</dt><dd>{databaseIntegrityLabel(dashboard?.databaseIntegrity)}</dd></div>
          </dl>
          <div className="integrated-control-bar">
            {dashboard?.canManage ? <Button appearance="primary" icon={running ? <Square size={15} /> : <Play size={15} />} onClick={() => void runAction(running ? "stop" : "start", () => invoke<Dashboard>(running ? "integrated_stop_service" : "integrated_start_service"))} disabled={!dashboard.serviceInstalled || Boolean(busy)}>{running ? "停止服务" : "启动服务"}</Button> : null}
            <Button appearance="secondary" icon={<ExternalLink size={15} />} onClick={() => void openInventory()} disabled={!dashboard?.healthy || Boolean(busy)}>打开库存系统</Button>
            <Button appearance="secondary" icon={<RefreshCw size={15} />} onClick={() => void refresh()} disabled={Boolean(busy)}>检查状态</Button>
          </div>
        </section>
        <Notice icon={ShieldCheck}>服务只管理本项目的库存进程。维护操作由指定维护账号或管理员通过更新服务执行。</Notice>
      </div>
    );
  }
  function renderDatabase() {
    const canManage = Boolean(dashboard?.canManage);
    return (
      <div className="integrated-stack">
        <section className="integrated-db-summary">
          <div className="integrated-db-icon"><Database size={22} /></div>
          <div><span>当前数据库</span><strong>{dashboard?.databasePath ?? "%ProgramData%\\SUGRID\\Inventory\\data\\inventory.db"}</strong><small>{databaseCheck ? `${databaseIntegrityLabel(databaseCheck.integrity)} · 外键问题 ${databaseCheck.foreignKeyViolations} 条 · ${formatBeijingDate(databaseCheck.checkedAt)}` : dashboard ? databaseIntegrityLabel(dashboard.databaseIntegrity) : "正在读取完整性"} · 库存版本更新不会覆盖数据</small></div>
          {canManage ? <Button appearance="primary" icon={<HardDrive size={16} />} onClick={() => void createBackup()} disabled={!dashboard?.serviceInstalled || !maintenanceAvailable || Boolean(busy)}>创建备份</Button> : null}
        </section>
        <section className="integrated-section">
          <div className="integrated-section-heading"><div><h2>数据库健康检查</h2><span>只读执行 SQLite 完整性与外键检查，不修改数据库内容</span></div><Button appearance="secondary" icon={busy === "database-check" ? <LoaderCircle className="spin" size={15} /> : <ShieldCheck size={15} />} onClick={() => void checkDatabase()} disabled={Boolean(busy) || !dashboard?.databaseExists || !maintenanceAvailable}>立即检查</Button></div>
          <div className="integrated-check-result" role="status">
            <div><span>SQLite 完整性</span><strong>{databaseCheck ? databaseIntegrityLabel(databaseCheck.integrity) : "尚未执行检查"}</strong></div>
            <div><span>外键约束</span><strong>{databaseCheck ? databaseCheck.foreignKeyViolations === 0 ? "未发现问题" : `${databaseCheck.foreignKeyViolations} 条问题` : "尚未执行检查"}</strong></div>
            <div><span>最近检查</span><strong>{databaseCheck ? formatBeijingDate(databaseCheck.checkedAt) : "—"}</strong></div>
          </div>
        </section>
        <section className="integrated-section">
          <div className="integrated-section-heading"><div><h2>自动备份计划</h2><span>每日按计划时区执行；服务重启后会补做当日缺失备份</span></div><Badge appearance="tint" className="integrated-badge-muted">每日</Badge></div>
          <div className="integrated-check-result">
            <div><span>计划时间</span><strong>{dashboard?.backupSchedule ? `${dashboard.backupSchedule.time} · ${timeZoneLabel(dashboard.backupSchedule.timeZone)}` : "更新服务不可用"}</strong></div>
            <div><span>下次执行</span><strong>{dashboard?.backupSchedule?.nextRunAt ? formatDateInTimeZone(dashboard.backupSchedule.nextRunAt, dashboard.backupSchedule.timeZone) : "—"}</strong></div>
            <div><span>最近记录的自动备份</span><strong>{dashboard?.backupSchedule?.lastRunAt ? formatDateInTimeZone(dashboard.backupSchedule.lastRunAt, dashboard.backupSchedule.timeZone) : "暂无自动备份记录"}</strong></div>
          </div>
        </section>
        <section className="integrated-section">
          <div className="integrated-section-heading"><div><h2>可恢复备份</h2><span>恢复前再次备份当前数据库，并验证完整性</span></div><Button appearance="secondary" icon={<RefreshCw size={15} />} onClick={() => void refresh()} disabled={Boolean(busy)}>刷新</Button></div>
          <BackupTable backups={dashboard?.backups ?? []} onRestore={(backup) => void restoreBackup(backup)} onExport={(backup) => void exportBackup(backup)} busy={Boolean(busy)} canRestore={maintenanceAvailable} canExport={canManage} />
        </section>
        <section className="integrated-section">
          <div className="integrated-section-heading"><div><h2>最近维护记录</h2><span>最多保留 50 条；服务重启时会标记未完成操作</span></div></div>
          <OperationTable history={dashboard?.operationHistory ?? []} />
        </section>
        <Notice icon={ShieldCheck}>指定的 Windows 维护账号或管理员可创建、恢复数据库备份。操作由本机受限后台服务执行。</Notice>
      </div>
    );
  }
  function renderManagerUpdatePanel() {
    return (
      <section className="integrated-section integrated-update-panel">
        <div className="integrated-section-heading">
          <div><h2>服务器管理器</h2><span>管理器与库存系统各自发布</span></div>
          <Badge appearance="tint" className="integrated-badge-muted">当前 {dashboard?.managerVersion ?? update?.currentVersion ?? "—"}</Badge>
        </div>
        <p>{update?.message ?? "检查管理器的独立安装包。更新管理器仍需 Windows 管理员确认。"}</p>
        {update?.releaseNotes ? <pre className="integrated-release-notes">{update.releaseNotes}</pre> : null}
        <div className="integrated-control-bar">
          <Button appearance="secondary" icon={busy === "update-check" ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />} onClick={() => void checkUpdate()} disabled={Boolean(busy)}>检查管理器更新</Button>
          {update?.updateAvailable && update.installerAvailable && update.latestVersion ? <Button appearance="primary" icon={<ArrowDownToLine size={15} />} onClick={() => void installUpdate()} disabled={Boolean(busy)}>下载安装包</Button> : null}
          {update?.releaseUrl ? <Button appearance="subtle" icon={<ExternalLink size={15} />} onClick={() => window.open(update.releaseUrl!, "_blank", "noopener,noreferrer")}>查看发布记录</Button> : null}
        </div>
      </section>
    );
  }
  function renderUpdates() {
    return <div className="integrated-stack">
      <section className="integrated-version-strip" aria-label="已安装版本">
        <div><span>管理器</span><strong>{dashboard?.managerVersion ?? "读取中"}</strong></div>
        <div><span>服务宿主</span><strong>{dashboard?.serviceHostVersion ?? "旧版 · 待核验"}</strong></div>
        <div><span>库存系统</span><strong>{dashboard?.inventoryVersion ?? "旧版 · 待核验"}</strong></div>
      </section>
      <InventoryUpdates
        canManage={maintenanceAvailable}
        pollPaused={pausesUpdaterPolling(busy)}
        updaterAvailable={Boolean(dashboard?.updaterAvailable)}
        currentVersion={dashboard?.inventoryVersion ?? null}
        cache={inventoryCache}
        prefetchBusy={prefetchBusy}
        onPrefetch={prefetchInventory}
      />
      {renderManagerUpdatePanel()}
    </div>;
  }

  function renderLogs() {
    return <div className="integrated-stack"><section className="integrated-section"><div className="integrated-section-heading"><div><h2>服务诊断</h2><span>服务进程、业务健康和数据库完整性分别显示</span></div><Button appearance="secondary" icon={<RefreshCw size={15} />} onClick={() => void refresh()} disabled={Boolean(busy)}>重新检查</Button></div><div className="integrated-diagnostic-list"><Diagnostic icon={dashboard?.serviceInstalled ? CheckCircle2 : AlertCircle} label="Windows 服务安装" value={dashboard?.serviceInstalled ? "已注册" : "未安装"} good={Boolean(dashboard?.serviceInstalled)} /><Diagnostic icon={dashboard?.serviceState === "running" ? CheckCircle2 : AlertCircle} label="服务进程" value={dashboard?.serviceState === "running" ? `运行中 · PID ${dashboard.servicePid ?? "未知"}` : serviceStateLabel(dashboard?.serviceState)} good={dashboard?.serviceState === "running"} /><Diagnostic icon={dashboard?.healthy ? CheckCircle2 : AlertCircle} label="业务健康接口" value={serviceHealthLabel(dashboard?.serviceState, dashboard?.healthy)} good={Boolean(dashboard?.healthy)} /><Diagnostic icon={dashboard?.databaseIntegrity === "ok" ? CheckCircle2 : Database} label="数据库完整性" value={databaseIntegrityLabel(dashboard?.databaseIntegrity)} good={dashboard?.databaseIntegrity === "ok"} /><Diagnostic icon={Database} label="数据库路径" value={dashboard?.databasePath ?? "尚未确认"} good={Boolean(dashboard?.databaseExists)} /></div></section><Notice icon={FileClock}>服务运行日志保存在 %ProgramData%\SUGRID\Inventory\logs。真实安装环境下服务使用 LocalService 账号运行。</Notice></div>;
  }

  function renderSettings() {
    return <div className="integrated-stack"><section className="integrated-section"><div className="integrated-section-heading"><div><h2>服务器固定配置</h2><span>无需填写源码目录，也不读取仓库中的 Git 状态</span></div></div><dl className="integrated-details"><div><dt>服务类型</dt><dd>Windows 服务 · 自动启动</dd></div><div><dt>监听地址</dt><dd>0.0.0.0:{dashboard?.port ?? 3000}</dd></div><div><dt>数据库路径</dt><dd>{dashboard?.databasePath ?? "%ProgramData%\\SUGRID\\Inventory\\data\\inventory.db"}</dd></div><div><dt>数据保留路径</dt><dd>%ProgramData%\SUGRID\Inventory\data、backups、logs</dd></div><div><dt>运行账号</dt><dd>NT AUTHORITY\LocalService</dd></div></dl></section><Notice icon={Settings}>配置随一体化安装程序管理。安装更新只替换应用和服务文件，数据库、备份和日志保留在 ProgramData。</Notice></div>;
  }

  const currentTitle = TITLES[page];

  return <FluentProvider theme={webLightTheme}><div className="integrated-shell"><aside className="integrated-sidebar"><div className="integrated-brand"><img src="/brand/sugrid-wordmark.png" alt="溯格 SUGRID"/><span>服务器管理器</span></div><nav aria-label="主导航">{NAV.map(({ key, title, icon: Icon }) => <Button key={key} appearance="subtle" className={`integrated-nav-item${page === key ? " is-active" : ""}`} icon={<Icon size={18}/>} onClick={() => setPage(key)} aria-current={page === key ? "page" : undefined}>{title}</Button>)}</nav><div className="integrated-sidebar-footer"><span className={`integrated-health-dot ${dashboard?.healthy ? "is-good" : ""}`}/><div><strong>{dashboard?.healthy ? "业务健康" : "需要检查"}</strong><small>本机管理 · 不发送遥测</small></div></div></aside><main className="integrated-main"><header className="integrated-topbar"><div><span className="integrated-eyebrow">SUGRID / WINDOWS SERVER</span><h1>{currentTitle}</h1></div><div className="integrated-topbar-actions"><Badge appearance="tint" className={dashboard?.healthy ? "integrated-badge-good" : "integrated-badge-muted"}>{serviceStateLabel(dashboard?.serviceState)}</Badge><Button appearance="subtle" icon={busy === "refresh" ? <Spinner size="tiny"/> : <RefreshCw size={16}/>} onClick={() => void refresh()} disabled={Boolean(busy)} aria-label="刷新服务状态"/></div></header>{error && <div className="integrated-alert" role="alert"><AlertCircle size={17}/><span>{error}</span><button type="button" onClick={() => setError("")}>关闭</button></div>}{dashboard?.operationHistoryError && <div className="integrated-alert" role="alert"><AlertCircle size={17}/><span>维护记录无法读取或写入，最近一次操作结果可能没有保存到历史中。为保证维护过程可追踪，库存更新、数据库备份和恢复已暂停。请检查记录文件或磁盘空间，修复后刷新；系统会尝试补写最近一次操作。</span></div>}{notice && <div className="integrated-notice" role="status"><CheckCircle2 size={17}/><span>{notice}</span></div>}{page === "overview" ? renderOverview() : page === "service" ? renderService() : page === "database" ? renderDatabase() : page === "updates" ? renderUpdates() : page === "logs" ? renderLogs() : renderSettings()}<footer className="integrated-footer"><Activity size={14}/><span>固定服务端口 3000</span><span className="integrated-footer-separator">·</span><span>数据库位于 ProgramData</span></footer></main></div></FluentProvider>;
}

function Metric({ icon: Icon, label, value, detail }: { icon: IconComponent; label: string; value: string; detail: string }) {
  return <div className="integrated-metric"><span className="integrated-metric-icon"><Icon size={18}/></span><div><small>{label}</small><strong>{value}</strong><span title={detail}>{detail}</span></div></div>;
}

function ActionTile({ icon: Icon, title, detail, onClick, disabled }: { icon: IconComponent; title: string; detail: string; onClick: () => void; disabled: boolean }) {
  return <button type="button" className="integrated-action-tile" onClick={onClick} disabled={disabled}><span className="integrated-tile-icon"><Icon size={19}/></span><span className="integrated-tile-copy"><strong>{title}</strong><small>{detail}</small></span></button>;
}

function BackupTable({ backups, onRestore, onExport, busy, canRestore = true, canExport = true }: { backups: BackupSummary[]; onRestore: (backup: BackupSummary) => void; onExport?: (backup: BackupSummary) => void; busy: boolean; canRestore?: boolean; canExport?: boolean }) {
  if (!backups.length) return <div className="integrated-empty">尚无备份。首次安装及每次数据库操作前会创建备份。</div>;
  return <div className="integrated-table-scroll"><table className="integrated-table"><thead><tr><th>备份文件</th><th>创建时间</th><th>大小</th><th>完整性</th><th>操作</th></tr></thead><tbody>{backups.map((backup) => <tr key={backup.name}><td><strong className="integrated-mono">{backup.name}</strong></td><td>{formatBeijingDate(backup.modifiedAt)}</td><td>{formatSize(backup.size)}</td><td><span className={`integrated-table-state ${backup.verified ? "is-good" : "is-bad"}`}>{backup.verified ? "已验证" : "校验失败"}</span></td><td>{onExport ? <Button appearance="subtle" size="small" icon={<ArrowDownToLine size={14} />} onClick={() => onExport(backup)} disabled={busy || !canExport || !backup.canExport}>导出</Button> : null}<Button appearance="subtle" size="small" onClick={() => onRestore(backup)} disabled={busy || !canRestore || !backup.verified}>恢复</Button></td></tr>)}</tbody></table></div>;
}

function OperationTable({ history }: { history: OperationSummary[] }) {
  if (!history.length) return <div className="integrated-empty">暂无维护记录。</div>;
  return <div className="integrated-table-scroll"><table className="integrated-table integrated-history-table"><thead><tr><th>开始时间</th><th>操作</th><th>进度</th><th>结果</th><th>说明</th></tr></thead><tbody>{[...history].reverse().slice(0, 12).map((operation) => <tr key={operation.operationId ?? `${operation.kind}-${operation.startedAt}`}><td>{formatBeijingDate(operation.startedAt)}</td><td>{operationKindLabel(operation.kind)}</td><td>{operationStageLabel(operation.stage)}</td><td><span className={`integrated-table-state ${operation.state === "succeeded" ? "is-good" : operation.state === "failed" || operation.state === "recovered" ? "is-bad" : ""}`}>{operationStateLabel(operation.state)}</span></td><td className="integrated-history-detail" title={operation.error ?? operation.inventoryVersion ?? undefined}>{operation.error ?? (operation.inventoryVersion ? `库存版本 ${operation.inventoryVersion}` : "—")}</td></tr>)}</tbody></table></div>;
}

function Notice({ icon: Icon, children }: { icon: IconComponent; children: string }) {
  return <section className="integrated-notice-block"><Icon size={17}/><p>{children}</p></section>;
}

function Diagnostic({ icon: Icon, label, value, good }: { icon: IconComponent; label: string; value: string; good: boolean }) {
  return <div className="integrated-diagnostic"><Icon size={17} className={good ? "is-good" : "is-muted"}/><span>{label}</span><strong title={value}>{value}</strong></div>;
}
