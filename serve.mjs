// 掌心 C · 本地静态服务器（只用 Node 原生模块，零依赖）
// 用法：node serve.mjs [端口]   → 手机与电脑连同一个 Wi-Fi，用手机浏览器访问打印出的地址
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const PORT = Number(process.argv[2] || process.env.PORT || 8080);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.c': 'text/plain; charset=utf-8',
  '.h': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function safeJoin(root, urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  const p = normalize(join(root, decoded));
  if (p !== root && !p.startsWith(root + sep)) return null;
  return p;
}

const server = createServer(async (req, res) => {
  try {
    let path = safeJoin(ROOT, req.url || '/');
    if (!path) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('403 越权访问');
      return;
    }
    let st = await stat(path).catch(() => null);
    if (st && st.isDirectory()) {
      path = join(path, 'index.html');
      st = await stat(path).catch(() => null);
    }
    if (!st) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('404 找不到 ' + req.url);
      return;
    }
    const body = await readFile(path);
    const ext = extname(path).toLowerCase();
    const noCache = ext === '.html' || ext === '.js' || ext === '.css' || ext === '.webmanifest';
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'content-length': body.length,
      'cache-control': noCache ? 'no-cache' : 'public, max-age=3600',
      // 允许被 PWA 安装、允许 worker 以 module 方式加载
      'service-worker-allowed': '/',
    });
    res.end(body);
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('500 服务器错误：' + e.message);
  }
});

function lanAddresses() {
  const out = [];
  const nets = networkInterfaces();
  for (const list of Object.values(nets)) {
    for (const n of list || []) {
      if (n.family === 'IPv4' && !n.internal) out.push(n.address);
    }
  }
  return out;
}

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  掌心 C 已启动（按 Ctrl+C 停止）');
  console.log('');
  console.log(`  电脑：  http://localhost:${PORT}/`);
  for (const ip of lanAddresses()) {
    console.log(`  手机：  http://${ip}:${PORT}/`);
  }
  console.log('');
  console.log('  手机与电脑连同一个 Wi-Fi，用上面的「手机」地址打开即可。');
  console.log('  打开后可在浏览器菜单里「添加到主屏幕」，之后断网也能用。');
  console.log('');
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用，换一个：node serve.mjs 8081`);
  } else {
    console.error('启动失败：', e.message);
  }
  process.exit(1);
});
