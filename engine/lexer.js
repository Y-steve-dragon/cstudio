// 掌心 C · 词法分析器
import { CompileError, toBytes } from './core.js';

const PUNCTS = [
  '...', '<<=', '>>=',
  '->', '++', '--', '<<', '>>', '<=', '>=', '==', '!=', '&&', '||',
  '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '##',
  '+', '-', '*', '/', '%', '=', '<', '>', '!', '&', '|', '^', '~', '?', ':',
  ';', ',', '.', '(', ')', '[', ']', '{', '}', '#', '\\',
];
PUNCTS.sort((a, b) => b.length - a.length);

const isDigit = (c) => c >= '0' && c <= '9';
const isAlpha = (c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c === '$';
const isAlnum = (c) => isAlpha(c) || isDigit(c);
const isHex = (c) => isDigit(c) || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');

function unescapeChar(s, i, err) {
  const c = s[i];
  switch (c) {
    case 'n': return ['\n', i + 1];
    case 't': return ['\t', i + 1];
    case 'r': return ['\r', i + 1];
    case '0': case '1': case '2': case '3': case '4': case '5': case '6': case '7': {
      let j = i, v = 0, n = 0;
      while (n < 3 && j < s.length && s[j] >= '0' && s[j] <= '7') { v = v * 8 + (s.charCodeAt(j) - 48); j++; n++; }
      return [String.fromCharCode(v & 0xff), j];
    }
    case 'x': {
      let j = i + 1, v = 0, n = 0;
      while (j < s.length && isHex(s[j])) { v = v * 16 + parseInt(s[j], 16); j++; n++; }
      if (!n) err('\\x 后面缺少十六进制数字');
      return [String.fromCharCode(v & 0xff), j];
    }
    case 'a': return ['\x07', i + 1];
    case 'b': return ['\b', i + 1];
    case 'f': return ['\f', i + 1];
    case 'v': return ['\v', i + 1];
    case 'e': return ['\x1b', i + 1];
    case '\\': return ['\\', i + 1];
    case "'": return ["'", i + 1];
    case '"': return ['"', i + 1];
    case '?': return ['?', i + 1];
    case '\n': return ['', i + 1];
    default: return [c, i + 1];
  }
}

/**
 * @param {string} src  预处理后的源码（行结构保持）
 * @param {(idx:number)=>{file:string,line:number}} posOf  行号映射
 */
export function tokenize(src, posOf) {
  const toks = [];
  let i = 0, line = 1, lineStart = 0;
  const n = src.length;

  function here() {
    const p = posOf ? posOf(line) : { file: '<main>', line };
    return { file: p.file, line: p.line, col: i - lineStart + 1 };
  }
  function err(msg) {
    const h = here();
    throw new CompileError(msg, h.line, h.col, h.file);
  }

  while (i < n) {
    let c = src[i];
    if (c === '\n') { line++; i++; lineStart = i; continue; }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v') { i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') {
      const startLine = line, h = here();
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') { line++; lineStart = i + 1; } i++; }
      if (i >= n) throw new CompileError('未闭合的注释 /* ... */', h.line, h.col, h.file);
      i += 2;
      if (line !== startLine) { /* 行号已跟踪 */ }
      continue;
    }
    const h = here();

    // 标识符
    if (isAlpha(c)) {
      let j = i + 1;
      while (j < n && isAlnum(src[j])) j++;
      toks.push({ k: 'id', v: src.slice(i, j), ...h });
      i = j; continue;
    }
    // 数字
    if (isDigit(c) || (c === '.' && isDigit(src[i + 1]))) {
      let j = i, isF = false, val;
      if (c === '0' && (src[i + 1] === 'x' || src[i + 1] === 'X')) {
        j = i + 2;
        while (j < n && (isHex(src[j]) || src[j] === '.')) j++;
        if (src[j] === '.') { isF = true; j++; while (j < n && isHex(src[j])) j++; }
        val = isF ? parseInt('0x' + src.slice(i + 2, j).replace('.', ''), 16) : parseInt(src.slice(i, j), 16);
        if (j < n && src[j] === 'p') { isF = true; j++; if (src[j] === '+' || src[j] === '-') j++; while (isDigit(src[j])) j++; }
      } else if (c === '0' && (src[i + 1] === 'b' || src[i + 1] === 'B')) {
        j = i + 2;
        while (j < n && (src[j] === '0' || src[j] === '1')) j++;
        val = parseInt(src.slice(i + 2, j), 2);
      } else {
        j = i;
        while (j < n && isDigit(src[j])) j++;
        if (src[j] === '.') { isF = true; j++; while (j < n && isDigit(src[j])) j++; }
        if (src[j] === 'e' || src[j] === 'E') {
          let k = j + 1;
          if (src[k] === '+' || src[k] === '-') k++;
          if (isDigit(src[k])) { isF = true; j = k; while (j < n && isDigit(src[j])) j++; }
        }
        const body = src.slice(i, j);
        if (!isF && body.length > 1 && body[0] === '0' && /^[0-7]+$/.test(body)) val = parseInt(body, 8);
        else val = isF ? parseFloat(body) : Number(body);
      }
      // 后缀
      let suf = '';
      while (j < n && /[uUlLfF]/.test(src[j])) { suf += src[j]; j++; }
      if (/[fF]/.test(suf) && !isF) isF = true;
      if (!Number.isFinite(val)) err(`无法解析的数字字面量 ${src.slice(i, j)}`);
      toks.push({
        k: 'num', v: val, isFloat: isF,
        u: /[uU]/.test(suf), l: /[lL]{2}/.test(suf) ? 2 : /[lL]/.test(suf) ? 1 : 0,
        f: /[fF]/.test(suf) ? 4 : (isF ? 8 : 0),
        ...h,
      });
      i = j; continue;
    }
    // 字符串
    if (c === '"') {
      let j = i + 1, out = '';
      while (j < n && src[j] !== '"') {
        if (src[j] === '\n') { throw new CompileError('字符串字面量未闭合（缺少结束的 "）', h.line, h.col, h.file); }
        if (src[j] === '\\') {
          const [ch, nj] = unescapeChar(src, j + 1, err);
          out += ch; j = nj;
        } else if (src.charCodeAt(j) < 0x80) {
          out += src[j]; j++;
        } else {
          // 源码里的中文等非 ASCII 字符：按 UTF-8 编码成字节串（与 C 编译器行为一致）
          const cp = src.codePointAt(j);
          const chStr = String.fromCodePoint(cp);
          const bytes = toBytes(chStr);
          for (let k = 0; k < bytes.length; k++) out += bytes[k];
          j += chStr.length;
        }
      }
      if (j >= n) throw new CompileError('字符串字面量未闭合（缺少结束的 "）', h.line, h.col, h.file);
      toks.push({ k: 'str', v: out, ...h });
      i = j + 1; continue;
    }
    // 字符常量
    if (c === "'") {
      let j = i + 1, v = 0;
      if (src[j] === '\\') {
        const [ch, nj] = unescapeChar(src, j + 1, err);
        v = ch.length ? ch.charCodeAt(0) : 0; j = nj;
      } else if (src[j] === "'") {
        err('空字符常量');
      } else {
        v = src.charCodeAt(j); j++;
      }
      if (src[j] !== "'") throw new CompileError('字符常量格式错误（应形如 \'a\'）', h.line, h.col, h.file);
      toks.push({ k: 'chr', v, ...h });
      i = j + 1; continue;
    }
    // 标点
    let matched = null;
    for (const p of PUNCTS) { if (src.startsWith(p, i)) { matched = p; break; } }
    if (!matched) err(`无法识别的字符 '${c}'（0x${c.charCodeAt(0).toString(16)}）`);
    toks.push({ k: 'punct', v: matched, ...h });
    i += matched.length;
  }
  const last = posOf ? posOf(line) : { file: '<main>', line };
  toks.push({ k: 'eof', v: '<文件结尾>', file: last.file, line: last.line, col: 1 });
  return toks;
}
