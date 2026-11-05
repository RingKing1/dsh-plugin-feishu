/**
 * 在册卡片（NFR-2③）：把「还有哪些卡片正在跑」写到磁盘。
 *
 * 为什么必须有这一层：进程崩了 / 被强杀时，内存里的 liveCards 一起消失，
 * 飞书那边那张卡就永久停在「回复中」。重启后没有任何人知道它的存在，
 * 除非我们提前把 cardId 落到文件里。启动时读回来逐张翻成「已中断」，
 * 用户至少知道这轮没成，而不是对着一个假活的卡片等下去。
 *
 * 文件与会话映射同目录（statePath 旁边），多机器人按 appId 分开。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { buildCard } from './card.js'

/** 在册文件里最多留多少条：异常场景下也不会无限膨胀 */
const MAX_ENTRIES = 50

function entryOf(item) {
  if (!item || typeof item !== 'object') return undefined
  const cardId = String(item.cardId || '').trim()
  if (!cardId) return undefined
  return {
    cardId,
    key: String(item.key || ''),
    chatId: String(item.chatId || ''),
    title: String(item.title || ''),
    since: Number(item.since) || 0,
  }
}

export class CardRegistry {
  /**
   * @param {string} path 在册文件路径
   * @param {{debug?: Function, warn?: Function}} log
   */
  constructor(path, log) {
    this.path = path
    this.log = log
    this.items = new Map()
    /** 串行化落盘：并发 add/remove 不会互相覆盖 */
    this.chain = Promise.resolve()
  }

  /** 从磁盘载入上次的在册记录（文件不存在 = 正常情况） */
  async load() {
    if (!this.path) return []
    try {
      const text = await readFile(this.path, 'utf8')
      const parsed = JSON.parse(text)
      const list = Array.isArray(parsed) ? parsed : []
      this.items.clear()
      for (const item of list) {
        const entry = entryOf(item)
        if (entry) this.items.set(entry.cardId, entry)
      }
    } catch (error) {
      if (error && error.code === 'ENOENT') return []
      // 文件坏了不该阻断启动：丢掉内容重建，并留一条可检索的记录
      this.log.warn('在册卡片文件读取失败，按空处理', { path: this.path, error: String(error) })
    }
    return this.list()
  }

  list() {
    return [...this.items.values()]
  }

  /** 卡片建好：立刻落盘。没落成也不影响本轮（只是崩溃后少一次兜底） */
  add(entry) {
    const item = entryOf(entry)
    if (!item) return Promise.resolve()
    this.items.set(item.cardId, item)
    // 超出上限时丢最老的：崩溃兜底是「尽力而为」，不能反噬主流程
    while (this.items.size > MAX_ENTRIES) {
      const oldest = this.items.keys().next().value
      this.items.delete(oldest)
    }
    return this.persist()
  }

  /** 卡片收尾 / 中断：从在册表移除 */
  remove(cardId) {
    if (!this.items.delete(String(cardId || ''))) return Promise.resolve()
    return this.persist()
  }

  /** 原子写：先写临时文件再 rename，避免崩在半行 JSON 上导致下次读不出来 */
  persist() {
    const path = this.path
    if (!path) return Promise.resolve()
    const payload = JSON.stringify(this.list(), null, 2)
    this.chain = this.chain
      .then(async () => {
        await mkdir(dirname(path), { recursive: true })
        const temp = path + '.tmp'
        await writeFile(temp, payload, 'utf8')
        await rename(temp, path)
      })
      .catch((error) => {
        this.log.warn('在册卡片落盘失败（不影响本轮）', { path, error: String(error) })
      })
    return this.chain
  }
}

/**
 * 启动清扫：把上次进程留下的、还在「回复中」的卡片逐张翻成「已中断」。
 *
 * 每张都独立 try/catch：一张卡的接口失败（比如消息被撤回）不能挡住其它卡。
 *
 * @param {CardRegistry} registry
 * @param {{updateCard: Function}} api
 * @param {{warn?: Function, info?: Function}} log
 * @param {string} reason
 * @returns {Promise<number>} 成功翻掉的张数
 */
export async function sweepStaleCards(registry, api, log, reason) {
  const items = registry.list()
  if (items.length === 0) return 0
  let done = 0
  for (const item of items) {
    const card = buildCard({
      status: 'stopped',
      title: item.title || '回复（中断）',
      body: '',
      note: '⚠️ ' + (reason || '服务重启，本轮回复已中断') + '，请重发这条消息',
      statusLine: '⛔ 已中断 · 服务重启',
      progressEnabled: false,
    })
    try {
      // 重启后 sequence 无从得知，用时间戳起步，保证比崩溃前任何一次写入都大
      await api.updateCard(item.cardId, card, Date.now())
      done += 1
    } catch (error) {
      log.warn('清扫残留卡片失败', { cardId: item.cardId, key: item.key, error: String(error) })
    }
    await registry.remove(item.cardId)
  }
  if (done > 0 && typeof log.info === 'function') log.info('已清扫上次遗留的运行中卡片', { count: done })
  return done
}

/** 在册文件路径：跟 statePath 同目录，按 appId 分开（多机器人互不干扰） */
export function cardRegistryPath(statePath, appId) {
  const base = dirname(String(statePath || join(process.cwd(), 'state.json')))
  const safe = String(appId || 'default').replace(/[^A-Za-z0-9_-]/g, '_')
  return join(base, 'running-cards-' + safe + '.json')
}
