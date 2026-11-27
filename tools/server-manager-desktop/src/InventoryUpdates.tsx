import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Button } from "@fluentui/react-components";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { ArrowDownToLine, CheckCircle2, CircleHelp, ExternalLink, LoaderCircle, RefreshCw, ShieldCheck, Upload, XCircle } from "lucide-react";
import { maintenanceAccess } from "./manager-display";

export interface InventoryCache {
  state: "idle" | "checking" | "cached" | "empty" | "offline" | "failed";
  version: string | null;
  message: string;
}

interface InventoryRelease {
  currentVersion: string | null;
  latestVersion: string;
  releaseUrl: string;
  releaseNotes: string | null;
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
  operationHistoryError?: string | null;
}

const STAGES: Record<string, string> = {
  idle: "待命",
  copying: "复制到安全目录",
  verifying: "验证发布签名",
  backing_up: "备份数据库",
  migrating: "迁移测试副本",
  switching: "切换库存版本",
  starting: "启动库存服务",
  health_check: "检查服务健康",
  rolling_back: "恢复旧版本",
  rolled_back: "已恢复旧版本",
  complete: "完成",
};
const STAGE_ORDER = ["copying", "verifying", "backing_up", "migrating", "switching", "starting", "health_check", "complete"];

function errorText(value: unknown) {
  return typeof value === "string" ? value : value instanceof Error ? value.message : "操作失败，请查看更新服务日志。";
}

