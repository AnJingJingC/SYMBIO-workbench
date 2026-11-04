// 免费站问答面板（harness 渲染器）—— 只经 app.bridge.ask 走 IPC，不直连网络。
// CSP connect-src 'none' 是硬保证：这里根本发不出 fetch。

(function () {
  const ERROR_LABEL = {
    'not-logged-in': '未登录（请手动登录一次）',
    'guest-dead': '页面已失效（已尝试重建）',
    'selector-stale': '选择器可能过期（站点薄壳待实测）',
    'empty-answer': '回答为空（不编造，如实报错）',
    timeout: '超时（已中止）',
    'secret-blocked': '机密拦截（内容含敏感信息，未发送）',
    'bad-request': '请求不合法',
    'unknown-site': '站点未注册',
    unknown: '未知错误',
  };

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  async function mount(root, cfg) {
    root.innerHTML = '';
    const wrap = el('div', 'chat');
    const log = el('div', 'log');
    const bar = el('div', 'bar');
    const siteSel = el('select');
    const input = el('textarea');
    const askBtn = el('button', 'btn primary', '提问');
    input.placeholder = '问一句短问题（免费桥只适合一问一答纯文字）…';

    const sites = await window.app.bridge.sites();
    for (const s of sites) {
      const opt = el('option', null, `${s.name}${s.verified ? '' : '（选择器待实测）'}`);
      opt.value = s.id;
      siteSel.appendChild(opt);
    }
    if (cfg && cfg.site) siteSel.value = cfg.site;

    const meta = el('span', 'hint');
    meta.textContent = sites.length ? '' : '没有注册任何站点薄壳';

    // 登录窗：只开窗，壳不代填账号/验证码
    const loginBtn = el('button', 'btn ghost small', '开登录窗');
    loginBtn.title = '把该站网页窗口显示出来，你手动登录一次；壳不会代填任何账号信息';
    // 选择器实测：把 verified:false 校准成真实值
    const probeBtn = el('button', 'btn ghost small', '探测选择器');
    probeBtn.title = '真跑一次 DOM 探测，回报各选择器命中数与候选元素';

    bar.append(siteSel, askBtn, loginBtn, probeBtn, meta);
    wrap.append(log, input, bar);
    root.appendChild(wrap);

    function push(cls, text) {
      const b = el('div', 'bubble ' + cls, text);
      log.appendChild(b);
      log.scrollTop = log.scrollHeight;
    }

    async function ask() {
      const question = input.value.trim();
      if (!question) return;
      const site = siteSel.value;
      push('q', question);
      input.value = '';
      askBtn.disabled = true;
      meta.textContent = '等待中（免费站较慢，几十秒正常）…';
      const t0 = performance.now();
      try {
        const r = await window.app.bridge.ask({ site, question });
        const ms = Math.round(performance.now() - t0);
        if (r && r.ok) {
          push('a', r.text);
          meta.textContent = `${ms}ms · ${r.chars ?? r.text.length} 字`;
        } else {
          const type = r?.errorType ?? 'unknown';
          push('e', `[${type}] ${ERROR_LABEL[type] ?? type}\n${r?.message ?? ''}`.trim());
          meta.textContent = `${ms}ms · 失败：${type}`;
        }
      } catch (e) {
        push('e', `调用异常：${e?.message ?? e}`);
        meta.textContent = '调用异常';
      } finally {
        askBtn.disabled = false;
        input.focus();
      }
    }

    async function openLogin() {
      const site = siteSel.value;
      loginBtn.disabled = true;
      meta.textContent = '正在打开该站窗口…';
      try {
        const r = await window.app.bridge.login({ site });
        if (r && r.ok) {
          meta.textContent = r.loggedIn
            ? '窗口已打开，且已是登录态。可直接提问；用完点「收起窗口」。'
            : '窗口已打开：请在其中手动登录一次（壳不代填），登录完成后点「收起窗口」。';
          loginBtn.textContent = '收起窗口';
        } else {
          push('e', `[${r?.errorType ?? 'unknown'}] ${r?.message ?? '打开失败'}`);
          meta.textContent = '打开失败';
        }
      } catch (e) {
        push('e', `打开异常：${e?.message ?? e}`);
        meta.textContent = '打开异常';
      } finally {
        loginBtn.disabled = false;
      }
    }

    async function closeLogin() {
      loginBtn.disabled = true;
      try {
        await window.app.bridge.hide({ site: siteSel.value });
        meta.textContent = '窗口已收起。';
        loginBtn.textContent = '开登录窗';
      } finally {
        loginBtn.disabled = false;
      }
    }

    async function probe() {
      const site = siteSel.value;
      probeBtn.disabled = true;
      meta.textContent = '探测中（会真打开该站页面）…';
      try {
        const r = await window.app.bridge.probe({ site });
        if (r && r.ok) {
          const m = r.matched || {};
          const lines = [
            `站点：${r.name}（verified=${r.verified}）`,
            `登录态：${r.loggedIn ? '已登录' : '未登录'}`,
            `选择器命中：输入框 ${m.input ? '✓' : '✗'} / 发送钮 ${m.send ? '✓' : '✗'} / 回答区 ${m.answer ? '✓' : '✗'}`,
            `结论：${r.calibrated ? '三个选择器全部命中，可校准为 verified' : '未全部命中，需按候选元素改站点薄壳'}`,
            `页面：${r.dom?.url ?? ''}`,
            `候选输入框 ${(r.dom?.candidates?.contenteditable ?? []).length} / 候选 textarea ${(r.dom?.candidates?.textarea ?? []).length} / 候选按钮 ${(r.dom?.candidates?.sendButtons ?? []).length}`,
          ];
          push(r.calibrated ? 'a' : 'e', lines.join('\n'));
          meta.textContent = r.calibrated ? '探测通过' : '探测完成：需校准';
        } else {
          push('e', `[${r?.errorType ?? 'unknown'}] ${r?.message ?? '探测失败'}`);
          meta.textContent = '探测失败';
        }
      } catch (e) {
        push('e', `探测异常：${e?.message ?? e}`);
        meta.textContent = '探测异常';
      } finally {
        probeBtn.disabled = false;
      }
    }

    askBtn.addEventListener('click', ask);
    loginBtn.addEventListener('click', () => (loginBtn.textContent === '收起窗口' ? closeLogin() : openLogin()));
    probeBtn.addEventListener('click', probe);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        ask();
      }
    });
  }

  window.WebAIBridge = { mount, ERROR_LABEL };
})();
