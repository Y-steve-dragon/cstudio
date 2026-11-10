// 掌心 C · 单文件离线版构建脚本
//   node tools/build-offline.mjs
// 产出：CStudio/掌心C-离线版.html —— 一个 HTML 文件，里面装好了全部样式、全部 JS、
// 全部引擎代码和图标。手机上把它拷进存储卡，用浏览器打开就能用，**不需要服务器、不需要网络**。
//
// 为什么需要这个脚本：浏览器不允许 file:// 页面 import ES 模块、也不允许 new Worker(相对路径)，
// 所以这里把 ESM 打成一段普通 <script>（自建模块注册表），并让界面换用主线程内引擎。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = 'js/app.js';
const OUT = path.join(ROOT, '掌心C-离线版.html');

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const norm = (p) => p.replace(/\\/g, '/');

// ───────────────────────────── 1. 收集模块 ─────────────────────────────
const IMPORT_RE = /^[ \t]*import\s*\{([^}]*)\}\s*from\s*'([^']+)'\s*;?[ \t]*$/gm;

function resolveSpec(fromRel, spec) {
  const dir = path.posix.dirname(norm(fromRel));
  return norm(path.posix.normalize(path.posix.join(dir, spec)));
}

function parseModule(rel) {
  let src = read(rel);
  const deps = new Map();          // depRel -> [names...]
  const exports = new Set();

  // 1) import { a, b as c } from './x.js';
  src = src.replace(IMPORT_RE, (whole, list, spec) => {
    const depRel = resolveSpec(rel, spec);
    const pairs = list.split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
      const m = /^(\S+)\s+as\s+(\S+)$/.exec(s);
      return m ? [m[1], m[2]] : [s, s];
    });
    if (!deps.has(depRel)) deps.set(depRel, []);
    for (const [orig, local] of pairs) deps.get(depRel).push(orig === local ? orig : `${orig}: ${local}`);
    return `/* import ${depRel} */`;
  });

  // 2) export { a, b };  （cengine.js 里有这种再导出）
  src = src.replace(/^[ \t]*export\s*\{([^}]*)\}\s*;?[ \t]*$/gm, (whole, list) => {
    for (const s of list.split(',').map((x) => x.trim()).filter(Boolean)) {
      const m = /^(\S+)\s+as\s+(\S+)$/.exec(s);
      exports.add(m ? m[2] : s);
    }
    return '/* export-list */';
  });

  // 3) export const / let / var / function / async function / class
  src = src.replace(/^([ \t]*)export\s+(?=(?:const|let|var|function|async|class)\b)/gm, (whole, indent) => indent);
  // 记录导出的名字
  const declRe = /^[ \t]*(?:const|let|var|function|async\s+function|class)\s+([A-Za-z_$][\w$]*)/gm;
  let mm;
  const declNames = new Set();
  while ((mm = declRe.exec(src))) declNames.add(mm[1]);
  // 只把「原本带 export 的声明」算作导出：重新扫一遍原始文本
  const orig = read(rel);
  const expDeclRe = /^[ \t]*export\s+(?:const|let|var|function|async\s+function|class)\s+([A-Za-z_$][\w$]*)/gm;
  while ((mm = expDeclRe.exec(orig))) exports.add(mm[1]);
  void declNames;

  src = src.replace(/^[ \t]*export\s+default\s+/gm, '/* export-default 不支持 */ ');

  return { rel: norm(rel), src, deps, exports };
}

const modules = new Map();
function collect(rel) {
  const key = norm(rel);
  if (modules.has(key)) return;
  const mod = parseModule(key);
  modules.set(key, mod);
  for (const dep of mod.deps.keys()) collect(dep);
}
collect(ENTRY);

// 拓扑排序（依赖在前），保证 __mods[...] 在使用时已有值
const order = [];
const seen = new Set();
const visiting = new Set();
function visit(key) {
  if (seen.has(key)) return;
  if (visiting.has(key)) return; // 有环也不至于死循环；运行时按需访问
  visiting.add(key);
  for (const dep of modules.get(key).deps.keys()) visit(dep);
  visiting.delete(key);
  seen.add(key);
  order.push(key);
}
for (const key of modules.keys()) visit(key);

