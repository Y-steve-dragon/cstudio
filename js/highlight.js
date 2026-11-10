// 掌心 C · C 语言语法高亮（把源码转成带 <span class="t-xxx"> 的 HTML）
const KEYWORDS = new Set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'break', 'continue',
  'return', 'goto', 'sizeof', 'typedef', 'struct', 'union', 'enum', 'static', 'extern',
  'const', 'volatile', 'register', 'auto', 'inline', 'restrict', 'sizeof',
]);

const TYPES = new Set([
  'void', 'char', 'short', 'int', 'long', 'float', 'double', 'signed', 'unsigned',
  '_Bool', 'bool', 'size_t', 'ssize_t', 'ptrdiff_t', 'wchar_t', 'int8_t', 'int16_t',
  'int32_t', 'int64_t', 'uint8_t', 'uint16_t', 'uint32_t', 'uint64_t', 'FILE', 'va_list',
  'time_t', 'clock_t', 'NULL',
]);

const PREPROC = /^[ \t]*#[ \t]*[A-Za-z_]+/;

function esc(s) {
  return s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
}

const TOKEN_RE = new RegExp(
  [
    '(\\/\\*[\\s\\S]*?(?:\\*\\/|$))',            // 1 块注释
    '(\\/\\/[^\\n]*)',                            // 2 行注释
    '("(?:\\\\.|[^"\\\\\\n])*"?|\\d*"(?:\\\\.|[^"\\\\\\n])*"?)', // 3 字符串（含 L".." 前缀粗略处理）
    "('(?:\\\\.|[^'\\\\\\n])*'?)",                // 4 字符
    '((?:0[xX][0-9a-fA-F]+|(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][+-]?\\d+)?)[uUlLfF]*)', // 5 数字
    '([A-Za-z_]\\w*)',                            // 6 标识符
    '(\\s+)',                                     // 7 空白
    '([\\s\\S])',                                 // 8 其他
  ].join('|'),
  'g'
);

/**
 * 高亮一段 C 源码。返回 HTML 字符串（已转义）。
 * 为了在 textarea 之上精确对齐，除 token 外的所有字符都必须原样保留（含空白）。
 */
export function highlightC(src) {
  let out = '';
  let m;
  let lastIndex = 0;
  TOKEN_RE.lastIndex = 0;
  // 逐行判断预处理指令：先算出每个 # 所在行的起始位置
  const lineStarts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') lineStarts.push(i + 1);

  const isPpLine = (idx) => {
    // 二分找行首
    let lo = 0, hi = lineStarts.length - 1, line = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (lineStarts[mid] <= idx) { line = mid; lo = mid + 1; } else hi = mid - 1;
    }
    const start = lineStarts[line];
    return PREPROC.test(src.slice(start, start + 64));
  };

  while ((m = TOKEN_RE.exec(src)) !== null) {
    if (m.index > lastIndex) out += esc(src.slice(lastIndex, m.index));
    lastIndex = TOKEN_RE.lastIndex;
    const [all, block, line, str, chr, num, ident, ws, other] = m;
    if (block) out += `<span class="t-com">${esc(block)}</span>`;
    else if (line) out += `<span class="t-com">${esc(line)}</span>`;
    else if (str) out += `<span class="t-str">${esc(str)}</span>`;
    else if (chr) out += `<span class="t-chr">${esc(chr)}</span>`;
    else if (num) out += `<span class="t-num">${esc(num)}</span>`;
    else if (ident) {
      if (isPpLine(m.index)) {
        // 预处理指令行的标识符沿用预处理色
        out += `<span class="t-pp">${esc(ident)}</span>`;
      } else if (KEYWORDS.has(ident)) out += `<span class="t-kw">${esc(ident)}</span>`;
      else if (TYPES.has(ident)) out += `<span class="t-ty">${esc(ident)}</span>`;
      else {
        const rest = src.slice(lastIndex);
        const nx = /^[ \t]*\(/.exec(rest);
        out += nx ? `<span class="t-fn">${esc(ident)}</span>` : esc(ident);
      }
    } else if (ws) out += ws;
    else out += esc(other);
  }
  if (lastIndex < src.length) out += esc(src.slice(lastIndex));
  return out;
}

/** 行数（空串算 1 行） */
export function countLines(src) {
  let n = 1;
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') n++;
  return n;
}
