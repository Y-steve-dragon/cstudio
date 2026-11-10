// 掌心 C · 主程序：界面装配、运行/调试控制、文件与设置
import { Store, SAMPLES } from './store.js';
import { CodeEditor } from './editor.js';
import { createInlineEngine } from './inline-engine.js';

const $ = (id) => document.getElementById(id);
const store = new Store();

// 引擎常量（与 docs 中承诺的支持范围一致）
const ENGINE_VERSION = '1.0';
const DEFAULT_STEP_LIMIT = 30000000;
const DEFAULT_DEADLINE_MS = 30000;

let editor = null;
let worker = null;
let running = false;
let paused = false;
let sessionSeq = 0;
let lastRunWasDebug = false;
let outAtBottom = true;

// ───────────────────────────── 小工具 ─────────────────────────────
let toastTimer = null;
function toast(msg, ms = 1800) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  el.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => { el.hidden = true; }, 200);
  }, ms);
}

let modalResolve = null;
function modal({ title, bodyHTML, okText = '确定', cancelText = '取消', input = null, danger = false }) {
  return new Promise((resolve) => {
    $('modal-title').textContent = title;
    $('modal-body').innerHTML = bodyHTML;
    $('modal-ok').textContent = okText;
    $('modal-cancel').textContent = cancelText;
    $('modal-ok').classList.toggle('danger', !!danger);
    $('modal-cancel').hidden = cancelText === null;
    $('modal').hidden = false;
    $('mask').hidden = false;
    modalResolve = resolve;
    if (input) {
      const f = $('modal-body').querySelector('input,textarea');
      if (f) { f.focus(); f.select && f.select(); }
    }
  });
}
function closeModal(result) {
  $('modal').hidden = true;
  if (!paused) $('mask').hidden = true;
  const r = modalResolve;
  modalResolve = null;
  if (r) r(result);
}
$('modal-ok').addEventListener('click', () => {
  const inp = $('modal-body').querySelector('input,textarea');
  closeModal(inp ? inp.value : true);
});
$('modal-cancel').addEventListener('click', () => closeModal(null));
$('modal').addEventListener('click', (e) => { if (e.target === $('modal')) closeModal(null); });

async function promptText(title, value = '', hint = '') {
  const r = await modal({
    title,
    bodyHTML: `${hint ? `<div class="hint-line">${hint}</div>` : ''}<input class="modal-input" value="${String(value).replace(/"/g, '&quot;')}" autocapitalize="off" autocorrect="off" spellcheck="false">`,
    input: true,
  });
  return r === null ? null : String(r);
}
async function confirmBox(title, text, danger = true) {
  const r = await modal({
    title,
    bodyHTML: `<div class="hint-line">${text}</div>`,
    okText: danger ? '删除' : '确定',
    danger,
  });
  return r === true;
}

// ───────────────────────────── 主题 / 设置 ─────────────────────────────
function applyTheme() {
  document.documentElement.dataset.theme = store.settings.theme || 'dark';
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    meta.setAttribute('content', store.settings.theme === 'light' ? '#f5f7fa' : store.settings.theme === 'midnight' ? '#0b1220' : '#11161c');
  }
}

function bindSettings() {
  const s = store.settings;
  $('set-theme').value = s.theme;
  $('set-tab').value = String(s.tabSize);
  $('font-val').textContent = String(s.fontSize);
  $('set-indent').checked = s.autoIndent !== false;
  $('set-close').checked = s.autoClose !== false;
  $('set-wrap').checked = !!s.lineWrap;
  $('set-gutter').checked = s.showGutter !== false;
  $('set-symbar').checked = s.symbolBar !== false;

  $('set-theme').addEventListener('change', (e) => {
    store.setSetting('theme', e.target.value);
    applyTheme();
    toast('主题已切换');
  });
  $('set-tab').addEventListener('change', (e) => {
    store.setSetting('tabSize', Number(e.target.value));
    editor.applySettings(store.settings);
  });
  const setFont = (v) => {
    const n = Math.max(10, Math.min(32, v));
    store.setSetting('fontSize', n);
    $('font-val').textContent = String(n);
    editor.applySettings(store.settings);
  };
  $('font-dec').addEventListener('click', () => setFont(store.settings.fontSize - 1));
  $('font-inc').addEventListener('click', () => setFont(store.settings.fontSize + 1));
  const bindCheck = (id, key, after) => {
    $(id).addEventListener('change', (e) => {
      store.setSetting(key, e.target.checked);
      if (after) after();
    });
  };
  bindCheck('set-indent', 'autoIndent');
  bindCheck('set-close', 'autoClose');
  bindCheck('set-wrap', 'lineWrap', () => editor.applySettings(store.settings));
  bindCheck('set-gutter', 'showGutter', () => editor.applySettings(store.settings));
  bindCheck('set-symbar', 'symbolBar', () => { syncSymbarVisible(); });
  $('btn-clear-bp').addEventListener('click', () => {
    store.clearBreakpoints();
    editor.setBreakpoints([]);
    toast('断点已全部清除');
  });
}

