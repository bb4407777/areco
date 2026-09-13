import fs from 'node:fs'
import { trafficStateFromMessages, type TrafficState } from '../../../shared/traffic'
import { readHistoryPage } from './history'

export function transcriptFingerprint(filePath: string): string | null {
  let fd: number | null = null
  try {
    const stat = fs.statSync(filePath)
    if (!stat.isFile() || stat.size === 0) return null
    fd = fs.openSync(filePath, 'r')
    const tail = Buffer.allocUnsafe(1)
    if (fs.readSync(fd, tail, 0, 1, stat.size - 1) !== 1 || tail[0] !== 0x0a) return null
    return `${filePath}:${stat.mtimeMs}:${stat.size}`
  } catch {
    return null
  } finally {
    if (fd !== null) fs.closeSync(fd)
  }
}

export function readClaudeTrafficState(filePath: string): Exclude<TrafficState, 'exited'> {
  return trafficStateFromMessages(readHistoryPage(filePath).messages)
}
