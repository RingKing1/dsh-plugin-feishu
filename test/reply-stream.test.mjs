import test from 'node:test'
import assert from 'node:assert/strict'
import { ReplyStream, buildText } from '../lib/reply-stream.js'

/** 一次 attempt 的 start 帧 */
function start(turn, step, attemptId, revision) {
  return { type: 'start', attemptId: attemptId || 'a' + turn + '-' + step, revision: revision || 0, turn, step }
}

/** chunk 帧 */
function chunk(attemptId, body) {
  return { type: 'chunk', attemptId, revision: 0, index: 0, time: 0, chunk: body }
}

function textDelta(text, index) {
  return { type: 'text-delta', index: index || 0, text }
}

function blockStart(index, blockType) {
  return { type: 'block-start', index, blockType }
}

function blockEnd(index, block) {
  return { type: 'block-end', index, block }
}

function end(attemptId, kind, eventType) {
  const outcome = kind === 'abandoned' ? { kind: 'abandoned' } : { kind: 'committed', eventType: eventType || 'assistant/message', seq: 1 }
  return { type: 'end', attemptId, revision: 0, index: 0, outcome }
}

/** 把一串帧喂进去，收集全部动作 */
function drive(stream, frames) {
  const actions = []
  for (const frame of frames) actions.push(...stream.accept(frame))
  return actions
}

const kinds = (actions) => actions.map((action) => action.kind)

test('单步纯文本：正文等于全文，不产生旁白', () => {
  const stream = new ReplyStream()
  const actions = drive(stream, [
    start(0, 0),
    chunk('a0-0', textDelta('你好')),
    chunk('a0-0', textDelta('，世界')),
    end('a0-0'),
  ])
  assert.equal(stream.text(), '你好，世界')
  assert.equal(stream.finalText(), '你好，世界')
  assert.equal(kinds(actions).includes('narration'), false)
})

test('多步：上一步文本变旁白，正文只留末步', () => {
  const stream = new ReplyStream()
  const start1 = start(0, 0, 'att-1')
  const start2 = start(0, 1, 'att-2')
  const start3 = start(0, 2, 'att-3')
  const actions = drive(stream, [
    start1,
    chunk('att-1', textDelta('我先看一下文件')),
    end('att-1'),
    start2,
    chunk('att-2', textDelta('现在跑测试')),
    end('att-2'),
    start3,
    chunk('att-3', textDelta('改完了，结论是没问题')),
    end('att-3'),
  ])

  const narrations = actions.filter((action) => action.kind === 'narration').map((action) => action.text)
  assert.deepEqual(narrations, ['我先看一下文件', '现在跑测试'])
  assert.equal(stream.text(), '改完了，结论是没问题')
  assert.equal(stream.finalText(), '改完了，结论是没问题')
  // 切步刻意不发 reset：卡片上的旧文本要留到新一步真的开口为止，
  // 否则「工具正在跑」的几十秒里正文会变成一句占位
  assert.equal(actions.filter((action) => action.kind === 'reset').length, 0)
  assert.deepEqual(actions.filter((action) => action.kind === 'step').map((action) => action.step), [0, 1, 2])
})

test('同一步重试：reset 掉废弃 attempt 的文本', () => {
  const stream = new ReplyStream()
  drive(stream, [start(0, 0, 'att-1'), chunk('att-1', textDelta('半截废'), )])
  const actions = drive(stream, [start(0, 0, 'att-2', 1)])
  assert.deepEqual(kinds(actions), ['reset'])
  assert.equal(stream.text(), '')
  drive(stream, [chunk('att-2', textDelta('真正的回答')), end('att-2')])
  assert.equal(stream.text(), '真正的回答')
})

test('abandoned attempt：正文清空，且不留痕', () => {
  const stream = new ReplyStream()
  drive(stream, [start(0, 0, 'att-1'), chunk('att-1', textDelta('跑一半'))])
  const actions = drive(stream, [end('att-1', 'abandoned')])
  assert.deepEqual(kinds(actions), ['reset'])
  assert.equal(stream.text(), '')
  assert.equal(stream.finalText(), '')
})

test('两个 text 块之间自动空行，不粘成一段', () => {
  const stream = new ReplyStream()
  const actions = drive(stream, [
    start(0, 0, 'att-1'),
    chunk('att-1', blockStart(0, 'text')),
    chunk('att-1', textDelta('第一段', 0)),
    chunk('att-1', blockStart(1, 'text')),
    chunk('att-1', textDelta('第二段', 1)),
  ])
  assert.equal(stream.text(), '第一段\n\n第二段')
  assert.ok(actions.some((action) => action.kind === 'append' && action.text === '\n\n'))
})

