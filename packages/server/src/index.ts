// 装配入口：config → services → Koa 中间件按序注册（healthz → Host/Origin 守卫 → 登录路由 →
// 会话守卫 → /api → 静态+SPA fallback）→ ws upgrade 挂载 → SIGTERM 优雅退出
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import Koa from 'koa'
import { bodyParser } from '@koa/bodyparser'
import serve from 'koa-static'
import { loadConfig, enforceSecurityGate, CLIENT_DIR, ENTRY_DIR, ROOT_DIR, DATA_DIR } from './config'
import { createLogger, enableFileLog } from './logger'
import { AuthService, LoginLimiter } from './services/auth'
import { runPasswordCli } from './services/password'
import { TemplateStore } from './services/templates'
import { Persistence } from './services/persistence'
import { SessionManager } from './services/session-manager'
import { ApiControllers, getAccessUrls } from './controllers/api'
import { RoomStore, DEFAULT_HUMAN_NAME } from './services/rooms'
import { RoomRelay } from './services/room-relay'
import { RoomControllers } from './controllers/rooms'
import { createAuthRouter } from './routes/auth'
import { createApiRouter } from './routes/api'
import { createHostOriginGuard, createSessionGuard } from './middleware/auth'
import { Gateway } from './ws/gateway'
import { FileService } from './services/files'
import { ProjectFileService } from './services/project-files'

declare const __APP_VERSION__: string | undefined

const log = createLogger('server')