export function InventoryUpdates({ canManage, pollPaused, updaterAvailable, currentVersion, cache, prefetchBusy, onPrefetch }: {
  canManage: boolean;
  pollPaused: boolean;
  updaterAvailable: boolean;
  currentVersion: string | null;
  cache: InventoryCache;
  prefetchBusy: boolean;
  onPrefetch: () => Promise<void>;
}) {
  const [release, setRelease] = useState<InventoryRelease | null>(null);
  const [status, setStatus] = useState<UpdaterStatus | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [statusError, setStatusError] = useState("");
  const pausedRef = useRef(pollPaused);
  useEffect(() => {
    pausedRef.current = pollPaused;
  }, [pollPaused]);

  const refreshStatus = useCallback(async () => {
    if (pausedRef.current) return;
    if (!updaterAvailable) {
      setStatus(null);
      setStatusError("");
      return;
    }
    try {
      const next = await invoke<UpdaterStatus>("integrated_updater_status");
      if (pausedRef.current) return;
      setStatus(next);
      setStatusError("");
      if (next.state === "failed" || next.state === "cancelled" || next.state === "succeeded" || next.state === "recovered") setNotice("");
    } catch (reason) {
      if (pausedRef.current) return;
      setStatus(null);
      setStatusError(errorText(reason));
    }
  }, [updaterAvailable]);

  const checkRelease = useCallback(async () => {
    setBusy("check");
    setError("");
    try { setRelease(await invoke<InventoryRelease>("integrated_check_inventory_update")); }
    catch (reason) { setRelease(null); setError(errorText(reason)); }
    finally { setBusy(""); }
  }, []);

  useEffect(() => {
    void checkRelease();
  }, [checkRelease]);

  useEffect(() => {
    if (pollPaused) return;
    void refreshStatus();
    const timer = window.setInterval(() => void refreshStatus(), 1500);
    return () => window.clearInterval(timer);
  }, [refreshStatus, pollPaused]);

  async function perform(label: string, command: () => Promise<UpdaterStatus>) {
    setBusy(label);
    setError("");
    setNotice("");
    try {
      const next = await command();
      setStatus(next);
      setNotice(next.operationId ? "维护任务已开始，进度会在下方更新。" : "操作已完成。");
    } catch (reason) { setError(errorText(reason)); }
    finally { setBusy(""); }
  }

  async function installOnline() {
    if (!release?.latestVersion) return;
    if (!window.confirm(`安装库存版本 ${release.latestVersion}？更新期间会备份数据库，并短暂停止库存服务。`)) return;
    await perform("online", () => invoke<UpdaterStatus>("integrated_install_inventory_online", { version: release.latestVersion }));
  }

  async function installCached() {
    if (!cache.version) return;
    if (!window.confirm(`安装本机已验签的库存版本 ${cache.version}？更新服务会再次验签、备份数据库并短暂停止库存服务。`)) return;
    await perform("cached", () => invoke<UpdaterStatus>("integrated_install_inventory_cached", { version: cache.version }));
  }

  async function importOffline() {
    try {
      const selected = await open({ multiple: false, directory: false, filters: [{ name: "SUGRID 库存签名包", extensions: ["zip"] }] });
      if (typeof selected !== "string") return;
      const filename = selected.split(/[\\/]/).pop() ?? selected;
      if (!window.confirm(`安装库存签名包「${filename}」？后台服务会验签、备份并短暂停止库存服务。`)) return;
      await perform("offline", () => invoke<UpdaterStatus>("integrated_install_inventory_file", { path: selected }));
    } catch (reason) { setError(errorText(reason)); }
  }

  async function cancel() {
    if (!status?.operationId) return;
    await perform("cancel", () => invoke<UpdaterStatus>("integrated_cancel_inventory_update", { operationId: status.operationId }));
  }

  const running = status?.state === "running";
  const stageIndex = STAGE_ORDER.indexOf(status?.stage ?? "");
  const cancelAllowed = running && stageIndex >= 0 && stageIndex < STAGE_ORDER.indexOf("switching");
  const installedVersion = status?.inventoryVersion ?? currentVersion;
  const serviceReady = updaterAvailable && !statusError && status?.available === true;
  const maintenanceAllowed = maintenanceAccess(canManage, status?.canManage, status?.operationHistoryError);
  const onlineUpdateAvailable = release?.updateAvailable && release.latestVersion !== installedVersion;
  const cachedUpdateAvailable = Boolean(cache.version && cache.version !== installedVersion);
  const cacheTitle = cache.state === "cached" ? "正式包已验签并缓存" : cache.state === "offline" ? "网络不可用" : cache.state === "failed" ? cache.version ? "最新包缓存失败 · 已有可用缓存" : "缓存失败" : cache.state === "empty" ? "尚无库存包缓存" : "正在查找正式库存包";

  return <section className="integrated-section integrated-update-panel">
    <div className="integrated-section-heading"><div><h2>库存系统</h2><span>独立发布与更新，管理器本身不会随之替换</span></div><Badge appearance="tint" className={installedVersion ? "integrated-badge-good" : "integrated-badge-muted"}>{installedVersion ? `当前 ${installedVersion}` : "旧版 · 业务版本待核验"}</Badge></div>
    <p>{release && installedVersion === release.latestVersion ? "当前库存系统已是最新正式版本。" : release?.message ?? "正在查询已发布的库存版本…"}</p>
    <div className={`integrated-cache-state is-${cache.state}`} role="status">
      {cache.version && cache.state !== "checking" ? <ShieldCheck size={18}/> : cache.state === "checking" ? <LoaderCircle className="spin" size={18}/> : cache.state === "failed" || cache.state === "offline" ? <XCircle size={18}/> : <CircleHelp size={18}/>}
      <div><strong>{cacheTitle}{cache.version ? ` · ${cache.version}` : ""}</strong><span>{cache.message}</span></div>
    </div>
    {release?.releaseNotes ? <pre className="integrated-release-notes">{release.releaseNotes}</pre> : null}
    {!updaterAvailable ? <div className="integrated-alert" role="alert"><XCircle size={16}/><span>库存更新服务不可用。请检查过渡版管理器和 Windows 更新服务是否已安装并运行。</span></div> : null}
    {statusError ? <div className="integrated-alert" role="alert"><XCircle size={16}/><span>无法读取库存更新服务状态：{statusError}</span></div> : null}
    {error ? <div className="integrated-alert" role="alert"><XCircle size={16}/><span>{error}</span><button type="button" onClick={() => setError("")}>关闭</button></div> : null}
    {notice ? <div className="integrated-notice" role="status"><CheckCircle2 size={16}/><span>{notice}</span></div> : null}
    {status?.state === "failed" && status.error ? <div className="integrated-alert" role="alert"><XCircle size={16}/><span>{status.error}</span></div> : null}
    {status?.state === "recovered" && status.error ? <div className="integrated-notice" role="status"><CheckCircle2 size={16}/><span>{status.error}</span></div> : null}
    {busy === "online" || busy === "offline" || busy === "cached" ? <div className="integrated-progress is-submitting" role="status"><div><strong>{busy === "online" ? "正在下载并提交库存包" : busy === "cached" ? "正在提交已缓存库存包" : "正在提交离线签名包"}</strong><span>校验完成前，现有库存服务继续运行。</span></div><LoaderCircle className="spin" size={17} /></div> : null}
    {status?.operationId ? <div className="integrated-progress" role="status" aria-live="polite">
      <div><strong>{status.state === "running" ? "更新进行中" : status.state === "succeeded" ? "最近操作已完成" : status.state === "failed" ? "最近操作失败" : status.state === "recovered" ? "已恢复中断操作" : status.state === "cancelled" ? "操作已取消" : "最近操作"}</strong><span>{STAGES[status.stage ?? ""] ?? status.stage ?? "待命"}</span></div>
      <div className="integrated-progress-steps">{STAGE_ORDER.map((stage, index) => <span key={stage} className={index <= stageIndex ? "is-reached" : ""} title={STAGES[stage]} />)}</div>
      {cancelAllowed && maintenanceAllowed ? <Button appearance="subtle" size="small" onClick={() => void cancel()} disabled={Boolean(busy)}>切换前取消</Button> : null}
    </div> : null}
    <div className="integrated-control-bar">
      <Button appearance="secondary" icon={<RefreshCw size={15}/>} onClick={() => void checkRelease()} disabled={Boolean(busy)}>检查库存版本</Button>
      <Button appearance="secondary" icon={prefetchBusy ? <LoaderCircle className="spin" size={15}/> : <ArrowDownToLine size={15}/>} onClick={() => void onPrefetch()} disabled={prefetchBusy || Boolean(busy) || running}>缓存最新正式包</Button>
      {maintenanceAllowed ? <>{cachedUpdateAvailable ? <Button appearance="primary" icon={busy === "cached" ? <LoaderCircle className="spin" size={15}/> : <ShieldCheck size={15}/>} onClick={() => void installCached()} disabled={!serviceReady || Boolean(busy) || running || prefetchBusy}>安装已缓存版本</Button> : null}{onlineUpdateAvailable && release?.latestVersion !== cache.version ? <Button appearance="primary" icon={busy === "online" ? <LoaderCircle className="spin" size={15}/> : <ArrowDownToLine size={15}/>} onClick={() => void installOnline()} disabled={!serviceReady || Boolean(busy) || running || prefetchBusy}>{installedVersion ? "在线安装更新" : "在线安装库存系统"}</Button> : null}<Button appearance="secondary" icon={busy === "offline" ? <LoaderCircle className="spin" size={15}/> : <Upload size={15}/>} onClick={() => void importOffline()} disabled={!serviceReady || Boolean(busy) || running}>导入签名包</Button></> : null}
      {release?.releaseUrl ? <Button appearance="subtle" icon={<ExternalLink size={15}/>} onClick={() => window.open(release.releaseUrl, "_blank", "noopener,noreferrer")}>查看发布记录</Button> : null}
    </div>
    {serviceReady && !maintenanceAllowed ? <div className="integrated-inline-help"><CircleHelp size={15}/><span>当前无法执行库存维护，请检查维护权限和操作记录状态。</span></div> : null}
  </section>;
}
