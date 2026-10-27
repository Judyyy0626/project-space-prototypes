const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 8080);
const HOST = '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'X-Robots-Tag': 'noindex, nofollow',
    'Referrer-Policy': 'no-referrer',
    ...headers
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/healthz') {
    send(res, 200, JSON.stringify({ status: 'ok', time: new Date().toISOString() }), {
      'Content-Type': 'application/json; charset=utf-8'
    });
    return;
  }

  if (url.pathname === '/robots.txt') {
    send(res, 200, 'User-agent: *\nDisallow: /\n', { 'Content-Type': 'text/plain; charset=utf-8' });
    return;
  }

  // 机会品占位接口：dashboard-snapshot 的"重新拉取"功能在纯静态模式下没有后端，
  // 这里返回明确的占位响应，避免前端拿到 404 HTML 解析失败。
  if (url.pathname === '/api/opportunity/status') {
    send(res, 200, JSON.stringify({ ok: null, running: false, message: '演示模式：机会品重跑需要完整后端服务', started_at: null, finished_at: null }), {
      'Content-Type': 'application/json; charset=utf-8'
    });
    return;
  }
  if (url.pathname === '/api/opportunity/run') {
    send(res, 200, JSON.stringify({ ok: false, error: '演示模式：此环境未接入黄金眼取数服务' }), {
      'Content-Type': 'application/json; charset=utf-8'
    });
    return;
  }

  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/' || pathname === '/index.html') pathname = '/templates.html';

  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    send(res, 403, 'Forbidden', { 'Content-Type': 'text/plain; charset=utf-8' });
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      send(res, 404, 'Not Found', { 'Content-Type': 'text/plain; charset=utf-8' });
      return;
    }

    fs.readFile(filePath, (readErr, data) => {
      if (readErr) {
        send(res, 500, 'Internal Server Error', { 'Content-Type': 'text/plain; charset=utf-8' });
        return;
      }
      send(res, 200, data, {
        'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      });
    });
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Changyu dashboard listening on http://${HOST}:${PORT}`);
});
