# areco 桌面壳（packages/app）

像 weSaw 那样的 Electron 应用壳：一个窗口加载 areco server（默认 `http://127.0.0.1:8790`），
替代现在的 Chrome Apps 快捷方式。前端不重复打包——复用 launchd 常驻的 areco 服务，
同源 `/api` `/ws` 天然可用。

## 运行

```bash
npm install        # 首次
npm start          # 开发态启动（窗口 + dock 图标）
ARECO_URL=http://other-host:8790 npm start   # 指向其他 areco 服务
```

服务没启动时壳会显示「连接中」重试页，服务恢复后自动跳进 areco。

## 打包

```bash
npm run pack   # 免 dmg 快速验证：dist/mac-arm64/areco.app
npm run dist   # 出 dist/areco-app-<version>-arm64.dmg（未公证，本机自用）
```

## 行为

- 窗口 1400×800，macOS `hiddenInset` 标题栏融合（同 weSaw）。
- 单实例；外部链接一律交给系统浏览器。
- 无托盘、无自动更新、无 IPC——纯壳，刻意保持简单。
- 配置只有一个环境变量 `ARECO_URL`，默认 `http://127.0.0.1:8790`。
