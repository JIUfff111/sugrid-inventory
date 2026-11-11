import { useEffect, useMemo, useRef, useState } from "react";
import {
  Badge,
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Drawer,
  DrawerBody,
  DrawerHeader,
  DrawerHeaderTitle,
  FluentProvider,
  Input,
  webLightTheme,
} from "@fluentui/react-components";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  Activity,
  AlertCircle,
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  Check,
  CheckCircle2,
  Circle,
  Database,
  ExternalLink,
  FileClock,
  FileSearch,
  Folder,
  GitBranch,
  HardDrive,
  Info,
  LayoutDashboard,
  LoaderCircle,
  Play,
  RefreshCw,
  ScrollText,
  Server,
  Settings,
  ShieldCheck,
  Square,
  X,
  type LucideIcon,
} from "lucide-react";
import { UPDATE_STEPS, type StepStatus } from "./update-flow";

type PageKey = "overview" | "services" | "update" | "database" | "logs" | "settings";
type DialogKind = "update" | "backup" | "restore" | "stop" | "stopExternal" | null;
type Tone = "success" | "error" | "info" | "warning";

interface AppConfig {
  projectRoot: string;
  databasePath: string;
  port: number;
  host: string;
}

interface ServiceProcess {
  processId: number;
  parentProcessId: number | null;
  source: string;
  state: string;
  port: number;
  startedAt: string;
  executablePath: string;
  commandLine: string;
  managed: boolean;
}

interface ServiceSnapshot {
  configured: boolean;
  scanComplete: boolean;
  running: boolean;
  healthy: boolean;
  url: string;
  message: string;
  processes: ServiceProcess[];
}

interface GitSnapshot {
  available: boolean;
  branch: string;
  commit: string;
  clean: boolean;
  dirtyPaths: string[];
  ahead: number;
  behind: number;
  remoteMatches: boolean;
  canUpdate: boolean;
  state: string;
  message: string;
}

interface BackupItem {
  path: string;
  name: string;
  size: number;
  modifiedAt: number;
  verified: boolean;
  detail: string;
}

interface DatabaseSnapshot {
  path: string;
  exists: boolean;
  integrity: string;
  foreignKeyViolations: number;
  message: string;
}

interface OperationLog {
  timestamp: number;
  action: string;
  success: boolean;
  detail: string;
}

interface DiagnosticItem {
  label: string;
  state: string;
  detail: string;
}

interface Dashboard {
  config: AppConfig;
  configured: boolean;
  service: ServiceSnapshot;
  git: GitSnapshot;
  database: DatabaseSnapshot;
  backups: BackupItem[];
  logs: OperationLog[];
  diagnostics: DiagnosticItem[];
}

interface UpdateProgress {
  key: string;
  state: StepStatus;
  detail: string;
}

interface ActivityView {
  time: string;
  title: string;
  detail: string;
  tone: Tone;
}

interface NavItem {
  key: PageKey;
  label: string;
  icon: LucideIcon;
}

const NAV_ITEMS: NavItem[] = [
  { key: "overview", label: "概览", icon: LayoutDashboard },
  { key: "services", label: "项目服务", icon: Server },
  { key: "update", label: "Git 更新", icon: GitBranch },
  { key: "database", label: "数据库", icon: Database },
  { key: "logs", label: "日志诊断", icon: ScrollText },
  { key: "settings", label: "设置", icon: Settings },
];

const PAGE_TITLES: Record<PageKey, string> = {
  overview: "服务概览",
  services: "项目服务",
  update: "安全更新",
  database: "数据库备份",
  logs: "日志与诊断",
  settings: "管理器设置",
};

function formatTime(value: number | string) {
  if (typeof value === "string" && value === "未知") return value;
  const date = new Date(typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "medium", hour12: false }).format(date);
}

