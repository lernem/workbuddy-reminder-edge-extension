<img width="907" height="1275" alt="image" src="https://github.com/user-attachments/assets/b195794f-6372-4a8c-a3fd-4c34b0b66b1a" />


# WorkBuddy 积分到期侧边栏（Edge 扩展）

打开 WorkBuddy「套餐与用量」页面（`https://www.workbuddy.cn/profile/plans-usage`）时，
在页面**右侧**自动显示一个固定侧边栏，列出当前所有积分 / 套餐 / 资源包的**到期时间**，
按临近到期排序，并对即将到期的项做高亮提醒（7 天内红色、30 天内橙色）。

## 原理

- 页面是 SPA，积分与到期数据由页面自己的接口返回（字段含 `expireAt` / `ExpiredTime` / `CycleEndTime` 等）。
- `inject.js`（MAIN world）在页面最早期劫持 `window.fetch` 与 `XMLHttpRequest`，
  捕获「含到期字段」的接口响应，转发给 `content.js`。
- `content.js`（ISOLATED world）解析出所有带到期时间的条目，注入右侧侧边栏。
- 兜底：若劫持未命中，会尝试同源重新请求候选接口，并对页面可见文本做解析；
  仍失败则提供「复制原始接口数据」按钮，便于反馈适配。

## 安装（Edge 加载解压缩扩展）

1. 打开 Edge，地址栏访问 `edge://extensions/`
2. 打开左下角「开发人员模式」开关
3. 点击「加载解压缩的扩展」，选择本目录（`edge-extension/`）
4. 确认扩展已启用（图标出现）
5. 登录 WorkBuddy 后，打开 `https://www.workbuddy.cn/profile/plans-usage`
6. 右侧即出现「积分到期提醒」侧边栏

> 若扩展未生效：确认页面 URL 完全匹配 `https://www.workbuddy.cn/profile/plans-usage*`，
> 且已在 Edge 中登录 WorkBuddy（侧边栏依赖页面会话的登录态）。

## 自适应与调试

- 提取逻辑为「通用字段遍历」，不依赖固定 DOM 结构，可适配接口字段微调。
- 若侧边栏显示「未识别」或条目不全：点击侧边栏底部「复制原始接口数据（供调试）」，
  将剪贴板内容粘贴反馈，即可针对性完善解析规则。

## 文件

- `manifest.json` —— MV3 清单，声明仅在 plans-usage 页面注入两个 content script
- `inject.js` —— MAIN world，劫持 fetch/XHR，转发接口数据
- `content.js` —— ISOLATED world，解析数据并渲染侧边栏