// ───────────────────────────── 文件 ─────────────────────────────
function openFile(name) {
  if (store.getFile(name) === null) return;
  store.setActiveFile(name);
  $('cur-file').textContent = name;
  editor.setValue(store.getFile(name));
  editor.setPausedLine(0);
  editor.setErrorLine(0);
  editor.setBreakpoints(store.breakpointsOf(name));
  renderFiles();
  renderTabs();
  closeSidebar();
  updateDebugBarPos(null);
}

function renderFiles() {
  const list = $('file-list');
  list.innerHTML = '';
  for (const name of store.fileNames) {
    const li = document.createElement('li');
    li.className = 'file-row' + (name === store.activeFile ? ' active' : '');
    const bps = store.breakpointsOf(name).length;
    li.innerHTML = `
      <span class="f-ico">${name.endsWith('.h') ? '📎' : '📄'}</span>
      <span class="f-name" title="${name}">${name}</span>
      ${name === store.mainFile ? '<span class="badge">入口</span>' : ''}
      ${bps ? `<span class="bp-count">${bps}</span>` : ''}
      <button class="mini more" data-more="${name}" title="更多操作">⋯</button>`;
    li.querySelector('.f-name').addEventListener('click', () => openFile(name));
    li.querySelector('.f-ico').addEventListener('click', () => openFile(name));
    li.querySelector('[data-more]').addEventListener('click', (e) => {
      e.stopPropagation();
      fileMenu(name);
    });
    list.appendChild(li);
  }
  $('engine-ver').textContent = ENGINE_VERSION;
}

function renderTabs() {
  const tabs = $('tabs');
  const names = Object.keys(store.state.files).filter((n) => store.state.files[n] !== undefined);
  tabs.innerHTML = '';
  const ordered = [store.mainFile, ...names.filter((n) => n !== store.mainFile)];
  for (const n of ordered) {
    const b = document.createElement('button');
    b.className = 'tab' + (n === store.activeFile ? ' active' : '');
    b.innerHTML = `<span>${n}</span>${store.breakpointsOf(n).length ? '<i class="dot"></i>' : ''}`;
    b.addEventListener('click', () => openFile(n));
    tabs.appendChild(b);
  }
  tabs.hidden = ordered.length <= 1;
}

async function fileMenu(name) {
  const body = `
    <div class="menu-list">
      <button class="menu-item" data-act="open">打开</button>
      <button class="menu-item" data-act="main">设为入口文件（编译入口）</button>
      <button class="menu-item" data-act="rename">重命名</button>
      <button class="menu-item" data-act="download">下载到电脑</button>
      <button class="menu-item danger" data-act="delete">删除</button>
    </div>`;
  const modalP = modal({ title: name, bodyHTML: body, okText: '', cancelText: '关闭' });
  $('modal-ok').hidden = true;
  const box = $('modal-body');
  const done = (v) => { $('modal-ok').hidden = false; closeModal(v); };
  box.querySelectorAll('.menu-item').forEach((b) => {
    b.addEventListener('click', async () => {
      const act = b.dataset.act;
      if (act === 'open') { done(true); openFile(name); }
      else if (act === 'main') { store.setMainFile(name); renderFiles(); renderTabs(); toast(`${name} 已设为入口文件`); done(true); }
      else if (act === 'rename') {
        done(true);
        const nn = await promptText('重命名文件', name, '例如 hello.c / utils.h');
        if (!nn || nn === name) return;
        if (!/^[\w.\-\u4e00-\u9fa5]+$/.test(nn)) { toast('文件名不能包含特殊字符'); return; }
        if (!store.renameFile(name, nn)) { toast('重命名失败：同名文件已存在'); return; }
        openFile(nn);
        toast('已重命名');
      } else if (act === 'download') {
        done(true);
        downloadFile(name, store.getFile(name));
      } else if (act === 'delete') {
        done(true);
        if (Object.keys(store.state.files).length <= 1) { toast('至少要保留一个文件'); return; }
        if (!(await confirmBox('删除文件', `确定删除 ${name}？此操作不可撤销。`))) return;
        store.deleteFile(name);
        openFile(store.activeFile);
        toast('已删除');
      }
    });
  });
  await modalP;
}

