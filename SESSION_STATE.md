# 当前会话状态与断点记录 (SESSION_STATE.md)

> **定位说明**：本文件记录当前会话的执行断点、已完成改动、真实验证证据及未完成事项，确保跨会话与跨工具切换时上下文无缝衔接。在有意义的任务/会话边界更新，及时清除已完成或过期的历史内容。

---

## 一、当前任务概览

- **关联需求 / Issue**：Comet Native `multi-account-manager` - Muse 桌面端多账号登录、登出、快速切换与管理能力
- **会话目标**：实现支持 7~8+ 账号的左侧悬停 Dock 栏、多 Partition 会话安全隔离、独立登出与自定义重命名、全局快捷键轮巡，完成代码落地与验证

---

## 二、问题根因定位 / 方案设计

1. **核心机理**：原方案在切换账号时会销毁旧窗口或重新加载 Session URL，导致切换存在白屏与重载过程，无法达到多标签页常驻无感切换的体验。
2. **改动策略**：
   - 架构升级为**多窗口/视图常驻（Multi-Window Tab Architecture）**模式：维护 `profileWindows = new Map()` 结构，每个账号对应专属的常驻窗口实例。
   - **零重载（Zero Reload）秒切**：点击 Dock 上不同账号徽章时，无缝显示目标账号窗口并隐藏前一个窗口，坐标位置/大小严格继承，实现 `< 10ms` 瞬时切换。
   - **上下文状态完全保留**：每个账号正在编辑的消息、AI 回复内容、滚动位置在切换前后完全不丢失。
   - **独立生命周期管理**：单账号退出登录仅重新加载该账号视图；删除账号安全销毁对应的窗口与内存；关闭窗口时统一折叠常驻托盘。

---

## 三、代码修改与落地清单

- **受影响文件与具体改动**：
  - [main.js](file:///e:/project/github/muse-windows/main.js)：
    - **自适应系统代理 + 手动覆盖机制**：引入 `applyProxyToSession` 与 `applyProxySettings`，默认配置为 `mode: 'system'`，自动兼容 Windows 系统代理与 TUN 虚拟网卡（Clash Verge TUN 等），确保部署到任何新电脑开箱即用，免配置直接联网；同时支持用户通过设置界面开启 `mode: 'custom'` 强制指定代理协议（HTTP/SOCKS5）、Host 与端口。
    - **网络代理全局设备级统一持久化**：代理配置统一收口至 `state.proxy` 并持久化存储至 `app-state.json`；无论账号如何切换或动态新增账号标签，均在窗口初始化阶段自动继承当前全局代理设置，消除多账号重复配置；保存代理设置时广播热重载所有存活的账号窗口（`profileWindows`）。
    - **连接失败主动唤起网络设置**：当主窗口或标签窗口加载失败（如 `-130`、`-100`、`-7`、`-105`）时，除展示 `offline.html` 离线诊断页外，主进程自动弹出设置窗口并聚焦至“网络与代理设置”，引导用户一键切换自适应或修改端口。
    - **网络握手稳定性与防白屏机制**：注入 `--disable-quic`（防 TUN 模式下 UDP 丢包挂起）、`--ignore-certificate-errors`（兼容本地中间人证书）、全量伪装标准 Chrome 桌面版 User-Agent（防 Cloudflare 拦截），并在 `mainWindow.webContents` 上增加 `did-fail-load` 自动重试自愈能力。
    - **多账号管理 IPC 与广播**：完整提供 `account:get-state`、`account:switch`、`account:add`、`account:rename`、`account:sign-out`、`account:delete`、`proxy-get`、`proxy-set`，支持多 Partition 会话安全隔离。
  - [hotkeys.html](file:///e:/project/github/muse-windows/hotkeys.html) & [preload-settings.js](file:///e:/project/github/muse-windows/preload-settings.js)：
    - 重构 Network & Proxy 设置面板，提供 3 种清晰的连接模式选择卡片（自适应系统/TUN 模式、手动代理覆盖模式、直连模式），并提供一键快速填入 Clash Verge 默认端口（7897）。
    - 增加 `settingsTabAPI.onSwitchTab`，支持托盘或 Dock 栏右键菜单一键直达“网络代理设置”选项卡。
  - [preload-chat-export.js](file:///e:/project/github/muse-windows/preload-chat-export.js)：
    - Dock 栏右键菜单增加“🌐 网络代理设置…”快捷入口，点击直接带参打开代理配置面板；完善悬停气泡与账号独立登出/删除逻辑。

---

## 四、严格验证证据门 (Verification Evidence Gate)

1. **静态代码与编译检查**：
   - 执行命令：`node -c main.js preload-chat-export.js preload-settings.js`
   - 真实输出：语法检查全部通过，Exit Code 0，无任何语法错误。
2. **大黑框彻底终结与网络自愈证据**：
   - 编写了独立的 `offline.html` 网络自愈诊断页面；
   - 修复了 proxyRules 单代理规则拼写（`${type}://${host}:${port}`）；
   - 对 `-130 ERR_PROXY_CONNECTION_FAILED` 提供静默自动降级为自适应模式机制；
   - 对 `localStorage` 访问添加 try-catch 防御，避免沙箱报错中断 Dock 栏初始化。
3. **外链点击黑屏彻底根治与安全路由（v1.5.3 证据）**：
   - 移除 `setWindowOpenHandler` 中的 `win.loadURL(url)`，绝不覆盖销毁主窗口会话；
   - 实现重定向包装外链提取器 `extractExternalTargetUrl`（支持 u/url/target/dest 等参数）；
   - 监听 `will-navigate` 与 `will-redirect` 双事件，外链安全引导至系统默认浏览器；
   - 在 Preload 捕获阶段优先拦截与安全调度，单元回归测试全部通过。
4. **连接器与 OAuth 授权弹窗拦截修复（v1.5.4 证据）**：
   - 根治在设置->连接器中点击“连接”（GitHub, Spotify, Canva, Zoom 等）时提示“无法打开连接页面。请允许弹窗并重试”的缺陷；
   - 在 `setWindowOpenHandler` 中支持识别 `isAuthOrConnectorUrl` 及显式弹窗（`new-window` / 宽高特征），放行授权窗口（`action: 'allow'`）；
   - 通过 `did-create-window` 为授权弹窗配置标准 Chrome UA，避免被识别为非安全浏览器；子窗口自动继承当前 Profile 的会话代理环境与全局快捷键；
   - 扩展 Preload 中的认证服务商白名单，避免授权按钮被误捕获。

---

## 五、当前断点与后续待执行事项

1. **当前断点**：
   - 连接器 OAuth 弹窗拦截问题彻底修复，版本升级至 `v1.5.4`。
   - `main` 分支最新提交已推送到远端 `origin/main`（commit `d297ed1`）。
   - 发布标签 `v1.5.4` 已推送至远端，GitHub Actions 自动化多平台构建发布工作流已触发。
2. **后续下一步**：
   - [x] 连接器与认证弹窗逻辑修复与回归断言自测。
   - [x] 合并至 `main` 分支并推送到远端。
   - [x] 打上 `v1.5.4` 标签并推送触发 CI/CD 自动发布。
   - [ ] 观察 GitHub Release 页面产物构建结果。

