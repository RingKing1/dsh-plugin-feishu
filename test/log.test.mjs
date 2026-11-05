import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLog } from '../lib/log.js'

const tempDir = () => mkdtempSync(join(tmpdir(), 'feishu-log-'))

const read = (path) => readFileSync(path, 'utf8')

test('info / warn / error 无条件落盘，debug 默认不落盘（NFR-4）', () => {
  const dir = tempDir()
  const log = createLog(null, false, { dir })
  log.info('建卡成功', { cardId: 'c1' })
  log.warn('刷新失败', { cardId: 'c1' })
  log.debug('节流窗口', { ms: 700 })
  const text = read(join(dir, readdirSync(dir)[0]))
  assert.match(text, /INFO\s+feishu: 建卡成功 \{"cardId":"c1"\}/)
  assert.match(text, /WARN\s+feishu: 刷新失败/)
  assert.doesNotMatch(text, /节流窗口/)
})

test('debug 开关可随时切换：传函数即可即时生效', () => {
  const dir = tempDir()
  let enabled = false
  const log = createLog(null, () => enabled, { dir })
  log.debug('第一条')
  enabled = true
  log.debug('第二条')
  const text = read(join(dir, readdirSync(dir)[0]))
  assert.doesNotMatch(text, /第一条/)
  assert.match(text, /DEBUG feishu: 第二条/)
})

test('每行带时间戳与时区，可直接 grep 时间线', () => {
  const dir = tempDir()
  const log = createLog(null, true, { dir, now: () => new Date('2026-11-05T09:40:00.123Z') })
  log.info('启动')
  const text = read(log.file)
  assert.match(text, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2} INFO/)
})

test('scope：多机器人日志可分辨来源', () => {
  const dir = tempDir()
  const log = createLog(null, true, { dir })
  log.scope('运维机器人').info('已连接')
  const text = read(log.file)
  assert.match(text, /\[feishu:运维机器人\] 已连接/)
})

test('按天分文件：日期变了就换新文件', () => {
  const dir = tempDir()
  let clock = new Date('2026-11-05T10:00:00')
  const log = createLog(null, true, { dir, now: () => clock })
  log.info('今天')
  clock = new Date('2026-11-06T10:00:00')
  log.info('明天')
  const files = readdirSync(dir).sort()
  assert.equal(files.length, 2)
  assert.match(files[0], /feishu-2026-11-05\.log/)
  assert.match(files[1], /feishu-2026-11-06\.log/)
})

test('单文件超过上限时滚动，最多留 3 个历史文件', () => {
  const dir = tempDir()
  const log = createLog(null, true, { dir, maxBytes: 200 })
  for (let index = 0; index < 30; index += 1) log.info('第 ' + index + ' 行', { pad: 'x'.repeat(50) })
  const files = readdirSync(dir)
  const rotated = files.filter((name) => name.endsWith('.log.1'))
  assert.equal(rotated.length, 1, '滚动后应存在 .1 文件')
  assert.ok(files.length <= 5, '历史文件最多 3 个 + 当前文件，实际 ' + files.length)
})

test('落盘失败不抛错、不拖死主流程，并停用文件日志', () => {
  const blocker = join(tempDir(), 'not-a-dir')
  writeFileSync(blocker, 'x')
  const log = createLog(null, true, { dir: blocker })
  assert.doesNotThrow(() => log.info('仍然要能写'))
})

test('file=false 时不建目录也不落盘（单测与纯内存场景）', () => {
  const dir = join(tempDir(), 'nested', 'logs')
  const log = createLog(null, true, { dir, file: false })
  log.info('只在宿主日志里')
  assert.equal(log.file, '')
})
