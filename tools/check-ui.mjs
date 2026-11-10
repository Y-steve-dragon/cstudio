// 界面与模块一致性自检（不需要浏览器）：
//   1. JS 引用的 DOM id 是否在 index.html 里存在
//   2. index.html 引用的本地文件是否存在
//   3. HTML 里 id 是否重复、控制台面板是否齐全
//   4. 编辑器依赖的类名是否有 CSS 样式
//   5. app.js 对 store / editor 的方法调用是否真的存在
//   6. app.js 发给 Worker 的消息类型，worker.js 是否处理
// 用法：node tools/check-ui.mjs
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

const html = read('index.html');
const appJs = read('js/app.js');
const editorJs = read('js/editor.js');
const storeJs = read('js/store.js');
const workerJs = read('engine/worker.js');
const css = read('styles/app.css');

// 去掉字符串、模板字面量与注释，避免把 C 源码片段当成函数调用
function strip(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, '``')
    .replace(/'(?:\\[\s\S]|[^'\\\n])*'/g, "''")
    .replace(/"(?:\\[\s\S]|[^"\\\n])*"/g, '""');
}

const appCode = strip(appJs);
const editorCode = strip(editorJs);
const problems = [];

const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
const referenced = new Map();
for (const [name, src] of [['js/app.js', appJs], ['js/editor.js', editorJs]]) {
  for (const m of src.matchAll(/\$\('([#]?[a-zA-Z0-9_-]+)'\)/g)) referenced.set(m[1].replace(/^#/, ''), name);
  for (const m of src.matchAll(/\$\(\s*`'?([a-zA-Z0-9_-]+)'?`\s*\)/g)) referenced.set(m[1], name);
  for (const m of src.matchAll(/getElementById\('([a-zA-Z0-9_-]+)'\)/g)) referenced.set(m[1], name);
  for (const m of src.matchAll(/querySelector(?:All)?\('#([a-zA-Z0-9_-]+)/g)) referenced.set(m[1], name);
}
for (const [id, file] of referenced) if (!ids.has(id)) problems.push(`${file} 引用了不存在的 id: #${id}`);

const panels = new Set([...html.matchAll(/data-panel="([^"]+)"/g)].map((m) => m[1]));
for (const p of ['out', 'problems', 'vars', 'stack']) {
  if (!panels.has(p)) problems.push(`控制台缺少面板按钮 data-panel="${p}"`);
}

for (const m of html.matchAll(/(?:src|href)="([^":#]+)"/g)) {
  const p = m[1];
  if (/^(https?:|data:|mailto:)/.test(p)) continue;
  if (!existsSync(join(root, p))) problems.push(`index.html 引用了不存在的文件: ${p}`);
}

for (const cls of ['ed-gutter', 'ed-bp', 'ed-lines', 'ed-body', 'ed-hl', 'ed-ta', 'ed-current']) {
  if (!html.includes(cls) && !editorJs.includes(cls)) problems.push(`编辑器结构缺少 ${cls}`);
  if (!css.includes(cls)) problems.push(`CSS 缺少 .${cls} 的样式`);
}

const allIds = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
const dup = [...new Set(allIds.filter((v, i) => allIds.indexOf(v) !== i))];
if (dup.length) problems.push(`id 重复: ${dup.join(', ')}`);

// class 方法表
function methodsOf(src, className) {
  const i = src.indexOf(`class ${className}`);
  if (i < 0) return new Set();
  let depth = 0, started = false, end = src.length;
  for (let k = i; k < src.length; k++) {
    const c = src[k];
    if (c === '{') { depth++; started = true; }
    else if (c === '}') { depth--; if (started && depth === 0) { end = k; break; } }
  }
  const body = src.slice(i, end);
  const out = new Set();
  for (const m of body.matchAll(/(?:^|\n)\s{2}(?:static\s+|get\s+|set\s+|async\s+|\*\s*)?([A-Za-z_$][\w$]*)\s*\(/g)) out.add(m[1]);
  for (const m of body.matchAll(/(?:^|\n)\s{2}(?:static\s+)?(?:get|set)\s+([A-Za-z_$][\w$]*)/g)) out.add(m[1]);
  return out;
}
const storeMethods = methodsOf(storeJs, 'Store');
const editorMethods = methodsOf(editorJs, 'CodeEditor');

function callsOn(code, varName, allow = []) {
  const out = new Set();
  const re = new RegExp(`\\b${varName}\\.([A-Za-z_$][\\w$]*)\\s*\\(`, 'g');
  for (const m of code.matchAll(re)) out.add(m[1]);
  for (const a of allow) out.delete(a);
  return out;
}

for (const m of callsOn(appCode, 'store')) {
  if (!storeMethods.has(m)) problems.push(`app.js 调用了 store.${m}()，但 js/store.js 的 Store 里没有这个方法`);
}
for (const m of callsOn(appCode, 'editor')) {
  if (!editorMethods.has(m)) problems.push(`app.js 调用了 editor.${m}()，但 js/editor.js 的 CodeEditor 里没有这个方法`);
}
for (const m of callsOn(appCode, 'ed')) {
  if (!editorMethods.has(m)) problems.push(`app.js 调用了 ed.${m}()，但 js/editor.js 的 CodeEditor 里没有这个方法`);
}

// Worker 协议对账
const sentTypes = new Set([...appCode.matchAll(/postMessage\(\s*\{\s*type:\s*'([^']+)'/g)].map((m) => m[1]));
const handledTypes = new Set([...strip(workerJs).matchAll(/msg\.type\s*===\s*'([^']+)'/g)].map((m) => m[1]));
for (const m of strip(workerJs).matchAll(/case\s*'([^']+)'\s*:/g)) handledTypes.add(m[1]);
for (const t of sentTypes) if (!handledTypes.has(t)) problems.push(`app.js 发送了未处理的 Worker 消息类型: ${t}`);
for (const t of handledTypes) if (!sentTypes.has(t)) problems.push(`worker.js 处理了但 app.js 从不发送的消息类型: ${t}（可能是漏调用）`);

// Worker 回传的消息类型，app.js 是否都在 handleWorkerMessage 里处理
const backTypes = new Set([...strip(workerJs).matchAll(/type:\s*'([^']+)'/g)].map((m) => m[1]));
const appHandled = new Set([...appCode.matchAll(/msg\.type\s*===\s*'([^']+)'/g)].map((m) => m[1]));
for (const m of appCode.matchAll(/case\s*'([^']+)'\s*:/g)) appHandled.add(m[1]);
for (const t of backTypes) {
  if (['start', 'input', 'eof', 'resume', 'stop'].includes(t)) continue;
  if (!appHandled.has(t)) problems.push(`worker.js 发出 ${t} 消息，但 app.js 没有处理`);
}

if (problems.length === 0) {
  console.log(`界面自检通过：${ids.size} 个 id、${referenced.size} 处引用、${panels.size} 个面板、${storeMethods.size} 个 Store 方法、${editorMethods.size} 个编辑器方法、Worker 协议一致`);
} else {
  console.log(`发现 ${problems.length} 个问题：`);
  for (const p of problems) console.log('  · ' + p);
  process.exitCode = 1;
}
