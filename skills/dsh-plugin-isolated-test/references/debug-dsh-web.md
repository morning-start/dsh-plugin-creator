# Debug 一个 dsh web 实例（分层分诊）

> 原则：**从外往里、每层只回答一个是非题**。乱翻日志最费时间，而且容易把"没起来"误判成"插件坏了"。

## 0. 先确定你在 debug 哪个实例

```powershell
# 谁在监听、监听在哪个口（先看端口，再看进程）
Get-NetTCPConnection -State Listen | Where-Object { $_.LocalPort -in 3099,3080,52332 } |
  Select-Object LocalPort, OwningProcess
Get-Process -Id <pid> | Select-Object Id, ProcessName, Path
```

三个必须能回答的问题：

1. 这是**我起的**实例，还是用户的（桌面端 / 他开的 web）？→ 决定你能不能停它。
2. 它的 `DSH_HOME` 是哪个？→ 同一 shell 里 `$env:DSH_HOME` 只影响你起的子进程；已运行实例要用日志/命令行判断。
3. 它的 profile 是哪个？→ 决定"该有哪个插件"。

## 1. 它起来了吗（进程 + 端口 + 启动行）

```powershell
# 启动输出里应该有一行 URL（带 token）
Get-Content tmp\web-3099.log -Tail 8
```

- 有 `dsh web: http://127.0.0.1:<port>/?token=…` → 起来了。
- 只有 `[hub] routes mounted (profile=…)` 没有 URL → 卡在更早的初始化，去看 stderr。
- `EADDRINUSE` → 端口被别人占：换口，**不要**杀不认识的进程。
- `N required plugins did not activate` → 有插件加载失败；这一步就会导致"入口不见了"，先修它再谈功能。

## 2. 首页能打开吗（HTTP + 认证）

```powershell
curl.exe -s -o NUL -w "status=%{http_code} size=%{size_download}\n" http://127.0.0.1:3099/
```

- `200` + 几十 KB HTML → 静态站正常。
- `401` → 认证闸在（预期）。带 cookie 再试：
  ```powershell
  # 只对**你自己起的**实例做：用启动行里打印的 token 铸一次 cookie
  curl.exe -s -D - -o NUL "http://127.0.0.1:3099/?token=<你实例打印的 token>"
  # 取 Set-Cookie 的第一段，后续请求带 -H "cookie: <pair>"
  ```
- `403`/`MT_UNTRUSTED_HOST` → 你在走反代/局域网 Host；给实例加 `--trusted-host <authority>`，别去改认证代码。

> 反过来：**不要**为了截图去用户实例里找 token、改 HOME、翻浏览器 profile。浏览器控制不可用时，把"视觉未验证"写进报告。

## 3. 页面里到底有没有你的客户端（bundle 组，不是单文件）

首页 HTML 里给的是**合并后的** bundle URL，形如：

```
plugins/??@deepseek-ai/dsh-client-ui-layout/client.js, …,dsh-plugin-myteam/client.js&rev=…
```

自己拼 `/plugins/dsh-plugin-myteam/client.js` 会 **404**（真实踩过）。正确做法：

```powershell
# 从首页 HTML 里取出含 plugins/ 的 URL，原样请求那一条，再断言里面有你仓库的原文片段
node tools/…  # 或 curl 后 Select-String
```

判据：响应 200、长度合理、内容包含你仓库 `client/client.js` 的特征串（比如你的 slot id、标签文案）。
这一步过了，才说明"客户端那一半真的被发出来了"。

## 4. 你的路由在不在（HTTP 契约）

面板类插件一般自己注册 HTTP 路由。按契约逐条打：

| 请求 | 期望 | 说明 |
|---|---|---|
| 不带 cookie | `401` + 你自己的错误码 | 准入在路由前面 |
| 缺必要参数（如 `sessionId`） | `400` + `BAD_REQUEST` | 参数校验 |
| 未知方法 | `404` + `UNKNOWN_METHOD` | 方法表是白名单 |
| 非 POST | `405` | 只接受 POST |
| 需要活会话但传了假 id | `200` + 明确拒绝（如"没有绑定工作区"） | **不许**回落到进程 cwd |

最后一条是重点：会话类方法必须依赖"本进程活会话"，回落会把面板接到错误项目上，属于静默错误。

## 5. 活会话从哪来（agents.get 的边界）

面板/工具里拿 `agents.get(sessionId)` 的地方，只认**本进程活着**的会话；脚本编一个 id 一定失败。

两条合法路径：

1. **让人在页面里开一个会话**（最真实，适合验收）。
2. **用 gateway 的 `session.create` 造一个**（适合自动化）：

```text
POST /api/session/create
content-type: application/json
cookie: <你的实例 cookie>

{"type":"client-request","rpcId":"<uuid>","method":"session/create",
 "payload":{"args":{"request":{"cwd":"<绝对路径>"}}}}
```

- 返回 `{"result":{"ok":true,"value":{"sessionId":"session-…"}}}`。
- 参数形状写错会报 `gateway/arguments-invalid` 或
  `Remote payload must contain exactly one plain-object args field`——看到这两句，先改形状，别怀疑插件。

## 6. 数据对不对（和磁盘对账）

接口 200 不等于数据对。至少对一处：

- 看板按状态计数之和 == 概览 `totals.all`；
- 审计 `items.length` 与账本行数量级一致（受 `limit` 影响）；
- 团队/任务名与工作区 `.dsh-*` 下的账本/投影一致。

## 7. 写不进去（锁与租约）

症状：写接口返回 `WRITER_LEASE_LOST`，`details` 里带 `pid` / `renewedAt` / `owner`。

- 含义：**另一个活进程**正持有这个项目的写者锁（单写者设计，不是 bug）。
- 锁文件在工作区数据目录里（本项目是 `.dsh-myteam/state/writer.lock`）。
- 处置：① 停掉另一个写者；② 或把项目**拷一份**当测试工作区，并删掉副本里的 `state/writer.lock`；
  ③ 不要删真实项目里的锁去"抢"。

## 8. 日志在哪

| 位置 | 有什么 |
|---|---|
| 你起的实例的 stdout/stderr（重定向到 `tmp/*.log`） | 启动行、URL、插件 warn、`EADDRINUSE`、路由注册失败 |
| `$DSH_HOME/logs/` | 宿主自己的启动/运行日志（含插件激活失败清单） |
| `%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*-host.log` | 桌面端崩溃时的宿主日志（`exited with …` 就在这里） |

读日志的两个细节：Windows 下 `cmd > file` 重定向可能是 UTF-16LE（前两字节 `FF FE`）；
`Select-Object -First n` 截断管道会让退出码看起来是失败，别把它当成"命令失败"。