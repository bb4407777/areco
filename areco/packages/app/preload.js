// areco 桌面壳 preload：给页面暴露桥接口。拖入的文件/文件夹直接取真实绝对路径，
// 前端据此跳过 Spotlight 反查/上传副本；浏览器环境无此桥，自动走原 fallback。
const { contextBridge, webUtils } = require('electron')

// 来源白名单：壳可能加载远程站点（areco.gaochengbin.com），桥只注入给自己人的来源，
// 其他来源（比如被重定向到的第三方页面）一律不暴露
const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', 'areco.gaochengbin.com'])

if (ALLOWED_HOSTS.has(window.location.hostname)) {
  contextBridge.exposeInMainWorld('arecoShell', {
    // 对虚拟 File（如网页里拖来的图）返回空串，由前端退回原流程
    getPathForFile: (file) => webUtils.getPathForFile(file),
  })
}
