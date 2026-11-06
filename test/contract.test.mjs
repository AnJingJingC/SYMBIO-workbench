import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'
import { createApiRoutes, EXPECTED_ASSETS, API_PREFIX, VERSION, readJsonBody } from '../src/api.mjs'
import { readState } from '../src/state.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const patch = readFileSync(path.join(ROOT, 'cordis.patch.yml'), 'utf8')

test('包声明满足工作台规范四要件', () => {
  assert.equal(pkg.name, 'symbio-workbench')
  assert.equal(pkg.version, VERSION)
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.ok(pkg.dsh.client.inject.includes('dsh-desktop-workbenches'), 'inject 必须包含工作台服务')
  assert.ok(pkg.exports['.'], '缺服务端入口')
  assert.ok(pkg.exports['./client'], '缺客户端入口')
  // 上架市场前置：repository 须为合法 git URL（本地装仍被宿主派生成 local:* 身份，与字段无关）。
  assert.ok(
    pkg.repository && typeof pkg.repository === 'object' && /^https?:\/\//.test(pkg.repository.url || ''),
    '上架市场需填 repository（合法 git URL）',
  )
})

test('打进 tgz 的文件都真实存在', () => {
  for (const entry of ['dsh/index.mjs', 'src/api.mjs', 'src/state.mjs', 'lib/client.js', 'cordis.patch.yml', 'README.md', 'LICENSE']) {
    assert.ok(existsSync(path.join(ROOT, entry)), `缺文件：${entry}`)
    assert.ok(pkg.files.some(f => entry.startsWith(f.replace(/\/$/, ''))), `files 未覆盖：${entry}`)
  }
})

test('cordis.patch.yml 的 name 必须是 npm 包名，且声明真实业务根', () => {
  assert.match(patch, /name:\s*symbio-workbench/)
  assert.match(patch, /id:\s*symbio-workbench/)
  assert.match(patch, /dshHomePath\('symbio-workbench'\)/)
  assert.match(patch, /dataRoot:\s*'E:\/SYMBIO'/)
})

test('设计清单与 SYMBIO 的十技能六工具五层一致', () => {
  assert.equal(EXPECTED_ASSETS.skills.length, 10)
  assert.equal(EXPECTED_ASSETS.tools.length, 6)
  assert.equal(EXPECTED_ASSETS.layers.length, 5)
  assert.ok(EXPECTED_ASSETS.skills.includes('symbio-intake'))
  assert.ok(EXPECTED_ASSETS.tools.includes('load-gate'))
  assert.ok(EXPECTED_ASSETS.layers.includes('00-constitution'))
})

test('health 路由返回完整结构；桥不可用时如实报离线', async () => {
  const routes = createApiRoutes({ bridgeUrl: 'http://127.0.0.1:1', dataRoot: 'E:/SYMBIO' })
  const health = routes.find(r => r.path === `${API_PREFIX}/health`)
  assert.ok(health)
  assert.deepEqual(health.methods, ['GET'])
  const res = await health.fetch()
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.equal(body.workbench, 'SYMBIO')
  assert.equal(body.version, VERSION)
  assert.equal(body.identity, 'local:symbio-workbench')
  assert.equal(body.redLines.length, 5)
  assert.equal(body.bridge.online, false, '桥不通时绝不能报在线')
  assert.ok(body.bridge.reason, '应给出离线原因')
  assert.ok(body.dataSource && typeof body.dataSource.reachable === 'boolean')
})

test('所有路由都在自己的 /api/symbio/ 前缀下', () => {
  const paths = createApiRoutes({}).map(r => r.path)
  assert.deepEqual(paths, [
    `${API_PREFIX}/health`, `${API_PREFIX}/state`,
    `${API_PREFIX}/activity`, `${API_PREFIX}/load`,
    `${API_PREFIX}/bridge/health`,
    `${API_PREFIX}/bridge/login`, `${API_PREFIX}/bridge/hide`,
    `${API_PREFIX}/tools`, `${API_PREFIX}/tools/run`, `${API_PREFIX}/ask`, `${API_PREFIX}/intake`,
  ])
  for (const route of createApiRoutes({})) {
    assert.equal(typeof route.fetch, 'function')
    assert.ok(route.requestBody === 'buffered')
  }
})

// ---- 用临时 fixture 测解析器，不依赖真机 E:/SYMBIO ----

