# 集成测试：用 CDP 看真页面

功能测试证明「接口对」，集成测试要证明「用户看得见的东西对」。这一段以前只能靠人：截图、点一遍、回传。

现在不用了。沙盒给你一个带 token 的 URL，无头浏览器给你眼睛和手。

## 怎么用

```powershell
node scripts/sandbox.mjs start default          # 沙盒起来，URL 记进登记表
node scripts/ui.mjs shot default --path / --out tmp/ui/home.png
node scripts/ui.mjs assert default --text "新会话" --no-console-errors
node scripts/ui.mjs eval default --expression "document.title"
node scripts/ui.mjs close
```

或者用工具：`dsh_plugin_ui { action: 'shot' | 'assert' | 'eval' | 'close', sandbox, path }`。

**token 不用你操心**：给沙盒名，URL 和 `?token=` 从沙盒自己的日志里取；正文里出现的 token 不会回显。

## 三种证据，别混

| 动作 | 证明什么 | 不证明什么 |
|---|---|---|
| `shot` | 页面**渲染**成了什么样（真实像素，能看图） | 对错——一张好看的截图也可能是错的 |
| `assert` | 某个**断言**成立：选择器在、文案在、表达式等于某值、没有 console error、没有失败请求 | 好不好看、用户会不会用 |
| `click` / `type` | 交互**真的跑通**了（真实鼠标事件与 `Input.insertText`，不是 `element.click()`） | 业务流程对不对（那要配合数据对账） |

三条纪律，来自真实事故：

1. **没拍到的截图不许说拍到了**：`Page.captureScreenshot` 没数据就报错，不落占位图。
2. **断言要写「必须成立什么」**，不是「看起来有东西」。`document.querySelectorAll('*').length` 能证明页面渲染了 1254 个节点，但证明不了内容对。
3. **`element.click()` 不算点击**：React 输入框和 `contenteditable` 会忽略合成事件，必须走 `Input.dispatchMouseEvent` + `Input.insertText`。

## 一次完整的集成测试长什么样

```
1. 沙盒起来           dsh_sandbox { action: 'start' }
2. 装真实数据         dsh_sandbox { action: 'seed', entries: ['myteam'] }
3. 开页面并断言       dsh_plugin_ui { action: 'assert', assertions: [
                        { selector: '[data-slot="session-tab"]' },
                        { text: '团队视图' },
                        { noConsoleErrors: true },
                        { noNetworkFailures: true } ] }
4. 点一遍             dsh_plugin_ui { action: 'assert', click: '...', assertions: [...] }
5. 截图留证           dsh_plugin_ui { action: 'shot', path: '/', out: '...' }
6. 关浏览器           dsh_plugin_ui { action: 'close' }
```

判据：**断言全过 + 截图人看过 + 数据与磁盘对得上**。三者缺一，就写「未验证」。

## 沙盒验不到的部分

- **真实点击路径**：CDP 能点，但「用户会不会这么点」仍要人判断；
- **视觉判断**：对比度、留白、信息层次——截图给了素材，判断是人给的；
- **多窗口/多标签/拖拽/输入法**：没覆盖，别声称验过。

## 边界与已知限制

- 需要本机有 Chrome 或 Edge（`CHROME_PATH` 可指定）；找不到就跳过，不假装验过；
- 默认 CDP 端口 `9222`，被占用时用 `--port` 换一个，别去杀别人的浏览器；
- 浏览器在多次调用之间**复用**（起一次几十毫秒到几秒），`close` 才停；
- 页面里的 `?token=` 是会话凭据：工具会把响应正文里的 token 替换成 `{{token}}`，截图里如果拍到 URL 自己注意。