function downloadFile(name, content) {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

async function newFile() {
  const name = await promptText('新建文件', 'program.c', '以 .c 结尾是 C 源文件，.h 是头文件');
  if (!name) return;
  if (!/^[\w.\-\u4e00-\u9fa5]+$/.test(name)) { toast('文件名不能包含特殊字符'); return; }
  if (store.getFile(name) !== null) { toast('同名文件已存在'); return; }
  const tpl = name.endsWith('.h')
    ? `#ifndef ${name.replace(/\W/g, '_').toUpperCase()}\n#define ${name.replace(/\W/g, '_').toUpperCase()}\n\n\n#endif\n`
    : `#include <stdio.h>\n\nint main(void)\n{\n    \n    return 0;\n}\n`;
  store.addFile(name, tpl);
  openFile(name);
  toast('已创建 ' + name);
}

function exportProject() {
  const data = {
    app: '掌心 C',
    version: ENGINE_VERSION,
    exportedAt: new Date().toISOString(),
    files: store.state.files,
    mainFile: store.mainFile,
    breakpoints: store.state.breakpoints,
  };
  const name = 'cstudio-project-' + new Date().toISOString().slice(0, 10) + '.json';
  downloadFile(name, JSON.stringify(data, null, 2));
  toast('已导出项目 JSON');
}

function importProject() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json,.c,.h,text/plain';
  input.addEventListener('change', async () => {
    const f = input.files && input.files[0];
    if (!f) return;
    const text = await f.text();
    if (/\.(c|h)$/i.test(f.name)) {
      // 直接当源码导入
      let name = f.name;
      let i = 1;
      while (store.getFile(name) !== null) name = f.name.replace(/(\.\w+)$/, `_${i++}$1`);
      store.addFile(name, text);
      openFile(name);
      toast('已导入 ' + name);
      return;
    }
    try {
      const data = JSON.parse(text);
      if (!data || typeof data.files !== 'object') throw new Error('缺少 files 字段');
      const names = Object.keys(data.files);
      if (!names.length) throw new Error('项目里没有文件');
      const ok = await confirmBox('导入项目', `将导入 ${names.length} 个文件并替换当前工作区，确定？`, false);
      if (!ok) return;
      store.state.files = data.files;
      store.state.mainFile = data.mainFile && data.files[data.mainFile] ? data.mainFile : names[0];
      store.state.breakpoints = data.breakpoints || {};
      store.state.activeFile = store.state.mainFile;
      store.saveNow();
      openFile(store.state.activeFile);
      toast('导入完成');
    } catch (e) {
      toast('导入失败：' + e.message, 2600);
    }
  });
  input.click();
}

// ───────────────────────────── 示例 ─────────────────────────────
function renderSamples() {
  const ul = $('sample-list');
  ul.innerHTML = '';
  for (const s of SAMPLES) {
    const li = document.createElement('li');
    li.className = 'sample-row';
    li.innerHTML = `<span>${s.name}</span><span class="s-file">${s.file}</span>`;
    li.addEventListener('click', async () => {
      const names = store.fileNames;
      let target = s.file;
      if (store.getFile(target) !== null) {
        let i = 2;
        while (store.getFile(target) !== null) target = s.file.replace(/(\.\w+)$/, `_${i++}$1`);
      }
      store.addFile(target, s.code);
      openFile(target);
      toast('已载入示例：' + s.name);
    });
    ul.appendChild(li);
  }
}

// ───────────────────────────── 符号栏 ─────────────────────────────
// 手机上打 {} [] ; " 很麻烦；但一排放不下，所以：可折叠 + 左右滚动（滑动/箭头/滚轮/拖动）。
const SYMBOLS = [
  { t: '    ', label: '⇥缩进', wide: true }, { t: '\n', label: '↵换行', wide: true },
  { t: '/*  */', label: '/* */', wide: true },
  { t: '{', label: '{' }, { t: '}', label: '}' }, { t: '(', label: '(' }, { t: ')', label: ')' },
  { t: '[', label: '[' }, { t: ']', label: ']' }, { t: ';', label: ';' }, { t: '"', label: '"' },
  { t: "'", label: "'" }, { t: ' = ', label: '=' }, { t: '+', label: '+' }, { t: '-', label: '−' },
  { t: '*', label: '*' }, { t: '/', label: '/' }, { t: '%', label: '%' }, { t: '<', label: '<' },
  { t: '>', label: '>' }, { t: '&', label: '&' }, { t: '|', label: '|' }, { t: '!', label: '!' },
  { t: '#', label: '#' }, { t: ' ? ', label: '?' }, { t: ' : ', label: ':' }, { t: ',', label: ',' },
  { t: '.', label: '.' }, { t: '->', label: '→' }, { t: ' == ', label: '==' }, { t: ' != ', label: '!=' },
  { t: ' && ', label: '&&' }, { t: ' || ', label: '||' }, { t: ' <= ', label: '<=' }, { t: ' >= ', label: '>=' },
  { t: ' += ', label: '+=' }, { t: ' -= ', label: '-=' }, { t: ' ++', label: '++' }, { t: ' --', label: '--' },
  { t: 'scanf("", );', label: 'scanf' }, { t: 'printf("", );', label: 'printf' }, { t: 'for (;;) {}', label: 'for' },
  { t: 'if () {}', label: 'if' }, { t: 'while () {}', label: 'while' }, { t: 'return ', label: 'return' },
];

