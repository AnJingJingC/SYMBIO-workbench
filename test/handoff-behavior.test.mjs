// 会话衔接菜单 · 点击行为测试。
// contract.test.mjs 里的断言是字符串层（src.includes），只能证明"代码写了这句话"，
// 证明不了"点下去真的 fetch、真的写剪贴板、失败真的标 error"。这里用桩 React 把
// SessionHandoffMenuItem 从闭包里挂出来，注入 fetch/navigator 桩，跑真实 onClick，
// 断言四次分支的 setState 序列——不引入 jsdom，不改生产文件。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function loadHandoff({ ok = true, prompt = '【SYMBIO 会话衔接】新一轮对话请从这里续上：\n……', message = '', withClipboard = true, fetchThrows = false } = {}) {
  const src = readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8').replace(
    "return { apply, inject: ['desktopWorkbenches'] }",
    "return { apply, inject: ['desktopWorkbenches'], __i: { SessionHandoffMenuItem } }",
  )
  let stateIdx = 0
  const calls = { setState: [], fetch: [], clipboard: [] }
  const ReactStub = {
    createElement: (type, props, ...kids) => {
      const merged = { ...(props || {}), children: kids.length > 1 ? kids : kids[0] }
      return typeof type === 'function' ? type(merged) : { type, props: merged, kids }
    },
    useState: (init) => {
      const i = stateIdx++
      return [typeof init === 'function' ? init() : init, (nv) => calls.setState.push({ i, nv })]
    },
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
  const fetchStub = async (url, opts) => {
    calls.fetch.push({ url, opts })
    if (fetchThrows) throw new Error('网络断了')
    const body = ok ? { ok: true, prompt, chars: prompt.length, mode: 'semi-automatic' } : { ok: false, message }
    return { json: async () => body }
  }
  const navStub = withClipboard
    ? { clipboard: { writeText: async (t) => { calls.clipboard.push(t) } } }
    : {}
  new Function('window', 'document', 'require', 'fetch', 'navigator', src)(
    windowStub, documentStub, requireStub, fetchStub, navStub,
  )
  const comp = mod.factory(requireStub).__i?.SessionHandoffMenuItem
  assert.ok(typeof comp === 'function', '应能从闭包挂出 SessionHandoffMenuItem')
  return { btn: comp(), calls, stateIdx }
}

const phase = (calls, i) => calls.setState.filter((s) => s.i === i).map((s) => s.nv)
const msgs = (calls) => phase(calls, 1)

test('菜单项渲染成 role=menuitem 的 button，初始 idle，带可观测状态属性', () => {
  const { btn, stateIdx } = loadHandoff()
  assert.equal(btn.type, 'button')
  assert.equal(btn.props.role, 'menuitem')
  assert.equal(btn.props['data-symbio-handoff'], 'idle')
  assert.equal(typeof btn.props.onClick, 'function')
  assert.equal(stateIdx, 2, '组件应恰好用两个 useState（phase / msg）')
})

test('成功：点一次 → fetch 自建 API → 提示原文进剪贴板 → phase 走 busy→done，msg 报字数', async () => {
  const { btn, calls } = loadHandoff({ prompt: '【SYMBIO 会话衔接】…正文…' })
  await btn.props.onClick()
  assert.equal(calls.fetch.length, 1)
  assert.equal(calls.fetch[0].url, '/api/symbio/handoff/prepare')
  assert.equal(calls.fetch[0].opts.method, 'POST')
  assert.deepEqual(calls.clipboard, ['【SYMBIO 会话衔接】…正文…'], '剪贴板应拿到 API 返回的 prompt 原文')
  assert.deepEqual(phase(calls, 0), ['busy', 'done'], 'phase 必须先忙后成功')
  assert.match(msgs(calls).at(-1), /已复制 \d+ 字衔接提示.*手动新建对话并粘贴/)
})

test('API 报错：如实标 error，显示服务端 message，不碰剪贴板、不谎称成功', async () => {
  const { btn, calls } = loadHandoff({ ok: false, message: '读不到交接文件：ENOENT' })
  await btn.props.onClick()
  assert.deepEqual(calls.clipboard, [], 'API 失败时绝不能往剪贴板写东西')
  assert.deepEqual(phase(calls, 0), ['busy', 'error'])
  assert.ok(msgs(calls).includes('读不到交接文件：ENOENT'), '应把服务端错误如实显示')
  assert.ok(!msgs(calls).some((m) => /已复制/.test(m)), '失败路径不能出现"已复制"字样')
})

test('剪贴板不可用：接口成功但不谎称已复制，标 error 并提示查权限', async () => {
  const { btn, calls } = loadHandoff({ withClipboard: false })
  await btn.props.onClick()
  assert.equal(calls.fetch.length, 1, '接口仍应正常调用')
  assert.deepEqual(calls.clipboard, [])
  assert.deepEqual(phase(calls, 0), ['busy', 'error'])
  assert.match(msgs(calls).at(-1), /剪贴板不可用.*权限/)
})

test('网络异常：catch 到 fetch 抛错，标 error 并显示原因，不崩、不谎称成功', async () => {
  const { btn, calls } = loadHandoff({ fetchThrows: true })
  await btn.props.onClick()
  assert.deepEqual(phase(calls, 0), ['busy', 'error'])
  assert.match(msgs(calls).at(-1), /请求失败：网络断了/)
  assert.deepEqual(calls.clipboard, [])
})

test('防重复点击：busy 状态下再点不复发请求', async () => {
  // useState 桩首值给 'busy'，模拟上一次点击仍在进行中。
  const src = readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8').replace(
    "const [phase, setPhase] = React.useState('idle')",
    "const [phase, setPhase] = React.useState('busy')",
  ).replace(
    "return { apply, inject: ['desktopWorkbenches'] }",
    "return { apply, inject: ['desktopWorkbenches'], __i: { SessionHandoffMenuItem } }",
  )
  const calls = { fetch: [] }
  const ReactStub = {
    createElement: (t, p, ...k) => (typeof t === 'function' ? t(p) : { type: t, props: p, kids: k }),
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => {}, useCallback: (fn) => fn, useRef: (v) => ({ current: v }),
  }
  let mod = null
  const requireStub = (n) => (n === 'react' ? ReactStub : (() => { throw new Error(`意外依赖 ${n}`) })())
  new Function('window', 'document', 'require', 'fetch', 'navigator', src)(
    { __ModuleLoader__: { load: (m) => { mod = m } } },
    { querySelector: () => null, querySelectorAll: () => [], createElement: () => ({}), head: { appendChild: () => {} } },
    requireStub,
    async (url) => { calls.fetch.push(url); return { json: async () => ({ ok: true, prompt: 'x' }) } },
    {},
  )
  const btn = mod.factory(requireStub).__i.SessionHandoffMenuItem()
  await btn.props.onClick()
  assert.deepEqual(calls.fetch, [], 'busy 时点击应被忽略，不重复发请求')
})
