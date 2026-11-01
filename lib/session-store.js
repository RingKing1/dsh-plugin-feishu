import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const STATE_VERSION = 1
/** 会话映射上限：超出按最后更新时间淘汰最旧的，防止文件无限膨胀。 */
const MAX_SESSIONS = 500

/**
 * 飞书会话（chat / thread）到 dsh 会话的映射，落盘为单个 JSON 文件。
 *
 * 为什么不用数据库：映射极小（几百条）、读取在启动时一次完成，
 * 原子写（临时文件 + rename）就足够，且不引入任何外部依赖。
 */
export class SessionStore {
  constructor(statePath, log) {
    this.path = statePath
    this.log = log
    /** @type {Map<string, { sessionId: string, cwd: string, updatedAt: number }>} */
    this.sessions = new Map()
    this.writing = Promise.resolve()
  }

  /** 读取映射。文件不存在按空处理；损坏则告警后按空启动，绝不阻断启动。 */
  async load() {
    let raw
    try {
      raw = await readFile(this.path, 'utf8')
    } catch (error) {
      if (!error || error.code !== 'ENOENT') {
        this.log.warn('读取会话映射失败，按空映射启动', { path: this.path, error: String(error) })
      }
      return
    }

    try {
      const parsed = JSON.parse(raw)
      const entries = parsed && parsed.sessions
      if (entries && typeof entries === 'object') {
        for (const key of Object.keys(entries)) {
          const value = entries[key]
          if (!value || typeof value.sessionId !== 'string') continue
          this.sessions.set(key, {
            sessionId: value.sessionId,
            cwd: typeof value.cwd === 'string' ? value.cwd : '',
            updatedAt: Number(value.updatedAt) || 0,
          })
        }
      }
      this.log.debug('已载入会话映射', { path: this.path, total: this.sessions.size })
    } catch (error) {
      this.log.warn('会话映射文件损坏，按空映射启动', { path: this.path, error: String(error) })
      // 备份坏文件，避免下一次写入把用户还能手动抢救的内容覆盖掉
      await rename(this.path, this.path + '.corrupt-' + Date.now()).catch(() => {})
    }
  }

  get(key) {
    return this.sessions.get(key)
  }

  set(key, value) {
    this.sessions.set(key, {
      sessionId: String(value.sessionId || ''),
      cwd: String(value.cwd || ''),
      updatedAt: Date.now(),
    })
    this.prune()
    return this.save()
  }

  delete(key) {
    if (!this.sessions.delete(key)) return Promise.resolve()
    return this.save()
  }

  /** 串行写入：并发调用只会排队，不会出现两个写者互相覆盖。 */
  save() {
    this.writing = this.writing.then(() => this.writeNow()).catch((error) => {
      this.log.warn('写入会话映射失败', { path: this.path, error: String(error) })
    })
    return this.writing
  }

  async writeNow() {
    const sessions = {}
    for (const [key, value] of this.sessions) sessions[key] = value
    const payload = { version: STATE_VERSION, sessions }
    await mkdir(dirname(this.path), { recursive: true })
    const temporary = this.path + '.tmp'
    await writeFile(temporary, JSON.stringify(payload, null, 2), 'utf8')
    await rename(temporary, this.path)
  }

  prune() {
    if (this.sessions.size <= MAX_SESSIONS) return
    const ordered = Array.from(this.sessions.entries())
      .sort((left, right) => left[1].updatedAt - right[1].updatedAt)
    const overflow = ordered.slice(0, this.sessions.size - MAX_SESSIONS)
    for (const entry of overflow) this.sessions.delete(entry[0])
  }
}