let symbarBuilt = false;

function syncSymbarVisible() {
  const wrap = $('symbar-wrap');
  if (!wrap) return;
  wrap.hidden = store.settings.symbolBar === false;
  // 折叠状态也要在显示时同步（否则设置里关掉再打开会失效）
  wrap.dataset.open = store.settings.symbarOpen === false ? '0' : '1';
  syncSymbarChrome();
}

// 头栏文字/按钮的显示状态（收起时箭头没用，就别占位置）
function syncSymbarChrome() {
  const wrap = $('symbar-wrap');
  const fold = $('symbar-fold');
  const hint = $('symbar-hint');
  if (!wrap) return;
  const open = wrap.dataset.open !== '0';
  if (fold) {
    fold.textContent = open ? '收起 ▾' : '展开 ▴';
    fold.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  if (hint) {
    if (!open) hint.textContent = '已收起 · 点右侧「展开」';
    else hint.textContent = '左右滑动 · 点即插入';
  }
  if (open) updateSymbarNav();
}

function setSymbarOpen(open) {
  const wrap = $('symbar-wrap');
  if (!wrap) return;
  wrap.dataset.open = open ? '1' : '0';
  store.setSetting('symbarOpen', !!open);
  syncSymbarChrome();
}

function updateSymbarNav() {
  const bar = $('symbar');
  const prev = $('symbar-prev');
  const next = $('symbar-next');
  if (!bar || !prev || !next) return;
  const wrap = $('symbar-wrap');
  if (wrap && wrap.dataset.open === '0') return;   // 收起时不改头栏提示
  const max = bar.scrollWidth - bar.clientWidth;
  prev.disabled = bar.scrollLeft <= 2;
  next.disabled = bar.scrollLeft >= max - 2;
  const hint = $('symbar-hint');
  if (hint) hint.textContent = max > 8 ? '左右滑动 · 点即插入' : '点即插入';
}

function scrollSymbar(dir, page = 0.75) {
  const bar = $('symbar');
  if (!bar) return;
  // 用即时滚动而不是 smooth：箭头是"翻一页"的离散动作，手机上也更跟手，
  // 而且不会因为动画被打断而只挪几个像素。
  const step = Math.max(120, Math.round(bar.clientWidth * page));
  const max = bar.scrollWidth - bar.clientWidth;
  bar.scrollLeft = Math.max(0, Math.min(max, bar.scrollLeft + dir * step));
  updateSymbarNav();
}

function renderSymbols() {
  const bar = $('symbar');
  if (!bar) return;
  bar.innerHTML = '';
  for (const s of SYMBOLS) {
    const b = document.createElement('button');
    b.className = 'sym' + (s.wide ? ' wide' : '');
    b.type = 'button';
    b.textContent = s.label;
    b.title = s.t.trim() || s.label;

    const fire = () => {
      if (!editor) return;
      editor.focus();
      if (s.t === '/*  */') {
        const sel = editor.getSelection();
        const text = editor.value.slice(sel.start, sel.end);
        editor.replaceSelection('/* ' + text + ' */');
      } else {
        editor.insertText(s.t);
      }
      bar.dataset.touched = '1';
    };

    // 触屏：只有"点一下"才插入；手指滑过（横向拖动）交给浏览器滚动，
    // 否则整条符号栏在手机上根本滑不动。
    let sx = 0, sy = 0, st = 0, moved = false;
    b.addEventListener('touchstart', (e) => {
      const t = e.touches[0];
      sx = t.clientX; sy = t.clientY; st = Date.now(); moved = false;
    }, { passive: true });
    b.addEventListener('touchmove', (e) => {
      const t = e.touches[0];
      if (Math.abs(t.clientX - sx) > 8 || Math.abs(t.clientY - sy) > 8) moved = true;
    }, { passive: true });
    b.addEventListener('touchend', (e) => {
      if (moved || Date.now() - st > 700) return;   // 滑动或长按：滚动，不插入
      e.preventDefault();                            // 避免再触发一次 click
      fire();
    }, { passive: false });
    b.addEventListener('click', (e) => {
      if ('ontouchstart' in window) return;          // 触屏已由 touchend 处理
      e.preventDefault();
      fire();
    });
    bar.appendChild(b);
  }
  symbarBuilt = true;
  syncSymbarVisible();
  updateSymbarNav();
}

function bindSymbar() {
  const bar = $('symbar');
  const head = $('symbar-head');
  const fold = $('symbar-fold');
  if (!bar || !head || !fold) return;

  fold.addEventListener('click', () => setSymbarOpen($('symbar-wrap').dataset.open === '0'));
  // 点"符号"标题也能折叠（整条头栏点上去，但避开按钮）
  head.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    setSymbarOpen($('symbar-wrap').dataset.open === '0');
  });

  $('symbar-prev').addEventListener('click', () => scrollSymbar(-1));
  $('symbar-next').addEventListener('click', () => scrollSymbar(1));

  bar.addEventListener('scroll', updateSymbarNav, { passive: true });

  // 桌面：鼠标滚轮转成横向滚动
  bar.addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    const max = bar.scrollWidth - bar.clientWidth;
    if (max <= 0) return;
    bar.scrollLeft += e.deltaY;
    e.preventDefault();
  }, { passive: false });

  // 桌面：按住空白处拖动（手机上不需要，交给原生滚动）
  let dragging = false, startX = 0, startLeft = 0;
  bar.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch') return;
    if (e.target.closest('.sym')) return;
    dragging = true; startX = e.clientX; startLeft = bar.scrollLeft;
    bar.classList.add('grabbing');
  });
  window.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    bar.scrollLeft = startLeft - (e.clientX - startX);
  });
  window.addEventListener('pointerup', () => {
    if (!dragging) return;
    dragging = false;
    bar.classList.remove('grabbing');
  });

  // 键盘：在符号栏上左右箭头滚动
  bar.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') { scrollSymbar(1, 0.4); e.preventDefault(); }
    if (e.key === 'ArrowLeft') { scrollSymbar(-1, 0.4); e.preventDefault(); }
  });

  window.addEventListener('resize', updateSymbarNav);
}

