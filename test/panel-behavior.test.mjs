// 0.5.6 新增两张面板卡（发送前检查 / 投递入站）· 点击行为测试。
//
// 与 handoff-behavior.test.mjs 同一套思路，但这里多做了一步：桩 React 支持**重渲染**。
// 原因：衔接菜单只需要验证 setState 序列；这两张卡的关键是"点完之后人看到什么"——
// 放行/拦下/闸坏了是否显示、入站结果是否列出来。只看 setState 证明不了这些。
//
// 不引 jsdom：用最小 state store + 每次操作后重跑组件函数，钩子按顺序取值。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function mount(expose, { fetchImpl, nav } = {}) {
  const src = readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8').replace(
    "return { apply, inject: ['desktopWorkbenches'] }",
    `return { apply, inject: ['desktopWorkbenches'], __i: { ${expose} } }`,
  )

  const state = []
  const calls = { fetch: [], clipboard: [] }
  let cursor = 0
  let effects = []
  let mod = null

  const ReactStub = {
    createElement: (type, props, ...kids) => {
      const merged = { ...(props || {}), children: kids.length > 1 ? kids : kids[0] }
      return typeof type === 'function' ? type(merged) : { type, props: merged, kids }
    },
    useState: (init) => {
      const i = cursor++
      if (!(i in state)) state[i] = typeof init === 'function' ? init() : init
      return [state[i], (v) => { state[i] = typeof v === 'function' ? v(state[i]) : v }]
    },
    useEffect: (fn) => { effects.push(fn) },
    useCallback: (fn) => fn,
    useRef: (v) => ({ current: v }),
  }

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
    const body = await fetchImpl(url, opts)
    return { json: async () => body, ok: true, status: 200 }
  }
  const navStub = nav || { clipboard: { writeText: async (t) => { calls.clipboard.push(t) } } }

  new Function('window', 'document', 'require', 'fetch', 'navigator', src)(
    { __ModuleLoader__: { load: (m) => { mod = m } } },
    documentStub, requireStub, fetchStub, navStub,
  )

  const comp = mod.factory(requireStub).__i?.[expose]
  assert.ok(typeof comp === 'function', `应能从闭包挂出 ${expose}`)

  const render = () => { cursor = 0; effects = []; return comp({}) }
  const flush = async () => {
    const queued = effects.slice()
    effects = []
    for (const fn of queued) await fn()
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
  }
  return { render, flush, calls }
}

const textOf = (n) => {
  if (n == null) return ''
  if (typeof n === 'string' || typeof n === 'number') return String(n)
  if (Array.isArray(n)) return n.map(textOf).join(' ')
  if (!n.props) return ''
  return textOf(n.props.children)
}

const findNode = (n, pred) => {
  if (n == null || typeof n !== 'object') return null
  if (Array.isArray(n)) {
    for (const x of n) { const hit = findNode(x, pred); if (hit) return hit }
    return null
  }
  if (pred(n)) return n
  return n.props ? findNode(n.props.children, pred) : null
}

const setText = (tree, value) => {
  const ta = findNode(tree, (n) => n.type === 'textarea' && n.props.onChange)
  if (!ta) throw new Error('没找到输入框')
  ta.props.onChange({ target: { value } })
}

const buttons = (n, out = []) => {
  if (n == null || typeof n !== 'object') return out
  if (Array.isArray(n)) { n.forEach((x) => buttons(x, out)); return out }
  if (n.type === 'button') out.push(n)
  if (n.props) buttons(n.props.children, out)
  return out
}

const findBtn = (tree, re) => buttons(tree).find((b) => re.test(textOf(b)))

// onClick 是 `() => void fn()`：handler 不返回 promise，所以不能直接 await。
// 这里点完让出几轮事件循环，等内部的 fetch → setState 都落地再重渲染。
const settle = async () => { for (let i = 0; i < 6; i += 1) await new Promise((r) => setImmediate(r)) }
const click = async (tree, re) => { findBtn(tree, re).props.onClick(); await settle() }

// ---------- 发送前检查 ----------