async function makeFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'symbio-fixture-'))
  const put = async (rel, content) => {
    const abs = path.join(root, rel)
    await mkdir(path.dirname(abs), { recursive: true })
    await writeFile(abs, content, 'utf8')
  }
  await put('config/symbio.config.json', JSON.stringify({
    stage: { current: 'A', modules: { intake: true } },
    limits: { cardMaxChars: 1200, sceneMemoryMaxKB: 25 },
    cost: { dailyBudgetCNY: 5 },
    paths: { defaultScene: 'knowledge-digest' },
    privacy: { egressAllowlist: [] },
  }))
  await put('memory/10-shared/任务看板.md', [
    '# 任务看板（只放未闭环任务）', '',
    '| 时间 | 来源 | 目标 | 任务 | 状态 | 需要回执 |',
    '|---|---|---|---|---|---|',
    '| 11-04 | 宿主 | 知识消化 | 消化一份字幕 | 进行中 | 要 |',
    '', '## 冲突与待裁决', '',
    '| 时间 | 事项 | 涉及场景 | 待宿主决定 |', '|---|---|---|---|',
    '| — | — | — | — |',
  ].join('\n'))
  await put('memory/20-scenes/knowledge-digest/当前交接.md', [
    '# 当前交接', '', '## 当前状态', '已有一张卡。', '',
    '## 下一步', '1. 继续投喂', '', '## 未决问题', '- 无',
  ].join('\n'))
  await put('memory/20-scenes/knowledge-digest/cards/索引.md', '# 卡片索引\n\n> 由 index-build 生成于 2026-11-04 15:00\n')
  await put('memory/20-scenes/knowledge-digest/cards/2026-11-04-a.md', '# 一张测试卡\n\n正文内容。\n')
  await put('memory/00-constitution/REDLINES.md', '# REDLINES\n\n## 一级红线\n')
  await put('memory/10-shared/花费台账.json', JSON.stringify({ version: 1, currency: 'CNY', days: {} }))
  for (const l of EXPECTED_ASSETS.layers) await mkdir(path.join(root, 'memory', l), { recursive: true })
  for (const s of EXPECTED_ASSETS.skills) await mkdir(path.join(root, '.dsh/skills', s), { recursive: true })
  for (const t of EXPECTED_ASSETS.tools) await put(`tools/${t}.mjs`, '// stub\n')
  return root
}

test('解析器：真实文件 → 真实数字，表格/卡片/资产都能对上', async () => {
  const root = await makeFixture()
  try {
    const s = await readState(root)
    assert.equal(s.ok, true, `不该有核心读取问题：${JSON.stringify(s.issues)}`)
    assert.equal(s.config.stage, 'A')
    assert.equal(s.config.cardMaxChars, 1200)
    assert.equal(s.queue.tasks.length, 1)
    assert.equal(s.queue.tasks[0].task, '消化一份字幕')
    assert.equal(s.queue.conflicts.length, 0, '纯占位行要被过滤掉')
    assert.equal(s.cards.total, 1)
    assert.equal(s.cards.items[0].title, '一张测试卡')
    assert.ok(s.cards.indexGeneratedAt?.startsWith('2026-11-04'))
    assert.equal(s.handoff.status, '已有一张卡。')
    assert.ok(s.handoff.next.includes('继续投喂'))
    assert.equal(s.assets.skills.length, 10)
    assert.equal(s.assets.tools.length, 6)
    assert.equal(s.memory.layers.length, 5)
    assert.ok(s.memory.totalFiles >= 5)
    assert.equal(s.privacyDoc.loaded, true)
    assert.equal(s.ledger.currency, 'CNY')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('解析器：数据源不可读时如实记 issues，绝不用预期清单冒充真实资产', async () => {
  const root = path.join(os.tmpdir(), `symbio-missing-${Date.now()}`)
  const s = await readState(root)
  assert.equal(s.ok, false)
  assert.ok(s.issues.length >= 5, '每个缺文件都要有原因')
  assert.equal(s.config, null)
  assert.equal(s.assets.skills, null, '不可读时必须是 null，不能填 10 个技能')
  assert.equal(s.assets.tools, null)
  assert.equal(s.cards.available, false)
  assert.equal(s.handoff, null)
  assert.ok(s.issues.every(i => i.path && i.reason))
})

test('state 路由把不可读状态原样交出去，不美化', async () => {
  const routes = createApiRoutes({ bridgeUrl: 'http://127.0.0.1:1', dataRoot: path.join(os.tmpdir(), `symbio-nope-${Date.now()}`) })
  const res = await routes.find(r => r.path === `${API_PREFIX}/state`).fetch()
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.state.ok, false)
  assert.equal(body.state.assets.skills, null)
  assert.equal(body.expectedAssets.skills.length, 10, '预期清单可以留着核对，但不能冒充实时值')
})

test('ask：空问题直接 400，不碰桥', async () => {
  const routes = createApiRoutes({ bridgeUrl: 'http://127.0.0.1:1' })
  const ask = routes.find(r => r.path === `${API_PREFIX}/ask`)
  const req = new Request('http://local/api/symbio/ask', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question: '   ' }),
  })
  const res = await ask.fetch(req)
  assert.equal(res.status, 400)
  const body = await res.json()
  assert.equal(body.errorType, 'bad-request')
  assert.match(body.message, /未发送任何内容/)
})

