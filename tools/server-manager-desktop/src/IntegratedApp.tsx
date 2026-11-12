import { useCallback, useEffect, useState } from "react";
import { Badge, Button, FluentProvider, Spinner, webLightTheme } from "@fluentui/react-components";
import { invoke } from "@tauri-apps/api/core";
import {
  Activity,
  AlertCircle,
  ArrowDownToLine,
  CheckCircle2,
  CircleHelp,
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
}

interface Dashboard {
  serviceInstalled: boolean;
  serviceState: string;
  servicePid: number | null;
  healthy: boolean;
  serviceUrl: string;
  port: number;
  databasePath: string;
  databaseExists: boolean;
  databaseIntegrity: string;
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

const NAV: Array<{ key: PageKey; title: string; icon: IconComponent }> = [
  { key: "overview", title: "概览", icon: LayoutDashboard },
  { key: "service", title: "库存服务", icon: Server },
  { key: "database", title: "数据库与备份", icon: Database },
  { key: "updates", title: "一体化更新", icon: ArrowDownToLine },
  { key: "logs", title: "运行状态", icon: ScrollText },
  { key: "settings", title: "固定配置", icon: Settings },
];

const TITLES: Record<PageKey, string> = {
  overview: "服务概览",
  service: "库存服务",
  database: "数据库与备份",
  updates: "一体化更新",
  logs: "运行状态",
  settings: "固定配置",
};

function formatDate(epoch: number) {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(epoch * 1000));
}

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

  const refresh = useCallback(async (quiet = false) => {
    if (!quiet) setBusy("refresh");
    try {
      const next = await invoke<Dashboard>("integrated_dashboard");
      setDashboard(next);
      setError("");
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      if (!quiet) setBusy("");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(true), 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);

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
    const confirmed = window.confirm(`下载 ${update.latestVersion} 的一体化安装包。安装程序会备份数据库、停止并更新 Windows 服务，然后重新启动服务。继续吗？`);
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
    const confirmed = window.confirm(`将数据库恢复到 ${formatDate(backup.modifiedAt)} 的备份。恢复前会自动创建当前数据库备份，期间库存服务会短暂停止。继续吗？`);
    if (!confirmed) return;
    await runAction("restore", () => invoke<Dashboard>("integrated_restore_backup", { name: backup.name }));
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
        <div className="integrated-banner-copy"><span>Windows 服务 · {dashboard?.serviceState === "running" ? "运行中" : dashboard?.serviceState === "not_installed" ? "未安装" : "已停止"}</span><strong>{dashboard?.statusMessage ?? "正在连接本机服务…"}</strong></div>
        <div className="integrated-banner-actions"><Button appearance="secondary" icon={<RefreshCw size={16} />} onClick={() => void refresh()} disabled={Boolean(busy)}>刷新状态</Button>{dashboard?.serviceInstalled && dashboard.serviceState !== "running" ? <Button appearance="primary" icon={<Play size={15} />} onClick={() => void runAction("start", () => invoke<Dashboard>("integrated_start_service"))} disabled={Boolean(busy)}>启动服务</Button> : null}</div>
      </section>
      <section className="integrated-metrics">
        <Metric icon={Server} label="服务端口" value={`:${dashboard?.port ?? 3000}`} detail="局域网库存服务" />
        <Metric icon={Database} label="数据库" value={dashboard?.databaseExists ? "已就绪" : "尚未创建"} detail={dashboard?.databasePath ?? "%ProgramData%\\SUGRID\\Inventory\\data\\inventory.db"} />
        <Metric icon={HardDrive} label="已验证备份" value={`${dashboard?.backups.filter((backup) => backup.verified).length ?? 0}`} detail={dashboard?.backupDirectory ?? "%ProgramData%\\SUGRID\\Inventory\\backups"} />
      </section>
      <section className="integrated-section"><div className="integrated-section-heading"><div><h2>常用操作</h2><span>直接管理本机库存服务</span></div></div><div className="integrated-action-grid">
        <ActionTile icon={dashboard?.serviceState === "running" ? Square : Play} title={dashboard?.serviceState === "running" ? "停止库存服务" : "启动库存服务"} detail={dashboard?.serviceState === "running" ? "局域网用户会暂时无法访问" : "启动 Windows 服务并检查数据库"} onClick={() => void runAction(dashboard?.serviceState === "running" ? "stop" : "start", () => invoke<Dashboard>(dashboard?.serviceState === "running" ? "integrated_stop_service" : "integrated_start_service"))} disabled={!dashboard?.serviceInstalled || Boolean(busy)} />
        <ActionTile icon={HardDrive} title="创建数据库备份" detail="通过管理员确认创建 SQLite 一致性备份" onClick={() => void runAction("backup", () => invoke<Dashboard>("integrated_create_backup"))} disabled={!dashboard?.serviceInstalled || Boolean(busy)} />
        <ActionTile icon={ExternalLink} title="打开库存系统" detail="在独立窗口打开本机库存页面" onClick={() => void openInventory()} disabled={!dashboard?.healthy || Boolean(busy)} />
        <ActionTile icon={ArrowDownToLine} title="检查一体化更新" detail="从项目 GitHub Release 获取安装包" onClick={() => { setPage("updates"); void checkUpdate(); }} disabled={Boolean(busy)} />
      </div></section>
      <section className="integrated-section"><div className="integrated-section-heading"><div><h2>最近数据库备份</h2><span>只显示文件名、大小和校验状态</span></div><Button appearance="subtle" onClick={() => setPage("database")}>查看全部</Button></div><BackupTable backups={(dashboard?.backups ?? []).slice(0, 4)} onRestore={(backup) => void restoreBackup(backup)} busy={Boolean(busy)} /></section>
    </div>;
  }

  function renderService() {
    const running = dashboard?.serviceState === "running";
    return <div className="integrated-stack"><section className="integrated-section"><div className="integrated-section-heading"><div><h2>库存业务服务</h2><span>由 Windows 服务控制器管理，随系统开机运行</span></div><Badge appearance="tint" className={dashboard?.healthy ? "integrated-badge-good" : "integrated-badge-muted"}>{dashboard?.healthy ? "健康" : dashboard?.serviceInstalled ? dashboard.serviceState : "未安装"}</Badge></div><dl className="integrated-details"><div><dt>服务名称</dt><dd>SUGRIDInventory</dd></div><div><dt>运行状态</dt><dd>{dashboard?.serviceState ?? "读取中"}</dd></div><div><dt>服务进程 PID</dt><dd>{dashboard?.servicePid ?? "—"}</dd></div><div><dt>局域网端口</dt><dd>{dashboard?.port ?? 3000}</dd></div><div><dt>本机地址</dt><dd>{dashboard?.serviceUrl ?? "http://127.0.0.1:3000"}</dd></div><div><dt>健康检查</dt><dd>{dashboard?.healthy ? "网页与数据库均可用" : "尚未通过"}</dd></div></dl><div className="integrated-control-bar"><Button appearance="primary" icon={running ? <Square size={15} /> : <Play size={15} />} onClick={() => void runAction(running ? "stop" : "start", () => invoke<Dashboard>(running ? "integrated_stop_service" : "integrated_start_service"))} disabled={!dashboard?.serviceInstalled || Boolean(busy)}>{running ? "停止服务" : "启动服务"}</Button><Button appearance="secondary" icon={<ExternalLink size={15} />} onClick={() => void openInventory()} disabled={!dashboard?.healthy || Boolean(busy)}>打开库存系统</Button><Button appearance="secondary" icon={<RefreshCw size={15} />} onClick={() => void refresh()} disabled={Boolean(busy)}>检查状态</Button></div></section><Notice icon={ShieldCheck}>服务只管理专用的 SUGRIDInventory Windows 服务，不会按进程名结束其他 Node 或项目进程。</Notice></div>;
  }

  function renderDatabase() {
    return <div className="integrated-stack"><section className="integrated-db-summary"><div className="integrated-db-icon"><Database size={22} /></div><div><span>当前数据库</span><strong>{dashboard?.databasePath ?? "%ProgramData%\\SUGRID\\Inventory\\data\\inventory.db"}</strong><small>由库存 Windows 服务账号读写，管理器不直接打开数据库内容</small></div><Button appearance="primary" icon={<HardDrive size={16} />} onClick={() => void runAction("backup", () => invoke<Dashboard>("integrated_create_backup"))} disabled={!dashboard?.serviceInstalled || Boolean(busy)}>创建备份</Button></section><section className="integrated-section"><div className="integrated-section-heading"><div><h2>可恢复备份</h2><span>恢复时自动备份当前库，并在事务完成后验证健康状态</span></div><Button appearance="secondary" icon={<RefreshCw size={15} />} onClick={() => void refresh()} disabled={Boolean(busy)}>刷新</Button></div><BackupTable backups={dashboard?.backups ?? []} onRestore={(backup) => void restoreBackup(backup)} busy={Boolean(busy)} /></section><Notice icon={ShieldCheck}>备份数据库包含用户凭据哈希和业务数据，文件仅管理员与 LocalService 可读。普通页面仅读取不敏感的备份清单；创建和恢复时会出现 Windows 管理员确认。</Notice></div>;
  }

  function renderUpdates() {
    return <div className="integrated-stack"><section className="integrated-section integrated-update-panel"><div className="integrated-section-heading"><div><h2>库存服务与管理器更新</h2><span>从项目 GitHub Release 获取一体化安装程序</span></div><Badge appearance="tint" className="integrated-badge-muted">当前版本 {update?.currentVersion ?? "内置版本"}</Badge></div><p>{update?.message ?? "检查 GitHub Release 是否提供更新版本和一体化安装包。安装前会自动备份数据库。"}</p>{update?.releaseNotes ? <pre className="integrated-release-notes">{update.releaseNotes}</pre> : null}<div className="integrated-control-bar"><Button appearance="secondary" icon={busy === "update-check" ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />} onClick={() => void checkUpdate()} disabled={Boolean(busy)}>检查更新</Button>{update?.updateAvailable && update.installerAvailable && update.latestVersion ? <Button appearance="primary" icon={<ArrowDownToLine size={15} />} onClick={() => void installUpdate()} disabled={Boolean(busy)}>{busy === "update-install" ? "正在准备安装程序…" : `安装 ${update.latestVersion}`}</Button> : null}{update?.releaseUrl ? <Button appearance="subtle" icon={<ExternalLink size={15} />} onClick={() => window.open(update.releaseUrl!, "_blank", "noopener,noreferrer")}>打开 Release</Button> : null}</div></section><Notice icon={CircleHelp}>若 GitHub Release 没有上传名为 SUGRID-Server-Manager-Setup.exe 的安装包，管理器会明确提示无法更新，不会尝试 Git pull 或修改项目目录。</Notice></div>;
  }

  function renderLogs() {
    return <div className="integrated-stack"><section className="integrated-section"><div className="integrated-section-heading"><div><h2>服务诊断</h2><span>当前 Windows 服务与库存健康接口</span></div><Button appearance="secondary" icon={<RefreshCw size={15} />} onClick={() => void refresh()} disabled={Boolean(busy)}>重新检查</Button></div><div className="integrated-diagnostic-list"><Diagnostic icon={dashboard?.serviceInstalled ? CheckCircle2 : AlertCircle} label="Windows 服务安装" value={dashboard?.serviceInstalled ? "已注册" : "未安装"} good={Boolean(dashboard?.serviceInstalled)} /><Diagnostic icon={dashboard?.serviceState === "running" ? CheckCircle2 : AlertCircle} label="服务进程" value={dashboard?.serviceState === "running" ? `运行中 · PID ${dashboard.servicePid ?? "未知"}` : dashboard?.serviceState ?? "未知"} good={dashboard?.serviceState === "running"} /><Diagnostic icon={dashboard?.healthy ? CheckCircle2 : AlertCircle} label="HTTP / 数据库健康检查" value={dashboard?.healthy ? "通过" : "未通过"} good={Boolean(dashboard?.healthy)} /><Diagnostic icon={Database} label="数据库路径" value={dashboard?.databasePath ?? "尚未确认"} good={Boolean(dashboard?.databaseExists)} /></div></section><Notice icon={FileClock}>服务运行日志保存在 %ProgramData%\SUGRID\Inventory\logs。真实安装环境下服务使用 LocalService 账号运行。</Notice></div>;
  }

  function renderSettings() {
    return <div className="integrated-stack"><section className="integrated-section"><div className="integrated-section-heading"><div><h2>服务器固定配置</h2><span>无需填写源码目录，也不读取仓库中的 Git 状态</span></div></div><dl className="integrated-details"><div><dt>服务类型</dt><dd>Windows 服务 · 自动启动</dd></div><div><dt>监听地址</dt><dd>0.0.0.0:{dashboard?.port ?? 3000}</dd></div><div><dt>数据库路径</dt><dd>{dashboard?.databasePath ?? "%ProgramData%\\SUGRID\\Inventory\\data\\inventory.db"}</dd></div><div><dt>数据保留路径</dt><dd>%ProgramData%\SUGRID\Inventory\data、backups、logs</dd></div><div><dt>运行账号</dt><dd>NT AUTHORITY\LocalService</dd></div></dl></section><Notice icon={Settings}>配置随一体化安装程序管理。安装更新只替换应用和服务文件，数据库、备份和日志保留在 ProgramData。</Notice></div>;
  }

  const currentTitle = TITLES[page];

  return <FluentProvider theme={webLightTheme}><div className="integrated-shell"><aside className="integrated-sidebar"><div className="integrated-brand"><img src="/brand/sugrid-wordmark.png" alt="溯格 SUGRID"/><span>服务器管理器</span></div><nav aria-label="主导航">{NAV.map(({ key, title, icon: Icon }) => <Button key={key} appearance="subtle" className={`integrated-nav-item${page === key ? " is-active" : ""}`} icon={<Icon size={18}/>} onClick={() => setPage(key)} aria-current={page === key ? "page" : undefined}>{title}</Button>)}</nav><div className="integrated-sidebar-footer"><span className={`integrated-health-dot ${dashboard?.healthy ? "is-good" : ""}`}/><div><strong>{dashboard?.healthy ? "服务正常" : "需要检查"}</strong><small>本机管理 · 不发送遥测</small></div></div></aside><main className="integrated-main"><header className="integrated-topbar"><div><span className="integrated-eyebrow">SUGRID / WINDOWS SERVER</span><h1>{currentTitle}</h1></div><div className="integrated-topbar-actions"><Badge appearance="tint" className={dashboard?.healthy ? "integrated-badge-good" : "integrated-badge-muted"}>{dashboard?.serviceState === "running" ? "运行中" : dashboard?.serviceState === "not_installed" ? "未安装" : "已停止"}</Badge><Button appearance="subtle" icon={busy === "refresh" ? <Spinner size="tiny"/> : <RefreshCw size={16}/>} onClick={() => void refresh()} disabled={Boolean(busy)} aria-label="刷新服务状态"/></div></header>{error && <div className="integrated-alert" role="alert"><AlertCircle size={17}/><span>{error}</span><button type="button" onClick={() => setError("")}>关闭</button></div>}{notice && <div className="integrated-notice" role="status"><CheckCircle2 size={17}/><span>{notice}</span></div>}{page === "overview" ? renderOverview() : page === "service" ? renderService() : page === "database" ? renderDatabase() : page === "updates" ? renderUpdates() : page === "logs" ? renderLogs() : renderSettings()}<footer className="integrated-footer"><Activity size={14}/><span>固定服务端口 3000</span><span className="integrated-footer-separator">·</span><span>数据库位于 ProgramData</span></footer></main></div></FluentProvider>;
}

