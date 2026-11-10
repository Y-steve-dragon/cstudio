// 掌心 C · 预处理器（#include / #define / #if 条件编译 / 宏展开）
import { CompileError } from './core.js';

/** 内置标准头文件：不真正读文件，只记录用了哪些（运行库始终可用） */
export const BUILTIN_HEADERS = new Set([
  'stdio.h', 'stdlib.h', 'string.h', 'math.h', 'ctype.h', 'stdbool.h', 'limits.h', 'float.h',
  'stdint.h', 'stddef.h', 'stdarg.h', 'time.h', 'assert.h', 'errno.h', 'conio.h', 'iso646.h',
  'inttypes.h', 'signal.h', 'locale.h', 'setjmp.h', 'wchar.h', 'stdnoreturn.h',
]);

const isAlpha = (c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c === '$';
const isDigit = (c) => c >= '0' && c <= '9';
const isAlnum = (c) => isAlpha(c) || isDigit(c);

// ───────────── pp-token ─────────────
const PP_PUNCT = [
  '...', '<<=', '>>=', '->', '++', '--', '<<', '>>', '<=', '>=', '==', '!=', '&&', '||',
  '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '##',
  '+', '-', '*', '/', '%', '=', '<', '>', '!', '&', '|', '^', '~', '?', ':', ';', ',', '.',
  '(', ')', '[', ']', '{', '}', '#',
];

function ppTokens(s) {
  const out = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (isAlpha(c)) {
      let j = i + 1;
      while (j < n && isAlnum(s[j])) j++;
      out.push({ t: 'id', text: s.slice(i, j) }); i = j; continue;
    }
    if (isDigit(c) || (c === '.' && isDigit(s[i + 1]))) {
      let j = i + 1;
      while (j < n) {
        const d = s[j];
        if ((d === 'e' || d === 'E' || d === 'p' || d === 'P') && (s[j + 1] === '+' || s[j + 1] === '-')) { j += 2; continue; }
        if (/[0-9a-zA-Z_.]/.test(d)) { j++; continue; }
        break;
      }
      out.push({ t: 'num', text: s.slice(i, j) }); i = j; continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && s[j] !== c) { if (s[j] === '\\') j += 2; else j++; }
      j++;
      out.push({ t: c === '"' ? 'str' : 'chr', text: s.slice(i, j) }); i = j; continue;
    }
    let m = null;
    for (const p of PP_PUNCT) if (s.startsWith(p, i)) { m = p; break; }
    if (!m) { out.push({ t: 'other', text: c }); i++; continue; }
    out.push({ t: 'punct', text: m }); i += m.length; continue;
  }
  return out;
}
function ppJoin(toks) {
  let s = '';
  for (const t of toks) { if (!t.nospace) s += ' '; s += t.text; }
  return s.trimStart();
}

/** 去掉注释，保留换行（注释替换为一个空格） */
export function stripComments(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && text[j] !== c) { if (text[j] === '\\') j++; j++; }
      out += text.slice(i, Math.min(j + 1, n)); i = j + 1; continue;
    }
    if (c === '/' && text[i + 1] === '/') { while (i < n && text[i] !== '\n') i++; continue; }
    if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) { if (text[i] === '\n') out += '\n'; i++; }
      i += 2; out += ' '; continue;
    }
    out += c; i++;
  }
  return out;
}

