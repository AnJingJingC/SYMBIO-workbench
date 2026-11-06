// SYMBIO 工作台 · 服务端入口
// 只注册自己的 /api/symbio/* 路由，不占用宿主或其他插件的路径。
//
// 读写边界（对外别再说错）：
//   · 读接口（health / state / activity / load / tools）只读取业务根：不创建、不迁移、不复制目录树；
//   · 写只发生在用户显式动作上——/intake 落一张卡，/tools/run 跑工具（intake、index-build 会写盘）；
//   · 数据根不可读时如实回报并给出配置指引，不编造、不拿猜出来的路径去凑数字。

import Schema from '@deepseek-ai/schemastery'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApiRoutes, resolveDataRoot } from '../src/api.mjs'

export const name = 'symbio-workbench'
export const inject = ['connection']

export const Config = Schema.object({
  root: Schema.string().required().description('宿主分配的工作台数据目录。'),
  // 不设默认值：包不带数据，也就不该替用户决定盘符。留空走下面的探测链。
  dataRoot: Schema.string().description(
    'SYMBIO 业务数据根目录（该目录下应同时有 memory/ 与 tools/）。留空则按 SYMBIO_HOME → 包同位目录 → 历史默认依次探测。',
  ),
  bridgeUrl: Schema.string().default('http://127.0.0.1:31239').description('免费 AI 桥的回环地址。'),
})

export function apply(ctx, config) {
  // 优先级：环境变量 → 宿主配置 → 包同位目录（仓库布局）→ 历史默认（真存在才用）→ 未配置。
  // 换机器只需 SYMBIO_HOME，不用改包，也不会被写死的盘符带到别人机器上。
  // 用 import.meta.url 而不是 import.meta.dirname：宿主可能对插件做打包/转译，
  // url 是所有 ESM 运行时都认的最小公约数。
  const selfDir = path.dirname(fileURLToPath(import.meta.url))
  const { root, source } = resolveDataRoot({
    envRoot: process.env.SYMBIO_HOME,
    configRoot: config.dataRoot,
    selfDir,
  })
  for (const route of createApiRoutes({ bridgeUrl: config.bridgeUrl, dataRoot: root, dataRootSource: source, selfDir })) {
    ctx.connection.fetch.register(route)
  }
}
