// SYMBIO 工作台 · 服务端入口
// 只注册自己的 /api/symbio/* 路由，不占用宿主或其他插件的路径。
// 只读业务根，不写、不迁移、不复制；数据源不可读时如实回报，不编造。

import Schema from '@deepseek-ai/schemastery'
import { createApiRoutes, DEFAULT_DATA_ROOT } from '../src/api.mjs'

export const name = 'symbio-workbench'
export const inject = ['connection']

export const Config = Schema.object({
  root: Schema.string().required().description('宿主分配的工作台数据目录。'),
  dataRoot: Schema.string().default(DEFAULT_DATA_ROOT).description('SYMBIO 业务数据根目录，只读。'),
  bridgeUrl: Schema.string().default('http://127.0.0.1:31239').description('免费 AI 桥的回环地址。'),
})

export function apply(ctx, config) {
  // 环境变量优先级最高：换机器时不用改包，只设 SYMBIO_HOME
  const dataRoot = process.env.SYMBIO_HOME || config.dataRoot || DEFAULT_DATA_ROOT
  for (const route of createApiRoutes({ bridgeUrl: config.bridgeUrl, dataRoot })) {
    ctx.connection.fetch.register(route)
  }
}
