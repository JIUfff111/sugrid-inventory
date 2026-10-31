<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Project Working Rules

- 以真实使用者的操作习惯和工作效率为优先；所有面向人的功能都应减少重复输入、明确当前状态、允许纠错和撤销，并在批量操作时清楚展示影响范围。
- 同类业务尽量提供一致的搜索、选择、确认、反馈和错误恢复体验；避免默认假设用户只处理一条记录，支持批量的场景应支持批量并保留逐项控制。
- After every code change, create a corresponding Git commit so the change can be traced and reverted.
- After every code change, add or update the relevant tests. Before delivery, run the relevant test suite and confirm that all required checks pass.
