# 当前会话状态与断点记录 (SESSION_STATE.md)

> **定位说明**：本文件记录当前会话的执行断点、已完成改动、真实验证证据及未完成事项，确保跨会话与跨工具切换时上下文无缝衔接。在有意义的任务/会话边界更新，及时清除已完成或过期的历史内容。

---

## 一、当前任务概览

- **关联需求 / Issue**：Comet Native `2026-10-26-lock-and-dock-optimizations` - 锁屏非置顶优化、多账号列表 12+ 扩容防挤压与移开自动收起/固定
- **会话目标**：
  1. 锁屏窗口移除强制置顶（`alwaysOnTop: false`），弹出后不阻碍用户在锁定态下操作其他桌面外部软件；
  2. 左侧多账号 Dock 栏支持至少 12 个账号（无上限限制），增加纵向响应式滚动与 `flex-shrink: 0` 防挤压变形，提供半透明高质感纤细滚动条；
  3. 切换账号后鼠标移开（`mouseleave`）自动平滑收起至侧边，顶部提供一键固定按钮（📌 Pin），主动点开固定后保持展开常驻，状态跨会话与重启持久化。

---

## 二、问题根因定位 / 方案设计

1. **锁屏置顶问题**：原 `lockWindow` 实例在 `main.js` 构造中配置了 `alwaysOnTop: true`，导致锁屏后窗口永久浮于所有外部桌面应用之上，无法切换查看其它软件；改为 `alwaysOnTop: false`，锁屏窗口作为普通层级窗口弹出聚焦，既隐藏 Muse 内部会话，又不影响外部操作。
2. **多账号挤压与截断**：原 `.acct-dock-list` 固定 `max-height: 380px` 且 `scrollbar: none`，且头像无 `flex-shrink: 0` 保护，9 个账号（388px）以上时最下方账号被截断或挤压；重构为自适应高度 `max-height: min(520px, calc(100vh - 210px))`，头像尺寸规范为 34px，`gap: 6px`，`flex-shrink: 0`，配合 4px 纤细半透明滚动条与当前账号自动滚入视口（`scrollIntoView`），完美支持 12+ 无限账号。
3. **自动收起与点开固定**：增加 `dockState.pinned` 状态（由 `state.ui.dockPinned` 与 `localStorage` 双重驱动）；未固定时移入展开、移开后 250ms 自动收缩；点击顶部“📌”固定后解除自动收缩，常驻展开。

---

## 三、代码修改与落地清单

