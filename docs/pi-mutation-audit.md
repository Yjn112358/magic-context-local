# Magic Context 修改审计

## 范围与启用

本地 `magic-context-local/packages/pi-plugin/` 增加可选审计，不修改 Pi 核心，也不捕获 Billion Context。

在启动 Pi 的 PowerShell 中设置：

```powershell
$env:MAGIC_CONTEXT_MUTATION_AUDIT = '1'
$env:PI_SESSION_AUDIT_DIR = "$env:USERPROFILE/.pi/agent/session-audit"
```

审计默认关闭。环境变量只对之后启动的进程生效；已运行 Pi 应重启。必须加载带此改动的本地构建，npm 版不包含此能力。不要同时加载本地与 npm 版 Magic Context。

本地包入口以 `packages/pi-plugin/package.json` 的 `pi.extensions` 为准，为 `dist/index.js`。构建后将 Pi 的 Magic Context 包路径替换为本地 `C:/Users/admin/Work/PiAgent/magic-context-local/packages/pi-plugin`，审计查看器包路径不变。

## 捕获位置

`src/index.ts` 将该实例的 Extension API 包装为 `withMagicMutationAudit(pi)`。它仅包裹该实例注册的处理器，不修改共享 Pi API，也不包裹其他插件。

捕获这些钩子的执行前事件、执行后事件、返回值和异常：

- `input`
- `before_agent_start`
- `context`
- `tool_call`、`tool_result`
- `before_provider_headers`、`before_provider_request`
- `session_before_compact`、`session_before_tree`

即使处理器未改写事件也保存记录。多个同名处理器分别生成调用 ID。系统提示词通常通过返回值替换，消息流水线可能原地修改，也可能返回新的消息数组。

同时捕获 `sendMessage`、`sendUserMessage` 的调用参数。使用 `AsyncLocalStorage` 从钩子或命令处理器传递会话上下文，包含 `/ctx-aug` 和清理提醒路径。它记录的是 API 被成功调用，不保证消息已经排入上下文或最终送入模型。无上下文时发出警告，不猜测会话归属。`session_shutdown` 等待已有写入队列完成。

## 存储格式

```text
<PI_SESSION_AUDIT_DIR>/mutations/<Pi-session-id>.jsonl
<PI_SESSION_AUDIT_DIR>/mutations/blobs/<SHA256>.json
```

每条元数据包含：

| 字段 | 来源与含义 |
|---|---|
| `auditVersion`、`event` | 插件格式版本及固定事件 `extension_mutation` |
| `sessionId` | Pi SessionManager 提供的会话 ID |
| `source`、`sourceVersion`、`sourceEntry` | 来源项目、包版本及审计模块入口；不能替代 Git commit 证明 |
| `invocationId` | 插件生成的调用 UUID，不是 Provider request ID |
| `hook`、`handlerIndex` | 钩子名称或主动注入 API 名称、同名钩子的注册序号（从 0 开始；API 记录为 0） |
| `startedAt`、`timestamp`、`durationMs` | 插件测得的开始时间、完成写入前时间及处理器耗时 |
| `outcome` | `success` 或 `error`，描述处理器结果 |
| `changed` | 脱敏后的前后快照哈希是否不同，包含返回值及异常差异 |
| `beforeRef`、`afterRef` | 快照哈希及 UTF-8 字节数 |

快照结构为 `{ event, returned, error }`。执行前的 `returned`、`error` 为 `null`；执行后记录实际返回值和异常。快照是可 JSON 序列化的值，不是 JavaScript 内存对象。

凭据按键名递归脱敏；`PI_SESSION_AUDIT_REDACT=0` 可关闭，风险由操作者承担。Token 数量字段以 `tokens` 结尾时不脱敏。字符串内部的源码、用户粘贴凭据不会自动识别，应按敏感本地数据管理整个目录。循环引用用占位符表示，函数等不可序列化值转为 `null`。

快照按内容哈希去重，但变化很小的完整消息数组仍会产生新快照；不是分块存储。开启审计会增加序列化、磁盘写入延迟和存储占用，适合诊断，不代表零开销。写入失败发出警告并保留原处理器返回或异常，审计不是失败关闭。

## 查看与边界

会话审计网页右侧底部提供“Magic Context 修改记录（整个会话）”。列表分页，每页 50 条；前后快照按需读取，长内容默认 100 字符预览。显示原地改写字段、返回的修改建议、异常和完整前后快照。消息数组额外显示共同前后缀与差异区间计数，不将数组位置差异直接认定为独立删除或新增。

以下不在本次覆盖范围：

- 宿主合并返回值之后的最终状态及后续插件修改。
- Magic Context 内部通过其他底层对象写入会话的路径、后台子代理的完整请求或任意文件/网络操作。
- 缺少本地审计记录的历史注入，无法事后恢复。
- 从时间推测对话或请求归属；页面按整个 Pi 会话展示，不强行绑定 `turnIndex` 或 Provider 请求。

应结合现有 `before_provider_request.data.payload` 确认修改内容是否在后续请求中保留。本记录证明该实例处理器看到和返回了什么，不是网络层审计。

## 验证

- `bun run --cwd packages/pi-plugin typecheck`
- `bun test --cwd packages/pi-plugin src/mutation-audit-pi.test.ts`
- `bun run --cwd packages/pi-plugin test`
- `bun run --cwd packages/pi-plugin lint`
- `npm run typecheck`、`npm test`（`pi-session-audit-local/`）

当前环境新增定向测试、类型检查及最终官方 build 通过；全量测试出现 Windows 文件锁、Pi/OMP harness 锁定等失败（955 通过、46 失败、7 errors），lint 出现大量 CRLF 格式诊断，不能宣称全量检查通过。首次官方 build 在 `dist/*-*.js` 无匹配时失败，分别执行构建步骤生成初始产物后，最终重新执行官方 build 已通过。
