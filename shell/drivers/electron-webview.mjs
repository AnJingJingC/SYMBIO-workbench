// Electron 真驱动 —— 壳层把"网页"抽象成 Page。
// 用「主进程隐藏窗口 + 持久分区」代替 renderer 自建 <webview>：
//   · 符合架构 §4.3「桥只能经 Main 触达网页，renderer 不得自建 webview」
//   · 每站一个独立 Chromium 会话（persist:webai-<key>），登录态持久
//   · 输入走真输入事件（insertText / sendInputEvent），对 contenteditable 有效

import { BrowserWindow } from 'electron';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tagged(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function js(sel) {
  return JSON.stringify(String(sel ?? ''));
}

export function createElectronDriver({ loadTimeoutMs = 60000, showPages = false, log = () => {} } = {}) {
  const wins = new Map();

  async function openPage(site) {
    const win = new BrowserWindow({
      show: !!showPages,
      width: 1280,
      height: 900,
      skipTaskbar: true,
      webPreferences: {
        partition: `persist:${site.partitionKey}`,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
        spellcheck: false,
      },
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

    const wc = win.webContents;
    const run = (code) => wc.executeJavaScript(code, true);

    try {
      await Promise.race([
        win.loadURL(site.url),
        sleep(loadTimeoutMs).then(() => {
          throw tagged('timeout', `打开 ${site.url} 超过 ${loadTimeoutMs}ms`);
        }),
      ]);
    } catch (e) {
      if (!win.isDestroyed()) win.destroy();
      throw e?.code ? e : tagged('guest-dead', `网页加载失败：${e?.message ?? e}`);
    }

    const page = {
      id: `${site.id}#${Date.now().toString(36)}`,
      async exists(sel) {
        if (win.isDestroyed()) throw tagged('guest-dead', '窗口已销毁');
        return run(`(() => { try { return !!document.querySelector(${js(sel)}); } catch (e) { return false; } })()`);
      },
      async text(sel) {
        if (win.isDestroyed()) throw tagged('guest-dead', '窗口已销毁');
        return run(
          `(() => { try {
             const list = document.querySelectorAll(${js(sel)});
             if (!list.length) return '';
             const el = list[list.length - 1];
             return (el.innerText || el.textContent || '').trim();
           } catch (e) { return ''; } })()`,
        );
      },
      async focus(sel) {
        if (win.isDestroyed()) throw tagged('guest-dead', '窗口已销毁');
        const ok = await run(
          `(() => { try {
             const el = document.querySelector(${js(sel)});
             if (!el) return false;
             el.scrollIntoView({ block: 'center' });
             el.focus();
             if (el.isContentEditable) {
               const r = document.createRange();
               r.selectNodeContents(el);
               r.collapse(false);
               const s = window.getSelection();
               s.removeAllRanges();
               s.addRange(r);
             }
             return typeof el.focus === 'function';
           } catch (e) { return false; } })()`,
        );
        if (ok) wc.focus();
        return !!ok;
      },
      async type(text) {
        if (win.isDestroyed()) throw tagged('guest-dead', '窗口已销毁');
        const s = String(text ?? '');
        for (let i = 0; i < s.length; i += 400) {
          wc.insertText(s.slice(i, i + 400));
          await sleep(20);
        }
        await sleep(250); // 给编辑器（ProseMirror 之类）一点时间落状态，再发送
        return true;
      },
      async click(sel) {
        if (win.isDestroyed()) throw tagged('guest-dead', '窗口已销毁');
        const ok = await run(
          `(() => { try { const el = document.querySelector(${js(sel)}); if (!el) return false; el.click(); return true; } catch (e) { return false; } })()`,
        );
        if (!ok) throw tagged('selector-stale', `发送按钮不存在：${sel}`);
        return true;
      },
      async key(name = 'Enter') {
        if (win.isDestroyed()) throw tagged('guest-dead', '窗口已销毁');
        wc.sendInputEvent({ type: 'keyDown', keyCode: name });
        wc.sendInputEvent({ type: 'keyUp', keyCode: name });
        return true;
      },
      /** 取所有匹配节点的文本（用于"新回答 = 新增的那一条"，不靠猜） */
      async texts(sel) {
        if (win.isDestroyed()) throw tagged('guest-dead', '窗口已销毁');
        if (!sel) return [];
        return run(
          `(() => { try {
             return [...document.querySelectorAll(${js(sel)})].map((e) => ((e.innerText || e.textContent || '') + '').trim());
           } catch (e) { return []; } })()`,
        );
      },
      /**
       * 等"新出现的回答"：先记着发送前有几条，等到条数变多、且最后一条文本稳定。
       * 这是修掉假阳性的关键——旧实现取"最后一个匹配节点"，会把用户自己的问句当回答交回去。
       */
      async waitForNew(sel, { minCount = 1, firstTokenMs = 25000, stableMs = 1500, hardTimeoutMs = 180000 } = {}) {
        const t0 = Date.now();
        // 阶段一：条数必须先变多（区分"没发出去"和"回答太慢"）
        let appeared = false;
        while (Date.now() - t0 < firstTokenMs) {
          if (win.isDestroyed()) throw tagged('guest-dead', '等待期窗口被销毁');
          const list = await this.texts(sel).catch(() => []);
          if (list.length >= minCount && String(list[list.length - 1] ?? '').trim()) {
            appeared = true;
            break;
          }
          await sleep(250);
        }
        if (!appeared) throw tagged('timeout', `首帧超时：${firstTokenMs}ms 内没有出现新回答（可能没发出去）`);

        // 阶段二：等文本不再变化
        let last = null;
        let lastChange = Date.now();
        while (Date.now() - t0 < hardTimeoutMs) {
          if (win.isDestroyed()) throw tagged('guest-dead', '等待期窗口被销毁');
          const list = await this.texts(sel).catch(() => []);
          const cand = list.length ? String(list[list.length - 1] ?? '').trim() : '';
          if (cand && cand !== last) {
            last = cand;
            lastChange = Date.now();
          } else if (last && Date.now() - lastChange >= stableMs) {
            return last;
          }
          await sleep(300);
        }
        if (last) return last; // 收敛不了就把已取到的交出去，别编
        throw tagged('timeout', `超过 ${hardTimeoutMs}ms 仍未收敛`);
      },
      async waitFor(sel, timeoutMs) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          if (win.isDestroyed()) throw tagged('guest-dead', '等待期窗口被销毁');
          const t = await this.text(sel).catch(() => '');
          if (t && t.length > 0) return true;
          await sleep(300);
        }
        throw tagged('timeout', `等待首帧超时：${sel}`);
      },
      async waitStable(sel, { stableMs = 1200, hardTimeoutMs = 180000 } = {}) {
        const start = Date.now();
        let last = null;
        let lastChange = Date.now();
        while (Date.now() - start < hardTimeoutMs) {
          if (win.isDestroyed()) throw tagged('guest-dead', '等待期窗口被销毁');
          const t = await this.text(sel).catch(() => '');
          if (t !== last) {
            last = t;
            lastChange = Date.now();
          } else if (last && Date.now() - lastChange >= stableMs) {
            return last;
          }
          await sleep(250);
        }
        if (last) return last; // 收敛不了就把已取到的交出去，别编
        throw tagged('timeout', '等待期未取到任何文本');
      },
      /** 登录用：把网页窗口显示出来，让宿主手动登录（壳绝不代填账号/验证码）。 */
      async setVisible(v) {
        if (win.isDestroyed()) throw tagged('guest-dead', '窗口已销毁');
        if (v) {
          win.setSkipTaskbar(false);
          if (win.isMinimized()) win.restore();
          win.show();
          win.focus();
        } else {
          win.hide();
          win.setSkipTaskbar(true);
        }
        return true;
      },
      async reload() {
        if (win.isDestroyed()) throw tagged('guest-dead', '窗口已销毁');
        wc.reload();
        return true;
      },
      async url() {
        if (win.isDestroyed()) throw tagged('guest-dead', '窗口已销毁');
        return wc.getURL();
      },
      async title() {
        if (win.isDestroyed()) throw tagged('guest-dead', '窗口已销毁');
        return wc.getTitle();
      },
      /**
       * 等页面 hydrate：loadURL 只保证"文档到了"，SPA 的界面是后来才挂上的。
       * 之前直接探测，拿到的 bodyLen=0、选择器全 false——那是时序问题，不是站点不可用。
       */
      /**
       * 等页面 hydrate。最准的信号是"目标元素挂出来了"，而不是正文长度——
       * 豆包正文只有 186 字但界面已完整，用字数当判据会一直等不到。
       */
      async waitHydrated({ timeoutMs = 25000, minChars = 150, minElements = 200, selector = '' } = {}) {
        const t0 = Date.now();
        let last = { bodyLen: 0, elements: 0, hit: false };
        const selLiteral = JSON.stringify(String(selector || ''));
        while (Date.now() - t0 < timeoutMs) {
          if (win.isDestroyed()) throw tagged('guest-dead', '等待期窗口被销毁');
          last = await run(
            `(() => { try {
               const b = document.body;
               const bodyLen = b ? ((b.innerText || '').trim().length) : 0;
               const elements = b ? b.querySelectorAll('*').length : 0;
               let hit = false;
               const sel = ${selLiteral};
               if (sel) {
                 try { hit = !!document.querySelector(sel); } catch (e) { hit = false; }
                 if (!hit) {
                   for (const el of (b ? b.querySelectorAll('*') : [])) {
                     if (el.shadowRoot) { try { if (el.shadowRoot.querySelector(sel)) { hit = true; break; } } catch (e) { /* noop */ } }
                   }
                 }
               }
               return { bodyLen, elements, hit };
             } catch (e) { return { bodyLen: 0, elements: 0, hit: false }; } })()`,
          ).catch(() => ({ bodyLen: 0, elements: 0, hit: false }));
          if (last.hit || last.bodyLen >= minChars || last.elements >= minElements) {
            return { hydrated: true, ...last, waitedMs: Date.now() - t0, bySelector: !!last.hit };
          }
          await sleep(500);
        }
        return { hydrated: false, ...last, waitedMs: Date.now() - t0, bySelector: false };
      },
      /**
       * 真实 DOM 探测（含 Shadow DOM 穿透）。
       * 为什么要穿透：豆包这类应用的界面挂在 web component 的 shadow root 里，
       * light DOM 上连一个 <button> 都查不到——用普通 querySelectorAll 会得出"全不命中"的假结论。
       */
      async probeDom(selectors = {}) {
        if (win.isDestroyed()) throw tagged('guest-dead', '窗口已销毁');
        const sel = JSON.stringify(selectors);
        return run(`(() => {
          try {
            const S = ${sel};

            // 穿透 open shadow root 的查询器（closed shadow root 无法穿透，单独统计）
            const deepQueryAll = (root, s, acc) => {
              if (!root || !s) return acc;
              try { acc.push(...root.querySelectorAll(s)); } catch (e) { /* 选择器非法 */ }
              let all = [];
              try { all = root.querySelectorAll('*'); } catch (e) { return acc; }
              for (const el of all) {
                if (el.shadowRoot) deepQueryAll(el.shadowRoot, s, acc);
              }
              return acc;
            };
            const deep = (s) => (s ? deepQueryAll(document, s, []) : []);

            const brief = (el, i) => {
              if (!el) return null;
              const r = el.getBoundingClientRect ? el.getBoundingClientRect() : { width: 0, height: 0 };
              const inShadow = !!(el.getRootNode && el.getRootNode().host);
              return {
                i,
                tag: el.tagName ? el.tagName.toLowerCase() : '?',
                id: el.id || '',
                cls: (el.className && String(el.className).slice(0, 60)) || '',
                testid: el.getAttribute ? (el.getAttribute('data-testid') || '') : '',
                editable: !!el.isContentEditable,
                inShadow,
                w: Math.round(r.width || 0),
                h: Math.round(r.height || 0),
                text: ((el.innerText || el.textContent || '').trim().slice(0, 40)),
              };
            };
            const pick = (s, n = 6) => (s ? deep(s).slice(0, n).map(brief).filter(Boolean) : []);

            const body = (document.body && document.body.innerText) || '';
            const allEls = document.body ? document.body.querySelectorAll('*') : [];

            // 会话区结构：把 answerSel 命中的每个节点连同祖先链一起打出来，
            // 用于区分"用户气泡"和"助手气泡"——只靠 testid 分不开时靠这个。
            const ancestry = (el) => {
              const out = [];
              let n = el;
              for (let d = 0; d < 4 && n && n.tagName; d += 1) {
                out.push({
                  tag: n.tagName.toLowerCase(),
                  testid: (n.getAttribute && n.getAttribute('data-testid')) || '',
                  cls: (n.getAttribute && (n.getAttribute('class') || '')) ? String(n.getAttribute('class')).slice(0, 70) : '',
                });
                n = n.parentElement;
              }
              return out;
            };
            const answerNodes = (() => {
              try {
                return deep(S.answerSel).map((el, i) => ({
                  i,
                  text: ((el.innerText || el.textContent || '').trim().slice(0, 60)),
                  ancestry: ancestry(el),
                }));
              } catch (e) { return []; }
            })();

            // 最后一条"助手气泡"的子树结构：用来精确定位"只包含正文"的那个容器
            const lastReceiveTree = (() => {
              try {
                const hosts = deep('[data-testid="receive_message"]');
                if (!hosts.length) return null;
                const host = hosts[hosts.length - 1];
                const rows = [];
                const walk = (el, depth) => {
                  if (depth > 4 || rows.length > 60) return;
                  rows.push({
                    depth,
                    tag: el.tagName ? el.tagName.toLowerCase() : '?',
                    testid: (el.getAttribute && el.getAttribute('data-testid')) || '',
                    cls: String((el.getAttribute && el.getAttribute('class')) || '').slice(0, 50),
                    textLen: ((el.innerText || el.textContent || '') + '').trim().length,
                    textHead: ((el.innerText || el.textContent || '') + '').trim().slice(0, 30),
                  });
                  for (const c of el.children || []) walk(c, depth + 1);
                };
                walk(host, 0);
                return { rows, hostText: ((host.innerText || '') + '').trim().slice(0, 300) };
              } catch (e) { return null; }
            })();

            // 页面上的所有 data-testid（找"助手消息"真实标记的最快路径）
            const testIds = {};
            for (const el of allEls) {
              const t = el.getAttribute ? el.getAttribute('data-testid') : '';
              if (!t) continue;
              testIds[t] = (testIds[t] || 0) + 1;
            }

            let shadowHosts = 0;
            let closedHosts = 0;
            const customTags = new Set();
            for (const el of allEls) {
              if (el.shadowRoot) shadowHosts += 1;
              // 有 shadow 但取不到 shadowRoot，多半是 closed（attachShadow({mode:'closed'})）
              else if (el.tagName && el.tagName.includes('-')) closedHosts += 1;
              if (el.tagName && el.tagName.includes('-')) customTags.add(el.tagName.toLowerCase());
            }

            return {
              url: location.href,
              title: document.title,
              ready: document.readyState,
              viewport: { w: innerWidth, h: innerHeight },
              domStats: {
                elements: allEls.length,
                shadowHosts,
                customElTags: [...customTags].slice(0, 12),
                closedOrUnreachableHosts: closedHosts,
                htmlLen: (document.body && document.body.innerHTML || '').length,
              },
              // lightCounts = 普通查询（旧口径）；deepCounts = 穿透后（真实口径）
              lightCounts: {
                input: (() => { try { return S.inputSel ? document.querySelectorAll(S.inputSel).length : -1; } catch (e) { return -1; } })(),
                send: (() => { try { return S.sendSel ? document.querySelectorAll(S.sendSel).length : -1; } catch (e) { return -1; } })(),
                answer: (() => { try { return S.answerSel ? document.querySelectorAll(S.answerSel).length : -1; } catch (e) { return -1; } })(),
              },
              counts: {
                input: deep(S.inputSel).length,
                send: deep(S.sendSel).length,
                answer: deep(S.answerSel).length,
              },
              candidates: {
                contenteditable: pick('[contenteditable="true"]'),
                textarea: pick('textarea'),
                sendButtons: pick('button[data-testid], button[type="submit"], button'),
              },
              iframes: [...document.querySelectorAll('iframe')].map((f) => f.src || '(no src)').slice(0, 5),
              answerNodes,
              lastReceiveTree,
              testIds,
              bodyLen: body.length,
              bodyHead: body.slice(0, 300),
              loginHints: {
                hasLoginWord: /登录|登陆|扫码|手机号|验证码/.test(body.slice(0, 4000)),
              },
            };
          } catch (e) { return { error: String((e && e.message) || e) }; }
        })()`);
      },
      async captureTo(filePath) {
        if (win.isDestroyed()) throw tagged('guest-dead', '窗口已销毁');
        const img = await wc.capturePage();
        const fs = await import('node:fs/promises');
        await fs.writeFile(filePath, img.toPNG());
        return filePath;
      },
      isDead() {
        return win.isDestroyed() || wc.isCrashed();
      },
      async dispose() {
        if (!win.isDestroyed()) win.destroy();
      },
    };

    wins.set(site.id, win);
    log({ level: 'info', msg: 'opened', site: site.id, url: site.url });
    return page;
  }

  return { openPage };
}
