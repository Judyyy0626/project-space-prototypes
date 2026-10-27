// 此文件由 imagination-mcp 自动注入，请勿手改。SSA 守卫（joyapp 子应用，转发 cookie 给门户验票）。
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const { URL } = require('url');

const PLATFORM_URL = process.env.__SSA_PLATFORM || "https://w10zglzij6rw.joyapp.jd.com";
const APP_CODE = process.env.__SSA_APPCODE || "projectspacenew";
const INNER_PORT = Number(process.env.__GW_INNER_PORT || 3001);
const GUARD_PORT = 8080;
const cache = new Map();  // ssaKey → { allowed, erp, exp }
const TTL = 60 * 1000;

// 拉起业务 demo（PORT=内部端口），先清端口占用
try { require('child_process').execSync('fuser -k ' + INNER_PORT + '/tcp 2>/dev/null || true'); } catch {}
// 递归护栏：业务启动命令绝不能指向守卫脚本自身，否则守卫 spawn 守卫 → fork 炸弹、真服务永不起、8080 一直 503。
// 正常链路已在 MCP 侧剔除污染值（resolveBusinessStartCmd），这里是最后一道兜底：命中即拒启，日志一眼可见。
const BUSINESS_CMD = "node server.js";
if (/_(ssa|gateway)_guard\.js/.test(BUSINESS_CMD)) {
  console.error('[ssa-guard] FATAL 业务启动命令指向守卫自身(' + BUSINESS_CMD + ')，会无限递归。拒绝启动。请检查 deploy 的 startCmd。');
  process.exit(1);
}
const child = spawn('bash', ['-c', BUSINESS_CMD], { env: buildChildEnv(), stdio: 'inherit' });
child.on('exit', (c) => { console.error('[ssa-guard] demo exited', c); process.exit(c || 1); });

// 把部署期环境变量（_env.js）merge 进业务进程的 process.env，业务可直接 process.env.X 读——
// 对齐 Vercel/Railway 等云平台惯例，省去应用侧 require('_env.js') + 多路径探测的踩坑（反馈 v6/v9）。
// _env.js 文件仍随包在，老应用 require('./_env.js') 照常工作 → 两种读法都成立、向后兼容。
function buildChildEnv() {
  const env = { ...process.env, PORT: String(INNER_PORT) };
  for (const p of [__dirname + '/_env.js', __dirname + '/../_env.js', process.cwd() + '/_env.js', '/workspace/_env.js']) {
    try {
      if (require('fs').existsSync(p)) {
        const e = require(p);
        for (const k of Object.keys(e || {})) { if (k !== '__ENV_JS_MARK') env[k] = String(e[k]); }
        console.log('[ssa-guard] merged _env.js →', Object.keys(e || {}).filter((k) => k !== '__ENV_JS_MARK').join(','));
        break;
      }
    } catch (err) { console.error('[ssa-guard] _env.js 加载失败(' + p + '):', err && err.message); }
  }
  return env;
}

