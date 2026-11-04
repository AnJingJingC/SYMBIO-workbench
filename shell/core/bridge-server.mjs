// 桥服务（主进程）—— 架构 §3.2：POST /webai/ask，只绑 127.0.0.1，不对外。

import http from 'node:http';

const BODY_LIMIT = 64 * 1024; // 64KB，免费桥只收短问句
const HOST = '127.0.0.1';

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > BODY_LIMIT) {
        reject(Object.assign(new Error('请求体过大'), { code: 'bad-request' }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

/**
 * @param {object} opts
 * @param {object} opts.dispatcher
 * @param {number} [opts.port] 0 = 随机端口（冒烟测试用）
 */
export async function startBridge({ dispatcher, port = 31239 }) {
  const server = http.createServer(async (req, res) => {
    // 只接受本机回环：任何非 127.0.0.1 的 Host 一律拒绝，防 DNS rebinding
    const remote = req.socket.remoteAddress ?? '';
    if (!(remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1')) {
      return send(res, 403, { ok: false, errorType: 'bad-request', message: '只接受本机调用。' });
    }

    const url = new URL(req.url ?? '/', `http://${HOST}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      return send(res, 200, { ok: true, sites: dispatcher.siteIds(), stats: dispatcher.stats() });
    }

    // 伴生模式没有自己的 UI：匿名额度耗尽后必须能从 HTTP 把站点窗口叫出来手动登录。
    // 壳只负责开窗 + 如实回报登录态，绝不代填账号、不碰验证码、不自动登录。
    if (req.method === 'POST' && (url.pathname === '/webai/show' || url.pathname === '/webai/hide')) {
      const siteId = url.searchParams.get('site') || dispatcher.siteIds()[0];
      try {
        const result = url.pathname === '/webai/show'
          ? await dispatcher.showSite(siteId)
          : await dispatcher.hideSite(siteId);
        const { status, ...body } = result;
        return send(res, status ?? (result.ok ? 200 : 500), body);
      } catch (e) {
        return send(res, 500, { ok: false, errorType: 'unknown', message: e?.message ?? '窗口操作失败' });
      }
    }

    if (req.method !== 'POST' || url.pathname !== '/webai/ask') {
      // 选择器实测：POST /webai/probe?site=xxx —— verified:false 的站点靠它校准
      if (req.method === 'POST' && url.pathname === '/webai/probe') {
        const siteId = url.searchParams.get('site');
        if (!siteId) {
          return send(res, 400, { ok: false, errorType: 'bad-request', message: '缺少 ?site=xxx' });
        }
        try {
          // 校准覆盖：verified:false 的站选择器是猜的，猜错就探不到东西。
          // ?input= / ?send= / ?answer= 允许"临时试任意候选"，只影响本次探测，
          // 不写回站点定义——校准完再决定要不要回写，避免把猜测当事实。
          const overrides = {
            inputSel: url.searchParams.get('input') || undefined,
            sendSel: url.searchParams.get('send') || undefined,
            answerSel: url.searchParams.get('answer') || undefined,
          };
          const result = await dispatcher.probeSite(siteId, {
            captureTo: url.searchParams.get('capture') || undefined,
            overrides,
          });
          const { status, ...body } = result;
          return send(res, status ?? (result.ok ? 200 : 500), body);
        } catch (e) {
          return send(res, 500, { ok: false, errorType: 'unknown', message: e?.message ?? '探测失败' });
        }
      }
      return send(res, 404, {
        ok: false, errorType: 'bad-request',
        message: '未知路径。可用：GET /health、POST /webai/ask、POST /webai/show、POST /webai/hide、POST /webai/probe。',
      });
    }

    let payload;
    try {
      const raw = await readBody(req);
      payload = JSON.parse(raw || '{}');
    } catch (e) {
      return send(res, 400, { ok: false, errorType: 'bad-request', message: `请求体不是合法 JSON：${e.message}` });
    }

    try {
      const result = await dispatcher.ask({ site: payload.site, question: payload.question });
      const status = result.ok ? 200 : (result.status ?? 500);
      const { status: _drop, ...body } = result;
      return send(res, status, body);
    } catch (e) {
      return send(res, 500, { ok: false, errorType: 'unknown', message: e?.message ?? '内部错误' });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, () => resolve());
  });

  const actualPort = server.address().port;
  return {
    port: actualPort,
    baseUrl: `http://${HOST}:${actualPort}`,
    server,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