// ───────────── #if 表达式求值 ─────────────
function evalPPExpr(text, definedNames) {
  const toks = ppTokens(text);
  const items = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.t === 'id' && t.text === 'defined') {
      let name = null;
      if (toks[i + 1] && toks[i + 1].text === '(') {
        name = toks[i + 2] ? toks[i + 2].text : null; i += 3;
      } else { name = toks[i + 1] ? toks[i + 1].text : null; i += 1; }
      items.push({ type: 'num', v: definedNames.has(name) ? 1 : 0 });
      continue;
    }
    if (t.t === 'num') {
      let v;
      const s = t.text.replace(/[uUlL]+$/, '');
      if (/^0[xX]/.test(s)) v = parseInt(s, 16);
      else if (/^0[bB]/.test(s)) v = parseInt(s.slice(2), 2);
      else if (/^0[0-7]+$/.test(s)) v = parseInt(s, 8);
      else v = Number(s) || 0;
      items.push({ type: 'num', v });
      continue;
    }
    if (t.t === 'id') { items.push({ type: 'num', v: 0 }); continue; } // 未定义标识符按标准视作 0
    if (t.t === 'chr') {
      const m = /^'(.*)'$/s.exec(t.text);
      items.push({ type: 'num', v: m ? m[1].charCodeAt(m[1].length - 1) : 0 });
      continue;
    }
    items.push({ type: 'op', v: t.text });
  }
  let p = 0;
  const peek = () => items[p];
  const eat = (v) => (peek() && peek().type === 'op' && peek().v === v ? (p++, true) : false);
  function primary() {
    const it = items[p];
    if (!it) return 0;
    if (it.type === 'num') { p++; return it.v; }
    if (it.v === '(') { p++; const v = ternary(); eat(')'); return v; }
    if (it.v === '!') { p++; return primary() ? 0 : 1; }
    if (it.v === '-') { p++; return -primary(); }
    if (it.v === '+') { p++; return primary(); }
    if (it.v === '~') { p++; return ~primary(); }
    p++; return 0;
  }
  const bin = (next, table) => {
    let l = next();
    for (;;) {
      const t = peek();
      if (!t || t.type !== 'op') return l;
      const f = table[t.v];
      if (!f) return l;
      p++; l = f(l, next());
    }
  };
  const mul = () => bin(primary, { '*': (a, b) => a * b, '/': (a, b) => (b === 0 ? 0 : Math.trunc(a / b)), '%': (a, b) => (b === 0 ? 0 : a % b) });
  const add = () => bin(mul, { '+': (a, b) => a + b, '-': (a, b) => a - b });
  const shift = () => bin(add, { '<<': (a, b) => a << b, '>>': (a, b) => a >> b });
  const rel = () => bin(shift, { '<': (a, b) => (a < b ? 1 : 0), '>': (a, b) => (a > b ? 1 : 0), '<=': (a, b) => (a <= b ? 1 : 0), '>=': (a, b) => (a >= b ? 1 : 0) });
  const eq = () => bin(rel, { '==': (a, b) => (a === b ? 1 : 0), '!=': (a, b) => (a !== b ? 1 : 0) });
  const band = () => bin(eq, { '&': (a, b) => a & b });
  const bxor = () => bin(band, { '^': (a, b) => a ^ b });
  const bor = () => bin(bxor, { '|': (a, b) => a | b });
  const land = () => bin(bor, { '&&': (a, b) => (a && b ? 1 : 0) });
  const lor = () => bin(land, { '||': (a, b) => (a || b ? 1 : 0) });
  function ternary() {
    const c = lor();
    if (peek() && peek().v === '?') { p++; const a = ternary(); eat(':'); const b = ternary(); return c ? a : b; }
    return c;
  }
  try { return ternary(); } catch { return 0; }
}

// ───────────── 主流程 ─────────────
/**
 * @param {string} mainName 主文件名
 * @param {Map<string,string>} files 工程内所有文件（名→内容）
 * @returns {{text:string, posOf:Function, includes:Set<string>, warnings:Array}}
 */
