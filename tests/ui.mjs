// 界面层模块自检：store（本地存储/文件管理/断点）、highlight（高亮）、六个内置示例能否编译并运行
// 用法：node tests/ui.mjs
import { Store, SAMPLES, SAMPLE_INPUT } from '../js/store.js';
import { highlightC, countLines } from '../js/highlight.js';
import { compileSources, runSource } from '../engine/cengine.js';

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  failures.push(`${name}${detail ? ' —— ' + detail : ''}`);
}
function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(name, a === e, `期望 ${e}，实际 ${a}`);
}

// ── localStorage 桩 ──
class MemStorage {
  constructor() { this.map = new Map(); }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
  clear() { this.map.clear(); }
  key(i) { return [...this.map.keys()][i] ?? null; }
  get length() { return this.map.size; }
}

globalThis.localStorage = new MemStorage();
globalThis.setTimeout = globalThis.setTimeout;

// ── Store ──
{
  const s = new Store();
  ok('默认带一个 main.c', s.getFile('main.c') !== null);
  eq('默认入口文件', s.mainFile, 'main.c');
  eq('默认活动文件', s.activeFile, 'main.c');
  eq('默认字号', s.settings.fontSize, 14);

  ok('新建文件', s.addFile('a.c', 'int a;'));
  ok('不允许重名新建', s.addFile('a.c', 'x') === false);
  eq('文件列表把入口排前面', s.fileNames[0], 'main.c');
  ok('文件列表里有两个 .c', s.fileNames.filter((n) => n.endsWith('.c')).length === 2);

  s.setFile('a.c', 'int b;');
  eq('写文件后能读回', s.getFile('a.c'), 'int b;');

  s.setActiveFile('a.c');
  eq('切换活动文件', s.activeFile, 'a.c');

  s.toggleBreakpoint('a.c', 3);
  s.toggleBreakpoint('a.c', 7);
  eq('断点记录', s.breakpointsOf('a.c'), [3, 7]);
  eq('全部断点', s.allBreakpoints(), ['a.c:3', 'a.c:7']);
  s.toggleBreakpoint('a.c', 3);
  eq('再点一次取消断点', s.breakpointsOf('a.c'), [7]);

  ok('重命名文件', s.renameFile('a.c', 'b.c'));
  eq('重命名后内容还在', s.getFile('b.c'), 'int b;');
  eq('重命名后断点跟着走', s.breakpointsOf('b.c'), [7]);

  s.saveNow();
  const s2 = new Store();
  eq('重新打开后文件还在', s2.getFile('b.c'), 'int b;');
  eq('重新打开后断点还在', s2.breakpointsOf('b.c'), [7]);
  eq('重新打开后设置还在', s2.settings.fontSize, 14);

  ok('删除文件', s2.deleteFile('b.c'));
  ok('删光前最后一个不能删', (() => {
    const s3 = new Store();
    for (const n of s3.fileNames.slice(1)) s3.deleteFile(n);
    return s3.deleteFile(s3.fileNames[0]) === false;
  })());

  // 坏数据不应炸
  localStorage.setItem('cstudio.v1', '{不是 JSON');
  const quiet = console.warn;
  console.warn = () => {};
  const s4 = new Store();
  console.warn = quiet;
  ok('本地数据损坏时回落到默认内容', s4.getFile('main.c') !== null);
}

// ── 高亮 ──
{
  const src = '#include <stdio.h>\nint main(void) { int x = 42; /* 注释 */ char *s = "hi"; return 0; }';
  const html = highlightC(src);
  ok('高亮产生 span', html.includes('<span class="t-kw"'));
  ok('预处理行被标为 t-pp', html.includes('t-pp'));
  ok('字符串被标为 t-str', html.includes('t-str'));
  ok('注释被标为 t-com', html.includes('t-com'));
  ok('数字被标为 t-num', html.includes('t-num'));
  ok('高亮不改变原文（去掉标签与转义后能找到原文片段）',
    html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').includes('#include <stdio.h>'));
  eq('行数', countLines('a\nb\nc'), 3);
  eq('空文本算 1 行', countLines(''), 1);
  eq('结尾换行后编辑器还有一个空行', countLines('a\n'), 2);
  const tricky = `char *s = "未闭合";
int x = 1`;
  ok('未闭合字符串不会抛异常', typeof highlightC(tricky) === 'string');
}

// ── 六个内置示例都要能编译 ──
const inputs = {
  '交互输入': ['12 34', 'abc'],
};
for (const sample of SAMPLES) {
  const files = { 'main.c': sample.code };
  const c = compileSources(files, 'main.c');
  ok(`示例「${sample.name}」能编译通过`, c.ok, (c.diagnostics || []).map((d) => `${d.line}: ${d.message}`).join('; '));
  if (!c.ok) continue;
  const r = await runSource(sample.code, { input: inputs[sample.name] || [], echo: !!inputs[sample.name] });
  ok(`示例「${sample.name}」能正常运行`, r.ok, r.error || '');
  ok(`示例「${sample.name}」有输出`, r.output.trim().length > 0, '输出为空');
}

// 交互示例的输出要包含输入回显与结果
{
  const r = await runSource(SAMPLE_INPUT, { input: ['12 34', 'abc'], echo: true });
  ok('交互示例打印了和', r.output.includes('46'), r.output);
}

console.log('');
if (fail === 0) {
  console.log(`界面层自检通过：${pass} 项`);
} else {
  console.log(`界面层自检：${pass} 通过，${fail} 失败`);
  for (const f of failures) console.log('  ✗ ' + f);
  process.exitCode = 1;
}
