# 溯格 / SUGRID

基于 Next.js、React 与 SQLite 的机器采购、库存、销售和售后管理系统。

## 启动

在项目目录执行：

```powershell
npm ci
npm run db:init
npm run dev -- --hostname 0.0.0.0 --port 3000
```

生产部署或更新源码时，先停止原服务，再逐条执行；每条成功后才继续下一条：

```powershell
git pull origin main
npm ci
npm run db:init
npm run build
npm run start -- --hostname 0.0.0.0 --port 3000
```

`npm start` 只启动已有的生产构建。`.next` 不随 Git 分发；首次安装、更新源码或清理构建目录后都需要先完成 `npm run build`。如果出现 `Could not find a production build`，先查看构建是否成功，不需要删除数据库。

本机访问 `http://127.0.0.1:3000`，局域网访问 `http://服务器局域网IP:3000`。局域网访问需要主机防火墙允许相应端口。

## 登录与部署协议

会话存储在数据库，浏览器只持有 HttpOnly、SameSite=Lax Cookie。开放注册的账号需经管理员审核；启用分仓管时必须分配至少一个启用仓库。

`SESSION_COOKIE_SECURE` 控制会话 Cookie 是否仅通过 HTTPS 发送：

| 配置 | 行为 |
| --- | --- |
| 不配置 | 根据应用接收到的请求 URL 协议选择；本机、局域网 HTTP 可用 |
| `true` | 仅通过 HTTPS 发送 Cookie；用于 HTTPS 部署 |
| `false` | 允许 HTTP；用于局域网 HTTP 部署 |

可在项目 `.env.local` 或进程环境变量中配置。应用不直接信任 `X-Forwarded-Proto` 等代理请求头。如果反向代理对外提供 HTTPS、对 Next.js 使用内部 HTTP，应显式设置 `SESSION_COOKIE_SECURE=true`。修改环境变量后需重新启动服务。

用户姓名修改及无变化保存保留登录；账号停用、权限变更、实际密码变更会撤销相应会话。本人修改密码后需重新登录。

## 数据库与验证

默认数据库为 `data/inventory.db`；启动时执行幂等版本迁移，保留现有业务记录。通过 `INVENTORY_DB_PATH` 可指定独立数据库，例如自动化测试库。不要将测试数据写入正式数据库。

```powershell
npm run lint
npx tsc --noEmit
npm run build
node scripts/test-account-api.cjs
```

账号接口测试使用独立内存 SQLite，覆盖登录审计、协议 Cookie、审核权限、会话撤销和个人改密，不会打开正式数据库。
