// /api/* 路由声明：只做 URL → controller 映射，零业务
import Router from '@koa/router'
import type { ApiControllers } from '../controllers/api'
import type { RoomControllers } from '../controllers/rooms'

export function createApiRouter(c: ApiControllers, rc: RoomControllers): Router {
  const router = new Router({ prefix: '/api' })

  router.get('/system', c.system)
  router.put('/settings', c.updateSettings)
  router.post('/server/restart', c.restartServer)

  router.get('/templates', c.listTemplates)
  router.post('/templates', c.createTemplate)
  router.post('/templates/reorder', c.reorderTemplates)
  router.put('/templates/:id', c.updateTemplate)
  router.delete('/templates/:id', c.removeTemplate)

  router.get('/sessions', c.listSessions)
  router.post('/sessions', c.spawnSession)
  router.get('/sessions/:id', c.getSession)
  router.post('/sessions/:id/stop', c.stopSession)
  router.post('/sessions/:id/handoff', c.sessionHandoff)
  router.post('/sessions/:id/kill', c.killSession)
  router.post('/sessions/:id/restart', c.restartSession)
  router.post('/sessions/:id/rename', c.renameSession)
  router.post('/sessions/:id/archive', c.archiveSession)
  router.post('/sessions/:id/pin', c.pinSession)
  router.post('/sessions/:id/unarchive', c.unarchiveSession)
  router.delete('/sessions/:id', c.removeSession)

  router.get('/sessions/:id/transcript', c.transcript)
  router.get('/sessions/:id/screen', c.screen)
  router.get('/stats', c.stats)

  router.get('/history', c.historyList)
  router.get('/history/:source/:project/:id/transcript', c.historyTranscript)
  router.post('/history/:source/:project/:id/resume', c.historyResume)
  router.post('/history/:source/:project/:id/continue', c.historyContinue)

  router.get('/files/meta', c.fileMeta)
  router.get('/files/raw', c.fileRaw)
  router.post('/files/upload', c.fileUpload)
  router.post('/files/locate-dir', c.fileLocateDir)

  // 语音输入（长按说话→转写）：raw 16kHz wav → 文字。前端 PromptBar 长按录音后 POST
  router.post('/voice/transcribe', c.voiceTranscribe)

  // 项目协作（Phase 6：项目 = 人 + 活会话，@mention 投递终端，消息 SoT 在项目消息库）
  router.get('/rooms', rc.list)
  router.post('/rooms', rc.create)
  router.post('/rooms/:id/archive', rc.archive)
  router.post('/rooms/:id/unarchive', rc.unarchive)
  router.delete('/rooms/:id', rc.remove)
  router.post('/rooms/:id/members', rc.addMember)
  router.delete('/rooms/:id/members/:name', rc.removeMember)
  router.get('/rooms/messages/search', rc.search)
  router.get('/rooms/:id/messages', rc.messages)
  router.post('/rooms/:id/messages', rc.send)
  // 房间调度（确定性轮转）：列表 / 切模式 / 取消
  router.get('/rooms/:id/dispatches', rc.listDispatches)
  router.post('/rooms/:id/mode', rc.setMode)
  router.post('/rooms/:id/repo', rc.setRepo)
  router.post('/rooms/:id/root', rc.setRoot)
  router.get('/rooms/:id/files', rc.files)
  router.post('/rooms/:id/dispatches/:dispatchId/cancel', rc.cancelDispatch)
  router.post('/rooms/:id/dispatches/:dispatchId/merge-check', rc.mergeCheck)
  router.post('/rooms/:id/dispatches/:dispatchId/resolve-conflict', rc.resolveConflict)

  return router
}
