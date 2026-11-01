/**
 * 同一会话内串行、跨会话并行的任务队列。
 * 作用：同一个飞书会话连发多条消息时，保证按到达顺序逐条进入 agent，
 * 不会出现两条消息同时驱动同一轮次的竞态。
 */
export class SerialQueue {
  constructor() {
    /** @type {Map<string, Promise<void>>} */
    this.tails = new Map()
  }

  /**
   * @param {string} key 会话键
   * @param {() => Promise<void>} task 任务
   * @returns {Promise<void>} 本任务的完成结果（失败会抛出给调用方）
   */
  run(key, task) {
    const previous = this.tails.get(key) || Promise.resolve()
    // 前一个任务失败也必须继续跑下一个，故 then 的两个分支都指向 task
    const next = previous.then(task, task)
    const settled = next.catch(() => {})
    this.tails.set(key, settled)
    // 队列清空后回收条目，避免长期运行后 Map 无界增长
    settled.then(() => {
      if (this.tails.get(key) === settled) this.tails.delete(key)
    })
    return next
  }

  /** 当前还有排队的会话数（就绪状态展示用）。 */
  get size() {
    return this.tails.size
  }
}