// ───────────────────────────── 控制台 / 面板 ─────────────────────────────
function panelShow(name) {
  document.querySelectorAll('.ptab').forEach((b) => b.classList.toggle('active', b.dataset.panel === name));
  document.querySelectorAll('.console-body [data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== name; });
  $('console').dataset.open = 'true';
}
document.querySelectorAll('.ptab').forEach((b) => b.addEventListener('click', () => panelShow(b.dataset.panel)));
$('btn-toggle-console').addEventListener('click', () => {
  const el = $('console');
  el.dataset.open = el.dataset.open === 'true' ? 'false' : 'true';
  $('btn-toggle-console').textContent = el.dataset.open === 'true' ? '▾' : '▴';
});
$('btn-clear-out').addEventListener('click', () => { $('out').textContent = ''; });

function appendOut(text) {
  const el = $('out');
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  el.textContent += text;
  if (atBottom) el.scrollTop = el.scrollHeight;
}

function appendSystem(text) {
  appendOutText(text);
}
function appendOutText(text) {
  appendOut(text);
}

function setProblems(diagnostics) {
  const box = $('problems');
  const badge = $('problem-badge');
  box.innerHTML = '';
  const errs = diagnostics.filter((d) => d.severity !== 'warning');
  const warns = diagnostics.filter((d) => d.severity === 'warning');
  $('problem-badge').hidden = !errs.length;
  badge.textContent = String(errs.length);
  if (!diagnostics.length) {
    box.innerHTML = '<div class="empty">没有问题，代码看起来很干净 ✔</div>';
    return;
  }
  for (const d of [...errs, ...warns]) {
    const row = document.createElement('div');
    row.className = 'problem ' + (d.severity === 'warning' ? 'warn' : 'err');
    row.innerHTML = `<span class="p-ico">${d.severity === 'warning' ? '⚠' : '✖'}</span>
      <span class="p-msg">${escapeHTML(d.message)}</span>
      <span class="p-pos">${d.line ? `第 ${d.line} 行` : ''}</span>`;
    if (d.line) {
      row.addEventListener('click', () => {
        if (d.file && store.getFile(d.file) !== null && d.file !== store.activeFile) openFile(d.file);
        editor.setErrorLine(d.line);
        editor.gotoLine(d.line, { focus: true });
      });
    }
    box.appendChild(row);
  }
  if (errs.length) panelShow('problems');
}

function setVars(snapshot) {
  const box = $('vars');
  box.innerHTML = '';
  if (!snapshot) { box.innerHTML = '<div class="empty">运行到断点或单步时，这里会显示变量的值。</div>'; return; }
  const sec = (title, arr) => {
    if (!arr || !arr.length) return '';
    return `<div class="var-sec"><div class="var-head">${title}</div>` +
      arr.map((v) => `<div class="var-row"><span class="v-name">${escapeHTML(v.name)}</span>
        <span class="v-type">${escapeHTML(v.type)}</span>
        <span class="v-val">${escapeHTML(String(v.value))}</span></div>`).join('') + '</div>';
  };
  box.innerHTML = sec('局部变量', snapshot.vars) + sec('全局变量', snapshot.globals) ||
    '<div class="empty">没有可显示的变量</div>';
}

function setStack(snapshot) {
  const box = $('stack');
  box.innerHTML = '';
  if (!snapshot) { box.innerHTML = '<div class="empty">暂停时这里显示调用栈。</div>'; return; }
  const rows = snapshot.stack || [];
  if (!rows.length) { box.innerHTML = '<div class="empty">调用栈为空</div>'; return; }
  rows.forEach((f, i) => {
    const row = document.createElement('div');
    row.className = 'stack-row' + (i === 0 ? ' cur' : '');
    row.innerHTML = `<span class="s-idx">${i + 1}</span><span class="s-fn">${escapeHTML(f.name)}</span>
      <span class="s-pos">${escapeHTML(f.file || '')}:${f.line || '?'}</span>`;
    row.addEventListener('click', () => {
      if (f.file && store.getFile(f.file) !== null && f.file !== store.activeFile) openFile(f.file);
      if (f.line) editor.gotoLine(f.line, { focus: false });
    });
    box.appendChild(row);
  });
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function updateDebugBarPos(snapshot) {
  const el = $('dbg-pos');
  if (!snapshot) { el.textContent = '已暂停'; return; }
  el.textContent = `${snapshot.fn}() · 第 ${snapshot.line} 行 · 深度 ${snapshot.depth}`;
}

// ───────────────────────────── 引擎外壳管理 ─────────────────────────────
// 两条路：① 常规情况用 Web Worker（界面与引擎彻底隔离）；
// ② 单文件离线版 / file:// 打开时浏览器不允许 Worker，改用主线程内引擎（接口一致）。
// 地址后面加 ?inline=1 可以强制走②，方便自动化测试在虚拟时钟下稳定复现。
function wantsInlineEngine() {
  if (typeof window !== 'undefined' && window.__CSTUDIO_OFFLINE__) return true;
  if (typeof location !== 'undefined' && /(?:^|[?&])inline=1(?:&|$)/.test(location.search)) return true;
  return typeof location !== 'undefined' && location.protocol === 'file:';
}

function ensureWorker() {
  if (worker) return worker;
  if (wantsInlineEngine()) {
    worker = createInlineEngine();
    worker.onmessage = (ev) => handleWorkerMessage(ev.data || {});
    return worker;
  }
  worker = new Worker('engine/worker.js', { type: 'module' });
  worker.onmessage = (ev) => handleWorkerMessage(ev.data || {});
  worker.onerror = (e) => {
    appendOut(`\n[引擎错误] ${e.message || '未知错误'}\n`);
    finishRun();
  };
  return worker;
}

function killWorker() {
  if (worker) { worker.terminate(); worker = null; }
}

function setRunningUI(on) {
  running = on;
  $('btn-run').disabled = on;
  $('btn-debug').disabled = on;
  $('btn-stop').hidden = !on;
  document.body.classList.toggle('is-running', on);
}

function finishRun() {
  setRunningUI(false);
  paused = false;
  $('debugbar').hidden = true;
  $('mask').hidden = true;
  $('inputbar').hidden = true;
  updateDebugBarPos(null);
}

// ───────────────────────────── 运行 / 调试 ─────────────────────────────
function startRun(mode) {
  if (running) { toast('程序正在运行，先停止再试'); return; }
  if (!store.getFile(store.mainFile)) {
    toast('没有入口文件，请先在左侧选择或新建 .c 文件');
    return;
  }
  if (mode === 'debug' && !store.allBreakpoints().length) {
    toast('提示：先点击行号设置断点，调试会停在那里', 2200);
  }
  store.saveNow(); // 保证 worker 拿到最新代码
  lastRunWasDebug = mode === 'debug';
  sessionSeq++;
  const files = store.sourceFiles();
  ensureWorker();
  setRunningUI(true);
  panelShow('out');
  appendOut(`\n──── 开始${mode === 'debug' ? '调试' : '运行'} · ${new Date().toLocaleTimeString('zh-CN', { hour12: false })} ────\n`);
  worker.postMessage({
    type: 'start',
    files,
    main: store.mainFile,
    mode,
    breakpoints: store.allBreakpoints(),
    stepLimit: DEFAULT_STEP_LIMIT,
    deadlineMs: DEFAULT_DEADLINE_MS,
  });
}

function stopRun() {
  if (!running) return;
  if (worker) worker.postMessage({ type: 'stop' });
  appendOut('\n[已请求停止…]\n');
  // 兜底：1.2 秒后仍未收尾就强制终止 worker
  const seq = sessionSeq;
  setTimeout(() => {
    if (running && seq === sessionSeq) {
      killWorker();
      appendOut('[已强制终止程序]\n');
      finishRun();
    }
  }, 1200);
}

function resumeDebug(action) {
  if (!worker || !paused) return;
  const breakpoints = store.allBreakpoints();
  if (action === 'stop') { stopRun(); return; }
  paused = false;
  $('debugbar').hidden = true;
  editor.setPausedLine(0);
  worker.postMessage({ type: 'resume', action: { action, breakpoints } });
}

function handleWorkerMessage(msg) {
  switch (msg.type) {
    case 'compile': {
      setProblems(msg.diagnostics || []);
      if (msg.ok) {
        const warns = (msg.diagnostics || []).length;
        appendOut(`编译通过${warns ? `（${warns} 个警告）` : ''}，开始执行…\n`);
      } else {
        appendOut('编译失败：\n');
        for (const d of msg.diagnostics || []) {
          appendOut(`  ${d.severity === 'warning' ? '警告' : '错误'}${d.line ? `（第 ${d.line} 行）` : ''}: ${d.message}\n`);
        }
        const first = (msg.diagnostics || []).find((d) => d.line);
        if (first) {
          if (first.file && store.getFile(first.file) !== null && first.file !== store.activeFile) openFile(first.file);
          editor.setErrorLine(first.line);
          editor.gotoLine(first.line, { focus: false });
        }
      }
      break;
    }
    case 'out':
      appendOut(msg.text);
      break;
    case 'input-request': {
      const bar = $('inputbar');
      bar.hidden = false;
      $('stdin').value = '';
      $('stdin').placeholder = msg.prompt || '输入一行后回车';
      setTimeout(() => $('stdin').focus(), 30);
      break;
    }
    case 'paused': {
      paused = true;
      const snap = msg.snapshot;
      $('debugbar').hidden = false;
      $('mask').hidden = false;
      $('inputbar').hidden = true;
      if (snap.file && store.getFile(snap.file) !== null && snap.file !== store.activeFile) openFile(snap.file);
      editor.setPausedLine(snap.line);
      editor.gotoLine(snap.line, { focus: false });
      setVars(snap);
      setStack(snap);
      updateDebugBarPos(snap);
      panelShow('vars');
      toast(`暂停在第 ${snap.line} 行（${snap.fn}）`, 1200);
      break;
    }
    case 'resumed':
      paused = false;
      $('debugbar').hidden = true;
      $('mask').hidden = true;
      editor.setPausedLine(0);
      break;
    case 'exit':
      appendOut(`\n[程序结束，退出码 ${msg.code}]\n`);
      break;
    case 'error':
      appendOut(`\n[运行时错误] ${msg.error.message}${msg.error.line ? `（第 ${msg.error.line} 行）` : ''}\n`);
      if (msg.error.stack && msg.error.stack.length) {
        appendOut('调用栈：\n');
        msg.error.stack.forEach((f, i) => appendOut(`  #${i} ${f.name} 第 ${f.line || '?'} 行\n`));
      }
      if (msg.error.line) {
        if (msg.error.file && store.getFile(msg.error.file) !== null && msg.error.file !== store.activeFile) openFile(msg.error.file);
        editor.setErrorLine(msg.error.line);
        editor.gotoLine(msg.error.line, { focus: false });
      }
      break;
    case 'done': {
      const parts = [];
      if (msg.stopped) parts.push('已停止');
      else parts.push(msg.ok ? '运行结束' : '异常结束');
      if (msg.steps) parts.push(`${msg.steps.toLocaleString('zh-CN')} 步`);
      if (msg.ms !== undefined) parts.push(`${msg.ms} ms`);
      appendOut(`──── ${parts.join(' · ')} ────\n`);
      if (msg.internal) appendOut(`[内部错误] ${msg.internal}\n`);
      finishRun();
      break;
    }
    default:
      break;
  }
}

// 输入栏
$('btn-send').addEventListener('click', sendInputLine);
$('stdin').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); sendInputLine(); }
});
$('btn-eof').addEventListener('click', () => {
  if (worker) worker.postMessage({ type: 'eof' });
  $('inputbar').hidden = true;
});
function sendInputLine() {
  const inp = $('stdin');
  if (!worker || $('inputbar').hidden) return;
  worker.postMessage({ type: 'input', text: inp.value });
  inp.value = '';
  $('inputbar').hidden = true;
}

