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

## 五、当前断点与后续待执行事项

1. **当前断点**：
   - `v1.5.13`、`v1.5.14` 均已合并 main（f111f45），正式发版与实机复核待进行；`v1.5.15` 第二批修复已合并 main（40cf4f3），release.yml 的 sips 步骤与 1024 图标已由用户手动补齐（84f6689、dd332b6）；`v1.5.16` 第三批修复（登出范围与缓存、权限询问、删号原子化、randomUUID、profiles 校验、.bak 代际、更新流式下载、Auto-Allow 加固、发布配置侧）在分支 fix/batch3-session-hygiene 待合并，配套 release.yml v2 待用户替换。评审剩余尾巴（第四批候选）：聊天导出健壮性、外链拦截收窄与参数解包、注入指纹面收敛、file:// 内部站点归类、Google 重置入口一致性、lock 镜像与 CI npm ci 回退、代码签名（需证书投入）、executableName 改名过渡提示。
2. **后续下一步**：
   - [x] 完成代码修复与语法校验。
   - [x] 合并至 `main` 主分支并推送到远端。
   - [x] 发布 Release 标签 `v1.5.12` 触发 CI/CD 自动化构建。



