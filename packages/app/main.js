// areco 桌面壳主进程：一个窗口加载 areco server，连不上时显示重试页
const { app, BrowserWindow, shell } = require('electron')
const { join } = require('path')

const ARECO_URL = (process.env.ARECO_URL || 'http://127.0.0.1:8790').replace(/\/+$/, '')
const iconPath = join(__dirname, 'build', 'icon.png')

// hiddenInset 红绿灯直接浮在内容区左上角。壳里注入 CSS：在 areco 顶栏上方
// 垫一条 32px 的「红绿灯栏」（带下边框作隔断，可拖动窗口），areco 顶栏保持原样靠左；
// 顶栏本身也作为拖动区（链接/按钮保持可点）
const SHELL_CSS = `
  .app-shell::before {
    content: '';
    flex: 0 0 32px;
    background: var(--bar);
    border-bottom: 1px solid var(--border);
    -webkit-app-region: drag;
  }
  .app-header { -webkit-app-region: drag !important; }
  .app-header .brand, .app-header .nav { -webkit-app-region: no-drag !important; }
`

let mainWindow = null

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 800,
    // 最小尺寸按 iPhone SE3 逻辑分辨率（375x667），小于 768 断点自动切手机布局
    minWidth: 375,
    minHeight: 667,
    show: false,
    autoHideMenuBar: true,
    icon: iconPath,
    // Areco 式窗口融合：内容延伸进标题栏，红绿灯内嵌（仅 macOS）
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' } : {}),
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      preload: join(__dirname, 'preload.js')
    }
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
  })

  // 外部链接交给系统浏览器，不在壳里开新窗口
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // 服务不可达（没启动/重启中）时进重试页，由它轮询恢复后自动跳回
  mainWindow.webContents.on('did-fail-load', (_event, _code, _desc, _url, isMainFrame) => {
    if (!isMainFrame) return
    mainWindow.loadFile(join(__dirname, 'offline.html'), { query: { url: ARECO_URL } })
  })

  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.insertCSS(SHELL_CSS)
  })

  mainWindow.loadURL(ARECO_URL)
}

// 单实例：重复启动时聚焦已有窗口
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
    app.setName('areco')
    // 开发态（未打包）下 macOS dock 默认是 Electron 图标，换成 areco 的
    if (process.platform === 'darwin' && !app.isPackaged) {
      app.dock?.setIcon(iconPath)
    }
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