// 调试按钮
$('dbg-continue').addEventListener('click', () => resumeDebug('run'));
$('dbg-stepin').addEventListener('click', () => resumeDebug('stepIn'));
$('dbg-stepover').addEventListener('click', () => resumeDebug('stepOver'));
$('dbg-stepout').addEventListener('click', () => resumeDebug('stepOut'));
$('dbg-stop').addEventListener('click', () => resumeDebug('stop'));

$('btn-run').addEventListener('click', () => startRun('run'));
$('btn-debug').addEventListener('click', () => startRun('debug'));
$('btn-stop').addEventListener('click', stopRun);

// ───────────────────────────── 侧栏 / 查找 ─────────────────────────────
function openSidebar() { $('sidebar').classList.add('open'); $('mask').hidden = false; }
function closeSidebar() { $('sidebar').classList.remove('open'); if (!paused && $('modal').hidden) $('mask').hidden = true; }
$('btn-menu').addEventListener('click', () => {
  if ($('sidebar').classList.contains('open')) closeSidebar(); else openSidebar();
});
$('mask').addEventListener('click', () => {
  if ($('sidebar').classList.contains('open')) closeSidebar();
  if (!$('modal').hidden) closeModal(null);
});

$('btn-new-file').addEventListener('click', newFile);
$('btn-export').addEventListener('click', exportProject);
$('btn-import').addEventListener('click', importProject);

