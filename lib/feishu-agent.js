/**
 * 跨插件的「这个 agent 是不是飞书会话」判据。
 *
 * DSH 里审批工具只在飞书驱动的会话可见，但 /learn 这类**其它插件**的命令看不到
 * 本插件的 registry。于是约定一个进程级符号：
 *   - 本插件 apply 时注册 (agent) => registry.owns(agent)；
 *   - knowledge-flow 的 isFeishuSession() 读到它，就能按**当前会话**判断，
 *     而不是靠进程级环境变量（那会把本地会话误判成飞书）。
 *
 * 用 Symbol.for 而不是模块导出：两个插件各自打包，模块实例不共享，只有 globalThis 能跨过去。
 */

/** 与 .dsh/plugins/vkk-knowledge-flow/src/lib/learn.ts 的常量必须一致 */
export const FEISHU_AGENT_PREDICATE_KEY = 'dsh.feishu.isFeishuAgent'

/**
 * 注册判据，返回注销函数。
 *
 * 注销时只在「当前值仍是自己」的情况下删除/还原：多个实例或热重载交错时，
 * 不能把后注册的那一个误删掉。
 *
 * @param {(agent: unknown) => boolean} owns
 * @param {Record<symbol, unknown>} [target]
 * @returns {() => void}
 */
export function registerFeishuAgentPredicate(owns, target = globalThis) {
  if (typeof owns !== 'function') return () => {}
  const key = Symbol.for(FEISHU_AGENT_PREDICATE_KEY)
  const previous = target[key]
  const predicate = (agent) => owns(agent)
  target[key] = predicate
  return () => {
    if (target[key] !== predicate) return
    if (previous === undefined) delete target[key]
    else target[key] = previous
  }
}
