// SYMBIO 工作台 · 客户端业务面板（单文件模块，无构建依赖）
//
// 设计基准：
//   · 业务面板在左 60%，右侧复用宿主原生会话；面板内所有列随可用宽度自动折叠。
//   · 所有数字来自 /api/symbio/state 的真实文件解析；读不到显示「—」+ 原因，绝不补假值。
//   · 空状态是真实状态，不是加载失败：第一张卡片还没产生时，给的是真实的下一步，不是示意数据。
//   · 「试问一句」会真的把文字发给网页端，所以外发提示必须常驻，且桥离线时不可点。

window.__ModuleLoader__.load({
  id: 'symbio-workbench',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const NS = 'symbio-workbench'

    const C = {
      card: 'rgba(127,145,190,0.07)', border: 'rgba(127,145,190,0.18)',
      text: 'var(--dsw-text-primary, #e8ecf8)', muted: 'var(--dsw-text-secondary, #98a4c4)',
      ok: '#3ddc97', warn: '#f0b45e', err: '#ff7a8a', dim: '#7b86a3', accent: '#8b9bff',
    }

    const CSS = `
[data-symbio-root],[data-symbio-root] *{box-sizing:border-box}
[data-symbio-root]{width:100%;height:100%;min-width:0;overflow-y:auto;padding:18px 20px 26px;color:${C.text};font-family:inherit;font-size:13px;line-height:1.6}
[data-symbio-root]::-webkit-scrollbar{width:8px}
[data-symbio-root]::-webkit-scrollbar-thumb{background:rgba(127,145,190,.24);border-radius:8px}
.sb-wrap{display:flex;flex-direction:column;gap:14px;min-width:0}
.sb-head{position:sticky;top:0;z-index:3;display:flex;align-items:center;gap:9px;flex-wrap:wrap;min-width:0;margin:-18px -20px 0;padding:18px 20px 12px;background:rgba(16,18,28,.82);backdrop-filter:blur(8px);border-bottom:1px solid ${C.border}}
.sb-title{margin:0;font-size:20px;font-weight:650;letter-spacing:.2px;white-space:nowrap}
.sb-sub{margin:0;color:${C.muted};font-size:12px}
.sb-badge{display:inline-flex;align-items:center;gap:5px;padding:2px 9px;border-radius:999px;border:1px solid ${C.border};background:${C.card};font-size:11px;color:${C.muted};white-space:nowrap}
.sb-spacer{flex:1 1 auto}
.sb-btn{padding:5px 12px;border-radius:8px;border:1px solid ${C.border};background:${C.card};color:${C.text};cursor:pointer;font-size:12px;font-family:inherit;transition:background .15s,border-color .15s}
.sb-btn:hover:not(:disabled){background:rgba(139,155,255,.16);border-color:rgba(139,155,255,.45)}
.sb-btn:disabled{opacity:.45;cursor:not-allowed}
.sb-btn-primary{background:rgba(139,155,255,.18);border-color:rgba(139,155,255,.5)}
.sb-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(158px,1fr));gap:12px;min-width:0}
.sb-main{display:grid;grid-template-columns:repeat(auto-fit,minmax(310px,1fr));gap:12px;min-width:0;align-items:start}
.sb-card{min-width:0;padding:14px 16px;border-radius:12px;border:1px solid ${C.border};background:${C.card}}
.sb-card-title{margin:0 0 10px;font-size:12px;font-weight:600;color:${C.muted};letter-spacing:.3px;display:flex;align-items:center;gap:7px}
.sb-big{font-size:26px;font-weight:650;line-height:1.15;letter-spacing:-.5px}
.sb-metric-label{color:${C.muted};font-size:11px;margin-top:4px}
.sb-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.sb-dot{width:8px;height:8px;border-radius:999px;flex:0 0 auto}
.sb-tag{display:inline-block;margin:0 5px 5px 0;padding:2px 7px;border-radius:6px;border:1px solid ${C.border};font-size:11px;color:${C.muted};overflow-wrap:anywhere}
.sb-code{padding:2px 6px;border-radius:5px;background:rgba(0,0,0,.24);font-size:11px;overflow-wrap:anywhere;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.sb-list{margin:0;padding-left:18px;color:${C.muted};font-size:12px}
.sb-list li{margin-bottom:3px}
.sb-empty{margin-top:10px;padding:12px 13px;border-radius:10px;border:1px dashed ${C.border};background:rgba(127,145,190,.04);color:${C.muted};font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere}
.sb-empty strong{color:${C.text};font-weight:600}
.sb-note{margin-top:8px;color:${C.dim};font-size:11px}
.sb-table{width:100%;border-collapse:collapse;font-size:12px;margin-top:4px;table-layout:fixed}
.sb-table th{text-align:left;color:${C.dim};font-weight:500;font-size:11px;padding:5px 6px;border-bottom:1px solid ${C.border}}
.sb-table td{padding:6px;border-bottom:1px solid rgba(127,145,190,.1);overflow-wrap:anywhere;vertical-align:top}
.sb-bar{height:6px;border-radius:999px;background:rgba(127,145,190,.14);overflow:hidden;margin-top:4px}
.sb-bar > i{display:block;height:100%;border-radius:999px;background:${C.accent}}
.sb-layer{display:grid;grid-template-columns:78px 1fr 62px;gap:8px;align-items:center;font-size:11px;margin-bottom:8px}
.sb-input{width:100%;min-width:0;padding:8px 10px;border-radius:8px;border:1px solid ${C.border};background:rgba(0,0,0,.2);color:${C.text};font-family:inherit;font-size:12px;resize:vertical}
.sb-input:focus{outline:none;border-color:rgba(139,155,255,.6)}
.sb-warn{padding:8px 10px;border-radius:8px;border:1px solid rgba(240,180,94,.35);background:rgba(240,180,94,.08);color:${C.warn};font-size:11px;line-height:1.5}
.sb-answer{margin-top:10px;padding:10px 12px;border-radius:9px;border:1px solid ${C.border};background:rgba(0,0,0,.18);font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:220px;overflow-y:auto}
.sb-foot{color:${C.dim};font-size:11px;border-top:1px solid ${C.border};padding-top:10px;display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.sb-sep{height:1px;background:${C.border};margin:10px 0}
.sb-pre{margin:10px 0 0;padding:10px 12px;border-radius:9px;border:1px solid ${C.border};background:rgba(0,0,0,.22);font-size:11.5px;line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere;max-height:260px;overflow-y:auto;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.sb-tools-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.sb-check{display:inline-flex;gap:5px;align-items:center;cursor:pointer;color:${C.muted};font-size:12px}
/* 负载胶囊：CPU / 内存两条细条，颜色跟判定走（绿=可派单 橙=停止派单 红=停重活） */
.sb-capsule{display:inline-flex;align-items:center;gap:6px;padding:2px 9px;border-radius:999px;border:1px solid ${C.border};background:${C.card};font-size:11px;color:${C.muted};white-space:nowrap}
.sb-capsule b{font-weight:600;color:${C.text};font-variant-numeric:tabular-nums}
.sb-meter{display:inline-block;width:32px;height:4px;border-radius:999px;background:rgba(127,145,190,.22);overflow:hidden;flex:0 0 auto}
.sb-meter>i{display:block;height:100%;border-radius:999px;transition:width .3s ease}
/* 亮灯：有场景在干活时呼吸，全空闲时静止（静止=真的没活，不是坏了） */
@keyframes sb-breathe{0%,100%{opacity:.35}50%{opacity:1}}
.sb-live{animation:sb-breathe 1.7s ease-in-out infinite}
.sb-lib{display:grid;grid-template-columns:repeat(auto-fit,minmax(196px,1fr));gap:10px;min-width:0}
.sb-lib-cell{min-width:0;padding:10px 11px;border-radius:10px;border:1px solid ${C.border};background:rgba(127,145,190,.05)}
.sb-lib-h{display:flex;align-items:baseline;gap:6px;margin-bottom:6px;font-size:11px;color:${C.dim}}
.sb-lib-v{font-size:17px;font-weight:650;letter-spacing:-.3px;color:${C.text}}
.sb-lib-v small{font-size:11px;font-weight:400;color:${C.muted};margin-left:4px}
.sb-lib-row{display:flex;align-items:center;gap:6px;font-size:11px;color:${C.muted};margin-top:4px;min-width:0}
.sb-lib-row span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* ── 常驻状态条（shell.overlay）：全帧表面，永不吃鼠标事件 ──
   覆盖率最高的座位，所以它必须"看得见但不碍事"：pointer-events 恒为 none，
   不设 hover、不设点击——状态条一旦能点，就会挡住宿主自己的按钮。 */
.sb-pill{display:inline-flex;align-items:center;gap:7px;padding:4px 10px;border-radius:999px;border:1px solid rgba(127,145,190,.22);background:rgba(16,18,28,.78);backdrop-filter:blur(6px);color:#98a4c4;font-size:11px;line-height:1.25;white-space:nowrap;font-variant-numeric:tabular-nums;box-shadow:0 3px 14px rgba(0,0,0,.3);max-width:100%;overflow:hidden}
.sb-pill b{color:#e8ecf8;font-weight:600}
.sb-pill>span{overflow:hidden;text-overflow:ellipsis}
.sb-pill .sb-sep-v{width:1px;height:10px;background:rgba(127,145,190,.28);flex:0 0 auto}
/* ── 协同总览页（main 座位）：整页，自带滚动 ──
   注意它渲染在 [data-symbio-root] 之外，基础字体/颜色得自己再声明一次。 */
[data-symbio-overview]{width:100%;height:100%;min-width:0;overflow-y:auto;padding:20px 24px 30px;color:var(--dsw-text-primary,#e8ecf8);font-family:inherit;font-size:13px;line-height:1.6;box-sizing:border-box}
[data-symbio-overview],[data-symbio-overview] *{box-sizing:border-box}
[data-symbio-overview]::-webkit-scrollbar{width:8px}
[data-symbio-overview]::-webkit-scrollbar-thumb{background:rgba(127,145,190,.24);border-radius:8px}
.sb-ov-wrap{display:flex;flex-direction:column;gap:14px;max-width:1180px;margin:0 auto;min-width:0}
.sb-ov-head{display:flex;align-items:center;gap:9px;flex-wrap:wrap;min-width:0}
.sb-ov-title{margin:0;font-size:20px;font-weight:650;letter-spacing:.2px;white-space:nowrap}
.sb-ov-cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:12px;align-items:start;min-width:0}
.sb-ov-row{display:flex;align-items:center;gap:8px;padding:7px 9px;border-radius:8px;border:1px solid rgba(127,145,190,.16);background:rgba(127,145,190,.05);font-size:12px;min-width:0}
.sb-ov-row+.sb-ov-row{margin-top:6px}
.sb-ov-k{color:#98a4c4;flex:0 0 auto}
.sb-ov-mid{color:#7b86a3;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sb-ov-v{margin-left:auto;color:#e8ecf8;font-variant-numeric:tabular-nums;flex:0 0 auto}
`

    function ensureStyles() {
      if (document.querySelector(`style[data-plugin="${NS}"]`)) return
      const style = document.createElement('style')
      style.dataset.plugin = NS
      style.textContent = CSS
      document.head.appendChild(style)
    }
    function removeStyles() {
      for (const el of document.querySelectorAll(`style[data-plugin="${NS}"]`)) el.remove()
    }

    const Dot = ({ on, color }) => h('span', { className: 'sb-dot', style: { background: on ? (color || C.ok) : C.dim } })
    const Card = ({ title, extra, children }) => h('section', { className: 'sb-card' },
      h('h3', { className: 'sb-card-title' }, title, extra || null), children)

    const fmtBytes = (n) => n == null ? '—' : n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`
    const fmtTime = (iso) => { try { return new Date(iso).toLocaleTimeString('zh-CN', { hour12: false }) } catch { return '—' } }
    const num = (v) => (v == null ? '—' : String(v))

    // 数据根是从哪来的——用户装完最常问的就是这句。没配置时不能装作"部分不可读"，
    // 那会让人去查文件权限；实际原因是根压根没指对。
    const ROOT_SOURCE_LABEL = {
      env: '环境变量 SYMBIO_HOME',
      config: '插件配置 dataRoot',
      sibling: '包同位目录',
      legacy: '历史默认路径',
      unset: '未配置',
    }
    const rootSourceText = (health) => {
      const ds = health?.dataSource
      if (!ds) return null
      return ROOT_SOURCE_LABEL[ds.source] || null
    }

    // ── 跨座位共享的数据源 ─────────────────────────────────────
    // 常驻状态条（shell.overlay）、协同总览（main）、业务面板（desktopWorkbenches）
    // 是三个独立挂载点。如果各自起定时器，同一份 /activity 会被每 5 秒拉三遍，
    // 亮灯数据本来就很轻，没必要这么打自己的服务端。收成一个模块级单例：
    // 谁挂载谁订阅，最后一个卸载时停表；刷新按钮叫 refresh()，三处一起更新。
    function createFeed() {
      const subs = new Set()
      let snap = { health: null, state: null, activity: null, load: null, error: '', loading: true }
      let seq = 0
      let timers = []
      let running = false

      const emit = () => { for (const fn of subs) { try { fn(snap) } catch { /* 单个订阅者崩了不拖累其它座位 */ } } }
      const patch = (next) => { snap = { ...snap, ...next }; emit() }

      const pullCore = async () => {
        const mine = ++seq
        patch({ loading: true, error: '' })
        try {
          const [a, b] = await Promise.all([
            fetch('/api/symbio/health', { cache: 'no-store' }),
            fetch('/api/symbio/state', { cache: 'no-store' }),
          ])
          if (!a.ok || !b.ok) throw new Error(`HTTP ${a.status}/${b.status}`)
          const [ha, st] = await Promise.all([a.json(), b.json()])
          if (mine !== seq) return
          patch({ health: ha, state: st })
        } catch (e) {
          if (mine !== seq) return
          patch({ error: e?.message ?? '读取失败', health: null, state: null })
        } finally {
          if (mine === seq) patch({ loading: false })
        }
      }

      // 亮灯 5s / 负载 20s：和原面板口径一致，不因为换座位而改采样频率。
      // 两者失败都静默——灯灭、负载「—」是真实状态，不该盖住主面板。
      const pullActivity = async () => {
        try {
          const r = await fetch('/api/symbio/activity', { cache: 'no-store' })
          if (!r.ok) return
          patch({ activity: await r.json() })
        } catch { /* 静默 */ }
      }
      const pullLoad = async () => {
        try {
          const r = await fetch('/api/symbio/load', { cache: 'no-store' })
          const b = await r.json().catch(() => null)
          patch({ load: b || { ok: false, message: `负载接口 ${r.status}` } })
        } catch (e) {
          patch({ load: { ok: false, message: e?.message ?? '负载接口不可达' } })
        }
      }

      return {
        get: () => snap,
        subscribe(fn) { subs.add(fn); return () => { subs.delete(fn) } },
        start() {
          if (running) return
          running = true
          void pullCore(); void pullActivity(); void pullLoad()
          timers = [
            setInterval(() => void pullCore(), 30000),
            setInterval(() => void pullActivity(), 5000),
            setInterval(() => void pullLoad(), 20000),
          ]
        },
        stop() {
          if (!running || subs.size > 0) return
          running = false
          for (const t of timers) clearInterval(t)
          timers = []
        },
        refresh: () => pullCore(),
      }
    }

    const feed = createFeed()

    /** 三个座位共用一口数据井；卸载时退订，最后一个走的负责停表。 */
    function useFeed() {
      const [snap, setSnap] = React.useState(feed.get())
      React.useEffect(() => {
        const off = feed.subscribe(setSnap)
        feed.start()
        setSnap(feed.get())
        return () => { off(); feed.stop() }
      }, [])
      return snap
    }

    function Metric({ label, value, unit, hint, color }) {
      return h(Card, { title: label },
        h('div', { className: 'sb-big', style: color ? { color } : null }, num(value), unit && h('span', { style: { fontSize: 12, fontWeight: 400, color: C.muted, marginLeft: 5 } }, unit)),
        h('div', { className: 'sb-metric-label' }, hint || '来自本机真实文件'))
    }

    // 负载胶囊：作者原话是「既给人看，也给 AI 用于自我限流」。
    // 给 AI 那一半在 tools/load-gate.mjs（autopilot 派单前已接），这里补「给人看」这一半。
    // 判定颜色只认退出码 0/10/20——口径只在负载闸里定义，面板不自己再算一遍。
    function LoadCapsule({ load }) {
      if (!load || load.ok === false) {
        return h('span', { className: 'sb-capsule', title: load?.message || '负载闸还没跑过（约 4.5s 采样一次）' },
          h(Dot, { on: false }), '负载 —')
      }
      const color = load.exitCode === 20 ? C.err : load.exitCode === 10 ? C.warn : C.ok
      const label = load.exitCode === 20 ? '停重活' : load.exitCode === 10 ? '停止派单' : '可派单'
      const ramText = load.ramUsedMB && load.ramTotalMB
        ? `（${(load.ramUsedMB / 1024).toFixed(1)} / ${(load.ramTotalMB / 1024).toFixed(0)} GB）`
        : ''
      const title = `CPU ${load.cpu}%（三次采样 ${(load.samples || []).join(' / ')}）\n内存 ${load.ram}%${ramText}\n判定：${label}（阈值 ${load.minOk}% / ${load.minWarn}%）\n采样于 ${load.time || '—'}${load.cached ? '（缓存）' : ''}`
      const meter = (v) => h('span', { className: 'sb-meter' }, h('i', { style: { width: `${Math.max(2, Math.min(100, Number(v) || 0))}%`, background: color } }))
      return h('span', { className: 'sb-capsule', title },
        h(Dot, { on: true, color }),
        h('span', null, 'CPU'), h('b', null, `${num(load.cpu)}%`), meter(load.cpu),
        h('span', null, '内存'), h('b', null, `${num(load.ram)}%`), meter(load.ram),
        h('span', { style: { color } }, label))
    }

    // 亮灯：谁被唤醒 / 谁在思考，就亮起来。
    // 数据源是 memory/10-shared/心跳/（一场景一文件，带 TTL），过期即灭——
    // 灯灭代表"现在没活干"，不是"监控坏了"。
    function LightCapsule({ activity }) {
      const active = activity?.active || []
      if (!activity) return h('span', { className: 'sb-badge' }, h(Dot, { on: false }), '亮灯 · 探测中')
      if (activity.available === false) {
        return h('span', { className: 'sb-badge', title: activity.reason || '心跳目录不可读' }, h(Dot, { on: false }), '亮灯 · 不可读')
      }
      if (!active.length) {
        return h('span', { className: 'sb-badge', title: '当前没有场景在干活。灯灭是正常状态，不是故障。' },
          h(Dot, { on: false }), '全场空闲')
      }
      const first = active[0]
      const tip = active.map((a) => `${a.scene} · ${a.phaseLabel}${a.detail ? ' · ' + a.detail : ''}（剩 ${Math.round(a.remainMs / 1000)}s）`).join('\n')
      return h('span', { className: 'sb-badge sb-live', title: tip },
        h(Dot, { on: true, color: C.accent }),
        `${active.length} 处活动 · ${first.scene} ${first.phaseLabel}`)
    }

    // 三层「库」：共享技能 / 零件库 / 项目台账。
    // 它们是 A 机制层补齐的三块底座，面板只做只读摘要——操作走 CLI 或宿主 Agent 技能
    // （多参数命令塞不进单输入框的工具箱，硬塞会变成"看得见点不动"）。
    function Libraries({ libs, activity }) {
      const ss = libs?.sharedSkills
      const pt = libs?.parts
      const pj = libs?.projects
      const active = activity?.active || []

      const cell = (title, value, unit, rows, hint) => h('div', { className: 'sb-lib-cell' },
        h('div', { className: 'sb-lib-h' }, title, hint && h('span', { style: { marginLeft: 'auto', color: C.dim, fontSize: 10 } }, hint)),
        h('div', { className: 'sb-lib-v' }, value == null ? '—' : value, unit && h('small', null, unit)),
        ...rows)

      const ssRows = (ss?.available === false)
        ? [h('div', { className: 'sb-lib-row' }, h('span', null, ss.reason || '目录不可读'))]
        : (ss?.items || []).slice(0, 3).map((it, i) => h('div', { key: i, className: 'sb-lib-row' },
            h(Dot, { on: it.installed, color: it.installed ? C.ok : C.warn }),
            h('span', { title: `${it.name}${it.from ? '（来自 ' + it.from + '）' : ''}` }, it.name),
            h('span', { style: { marginLeft: 'auto', color: it.installed ? C.ok : C.warn, fontSize: 10 } }, it.installed ? '已装配' : '未装配')))

      const ptRows = (pt?.available === false)
        ? [h('div', { className: 'sb-lib-row' }, h('span', null, pt.reason || '目录不可读'))]
        : Object.entries(pt?.byKind || {}).slice(0, 3).map(([k, v], i) => h('div', { key: i, className: 'sb-lib-row' },
            h('span', null, k), h('span', { style: { marginLeft: 'auto', color: C.text } }, `${v}`)))

      const pjRows = (pj?.available === false)
        ? [h('div', { className: 'sb-lib-row' }, h('span', null, pj.reason || '目录不可读'))]
        : Object.entries(pj?.byStatus || {}).slice(0, 3).map(([k, v], i) => h('div', { key: i, className: 'sb-lib-row' },
            h(Dot, { on: true, color: k === '已交付' ? C.ok : k === '待验收' ? C.warn : C.accent }),
            h('span', null, k), h('span', { style: { marginLeft: 'auto', color: C.text } }, `${v}`)))

      const actRows = active.length
        ? active.slice(0, 3).map((a, i) => h('div', { key: i, className: 'sb-lib-row' },
            h(Dot, { on: true, color: C.accent }),
            h('span', { title: a.detail }, `${a.scene} · ${a.phaseLabel}`),
            h('span', { style: { marginLeft: 'auto', color: C.dim, fontSize: 10 } }, `${Math.round(a.remainMs / 1000)}s`)))
        : [h('div', { className: 'sb-lib-row' }, h('span', null, '没有场景在活动'))]

      return h(Card, { title: '共享层 · 库', extra: h('span', { className: 'sb-badge' }, 'A 机制层') },
        h('div', { className: 'sb-lib' },
          cell('共享技能', ss?.available === false ? '—' : ss?.count, '个', ssRows, ss?.available === false ? '' : `已装配 ${ss?.installed ?? 0}`),
          cell('零件库', pt?.available === false ? '—' : pt?.count, '个', ptRows, pt?.available === false ? '' : `已验证 ${pt?.verified ?? 0}`),
          cell('项目台账', pj?.available === false ? '—' : pj?.count, '个', pjRows),
          cell('亮灯 · 活动心跳', active.length ? active.length : 0, '处', actRows, activity?.available === false ? '不可读' : '过期即灭')),
        h('div', { className: 'sb-note' },
          '共享技能 = 场景学会→登记→装配进 .dsh/skills；零件库 = 按需取一块；项目台账 = 客户交付建档。',
          '三者都是文件+CLI，AI 可读可写，不依赖宿主提供服务位。'))
    }

    function Queue({ queue, handoff }) {
      const tasks = queue?.tasks || []
      const conflicts = queue?.conflicts || []
      return h(Card, { title: '知识消化 · 工作流', extra: h('span', { className: 'sb-badge' }, `队列 ${tasks.length}`) },
        h('div', { className: 'sb-sub' }, '当前交接（原文，未改写）'),
        h('div', { className: 'sb-empty' }, handoff?.status || '交接文件不可读，原因见底部数据源诊断。'),

        h('div', { className: 'sb-sep' }),
        h('div', { className: 'sb-sub' }, '未闭环任务'),
        tasks.length
          ? h('table', { className: 'sb-table' },
              h('thead', null, h('tr', null, h('th', { style: { width: '22%' } }, '时间'), h('th', null, '任务'), h('th', { style: { width: '18%' } }, '状态'))),
              h('tbody', null, ...tasks.map((t, i) => h('tr', { key: i },
                h('td', null, t.time), h('td', null, t.task), h('td', null, t.status)))))
          : h('div', { className: 'sb-empty' }, '看板当前无未闭环任务。做完即删行，流水进 90-archive。'),

        conflicts.length > 0 && h('div', { className: 'sb-note', style: { color: C.warn } }, `另有 ${conflicts.length} 项待宿主裁决`),

        h('div', { className: 'sb-sep' }),
        h('div', { className: 'sb-sub' }, '下一步（来自交接文件）'),
        h('div', { className: 'sb-empty' }, handoff?.next || '—'))
    }

    function Cards({ cards, maxChars }) {
      const items = cards?.items || []
      return h(Card, { title: '知识卡片', extra: h('span', { className: 'sb-badge' }, `${num(cards?.available ? cards.total : null)} 张`) },
        items.length
          ? h('table', { className: 'sb-table' },
              h('thead', null, h('tr', null, h('th', null, '标题'), h('th', { style: { width: '78px' } }, '字数'))),
              h('tbody', null, ...items.map((c) => h('tr', { key: c.file },
                h('td', null, c.title), h('td', null, `${c.chars} / ${num(maxChars)}`)))))
          : h('div', { className: 'sb-empty' },
              h('strong', null, '还没有第一张知识卡片。'),
              '\n这是真实的空状态，不是加载失败。把链接 / 文件 / 字幕 / 长文本丢进右侧会话，说「消化它」，会走隐私扫描 → 生成 ≤' + num(maxChars) + ' 字卡片 → 更新索引。'),
        h('div', { className: 'sb-note' },
          cards?.indexGeneratedAt ? `索引由 index-build 生成于 ${cards.indexGeneratedAt}` : '卡片索引尚未生成或不可读'))
    }

    function Bridge({ bridge, onAsk, askState, question, setQuestion }) {
      const online = !!bridge?.online
      const busy = askState?.busy
      const res = askState?.result
      const [login, setLogin] = React.useState(null)

      const openLogin = async () => {
        if (!online || login?.loading) return
        setLogin({ loading: true, data: null, error: '' })
        try {
          const r = await fetch('/api/symbio/bridge/login', {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ site: 'doubao' }),
          })
          setLogin({ loading: false, data: await r.json(), error: '' })
        } catch (e) { setLogin({ loading: false, data: null, error: e?.message ?? '请求失败' }) }
      }
      const closeLogin = async () => {
        try {
          await fetch('/api/symbio/bridge/hide', {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ site: 'doubao' }),
          })
        } catch { /* 收回失败不影响其余 */ }
        setLogin({ loading: false, data: null, error: '' })
      }

      const loginData = login?.data
      const loginBadge = !loginData
        ? h('span', { className: 'sb-badge' }, '登录态未检测')
        : loginData.loginRequired
          ? h('span', { className: 'sb-badge', style: { color: C.warn } }, '需登录')
          : h('span', { className: 'sb-badge', style: { color: C.ok } }, '已登录')

      return h(Card, {
        title: '免费 AI 桥',
        extra: h('span', { style: { display: 'inline-flex', gap: 6, alignItems: 'center' } },
          h('span', { className: 'sb-badge' }, h(Dot, { on: online }), online ? '在线' : '离线'), loginBadge),
      },
        h('div', { className: 'sb-row' },
          h('span', { className: 'sb-sub' }, bridge?.url || 'http://127.0.0.1:31239'),
          h('span', { className: 'sb-spacer' }),
          h('span', { className: 'sb-sub' }, `站点 ${num(bridge?.sites?.length)}`)),
        bridge?.stats && h('div', { className: 'sb-note' },
          `已问 ${num(bridge.stats.asked)} · 成功 ${num(bridge.stats.ok)} · 失败 ${num(bridge.stats.failed)}`),

        !online && h('div', { className: 'sb-empty' },
          '伴生桥未启动，面板其余部分不受影响。\n启动：',
          h('div', { style: { marginTop: 5 } }, h('code', { className: 'sb-code' }, 'cd E:/SYMBIO/shell && npm run bridge'))),

        h('div', { className: 'sb-sep' }),
        h('div', { className: 'sb-row' },
          h('button', { className: 'sb-btn', disabled: !online || login?.loading, onClick: () => void openLogin() }, login?.loading ? '开窗中…' : '开登录窗'),
          loginData?.visible && h('button', { className: 'sb-btn', onClick: () => void closeLogin() }, '收回窗口')),
        loginData && h('div', { className: loginData.loginRequired ? 'sb-warn' : 'sb-note', style: loginData.loginRequired ? null : { color: C.ok } },
          loginData.message || (loginData.loginRequired ? '该站未登录。' : '该站已登录。')),
        loginData?.contract && h('div', { className: 'sb-note' }, loginData.contract),
        login?.error && h('div', { className: 'sb-warn' }, `登录窗请求失败：${login.error}`),

        h('div', { className: 'sb-sep' }),
        h('div', { className: 'sb-warn' }, '试问会把这段文字经伴生桥发给豆包网页端。机密闸会拦截手机号等敏感串，但请勿输入任何隐私内容。'),
        h('textarea', {
          className: 'sb-input', rows: 2, value: question,
          placeholder: '只回答四个字：挂载成功',
          onChange: (e) => setQuestion(e.target.value),
          disabled: !online || busy,
        }),
        h('div', { className: 'sb-row', style: { marginTop: 8 } },
          h('button', {
            className: 'sb-btn sb-btn-primary', disabled: !online || busy || !question.trim(),
            onClick: () => void onAsk(),
          }, busy ? '等待回答…' : '试问一句'),
          h('span', { className: 'sb-sub' }, busy ? '正在等网页端生成，最多 3 分钟' : (online ? '回答原样返回，不改写' : '桥离线时不可发送'))),

        res && h('div', { className: 'sb-answer', style: res.ok ? null : { borderColor: 'rgba(255,122,138,.4)' } },
          res.ok
            ? res.text
            : `未拿到回答 · ${res.errorType || 'unknown'}\n${res.message || ''}`))
    }

    function Memory({ memory }) {
      const layers = memory?.layers || []
      const max = Math.max(1, ...layers.map((l) => l.files || 0))
      return h(Card, { title: '六层记忆分布', extra: h('span', { className: 'sb-badge' }, `${num(memory?.totalFiles)} 文件 · ${fmtBytes(memory?.totalBytes)}`) },
        ...layers.map((l) => h('div', { key: l.key, className: 'sb-layer' },
          h('span', { style: { color: C.muted }, title: l.desc }, l.label),
          h('div', null, h('div', { className: 'sb-bar' }, h('i', { style: { width: `${Math.round(((l.files || 0) / max) * 100)}%` } }))),
          h('span', { style: { color: C.dim, textAlign: 'right' } }, `${l.files} 文件`))),
        h('div', { className: 'sb-note' }, '层内文件只读统计；面板不写入、不迁移任何记忆。'))
    }

    function Assets({ assets, expected }) {
      const skills = assets?.skills
      const tools = assets?.tools
      return h(Card, { title: '已挂载资产' },
        h('div', { className: 'sb-sub' }, `技能 ${num(skills?.length)} · 工具 ${num(tools?.length)}`),
        h('div', { style: { marginTop: 8 } },
          skills
            ? skills.map((n) => h('span', { key: n, className: 'sb-tag' }, n))
            : h('span', { className: 'sb-sub' }, '—（数据源不可读，不显示预期值）')),
        h('div', { className: 'sb-sep' }),
        h('div', { className: 'sb-sub' }, '本机工具'),
        h('div', { style: { marginTop: 8 } },
          tools
            ? tools.map((n) => h('span', { key: n, className: 'sb-tag' }, n))
            : h('span', { className: 'sb-sub' }, '—')),
        h('div', { className: 'sb-note' }, `设计清单 ${expected?.skills?.length ?? '—'} 技能 / ${expected?.tools?.length ?? '—'} 工具，用于核对是否齐全；此处显示的是真实扫描结果。`))
    }

    function RedLines({ lines, privacy }) {
      return h(Card, { title: '五条红线', extra: privacy?.loaded ? h('span', { className: 'sb-badge' }, `宪法已落盘 ${privacy.chars} 字`) : h('span', { className: 'sb-badge', style: { color: C.warn } }, '宪法文件不可读') },
        h('ul', { className: 'sb-list' }, ...(lines || []).map((line, i) => h('li', { key: i }, line))),
        h('div', { className: 'sb-note' }, '与 AGENTS.md / REDLINES.md 一致；L0 宪法只有宿主能改。'))
    }

    function ToolResult({ out }) {
      if (!out) return null
      const code = out.exitCode
      const color = out.ok === false ? C.err : (code === 0 ? C.ok : C.warn)
      const label = out.ok === false ? '调用失败' : (code === 0 ? '退出 0 · 正常' : `退出 ${code}`)
      const text = (out.stdout || '') + (out.stderr ? `\n--- stderr ---\n${out.stderr}` : '')
      return h('div', null,
        h('div', { className: 'sb-tools-row', style: { marginTop: 10 } },
          h('span', { className: 'sb-badge', style: { color } }, label),
          out.timedOut && h('span', { className: 'sb-badge', style: { color: C.warn } }, '超时'),
          out.errorType && h('span', { className: 'sb-badge', style: { color: C.err } }, out.errorType)),
        h('pre', { className: 'sb-pre' }, text.trim() || '（无输出，但已正常退出）'))
    }

    function Tools() {
      const [list, setList] = React.useState(null)
      const [sel, setSel] = React.useState('')
      const [input, setInput] = React.useState('')
      const [json, setJson] = React.useState(true)
      const [redact, setRedact] = React.useState(false)
      const [chain, setChain] = React.useState(false)
      const [running, setRunning] = React.useState(false)
      const [out, setOut] = React.useState(null)
      const [err, setErr] = React.useState('')

      React.useEffect(() => {
        void (async () => {
          try {
            const r = await fetch('/api/symbio/tools', { cache: 'no-store' })
            if (r.ok) { const b = await r.json(); setList(b.tools); if (b.tools?.length) setSel(b.tools[0].name) }
            else setErr(`清单接口 ${r.status}`)
          } catch (e) { setErr('工具清单拉取失败：' + (e?.message ?? '')) }
        })()
      }, [])

      const onSelect = (name) => { setSel(name); setInput(''); setOut(null) }
      const tool = list?.find(t => t.name === sel) || null

      const run = async () => {
        if (!sel || running) return
        setRunning(true); setOut(null); setErr('')
        try {
          const res = await fetch('/api/symbio/tools/run', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              name: sel,
              input: input || undefined,
              json: tool?.jsonCapable ? json : undefined,
              redact: tool?.flags?.includes('redact') ? redact : undefined,
              chain: tool?.flags?.includes('chain') ? chain : undefined,
            }),
          })
          setOut(await res.json())
        } catch (e) {
          setOut({ ok: false, errorType: 'request-failed', message: e?.message ?? '请求失败' })
        } finally { setRunning(false) }
      }

      return h(Card, { title: '工具箱', extra: h('span', { className: 'sb-badge' }, `${list?.length ?? 0} 个本机工具`) },
        h('div', { className: 'sb-sub' }, '直接驱动 E:/SYMBIO/tools 下的脚本（服务端执行，无 shell，白名单受限）。'),
        list == null
          ? h('div', { className: 'sb-empty' }, err || '工具清单加载中…')
          : h('div', null,
            h('select', { className: 'sb-input', style: { marginBottom: 8 }, value: sel, onChange: (e) => onSelect(e.target.value) },
              ...list.map(t => h('option', { key: t.name, value: t.name }, t.title))),
            tool && h('div', { className: 'sb-note', style: { marginBottom: 6 } }, tool.desc),
            tool && h('div', { className: 'sb-note', style: { marginBottom: 8, color: C.dim } }, tool.hint),
            tool?.input === 'text' && h('textarea', {
              className: 'sb-input', rows: 3, value: input, placeholder: '贴入待检文本…',
              onChange: (e) => setInput(e.target.value),
            }),
            (tool?.input === 'scene' || tool?.input === 'dir' || tool?.input === 'amount') &&
              h('input', {
                className: 'sb-input', style: { marginTop: 6 }, value: input,
                placeholder: tool.input === 'amount' ? '数额，如 0.12（留空=只读判定）'
                  : tool.input === 'scene' ? '场景名（留空=全部）' : '目录，相对 dataRoot（留空=默认）',
                inputMode: tool.input === 'amount' ? 'decimal' : undefined,
                onChange: (e) => setInput(e.target.value),
              }),
            h('div', { className: 'sb-tools-row', style: { marginTop: 10 } },
              h('button', { className: 'sb-btn sb-btn-primary', disabled: !sel || running, onClick: () => void run() }, running ? '运行中…' : '运行'),
              tool?.jsonCapable && h('label', { className: 'sb-check' },
                h('input', { type: 'checkbox', checked: json, onChange: (e) => setJson(e.target.checked) }), '--json'),
              tool?.flags?.includes('redact') && h('label', { className: 'sb-check' },
                h('input', { type: 'checkbox', checked: redact, onChange: (e) => setRedact(e.target.checked) }), '--redact'),
              tool?.flags?.includes('chain') && h('label', { className: 'sb-check' },
                h('input', { type: 'checkbox', checked: chain, onChange: (e) => setChain(e.target.checked) }), '--chain')),
            h(ToolResult, { out })))
    }

    function Intake({ onIngested }) {
      const [title, setTitle] = React.useState('')
      const [source, setSource] = React.useState('')
      const [body, setBody] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [res, setRes] = React.useState(null)
      const [err, setErr] = React.useState('')

      const submit = async () => {
        if (!body.trim() || busy) return
        setBusy(true); setRes(null); setErr('')
        try {
          const r = await fetch('/api/symbio/intake', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ title: title.trim(), source: source.trim(), body }),
          })
          const b = await r.json()
          setRes({ status: r.status, body: b })
          if (b.ok && typeof onIngested === 'function') setTimeout(() => onIngested(), 700)
        } catch (e) {
          setErr(e?.message ?? '请求失败')
        } finally { setBusy(false) }
      }

      return h(Card, { title: '摄入长文 · 落卡', extra: h('span', { className: 'sb-badge' }, '确定性落卡') },
        h('div', { className: 'sb-sub' }, '把宿主技能 symbio-intake 或免费 AI 桥消化好的卡片正文粘进来，点「落卡」即写入 cards/ 并通过隐私闸(L1 硬拦)+字数闸后重建索引。'),
        h('input', { className: 'sb-input', style: { marginTop: 8 }, placeholder: '标题', value: title, onChange: (e) => setTitle(e.target.value) }),
        h('input', { className: 'sb-input', style: { marginTop: 6 }, placeholder: '来源（链接 / 文件路径）', value: source, onChange: (e) => setSource(e.target.value) }),
        h('textarea', {
          className: 'sb-input', rows: 6, style: { marginTop: 6 },
          placeholder: '# 标题\n- 来源：…\n- 摄入时间：…\n- 密级：L0 公开\n- 主题标签：#…\n\n## 一句话结论\n…\n\n## 要点\n1. …',
          value: body, onChange: (e) => setBody(e.target.value),
        }),
        h('div', { className: 'sb-tools-row', style: { marginTop: 10 } },
          h('button', { className: 'sb-btn sb-btn-primary', disabled: !body.trim() || busy, onClick: () => void submit() }, busy ? '落卡中…' : '落卡'),
          h('span', { className: 'sb-sub' }, busy ? '隐私闸 + 字数闸校验中' : '落卡后自动出现在上方「知识卡片」')),
        res && h('div', { className: res.body.ok ? 'sb-answer' : 'sb-warn', style: res.body.ok ? null : { borderColor: 'rgba(255,122,138,.4)' } },
          res.body.ok
            ? `已落卡：${res.body.cardFile}\n字数 ${res.body.chars} / ${res.body.limit}\n索引：${res.body.index?.ok ? '已重建' : '未重建（' + (res.body.index?.reason || '') + '）'}`
            : `未落卡 · ${res.body.errorType || ''}\n${res.body.message || ''}`),
        err && h('div', { className: 'sb-warn' }, `请求失败：${err}`))
    }

    function Topology({ activity }) {
      const active = activity?.active || []
      const has = (fn) => active.some(fn)
      // 节点到活动的映射：只映射能对应到工序的阶段，映射不上就不亮（宁可不亮，也不乱亮）
      const live = {
        intake: has((a) => a.scene === 'knowledge-digest' && a.phase === 'intake'),
        card: has((a) => a.scene === 'knowledge-digest' && a.phase === 'card'),
        think: has((a) => a.phase === 'think'),
        dispatch: has((a) => a.phase === 'dispatch' || a.phase === 'receipt'),
      }

      const Node = ({ x, y, w, ht, label, sub, on }) => h('g', null,
        on && h('rect', {
          x: x - 2.5, y: y - 2.5, width: w + 5, height: ht + 5, rx: 10.5,
          fill: 'none', stroke: 'rgba(139,155,255,.5)', 'stroke-width': 1.4, className: 'sb-live',
        }),
        h('rect', {
          x, y, width: w, height: ht, rx: 8,
          fill: on ? 'rgba(139,155,255,.20)' : 'rgba(127,145,190,.10)',
          stroke: on ? 'rgba(139,155,255,.8)' : C.border,
        }),
        h('text', { x: x + w / 2, y: y + ht / 2 - 2, 'text-anchor': 'middle', fill: C.text, 'font-size': 11, 'font-weight': 600 }, label),
        sub && h('text', { x: x + w / 2, y: y + ht / 2 + 12, 'text-anchor': 'middle', fill: C.muted, 'font-size': 9 }, sub),
        on && h('circle', { cx: x + w - 7, cy: y + 7, r: 3.2, fill: C.accent, className: 'sb-live' }))

      const Arrow = ({ x1, y1, x2, y2, dash }) => h('line', {
        x1, y1, x2, y2, stroke: C.muted, 'stroke-width': 1.4,
        'marker-end': 'url(#sb-arr)', strokeDasharray: dash ? '4 3' : undefined,
      })

      return h(Card, {
        title: '系统拓扑 · 单面板内',
        extra: h('span', { className: 'sb-badge' }, active.length ? `${active.length} 处亮灯` : '2D 流水线'),
      },
        h('div', { style: { minWidth: 0 } },
          h('svg', {
            viewBox: '0 0 320 152', width: '100%', height: 'auto', role: 'img',
            'aria-label': 'SYMBIO 流水线：摄入→卡片→记忆；卡片→桥·试问；卡片→工具箱；派单总线→卡片',
          },
            h('defs', null, h('marker', {
              id: 'sb-arr', viewBox: '0 0 10 10', refX: 8, refY: 5,
              markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse',
            }, h('path', { d: 'M0,0 L10,5 L0,10 z', fill: C.muted }))),
            // 顶行：摄入 → 卡片 → 记忆
            h(Node, { x: 4, y: 10, w: 88, ht: 40, label: '长文摄入', sub: 'Intake', on: live.intake }),
            h(Node, { x: 116, y: 10, w: 88, ht: 40, label: '知识卡片', sub: 'Cards', on: live.card }),
            h(Node, { x: 228, y: 10, w: 88, ht: 40, label: '六层记忆', sub: 'Memory' }),
            h(Arrow, { x1: 92, y1: 30, x2: 113, y2: 30 }),
            h(Arrow, { x1: 204, y1: 30, x2: 225, y2: 30 }),
            // 底行：派单总线 → 卡片；卡片 → 桥 / 工具箱
            h(Node, { x: 4, y: 96, w: 88, ht: 40, label: '派单总线', sub: 'bus', on: live.dispatch }),
            h(Node, { x: 116, y: 96, w: 88, ht: 40, label: '免费 AI 桥', sub: '试问', on: live.think }),
            h(Node, { x: 228, y: 96, w: 88, ht: 40, label: '工具箱', sub: '6 本机工具' }),
            h(Arrow, { x1: 58, y1: 94, x2: 116, y2: 52, dash: true }),
            h(Arrow, { x1: 160, y1: 50, x2: 160, y2: 94, dash: true }),
            h(Arrow, { x1: 204, y1: 50, x2: 228, y2: 94, dash: true }),
            // 桥 的试问回流（循环）
            h('path', {
              d: 'M204,116 C232,128 208,140 188,128', fill: 'none', stroke: C.muted,
              'stroke-width': 1.2, 'stroke-dasharray': '3 3', 'marker-end': 'url(#sb-arr)',
            }),
            h('text', { x: 210, y: 140, fill: C.dim, 'font-size': 9 }, '反问宿主对话'))))
    }

    // ═══════════════════════════════════════════════════════════
    // 三处宿主座位（2026-11-05 由座位探针 0.1.3 真机验证全部开放）
    //   A shell.overlay     —— 常驻状态条：跨页可见，不可交互
    //   B sidebar.panellist —— 侧栏入口：id 必须与 main 的 key 同名
    //   C main (keyed)      —— 协同总览页：点入口后替换中央区（不是与业务面板并排）
    // 注册方式严格照官方契约：ctx.get('slots') → slots.inject(name, cb) → slots.register(...)
    // ═══════════════════════════════════════════════════════════
    const SCENE_KEY = 'symbio-overview'

    /** 负载判定的颜色/文案：只认退出码 0/10/20，口径仍在 load-gate 里，面板不自己再算。 */
    function loadVerdict(load) {
      if (!load || load.ok === false) return { color: C.dim, label: '', known: false }
      return {
        color: load.exitCode === 20 ? C.err : load.exitCode === 10 ? C.warn : C.ok,
        label: load.exitCode === 20 ? '停重活' : load.exitCode === 10 ? '停止派单' : '可派单',
        known: true,
      }
    }

    /**
     * A · 常驻状态条。
     *
     * 这个座位是全帧表面、跨页常驻，所以它必须"看得见但不碍事"：
     * pointer-events 恒为 none —— 一条状态条绝不该让宿主自己的按钮点不动。
     * 也正因不可点，它只放三件"一眼能读完"的事：亮灯、负载、待闭环任务数。
     */
    function StatusBar() {
      const { activity, load, state } = useFeed()
      const active = activity?.active || []
      const v = loadVerdict(load)
      const tasks = state?.state?.queue?.tasks?.length
      const light = !activity
        ? '探测中'
        : activity.available === false ? '灯不可读'
          : active.length ? `${active.length} 处活动 · ${active[0].scene} ${active[0].phaseLabel}` : '全场空闲'

      return h('div', {
        'data-symbio-overlay': 'status',
        style: {
          position: 'absolute', right: 14, bottom: 12, zIndex: 10,
          pointerEvents: 'none',
          display: 'flex', justifyContent: 'flex-end',
          maxWidth: 'min(620px, calc(100vw - 28px))',
        },
      }, h('span', { className: 'sb-pill', title: 'SYMBIO 常驻状态 · 只读、不接收点击' },
        h(Dot, { on: active.length > 0, color: C.accent }),
        h('span', { className: active.length ? 'sb-live' : null }, light),
        h('span', { className: 'sb-sep-v' }),
        v.known
          ? h('span', null, 'CPU ', h('b', null, `${num(load.cpu)}%`), ' 内存 ', h('b', null, `${num(load.ram)}%`), ' ', h('span', { style: { color: v.color } }, v.label))
          : h('span', { style: { color: C.dim } }, '负载 —'),
        tasks != null && h('span', { className: 'sb-sep-v' }),
        tasks != null && h('span', null, '待办 ', h('b', null, String(tasks)))))
    }

    /** B · 侧栏入口。`size` 由宿主传入，别写死。 */
    function SceneEntry({ size = 20 } = {}) {
      const { activity } = useFeed()
      const active = activity?.active || []
      return h('span', {
        'data-symbio-scene-entry': '1',
        title: 'SYMBIO 协同总览' + (active.length ? ` · ${active.length} 处活动` : ''),
        style: { position: 'relative', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: size, height: size },
      },
        h('svg', { viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': true, style: { display: 'block' } },
          h('circle', { cx: 12, cy: 12, r: 9, fill: 'none', stroke: C.accent, strokeWidth: 1.5, opacity: 0.85 }),
          h('circle', { cx: 12, cy: 12, r: 2.4, fill: C.accent }),
          h('path', { d: 'M12 3v3.2M12 17.8V21M3 12h3.2M17.8 12H21', stroke: C.accent, strokeWidth: 1.3, strokeLinecap: 'round', opacity: 0.7 })),
        active.length > 0 && h('span', {
          style: {
            position: 'absolute', top: -1, right: -1, width: 6, height: 6, borderRadius: 999,
            background: C.ok, boxShadow: '0 0 0 2px rgba(16,18,28,.9)',
          },
        }))
    }

    /** 亮灯明细：谁在干活、干到哪一步、还差多久。 */
    function ActivityCard({ activity }) {
      const active = activity?.active || []
      const extra = activity
        ? (activity.available === false ? '心跳不可读' : `${active.length} 处活动 / ${activity.total ?? 0} 个心跳文件`)
        : '探测中'
      const body = active.length === 0
        ? h('div', { className: 'sb-empty' },
            activity?.available === false
              ? `心跳目录不可读：${activity.reason || '原因未知'}`
              : '当前没有场景在干活。灯灭是正常状态，不是故障。')
        : active.map((a, i) => h('div', { key: i, className: 'sb-ov-row' },
            h(Dot, { on: true, color: C.accent }),
            h('span', { className: 'sb-ov-k' }, `${a.scene} · ${a.phaseLabel}`),
            a.detail ? h('span', { className: 'sb-ov-mid' }, a.detail) : null,
            h('span', { className: 'sb-ov-v' }, `剩 ${Math.round((a.remainMs || 0) / 1000)}s`)))

      return h(Card, { title: '亮灯 · 谁在干活', extra: h('span', { className: 'sb-badge' }, extra) },
        body,
        activity?.stale > 0
          ? h('div', { className: 'sb-note' }, `${activity.stale} 个心跳已过期（TTL 内未续），不计入活动。`)
          : null)
    }

    /** 负载明细：给人看的那一半。判定口径只在 load-gate 里，本页不重算。 */
    function LoadCard({ load }) {
      const v = loadVerdict(load)
      const extra = h('span', { className: 'sb-badge', style: { color: v.color } }, v.known ? v.label : '未采样')
      if (!v.known) {
        return h(Card, { title: '负载 · 能不能派单', extra },
          h('div', { className: 'sb-empty' }, load?.message || '负载闸还没跑过（约 4.5s 采样一次）。'))
      }
      const row = (key, mid, val) => h('div', { className: 'sb-ov-row' },
        h('span', { className: 'sb-ov-k' }, key),
        h('span', { className: 'sb-ov-mid' }, mid),
        h('span', { className: 'sb-ov-v' }, val))
      const ramMid = load.ramUsedMB
        ? `${(load.ramUsedMB / 1024).toFixed(1)} / ${(load.ramTotalMB / 1024).toFixed(0)} GB`
        : '—'
      return h(Card, { title: '负载 · 能不能派单', extra },
        row('CPU', (load.samples || []).join(' / ') || '—', `${num(load.cpu)}%`),
        row('内存', ramMid, `${num(load.ram)}%`),
        row('阈值', `可派单 < ${num(load.minOk)}% · 停止 < ${num(load.minWarn)}%`, load.cached ? '缓存' : '实时'),
        h('div', { className: 'sb-note' }, `采样于 ${load.time || '—'}；判定口径只在 tools/load-gate.mjs 里，本页不重算。`))
    }

    /**
     * C · 协同总览页（main 座位）。
     *
     * 它是「跨场景的全局视图」，不是业务面板的复制品：业务面板管知识消化的具体活，
     * 这一页管三件事——谁在干活、机器扛不扛得住、三层库长什么样。
     *
     * 注意：点侧栏入口会把中央区**替换**成这一页（真机实测 panelProbe 同时转 false），
     * 不是与业务面板并排。所以这一页必须自带「回哪去」的说明。
     */
    function OverviewPage() {
      const { health, state, activity, load, error, loading } = useFeed()
      const s = state?.state
      const sourceOk = !!s?.ok
      const bridge = health?.bridge
      const issues = s?.issues || []

      const head = h('div', { className: 'sb-ov-head' },
        h('h2', { className: 'sb-ov-title' }, 'SYMBIO · 协同总览'),
        h('span', { className: 'sb-badge' }, `阶段 ${s?.config?.stage ?? '—'}`),
        h('span', { className: 'sb-badge' },
          h(Dot, { on: sourceOk, color: sourceOk ? C.ok : C.dim }),
          health?.dataSource?.source === 'unset'
            ? '数据源 未配置'
            : `数据源 ${s ? (sourceOk ? '已连接' : '部分不可读') : '探测中'}`),
        h('span', { className: 'sb-badge' },
          h(Dot, { on: !!bridge?.online }),
          `桥 ${bridge ? (bridge.online ? '在线' : '离线') : '探测中'}`),
        h('span', { className: 'sb-spacer' }),
        h('span', { className: 'sb-badge' }, `v${health?.version ?? '—'}`),
        h('button', {
          className: 'sb-btn', disabled: loading,
          onClick: () => void feed.refresh(),
        }, loading ? '刷新中…' : '刷新'))

      const foot = h('div', { className: 'sb-foot' },
        h('span', null, '座位 main · key = ' + SCENE_KEY),
        h('span', null, '·'),
        h('span', null, '数据源 ', h('code', { className: 'sb-code' }, s?.root || health?.dataSource?.root || '—'),
          rootSourceText(health) ? h('span', { style: { color: C.dim } }, ` · ${rootSourceText(health)}`) : null,
          health?.dataSource?.source === 'unset'
            ? h('span', { style: { color: C.warn } }, ' · 请在插件配置填 dataRoot，或设 SYMBIO_HOME 指向工作台根')
            : null),
        h('span', null, '·'),
        h('span', null, s?.checkedAt ? `读取于 ${fmtTime(s.checkedAt)}` : '尚未读取'),
        h('span', { style: issues.length ? { color: C.warn } : null }, `${issues.length} 个读取问题`),
        issues.length > 0
          ? h('div', { style: { width: '100%', color: C.warn } },
              ...issues.map((it, i) => h('div', { key: i }, `${it.path} — ${it.reason}`)))
          : null,
        h('span', null, '本页只读；切回对话由侧栏的会话入口负责。'))

      return h('div', { 'data-symbio-overview': '' },
        h('div', { className: 'sb-ov-wrap' },
          head,
          h('p', { className: 'sb-sub' }, '本页占据中央区（main 座位），业务面板仍在左侧那块。从侧栏切回对话即可离开。'),
          error ? h('div', { className: 'sb-warn' }, h('strong', null, '工作台接口未就绪：'), error) : null,
          h('div', { className: 'sb-ov-cols' },
            h(ActivityCard, { activity }),
            h(LoadCard, { load })),
          h(Libraries, { libs: s?.libraries, activity }),
          h(Topology, { activity }),
          h('div', { className: 'sb-ov-cols' },
            h(Queue, { queue: s?.queue, handoff: s?.handoff }),
            h(Memory, { memory: s?.memory })),
          foot))
    }

    function BusinessPanel() {
      const { health, state, activity, load: loadInfo, error, loading } = useFeed()
      const [question, setQuestion] = React.useState('只回答四个字：挂载成功')
      const [askState, setAskState] = React.useState(null)

      const load = React.useCallback(() => feed.refresh(), [])

      const onAsk = async () => {
        const q = question.trim()
        if (!q || askState?.busy) return
        setAskState({ busy: true, result: null })
        const t0 = Date.now()
        try {
          const res = await fetch('/api/symbio/ask', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ site: 'doubao', question: q }),
          })
          const body = await res.json()
          setAskState({ busy: false, result: { ...body, ms: Date.now() - t0 } })
        } catch (e) {
          setAskState({ busy: false, result: { ok: false, errorType: 'request-failed', message: e?.message ?? '请求失败' } })
        }
        void load()
      }

      const s = state?.state
      const sourceOk = !!s?.ok
      const sourceIssues = s?.issues || []
      const bridge = health?.bridge
      const redLines = s?.redLines || state?.redLines || health?.redLines || []
      const expected = state?.expectedAssets || health?.expectedAssets

      return h('div', { 'data-symbio-root': '' },
        h('div', { className: 'sb-wrap' },
          h('header', { className: 'sb-head' },
            h('h2', { className: 'sb-title' }, 'SYMBIO · 知识消化'),
            h('span', { className: 'sb-badge' }, `阶段 ${s?.config?.stage ?? '—'}`),
            h('span', { className: 'sb-badge' }, '单主场景'),
            h('span', { className: 'sb-badge' }, h(Dot, { on: sourceOk, color: sourceOk ? C.ok : C.dim }),
              health?.dataSource?.source === 'unset' ? '数据源 未配置' : `数据源 ${s ? (sourceOk ? '已连接' : '部分不可读') : '探测中'}`),
            h('span', { className: 'sb-badge' }, h(Dot, { on: !!bridge?.online }), `桥 ${bridge ? (bridge.online ? '在线' : '离线') : '探测中'}`),
            h(LightCapsule, { activity }),
            h(LoadCapsule, { load: loadInfo }),
            h('span', { className: 'sb-spacer' }),
            h('span', { className: 'sb-badge' }, `v${health?.version ?? '0.5.1'}`),
            h('button', { className: 'sb-btn', disabled: loading, onClick: () => void load() }, loading ? '刷新中…' : '刷新')),

          h('p', { className: 'sb-sub', style: { marginTop: -6 } }, '资料 → 可检索卡片。所有数字来自本机真实文件；右侧对话由宿主原生提供。'),

          error && h('div', { className: 'sb-warn' },
            h('strong', null, '工作台接口未就绪：'), error,
            h('div', { style: { marginTop: 5 } }, '刚升级完包时，点菜单「Harness → 重启 Harness」再刷新面板。')),

          h('div', { className: 'sb-grid' },
            h(Metric, { label: '未闭环任务', value: s?.queue?.tasks?.length, hint: '10-shared/任务看板.md' }),
            h(Metric, { label: '知识卡片', value: s?.cards?.available ? s.cards.total : null, unit: '张', hint: 'knowledge-digest/cards/' }),
            h(Metric, { label: '记忆文件', value: s?.memory?.totalFiles, unit: '个', hint: fmtBytes(s?.memory?.totalBytes) }),
            h(Metric, {
              label: '今日花费', value: s?.ledger ? (s.ledger.todaySpend == null ? '0.00' : Number(s.ledger.todaySpend).toFixed(2)) : null,
              unit: s?.ledger?.currency === 'CNY' ? '¥' : (s?.ledger?.currency ?? ''),
              hint: s?.ledger
                ? `${s.ledger.todaySpend == null ? '台账无今日记录' : '台账已记'} · 上限 ¥${num(s?.config?.dailyBudgetCNY)}/天`
                : '台账不可读',
              color: C.ok,
            })),

          h('div', { className: 'sb-main' },
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 } },
              h(Queue, { queue: s?.queue, handoff: s?.handoff }),
              h(Cards, { cards: s?.cards, maxChars: s?.config?.cardMaxChars }),
              h(Intake, { onIngested: () => void load() })),
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 } },
              h(Bridge, { bridge, onAsk, askState, question, setQuestion }),
              h(Memory, { memory: s?.memory }))),

          h('div', { style: { minWidth: 0 } }, h(Tools)),

          h('div', { style: { minWidth: 0 } }, h(Libraries, { libs: s?.libraries, activity })),

          h('div', { style: { minWidth: 0 } }, h(Topology, { activity })),

          h('div', { className: 'sb-grid' },
            h(Assets, { assets: s?.assets, expected }),
            h(RedLines, { lines: redLines, privacy: s?.privacyDoc })),

          h('div', { className: 'sb-foot' },
            h('span', null, '身份 local:symbio-workbench'),
            h('span', null, '·'),
            h('span', null, '数据源 ', h('code', { className: 'sb-code' }, s?.root || health?.dataSource?.root || '—'),
          rootSourceText(health) ? h('span', { style: { color: C.dim } }, ` · ${rootSourceText(health)}`) : null,
          health?.dataSource?.source === 'unset'
            ? h('span', { style: { color: C.warn } }, ' · 请在插件配置填 dataRoot，或设 SYMBIO_HOME 指向工作台根')
            : null),
            h('span', null, '·'),
            h('span', null, s?.checkedAt ? `读取于 ${fmtTime(s.checkedAt)}` : '尚未读取'),
            h('span', null, '·'),
            h('span', { style: sourceIssues.length ? { color: C.warn } : null }, `${sourceIssues.length} 个读取问题`),
            sourceIssues.length > 0 && h('div', { style: { width: '100%', color: C.warn } },
              ...sourceIssues.map((it, i) => h('div', { key: i }, `${it.path} — ${it.reason}`))),
            h('span', null, '面板只读，不覆盖宿主的对话、工作台切换与设置入口。'))))
    }

    // 宿主会重放 apply（0.1.1 真机见过同一实例被 apply 7 次）。
    // 三个座位与业务面板都按 id/包名判重，重复注册会抛 Duplicate —— 这里只挂一次。
    let mounted = false

    /**
     * 把 A/B/C 三处座位挂上去。
     *
     * 契约来自宿主 asar 的官方样板与 SlotMap，不是猜的：
     *   ctx.get('slots')          门面提供的免声明查询
     *   slots.inject(name, cb)    座位被声明时才回调
     *   slots.register(opts, C)   list 座位用 id，keyed 座位（main）用 key
     *
     * 直接读 ctx.slots 会抛 `cannot get property "slots" without inject`
     * —— 0.1.2 真机就栽在这，所以这里绝不碰 ctx.slots。
     */
    function bindSeats(ctx, push) {
      let slots = null
      try {
        slots = typeof ctx?.get === 'function' ? ctx.get('slots') : null
      } catch {
        slots = null
      }
      if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
        // 只丢附加能力，业务面板照旧 —— 这条降级路径是有意的，不是失败。
        console.warn('[symbio] slots 服务未交付：常驻状态条与协同总览暂不挂载，业务面板不受影响')
        return
      }

      const seat = (name, opts, Comp) => {
        try {
          push(slots.inject(name, () => slots.register(opts, Comp)))
        } catch (e) {
          // 单个座位失败不牵连其它座位，更不牵连业务面板。
          console.warn(`[symbio] 座位 ${name} 注册失败：`, e?.message ?? e)
        }
      }

      seat('shell.overlay', { name: 'shell.overlay', id: 'symbio-status', order: 900 }, StatusBar)
      // id 与 main 的 key 必须同名，宿主按 id 选择中央面板（已真机验证）
      seat('sidebar.panellist', { name: 'sidebar.panellist', id: SCENE_KEY, order: 900 }, SceneEntry)
      seat('main', { name: 'main', key: SCENE_KEY }, OverviewPage)
    }

    function apply(ctx) {
      if (mounted) return
      mounted = true
      ctx.effect(() => {
        ensureStyles()
        const disposers = []
        const push = (d) => { if (typeof d === 'function') disposers.push(d) }

        // D · 业务面板：这条是工作台本体，放最前，且**不依赖 slots**。
        push(ctx.desktopWorkbenches.register({
          title: 'SYMBIO 工作台',
          description: '把六层记忆、通用技能与免费 AI 桥挂进一块业务面板；单主场景为知识消化。',
          panelTitle: 'SYMBIO 工作台',
          audience: '知识工作者 / 资料消化场景',
          requirements: '业务面板可独立使用；数据源为 E:/SYMBIO（只读）；免费 AI 桥需另起伴生进程，未启动不阻断面板。',
          initialization: 'empty',
          layout: { businessSide: 'left', businessWidth: 0.6 },
        }, BusinessPanel))

        // A/B/C 三处额外座位。失败只丢附加能力，不影响上面那块面板。
        bindSeats(ctx, push)

        return () => {
          for (const d of disposers.reverse()) { try { d() } catch { /* 卸载期失败不外抛 */ } }
          mounted = false
          removeStyles()
        }
      })
    }

    return { apply, inject: ['desktopWorkbenches'] }
  },
})