- **受影响文件与具体改动**：
  - [main.js](file:///home/picohood/projects/opensource/muse-ai-Desktop/main.js)：
    - `lockWindow` 构造移除 `alwaysOnTop: true`，设为 `alwaysOnTop: false`；
    - `defaultState.ui` 与 `sanitizeAndMergeState` 支持 `dockPinned: false`；
    - 扩充 `AVATAR_COLORS` 调色盘至 16 色，确保 12 个以上账号拥有各不相同的质感头像配色；
    - `account:get-state` 与 `broadcastAccountChange` 下发 `dockPinned` 属性；
    - 新增 `dock:set-pinned` IPC 接口支持修改并广播持久化。
  - [preload-chat-export.js](file:///home/picohood/projects/opensource/muse-ai-Desktop/preload-chat-export.js)：
    - 中英文国际化增加 `pinDock` 与 `unpinDock` 字典；
    - 样式升级：`#acct-dock` 增加 `max-height: calc(100vh - 28px)` 与 `box-sizing: border-box`；`.acct-dock-list` 响应式高度及明暗双色模式纤细滚动条；`.acct-dock-item` 设置 `flex-shrink: 0`；
    - 顶部操作区新增 Header，内嵌折叠箭头与 📌 固定按钮；
    - 绑定 `mouseenter` / `mouseleave` 与 `scheduleAutoCollapse` 防抖机制；
    - 账号切换后自动平滑滚入可视区域。
  - 规格与验证产物：
    - [spec.md (screen-lock)](file:///home/picohood/projects/opensource/muse-ai-Desktop/docs/comet/specs/screen-lock/spec.md)
    - [spec.md (multi-account)](file:///home/picohood/projects/opensource/muse-ai-Desktop/docs/comet/specs/multi-account/spec.md)
    - [2026-10-26-lock-and-dock-optimizations](file:///home/picohood/projects/opensource/muse-ai-Desktop/docs/comet/archive/2026-10-26-lock-and-dock-optimizations/)
    - [test-dock-and-lock.js](file:///home/picohood/projects/opensource/muse-ai-Desktop/scratch/test-dock-and-lock.js)

---

## 四、严格验证证据门 (Verification Evidence Gate)

1. **静态语法编译检查**：
   - 执行命令：`node -c main.js preload-settings.js preload-chat-export.js`
   - 验证结果：全部通过，退出码 0，无语法错误。
2. **锁屏与多账号自动化单元测试**：
   - 执行脚本：`node scratch/test-dock-and-lock.js`
   - 验证结果：7 项断言全部 PASS（非置顶校验、16 色调色盘、dockPinned 状态持久化与广播、中英双语 i18n、CSS 响应式与防挤压规则、auto-collapse 与 scrollIntoView 逻辑）。

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
4. **连接器与 OAuth 授权弹窗拦截根治（v1.5.5 证据）**：
   - 攻克现代 Web 应用在用户点击事件同步上下文先打开 `window.open('about:blank')` 空白占位弹窗再异步导航的技术卡点；
   - 在 `main.js:setWindowOpenHandler` 中支持 `about:blank`、空字符串以及具备弹窗意图（`new-window`、带 features）的请求，全部放行 `action: 'allow'`；
   - 在 `preload-chat-export.js` 中增加模态防御，凡在 `[role="dialog"]`、`[aria-modal="true"]`、设置面板及模态弹窗内部发生的点击彻底放行，严禁任何拦截破坏网页原生行为；
   - 彻底根除“无法打开连接页面。请允许弹窗并重试”的错误。

6. **Google OAuth 安全拦截攻克（v1.5.7 证据）**：
   - 实施方案 A（Firefox UA 拟态与请求头脱敏）：针对发往 `accounts.google.com`、`myaccount.google.com` 及 `oauth2.googleapis.com` 的认证请求，统一将 User-Agent 拟态为标准桌面端 Firefox (`rv:132.0`)；
   - 在主进程网络层全面剥离 Chromium 专属的 `sec-ch-ua` 系列 Client Hints，使请求特征与独立原生 Firefox 100% 吻合，直接绕过 Google 针对 Blink 嵌入式 WebView 的自动化环境嗅探；
   - 增加 `--disable-blink-features=AutomationControlled` 隐藏自动化标志；
   - 子窗口创建后通过 `did-navigate` 双向动态感知 Google 认证路由并无缝注入拟态 UA，彻底攻克“此浏览器或应用可能不安全”的拦截。

---

7. **下载提示不友好与空白 Electron 窗口根治（v1.5.9 证据）**：
   - **根因消除**：在 Windows 开发模式下，设置 `app.setAppUserModelId(process.execPath)`，彻底消除因 Windows 找不到快捷方式退化执行无参 `node_modules\electron.exe` 弹出默认空白界面的缺陷；
   - **方案 A 落地（双层提示机制）**：主窗口前台可见时显示应用内高质感 Toast，后台时使用 Windows 系统通知兜底，文案中英双语对齐；已合并发布至 `v1.5.9`。

8. **账号自动退出登录与持久化加固（v1.5.10 证据）**：
   - **单例锁最前置**：将 `app.requestSingleInstanceLock()` 移至 `main.js` 最顶部执行，阻断多实例并发竞争锁坏 SQLite 数据库；
   - **UserData 路径统一**：在 Windows 上强制锁定为 `%APPDATA%\Muse`，彻底消除便携版（Portable）与安装版数据分裂漂移；
   - **状态读写原子化与双备份**：采用 `tmp + renameSync` 原子写入与防抖，并在主文件损坏时自动从 `.bak` 备份恢复，严禁抹除账号；
   - **Session Cookie 刷盘**：在 `before-quit` 与账号切换时对全部存活 session 显式调用 `flushStore()`；
   - 已合并至 `main` 主分支并发布标签 `v1.5.10`。

9. **Meta 登录 CSRF Token 失效与外链重定向根治（v1.5.11 证据）**：
   - **根因消除**：彻底废除 `setupSessionPersistence` 中监听 `ses.cookies.on('changed')` 强行篡改会话 Cookie 的逻辑，杜绝并发覆写 Meta 握手 CSRF Token 导致的 `CSRF token expired or missing` 及账号被 Meta 服务端降级踢出；改为 5 分钟定时安全调用原生无害的 `flushAllSessions()` 落盘；
   - **认证放行与域名补全**：在 `isAuthOrConnectorUrl` 中扩充 Meta 家族域名（`meta.com`, `auth.meta.com`, `account.meta.com`, `facebook.com`, `fb.com`, `instagram.com`），并放行 `error=`, `code=`, `state=`, `token=` 等认证回调参数；在 `isInternalSiteUrl` 中将 `meta.com` 纳入内部受信任域；
   - **测试证据**：Node.js 语法校验 Exit Code 0，全矩阵 URL 路由与认证判定单元回归测试全部 PASS。

---

10. **Windows 任务栏图标通用空白占位符根治（v1.5.12 证据）**：
    - **快捷方式死链自愈**：针对便携版启动解压至动态 Temp 目录导致开始菜单 `Muse.lnk` 指向已失效旧路径的问题，启动时自动检测并修复目标与图标为当前实际可执行文件或清理失效死链，杜绝 Windows AUMID 寻径失败；
    - **全窗口图标显式注入**：为所有 `BrowserWindow` 实例配置 `icon: APP_ICON_PATH`，并显式调用 `win.setIcon()` 下发 Win32 `WM_SETICON`，确保各种启动模式下任务栏与窗口标题栏均能正确渲染应用图标；
    - **测试证据**：语法校验 `node -c main.js` Exit Code 0，现场修复当前机器开始菜单快捷方式。

---

11. **Ubuntu 多账号登录后主窗口唤不回与 Dock 图标异常根治（v1.5.13 证据）**：
   - **现场症状**：Ubuntu 24.04（VMware）昨日单账号正常，今日登录多账号后：Dock 出现紫猫启动器与灰齿轮「muse」两个条目并存；点击 Dock 图标、右键「所有窗口」预览、托盘「打开 Muse 主窗口」与「切换至 Muse」均无任何窗口出现；托盘菜单本身正常（当前账号/站点状态可读）。
   - **根因定位**：①多窗口常驻架构下全部账号共用一份全局 `state.window` 几何且加载/落盘/使用三处均零校验，多窗口 resize/move 竞写、最小化/隐藏瞬间或虚拟机分辨率变化写入的屏幕外坐标/异常尺寸被持久化至 `app-state.json` 并反复重放；②托盘单击、菜单打开主窗口、切换站点、二次启动四条唤回路径全部汇聚到只有 restore/show/focus 的 `showMainWindow()`，无几何修复、无可见性复查、无重建兜底，活动窗口一旦楔死四路同时失效；③Linux 图标从未做桌面匹配：窗口 app_id/WM_CLASS 为「muse」，与 electron-builder 生成的 .desktop/可执行名不一致，GNOME 无法认领窗口而生成灰齿轮兜底条目，且 v1.5.12 的 `setIcon()` 带 `win32` 限定未惠及 Linux。
   - **修复落地**：新增 `sanitizeWindowBounds`（加载时钳制尺寸/坐标）与 `ensureBoundsVisible`（显示前按当前全部显示器校验交叠、屏幕外自动居中主屏）；`persistBounds` 在最小化/隐藏时不再落盘，并新增按账号分开的 `windowByProfile` 几何存储（全局 `window` 保留兼容）；新建/复用/切换窗口的全部 setBounds 入口统一过校验；新增 `showWindowSafely`（修几何→restore→show→moveTop→focus→返回真实可见性），`showMainWindow` 在 show 后仍不可见时销毁楔死窗口并以安全几何重建；`createMainWindow` 的 ready-to-show 改为捕获本次创建的窗口对象（原闭包引用全局 mainWindow，切账号竞态下会 show 错窗）；profile 窗口新增 `closed` 清理（Map 与 mainWindow 同步置空）；主窗口/设置窗口 `setIcon` 平台条件由 `win32` 放宽为非 darwin，Linux X11 同步生效；`package.json` Linux 配置对齐桌面匹配：`executableName: "muse"` 与 `desktop.StartupWMClass: "muse"`，使 .desktop 文件名、图标名与窗口 app_id 三者一致。
   - **测试证据**：`node --check` 对 main.js / preload-chat-export.js / preload-settings.js 全部通过；以 Electron 桩加载 main.js 并预置被写坏的 app-state.json（width 40 / height 99999 / x -99999 等）做冒烟测试 9 项全 PASS：坏几何加载即被钳制并写回、屏幕外坐标自动居中主屏、屏幕内坐标原样保留、无坐标居中、垃圾值清空。Ubuntu 实机（Wayland/Xorg 双会话、Dock 图标归并、多账号秒切唤回）待真机复核后发布 v1.5.13。

12. **评审 P0 第一批修复（v1.5.14 证据）**：
   - **背景**：v1.5.13 合并后由 5 位专家并行评审 main，共 5 条 P0 / 9 条 P1 / 16 条 P2；本批按报告顺序修安全止血三条 + 快捷窗串号 + v1.5.13 自愈缺陷，其余 P1/P2 留待后续批次。
   - **P0-1 证书**：删除 `ignore-certificate-errors` 与 `allow-insecure-localhost` 开关，删除 `certificate-error` 无条件 `callback(true)` 放行，恢复 Chromium 默认证书校验。
   - **P0-2 更新器**：自更新全链路加 `isPortableWindowsBuild()`（win32 + PORTABLE_EXECUTABLE_FILE）门控——非便携形态不启动后台检查、手动检查改为对话框引导至 Releases 页、install 入口二次设防；下载后强制校验 GitHub 资产 `digest` 的 SHA-256（缺失/不符即中止）；落盘文件名改 basename 防路径越界；PowerShell spawn 补 `error` 监听。
   - **P0-3 权限倒置**：聊天 preload 删除 `automationAPI`、`museExport` 两个主世界桥，`offlineAPI` 仅在 file:// 页面暴露；聊天抓取改为「主进程经 IPC 点名 → preload 隔离世界执行 → 回传结果」（scrapeChatViaPreload，30s 超时）；主进程新增 `isTrustedIpcSender`（自有窗口 + 主 frame + https muse/meta 或 file://）并接入全部 29 处 IPC 注册（静态审计 0 未守卫）；`automation-set/toggle-site/set-site-action` 的站点键加 `isValidHostname` 校验，`proxy-set` 对 custom 模式加 type/port/host 字段校验；`hotkeys.html` 站点规则列表改 DOM API + textContent 构建，断掉存储型 XSS 链。
   - **P0-4 快捷窗串号**：quickWindow 创建时显式绑定 partition 并记录所属 profile；`switchAccount` 与 `toggleQuickWindow` 在账号不一致时先销毁再按当前账号重建。
   - **自愈修正（回应评审对 v1.5.13 的意见）**：showMainWindow 不再同步判死，改为 250ms+250ms 两段异步复查（先居中重试、仍不可见才重建）；ensureBoundsVisible 居中改以主屏为基准，可见判据升级为「标题栏 40px 落在可用区且交叠面积 ≥30%」；persistBounds 落盘改为存真实尺寸（钳制只留给加载/显示校验），并跳过最大化状态。
   - **顺带**：package.json 升 1.5.14，package-lock 两处版本字段由漂移的 1.4.1 同步为 1.5.14。
   - **测试证据**：`node --check` 三个 JS 全过；IPC 守卫静态审计 29/29 覆盖；Electron 桩冒烟 11 项全 PASS（标题栏飘出居中、只剩边缘居中、正常保留、屏幕外居中、hostname 合法/XSS/空格/前导横线/无后缀/空 六类判定）；hotkeys.html 内联脚本编译检查通过。Ubuntu/Windows 实机回归（证书校验开启后代理场景、便携版更新 digest 校验、快捷窗切号、设置页站点列表渲染）待真机复核。

13. **评审第二批修复（v1.5.15 证据）**：
   - **P1-11 单例锁顺序**：`app.setName` 与 win32 的 `setPath('userData')` 整体提到 `requestSingleInstanceLock()` 之前（锁绑定获取时刻的 userData 目录，旧顺序下便携版与安装版可能各持一把锁并发写状态/会话）；锁仍在一切业务初始化之前。
   - **P1-6 子弹窗追踪**：新增 `childWindowsByProfile` 登记表，`did-create-window` 时按父窗口 profile 登记、closed 注销；切账号时前一账号子弹窗跟随隐藏、目标账号子弹窗恢复显示（WeakSet 标记区分「被切换藏起」与用户自关）；托盘登出、IPC 登出、删号三条路径均先 `closeChildWindows` 再清存储，堵住清除后回写 Cookie 的会话复活路径。
   - **P1-12 延迟导航**：新增 `pendingWindowNav` 脏标记（site/reload 两档）：`toggleSite` 与 `proxy-set` 对可见窗口立即生效、对隐藏窗口只打标记，窗口下次被 show（showWindowSafely / toggleQuickWindow）时才真正 loadURL/reload，后台账号未发送内容不再被静默冲掉。
   - **P1-8 超时**：`flushAllSessions` 加 3 秒总超时 race（before-quit 不再可能被单个分区卡死）；启动改为先建窗/托盘/快捷键，`applyProxySettings` 异步补应用并加 5 秒超时降级，新窗口创建时各自仍会按当前配置应用代理。
   - **P1-10 崩溃重建与常驻上限**：每个 profile 窗口注册 `render-process-gone`（clean-exit 除外）：销毁僵尸窗口，活动账号立即重建并显示；10 分钟内崩溃超过 3 次停止自动重建并通知。常驻 profile 窗口上限 5 个，超出按 LRU 销毁最久未显示的隐藏窗口（partition 在磁盘，重建恢复登录态）。
   - **P0-5 mac 图标（CI 侧）**：`release.yml` 的 mac 任务在构建前新增 `sips -z 1024 1024 assets/icon.png` 步骤，绕过 256 源图生成不了 .icns 的问题；建议后续把仓库 assets/icon.png 直接换成 1024 源图（已另行生成交付），该步骤届时为无害空转。注：mac 无产物是多版实查结论，图标仅为疑似主因，仍需以修后一次发布的 Actions 日志与资产清单为准。
   - **测试证据**：`node --check` 三个 JS 全过；release.yml YAML 解析通过；Electron 桩冒烟回归 11 项全 PASS 且新导出（childWindowsByProfile/pendingWindowNav 均为 Map、常驻上限 5）核对无误；单例锁顺序经行号核对（setPath 14 行 < 拿锁 17 行）。实机回归（子弹窗跟随/复活、延迟导航、退出卡死、崩溃重建、mac 发布资产）待真机与下一次发布验证。

14. **评审第三批修复（v1.5.16 证据）**：
   - **P1-13 登出范围与缓存补清**：新增 `clearSiteSession/clearWholeSession` 工具。托盘与 IPC 两条登出路径改为按当前站点范围清除（origin 范围 clearStorageData + 按域名摘除该站点 Cookie），不再误伤同账号另一站点登录；全部分区级清除路径补 `clearCache + clearAuthCache`。
   - **P1-14 权限收紧**：`setupPermissions` 归因改用请求方 frame 的 requestingUrl；clipboard-read 对站点默认拒绝；media/audioCapture/videoCapture 不再默认放行——自动化规则明确放行时直接通过，否则每次弹窗询问用户（拒绝为默认）。
   - **删号原子化（P2）**：顺序改为先关弹窗/窗口→立即从 profiles 摘除并落盘（含 windowByProfile 清理，账号即刻不可切回）→再清会话与 partition 磁盘目录（Partitions/muse-<id> 整目录删除，失败忽略）。
   - **账号 ID（P2）**：`addProfile` 改 `acc_<crypto.randomUUID()>` + 唯一性兜底，杜绝同毫秒双入口撞号共用 partition。
   - **profiles 合法性（P2）**：`sanitizeAndMergeState` 过滤空/重复/非字符串 id（全非法回退默认账号），并剪除 windowByProfile 中已删账号条目。
   - **.bak 代际（P2）**：saveState 改为覆盖前轮转——当前可解析主文件→.bak、旧 .bak→.bak2，坏内容不进备份链；loadState 恢复链扩展为主→.bak→.bak2。
   - **更新下载（P2）**：检查更新的 15s 超时覆盖到正文 json 解析完成；便携版下载改流式落盘 + 增量 SHA-256（不再整包进内存），超时改为 60 秒空闲超时，digest 校验前置到下载前，半成品文件失败即删。
   - **Auto-Allow 引擎加固（P2）**：MutationObserver 改 300ms 防抖 + 重入保护 + 每轮扫描上限 200 个按钮；按钮/容器文本改 textContent（不触发同步布局）截断读取；无确认容器时不再兜底读整页正文；CLICK_KEYWORDS 删除裸 continue；autoAllowAll 仅对 muse.ai/meta.ai 生效且引擎只在顶层页面运行（子框架不代点）。
   - **发布流水线（P1-7 配置侧）**：package.json 的 publish.releaseType 改 draft、mac 目标补 universal（Intel/Apple Silicon 通吃）。配套 release.yml（tag↔version 校验步骤 + finalize 转正 job）因连接器无 workflow 权限仍需手动替换，已单独交付（muse-release-yml-v1.5.16.yml）；注意 PR 与该文件须配套：只合 PR 不换 yml 时下次发版将停留在草稿（安全失败，一键可转正）。
   - **测试证据**：node --check 三个 JS 全过；Electron 桩冒烟新增 sanitize 用例（重复/空/数字/缺失 id 过滤、windowByProfile 剪枝、全非法回退默认）+ 第一批几何/主机名用例回归，全 PASS；release.yml v2 YAML 解析通过。实机回归待真机。

15. **评审第四批修复（v1.5.17 证据，评审清单收尾）**：
   - **聊天导出健壮性（P2）**：`exportChat` 改为永远导活动账号主窗口（旧实现取焦点窗口，焦点在快速窗/设置窗时导错会话或静默失败），且页面 URL 非 muse/meta 聊天页时明确提示；preload `scrapeChat` 改增量收集——上滚到顶（高度稳定 2 次判定 reachedTop）后逐步下滚边滚边按文本指纹去重收集，解决虚拟列表卸载屏外消息导致的静默丢数据；`fixRoles` 给交替推算的发言人打 `guessed` 标记，导出结果带 `stats{reachedTop, guessedRoles}`，Markdown/JSON/HTML 三种格式均写入完整性告警（未到顶、推算条数），不再产出「看似完整」的静默坏数据。
   - **外链拦截收窄（P2）**：preload 点击拦截放行带修饰键/中键点击与显式 target 的链接（交回页面与主进程窗口逻辑）；`extractExternalTargetUrl`（主进程与 preload 两份）改为只解包已知跳转站（Google/Bing/DDG/Facebook/Reddit/YouTube）的重定向参数，任意站点 ?u= 不再被无声直达。
   - **file:// 归类（P2）**：`isInternalSiteUrl` 与 preload `isInternalUrl` 均移除 file: 内部归类，本地 HTML 不再能在特权 preload 窗口内被当内部页放行（应用自身页面均由主进程直接加载，不受影响）。
   - **Google 重置一致性（P2）**：托盘与 IPC 两条重置路径删除对 defaultSession 的无条件清除（该会话不承载账号窗口），统一只清活动账号分区，与子弹窗横幅路径（按所属分区）对齐。
   - **注入指纹面收敛（P2）**：preload 注入页面的 DOM 标识去品牌化——data-muse-theme→data-ui-theme、Dock/Popover/Toast/右键菜单/弹窗的 muse-* id 与 class 统一改 acct-*/ui-* 前缀（文件内 JS/CSS 同步改名并审计零残留）；主进程侧 Google 横幅 id 与麦克风 shim 的主世界全局名 __museMic 同步去品牌化。注：Dock 折叠偏好的 localStorage 键随之改名，用户该偏好会重置一次。
   - **依赖可用性（P2）**：package-lock 中 271 处 resolved 镜像源 registry.npmmirror.com 统一换为官方 registry.npmjs.org（integrity 不变）；CI 的 `npm ci || npm install` 回退在 release.yml v3 交付件中去除（仍需手动替换）。
   - **未做（需用户投入/决策）**：代码签名与 mac 公证（需 Apple Developer 与 Windows 代码签名证书）；Linux executableName 改名后的旧启动器过渡（建议在 Release 说明中提示旧名 muse-desktop 失效，或保留一版旧名软链，需用户拍板）；release.yml v2 此前未被替换，当前仓库 workflow 仍无 tag 校验与 finalize——**在替换为 v3 之前打 tag 发版，Release 会因 releaseType:draft 停留在草稿**（资产齐全，网页一键可转正）。
   - **测试证据**：node --check 三个 JS 全过；指纹改名后全仓审计页面可见 muse- 标识零残留（muse.ai 域名、内部 IPC 通道名与隔离世界属性除外）；lock JSON 合法性校验通过；Electron 桩冒烟（sanitize/几何/主机名）回归全 PASS；release.yml v3 YAML 解析通过。实机回归待真机。

16. **v1.5.17 发版第二轮失败修复（linux.desktop 写法）**：
   - **现象**：PR #6 合并后重新触发 Release #15，`npm ci` 三端全部通过（锁文件修复生效），但三端均在 electron-builder 打包第一步失败（39 秒全灭），报错 `configuration.linux.desktop should be one of these: null`——配置校验未过，根本没开始打包。release.yml 本身无问题（tag 校验步带 `if: startsWith(github.ref, 'refs/tags/v')`，手动触发自动跳过）。
   - **根因**：第 11 条（v1.5.13）为对齐 Dock 写入的 `linux.desktop: { "StartupWMClass": "muse" }` 不符合 electron-builder 26 的 `LinuxDesktopFile` schema（`additionalProperties: false`，顶层只允许 `entry` / `desktopActions` 两个键，自定义 [Desktop Entry] 键必须嵌套在 `entry` 下）。该字段自写入后从未被 CI 真正执行（v1.5.13 起无一版走到打包步），本次首次暴露。
   - **修复**：package.json 改为 `"desktop": { "entry": { "StartupWMClass": "muse" } }`，语义不变（生成的 .desktop 文件仍含 StartupWMClass=muse，Dock 归并修复不受影响）；版本号保持 1.5.17（该版本从未成功发布过）。
   - **测试证据**：用仓库 node_modules 内 electron-builder 26.15.3 自带 validateConfiguration 实测三种形态——旧写法 INVALID（与 CI 报错一致）、entry 写法 VALID、删除 desktop 亦 VALID；改后对真实 package.json 复验 VALID。git diff 仅此一处（3 行）。

17. **v1.5.17 实机回归修复（v1.5.18）：Ubuntu 图标仍为齿轮**：
   - **现象**：用户安装 v1.5.17 后 Ubuntu 活动概览/Dock 中运行窗口仍是灰齿轮、与紫猫启动器双条目（v1.5.12 原始症状未愈）。
   - **取证**：下载已发布 .deb 解包核对——`/usr/share/applications/muse.desktop`（Icon=muse、StartupWMClass=muse、Exec=/opt/Muse/muse）与 `hicolor/1024x1024/apps/muse.png` 均正确，安装侧无问题。进而在本机 Xvfb 下运行已发布二进制并以自写 X11 探针读窗口属性：主窗口 **WM_CLASS instance='muse'、class='Muse'**——class 是可执行名首字母大写，GNOME 大小写敏感匹配 `StartupWMClass=muse` 失败，此为根因（v1.5.13 的 StartupWMClass 按可执行名写了小写，对错了对象）。同法实测 `app.setDesktopName` 与 package.json `desktopName` 均不改变 X11 WM_CLASS class（该 API 管 Wayland app_id 与 portal 身份）。
   - **修复**：①package.json `desktop.entry.StartupWMClass` 改为 `'Muse'`（与实测 WM_CLASS class 逐字对齐，X11 归并）；②main.js 在 setName 后、ready 前加 Linux 分支 `app.setDesktopName('muse')`，并在 package.json 顶层加 `desktopName: "muse"`，把 Wayland app_id 显式钉死为 muse（与 muse.desktop 一致，不再依赖 app 名推导）；③版本升 1.5.18。
   - **测试证据**：electron-builder 配置校验 VALID；`node --check` 三文件全过；以恢复后的真实配置重新 dir 构建，产物可执行名为 muse（配置生效），Xvfb 复测 WM_CLASS 与上表一致（instance=muse/class=Muse），与新 StartupWMClass 精确匹配。Wayland app_id 无法在本机 X 环境直接观测，按 Electron 官方 API 契约设置，待用户 Ubuntu（Wayland）实机终验。
   - **过程教训**：取证时 `asar extract-file` 在仓库目录执行会把解出的精简 package.json 覆盖工作区原件（后续两次本地构建因此缺 build 配置、产物名变 muse-desktop），已用 git 恢复并逐行核对 diff；今后解包一律在 /tmp 进行。
   - **追加修复（同日，用户澄清登录地址问题）**：用户明确 Muse AI 登录地址只有 https://muse.ai、不是 Meta AI。核查：代码默认站点恒为 muse、应用内地址均为 muse.ai，无写错；但站点选择随 app-state.json 跨版本保留，旧版切到过 meta 的用户升级后每次启动仍直达 meta.ai，与用户现象吻合。main.js 在 `loadState()` 后加一次性迁移：`siteResetV1518` 未置位时强制 `state.site='muse'` 并置位，落盘复用既有守卫首写（状态损坏时不覆盖、下一启动重试）；置位后用户主动切换照常保存。端到端实测（dir 构建 + 预置状态文件真机运行）：老状态（site=meta、无标记）首启后状态文件变为 site=muse 且标记为 true；标记已置位且 site=meta 时保持 meta 不干预，两用例均 PASS。

18. **v1.5.18 实机回归发现（v1.5.19 修复）：Ubuntu 应用中心与任务栏图标灰齿轮问题彻底根治**：
   - **现场症状**：Ubuntu 24.04（Wayland）安装已发布 `muse-desktop_1.5.18_amd64.deb` 后，应用中心（App Grid / 活动概览）和任务栏（Ubuntu Dock）中 Muse 应用图标均显示为系统默认灰色齿轮（`application-x-executable`），无法正常显示 Muse 自定义图标。
   - **根因定位**：
     1. `hicolor` 图标规范限制：`/usr/share/icons/hicolor/index.theme` 中 `Directories=` 最高仅定义到 `512x512/apps`，规范与系统均未声明 `1024x1024`。
     2. electron-builder 打包行为：`package.json` 中配置为 `"linux": { "icon": "assets/icon.png" }`，指向 1024x1024 单图时，electron-builder 不会自动为 Linux deb 降采样生成多分辨率目录，而是直接原样打包到 `/usr/share/icons/hicolor/1024x1024/apps/muse.png`。
     3. GTK/GNOME 图标解析全部返回 None：GNOME Shell 解析 `Icon=muse` 时经 `GtkIconTheme` 查询各常用尺寸（48、64、128、256、512），因 1024x1024 未在 index.theme 注册而被底层彻底忽略，所有尺寸查询全部返回 None，系统自动 fallback 为默认齿轮图标。
   - **修复落地**：
     1. 从 1024x1024 源图降采样生成完整标准多尺寸目录 `assets/icons/`（包含 16x16, 24x24, 32x32, 48x48, 64x64, 96x96, 128x128, 256x256, 512x512, 1024x1024 共 10 档分辨率）。
     2. `package.json` 中 `linux.icon` 修改为 `"assets/icons"`，由 electron-builder 自动在 deb/AppImage 中将各尺寸分发至对应的 `/usr/share/icons/hicolor/<size>/apps/muse.png` 标准目录。
     3. 保留根目录 `assets/icon.png` 与 `icon.ico`，确保 Windows 打包、macOS 构建及 `main.js`（`APP_ICON_PATH`）完全向下兼容。
     4. 现场将标准尺寸图标同步部署至本机 `~/.local/share/icons/hicolor/`，使本机当前桌面环境即刻恢复应用自定义图标。
   - **验证证据**：
     - 本机 Python `Gtk.IconTheme` 实测：`lookup_by_gicon('muse')` 在 16px、24px、32px、48px、64px、96px、128px、256px、512px 全尺寸 100% 精确命中；
     - `node -c main.js preload-settings.js preload-chat-export.js` 语法检查 Exit Code 0；
     - `package.json` JSON 格式校验通过。

19. **v1.5.20 主密码安全锁屏（Screen Lock）功能研发完成（Comet Native 变更：`screen-lock`）**：
   - **业务目标**：为桌面端增加机密会话安全锁屏，支持定时空闲锁屏、手动锁屏、全局快捷键锁屏、设置页配置（启用/修改密码/停用/时长选择），以及加盐慢哈希加密与防暴力破解。
   - **技术方案**：
     1. **密码学安全**：采用 Node 原生 `crypto.scryptSync(pwd, salt, 64, { N: 16384, r: 8, p: 1 })` 结合 16 字节随机 salt 派生 64 字节密钥，文件存储绝对不含明文或弱散列；密码比对使用 `crypto.timingSafeEqual` 恒定时间比对防时序侧信道攻击。
     2. **防暴力破解（Rate Limiting）**：连续输错 5 次触发 30 秒冷却倒计时锁定，主进程与 `lock.html` 倒计时联动，冷却期内拒绝对比任何密码。
     3. **无操作空闲自动锁屏**：结合 `powerMonitor.getSystemIdleTime()` 与应用内 `recordUserActivity()`（窗口聚焦与 IPC 交互）追踪空闲时长，支持 1/5/15/30/60 分钟阶梯配置。
     4. **会话遮蔽与快捷键越权拦截**：锁屏时隐藏全部 `mainWindow`、`profileWindows`、`quickWindow`、`hotkeyWindow`；弹出全屏置顶 `lockWindow`（`preload-lock.js` + `lock.html`）；`switchAccount`、`nextAccount`、快捷键、快速对话、聊天导出及设置窗口全部拦截。
     5. **设置中心 UI 融合**：在 `hotkeys.html` 中新增“安全与锁屏”Tab，支持主锁屏状态卡片、主密码设置/修改/停用模态框（`pwd-modal-overlay`）、自动锁屏开关与时长选择、锁屏快捷键卡片展示，完全适配深浅色主题与中英文 i18n。
   - **验证证据**：
     - `node -c main.js preload-settings.js preload-lock.js` 语法检查全部通过；
     - `node scratch/test-screen-lock.js` 执行 12 项单测与边界测试，18/18 验收标准（AC1~AC18）100% 变绿；
     - `comet native next screen-lock` 推进完成 Build 与 Verify 阶段，验收 18/18 通过。

20. **v1.5.20 GitHub Actions 多端自动化构建与正式发布完成**：
    - **构建状态**：GitHub Actions Release Workflow（Run ID `39891330584`）编译完成，耗时约 2 分 37 秒，全矩阵全部成功（Windows / Ubuntu / macOS）。
    - **发布地址**：[https://github.com/xusofty-cyber/muse-ai-Desktop/releases/tag/v1.5.20](https://github.com/xusofty-cyber/muse-ai-Desktop/releases/tag/v1.5.20)
    - **资产清单**：
      - Windows: `Muse-Setup-1.5.20.exe` (安装程序), `Muse-Portable-1.5.20.exe` (便携单文件), `latest.yml`
      - Linux: `Muse-1.5.20.AppImage`, `muse-desktop_1.5.20_amd64.deb`, `muse-desktop-1.5.20.tar.gz`, `latest-linux.yml`
      - macOS: `Muse-1.5.20-arm64-mac.zip.blockmap` 及 DMG/ZIP 安装包

## 五、当前断点与后续待执行事项

21. **GitHub Actions 发布流彻底重构（杜绝多端并发 Draft 竞态与资产分裂）**：
    - **根因消除**：彻底废除 3 端并行 Runner 调用 `electron-builder --publish always` 直接上传 GitHub Releases 的做法（消除了 Draft 竞态与多端孤立 Release）；
    - **两阶段原子发布（Two-Stage Atomic Publish）**：
      1. 第一阶段（Matrix Build）：Windows/Linux/macOS 仅负责纯粹编译打包（`--publish never`），通过 `actions/upload-artifact@v4` 暂存构件；
      2. 第二阶段（Atomic Publish）：三端构建全部成功后，由单个 `publish` 任务通过 `actions/download-artifact@v4` 统一下载并使用 `gh release create/upload` 单一指令一次性将全平台资产挂载到同一个 Release 并转正；任何一端失败均不触发发布。
    - **验证**：YAML 语法与解析验证通过，已在临时分支 `fix/release-workflow` 提交。

22. **v1.5.22 锁屏隐藏主窗口与异步重显安全门禁彻底修复**：
    - **现场缺陷**：锁屏窗口弹出时，主窗口未被隐藏，用户仍能滚动主窗口甚至输入。
    - **根因消除**：
      1. 移除 `lockScreen()` 中原先脆弱的 `win.isVisible()` 过滤，改为对 `BrowserWindow.getAllWindows()` 全量窗口执行无条件安全隐匿；
      2. 在统一显示函数 `showWindowSafely(win)` 头部加入 `if (isScreenLocked) return false;` 绝对门禁，任何渠道（ready-to-show、切账号、异步复查）严禁在锁屏期间显示主窗口；
      3. 在 `showMainWindow()` 的 250ms 异步恢复定时器两段回调中均补充 `if (isScreenLocked) return;` 防御，彻底消除异步重显竞态。
    - **测试证据**：Node 语法校验 Exit Code 0，`test-dock-and-lock.js` 7 项全 PASS，`test-screen-lock.js` 12 项全 PASS，安全门禁断言全部通过。版本号正式升至 `1.5.22`。

23. **GitHub Search 搜索排名与 README SEO 全面优化**：
    - **实测数据**：使用 GitHub API 检索确认项目已被收录，原排名位于第 62 位（第 7 页）；
    - **优化落地**：
      1. H1 标题精确锚定：`# Muse Desktop: Native Desktop Client for Muse AI & Meta AI`，中英双语对齐；
      2. 简介段落高频覆盖 `Muse Desktop`、`muse-desktop`、`Muse AI Desktop` 等核心短语；
      3. 补充 Electron 框架标识、v1.5.20~v1.5.22 主密码锁屏与 12+ 账号高密度防挤压 Dock 等最新特性说明与快捷键清单；
    - **合并流转**：已通过临时分支 `docs/seo-readme-optimization` 合入 `main` 主分支并推送到 `origin/main`。

## 五、当前断点与后续待执行事项

1. **当前断点**：
   - 锁屏安全隐藏缺陷与版本号 `1.5.22` 已全部合入 `main` 并打 tag `v1.5.22` 推送至远端（GitHub Actions 发布流水线运行完成）；
   - 中英双语 README 针对 GitHub 搜索的最佳匹配 SEO 优化已合并并推送到 `origin/main`；
   - 建议在 GitHub 网页端对应更新仓库右侧 About 区域的 Description 与 Topics 标签以完成最终加权。
2. **后续待办**：
   - [x] 彻底修复锁屏窗口弹出时主窗口未隐藏及异步重显竞态问题。
   - [x] 同步 package.json 与 package-lock.json 版本至 1.5.22。
   - [x] 合并至 main 分支，打标签 v1.5.22 并推送到 GitHub 远端触发构建发布。
   - [x] 优化中英文 README 标题、关键词与框架徽章，提升 GitHub 搜索命中权重并推送远端。