test('block-end 用权威全文替换，纠正流式少字', () => {
  const stream = new ReplyStream()
  drive(stream, [start(0, 0, 'att-1'), chunk('att-1', textDelta('少了几个'))])
  const actions = drive(stream, [chunk('att-1', blockEnd(0, { type: 'text', text: '少了几个字的完整版' }))])
  const replace = actions.find((action) => action.kind === 'replace')
  assert.equal(replace.text, '少了几个字的完整版')
  assert.equal(stream.text(), '少了几个字的完整版')
})

test('陈旧 attempt 的 chunk 被忽略', () => {
  const stream = new ReplyStream()
  drive(stream, [start(0, 0, 'att-2', 1), chunk('att-2', textDelta('新'))])
  const actions = drive(stream, [chunk('att-1', textDelta('旧'))])
  assert.deepEqual(actions, [])
  assert.equal(stream.text(), '新')
})

test('reasoning 默认丢弃，开启后作为动作产出', () => {
  const off = new ReplyStream()
  const offActions = drive(off, [start(0, 0, 'att-1'), chunk('att-1', { type: 'reasoning-delta', index: 0, text: '想一想' })])
  assert.equal(kinds(offActions).includes('reasoning'), false)
  assert.equal(off.text(), '')

  const on = new ReplyStream({ showReasoning: true })
  const onActions = drive(on, [start(0, 0, 'att-1'), chunk('att-1', { type: 'reasoning-delta', index: 0, text: '想一想' })])
  assert.equal(kinds(onActions).includes('reasoning'), true)
  assert.equal(on.text(), '')
})

test('live 模式：切步不重置，正文继续累积；重试仍回收废弃文本', () => {
  const stream = new ReplyStream({ bodyMode: 'live' })
  const actions = drive(stream, [
    start(0, 0, 'att-1'),
    chunk('att-1', textDelta('第一段')),
    end('att-1'),
    start(0, 1, 'att-2'),
    chunk('att-2', textDelta('第二段')),
  ])
  assert.equal(kinds(actions).includes('reset'), false)
  assert.equal(kinds(actions).includes('narration'), false)
  assert.equal(stream.text(), '第一段第二段')

  drive(stream, [start(0, 1, 'att-3', 1), chunk('att-3', textDelta('重试后的第二段'))])
  assert.equal(stream.text(), '第一段重试后的第二段')
})

test('末步为空（只调工具 / 被中断）：finalText 回落到最后一个有文本的步骤', () => {
  const stream = new ReplyStream()
  drive(stream, [
    start(0, 0, 'att-1'),
    chunk('att-1', textDelta('先说一句')),
    end('att-1'),
    start(0, 1, 'att-2'),
    end('att-2', 'abandoned'),
  ])
  assert.equal(stream.text(), '')
  assert.equal(stream.finalText(), '先说一句')
})

test('buildText：只取 text 块，按序号排序，空块忽略', () => {
  const blocks = new Map([
    [2, { type: 'text', text: '  C  ' }],
    [0, { type: 'reasoning', text: '思考' }],
    [1, { type: 'text', text: 'A' }],
    [3, { type: 'text', text: '   ' }],
  ])
  assert.equal(buildText(blocks), 'A\n\nC')
  assert.equal(buildText(new Map()), '')
  assert.equal(buildText(undefined), '')
})

test('中途被废弃的 attempt：文本不进旁白，只留提交过的那一步', () => {
  const stream = new ReplyStream()
  const actions = drive(stream, [
    start(0, 0, 'att-1'),
    chunk('att-1', textDelta('这一步跑完了')),
    end('att-1'),
    // 第 1 步：吐了一段字之后被废弃（重试 / 中断），这段是废稿
    start(0, 1, 'att-2'),
    chunk('att-2', textDelta('半截废稿')),
    end('att-2', 'abandoned'),
    start(0, 1, 'att-3', 1),
    chunk('att-3', textDelta('重试后的第二步')),
    end('att-3'),
    start(0, 2, 'att-4'),
    chunk('att-4', textDelta('最终答案')),
  ])
  const narrations = actions.filter((action) => action.kind === 'narration').map((action) => action.text)
  // 两个 step 都已提交 → 各进一条旁白；被废弃的那段「半截废稿」永远不出现
  assert.deepEqual(narrations, ['这一步跑完了', '重试后的第二步'])
  assert.equal(narrations.some((text) => text.includes('半截废稿')), false)
  assert.equal(stream.text(), '最终答案')
})

test('旁白只发一次：同一步被重试时不会重复记', () => {
  const stream = new ReplyStream()
  const actions = drive(stream, [
    start(0, 0, 'att-1'),
    chunk('att-1', textDelta('第一版')),
    end('att-1'),
    start(0, 0, 'att-2', 1),
    chunk('att-2', textDelta('第二版')),
    end('att-2'),
    start(0, 1, 'att-3'),
  ])
  const narrations = actions.filter((action) => action.kind === 'narration').map((action) => action.text)
  assert.deepEqual(narrations, ['第二版'])
})