function parseCookie(req) {
  const out = {}; (req.headers.cookie || '').split(';').forEach(p => {
    const i = p.indexOf('='); if (i > -1) {
      const k = p.slice(0, i).trim(); const raw = p.slice(i + 1).trim();
      // decodeURIComponent 遇畸形 cookie 值(裸 % / 非法 UTF-8)会抛 URIError——必须捕获，
      // 否则一个用户的畸形 cookie 就能崩溃守卫进程、整个应用 503(火爆高频触发→CrashLoop)。降级用原始值。
      try { out[k] = decodeURIComponent(raw); } catch { out[k] = raw; }
    }
  }); return out;
}
function ssaKey(req) {
  const c = parseCookie(req);
  return c['ssa.ticket'] || c['sso.jd.com'] || c['erp_erp'] || '';  // 缓存 key
}
function reqUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return proto + '://' + req.headers.host + req.url;
}
// 转发整份 cookie 给门户 check-access，门户验票 → { allowed, erp, name, dept, reason }
function checkAccess(req) {
  const key = ssaKey(req);
  const hit = key && cache.get(key);
  if (hit && hit.exp > Date.now()) return Promise.resolve({ allowed: hit.allowed, erp: hit.erp, name: hit.name, dept: hit.dept, owner: hit.owner });
  return new Promise((resolve) => {
    const u = new URL(PLATFORM_URL + '/api/sso/check-access?appCode=' + encodeURIComponent(APP_CODE));
    const lib = u.protocol === 'https:' ? https : http;
    const r = lib.request(u, { method: 'GET', headers: { 'Cookie': req.headers.cookie || '' }, timeout: 8000 }, (resp) => {
      const cs = []; resp.on('data', d => cs.push(d));
      resp.on('end', () => {
        let out = { allowed: false, erp: '', name: '', dept: '', owner: '' };
        try { const j = JSON.parse(Buffer.concat(cs).toString('utf-8')); out = { allowed: !!j.allowed, erp: j.erp || '', name: j.name || '', dept: j.dept || '', owner: j.owner || '' }; } catch {}
        if (key) cache.set(key, { allowed: out.allowed, erp: out.erp, name: out.name, dept: out.dept, owner: out.owner, exp: Date.now() + TTL });
        resolve(out);
      });
    });
    r.on('error', () => resolve({ allowed: false, erp: '', name: '', dept: '', owner: '', err: 1 }));   // 门户不可达 → 当未登录，跳登录
    r.on('timeout', () => { r.destroy(); resolve({ allowed: false, erp: '', name: '', dept: '', owner: '', err: 1 }); });
    r.end();
  });
}
function ssaLoginRedirect(req, res) {
  const ret = encodeURIComponent(reqUrl(req));
  res.writeHead(302, { Location: PLATFORM_URL + '/login?returnUrl=' + ret });
  res.end();
}
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function deny(res, owner) {
  const ownerLine = owner
    ? '应用负责人：<b style="color:#eef2f8">' + esc(owner) + '</b>，请联系 TA 为你开通权限。'
    : '你不在该应用的访问白名单内，或应用已下架，请联系应用负责人。';
  res.writeHead(403, { 'Content-Type': 'text/html;charset=utf-8' });
  res.end('<!doctype html><meta charset=utf-8><body style="font-family:sans-serif;background:#040507;color:#eef2f8;text-align:center;padding:80px"><h1 style="color:#ff7b96">无权访问</h1><p style="color:#8590a6">' + ownerLine + '</p><p><a style="color:#26e0d4" href="' + PLATFORM_URL + '">返回门户</a></p></body>');
}
function proxy(req, res, ident) {
  const headers = { ...req.headers };
  headers['x-user-erp'] = ident.erp;               // 注入的一定是 erp（门户验过），不是名字
  if (ident.name) headers['x-user-name'] = encodeURIComponent(ident.name);          // 姓名（门户回 dp.jd.com 验票拿到）
  if (ident.dept) headers['x-user-department'] = encodeURIComponent(ident.dept);    // 部门组织全路径
  delete headers.cookie;                      // 不把 .jd.com 全套 cookie 透给业务 demo
  const p = http.request({ hostname: '127.0.0.1', port: INNER_PORT, path: req.url, method: req.method, headers },
    (up) => { res.writeHead(up.statusCode || 502, up.headers); up.pipe(res); });
  p.on('error', () => { res.writeHead(502); res.end('demo upstream error'); });
  req.pipe(p);
}
function waitInner(cb, n = 30) {
  const s = require('net').connect(INNER_PORT, '127.0.0.1');
  s.on('connect', () => { s.destroy(); cb(); });
  s.on('error', () => { s.destroy(); n > 0 ? setTimeout(() => waitInner(cb, n - 1), 500) : cb(); });
}

waitInner(() => {
  http.createServer(async (req, res) => {
    // /api/tunnel/* 匿名直通：隧穿 exe 无浏览器 SSO 票据，应用层用配对码换的长期令牌(x-vibe-token)自证身份。
    // 有票据(浏览器访问)则照常验票注入 erp，没有也放行——令牌校验在应用层(server.js verifyTunnelToken)。
    const isTunnel = (req.url || '').split('?')[0].startsWith('/api/tunnel/');
    const r = await checkAccess(req);
    if (isTunnel) {
      if (r.erp && r.allowed) { proxy(req, res, r); return; }   // 已登录浏览器 → 注入 erp 直通
      proxy(req, res, { erp: '', name: '', dept: '', owner: '' }); // 匿名(exe) → 直通,应用层验令牌
      return;
    }
    if (!r.erp) { ssaLoginRedirect(req, res); return; }   // 门户没验出 erp（未登录/门户不可达）→ 跳 SSA 登录
    if (!r.allowed) { deny(res, r.owner); return; }        // 下架 / 不在白名单
    proxy(req, res, r);                                     // 放行 + 注入门户验过的 erp + 姓名 + 部门
  }).listen(GUARD_PORT, '0.0.0.0', () => console.log('[ssa-guard] on', GUARD_PORT, '→ demo', INNER_PORT, 'app=' + APP_CODE));
});