// ───────────────────────────── 2. 生成 bundle ─────────────────────────────
const parts = [];
parts.push('/* 掌心 C · 单文件离线版（由 tools/build-offline.mjs 生成，请不要手改这个文件） */');
parts.push('(function () {');
parts.push('"use strict";');
parts.push('window.__CSTUDIO_OFFLINE__ = true;');
parts.push('var __mods = Object.create(null);');
parts.push('var __def = function (id, factory) { __mods[id] = factory(); };');

for (const key of order) {
  const mod = modules.get(key);
  const lines = [];
  for (const [dep, names] of mod.deps) {
    const binds = names.map((n) => (n.includes(':') ? n : n)).join(', ');
    lines.push(`  var { ${binds} } = __mods[${JSON.stringify(dep)}];`);
  }
  // 把 import 注释行删掉（上面已经生成了取值语句）
  const body = mod.src.replace(/^[ \t]*\/\* import [^*]*\*\/[ \t]*$/gm, '');
  const exp = '{\n' + [...mod.exports].map((n) => `    ${n}: ${n}`).join(',\n') + '\n  }';
  parts.push(`__def(${JSON.stringify(key)}, function () {`);
  if (lines.length) parts.push(lines.join('\n'));
  parts.push(body.trimEnd());
  parts.push(`  return ${mod.exports.size ? exp : '{}'};`);
  parts.push('});');
}
parts.push('})();');

const js = parts.join('\n');

// ───────────────────────────── 3. 组装 HTML ─────────────────────────────
let html = read('index.html').replace(/\r\n/g, '\n');
html = html.replace('<!DOCTYPE html>', `<!DOCTYPE html>
<!--
  掌心 C · 单文件离线版（由 tools/build-offline.mjs 自动生成）
  用法：把本文件拷到手机（USB 数据线拷进「下载」目录即可），用手机浏览器打开它，
        就能写 C、编译、运行、单步调试 —— 不需要电脑、不需要 Wi-Fi、不需要联网。
  说明：代码保存在浏览器的本地存储里；若浏览器禁止本地文件存储，页面会提示你及时「下载」备份。
-->`);
const css = read('styles/app.css');
const iconSvg = read('icons/icon.svg');
const iconPng = fs.readFileSync(path.join(ROOT, 'icons/icon-192.png')).toString('base64');

html = html.replace(/^[ \t]*<link rel="manifest"[^>]*>\s*$/gm, '');
html = html.replace(/^[ \t]*<link rel="icon"[^>]*>\s*$/gm,
  () => `  <link rel="icon" href="data:image/svg+xml,${encodeURIComponent(iconSvg)}">`);
html = html.replace(/^[ \t]*<link rel="apple-touch-icon"[^>]*>\s*$/gm,
  () => `  <link rel="apple-touch-icon" href="data:image/png;base64,${iconPng}">`);
// 注意：替换内容里含代码，必须用函数形式——字符串形式会把代码里的 $& / $' 当成替换模式
html = html.replace(/^[ \t]*<link rel="stylesheet" href="styles\/app\.css">\s*$/gm,
  () => `  <style>\n${css}\n</style>`);
html = html.replace(/^[ \t]*<script type="module" src="js\/app\.js"><\/script>\s*$/gm,
  () => `  <script>\n${js}\n  </script>`);

// ───────────────────────────── 4. 自检 ─────────────────────────────
const problems = [];
if (/<link[^>]+href="(?!data:)/.test(html)) problems.push('HTML 里还有外部 link 引用');
if (/<script[^>]+src=/.test(html)) problems.push('HTML 里还有外部 script 引用');
if (/\bimport\s*\{[^}]*\}\s*from\b/.test(js)) problems.push('bundle 里还有 import 语句');
if (/^[ \t]*export\s/m.test(js)) problems.push('bundle 里还有 export 语句');
if (/\bnew Worker\(/.test(js) === false) problems.push('（提示）bundle 里没有 new Worker，说明只用主线程引擎——离线版预期如此');

fs.writeFileSync(OUT, html, 'utf8');

const kb = (n) => (n / 1024).toFixed(1) + ' KB';
console.log('模块数：' + order.length);
console.log('产出：' + path.basename(OUT) + '  ' + kb(Buffer.byteLength(html, 'utf8')));
console.log('  · 样式 ' + kb(Buffer.byteLength(css, 'utf8')) + '，脚本 ' + kb(Buffer.byteLength(js, 'utf8')));
for (const p of problems) console.log('  ! ' + p);
if (problems.some((p) => !p.startsWith('（提示）'))) process.exitCode = 1;
