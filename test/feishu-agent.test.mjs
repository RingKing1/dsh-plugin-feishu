import test from 'node:test'
import assert from 'node:assert/strict'
import { FEISHU_AGENT_PREDICATE_KEY, registerFeishuAgentPredicate } from '../lib/feishu-agent.js'

const key = Symbol.for(FEISHU_AGENT_PREDICATE_KEY)

test('注册后按 agent 判断，注销后恢复原值', () => {
  const target = {}
  const agent = { id: 'a' }
  const dispose = registerFeishuAgentPredicate((value) => value === agent, target)
  assert.equal(typeof target[key], 'function')
  assert.equal(target[key](agent), true)
  assert.equal(target[key]({ id: 'b' }), false)
  dispose()
  assert.equal(key in target, false)
})

test('注销时还原之前注册的判据', () => {
  const target = {}
  const previous = () => true
  target[key] = previous
  const dispose = registerFeishuAgentPredicate(() => false, target)
  assert.notEqual(target[key], previous)
  dispose()
  assert.equal(target[key], previous)
})

test('注销晚于新注册时不能删掉新判据', () => {
  const target = {}
  const first = registerFeishuAgentPredicate(() => false, target)
  registerFeishuAgentPredicate(() => true, target)
  // 旧实例晚注销：当前值已不是自己，必须原地不动（不能把新判据删成 undefined）
  first()
  assert.equal(target[key]({}), true)
})

test('传入非函数时保持原状，返回空注销函数', () => {
  const target = {}
  const dispose = registerFeishuAgentPredicate(undefined, target)
  assert.equal(key in target, false)
  assert.doesNotThrow(() => dispose())
})
