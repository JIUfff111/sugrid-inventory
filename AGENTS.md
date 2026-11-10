<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Project Working Rules

- 开始处理问题前，先核对前提、逻辑链和缺失信息；保持独立判断，并明确区分已验证事实、预测和主观建议。
- 以真实使用者的操作习惯和工作效率为优先；所有面向人的功能都应减少重复输入、明确当前状态、允许纠错和撤销，并在批量操作时清楚展示影响范围。
- 同类业务尽量提供一致的搜索、选择、确认、反馈和错误恢复体验；避免默认假设用户只处理一条记录，支持批量的场景应支持批量并保留逐项控制。
- 浏览器验收固定使用隔离测试账号 `experience-qa`，并确认服务连接独立 QA 数据库；禁止用正式账号或正式数据库做测试，也不要把测试密码写入项目规范文件。
- After every code change, create a corresponding Git commit so the change can be traced and reverted.
- After every code change, add or update the relevant tests. Before delivery, run the relevant test suite and confirm that all required checks pass.
- 硬性要求：每次任务交付前，确认当前项目服务正在运行，并在本对话右侧内置浏览器中复用现有标签打开项目页面；实际确认页面可访问后再回复，写明预览地址、端口和所连接的数据库环境。代码变更需要重启时先完成构建与测试，再重启服务并验证。
- 测试与演示继续使用独立 QA 数据库和固定测试账号，不把测试数据写进正式数据库。优先复用一个预览端口和浏览器标签；确需额外隔离环境时说明用途，结束时清理自己创建且不再使用的测试服务与标签，不关闭用户正在使用的资源。
