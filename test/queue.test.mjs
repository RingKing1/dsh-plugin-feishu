import test from 'node:test'
import assert from 'node:assert/strict'
import { SerialQueue } from '../lib/queue.js'

test('同一会话严格串行执行', async () => {
  const queue = new SerialQueue()
  const order = []
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  const first = queue.run('a', async () => {
    order.push('first-start')
    await wait(20)
    order.push('first-end')
  })
  const second = queue.run('a', async () => {
    order.push('second-start')
  })
  await Promise.all([first, second])
  assert.deepEqual(order, ['first-start', 'first-end', 'second-start'])
})

test('前一个任务失败不阻塞后一个', async () => {
  const queue = new SerialQueue()
  const order = []
  const failing = queue.run('a', async () => {
    order.push('fail')
    throw new Error('boom')
  })
  const following = queue.run('a', async () => {
    order.push('ok')
  })

  await assert.rejects(failing, /boom/)
  await following
  assert.deepEqual(order, ['fail', 'ok'])
})

test('不同会话并行执行', async () => {
  const queue = new SerialQueue()
  const order = []
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  await Promise.all([
    queue.run('a', async () => {
      await wait(20)
      order.push('a')
    }),
    queue.run('b', async () => {
      order.push('b')
    }),
  ])
  assert.deepEqual(order, ['b', 'a'])
})

test('队列清空后回收条目', async () => {
  const queue = new SerialQueue()
  assert.equal(queue.size, 0)
  const finished = queue.run('a', async () => {})
  assert.equal(queue.size, 1)
  await finished
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(queue.size, 0)
})
