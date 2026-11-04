import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
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
    `${API_PREFIX}/health`, `${API_PREFIX}/state`, `${API_PREFIX}/bridge/health`,
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
  assert.equal(s.cards.total, 0, '卡片目录当前应为空')
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