export function preprocess(mainName, files, opts = {}) {
  const out = [];              // {text, file, line}
  const macros = new Map();    // name → {params:null|string[], body: token[], fn:boolean}
  const includes = new Set();
  const warnings = [];
  const onceFiles = new Set();

  const emit = (text, file, line) => out.push({ text, file, line });

  function warn(msg, file, line) { warnings.push({ message: msg, file, line }); }

  function processText(name, rawText) {
    const text = stripComments(rawText.replace(/\r\n?/g, '\n'));
    const phys = text.split('\n');
    const lines = [];   // {text, line}
    for (let i = 0; i < phys.length; i++) {
      let s = phys[i], start = i + 1;
      while (/\\\s*$/.test(s) && i + 1 < phys.length) {
        s = s.replace(/\\\s*$/, '') + phys[i + 1];
        i++;
      }
      lines.push({ text: s, line: start });
    }

    // 条件编译栈
    const stack = [];
    let active = true;

    for (const ln of lines) {
      const trimmed = ln.text.trim();
      if (!trimmed.startsWith('#')) {
        if (!active) { emit('', name, ln.line); continue; }
        emit(ppJoin(expand(ppTokens(ln.text), macros, 0, new Set())), name, ln.line);
        continue;
      }
      const m = /^#\s*([A-Za-z_]\w*)?(.*)$/s.exec(trimmed);
      const dir = (m[1] || '').toLowerCase();
      const rest = (m[2] || '').trim();

      if (dir === 'if' || dir === 'ifdef' || dir === 'ifndef') {
        let cond = false;
        if (active) {
          if (dir === 'ifdef') cond = macros.has(rest.split(/\s+/)[0]);
          else if (dir === 'ifndef') cond = !macros.has(rest.split(/\s+/)[0]);
          else {
            const expanded = readyIfExpr(rest);
            cond = evalPPExpr(expanded, macros) !== 0;
          }
        }
        stack.push({ parent: active, taken: active && cond, active: active && cond });
        active = active && cond;
        emit('', name, ln.line);
        continue;
      }
      if (dir === 'elif') {
        const top = stack[stack.length - 1];
        if (!top) { warn('#elif 没有对应的 #if', name, ln.line); emit('', name, ln.line); continue; }
        const cond = top.parent && !top.taken ? evalPPExpr(readyIfExpr(rest), macros) !== 0 : false;
        top.active = top.parent && !top.taken && cond;
        active = top.active;
        if (top.active) top.taken = true;
        emit('', name, ln.line);
        continue;
      }
      if (dir === 'else') {
        const top = stack[stack.length - 1];
        if (!top) { warn('#else 没有对应的 #if', name, ln.line); emit('', name, ln.line); continue; }
        top.active = top.parent && !top.taken;
        if (top.active) top.taken = true;
        active = top.active;
        emit('', name, ln.line);
        continue;
      }
      if (dir === 'endif') {
        const top = stack.pop();
        if (!top) warn('#endif 没有对应的 #if', name, ln.line);
        active = top ? top.parent : true;
        emit('', name, ln.line);
        continue;
      }
      if (!active) { emit('', name, ln.line); continue; }

      if (dir === 'include') {
        const im = /^[<"]([^>"]+)[>"]/.exec(rest);
        if (!im) {
          emit('', name, ln.line);
          throw new CompileError('错误的 #include 写法（应形如 #include <stdio.h>）', ln.line, 1, name);
        }
        const target = im[1];
        if (target === 'assert.h') { /* ok */ }
        if (files.has(target)) {
          if (onceFiles.has(target) && opts.pragmaOnce) { emit('', name, ln.line); continue; }
          onceFiles.add(target);
          processText(target, files.get(target));
          emit('', name, ln.line);
          continue;
        }
        if (BUILTIN_HEADERS.has(target)) { includes.add(target); emit('', name, ln.line); continue; }
        // 猜一下：可能引用了工程里的其它文件
        throw new CompileError(`找不到头文件 "${target}"（工程内没有这个文件；本引擎内置：stdio.h stdlib.h string.h math.h ctype.h stdbool.h limits.h stdint.h time.h conio.h 等）`, ln.line, 1, name);
      }
      if (dir === 'define') {
        const dm = /^([A-Za-z_]\w*)(\()?/.exec(rest);
        if (!dm) { warn('无效的 #define', name, ln.line); emit('', name, ln.line); continue; }
        const mname = dm[1];
        if (dm[2] === '(') {
          const closeIdx = rest.indexOf(')');
          if (closeIdx < 0) { warn('宏参数列表缺少 )', name, ln.line); emit('', name, ln.line); continue; }
          const plist = rest.slice(dm[0].length, closeIdx).split(',').map((s) => s.trim()).filter((s) => s.length);
          const body = ppTokens(rest.slice(closeIdx + 1));
          macros.set(mname, { name: mname, fn: true, params: plist, body });
        } else {
          macros.set(mname, { name: mname, fn: false, params: null, body: ppTokens(rest.slice(dm[0].length)) });
        }
        emit('', name, ln.line);
        continue;
      }
      if (dir === 'undef') {
        macros.delete(rest.split(/\s+/)[0]);
        emit('', name, ln.line); continue;
      }
      if (dir === 'error') {
        throw new CompileError(`#error ${rest}`, ln.line, 1, name);
      }
      if (dir === 'warning') { warn(`#warning ${rest}`, name, ln.line); emit('', name, ln.line); continue; }
      if (dir === 'pragma') {
        if (rest.startsWith('once')) onceFiles.add(name);
        emit('', name, ln.line); continue;
      }
      if (dir === 'line' || dir === '' || dir === 'include_next') { emit('', name, ln.line); continue; }
      warn(`不支持的预处理指令 #${dir}（已忽略）`, name, ln.line);
      emit('', name, ln.line);
    }
    if (stack.length) warn('存在未闭合的 #if（缺少 #endif）', name, lines.length);
  }

  function readyIfExpr(rest) {
    // 先把 defined(NAME) / defined NAME 固化成 0/1，再展开其余宏
    const toks = ppTokens(rest);
    const pre = [];
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t.t === 'id' && t.text === 'defined') {
        let nm = null;
        if (toks[i + 1] && toks[i + 1].text === '(') { nm = toks[i + 2] && toks[i + 2].text; i += 3; }
        else { nm = toks[i + 1] && toks[i + 1].text; i += 1; }
        pre.push({ t: 'num', text: macros.has(nm) ? '1' : '0' });
        continue;
      }
      pre.push(t);
    }
    return ppJoin(expand(pre, macros, 0, new Set()));
  }

  processText(mainName, files.get(mainName) ?? '');
  const text = out.map((l) => l.text).join('\n');
  const posOf = (lineNo) => {
    const e = out[lineNo - 1];
    return e ? { file: e.file, line: e.line } : { file: mainName, line: lineNo };
  };
  return { text, posOf, includes, warnings };
}

