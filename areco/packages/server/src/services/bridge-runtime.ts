// agent-bridge 运行时单例：全 server 共享一个 Python sidecar（单 worker MVP，
// 多会话由 sidecar 内会话池承担）。懒启动——第一个 bridge 会话 spawn 时才拉起。
//
// 测试替身：setBridgeRuntimeForTesting 注入假 client，BridgeSession 的单测不起真进程。
import os from 'node:os'
import path from 'node:path'
import { AgentBridgeClient, AgentBridgeManager } from './agent-bridge'
import { createLogger } from '../logger'

const log = createLogger('bridge-runtime')

let manager: AgentBridgeManager | null = null
let testingClient: AgentBridgeClient | null = null

export async function ensureBridgeRuntime(): Promise<AgentBridgeClient> {
  if (testingClient) return testingClient
  if (!manager) {
    manager = new AgentBridgeManager({
      key: 'areco',
      // 隔离 home 是纪律：bridge 会话的状态绝不写生产 ~/.qclaw-hermes
      hermesHome: process.env.ARECO_BRIDGE_HERMES_HOME ?? path.join(os.homedir(), '.hermes-agent-bridge'),
      provider: process.env.ARECO_BRIDGE_PROVIDER ?? 'qclaw',
      model: process.env.ARECO_BRIDGE_MODEL ?? 'pool-deepseek-v4-flash',
    })
  }
  try {
    return await manager.ensureReady()
  } catch (err) {
    // 启动失败后丢掉 manager，下次 spawn 重试（否则一次坏死永久坏）
    manager = null
    log.error('bridge sidecar 启动失败', err)
    throw err
  }
}

/** 服务关闭时级联停 sidecar（index.ts 的 SIGTERM 钩子调） */
export async function stopBridgeRuntime(): Promise<void> {
  const m = manager
  manager = null
  if (m) await m.stop()
}

/** 仅测试：注入假 client 后 ensureBridgeRuntime 直接返回它；传 null 复原。 */
export function setBridgeRuntimeForTesting(client: AgentBridgeClient | null): void {
  testingClient = client
}
