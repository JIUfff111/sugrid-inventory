import { useState } from "react";
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
import { isTauri } from "@tauri-apps/api/core";
import {
  Activity,
  AlertCircle,
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  Check,
  CheckCircle2,
  Circle,
  CircleHelp,
  Database,
  ExternalLink,
  FileClock,
  FileDiff,
  FileSearch,
  Folder,
  GitBranch,
  HardDrive,
  Info,
  LayoutDashboard,
  LoaderCircle,
  Play,
  RefreshCw,
  RotateCcw,
  ScrollText,
  Server,
  Settings,
  ShieldCheck,
  SkipForward,
  Square,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  FAILED_STEP_INDEX,
  UPDATE_STEPS,
  getTerminalStatuses,
  getUpdateProgress,
  type DemoOutcome,
  type StepStatus,
} from "./update-flow";

type PageKey = "overview" | "services" | "update" | "database" | "logs" | "settings";
type RunState = "ready" | "running" | "failed" | "success";
type DialogKind = "update" | "backup" | "restore" | "stop" | "recheck" | null;
type DrawerKind = "changes" | "logs" | "service" | "backup" | null;
type ActivityTone = "success" | "error" | "info" | "warning";

interface ActivityItem {
  time: string;
  title: string;
  detail: string;
  tone: ActivityTone;
}

interface BackupItem {
  name: string;
  size: string;
  createdAt: string;
  status: "verified" | "manual";
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

const INITIAL_BACKUPS: BackupItem[] = [
  { name: "inventory.db.20261111_102418", size: "18.4 MB", createdAt: "2026-11-11 10:24", status: "verified" },
  { name: "inventory.db.20261110_184200", size: "18.2 MB", createdAt: "2026-11-10 18:42", status: "verified" },
  { name: "inventory.db.manual_20261109", size: "17.9 MB", createdAt: "2026-11-09 09:15", status: "manual" },
];

const INITIAL_ACTIVITIES: ActivityItem[] = [
  { time: "10:24:08", title: "准备开始", detail: "等待更新演示。", tone: "info" },
  { time: "09:51:43", title: "检查 Git 状态", detail: "main 分支，工作区干净。", tone: "success" },
  { time: "09:48:02", title: "数据库完整性检查", detail: "SQLite integrity_check 通过。", tone: "success" },
];

const PROCESS_ROWS = [
  { name: "库存系统", source: "管理器启动", state: "运行正常", port: "3000", pid: "8421", startedAt: "2026-11-11 08:12:34" },
  { name: "库存系统候选进程", source: "本地进程", state: "待核验", port: "3001", pid: "9037", startedAt: "2026-11-11 09:20:17" },
];

const CHANGE_ROWS = [
  { path: "app/api/inventory/route.ts", kind: "修改", summary: "库存查询响应处理" },
  { path: "scripts/database.cjs", kind: "修改", summary: "数据库迁移脚本" },
  { path: "package-lock.json", kind: "修改", summary: "依赖锁文件" },
];

const PAGE_TITLES: Record<PageKey, string> = {
  overview: "服务概览",
  services: "项目服务",
  update: "安全更新",
  database: "数据库备份",
  logs: "日志与诊断",
  settings: "管理器设置",
};

function getClockTime() {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date());
}

function delay(duration: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, duration));
}

function StateBadge({ state }: { state: RunState }) {
  const labels: Record<RunState, string> = {
    ready: "可安全更新",
    running: "演示进行中",
    failed: "更新失败",
    success: "更新完成",
  };
  return <Badge appearance="tint" className={"state-badge state-badge-" + state}>{labels[state]}</Badge>;
}

function StepIcon({ status }: { status: StepStatus }) {
  if (status === "complete") return <Check size={14} strokeWidth={2.5} />;
  if (status === "running") return <LoaderCircle size={15} className="spin" />;
  if (status === "failed") return <AlertCircle size={15} />;
  if (status === "skipped") return <SkipForward size={14} />;
  return <Circle size={10} />;
}

function ActivityIcon({ tone }: { tone: ActivityTone }) {
  if (tone === "success") return <CheckCircle2 size={17} />;
  if (tone === "error") return <AlertCircle size={17} />;
  if (tone === "warning") return <CircleHelp size={17} />;
  return <Info size={17} />;
}