/** 宏展开：object-like / function-like，支持 # 字符串化与 ## 粘接 */
function expand(toks, macros, depth, active) {
  if (depth > 64) return toks;
  const out = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.t !== 'id' || !macros.has(t.text) || active.has(t.text)) { out.push(t); continue; }
    const mac = macros.get(t.text);
    if (!mac.fn) {
      const na = new Set(active); na.add(mac.name);
      const body = mac.body.map((x) => ({ ...x }));
      out.push(...expand(body, macros, depth + 1, na));
      continue;
    }
    // 函数宏：必须紧跟 '('
    let j = i + 1;
    if (!toks[j] || toks[j].text !== '(') { out.push(t); continue; }
    // 收集实参（括号配平）
    let level = 0, args = [[]];
    let k = j;
    for (; k < toks.length; k++) {
      const tk = toks[k];
      if (tk.text === '(') { level++; if (level === 1) continue; }
      else if (tk.text === ')') { level--; if (level === 0) break; }
      else if (tk.text === ',' && level === 1) { args.push([]); continue; }
      args[args.length - 1].push(tk);
    }
    if (k >= toks.length) { out.push(t); continue; }
    const na = new Set(active); na.add(mac.name);
    // 参数替换
    const subst = [];
    const body = mac.body;
    for (let b = 0; b < body.length; b++) {
      const bt = body[b];
      const prev = body[b - 1], next = body[b + 1];
      if (bt.t === 'punct' && bt.text === '#' && next && next.t === 'id' && mac.params.includes(next.text)) {
        const idx = mac.params.indexOf(next.text);
        const raw = ppJoin(args[idx] || []);
        subst.push({ t: 'str', text: '"' + raw.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"' });
        b++; continue;
      }
      if (bt.t === 'id' && mac.params.includes(bt.text)) {
        const idx = mac.params.indexOf(bt.text);
        const arg = args[idx] || [];
        if (prev && prev.t === 'punct' && prev.text === '##') {
          for (const a of arg) subst.push({ ...a, nospace: true });
        } else if (next && next.t === 'punct' && next.text === '##') {
          for (const a of arg) subst.push({ ...a });
        } else {
          subst.push(...expand(arg.map((x) => ({ ...x })), macros, depth + 1, na));
        }
        continue;
      }
      if (bt.t === 'punct' && bt.text === '##') {
        const left = subst.pop();
        const right = body[++b];
        if (left && right) {
          const merged = (left.text || '') + (right.text || '');
          subst.push({ t: 'id', text: merged, nospace: true });
        }
        continue;
      }
      subst.push({ ...bt });
    }
    out.push(...expand(subst, macros, depth + 1, na));
    i = k;
  }
  // 重新输出为文本片段（保持 token 顺序，用空格分隔）
  return out;
}

/** expand 返回 token 数组，这里导出把 token 数组变文本的辅助（供内部 emit 使用） */
export function tokensToText(toks) { return ppJoin(toks); }
