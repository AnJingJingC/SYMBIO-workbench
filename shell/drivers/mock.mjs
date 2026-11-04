// Mock 驱动 —— 不碰网络，用可控的"假网页"验证闭环本身：
// 串行、首帧等待、收敛等待、错误分流、guest 自救，全都能在这层跑出来。
// 它不证明"某个站的选择器对"，只证明"桥是通的"。

function tagged(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {object} [opts]
 * @param {Record<string, object|Function>} [opts.plan] siteId → 行为
 *   { loggedIn?:boolean, stale?:boolean, noFirstToken?:boolean, silent?:boolean,
 *     answer?:string, delayMs?:number, dead?:boolean, crashOnWait?:boolean }
 * @param {(ev:object)=>void} [opts.onEvent]
 */
export function createMockDriver({ plan = {}, onEvent = () => {} } = {}) {
  const concurrency = new Map(); // siteId -> 当前并发数
  const peak = new Map();

  return {
    peakConcurrency: (siteId) => peak.get(siteId) ?? 0,

    async openPage(site) {
      const b = typeof plan[site.id] === 'function' ? plan[site.id]() : { ...(plan[site.id] ?? {}) };
      let dead = false;
      let typed = '';
      let sent = false;

      const track = (delta) => {
        const now = (concurrency.get(site.id) ?? 0) + delta;
        concurrency.set(site.id, now);
        peak.set(site.id, Math.max(peak.get(site.id) ?? 0, now));
      };

      const page = {
        id: `${site.id}#${Date.now().toString(36)}`,
        async exists(sel) {
          if (dead) throw tagged('guest-dead', 'mock 页面已失效');
          // 按选择器语义返回，别一律 true：
          // 未登录时"登录按钮"在、"输入框"也可能在（豆包实测如此）；已登录时没有登录按钮。
          const isLoginIndicator = !!site.loginIndicatorSel && sel === site.loginIndicatorSel;
          if (b.loggedIn === false) return isLoginIndicator;
          if (isLoginIndicator) return false;
          return true;
        },
        async text(sel) {
          if (dead) throw tagged('guest-dead', 'mock 页面已失效');
          return b.silent ? '' : (b.answer ?? `回声：${typed}`);
        },
        async focus(sel) {
          if (dead) throw tagged('guest-dead', 'mock 页面已失效');
          return !b.stale;
        },
        async type(text) {
          if (dead) throw tagged('guest-dead', 'mock 页面已失效');
          typed += text;
          return true;
        },
        async click() {
          sent = true;
          return true;
        },
        async key() {
          sent = true;
          return true;
        },
        async waitFor(sel, ms) {
          if (dead) throw tagged('guest-dead', 'mock 页面已失效');
          if (b.noFirstToken) throw tagged('timeout', 'mock 未出首帧');
          if (b.delayMs) await sleep(b.delayMs);
          return true;
        },
        // 发送前快照：未发送时一律为空（新回答 = 发送后新增的那条）
        async texts(sel) {
          if (dead) throw tagged('guest-dead', 'mock 页面已失效');
          if (!sent) return [];
          if (b.loggedIn === false) return []; // 未登录的站：不出回答 → 由调度器归因为 not-logged-in
          if (b.silent) return [];
          return [b.answer ?? `回声：${typed}`];
        },
        async waitForNew(sel, opts = {}) {
          track(1);
          try {
            if (b.crashOnWait && dead === false) {
              dead = true;
              throw tagged('guest-dead', 'mock guest 在等待期崩溃');
            }
            if (b.noFirstToken) throw tagged('timeout', 'mock 未出首帧');
            if (b.delayMs) await sleep(b.delayMs);
            if (b.loggedIn === false) throw tagged('timeout', 'mock 未登录不出回答');
            if (b.silent) return '';
            return b.answer ?? `回声：${typed}`;
          } finally {
            track(-1);
          }
        },
        async waitStable(sel, wait) {
          track(1);
          try {
            if (b.crashOnWait && dead === false) {
              // 模拟 guest 在等待期崩溃：第一次抛 guest-dead，重建后正常
              dead = true;
              throw tagged('guest-dead', 'mock guest 在等待期崩溃');
            }
            if (b.delayMs) await sleep(b.delayMs);
            if (b.silent) return '';
            return b.answer ?? `回声：${typed}`;
          } finally {
            track(-1);
          }
        },
        isDead: () => dead || !!b.dead,
        async dispose() {
          dead = true;
          onEvent({ ev: 'dispose', site: site.id });
        },
        get _sent() {
          return sent;
        },
      };
      onEvent({ ev: 'open', site: site.id });
      return page;
    },
  };
}
