// 请求号幂等窗：客户端在「连接半死、回执没回来」时会用同一个请求号重发，
// 服务端必须只执行一次——否则同一条任务会投给 agent 两遍（2026-11-18）。
// 只做内存窗口：重启后窗口清空，但那时客户端也在重连、待发请求已按失败交还用户，不会重复投递。
export class IdempotencyWindow {
  private seen = new Map<string, number>()

  constructor(
    private readonly ttlMs = 10 * 60_000,
    private readonly max = 2000,
  ) {}

  /** true = 第一次见，应当执行；false = 窗口内重复，只回执不再执行 */
  first(id: string | undefined | null): boolean {
    if (!id) return true // 没带请求号＝老客户端，无法判重，照旧执行
    const now = Date.now()
    const at = this.seen.get(id)
    if (at !== undefined && now - at < this.ttlMs) return false
    this.seen.set(id, now)
    if (this.seen.size > this.max) {
      const cutoff = now - this.ttlMs
      for (const [key, ts] of this.seen) {
        if (ts < cutoff) this.seen.delete(key)
      }
      // 全是新条目（短时间巨量请求）：整表清掉也比无限涨强
      if (this.seen.size > this.max) this.seen.clear()
    }
    return true
  }

  get size(): number {
    return this.seen.size
  }
}
