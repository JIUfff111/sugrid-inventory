export type DemoOutcome = "success" | "build-failure";
export type StepStatus = "pending" | "running" | "complete" | "failed" | "skipped";

export interface UpdateStep {
  key: string;
  title: string;
  detail: string;
}

export const FAILED_STEP_INDEX = 6;

export const UPDATE_STEPS: UpdateStep[] = [
  {
    key: "preflight",
    title: "前置检查",
    detail: "核对分支、工作区、远程状态和数据库配置。",
  },
  {
    key: "backup",
    title: "数据库备份",
    detail: "备份 data/inventory.db，并验证备份可读。",
  },
  {
    key: "stop",
    title: "停止服务",
    detail: "只停止已核验的库存系统进程。",
  },
  {
    key: "pull",
    title: "Git 快进更新",
    detail: "从 origin/main 执行 git pull --ff-only。",
  },
  {
    key: "dependencies",
    title: "安装依赖",
    detail: "使用 npm ci 按锁文件安装依赖。",
  },
  {
    key: "migrate",
    title: "数据库迁移",
    detail: "运行 npm run db:init。",
  },
  {
    key: "build",
    title: "检查与构建",
    detail: "运行 lint、TypeScript 检查和生产构建。",
  },
  {
    key: "start",
    title: "启动服务",
    detail: "启动库存系统并记录新进程身份。",
  },
  {
    key: "health",
    title: "健康检查",
    detail: "确认端口、登录页和数据库连接可用。",
  },
];

export function getUpdateProgress(
  completedCount: number,
  runningIndex: number | null = null,
): StepStatus[] {
  return UPDATE_STEPS.map((_, index) => {
    if (index < completedCount) return "complete";
    if (index === runningIndex) return "running";
    return "pending";
  });
}

export function getTerminalStatuses(outcome: DemoOutcome): StepStatus[] {
  if (outcome === "success") return UPDATE_STEPS.map(() => "complete");

  return UPDATE_STEPS.map((_, index) => {
    if (index < FAILED_STEP_INDEX) return "complete";
    if (index === FAILED_STEP_INDEX) return "failed";
    return "skipped";
  });
}