function AppContent() {
  const [activePage, setActivePage] = useState<PageKey>("update");
  const [runState, setRunState] = useState<RunState>("ready");
  const [demoOutcome, setDemoOutcome] = useState<DemoOutcome>("build-failure");
  const [stepStatuses, setStepStatuses] = useState<StepStatus[]>(() => getUpdateProgress(1));
  const [activities, setActivities] = useState<ActivityItem[]>(INITIAL_ACTIVITIES);
  const [backups, setBackups] = useState<BackupItem[]>(INITIAL_BACKUPS);
  const [activeDialog, setActiveDialog] = useState<DialogKind>(null);
  const [drawer, setDrawer] = useState<DrawerKind>(null);
  const [notice, setNotice] = useState("");
  const [logFilter, setLogFilter] = useState<"all" | "errors">("all");
  const [selectedService, setSelectedService] = useState(1);
  const [projectRoot, setProjectRoot] = useState("C:\\SUGRID\\inventory");
  const [databasePath, setDatabasePath] = useState("data/inventory.db");
  const [port, setPort] = useState("3000");
  const [host, setHost] = useState("0.0.0.0");
  const nativeWindow = isTauri();
  const currentTitle = PAGE_TITLES[activePage];

  function showNotice(message: string) {
    setNotice(message);
    window.setTimeout(() => setNotice(""), 2800);
  }

  function addActivity(item: Omit<ActivityItem, "time">) {
    setActivities((current) => [{ ...item, time: getClockTime() }, ...current].slice(0, 8));
  }

  function resetSample() {
    setRunState("ready");
    setStepStatuses(getUpdateProgress(1));
    setActivities(INITIAL_ACTIVITIES);
    setActiveDialog(null);
    showNotice("演示状态已重置，没有执行系统操作。");
  }

  async function runUpdateDemo() {
    if (runState === "running") return;
    setActiveDialog(null);
    setRunState("running");
    setStepStatuses(getUpdateProgress(1));
    addActivity({ title: "开始更新演示", detail: "仅切换界面状态，没有运行系统命令。", tone: "info" });

    for (let index = 1; index < UPDATE_STEPS.length; index += 1) {
      setStepStatuses(getUpdateProgress(index, index));
      addActivity({ title: UPDATE_STEPS[index].title, detail: "演示流程处理中。", tone: "info" });
      await delay(520);

      if (demoOutcome === "build-failure" && index === FAILED_STEP_INDEX) {
        setStepStatuses(getTerminalStatuses("build-failure"));
        setRunState("failed");
        addActivity({
          title: "代码检查 / 构建失败",
          detail: "后续启动与健康检查已跳过；服务保持停止。",
          tone: "error",
        });
        return;
      }

      setStepStatuses(getUpdateProgress(index + 1));
      addActivity({
        title: UPDATE_STEPS[index].title,
        detail: "演示步骤已完成。",
        tone: "success",
      });
      await delay(180);
    }

    setStepStatuses(getTerminalStatuses("success"));
    setRunState("success");
    addActivity({
      title: "健康检查通过",
      detail: "演示显示服务已启动，登录页可访问。",
      tone: "success",
    });
  }

  function createBackupDemo() {
    const backup: BackupItem = {
      name: "inventory.db.demo_" + Date.now(),
      size: "18.4 MB",
      createdAt: new Date().toLocaleString("zh-CN", { hour12: false }),
      status: "verified",
    };
    setBackups((current) => [backup, ...current]);
    setActiveDialog(null);
    showNotice("演示备份已添加到列表，没有读取或写入数据库。");
  }

  function confirmDialog() {
    if (activeDialog === "update") {
      void runUpdateDemo();
      return;
    }
    if (activeDialog === "backup") {
      createBackupDemo();
      return;
    }
    if (activeDialog === "restore") {
      setActiveDialog(null);
      showNotice("演示完成：没有替换或修改任何数据库文件。");
      return;
    }
    if (activeDialog === "stop") {
      setActiveDialog(null);
      showNotice("演示完成：没有停止任何本机进程。");
      return;
    }
    if (activeDialog === "recheck") {
      setActiveDialog(null);
      showNotice("演示检查通过；失败的构建仍需修复后再更新。");
      return;
    }
    setActiveDialog(null);
  }

  const filteredActivities = logFilter === "errors"
    ? activities.filter((item) => item.tone === "error")
    : activities;

  function openServiceDetails(index: number) {
    setSelectedService(index);
    setDrawer("service");
  }

  function renderHeaderActions() {
    if (activePage === "update") {
      return (
        <div className="header-actions">
          <StateBadge state={runState} />
          <Button appearance="subtle" icon={<FileDiff size={16} />} onClick={() => setDrawer("changes")}>
            查看变更
          </Button>
          {runState === "ready" && (
            <Button appearance="primary" icon={<Play size={16} />} onClick={() => setActiveDialog("update")}>
              开始更新
            </Button>
          )}
          {runState === "running" && (
            <Button appearance="primary" disabled icon={<LoaderCircle size={16} className="spin" />}>
              演示进行中
            </Button>
          )}
          {runState === "failed" && (
            <>
              <Button appearance="secondary" icon={<FileSearch size={16} />} onClick={() => setDrawer("logs")}>
                查看失败日志
              </Button>
              <Button appearance="secondary" icon={<RefreshCw size={16} />} onClick={() => setActiveDialog("recheck")}>
                重新检查
              </Button>
              <Button appearance="subtle" icon={<RotateCcw size={16} />} onClick={resetSample}>
                重置演示
              </Button>
            </>
          )}
          {runState === "success" && (
            <>
              <Button appearance="secondary" icon={<ExternalLink size={16} />} onClick={() => showNotice("演示环境不会打开实际库存系统。")}>
                打开系统
              </Button>
              <Button appearance="subtle" icon={<RotateCcw size={16} />} onClick={resetSample}>
                重置演示
              </Button>
            </>
          )}
        </div>
      );
    }

    if (activePage === "services") {
      return (
        <div className="header-actions">
          <Badge appearance="tint" className="demo-badge">演示环境</Badge>
          <Button appearance="secondary" icon={<RefreshCw size={16} />} onClick={() => showNotice("演示数据已刷新。")}>
            刷新
          </Button>
        </div>
      );
    }

    return (
      <div className="header-actions">
        <Badge appearance="tint" className="demo-badge">演示环境</Badge>
      </div>
    );
  }

  function renderUpdatePage() {
    return (
      <>
        <section className="update-summary" aria-label="更新目标与前置状态">
          <div className="summary-item">
            <GitBranch size={17} />
            <div><span>分支</span><strong>main</strong></div>
          </div>
          <div className="summary-item">
            <CheckCircle2 size={17} />
            <div><span>工作区</span><strong>干净</strong></div>
          </div>
          <div className="summary-item">
            <ArrowDownToLine size={17} />
            <div><span>快进合并</span><strong>可更新</strong></div>
          </div>
          <div className="summary-item summary-database">
            <Database size={17} />
            <div><span>数据库</span><strong>{databasePath}</strong></div>
          </div>
        </section>

        <div className="maintenance-note">
          <Info size={16} />
          <span>更新期间服务会短暂停止，通常需要 1–3 分钟；请在合适的时间操作。</span>
          <span className="maintenance-note-path">项目目录：{projectRoot}</span>
        </div>

        <div className="maintenance-layout">
          <section className="timeline-panel" aria-labelledby="update-flow-title">
            <div className="section-heading">
              <h2 id="update-flow-title">更新流程</h2>
              <span>9 个步骤</span>
            </div>
            <ol className="timeline-list">
              {UPDATE_STEPS.map((step, index) => {
                const status = stepStatuses[index];
                return (
                  <li key={step.key} className={"timeline-row timeline-row-" + status}>
                    <div className="timeline-rail">
                      <span className="step-marker"><StepIcon status={status} /></span>
                      {index < UPDATE_STEPS.length - 1 && <span className="step-connector" />}
                    </div>
                    <div className="timeline-copy">
                      <div className="timeline-title-line">
                        <span className="step-number">{String(index + 1).padStart(2, "0")}</span>
                        <strong>{step.title}</strong>
                        <Badge appearance="tint" className={"step-status step-status-" + status}>
                          {status === "complete" ? "已完成" : status === "running" ? "进行中" : status === "failed" ? "失败" : status === "skipped" ? "未执行" : "待执行"}
                        </Badge>
                      </div>
                      <p>{step.detail}</p>
                      {status === "failed" && <small className="step-result step-result-error">构建失败 · 1 个错误 · 服务保持停止</small>}
                      {status === "skipped" && <small className="step-result">上一步失败，未启动服务</small>}
                      {status === "running" && <small className="step-result step-result-running">正在演示当前步骤…</small>}
                      {status === "complete" && index === 0 && <small className="step-result">main · 工作区干净 · 允许快进</small>}
                      {status === "complete" && index === 1 && <small className="step-result">备份位置：data/backups/inventory.db.20261111_102418</small>}
                      {status === "complete" && index > 1 && <small className="step-result">{step.key === "pull" ? "origin/main 已快进合并" : "演示步骤已完成"}</small>}
                    </div>
                    {status === "complete" && <span className="timeline-time">{index === 0 ? "10:24:12" : index === 1 ? "10:24:18" : ""}</span>}
                  </li>
                );
              })}
            </ol>

            {runState === "failed" && (
              <div className="result-banner result-banner-failed" role="status">
                <AlertCircle size={20} />
                <div className="result-banner-copy">
                  <strong>更新失败，服务保持停止</strong>
                  <p>Git 更新和数据库迁移可能已完成；第 7 步构建失败，第 8、9 步已跳过。</p>
                  <div className="result-backup-path"><HardDrive size={14} /> 更新前备份：data/backups/inventory.db.20261111_102418</div>
                </div>
                <Button appearance="secondary" onClick={() => setDrawer("logs")}>查看日志</Button>
              </div>
            )}

            {runState === "success" && (
              <div className="result-banner result-banner-success" role="status">
                <CheckCircle2 size={20} />
                <div className="result-banner-copy">
                  <strong>更新完成，服务运行正常</strong>
                  <p>所有检查均已通过。数据库备份保留在本机。</p>
                </div>
                <Button appearance="secondary" onClick={() => setDrawer("logs")}>查看日志</Button>
              </div>
            )}
          </section>

          <aside className="activity-panel" aria-labelledby="recent-activity-title">
            <div className="section-heading">
              <h2 id="recent-activity-title">最近日志</h2>
              <Button appearance="subtle" size="small" onClick={() => { setActivePage("logs"); setLogFilter("all"); }}>
                查看全部 <ArrowRight size={14} />
              </Button>
            </div>
            <ol className="activity-list">
              {activities.slice(0, 7).map((item, index) => (
                <li key={item.time + item.title + index} className={"activity-item activity-" + item.tone}>
                  <span className="activity-time">{item.time}</span>
                  <span className="activity-icon"><ActivityIcon tone={item.tone} /></span>
                  <div className="activity-copy">
                    <strong>{item.title}</strong>
                    <span>{item.detail}</span>
                  </div>
                </li>
              ))}
            </ol>
            <div className="activity-footer">
              <Activity size={15} />
              <span>日志只保存在本机</span>
            </div>
          </aside>
        </div>
      </>
    );
  }

  function renderOverviewPage() {
    return (
      <div className="page-stack">
        <section className="overview-service-row">
          <div className="service-leading-icon"><Server size={23} /></div>
          <div className="overview-service-copy">
            <div className="title-with-status"><h2>库存系统</h2><span className="inline-status"><span className="status-dot status-dot-green" />运行正常</span></div>
            <div className="overview-facts">
              <span>访问地址 <strong>localhost:{port}</strong></span>
              <span>分支 <strong>main</strong></span>
              <span>数据库 <strong>{databasePath}</strong></span>
            </div>
          </div>
          <div className="overview-service-actions">
            <Button appearance="secondary" icon={<ExternalLink size={16} />} onClick={() => showNotice("演示环境不会打开实际库存系统。")}>打开系统</Button>
            <Button appearance="primary" icon={<GitBranch size={16} />} onClick={() => setActivePage("update")}>检查更新</Button>
          </div>
        </section>

        <section className="overview-metrics" aria-label="项目状态">
          <div><CheckCircle2 size={19} /><strong>服务健康</strong><span>端口可访问 · 演示状态</span></div>
          <div><GitBranch size={19} /><strong>Git 状态</strong><span>main · 工作区干净</span></div>
          <div><FileClock size={19} /><strong>最近备份</strong><span>2026-11-11 10:24 · 18.4 MB</span></div>
        </section>

        <section className="overview-section">
          <div className="section-heading"><h2>常用操作</h2><span>仅演示，不执行本机命令</span></div>
          <div className="quick-actions">
            <button type="button" onClick={() => setActivePage("update")}><GitBranch size={18} /><span><strong>Git 更新</strong><small>检查并演示安全更新流程</small></span><ArrowUpRight size={16} /></button>
            <button type="button" onClick={() => setActivePage("database")}><Database size={18} /><span><strong>数据库备份</strong><small>查看本机备份与恢复记录</small></span><ArrowUpRight size={16} /></button>
            <button type="button" onClick={() => setActivePage("services")}><Server size={18} /><span><strong>项目服务</strong><small>查看项目进程与端口</small></span><ArrowUpRight size={16} /></button>
          </div>
        </section>

        <section className="overview-section">
          <div className="section-heading"><h2>最近操作</h2><Button appearance="subtle" size="small" onClick={() => setActivePage("logs")}>查看日志 <ArrowRight size={14} /></Button></div>
          <ActivityList items={activities.slice(0, 3)} />
        </section>
      </div>
    );
  }

  function renderServicesPage() {
    return (
      <div className="page-stack">
        <section className="table-surface">
          <div className="table-toolbar">
            <div><h2>本机项目进程</h2><span>仅显示可关联到库存项目的服务</span></div>
            <Button appearance="secondary" icon={<RefreshCw size={16} />} onClick={() => showNotice("演示进程信息已刷新。")}>重新扫描</Button>
          </div>
          <div className="table-scroll">
            <table>
              <thead><tr><th>服务 / 进程</th><th>来源</th><th>状态</th><th>端口</th><th>PID</th><th>启动时间</th><th /></tr></thead>
              <tbody>
                {PROCESS_ROWS.map((row, index) => (
                  <tr key={row.pid} className={selectedService === index ? "selected-row" : ""} onClick={() => setSelectedService(index)}>
                    <td><strong>{row.name}</strong></td>
                    <td>{row.source}</td>
                    <td><span className={"table-state " + (index === 0 ? "table-state-good" : "table-state-warn")}>{row.state}</span></td>
                    <td>{row.port}</td><td>{row.pid}</td><td>{row.startedAt}</td>
                    <td><Button appearance="subtle" size="small" onClick={(event) => { event.stopPropagation(); openServiceDetails(index); }}>详情</Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        <section className="notice-inline">
          <ShieldCheck size={18} />
          <p>停止操作前会再次核对 PID、启动时间和进程身份。待核验的候选进程不能直接停止。</p>
          <Button appearance="secondary" onClick={() => openServiceDetails(selectedService)}>查看进程详情</Button>
        </section>
      </div>
    );
  }

  function renderDatabasePage() {
    return (
      <div className="page-stack">
        <section className="database-summary">
          <div className="database-summary-icon"><Database size={22} /></div>
          <div><span>当前数据库</span><strong>{databasePath}</strong><small>项目目录：{projectRoot}</small></div>
          <div className="database-summary-status"><span className="status-dot status-dot-green" />SQLite 完整性检查通过</div>
          <Button appearance="primary" icon={<HardDrive size={16} />} onClick={() => setActiveDialog("backup")}>创建备份</Button>
        </section>
        <section className="table-surface">
          <div className="table-toolbar"><div><h2>备份记录</h2><span>{backups.length} 个本机备份</span></div><Button appearance="secondary" icon={<RefreshCw size={16} />} onClick={() => showNotice("演示备份列表已刷新。")}>刷新</Button></div>
          <div className="table-scroll">
            <table>
              <thead><tr><th>文件</th><th>创建时间</th><th>大小</th><th>验证</th><th>操作</th></tr></thead>
              <tbody>
                {backups.map((backup) => (
                  <tr key={backup.name}>
                    <td><strong className="mono">{backup.name}</strong></td><td>{backup.createdAt}</td><td>{backup.size}</td>
                    <td><span className="table-state table-state-good">{backup.status === "verified" ? "完整性通过" : "手动备份"}</span></td>
                    <td className="row-actions">
                      <Button appearance="subtle" size="small" icon={<Folder size={14} />} onClick={() => { setDrawer("backup"); showNotice("演示环境不会打开本机目录。"); }}>位置</Button>
                      <Button appearance="subtle" size="small" onClick={() => setActiveDialog("restore")}>恢复</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        <section className="notice-inline"><Info size={18} /><p>恢复前会先备份当前数据库，并在替换前检查外键和完整性。</p></section>
      </div>
    );
  }

  function renderLogsPage() {
    return (
      <div className="page-stack">
        <section className="table-surface">
          <div className="table-toolbar">
            <div><h2>操作记录</h2><span>记录保存在本机，不发送遥测</span></div>
            <div className="segmented-control" role="group" aria-label="日志筛选">
              <Button appearance={logFilter === "all" ? "primary" : "subtle"} size="small" onClick={() => setLogFilter("all")}>全部</Button>
              <Button appearance={logFilter === "errors" ? "primary" : "subtle"} size="small" onClick={() => setLogFilter("errors")}>仅错误</Button>
            </div>
          </div>
          <ActivityList items={filteredActivities} showDetail />
        </section>
        <section className="diagnostic-list">
          <div className="section-heading"><h2>环境诊断</h2><span>演示结果</span></div>
          <div className="diagnostic-row"><CheckCircle2 size={17} /><span>Node.js</span><strong>已检测 · v24</strong></div>
          <div className="diagnostic-row"><CheckCircle2 size={17} /><span>Git</span><strong>已检测</strong></div>
          <div className="diagnostic-row"><CheckCircle2 size={17} /><span>SQLite 数据库</span><strong>完整性正常</strong></div>
          <div className="diagnostic-row"><AlertCircle size={17} /><span>Rust / C++ Build Tools</span><strong>尚未配置原生构建环境</strong></div>
        </section>
      </div>
    );
  }

  function renderSettingsPage() {
    return (
      <div className="page-stack">
        <section className="settings-surface">
          <div className="table-toolbar"><div><h2>项目配置</h2><span>当前配置只保存在本次页面演示中</span></div></div>
          <div className="settings-grid">
            <label>项目目录<Input value={projectRoot} onChange={(_, data) => setProjectRoot(data.value)} /></label>
            <label>服务端口<Input value={port} onChange={(_, data) => setPort(data.value)} /></label>
            <label>监听地址
              <select value={host} onChange={(event) => setHost(event.currentTarget.value)}>
                <option value="0.0.0.0">0.0.0.0（局域网）</option>
                <option value="127.0.0.1">127.0.0.1（仅本机）</option>
              </select>
            </label>
            <label>数据库路径<Input value={databasePath} onChange={(_, data) => setDatabasePath(data.value)} /></label>
          </div>
          <div className="settings-footer">
            <span><Info size={15} />样稿不会写入配置文件。</span>
            <Button appearance="primary" onClick={() => showNotice("演示配置已在当前页面更新，没有写入本机文件。")}>保存演示配置</Button>
          </div>
        </section>
        <section className="notice-inline"><ShieldCheck size={18} /><p>真实版本会要求服务停止后才能修改监听地址、端口或数据库路径。</p></section>
      </div>
    );
  }

  function renderPage() {
    switch (activePage) {
      case "overview": return renderOverviewPage();
      case "services": return renderServicesPage();
      case "update": return renderUpdatePage();
      case "database": return renderDatabasePage();
      case "logs": return renderLogsPage();
      case "settings": return renderSettingsPage();
    }
  }

  function getDialogTitle() {
    if (activeDialog === "update") return "确认演示更新";
    if (activeDialog === "backup") return "创建数据库备份";
    if (activeDialog === "restore") return "确认恢复备份";
    if (activeDialog === "stop") return "确认停止候选进程";
    if (activeDialog === "recheck") return "重新检查";
    return "";
  }

  function renderDialogBody() {
    if (activeDialog === "update") {
      return (
        <>
          <p>这次演示只更新页面状态，不会连接 Git、停止服务或读写数据库。</p>
          <dl className="confirm-facts">
            <div><dt>目标分支</dt><dd>origin/main（仅快进）</dd></div>
            <div><dt>数据库</dt><dd>{databasePath}</dd></div>
            <div><dt>自动备份</dt><dd>执行前创建并验证</dd></div>
            <div><dt>服务影响</dt><dd>演示停机约 1–3 分钟</dd></div>
          </dl>
          <fieldset className="outcome-picker">
            <legend>演示结果</legend>
            <button type="button" className={demoOutcome === "build-failure" ? "outcome-option is-selected" : "outcome-option"} onClick={() => setDemoOutcome("build-failure")}>
              <AlertCircle size={17} /><span><strong>构建失败</strong><small>展示服务保持停止与后续步骤跳过</small></span>
            </button>
            <button type="button" className={demoOutcome === "success" ? "outcome-option is-selected" : "outcome-option"} onClick={() => setDemoOutcome("success")}>
              <CheckCircle2 size={17} /><span><strong>全部成功</strong><small>展示启动服务和健康检查通过</small></span>
            </button>
          </fieldset>
        </>
      );
    }
    if (activeDialog === "backup") {
      return <p>演示会在列表新增一条备份记录，不会访问或创建本机数据库文件。</p>;
    }
    if (activeDialog === "restore") {
      return (
        <>
          <p>演示恢复前需要确认目标数据库和备份文件。</p>
          <dl className="confirm-facts">
            <div><dt>目标数据库</dt><dd>{databasePath}</dd></div>
            <div><dt>备份文件</dt><dd>{backups[0]?.name ?? "无备份"}</dd></div>
          </dl>
          <p className="dialog-warning"><AlertCircle size={16} />当前演示不会替换任何文件。</p>
        </>
      );
    }
    if (activeDialog === "stop") {
      const row = PROCESS_ROWS[selectedService];
      return (
        <>
          <p>停止前会再次核对进程身份。当前选中的是待核验候选，样稿不会执行停止。</p>
          <dl className="confirm-facts">
            <div><dt>PID</dt><dd>{row.pid}</dd></div><div><dt>端口</dt><dd>{row.port}</dd></div><div><dt>启动时间</dt><dd>{row.startedAt}</dd></div>
          </dl>
        </>
      );
    }
    if (activeDialog === "recheck") {
      return <p>检查不会重跑 Git 更新或构建。若构建错误尚未修复，服务继续保持停止；先查看日志和更新前数据库备份。</p>;
    }
    return null;
  }

  function getDialogActionLabel() {
    if (activeDialog === "update") return "运行演示";
    if (activeDialog === "backup") return "添加演示记录";
    if (activeDialog === "restore") return "继续演示";
    if (activeDialog === "stop") return "确认演示";
    if (activeDialog === "recheck") return "完成";
    return "确定";
  }

  function renderDrawerContent() {
    if (drawer === "changes") {
      return (
        <div className="drawer-section">
          <p className="drawer-intro">显示待更新的模拟变更。正式更新前会检查工作区状态，并只允许从 origin/main 快进。</p>
          <div className="change-list">
            {CHANGE_ROWS.map((item) => <div className="change-row" key={item.path}><span className="change-type">{item.kind}</span><div><strong className="mono">{item.path}</strong><small>{item.summary}</small></div><ArrowRight size={15} /></div>)}
          </div>
          <div className="drawer-footnote"><ShieldCheck size={16} />此样稿不读取真实 Git 工作区。</div>
        </div>
      );
    }
    if (drawer === "logs") {
      return (
        <div className="drawer-section">
          <div className="failure-detail">
            <AlertCircle size={18} />
            <div><strong>步骤 7 · 检查与构建失败</strong><p>模拟返回 1 个构建错误。启动服务和健康检查未执行。</p></div>
          </div>
          <div className="log-code">
            <div><span>10:25:06</span> npm run db:init <b>完成</b></div>
            <div><span>10:25:32</span> npm run lint <b>完成</b></div>
            <div className="log-code-error"><span>10:25:34</span> npm run build <b>失败</b></div>
            <pre>Build failed: demo compilation error
Service state: stopped
Next steps: inspect error, repair code, verify backup</pre>
          </div>
          <div className="drawer-footnote"><HardDrive size={16} />更新前备份：data/backups/inventory.db.20261111_102418</div>
          <Button appearance="secondary" icon={<FileSearch size={15} />} onClick={() => showNotice("演示环境不会打开本机日志文件。")}>查看本机日志（演示）</Button>
        </div>
      );
    }
    if (drawer === "service") {
      const row = PROCESS_ROWS[selectedService];
      return (
        <div className="drawer-section">
          <div className={selectedService === 0 ? "service-trust service-trust-good" : "service-trust service-trust-warn"}>
            {selectedService === 0 ? <CheckCircle2 size={18} /> : <AlertCircle size={18} />}
            <div><strong>{row.state}</strong><span>{selectedService === 0 ? "由本管理器启动并跟踪" : "停止前需要核实项目路径与数据库"}</span></div>
          </div>
          <dl className="detail-list">
            <div><dt>服务</dt><dd>{row.name}</dd></div>
            <div><dt>来源</dt><dd>{row.source}</dd></div>
            <div><dt>监听端口</dt><dd>{row.port}</dd></div>
            <div><dt>PID</dt><dd>{row.pid}</dd></div>
            <div><dt>启动时间</dt><dd>{row.startedAt}</dd></div>
            <div><dt>项目目录</dt><dd className="mono">{projectRoot}</dd></div>
            <div><dt>命令行</dt><dd className="mono">node next start --port {row.port}</dd></div>
          </dl>
          <div className="process-tree"><strong>进程树</strong><span><Folder size={15} /> explorer.exe <ArrowRight size={13} /> node.exe <ArrowRight size={13} /> next start</span></div>
          <div className="drawer-actions">
            <Button appearance="secondary" icon={<RefreshCw size={15} />} onClick={() => showNotice("演示身份核验已完成。")}>重新核验</Button>
            <Button appearance="secondary" disabled={selectedService !== 0} icon={<Square size={14} />} onClick={() => setActiveDialog("stop")}>停止服务</Button>
          </div>
          <p className="drawer-footnote"><ShieldCheck size={16} />停止前重新核对 PID、启动时间和进程身份。</p>
        </div>
      );
    }
    return (
      <div className="drawer-section">
        <p className="drawer-intro">演示备份位置：data/backups</p>
        <div className="drawer-footnote"><Info size={16} />预览不会在本机创建或打开目录。</div>
      </div>
    );
  }

  function getDrawerTitle() {
    if (drawer === "changes") return "待更新变更";
    if (drawer === "logs") return "更新错误日志";
    if (drawer === "service") return "进程详情";
    return "备份位置";
  }

  return (
    <FluentProvider theme={webLightTheme}>
      <div className="manager-shell">
        {!nativeWindow && (
          <div className="preview-titlebar">
            <span className="preview-mark">S</span>
            <span>SUGRID Server Manager</span>
            <span className="preview-context">本地交互样稿</span>
          </div>
        )}

        <div className="app-frame">
          <aside className="side-nav">
            <div className="sidebar-brand"><img src="/brand/sugrid-wordmark.png" alt="溯格 SUGRID" /></div>
            <nav aria-label="主导航" className="nav-list">
              {NAV_ITEMS.map(({ key, label, icon: Icon }) => (
                <Button
                  key={key}
                  appearance="subtle"
                  className={"nav-item" + (activePage === key ? " nav-item-active" : "")}
                  icon={<Icon size={19} strokeWidth={1.9} />}
                  onClick={() => setActivePage(key)}
                  aria-current={activePage === key ? "page" : undefined}
                >
                  <span>{label}</span>
                </Button>
              ))}
            </nav>
            <div className="sidebar-bottom">
              <div className="sample-note"><span className="sample-dot" />演示数据 · 不连接真实服务</div>
              <div className="sidebar-version">SUGRID Server Manager <span>样稿</span></div>
            </div>
          </aside>

          <main className="main-area">
            <div className="content-wrap">
              <header className="page-heading">
                <div>
                  <div className="eyebrow">SUGRID / 本机运维</div>
                  <h1>{currentTitle}</h1>
                  <div className="project-location"><Folder size={15} /><span>{projectRoot}</span></div>
                </div>
                <div className="heading-meta">
                  <span className="sample-date">2026-11-11</span>
                  <Badge appearance="tint" className="demo-badge">演示环境</Badge>
                </div>
              </header>

              {renderHeaderActions()}
              {renderPage()}
            </div>
          </main>
        </div>

        {notice && <div className="toast-message" role="status"><Info size={16} />{notice}</div>}

        <Dialog open={activeDialog !== null} onOpenChange={(_, data) => { if (!data.open) setActiveDialog(null); }}>
          <DialogSurface>
            <DialogBody>
              <DialogTitle>{getDialogTitle()}</DialogTitle>
              <DialogContent>{renderDialogBody()}</DialogContent>
              <DialogActions>
                <Button appearance="secondary" onClick={() => setActiveDialog(null)}>取消</Button>
                <Button appearance="primary" onClick={confirmDialog}>{getDialogActionLabel()}</Button>
              </DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>

        <Drawer
          open={drawer !== null}
          onOpenChange={(_, data) => { if (!data.open) setDrawer(null); }}
          position="end"
          size="medium"
          type="overlay"
        >
          <DrawerHeader>
            <DrawerHeaderTitle
              action={<Button appearance="subtle" icon={<X size={17} />} aria-label="关闭详情" onClick={() => setDrawer(null)} />}
            >
              {getDrawerTitle()}
            </DrawerHeaderTitle>
          </DrawerHeader>
          <DrawerBody>{renderDrawerContent()}</DrawerBody>
        </Drawer>
      </div>
    </FluentProvider>
  );
}

function ActivityList({ items, showDetail = false }: { items: ActivityItem[]; showDetail?: boolean }) {
  return (
    <ol className={"activity-list" + (showDetail ? " activity-list-full" : "")}>
      {items.length === 0 && <li className="empty-state">没有符合条件的日志</li>}
      {items.map((item, index) => (
        <li key={item.time + item.title + index} className={"activity-item activity-" + item.tone}>
          <span className="activity-time">{item.time}</span>
          <span className="activity-icon"><ActivityIcon tone={item.tone} /></span>
          <div className="activity-copy">
            <strong>{item.title}</strong>
            <span>{item.detail}</span>
            {showDetail && <small>本机操作记录 · 2026-11-11</small>}
          </div>
        </li>
      ))}
    </ol>
  );
}

export function App() {
  return <AppContent />;
}