const outboundBody = (verdict) => (url) => {
  if (!url.includes('/outbound/check')) throw new Error(`意外请求 ${url}`)
  return {
    pass: { ok: true, verdict: 'pass', allowed: true, blocked: 0, warned: 0, matches: [], policy: '只检查，不代发。' },
    block: {
      ok: true, verdict: 'block', allowed: false, blocked: 1, warned: 0,
      matches: [{ id: 'refund-promise', level: 'L1', hit: '不满意随时退' }], policy: '只检查，不代发。',
    },
    broken: { ok: false, errorType: 'redline-unavailable', message: '工具文件不存在：redline-scan.mjs', allowed: false },
  }[verdict]
}

test('发送前检查：初始不带「发送」按钮，空文本时检查按钮不可点', () => {
  const { render } = mount('Outbound', { fetchImpl: outboundBody('pass') })
  const tree = render()
  const labels = buttons(tree).map((b) => textOf(b))
  assert.deepEqual(labels, ['检查这段话'], '这里只能检查，绝不能出现「发送」按钮')
  assert.equal(buttons(tree)[0].props.disabled, true, '空文本时不该允许检查')
  assert.match(textOf(tree), /只检查，不代发/)
})

test('发送前检查：放行 → 请求打到我方接口，显示放行并把原文进剪贴板的入口放出来', async () => {
  const { render, calls } = mount('Outbound', { fetchImpl: outboundBody('pass') })
  let tree = render()
  // 输入文本：直接调 onChange（受控组件）
  setText(tree, '明天的会议改到十点')
  tree = render()
  await click(tree, /检查这段话/)
  tree = render()

  assert.equal(calls.fetch.length, 1)
  assert.equal(calls.fetch[0].url, '/api/symbio/outbound/check')
  assert.equal(calls.fetch[0].opts.method, 'POST')
  assert.equal(JSON.parse(calls.fetch[0].opts.body).text, '明天的会议改到十点')
  assert.match(textOf(tree), /放行/)
  const copy = findBtn(tree, /复制文本/)
  assert.ok(copy, '放行后才给「复制文本」——复制不等于发送')
  copy.props.onClick()
  await Promise.resolve()
  assert.deepEqual(calls.clipboard, ['明天的会议改到十点'])
})

test('发送前检查：拦下 → 显示命中规则与原文片段，且不提供复制入口', async () => {
  const { render } = mount('Outbound', { fetchImpl: outboundBody('block') })
  let tree = render()
  setText(tree, '不满意随时退')
  tree = render()
  await click(tree, /检查这段话/)
  tree = render()

  const text = textOf(tree)
  assert.match(text, /拦下/)
  assert.match(text, /refund-promise/)
  assert.match(text, /不满意随时退/)
  assert.equal(findBtn(tree, /复制文本/), undefined, '被拦下时不该给一键复制')
})

test('发送前检查：闸坏了 → 显红字并明说按「先别发」处理，不显示成放行', async () => {
  const { render } = mount('Outbound', { fetchImpl: outboundBody('broken') })
  let tree = render()
  setText(tree, '随便一句话')
  tree = render()
  await click(tree, /检查这段话/)
  tree = render()

  const text = textOf(tree)
  assert.match(text, /redline-unavailable/)
  assert.match(text, /先别发/)
  assert.doesNotMatch(text, /放行/)
})

test('发送前检查：网络异常 → 显示请求失败，不崩、不谎称通过', async () => {
  const { render } = mount('Outbound', {
    fetchImpl: () => { throw new Error('网络断了') },
  })
  let tree = render()
  setText(tree, '随便')
  tree = render()
  await click(tree, /检查这段话/)
  tree = render()
  assert.match(textOf(tree), /请求失败：网络断了/)
})

// ---------- 投递入站 ----------

const inboundImpl = ({ pending = ['a.md'], scan = null } = {}) => (url) => {
  if (url.includes('/inbound/pending')) {
    return { ok: true, available: true, files: pending, archived: { routed: 2, unrouted: 1, blocked: 0 } }
  }
  if (url.includes('/inbound/scan')) {
    return scan || { ok: true, dry: false, routed: 1, warn: 0, results: [{ file: 'a.md', verdict: 'routed', scene: 'knowledge-digest' }] }
  }
  throw new Error(`意外请求 ${url}`)
}