$('btn-search').addEventListener('click', () => toggleFind());
function toggleFind(force) {
  const bar = $('findbar');
  const show = force === undefined ? bar.hidden : force;
  bar.hidden = !show;
  if (show) {
    const sel = editor.value.slice(editor.getSelection().start, editor.getSelection().end);
    if (sel && !sel.includes('\n')) $('find-input').value = sel;
    $('find-input').focus();
  } else {
    editor.focus();
  }
}
$('find-next').addEventListener('click', () => {
  if (!editor.findNext($('find-input').value)) toast('没有找到匹配项');
});
$('find-prev').addEventListener('click', () => {
  if (!editor.findNext($('find-input').value, { backwards: true })) toast('没有找到匹配项');
});
$('find-replace').addEventListener('click', () => {
  const needle = $('find-input').value;
  if (!needle) return;
  const sel = editor.getSelection();
  const selected = editor.value.slice(sel.start, sel.end);
  if (selected === needle) {
    editor.replaceSelection($('replace-input').value);
    editor.findNext(needle);
  } else if (!editor.findNext(needle)) {
    toast('没有找到匹配项');
  }
});
$('find-replace-all').addEventListener('click', () => {
  const needle = $('find-input').value;
  if (!needle) return;
  const re = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
  const before = editor.value;
  const after = before.replace(re, $('replace-input').value);
  if (before === after) { toast('没有找到匹配项'); return; }
  const n = (before.match(re) || []).length;
  editor.setValue(after, { silent: false });
  toast(`已替换 ${n} 处`);
});
$('find-close').addEventListener('click', () => toggleFind(false));
$('find-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); editor.findNext($('find-input').value, { backwards: e.shiftKey }); }
  if (e.key === 'Escape') toggleFind(false);
});

