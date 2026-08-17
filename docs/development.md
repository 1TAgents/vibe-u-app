# 开发、运行与验证

本文说明 VibeU 的技术栈、本地运行、环境变量、验证命令、代码结构和存储模式。产品定位见项目根目录的 [README](../README.md)，编排与质量门见 [架构设计](architecture.md)。

## 技术栈

| 层 | 技术 |
| --- | --- |
| Web | Next.js 16、React 19、TypeScript |
| 样式 | Tailwind CSS 4 |
| 生成代码构建 | esbuild、Tailwind Node/Oxide |
| 功能验收 | jsdom、自研语义操作与断言执行器 |
| 本地存储 | JSON、JSONL 文件 |
| 线上存储 | Neon/Postgres Serverless |
| 模型接口 | OpenAI-compatible 非流式 Chat Completions |
| 部署 | Vercel |

模型客户端只在一次请求完成后保留最终正文、用量、成本和耗时，不把 reasoning
或 token 分片写入事件库。瞬时网络故障、空正文、异常重复输出和结构化结果解析失败
仍会留下可审计事件。平台角色默认关闭 thinking，避免非流式多角色流程被无法展示的推理长时间占用。

## 本地运行

要求：Node.js `>=20.9.0`。

```bash
npm install
cp .env.example .env.local
npm run dev
```

打开 [http://localhost:3002](http://localhost:3002)。

默认脚本：

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 在 3002 端口启动开发服务器 |
| `npm run check` | TypeScript、ESLint 和全部测试 |
| `npm run build` | 使用 webpack 创建生产构建 |
| `npm run start` | 在 3002 端口运行生产构建 |

## 环境变量

至少需要配置一个 OpenAI-compatible 模型端点：

```dotenv
LLM_BASE_URL=https://your-provider.example/v1
LLM_API_KEY=your-api-key
LLM_MODEL=deepseek-v4-flash
```

可选配置：

```dotenv
# 首页可选模型，逗号分隔
LLM_RACE_MODELS=deepseek-v4-flash,glm-5.2

# 不设置时使用本地 .data 文件存储
DATABASE_URL=postgresql://user:pass@host/db?sslmode=require
```

API Key 仅在服务端读取，不应提交到仓库或暴露给生成应用。

## 验证

```bash
npm run check
npm run build
```

当前测试主要覆盖：

- Postgres SQL、事件幂等、应用数据隔离和候选/公开存储语义；
- React 构建、Tailwind 编译和平台运行时注入；
- DOM 可见性、区域约束、稳定标签和记录级操作定位；
- 字段、属性、数值边界、计时器推进和数据持久化；
- 测试计划覆盖、复杂场景护栏和静默假通过防护；
- 调度预算、质量门不可绕过、SSE 取消和失败收敛；
- LLM 网络重试、推理降级、usage 和成本归因；
- 群聊事件去重与交付摘要。

这些测试验证 DOM 行为和确定性判定，不包含真实浏览器布局、像素级截图或视觉回归。相关边界见 [架构设计：当前边界](architecture.md#八当前边界)。

## 仓库结构

```text
src/
  app/
    a/[runId]/           生成应用公开页面
    api/run/             新建、续跑、变更、排队和终止 API
    api/appdata/         生成应用数据 API
    r/[runId]/           保留的只读回放页面
    workspace/           项目工作区
  components/            群聊、设计、代码、预览和测试界面
  lib/
    orchestrator.ts      动态调度主循环
    piper.ts             调度契约和提示词
    roles.ts             五个执行角色及提示词
    contracts.ts         结构化产物 schema
    gates.ts             平台质量门注册表
    budget.ts            派单预算与收敛限制
    builder.ts           生成代码构建
    testrunner.ts        语义操作和功能断言执行器
    delivery.ts          界面探查与交付采证
    events.ts            事件定义
    fold.ts              从事件恢复运行状态
    store.ts             文件与 Postgres 存储适配器
tests/                   构建、存储、质量门、验收与编排测试
docs/                    架构、开发和未来演进文档
```

## 存储模式

### 本地文件

未设置 `DATABASE_URL` 时，运行记录、事件、应用 bundle 和业务数据写入 `.data/`：

```text
.data/runs/<runId>/
  run.json
  events.jsonl
  app-bundle.json
  app/<collection>.json
```

### Postgres / Neon

设置 `DATABASE_URL` 后，服务端使用 `@neondatabase/serverless` 并自动创建：

- `runs`：运行索引与状态；
- `run_events`：追加式事件；
- `app_bundles`：候选和公开 bundle；
- `app_rows`：生成应用的业务数据。

存储适配器支持 `candidate` 与 `published` 双槽。新构建先进入候选预览；只有
功能 QA、交付证据和产品验收全部通过，候选版才会原子晋升为公开版。
后续修改失败时不覆盖上一个已发布版本。

## 生成应用运行时

生成代码由 Cody 输出，平台额外注入 `/db.js` 和 `/index.js`。构建器完成以下工作：

1. 校验和打包 React 源码；
2. 扫描源码并编译实际使用的 Tailwind CSS；
3. 将 JavaScript、CSS 和运行配置组装成自包含 HTML；
4. 在工作区预览或 `/a/[runId]` 公开路由中返回应用。

生成应用通过平台 `db` 接口访问 `/api/appdata/[runId]/[collection]`。功能测试和界面探查使用隔离命名空间；公开应用数据使用项目自己的 `runId`。