function formatBytes(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function logTone(success: boolean): Tone {
  return success ? "success" : "error";
}

function activityIcon(tone: Tone) {
  if (tone === "success") return <CheckCircle2 size={17} />;
  if (tone === "error") return <AlertCircle size={17} />;
  if (tone === "warning") return <AlertCircle size={17} />;
  return <Info size={17} />;
}

function StepIcon({ status }: { status: StepStatus }) {
  if (status === "complete") return <Check size={14} strokeWidth={2.5} />;
  if (status === "running") return <LoaderCircle size={15} className="spin" />;
  if (status === "failed") return <AlertCircle size={15} />;
  if (status === "skipped") return <ArrowRight size={14} />;
  return <Circle size={10} />;
}

export function NativeApp() {
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [draft, setDraft] = useState<AppConfig | null>(null);
  const [activePage, setActivePage] = useState<PageKey>("overview");
  const [activeDialog, setActiveDialog] = useState<DialogKind>(null);
  const [selectedBackup, setSelectedBackup] = useState<BackupItem | null>(null);
  const [selectedProcess, setSelectedProcess] = useState<ServiceProcess | null>(null);
  const [stopPhrase, setStopPhrase] = useState("");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [openingSystem, setOpeningSystem] = useState(false);
  const [notice, setNotice] = useState("");
  const noticeTimer = useRef<number | null>(null);
  const [filter, setFilter] = useState<"all" | "errors">("all");
  const [stepStatuses, setStepStatuses] = useState<StepStatus[]>(() => UPDATE_STEPS.map(() => "pending"));
  const [stepDetails, setStepDetails] = useState<Record<string, string>>({});
  const [updateState, setUpdateState] = useState<"idle" | "running" | "failed" | "success">("idle");
  const [updateError, setUpdateError] = useState("");

  const logs = dashboard?.logs ?? [];
  const visibleLogs = useMemo(() => filter === "errors" ? logs.filter((item) => !item.success) : logs, [filter, logs]);
  const currentTitle = PAGE_TITLES[activePage];

  function showNotice(message: string, durationMs = 3600) {
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    setNotice(message);
    noticeTimer.current = durationMs > 0
      ? window.setTimeout(() => {
        setNotice("");
        noticeTimer.current = null;
      }, durationMs)
      : null;
  }

  async function refresh() {
    const result = await invoke<Dashboard>("get_dashboard");
    setDashboard(result);
    setDraft(result.config);
    if (!result.configured) setActivePage("settings");
  }

  useEffect(() => {
    let active = true;
    void invoke<Dashboard>("get_dashboard").then((result) => {
      if (!active) return;
      setDashboard(result);
      setDraft(result.config);
      if (!result.configured) setActivePage("settings");
    }).catch((error: unknown) => showNotice(String(error)));
    let unlisten: (() => void) | undefined;
    void listen<UpdateProgress>("manager-operation-progress", (event) => {
      const progress = event.payload;
      const index = UPDATE_STEPS.findIndex((step) => step.key === progress.key);
      if (index < 0) return;
      setStepStatuses((current) => current.map((status, currentIndex) => {
        if (currentIndex < index && status !== "complete") return status;
        if (currentIndex === index) return progress.state;
        if (progress.state === "failed" && currentIndex > index) return "skipped";
        return status;
      }));
      setStepDetails((current) => ({ ...current, [progress.key]: progress.detail }));
      if (progress.state === "failed") setUpdateState("failed");
    }).then((stop) => { unlisten = stop; });
    return () => {
      active = false;
      unlisten?.();
      if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    };
  }, []);

  async function runAction<T>(action: () => Promise<T>, successMessage?: (value: T) => string) {
    if (busy) return;
    setBusy(true);
    try {
      const value = await action();
      if (successMessage) showNotice(successMessage(value));
      await refresh();
      return value;
    } catch (error) {
      showNotice(error instanceof Error ? error.message : String(error));
      return undefined;
    } finally {
      setBusy(false);
    }
  }

  async function saveConfig() {
    if (!draft) return;
    await runAction(() => invoke<AppConfig>("save_config", { config: draft }), (saved) => `配置已保存：${saved.projectRoot}`);
  }

  async function scanServices() {
    await runAction(async () => {
      const service = await invoke<ServiceSnapshot>("scan_services");
      await refresh();
      return service;
    }, (service) => service.message);
  }

  async function runUpdate() {
    if (busy) return;
    setBusy(true);
    setActiveDialog(null);
    setUpdateState("running");
    setUpdateError("");
    setStepStatuses(UPDATE_STEPS.map(() => "pending"));
    setStepDetails({});
    try {
      const result = await invoke<string>("run_safe_update");
      setUpdateState("success");
      showNotice(result);
    } catch (error) {
      setUpdateState("failed");
      setUpdateError(error instanceof Error ? error.message : String(error));
      showNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
      await refresh();
    }
  }

  async function checkUpdates() {
    const result = await runAction(() => invoke<GitSnapshot>("check_for_updates"));
    if (result) showNotice(result.message);
  }

  async function openSystem() {
    if (busy || openingSystem) return;
    setBusy(true);
    setOpeningSystem(true);
    showNotice("正在检查库存服务并打开系统窗口…", 0);
    try {
      const message = await invoke<string>("open_system");
      showNotice(message, 0);
      try {
        await refresh();
      } catch (error) {
        showNotice(`${message} 管理器状态刷新失败：${error instanceof Error ? error.message : String(error)}`, 0);
      }
    } catch (error) {
      showNotice(error instanceof Error ? error.message : String(error), 0);
    } finally {
      setBusy(false);
      setOpeningSystem(false);
    }
  }

  async function confirmDialog() {
    if (activeDialog === "update") {
      void runUpdate();
      return;
    }
    if (activeDialog === "backup") {
      setActiveDialog(null);
      await runAction(() => invoke<BackupItem>("create_backup"), (backup) => `备份完成：${backup.name}`);
      return;
    }
    if (activeDialog === "restore" && selectedBackup) {
      setActiveDialog(null);
      await runAction(() => invoke<string>("restore_backup", { path: selectedBackup.path }), (message) => message);
      return;
    }
    if (activeDialog === "stop") {
      setActiveDialog(null);
      await runAction(() => invoke<string>("stop_service"), (message) => message);
      return;
    }
    if (activeDialog === "stopExternal" && selectedProcess) {
      const process = selectedProcess;
      setActiveDialog(null);
      setDrawerOpen(false);
      await runAction(() => invoke<string>("stop_external_service", {
        processId: process.processId,
        port: process.port,
        startedAt: process.startedAt,
        confirmation: stopPhrase,
      }), (message) => message);
    }
  }

  async function openRestore(backup: BackupItem) {
    setSelectedBackup(backup);
    const valid = await runAction(() => invoke<BackupItem>("validate_backup", { path: backup.path }));
    if (valid?.verified) setActiveDialog("restore");
  }

  function changeConfig(key: keyof AppConfig, value: string) {
    setDraft((current) => current ? {
      ...current,
      [key]: key === "port" ? Number(value) : value,
    } : current);
  }

  function renderHeaderActions() {
    if (!dashboard) return null;
    if (activePage === "services") {
      const managedProcess = dashboard.service.processes.find((process) => process.managed);
      const externalProcess = dashboard.service.processes.find((process) => !process.managed);
      return <div className="header-actions">
        <Button appearance="secondary" icon={<RefreshCw size={16} />} onClick={() => void scanServices()} disabled={busy}>重新扫描</Button>
        {managedProcess
          ? <Button appearance="secondary" icon={<Square size={14} />} onClick={() => setActiveDialog("stop")}>停止管理器服务</Button>
          : externalProcess
            ? <Button appearance="secondary" icon={<FileSearch size={16} />} onClick={() => { setSelectedProcess(externalProcess); setDrawerOpen(true); }}>核验现有进程</Button>
            : <Button appearance="primary" icon={<Play size={16} />} onClick={() => void runAction(() => invoke<ServiceSnapshot>("start_service"), (service) => service.message)} disabled={busy || !dashboard.configured || !dashboard.service.scanComplete}>启动服务</Button>}
      </div>;
    }
    if (activePage === "update") {
      return <div className="header-actions">
        <Badge appearance="tint" className={`state-badge state-badge-${updateState === "idle" ? dashboard.git.state : updateState}`}>{updateState === "running" ? "更新中" : updateState === "success" ? "更新完成" : updateState === "failed" ? "更新失败" : dashboard.git.state === "ready" ? "可安全更新" : dashboard.git.state === "current" ? "已是最新" : "需要检查"}</Badge>
        <Button appearance="secondary" icon={<RefreshCw size={16} />} onClick={() => void checkUpdates()} disabled={busy}>检查远端更新</Button>
        {dashboard.git.canUpdate && updateState !== "success" && <Button appearance="primary" icon={<Play size={16} />} onClick={() => setActiveDialog("update")} disabled={busy || !dashboard.service.scanComplete || dashboard.service.processes.some((process) => !process.managed)}>开始更新</Button>}
      </div>;
    }
    if (activePage === "database") {
      return <div className="header-actions"><Button appearance="primary" icon={<HardDrive size={16} />} onClick={() => setActiveDialog("backup")} disabled={busy || !dashboard.database.exists}>创建备份</Button></div>;
    }
    if (activePage === "logs") {
      return <div className="header-actions"><Button appearance="secondary" icon={<RefreshCw size={16} />} onClick={() => void runAction(() => invoke<DiagnosticItem[]>("run_diagnostics")).then(() => refresh())} disabled={busy}>重新诊断</Button></div>;
    }
    return <div className="header-actions"><Badge appearance="tint" className="native-badge">本机管理</Badge></div>;
  }

  function renderOverview() {
    if (!dashboard) return <section className="notice-inline"><LoaderCircle className="spin" size={18} /><p>正在读取本机服务状态…</p></section>;
    const service = dashboard.service;
    const git = dashboard.git;
    const database = dashboard.database;
    const latestBackup = dashboard.backups[0];
    return <div className="page-stack">
      <section className="overview-service-row">
        <div className="service-leading-icon"><Server size={23} /></div>
        <div className="overview-service-copy">
          <div className="title-with-status"><h2>库存系统</h2><span className="inline-status"><span className={`status-dot ${service.healthy ? "status-dot-green" : "status-dot-warn"}`} />{!service.scanComplete ? "进程扫描待核验" : service.healthy ? "运行正常" : service.running ? "启动中或不健康" : "未运行"}</span></div>
          <div className="overview-facts">
            <span>访问地址 <strong>{service.url || `localhost:${dashboard.config.port}`}</strong></span>
            <span>分支 <strong>{git.available ? git.branch : "未检测"}</strong></span>
            <span>数据库 <strong>{database.path || "未配置"}</strong></span>
          </div>
        </div>
        <div className="overview-service-actions">
          <Button appearance="secondary" icon={openingSystem ? <LoaderCircle size={16} className="spin" /> : <ExternalLink size={16} />} onClick={() => void openSystem()} disabled={busy || openingSystem}>{openingSystem ? "正在打开…" : "打开系统"}</Button>
          <Button appearance="primary" icon={<GitBranch size={16} />} onClick={() => setActivePage("update")}>检查更新</Button>
        </div>
      </section>
      <section className="overview-metrics" aria-label="项目状态">
        <div><CheckCircle2 size={19} /><strong>服务健康</strong><span>{service.message}</span></div>
        <div><GitBranch size={19} /><strong>Git 状态</strong><span>{git.available ? `${git.branch} · ${git.message}` : git.message}</span></div>
        <div><FileClock size={19} /><strong>最近备份</strong><span>{latestBackup ? `${formatTime(latestBackup.modifiedAt)} · ${formatBytes(latestBackup.size)}` : "暂无备份"}</span></div>
      </section>
      <section className="overview-section">
        <div className="section-heading"><h2>常用操作</h2><span>操作前显示目标与影响范围</span></div>
        <div className="quick-actions">
          <button type="button" onClick={() => setActivePage("update")}><GitBranch size={18} /><span><strong>Git 更新</strong><small>{git.message}</small></span><ArrowUpRight size={16} /></button>
          <button type="button" onClick={() => setActivePage("database")}><Database size={18} /><span><strong>数据库备份</strong><small>{database.message}</small></span><ArrowUpRight size={16} /></button>
          <button type="button" onClick={() => setActivePage("services")}><Server size={18} /><span><strong>项目服务</strong><small>{service.message}</small></span><ArrowUpRight size={16} /></button>
        </div>
      </section>
      <section className="overview-section">
        <div className="section-heading"><h2>最近操作</h2><Button appearance="subtle" size="small" onClick={() => setActivePage("logs")}>查看全部 <ArrowRight size={14} /></Button></div>
        <ActivityList items={logs.slice(0, 4).map(toActivity)} />
      </section>
    </div>;
  }

  function renderServices() {
    const service = dashboard?.service;
    return <div className="page-stack">
      <section className="table-surface">
        <div className="table-toolbar"><div><h2>库存项目进程</h2><span>外部项目进程需核验身份并确认后逐个停止</span></div><Button appearance="secondary" icon={<RefreshCw size={16} />} onClick={() => void scanServices()} disabled={busy}>重新扫描</Button></div>
        {service?.processes.length ? <div className="table-scroll"><table>
          <thead><tr><th>服务 / 进程</th><th>来源</th><th>状态</th><th>端口</th><th>PID</th><th>启动时间</th><th /></tr></thead>
          <tbody>{service.processes.map((process) => <tr key={`${process.processId}-${process.port}`}>
            <td><strong>库存系统</strong></td><td>{process.source}</td>
            <td><span className={`table-state ${process.managed ? "table-state-good" : "table-state-warn"}`}>{process.state}</span></td>
            <td>{process.port}</td><td>{process.processId}</td><td>{formatTime(process.startedAt)}</td>
            <td><Button appearance="subtle" size="small" onClick={() => { setSelectedProcess(process); setDrawerOpen(true); }}>详情</Button></td>
          </tr>)}</tbody>
        </table></div> : <div className="empty-state service-empty">{service?.scanComplete === false ? "进程清单读取不完整，暂时无法确认运行中的服务。" : "目前没有占用配置端口的进程"}</div>}
      </section>
      <section className="notice-inline"><ShieldCheck size={18} /><p>{service?.message ?? "服务信息尚未读取。"} 无法核验项目路径或启动时间的进程不会提供停止操作。</p></section>
    </div>;
  }

  function renderUpdate() {
    const git = dashboard?.git;
    return <>
      <section className="update-summary" aria-label="更新目标与前置状态">
        <div className="summary-item"><GitBranch size={17} /><div><span>分支</span><strong>{git?.branch ?? "未检测"}</strong></div></div>
        <div className="summary-item"><CheckCircle2 size={17} /><div><span>工作区</span><strong>{git?.clean ? "干净" : "有本地改动"}</strong></div></div>
        <div className="summary-item"><ArrowDownToLine size={17} /><div><span>快进合并</span><strong>{git?.canUpdate ? `可更新 ${git.behind} 个提交` : git?.state === "current" ? "已同步" : "未就绪"}</strong></div></div>
        <div className="summary-item summary-database"><Database size={17} /><div><span>数据库</span><strong>{dashboard?.database.path || "未配置"}</strong></div></div>
      </section>
      <div className="maintenance-note"><Info size={16} /><span>更新将创建并校验 SQLite 备份，然后停止管理器服务；失败时服务保持停止。</span><span className="maintenance-note-path">项目目录：{dashboard?.config.projectRoot || "未配置"}</span></div>
      {dashboard?.service.scanComplete === false && <section className="notice-inline" role="alert"><AlertCircle size={17} /><p>{dashboard.service.message}</p></section>}
      <div className="maintenance-layout">
        <section className="timeline-panel" aria-labelledby="native-update-flow-title">
          <div className="section-heading"><h2 id="native-update-flow-title">更新流程</h2><span>只允许 origin/main 快进</span></div>
          {!git?.available && <div className="notice-inline"><AlertCircle size={17} /><p>{git?.message ?? "先配置项目目录。"}</p></div>}
          {git?.available && <p className={`git-reason git-reason-${git.state}`}>{git.message}</p>}
          {git?.dirtyPaths.length ? <ul className="dirty-path-list">{git.dirtyPaths.map((path) => <li key={path} className="mono">{path}</li>)}</ul> : null}
          <ol className="timeline-list">
            {UPDATE_STEPS.map((step, index) => {
              const status = stepStatuses[index];
              return <li key={step.key} className={`timeline-row timeline-row-${status}`}>
                <div className="timeline-rail"><span className="step-marker"><StepIcon status={status} /></span>{index < UPDATE_STEPS.length - 1 && <span className="step-connector" />}</div>
                <div className="timeline-copy"><div className="timeline-title-line"><span className="step-number">{String(index + 1).padStart(2, "0")}</span><strong>{step.title}</strong><Badge appearance="tint" className={`step-status step-status-${status}`}>{status === "complete" ? "已完成" : status === "running" ? "进行中" : status === "failed" ? "失败" : status === "skipped" ? "未执行" : "待执行"}</Badge></div><p>{step.detail}</p>{stepDetails[step.key] && <small className={`step-result ${status === "failed" ? "step-result-error" : ""}`}>{stepDetails[step.key]}</small>}</div>
                {status === "complete" && <span className="timeline-time">{formatTime(Date.now())}</span>}
              </li>;
            })}
          </ol>
          {updateState === "failed" && <div className="result-banner result-banner-failed"><AlertCircle size={20} /><div className="result-banner-copy"><strong>更新失败</strong><p>{updateError || "查看失败步骤和本机日志；服务保持停止。"}</p></div><Button appearance="secondary" onClick={() => setActivePage("logs")}>查看日志</Button></div>}
          {updateState === "success" && <div className="result-banner result-banner-success"><CheckCircle2 size={20} /><div className="result-banner-copy"><strong>更新完成，服务健康</strong><p>{dashboard?.service.message}</p></div></div>}
        </section>
        <aside className="activity-panel"><div className="section-heading"><h2>最近操作</h2><Button appearance="subtle" size="small" onClick={() => setActivePage("logs")}>查看全部 <ArrowRight size={14} /></Button></div><ActivityList items={logs.slice(0, 6).map(toActivity)} /><div className="activity-footer"><Activity size={15} /><span>日志保存在本机</span></div></aside>
      </div>
    </>;
  }

  function renderDatabase() {
    const database = dashboard?.database;
    const backups = dashboard?.backups ?? [];
    return <div className="page-stack">
      <section className="database-summary"><div className="database-summary-icon"><Database size={22} /></div><div><span>当前数据库</span><strong>{database?.path || "未配置"}</strong><small>完整性：{database?.integrity ?? "未知"} · 外键问题：{database?.foreignKeyViolations ?? 0}</small></div><div className="database-summary-status"><span className={`status-dot ${database?.integrity === "ok" && database.foreignKeyViolations === 0 ? "status-dot-green" : "status-dot-warn"}`} />{database?.message ?? "尚未读取"}</div></section>
      <section className="table-surface"><div className="table-toolbar"><div><h2>本机备份</h2><span>{backups.length} 个备份，位于数据库同目录下的 backups 文件夹</span></div><Button appearance="secondary" icon={<RefreshCw size={16} />} onClick={() => void refresh()} disabled={busy}>刷新</Button></div>
        {backups.length ? <div className="table-scroll"><table><thead><tr><th>文件</th><th>创建时间</th><th>大小</th><th>验证</th><th>操作</th></tr></thead><tbody>{backups.map((backup) => <tr key={backup.path}><td><strong className="mono">{backup.name}</strong></td><td>{formatTime(backup.modifiedAt)}</td><td>{formatBytes(backup.size)}</td><td><span className={`table-state ${backup.verified ? "table-state-good" : "table-state-warn"}`}>{backup.verified ? "完整性通过" : "校验失败"}</span></td><td className="row-actions"><Button appearance="subtle" size="small" icon={<FileSearch size={14} />} onClick={() => void runAction(() => invoke<BackupItem>("validate_backup", { path: backup.path }), (value) => value.detail)} disabled={busy}>校验</Button><Button appearance="subtle" size="small" onClick={() => void openRestore(backup)} disabled={busy || !backup.verified}>恢复</Button></td></tr>)}</tbody></table></div> : <div className="empty-state service-empty">还没有管理器创建的数据库备份</div>}
      </section>
      <section className="notice-inline"><Info size={18} /><p>备份使用 SQLite 在线备份接口，可包含 WAL 中的数据。恢复前自动再备份当前数据库；目标服务或端口仍在使用时会拒绝替换。</p></section>
    </div>;
  }

  function renderLogs() {
    const diagnostics = dashboard?.diagnostics ?? [];
    return <div className="page-stack">
      <section className="table-surface"><div className="table-toolbar"><div><h2>本机操作记录</h2><span>最多保留最近 200 条，不发送遥测</span></div><div className="segmented-control" role="group" aria-label="日志筛选"><Button appearance={filter === "all" ? "primary" : "subtle"} size="small" onClick={() => setFilter("all")}>全部</Button><Button appearance={filter === "errors" ? "primary" : "subtle"} size="small" onClick={() => setFilter("errors")}>仅错误</Button></div></div><ActivityList items={visibleLogs.map(toActivity)} showDetail /></section>
      <section className="diagnostic-list"><div className="section-heading"><h2>环境诊断</h2><span>当前机器实时状态</span></div>{diagnostics.map((item) => <div className="diagnostic-row" key={item.label}>{item.state === "ok" ? <CheckCircle2 size={17} /> : <AlertCircle size={17} />}<span>{item.label}</span><strong title={item.detail}>{item.detail}</strong></div>)}</section>
    </div>;
  }

  function renderSettings() {
    if (!draft) return null;
    return <div className="page-stack"><section className="settings-surface"><div className="table-toolbar"><div><h2>项目配置</h2><span>配置只保存在当前 Windows 用户的本机配置目录</span></div></div>
      <div className="settings-grid">
        <label>项目目录<Input value={draft.projectRoot} onChange={(_, data) => changeConfig("projectRoot", data.value)} placeholder="例如 D:\\sugrid-inventory" /></label>
        <label>服务端口<Input type="number" min={1} max={65535} value={String(draft.port)} onChange={(_, data) => changeConfig("port", data.value)} /></label>
        <label>监听地址<select value={draft.host} onChange={(event) => changeConfig("host", event.currentTarget.value)}><option value="0.0.0.0">0.0.0.0（局域网）</option><option value="127.0.0.1">127.0.0.1（仅本机）</option></select></label>
        <label>数据库路径<Input value={draft.databasePath} onChange={(_, data) => changeConfig("databasePath", data.value)} placeholder="相对项目目录或绝对路径" /></label>
      </div>
      <div className="settings-footer"><span><Info size={15} />端口、项目或数据库变更要求服务停止</span><Button appearance="primary" onClick={() => void saveConfig()} disabled={busy}>保存配置</Button></div>
    </section><section className="notice-inline"><ShieldCheck size={18} /><p>数据库路径将以绝对路径保存，并用于服务启动、数据库迁移和安全更新。管理器不提供任意命令或 SQL 执行入口。</p></section></div>;
  }

  function renderPage() {
    if (activePage === "overview") return renderOverview();
    if (activePage === "services") return renderServices();
    if (activePage === "update") return renderUpdate();
    if (activePage === "database") return renderDatabase();
    if (activePage === "logs") return renderLogs();
    return renderSettings();
  }

  function dialogTitle() {
    if (activeDialog === "update") return "确认安全更新";
    if (activeDialog === "backup") return "创建数据库备份";
    if (activeDialog === "restore") return "确认恢复数据库";
    if (activeDialog === "stopExternal") return "强制停止已核验的外部项目进程";
    return "停止库存服务";
  }

  function dialogBody() {
    if (activeDialog === "update") return <><p>更新会短暂停止库存服务，且只允许从 origin/main 快进。任何步骤失败后都不会自动启动服务。</p><dl className="confirm-facts"><div><dt>当前分支</dt><dd>{dashboard?.git.branch}</dd></div><div><dt>待更新</dt><dd>{dashboard?.git.behind} 个提交</dd></div><div><dt>数据库</dt><dd>{dashboard?.database.path}</dd></div><div><dt>执行顺序</dt><dd>SQLite 备份、停止、拉取、npm ci、迁移、检查、构建、启动、健康检查</dd></div></dl><p className="dialog-warning"><AlertCircle size={16} />本地工作区必须干净；更新不会 stash、reset 或覆盖本地改动。</p></>;
    if (activeDialog === "backup") return <><p>将使用 SQLite 在线备份当前数据库，包括 WAL 中尚未合并的数据。</p><dl className="confirm-facts"><div><dt>数据库</dt><dd>{dashboard?.database.path}</dd></div><div><dt>保存位置</dt><dd>{dashboard?.database.path ? `${dashboard.database.path.replace(/[\\/][^\\/]+$/, "")}${dashboard.database.path.includes("\\") ? "\\" : "/"}backups` : "未配置"}</dd></div></dl></>;
    if (activeDialog === "restore") return <><p>恢复会替换当前数据库，无法在应用内撤销。</p><dl className="confirm-facts"><div><dt>目标数据库</dt><dd>{dashboard?.database.path}</dd></div><div><dt>恢复备份</dt><dd>{selectedBackup?.path}</dd></div><div><dt>自动保留</dt><dd>先创建并校验当前数据库备份</dd></div></dl><p className="dialog-warning"><AlertCircle size={16} />请确认目标数据库和备份文件正确。恢复前必须停止相关服务。</p></>;
    if (activeDialog === "stopExternal" && selectedProcess) return <><p>这会立即强制结束该进程，库存系统会断开，未完成的请求或数据库写入可能中断。只对下方单个 PID 执行；请先确认没有人在使用。</p><dl className="confirm-facts"><div><dt>项目目录</dt><dd>{dashboard?.config.projectRoot}</dd></div><div><dt>管理器配置库</dt><dd>{dashboard?.config.databasePath}（外部进程实际使用的数据库路径无法确认）</dd></div><div><dt>端口 / PID</dt><dd>{selectedProcess.port} / {selectedProcess.processId}</dd></div><div><dt>启动时间</dt><dd>{formatTime(selectedProcess.startedAt)}</dd></div><div><dt>命令</dt><dd className="mono">{selectedProcess.commandLine}</dd></div></dl><label className="confirm-input-label">输入“停止 {selectedProcess.processId}”确认<Input value={stopPhrase} onChange={(_, data) => setStopPhrase(data.value)} autoComplete="off" /></label><p className="dialog-warning"><AlertCircle size={16} />停止前会复核 PID、启动时间、项目路径、Next 启动命令和监听端口；核验失败时不会停止。</p></>;
    return <><p>只会停止由当前管理器启动并持有进程句柄的服务，不会按进程名或端口停止外部程序。</p><dl className="confirm-facts"><div><dt>项目目录</dt><dd>{dashboard?.config.projectRoot}</dd></div><div><dt>数据库</dt><dd>{dashboard?.config.databasePath}</dd></div><div><dt>端口</dt><dd>{dashboard?.config.port}</dd></div><div><dt>PID</dt><dd>{dashboard?.service.processes.find((process) => process.managed)?.processId ?? "未找到"}</dd></div></dl></>;
  }

  function dialogActionLabel() {
    if (activeDialog === "update") return "开始更新";
    if (activeDialog === "backup") return "创建备份";
    if (activeDialog === "restore") return "恢复数据库";
    if (activeDialog === "stopExternal") return "强制停止";
    return "停止服务";
  }

  const drawerTitle = selectedProcess?.managed ? "管理器服务详情" : "外部进程信息";

  return <FluentProvider theme={webLightTheme}>
    <div className="manager-shell native-manager-shell">
      <div className="app-frame">
        <aside className="side-nav"><div className="sidebar-brand"><img src="/brand/sugrid-wordmark.png" alt="溯格 SUGRID" /></div><nav aria-label="主导航" className="nav-list">{NAV_ITEMS.map(({ key, label, icon: Icon }) => <Button key={key} appearance="subtle" className={`nav-item${activePage === key ? " nav-item-active" : ""}`} icon={<Icon size={19} strokeWidth={1.9} />} onClick={() => setActivePage(key)} aria-current={activePage === key ? "page" : undefined}><span>{label}</span></Button>)}</nav><div className="sidebar-bottom"><div className="sample-note"><span className="sample-dot" />本机数据 · 不发送遥测</div><div className="sidebar-version">SUGRID Server Manager <span>0.2</span></div></div></aside>
        <main className="main-area"><div className="content-wrap"><header className="page-heading"><div><div className="eyebrow">SUGRID / 本机运维</div><h1>{currentTitle}</h1><div className="project-location"><Folder size={15} /><span>{dashboard?.config.projectRoot || "请先配置项目目录"}</span></div></div><div className="heading-meta"><Badge appearance="tint" className="native-badge">{dashboard?.configured ? "已连接本机项目" : "待配置"}</Badge></div></header>{renderHeaderActions()}{renderPage()}</div></main>
      </div>
      {notice && <div className="toast-message" role="status"><Info size={16} /><span>{notice}</span><button type="button" className="toast-dismiss" aria-label="关闭提示" onClick={() => showNotice("", 0)}><X size={15} /></button></div>}
      <Dialog open={activeDialog !== null} onOpenChange={(_, data) => { if (!data.open) setActiveDialog(null); }}><DialogSurface><DialogBody><DialogTitle>{dialogTitle()}</DialogTitle><DialogContent>{dialogBody()}</DialogContent><DialogActions><Button appearance="secondary" onClick={() => setActiveDialog(null)} disabled={busy}>取消</Button><Button appearance="primary" onClick={() => void confirmDialog()} disabled={busy || (activeDialog === "restore" && (!selectedBackup || dashboard?.service.scanComplete !== true || dashboard.service.processes.length > 0)) || (activeDialog === "stopExternal" && (!selectedProcess || selectedProcess.state !== "待核验" || stopPhrase !== `停止 ${selectedProcess.processId}`))}>{busy ? <LoaderCircle size={15} className="spin" /> : null}{dialogActionLabel()}</Button></DialogActions></DialogBody></DialogSurface></Dialog>
      <Drawer open={drawerOpen} onOpenChange={(_, data) => { if (!data.open) setDrawerOpen(false); }} position="end" size="medium" type="overlay"><DrawerHeader><DrawerHeaderTitle action={<Button appearance="subtle" icon={<X size={17} />} aria-label="关闭详情" onClick={() => setDrawerOpen(false)} />}>{drawerTitle}</DrawerHeaderTitle></DrawerHeader><DrawerBody>{selectedProcess && <div className="drawer-section"><div className={`service-trust ${selectedProcess.managed ? "service-trust-good" : "service-trust-warn"}`}>{selectedProcess.managed ? <CheckCircle2 size={18} /> : <AlertCircle size={18} />}<div><strong>{selectedProcess.state}</strong><span>{selectedProcess.managed ? "由当前管理器启动，可安全停止" : selectedProcess.source === "外部项目候选（待核验）" ? "候选进程路径属于本项目；停止前还会再次核验身份" : "无法确认进程归属，管理器不会停止它"}</span></div></div><dl className="detail-list"><div><dt>PID</dt><dd>{selectedProcess.processId}</dd></div><div><dt>父进程 PID</dt><dd>{selectedProcess.parentProcessId ?? "未知"}</dd></div><div><dt>端口</dt><dd>{selectedProcess.port}</dd></div><div><dt>启动时间</dt><dd>{formatTime(selectedProcess.startedAt)}</dd></div><div><dt>可执行文件</dt><dd className="mono">{selectedProcess.executablePath || "当前权限无法读取"}</dd></div><div><dt>命令行</dt><dd className="mono">{selectedProcess.commandLine || "未展示"}</dd></div><div><dt>项目目录</dt><dd className="mono">{dashboard?.config.projectRoot}</dd></div><div><dt>数据库</dt><dd className="mono">{dashboard?.config.databasePath}</dd></div></dl><div className="drawer-actions"><Button appearance="secondary" icon={<RefreshCw size={15} />} onClick={() => void scanServices()} disabled={busy}>重新核验</Button><Button appearance="secondary" disabled={busy || (!selectedProcess.managed && (selectedProcess.source !== "外部项目候选（待核验）" || selectedProcess.startedAt === "未知"))} icon={<Square size={14} />} onClick={() => { if (!selectedProcess.managed) { setStopPhrase(""); setActiveDialog("stopExternal"); } else { setActiveDialog("stop"); } }}>停止此进程</Button></div><p className="drawer-footnote"><ShieldCheck size={16} />只停止这一条核验过的 PID，不按进程名批量结束。</p></div>}</DrawerBody></Drawer>
    </div>
  </FluentProvider>;
}

function toActivity(item: OperationLog): ActivityView {
  return { time: formatTime(item.timestamp), title: item.action, detail: item.detail, tone: logTone(item.success) };
}

function ActivityList({ items, showDetail = false }: { items: ActivityView[]; showDetail?: boolean }) {
  return <ol className={`activity-list${showDetail ? " activity-list-full" : ""}`}>
    {items.length === 0 && <li className="empty-state">暂无操作记录</li>}
    {items.map((item, index) => <li key={`${item.time}-${item.title}-${index}`} className={`activity-item activity-${item.tone}`}><span className="activity-time">{item.time}</span><span className="activity-icon">{activityIcon(item.tone)}</span><div className="activity-copy"><strong>{item.title}</strong><span>{item.detail}</span>{showDetail && <small>本机操作记录</small>}</div></li>)}
  </ol>;
}