test('ask：桥不可达时 503 且明确说没发出去，绝不编造回答', async () => {
  const routes = createApiRoutes({ bridgeUrl: 'http://127.0.0.1:1' })
  const ask = routes.find(r => r.path === `${API_PREFIX}/ask`)
  const req = new Request('http://local/api/symbio/ask', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ site: 'doubao', question: '只回答四个字：挂载成功' }),
  })
  const res = await ask.fetch(req)
  assert.equal(res.status, 503)
  const body = await res.json()
  assert.equal(body.ok, false)
  assert.equal(body.errorType, 'bridge-unreachable')
  assert.equal(body.text, undefined, '失败时不允许有 text 字段')
  assert.match(body.message, /未发送任何内容|未拿到回答/)
})

test('readJsonBody 兼容标准 Request 与退化 reader', async () => {
  const a = await readJsonBody(new Request('http://x', { method: 'POST', body: '{"q":1}' }))
  assert.deepEqual(a, { q: 1 })
  const fake = { body: { getReader: () => ({ read: async () => ({ done: true }), releaseLock() {} }) } }
  await assert.rejects(() => readJsonBody(fake))
})

test('tool 清单：6 个工具，schema 齐全', async () => {
  const routes = createApiRoutes({ dataRoot: 'E:/SYMBIO' })
  const toolsRoute = routes.find(r => r.path === `${API_PREFIX}/tools`)
  assert.ok(toolsRoute)
  const res = await toolsRoute.fetch()
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.tools.length, 6)
  for (const t of body.tools) {
    assert.ok(t.name && t.title && t.desc, '每个工具要有 name/title/desc')
    assert.ok(['text', 'scene', 'dir', 'amount', 'none'].includes(t.input), `input 形态合法：${t.name}`)
    assert.ok(Array.isArray(t.flags))
  }
  const names = body.tools.map(t => t.name).sort()
  assert.deepEqual(names, ['index-build', 'load-gate', 'memory-lint', 'model-probe', 'pii-scan', 'spend-guard'])
})

test('tool 运行：白名单内工具以真实 node 跑通，输出原样返回', async () => {
  const root = await makeFixture()
  try {
    const routes = createApiRoutes({ dataRoot: root })
    const runRoute = routes.find(r => r.path === `${API_PREFIX}/tools/run`)
    const req = new Request('http://local/api/symbio/tools/run', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'model-probe', json: true }),
    })
    const res = await runRoute.fetch(req)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.ok, true)
    assert.equal(body.exitCode, 0, 'stub 工具应退出 0')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('tool 运行：未知工具 / 缺失文件 → 404 不执行', async () => {
  const routes = createApiRoutes({ dataRoot: path.join(os.tmpdir(), `symbio-nope-${Date.now()}`) })
  const runRoute = routes.find(r => r.path === `${API_PREFIX}/tools/run`)
  const req = new Request('http://local/api/symbio/tools/run', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'rm -rf /' }),
  })
  const res = await runRoute.fetch(req)
  assert.equal(res.status, 404, '越权名字必须被拒')
  const body = await res.json()
  assert.equal(body.errorType, 'unknown-tool')
})

