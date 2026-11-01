/**
 * 连接状态端点：给浏览器半侧读「每台飞书机器人现在到底连上没有」。
 *
 * 为什么单独开一条 `/api/feishu.status`：配置存在 ≠ 连接成功。
 * 凭证错、被踢下线、网络抖动时配置都还在，但长连接根本没建立 ——
 * 界面上必须能看出区别，侧栏的绿灯也才有意义。
 *
 * 状态取值（宿主维护）：
 *   missing      缺凭证，没启动
 *   connecting   正在建连
 *   online       长连接就绪
 *   reconnecting 断线重连中
 *   error        建连失败（带 error 文案）
 *   stopped      已停止
 */

/**
 * @param {{ register(route: object): () => void }} webServer 宿主 webServer
 * @param {Map<string, { appId: string, name: string, state: string, error?: string, since?: number }>} statuses
 * @param {string} [path]
 * @returns {() => void} 注销路由
 */
export function registerStatusRoute(webServer, statuses, path = '/api/feishu.status') {
  return webServer.register({
    kind: 'exact',
    path,
    handler: async (req, res) => {
      const text = JSON.stringify({ bots: [...statuses.values()] })
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(text),
        'cache-control': 'no-store',
      })
      // HEAD 只要头
      res.end(req.method === 'HEAD' ? undefined : text)
    },
  })
}
