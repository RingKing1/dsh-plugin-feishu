import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ProgressTracker,
  clipOneLine,
  formatElapsed,
  formatProgressBlock,
  formatProgressLine,
  summarizeToolArgs,
  trimProgressToBytes,
} from '../lib/progress.js'

test('summarizeToolArgs 解析 JSON 并优先取 command', () => {
  assert.equal(summarizeToolArgs('{"command":"ls -la","description":"列目录"}'), 'ls -la')
  assert.equal(summarizeToolArgs({ path: '/tmp/a.txt', query: 'x' }), '/tmp/a.txt')
  // 没有优先字段时退回整段 JSON，至少让用户看到参数
  assert.equal(summarizeToolArgs({ foo: 'bar' }), '{"foo":"bar"}')
})

test('summarizeToolArgs 对非 JSON 与空值分别兜底', () => {
  assert.equal(summarizeToolArgs('直接是命令'), '直接是命令')
  assert.equal(summarizeToolArgs(''), '')
  assert.equal(summarizeToolArgs(undefined), '')
  assert.equal(summarizeToolArgs(42), '42')
})

test('clipOneLine 压成单行并保留首尾', () => {
  assert.equal(clipOneLine('a\n b\t c'), 'a b c')
  const long = 'a'.repeat(300)
  const clipped = clipOneLine(long)
  assert.equal(clipped.length, 200)
  assert.ok(clipped.includes('…'))
  assert.ok(clipped.startsWith('a'))
  assert.ok(clipped.endsWith('a'))
})

test('formatElapsed 在毫秒 / 秒 / 分三档都给可读结果', () => {
  assert.equal(formatElapsed(0), '0ms')
  assert.equal(formatElapsed(500), '500ms')
  assert.equal(formatElapsed(1500), '1.5s')
  assert.equal(formatElapsed(65000), '1m5s')
  assert.equal(formatElapsed(-1), '0ms')
  assert.equal(formatElapsed(Number.NaN), '0ms')
})

test('formatProgressLine 区分进行中、成功、失败与中断', () => {
  const base = { toolName: 'bash', detail: 'ls', startedAt: 1000 }
  assert.equal(formatProgressLine({ ...base }, 3000), '⏳ **bash** \u0060ls\u0060 · 已 2.0s')
  assert.equal(
    formatProgressLine({ ...base, endedAt: 1500, ok: true }, 3000),
    '✅ **bash** \u0060ls\u0060 · 500ms',
  )
  assert.equal(
    formatProgressLine({ ...base, endedAt: 1500, ok: false }, 3000),
    '❌ **bash** \u0060ls\u0060 · 500ms',
  )
  assert.equal(
    formatProgressLine({ ...base, endedAt: 1500, aborted: true }, 3000),
    '⛔ **bash** \u0060ls\u0060 · 500ms',
  )
})

test('ProgressTracker 记录调用与结果，重复 callId 不重复计数', () => {
  let now = 1000
  const tracker = new ProgressTracker({ now: () => now })
  assert.equal(tracker.trackCall({ callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' }), true)
  assert.equal(tracker.trackCall({ callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' }), false)
  now = 4000
  assert.equal(tracker.trackResult({ message: { callId: 'c1', isError: false } }), true)
  // 同一个结果事件重放不会把已完成的行改回进行中
  assert.equal(tracker.trackResult({ message: { callId: 'c1', isError: false } }), false)
  assert.equal(tracker.title(), '执行过程（已完成 1 步）')
  assert.ok(tracker.snapshot().markdown.includes('✅ **bash**'))
})

test('ProcessTracker 找不到对应调用时不凭空造条目', () => {
  const tracker = new ProgressTracker()
  assert.equal(tracker.trackResult({ message: { callId: 'ghost' } }), false)
  assert.equal(tracker.lineCount, 0)
})

test('abortAll 把未结束步骤标成中断', () => {
  const tracker = new ProgressTracker()
  tracker.trackCall({ callId: 'c1', name: 'bash', arguments: '{"command":"sleep 10"}' })
  tracker.abortAll()
  assert.equal(tracker.running, undefined)
  assert.ok(tracker.snapshot().markdown.includes('⛔'))
  assert.ok(tracker.title().includes('已中断'))
})

test('mode=off 不记录也不渲染', () => {
  const tracker = new ProgressTracker({ mode: 'off' })
  assert.equal(tracker.trackCall({ callId: 'c1', name: 'bash' }), false)
  assert.equal(tracker.snapshot().markdown, '')
  assert.equal(tracker.snapshot().title, '')
})

test('mode=action 只渲染当前这一步', () => {
  const tracker = new ProgressTracker({ mode: 'action', now: () => 5000 })
  tracker.trackCall({ callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' })
  tracker.trackCall({ callId: 'c2', name: 'bash', arguments: '{"command":"pwd"}' })
  tracker.trackResult({ message: { callId: 'c1', isError: false } })
  const markdown = tracker.render()
  assert.equal(markdown.split('\n').length, 1)
  assert.ok(markdown.includes('pwd'))
})

test('步骤过多时折叠中间，保留开头与结尾', () => {
  const tracker = new ProgressTracker({ maxLines: 5, now: () => 10000 })
  for (let index = 0; index < 10; index += 1) {
    tracker.trackCall({ callId: 'c' + index, name: 'bash', arguments: JSON.stringify({ command: 'cmd' + index }) })
  }
  const markdown = tracker.render()
  assert.ok(markdown.includes('已省略'))
  assert.ok(markdown.includes('cmd0'))
  assert.ok(markdown.includes('cmd9'))
})

test('formatProgressBlock 给每行加引用前缀', () => {
  assert.equal(formatProgressBlock('a\nb'), '> a\n> b')
  assert.equal(formatProgressBlock(''), '')
  assert.equal(formatProgressBlock('> 已有前缀'), '> 已有前缀')
})

test('trimProgressToBytes 从尾部保留并注明省略行数', () => {
  const markdown = ['line1-' + 'a'.repeat(20), 'line2-' + 'a'.repeat(20), 'line3-' + 'a'.repeat(20)].join('\n')
  const trimmed = trimProgressToBytes(markdown, 60)
  assert.ok(trimmed.startsWith('> … 前面'))
  assert.ok(trimmed.includes('line3'))
  assert.ok(!trimmed.includes('line1'))
  // 未超限时原样返回
  assert.equal(trimProgressToBytes('短内容', 100), '短内容')
})