test('intake 路由：body 空 → 400；有效 → 200 落卡；超限 → 422', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'symbio-intake-'))
  try {
    const put = async (rel, content) => {
      const abs = path.join(root, rel)
      await mkdir(path.dirname(abs), { recursive: true })
      await writeFile(abs, content, 'utf8')
    }
    await put('config/symbio.config.json', JSON.stringify({ limits: { cardMaxChars: 1200 }, paths: { defaultScene: 'knowledge-digest' }, privacy: { egressAllowlist: [] } }))
    await put('tools/intake.mjs', `
export async function runIntake({ root, title, source, body }) {
  if (!body || !body.trim()) return { ok: false, errorType: 'empty-body', message: '空' }
  if (body.length > 1200) return { ok: false, errorType: 'over-cap', message: '超限', chars: body.length, limit: 1200 }
  return { ok: true, cardFile: 'memory/20-scenes/knowledge-digest/cards/2026-11-04-x.md', chars: body.length, limit: 1200, scene: 'knowledge-digest', index: { ok: true, message: '已生成' } }
}
`)
    const route = createApiRoutes({ dataRoot: root }).find(r => r.path === `${API_PREFIX}/intake`)
    assert.ok(route, '应有 intake 路由')

    const emptyRes = await route.fetch(new Request('http://local/api/symbio/intake', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: '   ' }) }))
    assert.equal(emptyRes.status, 400)
    assert.equal((await emptyRes.json()).errorType, 'bad-request')

    const overRes = await route.fetch(new Request('http://local/api/symbio/intake', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 't', source: 's', body: 'x'.repeat(1300) }) }))
    assert.equal(overRes.status, 422)
    assert.equal((await overRes.json()).errorType, 'over-cap')

    const goodRes = await route.fetch(new Request('http://local/api/symbio/intake', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 't', source: 's', body: '# 标题\n正文 200 字以内' }) }))
    assert.equal(goodRes.status, 200)
    const goodBody = await goodRes.json()
    assert.equal(goodBody.ok, true)
    assert.ok(goodBody.cardFile)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('intake 路由：摄入模块缺失 → 503 如实报不可用（不编造落卡成功）', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), `symbio-intake-missing-${Date.now()}`))
  try {
    const route = createApiRoutes({ dataRoot: root }).find(r => r.path === `${API_PREFIX}/intake`)
    const res = await route.fetch(new Request('http://local/api/symbio/intake', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: '# 卡' }) }))
    assert.equal(res.status, 503)
    assert.equal((await res.json()).errorType, 'intake-unavailable')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('intake 路由：只传 text 不传 body → 422 提示先消化（intake 不负责 LLM 消化）', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), `symbio-intake-text-${Date.now()}`))
  try {
    const route = createApiRoutes({ dataRoot: root }).find(r => r.path === `${API_PREFIX}/intake`)
    const res = await route.fetch(new Request('http://local/api/symbio/intake', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '一段长文' }) }))
    assert.equal(res.status, 422)
    assert.equal((await res.json()).errorType, 'needs-digestion')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('真机数据源（若存在）：关键不变量仍成立', async () => {
  if (!existsSync('E:/SYMBIO/config/symbio.config.json')) return
  const s = await readState('E:/SYMBIO')
  assert.equal(s.ok, true, `真机数据源读取异常：${JSON.stringify(s.issues)}`)
  assert.equal(s.config.stage, 'A')
  assert.ok(s.assets.skills.length >= 11, '技能 ≥11（含 symbio-rollback）')
  assert.equal(s.assets.tools.length, 6)
  assert.equal(s.queue.tasks.length, 0, '看板当前应无未闭环任务')
  // 卡片数不设固定值：用户真的落了卡之后，硬编码 0 会让测试永久失败（2026-11-04 已踩）。
  // 断言改为「数据源真实」——total 必须等于卡片目录里的实际卡片数（不含索引），不许编造。
  const cardsDir = 'E:/SYMBIO/memory/20-scenes/knowledge-digest/cards'
  const cardsOnDisk = existsSync(cardsDir)
    ? readdirSync(cardsDir).filter((f) => f.endsWith('.md') && f !== '索引.md').length
    : 0
  assert.equal(s.cards.total, cardsOnDisk, '卡片数应与卡片目录实际文件数一致（数据源不得编造）')
  assert.ok(s.memory.totalFiles >= 22, '记忆文件 ≥22（含 deep-research 场景五件套）')
})

test('客户端源码不得在解构参数里遮蔽 React.createElement 的 h（回归：拓扑图致面板加载失败）', () => {
  const src = readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8')
  const bad = src.match(/\{[^{}]*\bh\s*,[^{}]*\}\s*=>/g) || []
  assert.deepEqual(bad, [], `以下解构参数把数字 h 传进了函数体，会遮蔽 React.createElement 的 h 导致面板渲染崩溃：${bad.join(' | ')}`)
})

test('客户端面板无头渲染冒烟（stub React 递归渲染整棵元素树）', () => {
  const src = readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8')
  const ReactStub = {
    // 函数组件立即递归调用，确保任何组件里的运行时错误都能在测试期暴露
    createElement: (type, props, ...kids) =>
      typeof type === 'function' ? type(props || {}) : { type, props, kids },
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useRef: (v) => ({ current: v }),
  }
  let mod = null
  let panel = null
  const windowStub = { __ModuleLoader__: { load: (m) => { mod = m } } }
  const documentStub = {
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({ dataset: {}, style: {}, textContent: '' }),
    head: { appendChild: () => {} },
  }
  const requireStub = (name) => {
    if (name === 'react') return ReactStub
    throw new Error(`客户端意外依赖 ${name}`)
  }
  new Function('window', 'document', 'require', src)(windowStub, documentStub, requireStub)
  assert.ok(mod && typeof mod.factory === 'function', 'client.js 应调用 __ModuleLoader__.load({ factory })')
  const evaluated = mod.factory(requireStub)
  assert.ok(evaluated && typeof evaluated.apply === 'function', 'factory 应求值出 { apply, inject }')
  evaluated.apply({
    effect: (fn) => fn(),
    desktopWorkbenches: { register: (_meta, Panel) => { panel = Panel; return () => {} } },
  })
  assert.equal(typeof panel, 'function', 'desktopWorkbenches.register 应收到面板组件')
  const tree = panel()
  assert.ok(tree && typeof tree === 'object', '面板应能无头渲染出完整元素树')
})