test('投递入站：进页面就显示待处理件数与归档计数', async () => {
  const { render, flush } = mount('Inbound', { fetchImpl: inboundImpl({ pending: ['a.md', 'b.txt'] }) })
  render()
  await flush()
  const tree = render()
  const text = textOf(tree)
  assert.match(text, /待处理 2 件/)
  assert.match(text, /a\.md/)
  assert.match(text, /已归档：派单 2 · 未路由 1 · 被拦 0/)
  assert.match(text, /入站只负责/, '必须写明它不负责回复')
})

test('投递入站：扫描并派单 → 调 scan(dry:false)，列出结果，并刷新待处理数', async () => {
  let pendingCalls = 0
  const { render, flush, calls } = mount('Inbound', {
    fetchImpl: (url) => {
      if (url.includes('/inbound/pending')) {
        pendingCalls += 1
        return { ok: true, available: true, files: pendingCalls > 1 ? [] : ['a.md'], archived: { routed: 2, unrouted: 1, blocked: 0 } }
      }
      return { ok: true, dry: false, routed: 1, warn: 0, results: [{ file: 'a.md', verdict: 'routed', scene: 'knowledge-digest' }] }
    },
  })
  render()
  await flush()
  let tree = render()
  await click(tree, /扫描并派单/)
  tree = render()

  const scanCall = calls.fetch.find((c) => c.url.includes('/inbound/scan'))
  assert.equal(scanCall.opts.method, 'POST')
  assert.equal(JSON.parse(scanCall.opts.body).dry, false)
  assert.equal(pendingCalls, 2, '扫描后必须重新拉一次待处理清单')
  const text = textOf(tree)
  assert.match(text, /已处理：派单 1 · 需人看 0/)
  assert.match(text, /a\.md → routed（knowledge-digest）/)
  assert.match(text, /待处理 0 件/)
})

test('投递入站：只判定 → dry:true，且文案明说未移动文件、未派单', async () => {
  const { render, flush, calls } = mount('Inbound', {
    fetchImpl: () => ({}),
  })
  // 换一个实现：pending 正常，scan 回 dry 结果
  const second = mount('Inbound', { fetchImpl: inboundImpl({ scan: { ok: true, dry: true, routed: 1, warn: 0, results: [] } }) })
  second.render()
  await second.flush()
  let tree = second.render()
  await click(tree, /只判定不派单/)
  tree = second.render()

  const scanCall = second.calls.fetch.find((c) => c.url.includes('/inbound/scan'))
  assert.equal(JSON.parse(scanCall.opts.body).dry, true)
  assert.match(textOf(tree), /只判定（未移动文件、未派单）/)
  // 第一个 mount 只为确认无副作用时不崩
  assert.equal(calls.fetch.length, 0)
})

test('投递入站：目录不可读时如实说不可读，不显示成「0 件待处理」', async () => {
  const { render, flush } = mount('Inbound', {
    fetchImpl: () => ({ ok: true, available: false, reason: 'ENOENT', files: [], archived: null }),
  })
  render()
  await flush()
  const text = textOf(render())
  assert.match(text, /目录不可读/)
  assert.match(text, /ENOENT/)
  assert.doesNotMatch(text, /待处理 0 件/)
})

test('投递入站：扫描失败（工具缺失）→ 显示错误码与消息，不当成功', async () => {
  const { render, flush } = mount('Inbound', {
    fetchImpl: (url) => (url.includes('/inbound/pending')
      ? { ok: true, available: true, files: ['a.md'], archived: null }
      : { ok: false, errorType: 'inbound-unavailable', message: '工具文件不存在：inbound.mjs' }),
  })
  render()
  await flush()
  let tree = render()
  await click(tree, /扫描并派单/)
  tree = render()
  const text = textOf(tree)
  assert.match(text, /inbound-unavailable/)
  assert.match(text, /工具文件不存在：inbound\.mjs/)
  assert.doesNotMatch(text, /已处理：/)
})