// npm 安装会丢 node-pty spawn-helper 的可执行位（macOS 上表现为 posix_spawnp failed），启动时自修复。
// node-pty 位置按三种布局探测：仓库根跑（ROOT_DIR/node_modules）、npm 顶层提升
// （node_modules/areco 的兄弟 node-pty）、包内嵌套（包根/node_modules）——修不到则会话 spawn 全挂
function repairSpawnHelper() {
  const entry = ENTRY_DIR
  const bases = [
    path.join(ROOT_DIR, 'node_modules', 'node-pty'),
    path.resolve(entry, '..', '..', '..', 'node-pty'), // dist/server → 包根 → node_modules → node-pty（npm 提升布局）
    path.resolve(entry, '..', '..', 'node_modules', 'node-pty'), // 包内嵌套布局
  ]
  const helper = bases
    .map((b) => path.join(b, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'))
    .find((p) => fs.existsSync(p))
  if (helper) {
    try {
      fs.chmodSync(helper, 0o755)
    } catch {
      log.warn(`spawn-helper chmod 失败: ${helper}`)
    }
  }
}

function resolveVersion(): string {
  if (typeof __APP_VERSION__ !== 'undefined' && __APP_VERSION__) return __APP_VERSION__
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8')).version as string
  } catch {
    return 'dev'
  }
}

async function main() {
  // 生产环境也能改密码：node dist/server/index.js --hash "密码" [--save]
  const hashFlag = process.argv.indexOf('--hash')
  if (hashFlag >= 0) {
    await runPasswordCli(process.argv.slice(hashFlag + 1))
    return
  }

  const version = resolveVersion()
  const config = loadConfig()
  enforceSecurityGate(config)
  enableFileLog(path.join(DATA_DIR, 'logs'))
  repairSpawnHelper()

  const auth = new AuthService(() => config.server.passwordHash, config.server.sessionTtlHours * 3600_000)
  const limiter = new LoginLimiter()
  const templates = new TemplateStore(config)
  const persistence = new Persistence()
  const manager = new SessionManager(config, templates, persistence)
  const files = new FileService(
    () => config.server.fileRoots,
    () => config.server.fileRootsUnrestricted
  )
  const projectFiles = new ProjectFileService(files)
  const controllers = new ApiControllers(manager, templates, config, version, files)
  const gateway = new Gateway(manager, templates, persistence, auth, config, version)
  const rooms = new RoomStore(config.humanName ?? DEFAULT_HUMAN_NAME)
  const roomRelay = new RoomRelay(rooms, manager, (msg) => gateway.broadcast(msg), {
    humanRelayAgents: config.humanRelayAgents ?? [],
  })
  const roomControllers = new RoomControllers(rooms, roomRelay, manager, templates, projectFiles)

  const app = new Koa()
  app.proxy = false

  // 兜底错误处理
  app.use(async (ctx, next) => {
    try {
      await next()
    } catch (err) {
      log.error(`${ctx.method} ${ctx.path} 未捕获错误`, err)
      ctx.status = 500
      ctx.body = { ok: false, error: { code: 'internal', message: '服务器内部错误' } }
    }
  })

  // public：存活探针（在一切守卫之前）
  app.use(async (ctx, next) => {
    if (ctx.path === '/healthz') {
      ctx.body = { ok: true, version }
      return
    }
    await next()
  })

  app.use(createHostOriginGuard(config))
  app.use(bodyParser({ enableTypes: ['json', 'form'], jsonLimit: '1mb', formLimit: '256kb', encoding: 'utf-8' }))

  // public：登录/登出（守卫之前注册 = 注册顺序式鉴权）
  const authRouter = createAuthRouter(auth, limiter, config.server.title)
  app.use(authRouter.routes()).use(authRouter.allowedMethods())

  // protected：以下全部需要登录
  app.use(createSessionGuard(auth))
  const apiRouter = createApiRouter(controllers, roomControllers)
  app.use(apiRouter.routes()).use(apiRouter.allowedMethods())

  // 静态资源 + SPA fallback（CLIENT_DIR 按包布局探测——npm 安装时产物在包内，不在数据根）
  const clientDir = CLIENT_DIR
  const indexHtml = path.join(clientDir, 'index.html')
  // 缓存策略：哈希资源一年 immutable；HTML 一律 no-store——iPhone PWA 缓存旧 index.html 后，
  // 其引用的旧哈希 chunk 已被重建删除，懒加载路由 404 → 导航静默失败（点按钮没反应）
  app.use(async (ctx, next) => {
    await next()
    if ((ctx.method !== 'GET' && ctx.method !== 'HEAD') || ctx.status !== 200) return
    if (ctx.path.startsWith('/assets/')) ctx.set('cache-control', 'public, max-age=31536000, immutable')
    else if (ctx.response.is('html')) ctx.set('cache-control', 'no-store')
  })
  if (fs.existsSync(clientDir)) {
    app.use(serve(clientDir, { index: 'index.html', maxAge: 0 }))
  }
  app.use(async (ctx) => {
    if (ctx.method === 'GET' && !ctx.path.startsWith('/api') && fs.existsSync(indexHtml)) {
      ctx.type = 'text/html; charset=utf-8'
      ctx.body = fs.createReadStream(indexHtml)
      return
    }
    ctx.status = 404
    ctx.body = fs.existsSync(indexHtml)
      ? { ok: false, error: { code: 'not_found', message: '未找到' } }
      : { ok: false, error: { code: 'no_client', message: '前端未构建：npm run build；开发模式请访问 vite 端口 8791' } }
  })

  const server = http.createServer(app.callback())
  gateway.mount(server)

  manager.restore()
  manager.autoStart()
  manager.startPeriodicSnapshots()
  roomRelay.start()

  const { host, port } = config.server
  server.listen(port, host, () => {
    const urls = getAccessUrls(port)
    log.info(`Areco v${version} 监听 ${host}:${port}（认证：${auth.enabled ? '已启用' : '未启用（仅 loopback）'}）`)
    log.info(`本机: http://127.0.0.1:${port}/`)
    for (const u of urls.lan) log.info(`局域网: ${u}/`)
    for (const u of urls.tailscale) log.info(`Tailscale: ${u}/`)
  })

  let shuttingDown = false
  const shutdown = (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    log.info(`收到 ${signal}，优雅退出：落快照 → 停会话 → 关服务`)
    const timeout = setTimeout(() => process.exit(0), 8000)
    void manager
      .shutdown()
      .catch(() => undefined)
      .then(() => {
        roomRelay.stop()
        gateway.shutdown()
        server.close(() => {
          clearTimeout(timeout)
          process.exit(0)
        })
      })
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('unhandledRejection', (reason) => log.error('unhandledRejection', reason))
  // EPIPE: 子进程管道断开时触发（如"一键刷新"杀会话后仍有输出写入）
  // 不防护会导致 Node 默认抛 uncaughtException → 进程崩溃
  process.on('EPIPE', () => log.warn('EPIPE（子进程管道已断开，忽略）'))
  // 兜底：未捕获异常记日志但不杀进程（launchd KeepAlive 才不会反复重启）
  process.on('uncaughtException', (err) => {
    log.error('uncaughtException', err)
    // EPIPE 类不退出，其他致命错误仍优雅退出
    if ((err as NodeJS.ErrnoException).code !== 'EPIPE') {
      log.error('致命错误，3 秒后退出')
      setTimeout(() => process.exit(1), 3000)
    }
  })
}

void main()