test('亮灯：心跳目录不存在是正常状态，不是故障', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'symbio-hb-empty-'))
  const s = await readState(root)
  assert.equal(s.activity.available, true, '磁盘上没有心跳目录 = 还没有活动，不该报"不可读"')
  assert.equal(s.activity.active.length, 0)
  assert.equal(s.activity.count, 0)
})

test('亮灯：过期的活动必须熄灭，不能假装还在干活', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'symbio-hb-ttl-'))
  await mkdir(path.join(root, 'memory/10-shared/心跳'), { recursive: true })
  const now = Date.now()
  const write = (scene, at, ttl) => writeFile(
    path.join(root, 'memory/10-shared/心跳', `${scene}.json`),
    JSON.stringify({ scene, phase: 'think', phaseLabel: '思考中', detail: 't', at: new Date(at).toISOString(), ttlMs: ttl }),
  )
  await write('fresh', now - 1000, 60000)
  await write('stale', now - 120000, 60000)

  const s = await readState(root)
  assert.equal(s.activity.active.length, 1, '只应剩未过期的那一个')
  assert.equal(s.activity.active[0].scene, 'fresh')
  assert.equal(s.activity.stale, 1, '过期数要如实统计')
  assert.ok(s.activity.active[0].remainMs > 0 && s.activity.active[0].remainMs <= 60000)
})

test('activity 路由：轻量轮询接口，字段齐全', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'symbio-act-'))
  const routes = createApiRoutes({ bridgeUrl: 'http://127.0.0.1:1', dataRoot: root })
  const res = await routes.find(r => r.path === `${API_PREFIX}/activity`).fetch()
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.deepEqual(Object.keys(body).sort(), ['active', 'available', 'checkedAt', 'ok', 'reason', 'stale', 'total'])
  assert.equal(body.ok, true)
  assert.ok(Array.isArray(body.active))
})

test('负载胶囊：工具缺失时如实报错，绝不编造一个"看起来正常"的 CPU 数字', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'symbio-load-miss-'))
  const routes = createApiRoutes({ bridgeUrl: 'http://127.0.0.1:1', dataRoot: root })
  const body = await (await routes.find(r => r.path === `${API_PREFIX}/load`).fetch()).json()
  assert.equal(body.ok, false)
  assert.equal(body.cpu, undefined, '失败时不许出现 cpu 字段')
  assert.equal(body.ram, undefined)
  assert.ok(body.errorType, '必须给出错误类型')
})

test('三层库：目录缺失时 available:false，不填 0 当"空库"', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'symbio-libs-'))
  const s = await readState(root)
  assert.equal(s.libraries.sharedSkills.available, false)
  assert.equal(s.libraries.parts.available, false)
  assert.equal(s.libraries.projects.available, false)
  assert.equal(s.libraries.parts.count, 0)
  assert.ok(s.libraries.parts.reason, '不可读必须带原因')
})

test('三层库：真机数据源（若存在）三库字段均可用', async () => {
  const real = 'E:/SYMBIO'
  const s = await readState(real)
  const libs = s.libraries
  for (const key of ['sharedSkills', 'parts', 'projects']) {
    assert.ok(libs[key], `${key} 必须存在`)
    assert.equal(typeof libs[key].count, 'number', `${key}.count 必须是数字`)
    assert.ok(Array.isArray(libs[key].items), `${key}.items 必须是数组`)
  }
  // 共享技能必须能区分"已提升"与"已装配"——这是它和普通技能目录的唯一价值
  if (libs.sharedSkills.available) {
    assert.equal(typeof libs.sharedSkills.installed, 'number')
    assert.ok(libs.sharedSkills.installed <= libs.sharedSkills.count, '已装配数不可能超过共享数')
  }
})