// ───────────────────────────── 键盘快捷键 ─────────────────────────────
document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key === 'Enter') { e.preventDefault(); if (running) stopRun(); else startRun('run'); return; }
  if (mod && (e.key === 's' || e.key === 'S')) { e.preventDefault(); store.saveNow(); toast('已保存到本机'); return; }
  if (mod && (e.key === 'f' || e.key === 'F')) { e.preventDefault(); toggleFind(true); return; }
  if (e.key === 'F5') { e.preventDefault(); if (paused) resumeDebug('run'); else startRun('debug'); return; }
  if (e.key === 'F10') { e.preventDefault(); if (paused) resumeDebug('stepOver'); return; }
  if (e.key === 'F11') { e.preventDefault(); if (paused) resumeDebug(e.shiftKey ? 'stepOut' : 'stepIn'); return; }
  if (e.key === 'Escape') {
    if (paused) resumeDebug('stop');
    else if (!$('findbar').hidden) toggleFind(false);
  }
});

// 离开页面时保存
window.addEventListener('pagehide', () => store.saveNow());
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') store.saveNow(); });

// ───────────────────────────── 启动 ─────────────────────────────
function boot() {
  applyTheme();
  editor = new CodeEditor($('editor'), {
    settings: store.settings,
    onChange: (v) => store.setFile(store.activeFile, v),
    onBreakpoint: (line, on) => {
      store.toggleBreakpoint(store.activeFile, line);
      renderFiles();
      renderTabs();
      if (on) toast(`已设置断点：第 ${line} 行`, 900);
    },
    onRunShortcut: () => { if (running) stopRun(); else startRun('run'); },
  });
  bindSettings();
  renderFiles();
  renderTabs();
  renderSamples();
  renderSymbols();
  bindSymbar();
  setVars(null);
  setStack(null);
  openFile(store.activeFile);

  // 记录编辑器里最新的内容（多文件切换前先落盘）
  window.addEventListener('beforeunload', () => store.setFile(store.activeFile, editor.value));

  // 注册 Service Worker（离线可用）
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('离线缓存注册失败', e));
  }
  // 存储只能用内存时（file:// 直接打开常见）要明确提醒：代码不会自动留到下次
  if (store.storageKind === 'memory') {
    setTimeout(() => {
      appendOut('提示：当前环境不允许浏览器自动保存，代码只保留在本次打开期间。\n');
      appendOut('      请用左侧菜单的「下载 / 导出」把代码存成文件备份，别直接关掉页面。\n');
      toast('本环境不自动保存，记得导出代码', 4000);
    }, 600);
  }
  // 空闲时先预热引擎：等用户点「运行」时就不用再花时间加载引擎模块
  setTimeout(() => { try { ensureWorker(); } catch (e) { /* 预热失败不影响后续运行 */ } }, 500);
  document.title = '掌心 C · ' + store.activeFile;
}

boot();
