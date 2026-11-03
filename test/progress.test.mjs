import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ProgressTracker,
  clipOneLine,
  formatElapsed,
  formatProgressBlock,
  formatProgressLine,
  summarizeToolArgs,
  summarizeToolCall,
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

test('summarizeToolCall：ask_user_question 只留题数与首题题干，不展开 JSON', () => {
  const singleArgs = JSON.stringify({ questions: [{ id: 'q1', question: '用哪个方案？', options: [{ label: 'A' }, { label: 'B' }] }] })
  const single = summarizeToolCall('ask_user_question', singleArgs)
  assert.equal(single, '等待回答：用哪个方案？')
  assert.equal(single.includes('{'), false)

  const multi = summarizeToolCall('ask_user_question', {
    questions: [
      { id: 'q1', question: '第一个问题' },
      { id: 'q2', question: '第二个问题' },
    ],
  })
  assert.equal(multi, '等待回答（2 个问题）：第一个问题')

  // 标题太长时截断，仍不输出参数结构
  const long = summarizeToolCall('ask_user_question', { questions: [{ question: '长'.repeat(120) }] })
  assert.ok(long.length <= 90)
  assert.ok(long.endsWith('…'))

  // 其它工具仍走通用摘要
  assert.equal(summarizeToolCall('bash', '{"command":"ls -la"}'), 'ls -la')
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

test('旁白条目：单行化 + 200 字截断，渲染成 💬 旁白', () => {
  const now = 1000
  const tracker = new ProgressTracker({ now: () => now })
  assert.equal(tracker.trackNarration({ text: '我先看一下\n这个文件' }), true)
  assert.equal(tracker.entries.length, 1)
  assert.equal(tracker.entries[0].kind, 'narration')
  assert.equal(tracker.entries[0].detail, '我先看一下 这个文件')

  const line = formatProgressLine(tracker.entries[0], now)
  assert.ok(line.startsWith('💬 **旁白**'))
  assert.ok(line.includes('我先看一下 这个文件'))

  const long = new ProgressTracker({ now: () => now })
  long.trackNarration({ text: 'x'.repeat(400) })
  assert.ok(long.entries[0].detail.length <= 200)

  // 空旁白不造条目：过程面板不该出现空行
  assert.equal(tracker.trackNarration({ text: '   ' }), false)
})

test('旁白与思考在 off 模式下完全不记录', () => {
  const tracker = new ProgressTracker({ mode: 'off' })
  assert.equal(tracker.trackNarration({ text: '说话' }), false)
  assert.equal(tracker.trackReasoning({ text: '思考' }), false)
  assert.equal(tracker.entries.length, 0)
})

test('思考增量：同一步合并成一条，不逐字刷屏', () => {
  const now = 5000
  const tracker = new ProgressTracker({ now: () => now })
  assert.equal(tracker.trackReasoning({ text: '先想', step: 1 }), true)
  assert.equal(tracker.trackReasoning({ text: '一想', step: 1 }), true)
  assert.equal(tracker.entries.length, 1)
  const entry = tracker.entries[0]
  assert.equal(entry.kind, 'reasoning')
  assert.equal(entry.detail, '先想一想')
  assert.ok(formatProgressLine(entry, now).startsWith('🧠 **思考**'))

  // 换一步就是新条目
  tracker.trackReasoning({ text: '第二步的思考', step: 2 })
  assert.equal(tracker.entries.length, 2)
})

test('标题带「第 N 步」；步号未知时不加前缀', () => {
  const tracker = new ProgressTracker({ now: () => 0 })
  tracker.trackCall({ callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' })
  tracker.trackResult({ callId: 'c1', ok: true })
  assert.equal(tracker.noteStep(2), true)
  assert.equal(tracker.noteStep(2), false)
  assert.ok(tracker.title().startsWith('第 3 步 · 执行过程（'))

  const unknown = new ProgressTracker({ now: () => 0 })
  assert.equal(unknown.step, -1)
  unknown.trackCall({ callId: 'c1', name: 'bash', arguments: '{}' })
  assert.equal(unknown.title().startsWith('执行过程（'), true)
})

test('条目上限：超过 200 条只留最近的', () => {
  const tracker = new ProgressTracker({ now: () => 0 })
  for (let index = 0; index < 260; index += 1) tracker.trackNarration({ text: '旁白' + index })
  assert.equal(tracker.entries.length, 200)
  assert.equal(tracker.entries[tracker.entries.length - 1].detail, '旁白259')
})

test('tool/result 的 callId 落在 message.toolCallId 上，也要能结算', () => {
  // dsh 的 tool/result 载荷是 ToolMessage：只认 message.callId 会让所有行永远停在 ⏳
  const tracker = new ProgressTracker({ now: () => 0 })
  tracker.trackCall({ callId: 'call_1', name: 'bash', arguments: '{"command":"ls"}' })
  assert.equal(tracker.trackResult({ message: { role: 'tool', toolCallId: 'call_1', isError: false } }), true)
  assert.equal(tracker.entries[0].ok, true)
  assert.ok(tracker.render().startsWith('✅'), '结算后应渲染成 ✅，而不是 ⏳')
})