test('面板：亮灯与负载两个胶囊都在顶栏，且拓扑能接收活动信号', async () => {
  const { readFile } = await import('node:fs/promises')
  const src = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.ok(src.includes('LightCapsule'), '顶栏必须有亮灯胶囊')
  assert.ok(src.includes('LoadCapsule'), '顶栏必须有负载胶囊')
  assert.ok(src.includes('Libraries'), '必须有共享层·库区块')
  assert.ok(/h\(Topology, \{ activity \}\)/.test(src), '拓扑必须接收活动信号（否则亮灯亮不到拓扑上）')
  assert.ok(src.includes('/api/symbio/activity'), '亮灯必须接 /activity')
  assert.ok(src.includes('/api/symbio/load'), '负载胶囊必须接 /load')
})

// ── 三处宿主座位（2026-11-05 由座位探针 0.1.3 真机验证开放）─────────────
// 这组测试锁的是「接入形状」，不是「长得好看」。形状错了在真机上表现为
// register-threw / no-slots，而报告里只会说一句「不通」，很难回溯——所以锁在这里。

/** 用桩 React + 桩宿主上下文求值 client.js，返回注册过程的可观测结果。 */
function makeHarness({ slots = true, get = true } = {}) {
  const src = readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8')
  const ReactStub = {
    createElement: (type, props, ...kids) =>
      typeof type === 'function' ? type(props || {}) : { type, props, kids },
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useRef: (v) => ({ current: v }),
  }
  let mod = null
  const windowStub = { __ModuleLoader__: { load: (m) => { mod = m } } }
  const documentStub = {
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({ dataset: {}, style: {}, textContent: '' }),
    head: { appendChild: () => {} },
  }
  const requireStub = (name) => {
    if (name === 'react') return ReactStub
    throw new Error(`客户端意外依赖 ${name}`)
  }
  new Function('window', 'document', 'require', src)(windowStub, documentStub, requireStub)
  const api = mod.factory(requireStub)

  const calls = { inject: [], register: [], panels: [] }
  const slotsStub = {
    inject(name, cb) { calls.inject.push(name); cb(); return () => {} },
    register(opts, Comp) { calls.register.push({ opts, comp: Comp && Comp.name }); return () => {} },
  }
  const ctx = {
    effect: (fn) => fn(),
    desktopWorkbenches: {
      register: (_meta, Panel) => { calls.panels.push(Panel); return () => {} },
    },
  }
  if (get) ctx.get = (name) => (name === 'slots' && slots ? slotsStub : undefined)

  const dispose = api.apply(ctx)
  return { api, calls, slotsStub, dispose }
}

test('三处座位按官方契约注册：list 用 id、keyed 用 key、id 与 key 同名', () => {
  const { calls } = makeHarness()
  assert.deepEqual(calls.inject, ['shell.overlay', 'sidebar.panellist', 'main'],
    '三个座位都要先 inject 再 register（顺序即优先级）')

  const by = Object.fromEntries(calls.register.map((r) => [r.opts.name, r.opts]))
  assert.deepEqual(by['shell.overlay'], { name: 'shell.overlay', id: 'symbio-status', order: 900 })
  assert.ok(by['sidebar.panellist'] && by['sidebar.panellist'].id, 'list 座位必须有 id')
  assert.equal(by['sidebar.panellist'].id, by.main.key,
    'main 是 keyed、由侧栏 id 选择，两者必须同名 —— 否则点了入口出不来页')
  assert.ok(by.main && typeof by.main.key === 'string' && by.main.key.length > 0,
    'main 必须用 key，不能用 id')
  assert.equal(by.main.id, undefined, 'main 传 id 无效，只能传 key')
})

test('拿不到 slots 时只降级附加座位，业务面板照旧挂载', () => {
  const { calls } = makeHarness({ slots: false })
  assert.equal(calls.panels.length, 1, '业务面板必须照常注册')
  assert.deepEqual(calls.inject, [], '没有 slots 就不该硬试 inject')
  assert.deepEqual(calls.register, [], '没有 slots 就不该 register')
})

test('宿主不提供 ctx.get 时不得抛错（老宿主 / 门面缺失）', () => {
  const { calls } = makeHarness({ get: false })
  assert.equal(calls.panels.length, 1, '业务面板必须照常注册')
  assert.deepEqual(calls.inject, [])
})

