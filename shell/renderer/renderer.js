// ③ Renderer —— 界面层：标签栏 + 网格 + 面板注册表。
// 铁律：不直接读盘（经 app.file.*）、不直连网络（CSP 禁）、不持有任何权限。
// 加一种面板 = 往 RENDERERS 加一个函数；加一个场景 = 加一份 JSON。都不改壳。

(function () {
  const state = {
    scenes: [],
    activeId: null,
    order: [],
    preview: null, // 跨面板联动：file → view
  };

  const $ = (id) => document.getElementById(id);

  // ---------- 面板注册表 ----------
  const RENDERERS = {
    async file(root, cfg) {
      root.innerHTML = '';
      const list = await window.app.file.list(cfg?.root || '.');
      for (const item of list) {
        const row = document.createElement('div');
        row.className = 'row' + (item.dir ? ' dir' : '');
        row.textContent = (item.dir ? '▸ ' : '· ') + item.name;
        if (!item.dir) {
          const sz = document.createElement('span');
          sz.className = 'sz';
          sz.textContent = item.size > 1024 ? `${Math.round(item.size / 1024)}K` : `${item.size}B`;
          row.appendChild(sz);
        } else {
          row.addEventListener('click', () => boot2(root, cfg)); // 占位：目录暂不展开
        }
        row.addEventListener('click', async () => {
          if (item.dir) return;
          const r = await window.app.file.read(item.path);
          window.dispatchEvent(
            new CustomEvent('symbio:preview', {
              detail: { path: item.path, text: r.text, truncated: r.truncated, size: r.size },
            }),
          );
        });
        root.appendChild(row);
      }
      if (!list.length) root.innerHTML = '<div class="hint">（空目录）</div>';
    },

    async view(root) {
      root.innerHTML = '<div class="hint">点左侧文件，这里显示前 8KB。</div>';
      window.addEventListener('symbio:preview', (e) => {
        const { path, text, truncated, size } = e.detail;
        root.innerHTML = '';
        const head = document.createElement('div');
        head.className = 'hint';
        head.textContent = `${path} · ${size}B${truncated ? ' · 只读前 8KB' : ''}`;
        const pre = document.createElement('pre');
        pre.className = 'preview';
        pre.textContent = text;
        root.append(head, pre);
      });
    },

    async harness(root, cfg) {
      await window.WebAIBridge.mount(root, cfg || {});
    },

    async mcp(root, cfg) {
      root.innerHTML = '';
      const d = document.createElement('div');
      d.className = 'hint';
      d.textContent = `MCP 面板（${cfg?.server ?? '未指定'}）：本骨架仅占位，接 MCP 工具总线需另配 server。`;
      root.appendChild(d);
    },

    async reserved(root, cfg) {
      root.innerHTML = '';
      const d = document.createElement('div');
      d.className = 'hint';
      d.textContent = `预留面板：${cfg?.title ?? cfg?.id ?? ''}`;
      root.appendChild(d);
    },
  };

  async function renderPanel(panel) {
    const wrap = document.createElement('section');
    wrap.className = 'panel';
    wrap.style.gridColumn = `${(panel.col ?? 0) + 1} / span ${panel.w ?? 4}`;
    wrap.style.gridRow = `${(panel.row ?? 0) + 1} / span ${panel.h ?? 4}`;

    const h = document.createElement('h3');
    h.textContent = panel.title || panel.id;
    const body = document.createElement('div');
    body.className = 'body';
    wrap.append(h, body);

    const render = RENDERERS[panel.type];
    if (!render) {
      // 约束：未注册类型只灰字提示，不报错、不白屏
      body.innerHTML = `<div class="unknown-type">未注册的面板类型「${panel.type}」——已跳过，未影响其他面板。</div>`;
      return wrap;
    }
    try {
      await render(body, panel);
    } catch (e) {
      body.innerHTML = `<div class="unknown-type">面板渲染失败：${String(e?.message ?? e)}</div>`;
    }
    return wrap;
  }

  async function renderScene(id) {
    const scene = state.scenes.find((s) => s.id === id);
    if (!scene) return;
    state.activeId = id;

    const grid = $('grid');
    grid.innerHTML = '';
    for (const p of scene.panels ?? []) grid.appendChild(await renderPanel(p));

    $('st-scene').textContent = `场景 ${scene.name ?? scene.id}`;
    $('st-panels').textContent = `面板 ${(scene.panels ?? []).length}`;
    renderTabs();
  }

  function renderTabs() {
    const bar = $('tabs');
    bar.innerHTML = '';
    const ordered = [...state.scenes].sort((a, b) => state.order.indexOf(a.id) - state.order.indexOf(b.id));
    for (const s of ordered) {
      const t = document.createElement('div');
      t.className = 'tab' + (s.id === state.activeId ? ' active' : '');
      t.textContent = s.name ?? s.id;
      t.draggable = true;
      t.dataset.id = s.id;
      t.addEventListener('click', () => renderScene(s.id));
      t.addEventListener('dragstart', (e) => {
        t.classList.add('dragging');
        e.dataTransfer.setData('text/plain', s.id);
      });
      t.addEventListener('dragend', () => t.classList.remove('dragging'));
      t.addEventListener('dragover', (e) => e.preventDefault());
      t.addEventListener('drop', async (e) => {
        e.preventDefault();
        const from = e.dataTransfer.getData('text/plain');
        const to = s.id;
        if (!from || from === to) return;
        const ids = ordered.map((x) => x.id).filter((x) => x !== from);
        ids.splice(ids.indexOf(to), 0, from);
        state.order = ids;
        // 单一权威：顺序上报 Main，UI 不本地持久化
        state.order = await window.app.tabs.setOrder(ids);
        renderTabs();
      });
      bar.appendChild(t);
    }
  }

  function boot2() {
    /* 目录展开留给下一版，保持骨架诚实 */
  }

  async function refreshBridge() {
    try {
      const h = await window.app.bridge.health();
      const dot = $('bridge-dot');
      dot.className = 'dot ' + (h.up ? 'up' : 'down');
      $('bridge-text').textContent = h.up ? `桥 ${h.baseUrl}` : '桥未就绪';
      const s = h.stats;
      $('st-queue').textContent = s ? `桥统计 问${s.asked} 成${s.ok} 败${s.failed}` : '桥统计 —';
    } catch {
      $('bridge-dot').className = 'dot down';
      $('bridge-text').textContent = '桥状态不可读';
    }
  }

  async function init() {
    // 阶段：从 config 真读，不硬编码
    try {
      const st = await window.app.config.stage();
      const on = Object.entries(st.modules || {})
        .filter(([, v]) => v)
        .map(([k]) => k);
      $('tag-stage').textContent = `阶段 ${st.current}${on.length ? ' · ' + on.length + ' 模块开' : ''}`;
      $('tag-stage').title = `已启用：${on.join(', ') || '无'}`;
    } catch {
      $('tag-stage').textContent = '阶段 未读';
    }

    // 会话
    try {
      const sess = await window.app.session.current();
      $('tag-session').textContent = `会话 ${sess.id}`;
      $('btn-rotate').addEventListener('click', async () => {
        const s = await window.app.session.rotate();
        $('tag-session').textContent = `会话 ${s.id}`;
      });
    } catch {
      /* 骨架容错 */
    }
    $('btn-close').addEventListener('click', () => window.app.window.close());

    // 场景（数据驱动）
    const ids = await window.app.scenario.list();
    state.scenes = [];
    for (const id of ids) {
      try {
        state.scenes.push(await window.app.scenario.get(id));
      } catch (e) {
        console.warn('场景加载失败', id, e);
      }
    }
    if (!state.scenes.length) {
      $('grid').innerHTML = '<div class="hint">没有可用场景 JSON（shell/scenarios/*.json）。</div>';
      return;
    }

    const saved = await window.app.tabs.getOrder();
    const all = state.scenes.map((s) => s.id);
    state.order = saved && saved.length ? [...saved.filter((x) => all.includes(x)), ...all.filter((x) => !saved.includes(x))] : all;

    await renderScene(state.order[0]);
    await refreshBridge();
    setInterval(refreshBridge, 5000);
  }

  window.addEventListener('DOMContentLoaded', init);
})();
