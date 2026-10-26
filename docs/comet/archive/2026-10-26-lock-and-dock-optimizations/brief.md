# 目标

1. **锁屏窗口去置顶**：移除锁屏窗口（`lockWindow`）的 `alwaysOnTop: true` 强制全屏置顶属性，避免锁屏状态下阻碍用户操作其他桌面外部应用（如浏览器、开发工具等）；锁定状态下继续严格隐匿 Muse 内部全部会话窗口并拦截全局快捷键。
2. **多账号列表扩容与防挤压**：优化左侧悬浮多账号 Dock 栏（`#acct-dock`）布局与滚动机制，解决账号达到 9 个及以上时的元素挤压、截断与溢出问题；支持至少 12 个账号的管理且不设上限（支持无限账号纵向平滑滚动），提供现代高质感纤细滚动条。
3. **鼠标移开自动收起与点开固定模式**：
   - 默认模式：Dock 栏未固定时，鼠标移入（hover）平滑展开；切换账号或操作完毕鼠标移开后（`mouseleave`）自动平滑收起至侧边，减少视线干扰；
   - 固定模式（📌）：提供一键“固定”切换按钮，用户主动点开固定后，侧边栏保持常态展开，鼠标移开不自动收起；状态支持持久化落盘与跨账号同步。

# 范围

1. **主进程窗口调度与状态持久化 (`main.js`)**：
   - `lockWindow` 构造参数中调整 `alwaysOnTop: false`；
   - `defaultState.ui` 增加 `dockPinned: false` 字段；`sanitizeAndMergeState` 支持合并；
   - 扩充 `AVATAR_COLORS` 调色盘至 16 色，确保 12 个以上账号拥有各不相同的质感头像配色；
   - 新增 `dock:set-pinned` IPC 通道（附带 `denyUntrusted` 校验）；
   - `account:get-state` 与 `broadcastAccountChange` 增加 `dockPinned` 字段下发。

2. **多账号 Dock 样式与交互引擎 (`preload-chat-export.js`)**：
   - `#acct-dock` 增加 `max-height: calc(100vh - 28px)` 与 `box-sizing: border-box`，彻底防止溢出屏幕外；
   - `.acct-dock-list` 设置 `max-height: min(520px, calc(100vh - 210px))`，采用 `flex: 1 1 auto; min-height: 0;` 与 `gap: 6px`；
   - `.acct-dock-item` 增加 `flex-shrink: 0;`，头像尺寸为 34px，保证即使拥有 12~20 个账号也绝不发生变形挤压；
   - 引入纤细半透明 WebKit 滚动条（`scrollbar-width: thin;` 与 4px 滑块），滚动流畅自然，支持明暗双色模式自适应；
   - 顶部增加 Header 容器，包含折叠按钮与固定按钮（📌 `acct-dock-pin-btn`）；
   - 支持中英双语国际化提示（`pinDock` / `unpinDock`）；
   - 监听 `mouseenter` 与 `mouseleave`：未固定模式下移入即展开、移开后 250ms 自动收起；点击固定后保持展开。

# 非目标

1. 不修改锁屏密码加密散列逻辑（保留 `crypto.scryptSync` 与 `timingSafeEqual`）。
2. 不修改多 Partition 隔离与常驻窗口（`profileWindows`）复用机制。
3. 不引入额外的第三方 UI 依赖，保持 Vanilla CSS 与 Electron 原生轻量实现。

# 验收示例

- **AC-1 (锁屏窗口非置顶)**：触发锁定（快捷键/托盘/设置）后，`lockWindow` 弹出并聚焦，但 `alwaysOnTop === false`，用户切换到其他桌面外部应用时，外部应用可正常盖在锁屏窗口上方，不阻挡其它应用操作；Muse 内部窗口依然隐匿安全。
- **AC-2 (12+ 账号平滑承载与防挤压)**：添加账号至 9 个、12 个乃至更多时，Dock 栏头像尺寸与间距保持统一规整，头像绝无垂直挤压变形；列表超出可视高度时出现平滑细滚动条，支持鼠标滚轮上下滚动，激活账号自动滚动至视口。
- **AC-3 (移开鼠标自动收起)**：未固定状态下，鼠标移入 Dock 栏展开，点击切换到某一账号后，当鼠标离开 Dock 区域，Dock 栏自动收缩至左侧屏幕边缘，仅保留边缘指示条。
- **AC-4 (主动点开固定)**：点击顶部“📌”固定按钮后，Dock 栏进入固定状态（高亮显示），鼠标移出不会自动收起；再次点击取消固定后恢复自动收起行为；刷新或重启后保持固定状态。