test('单个座位 register 抛错不牵连其它座位与业务面板', () => {
  const src = readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8')
  // 只锁行为约定：每个座位各自 try/catch，不是一把 try 包三处
  assert.ok(/const seat = \(name, opts, Comp\) => \{\s*try/.test(src.replace(/\r/g, '')),
    '三个座位必须各走一次 try，一处失败不能吞掉其余两处')
  assert.ok(src.includes("console.warn(`[symbio] 座位 ${name} 注册失败"),
    '座位注册失败必须留痕，不能静默')
})

test('重复 apply 不重复注册（宿主会重放同一个客户端的 apply）', () => {
  const { api, calls } = makeHarness()
  const before = { ...calls, register: calls.register.length, panels: calls.panels.length }
  // 用一个全新的宿主上下文再 apply 一次，模拟宿主重放
  const calls2 = { inject: [], register: [], panels: [] }
  const slots2 = { inject(n, cb) { calls2.inject.push(n); cb(); return () => {} }, register(o, C) { calls2.register.push({ opts: o, comp: C && C.name }); return () => {} } }
  api.apply({
    effect: (fn) => fn(),
    desktopWorkbenches: { register: () => { calls2.panels.push(1); return () => {} } },
    get: () => slots2,
  })
  assert.equal(before.panels, 1)
  assert.equal(calls2.panels.length, 0, '第二次 apply 不得再注册业务面板（会抛 Duplicate）')
  assert.deepEqual(calls2.inject, [], '第二次 apply 不得再碰座位')
})

test('客户端绝不直接读 ctx.slots（Cordis Proxy 会抛 without inject）', () => {
  const src = readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8').replace(/\r/g, '')
  // 允许出现在注释里，但不允许出现在可执行代码里
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
  assert.ok(!/ctx\s*\.\s*slots/.test(code), '不得写 ctx.slots —— 未在 inject 声明时会抛错')
  assert.ok(/ctx\?\.get\('slots'\)|ctx\.get\('slots'\)/.test(code), '必须走门面的 ctx.get(\'slots\')')
})

test('常驻状态条不得拦截宿主点击（pointerEvents 恒为 none）', () => {
  const src = readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8')
  const block = src.slice(src.indexOf('function StatusBar()'), src.indexOf('function SceneEntry'))
  assert.ok(/pointerEvents:\s*'none'/.test(block), 'overlay 是全帧表面，状态条必须 pointer-events:none')
  assert.ok(!/onClick/.test(block), '状态条不可交互：一旦能点就会挡住宿主自己的按钮')
})

test('三个座位共用一口数据井，不各起一套定时器', () => {
  const src = readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8')
  assert.ok(src.includes('function createFeed()'), '必须有模块级共享数据源')
  assert.ok(src.includes('function useFeed()'), '组件通过 useFeed 订阅')
  // 三个座位组件里都应调用 useFeed，而不是各自 fetch
  for (const name of ['StatusBar', 'SceneEntry', 'OverviewPage']) {
    const i = src.indexOf(`function ${name}(`)
    assert.ok(i > 0, `缺组件 ${name}`)
    const body = src.slice(i, i + 1200)
    assert.ok(body.includes('useFeed()'), `${name} 必须走共享数据源`)
  }
  const intervals = (src.match(/setInterval\(/g) || []).length
  assert.equal(intervals, 3, `只该有 3 个 setInterval（state 30s / activity 5s / load 20s），实际 ${intervals}`)
})

// ── 三处座位的无头渲染：把「冷启动」与「有数据」两条路径都跑一遍 ──────────
// 组件在 factory 闭包里拿不到，所以测试期把内部符号挂出来（只改测试里的源码字符串，
// 生产文件不动）。feed 允许注入，才能喂真实形状的数据而不是只测空态。
function renderSeats(snapshot) {
  let src = readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8')
  src = src.replace('const feed = createFeed()', 'const feed = (globalThis.__SB_FEED || createFeed())')
  src = src.replace(
    'return { apply, inject: [\'desktopWorkbenches\'] }',
    'return { apply, inject: [\'desktopWorkbenches\'], __i: { StatusBar, SceneEntry, OverviewPage, ActivityCard, LoadCard, feed } }',
  )
  const ReactStub = {
    // 忠实一点：React 会把位置参数塞进 props.children，Card 这类组件就靠它取子节点。
    // 桩里不合并的话，`h(Card, {title}, body)` 会渲染出一张空卡片——那是桩的错，不是组件的错。
    createElement: (type, props, ...kids) => {
      const merged = { ...(props || {}), children: kids.length > 1 ? kids : kids[0] }
      return typeof type === 'function' ? type(merged) : { type, props: merged, kids }
    },
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useRef: (v) => ({ current: v }),
  }
  let mod = null
  const windowStub = { __ModuleLoader__: { load: (m) => { mod = m } } }
  const documentStub = {
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({ dataset: {}, style: {}, textContent: '' }),
    head: { appendChild: () => {} },
  }
  const requireStub = (name) => {
    if (name === 'react') return ReactStub
    throw new Error(`客户端意外依赖 ${name}`)
  }
  globalThis.__SB_FEED = {
    get: () => snapshot,
    subscribe: () => () => {},
    start: () => {}, stop: () => {}, refresh: async () => {},
  }
  try {
    new Function('window', 'document', 'require', src)(windowStub, documentStub, requireStub)
    return mod.factory(requireStub).__i
  } finally {
    delete globalThis.__SB_FEED
  }
}

/** 把元素树压成纯文本，用来断言"真的渲染出了这句人话"。 */
function textOf(node) {
  if (node == null || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  if (node.kids) return textOf(node.kids)
  return ''
}

const FULL_SNAPSHOT = {
  activity: { available: true, active: [{ scene: '知识消化', phaseLabel: '思考中', detail: '卡片 3/8', remainMs: 42000 }], total: 2, stale: 1 },
  load: { ok: true, exitCode: 0, cpu: 9.5, ram: 62.5, minOk: 70, minWarn: 85, samples: [8, 10, 9.5], time: '23:40:12', cached: false, ramUsedMB: 20480, ramTotalMB: 32768 },
  state: {
    state: {
      ok: true, root: 'E:/SYMBIO', checkedAt: '2026-11-06T15:40:00Z',
      issues: [{ path: 'cards', reason: 'ENOENT' }],
      config: { stage: 'A' },
      queue: { tasks: [{ time: '1', task: 'x', status: '待' }], conflicts: [] },
      handoff: { status: 's', next: 'n' },
      cards: { available: true, total: 3, items: [] },
      memory: { layers: [{ key: '00', label: '宪法', files: 2, bytes: 100 }], totalFiles: 2, totalBytes: 100 },
      libraries: {
        sharedSkills: { available: true, count: 1, installed: 1, items: [] },
        parts: { available: true, count: 6, items: [], byKind: { 脚本: 6 } },
        projects: { available: true, count: 1, items: [], byStatus: { 已交付: 1 } },
      },
      assets: { skills: ['a'], tools: ['b'] },
      privacyDoc: { loaded: true, chars: 10 },
      redLines: ['r1'],
    },
  },
  health: { version: '0.5.0', bridge: { online: true }, dataSource: { root: 'E:/SYMBIO' } },
  error: '', loading: false,
}

test('座位组件冷启动（全 null）不崩，且如实说"探测中/未采样"', () => {
  const { StatusBar, SceneEntry, OverviewPage } = renderSeats({
    health: null, state: null, activity: null, load: null, error: '', loading: true,
  })
  const bar = textOf(StatusBar())
  assert.match(bar, /探测中/, '亮灯没数据时应说探测中')
  assert.match(bar, /负载 —/, '负载没数据时应显示「负载 —」，不能编数字')
  assert.equal(textOf(SceneEntry({ size: 20 })).trim(), '', '侧栏图标只有图形，不该有可见文案')
  const page = textOf(OverviewPage())
  assert.match(page, /协同总览/)
  assert.match(page, /当前没有场景在干活|探测中/, '空态要说清没活干，而不是报错')
})

test('座位组件有数据时渲染出真实内容，且数字来自快照', () => {
  const { StatusBar, OverviewPage } = renderSeats(FULL_SNAPSHOT)
  const bar = textOf(StatusBar())
  assert.match(bar, /知识消化/, '常驻条应显示当前场景')
  assert.match(bar, /9\.5%/, '常驻条应显示真实 CPU 采样值')
  assert.match(bar, /可派单/, '常驻条应显示 load-gate 的判定，而不是自己算')
  assert.match(bar, /待办/, '常驻条应显示待闭环任务数')
  const page = textOf(OverviewPage())
  assert.match(page, /卡片 3\/8/, '总览页应显示活动明细')
  assert.match(page, /ENOENT/, '数据源问题必须如实列出')
  assert.match(page, /symbio-overview/, '页脚应标出自己占了哪个 key')
})

test('常驻状态条不使用任何可交互元素（overlay 不能挡住宿主）', () => {
  const { StatusBar } = renderSeats(FULL_SNAPSHOT)
  const walk = (n, hits = []) => {
    if (n == null || typeof n !== 'object') return hits
    if (Array.isArray(n)) { n.forEach((x) => walk(x, hits)); return hits }
    if (n.type === 'button' || n.type === 'a' || n.type === 'input') hits.push(n.type)
    if (n.props && (n.props.onClick || n.props.onMouseDown)) hits.push('handler')
    if (n.kids) walk(n.kids, hits)
    return hits
  }
  assert.deepEqual(walk(StatusBar()), [], '状态条里不许出现按钮/链接/点击回调')
})


