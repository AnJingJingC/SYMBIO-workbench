// 调度器 —— 架构 §3 的桥内核：串行队列 + 分步驱动 + 错误分流 + guest 自救。
// 不依赖 Electron：Page 由 driver 提供，因此可在无头环境下真跑通闭环。

import { checkSecret } from './secret-gate.mjs';

const MAX_QUESTION_CHARS = 4000;
const MAX_ANSWER_CHARS = 20000;

const STATUS_OF = {
  'bad-request': 400,
  'not-logged-in': 401,
  'secret-blocked': 422,
  'unknown-site': 404,
  'empty-answer': 502,
  'guest-dead': 503,
  'timeout': 504,
  'selector-stale': 500,
  unknown: 500,
};

function fail(errorType, message) {
  return { ok: false, errorType, message, status: STATUS_OF[errorType] ?? 500 };
}

function tagged(code, message, extra = {}) {
  const e = new Error(message);
  e.code = code;
  Object.assign(e, extra);
  return e;
}

/**
 * @param {object} opts
 * @param {Record<string, object>} opts.sites  站点薄壳表
 * @param {object} opts.driver                 { openPage(site) => Page }
 * @param {(e:object)=>void} [opts.log]
 */
export function createDispatcher({ sites, driver, log = () => {} }) {
  const pages = new Map(); // siteId -> Page
  const queues = new Map(); // siteId -> Promise 尾节点
  const stats = { asked: 0, ok: 0, failed: 0, byError: {} };

  /** 同站串行：同站不并发（否则串话），跨站互不阻塞。 */
  function enqueue(siteId, task) {
    const tail = queues.get(siteId) ?? Promise.resolve();
    const run = tail.then(task, task);
    queues.set(
      siteId,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  async function ensurePage(site) {
    let page = pages.get(site.id);
    if (page && !page.isDead()) return { page, reused: true };
    if (page) {
      try {
        await page.dispose();
      } catch {
        /* 忽略清理失败 */
      }
      pages.delete(site.id);
    }
    page = await driver.openPage(site);
    pages.set(site.id, page);
    return { page, reused: false };
  }

  /** 一次真实问答：水合 → 登录态 → 定位输入框 → 输入 → 发送 → 等首帧 → 等稳定 → 取文本 */
  async function once(site, page, question, opts = {}) {
    // 首问冷启动的根因：loadURL 完成 ≠ SPA 界面挂出来。
    // 探测流程（probeSite）早就等水合了，问答流程却没有，所以同一个页面"第一问必失败、第二问就好"。
    // 这里以「输入框真挂出来」为信号；复用已水合的页面时命中即返回，几乎零开销。
    if (typeof page.waitHydrated === 'function') {
      const hydration = await page
        .waitHydrated({ timeoutMs: opts.hydrateTimeoutMs ?? 25000, selector: site.inputSel })
        .catch(() => ({ hydrated: false, hit: false, waitedMs: 0 }));
      if (!hydration.hydrated && !hydration.hit) {
        log({ level: 'warn', msg: '水合等待未完成，仍做一次真实定位后再定论', site: site.id, waitedMs: hydration.waitedMs });
      }
    }

    // 未登录不再硬拦：不少站允许匿名试用几轮。硬拦会把"能用的路"堵死。
    // 真失败时再归因为 not-logged-in，让结论来自实测而不是猜测。
    const loggedIn = await site.loggedIn(page).catch(() => true);
    if (!loggedIn) log({ level: 'warn', msg: '未登录，仍尝试（该站可能允许匿名试用）', site: site.id });

    const focused = await page.focus(site.inputSel);
    if (!focused) {
      // 此刻一个字都还没输入，重试绝对不会串话 → 标记为可安全重试。
      // 反之，focus 之后（type/click/wait）的失败一律不自动重试，避免把同一个问题发出去两次。
      throw tagged('selector-stale', `输入框选择器可能过期：${site.inputSel}。未改动配置，按原样报错。`, {
        retryable: true,
        stage: 'focus',
      });
    }

    const typed = await page.type(question);
    if (typed === false) throw tagged('selector-stale', '输入未落进输入框，选择器可能过期。');

    // 发送前先数一遍：新回答 = 条数变多的那一条。
    // 这一步是修掉假阳性的关键——旧实现取"最后一个匹配节点"，会把用户自己的问句当回答交回去。
    const before = typeof page.texts === 'function' ? await page.texts(site.answerSel).catch(() => []) : [];

    await site.send(page);

    let text = '';
    try {
      if (typeof page.waitForNew === 'function') {
        text = await page.waitForNew(site.answerSel, {
          minCount: before.length + 1,
          firstTokenMs: site.wait.firstTokenMs,
          stableMs: site.wait.stableMs,
          hardTimeoutMs: site.wait.hardTimeoutMs,
        });
      } else {
        await page.waitFor(site.answerSel, site.wait.firstTokenMs);
        text = await page.waitStable(site.answerSel, site.wait);
      }
    } catch (e) {
      if (e?.code === 'guest-dead') throw e;
      if (!loggedIn) {
        throw tagged('not-logged-in', '未登录时未出现回答：该站可能需要先登录。请在「开登录窗」里手动登录一次后重试。');
      }
      throw tagged('empty-answer', `等待回答失败（首帧 ${site.wait.firstTokenMs}ms / 硬超时 ${site.wait.hardTimeoutMs}ms）：${e?.message ?? ''}`);
    }

    text = String(text ?? '').trim();
    // 站点自带的去噪钩子（只做站点级清理，不在桥里写死任何站的特例）
    if (typeof site.clean === 'function') {
      try {
        text = String(site.clean(text) ?? '').trim();
      } catch {
        /* 清洗失败保留原文，绝不吞内容 */
      }
    }
    if (!text) throw tagged('empty-answer', '回答区域已出现但内容为空，如实报错，不编造。');
    if (text.length > MAX_ANSWER_CHARS) text = text.slice(0, MAX_ANSWER_CHARS);

    // 回答与问句完全相同：可能是回声/未真正生成，标出来而不是静默当成好结果
    const warnings = [];
    if (text.replace(/\s+/g, '') === String(question).replace(/\s+/g, '')) warnings.push('answer-equals-question');

    return { text, warnings };
  }

  async function run(site, question) {
    let attempt = 0;
    let lastErr = null;
    // 两路自救，都只重试一次，且都不重发问题：
    //   guest-dead        → 页面真的死了，重建一次
    //   selector-stale@focus → 页面还在水合，只补等一次（focus 失败时尚未输入任何字符）
    while (attempt < 2) {
      try {
        const { page } = await ensurePage(site);
        const got = await once(site, page, question, { attempt });
        return { ok: true, text: got.text, warnings: got.warnings, site: site.id, chars: got.text.length };
      } catch (e) {
        lastErr = e;
        if (e?.code === 'guest-dead' && attempt === 0) {
          const p = pages.get(site.id);
          if (p) {
            try {
              await p.dispose();
            } catch {
              /* noop */
            }
            pages.delete(site.id);
          }
          attempt += 1;
          log({ level: 'warn', msg: 'guest-dead，重建页面后重试一次', site: site.id });
          continue;
        }
        if (e?.code === 'selector-stale' && e.retryable && attempt === 0) {
          attempt += 1;
          const p = pages.get(site.id);
          if (p && typeof p.waitHydrated === 'function') {
            await p.waitHydrated({ timeoutMs: 15000, selector: site.inputSel }).catch(() => null);
          }
          log({ level: 'warn', msg: '首问冷启动：输入框未挂出，补等水合后重试一次（未重发问题）', site: site.id });
          continue;
        }
        return fail(e?.code ?? 'unknown', e?.message ?? '未知错误');
      }
    }
    return fail(lastErr?.code ?? 'unknown', lastErr?.message ?? '重试后仍失败。');
  }

  async function ask({ site: siteId, question } = {}) {
    if (typeof siteId !== 'string' || !siteId) return fail('bad-request', '缺少 site。');
    if (typeof question !== 'string' || !question.trim()) return fail('bad-request', 'question 为空。');
    if (question.length > MAX_QUESTION_CHARS) {
      return fail('bad-request', `question 超长（>${MAX_QUESTION_CHARS} 字）。免费桥只适合短问答。`);
    }
    const site = sites[siteId];
    if (!site) return fail('unknown-site', `未注册的站点：${siteId}（可选：${Object.keys(sites).join(', ')}）`);

    const gate = checkSecret(question);
    if (gate.blocked) return fail('secret-blocked', gate.message);

    stats.asked += 1;
    const result = await enqueue(site.id, () => run(site, question));
    if (result.ok) stats.ok += 1;
    else {
      stats.failed += 1;
      stats.byError[result.errorType] = (stats.byError[result.errorType] ?? 0) + 1;
    }
    log({ level: result.ok ? 'info' : 'warn', site: site.id, ok: result.ok, errorType: result.errorType, chars: result.chars });
    return result;
  }

  /**
   * 把某站的网页窗口显示出来，供宿主手动登录。
   * 壳只负责「开窗 + 如实回报登录态」，绝不代填账号、不碰验证码、不自动登录。
   */
  async function showSite(siteId) {
    const site = sites[siteId];
    if (!site) return { ok: false, errorType: 'unknown-site', message: `未注册的站点：${siteId}`, status: 404 };
    return enqueue(site.id, async () => {
      try {
        const { page, reused } = await ensurePage(site);
        if (typeof page.setVisible !== 'function') {
          return { ok: false, errorType: 'unknown', message: '当前驱动不支持显示窗口（Mock 驱动？）' };
        }
        await page.setVisible(true);
        const loggedIn = await site.loggedIn(page);
        const url = page.url ? await page.url() : null;
        // 契约在 API 层讲清楚：壳只开窗 + 如实报登录态；绝不代填账号、不碰验证码、不自动登录。
        const contract = '窗口已显示。我们绝不代填账号/验证码，也不自动登录——请在窗口内手动完成登录。';
        const message = loggedIn
          ? '窗口已显示，该站已登录，可正常问答。'
          : `窗口已显示，但该站当前未登录。请在此窗口手动登录（${contract}）登录完成后调用 /webai/hide 收回窗口即可正常问答。`;
        return {
          ok: true,
          visible: true,
          reused,
          loggedIn,
          loginRequired: !loggedIn,
          loginIndicator: site.loginIndicatorSel || null,
          url,
          contract,
          message,
        };
      } catch (e) {
        return fail(e?.code ?? 'unknown', e?.message ?? '打开登录窗口失败');
      }
    });
  }

  /** 隐藏该站窗口（登录完成后收回后台，不影响后续问答）。 */
  async function hideSite(siteId) {
    const site = sites[siteId];
    if (!site) return { ok: false, errorType: 'unknown-site', message: `未注册的站点：${siteId}`, status: 404 };
    const page = pages.get(site.id);
    if (!page || typeof page.setVisible !== 'function') {
      return { ok: true, visible: false, note: '窗口未打开', message: '该站窗口本来就没开着，无需收回。' };
    }
    try {
      await page.setVisible(false);
      return { ok: true, visible: false, message: '窗口已收回后台。已登录的会话仍保持登录态，可正常试问。' };
    } catch (e) {
      return fail(e?.code ?? 'unknown', e?.message ?? '隐藏窗口失败');
    }
  }

  /**
   * 选择器实测：打开站点，跑一次真实 DOM 探测，回报各选择器命中数与候选元素。
   * 用途：把 sites/*.mjs 里 verified:false 的选择器校准成实测值。
   */
  async function probeSite(siteId, opts = {}) {
    const site = sites[siteId];
    if (!site) return { ok: false, errorType: 'unknown-site', message: `未注册的站点：${siteId}`, status: 404 };
    return enqueue(site.id, async () => {
      try {
        const { page } = await ensurePage(site);
        if (typeof page.probeDom !== 'function') {
          return { ok: false, errorType: 'unknown', message: '当前驱动不支持 DOM 探测（Mock 驱动？）' };
        }

        // 先等页面 hydrate：SPA 的界面在 loadURL 之后才挂上，早探必假阴性
        const hydration =
          typeof page.waitHydrated === 'function'
            ? await page.waitHydrated({
                timeoutMs: opts.hydrateTimeoutMs ?? 25000,
                selector: site.inputSel, // 以"输入框真挂出来"为准，别拿字数猜
              })
            : { hydrated: null, bodyLen: null, waitedMs: 0 };

        // 自适应重探：水合是个过程，"看起来到了"不等于"输入框已经挂出来"。
        // 命中任一选择器就停；都不命中就每秒重探一次，最多 8 次（约 8s），最后如实报"未命中"。
        let dom = null;
        let attempts = 0;
        for (let i = 0; i < 8; i += 1) {
          attempts += 1;
          dom = await page.probeDom({
            inputSel: site.inputSel,
            sendSel: site.sendSel,
            answerSel: site.answerSel,
          });
          const hit = (dom?.counts?.input ?? 0) > 0 || (dom?.counts?.answer ?? 0) > 0 || (dom?.counts?.send ?? 0) > 0;
          if (hit) break;
          await new Promise((r) => setTimeout(r, 1000));
        }
        const loggedIn = await site.loggedIn(page).catch(() => false);

        // 自检用：把窗口显出来再截图（隐藏窗口在部分平台截图为空）
        let captured = null;
        if (opts.captureTo && typeof page.captureTo === 'function') {
          try {
            if (typeof page.setVisible === 'function') await page.setVisible(true);
            await new Promise((r) => setTimeout(r, 800));
            captured = await page.captureTo(opts.captureTo);
            if (typeof page.setVisible === 'function' && !opts.keepVisible) await page.setVisible(false);
          } catch (e) {
            captured = `截图失败：${e?.message ?? e}`;
          }
        }

        const matched = {
          input: dom.counts?.input > 0,
          // sendSel 为空 = 该站靠回车发送（豆包实测如此），不算未命中
          send: site.sendSel ? dom.counts?.send > 0 : true,
          answer: dom.counts?.answer > 0,
        };
        // 提问前能验证的：输入框 + 发送方式 + 登录态
        const preflightOk = matched.input && matched.send && loggedIn;
        return {
          ok: true,
          site: site.id,
          name: site.name,
          verified: !!site.verified,
          verifiedFields: site.verifiedFields ?? null,
          loggedIn,
          matched,
          preflightOk,
          // 完整校准要求回答区也命中——那必须真的问过一次才可能成立
          calibrated: preflightOk && matched.answer,
          answerSelUnverified: !matched.answer,
          hydration,
          probeAttempts: attempts,
          // 只有三个选择器都在页面上真实命中，才算"校准通过"
          calibrated: matched.input && matched.send && matched.answer && loggedIn,
          captured,
          dom,
        };
      } catch (e) {
        return fail(e?.code ?? 'unknown', e?.message ?? '探测失败');
      }
    });
  }

  async function closeAll() {
    for (const [, page] of pages) {
      try {
        await page.dispose();
      } catch {
        /* noop */
      }
    }
    pages.clear();
  }

  return {
    ask,
    showSite,
    hideSite,
    probeSite,
    closeAll,
    stats: () => ({ ...stats, byError: { ...stats.byError } }),
    siteIds: () => Object.keys(sites),
  };
}