function Metric({ icon: Icon, label, value, detail }: { icon: IconComponent; label: string; value: string; detail: string }) {
  return <div className="integrated-metric"><span className="integrated-metric-icon"><Icon size={18}/></span><div><small>{label}</small><strong>{value}</strong><span title={detail}>{detail}</span></div></div>;
}

function ActionTile({ icon: Icon, title, detail, onClick, disabled }: { icon: IconComponent; title: string; detail: string; onClick: () => void; disabled: boolean }) {
  return <button type="button" className="integrated-action-tile" onClick={onClick} disabled={disabled}><span className="integrated-tile-icon"><Icon size={19}/></span><span className="integrated-tile-copy"><strong>{title}</strong><small>{detail}</small></span></button>;
}

function BackupTable({ backups, onRestore, busy }: { backups: BackupSummary[]; onRestore: (backup: BackupSummary) => void; busy: boolean }) {
  if (!backups.length) return <div className="integrated-empty">尚无备份。首次安装及每次数据库操作前会创建备份。</div>;
  return <div className="integrated-table-scroll"><table className="integrated-table"><thead><tr><th>备份文件</th><th>创建时间</th><th>大小</th><th>完整性</th><th>操作</th></tr></thead><tbody>{backups.map((backup) => <tr key={backup.name}><td><strong className="integrated-mono">{backup.name}</strong></td><td>{formatDate(backup.modifiedAt)}</td><td>{formatSize(backup.size)}</td><td><span className={`integrated-table-state ${backup.verified ? "is-good" : "is-bad"}`}>{backup.verified ? "已验证" : "校验失败"}</span></td><td><Button appearance="subtle" size="small" onClick={() => onRestore(backup)} disabled={busy || !backup.verified}>恢复</Button></td></tr>)}</tbody></table></div>;
}

function Notice({ icon: Icon, children }: { icon: IconComponent; children: string }) {
  return <section className="integrated-notice-block"><Icon size={17}/><p>{children}</p></section>;
}

function Diagnostic({ icon: Icon, label, value, good }: { icon: IconComponent; label: string; value: string; good: boolean }) {
  return <div className="integrated-diagnostic"><Icon size={17} className={good ? "is-good" : "is-muted"}/><span>{label}</span><strong title={value}>{value}</strong></div>;
}
