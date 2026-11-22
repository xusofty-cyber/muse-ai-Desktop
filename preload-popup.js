// 授权 / 连接器弹窗专用的最小 preload (2026-11-22 审查 M2)。
// 这类弹窗承载第三方页面, 刻意不暴露任何 contextBridge 接口、不注入任何 UI,
// 也不发送任何 IPC。需要的横幅提示由主进程 executeJavaScript 注入。
