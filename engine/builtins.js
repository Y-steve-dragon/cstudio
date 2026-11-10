// 掌心 C · 标准库（stdio / stdlib / string / math / ctype / time / conio）
import {
  VOID, BOOL, CHAR, UCHAR, INT, UINT, LONG, ULONG, LLONG, ULLONG, FLOAT, DOUBLE,
  ptrTo, isFloat, Fault, ExitSignal, wrapInt,
} from './core.js';

const PCHAR = ptrTo(CHAR);
const PVOID = ptrTo(VOID);

export const BUILTIN_FUNCS = [];
function def(name, ret, min, max, fn) { BUILTIN_FUNCS.push({ name, ret, min, max, fn }); }

const num = (v) => (v && v.agg ? v.addr : (typeof v === 'number' ? v : 0));
const cstr = (it, p, max = 1 << 20) => {
  if (!p) return null;
  try { return it.mem.readCString(p, max); } catch { throw new Fault('字符串指针无效（可能指向了空指针或非法内存）'); }
};

// C 的空白只认这几个 ASCII 字节。注意：不能用 JS 的 \s —— 内存里的字符串是「字节串」，
// UTF-8 中文字节里会出现 0xA0，而 '\u00A0' 恰好被 \s 当成空白，会把中文从中间截断。
const WS_BYTES = ' \t\n\r\f\v';
const isWS = (c) => c !== null && c !== undefined && WS_BYTES.includes(c);

// ═════════════════════ printf / sprintf 格式化 ═════════════════════
function padBody(s, width, flags, isNum, sign) {
  // 宽度上限保护：手机上生成上百万个空格没有意义，也不该把内存撑爆
  const pad = Math.min(1 << 16, Math.max(0, (width | 0) - s.length - (sign ? sign.length : 0)));
  if (flags.left) return (sign || '') + s + ' '.repeat(pad);
  if (isNum && flags.zero) return (sign || '') + '0'.repeat(pad) + s;
  return ' '.repeat(pad) + (sign || '') + s;
}

function intToBase(v, base, upper) {
  if (v < 0) v = v + 18446744073709551616; // 当作无符号 64 位
  const s = Math.floor(v).toString(base);
  return upper ? s.toUpperCase() : s;
}

function fmtFloat(v, conv, prec) {
  if (!isFinite(v)) {
    if (Number.isNaN(v)) return 'nan';
    return v < 0 ? '-inf' : 'inf';
  }
  if (prec < 0) prec = 6;
  if (conv === 'f' || conv === 'F') return v.toFixed(prec);
  if (conv === 'e' || conv === 'E') {
    let s = v.toExponential(prec);
    // C 的指数至少两位：1.23e+3 → 1.23e+03
    s = s.replace(/e([+-])(\d)$/, 'e$10$2');
    if (conv === 'E') s = s.toUpperCase();
    return s;
  }
  // %g / %G
  if (prec === 0) prec = 1;
  const exp = v === 0 ? 0 : Math.floor(Math.log10(Math.abs(v)));
  let s;
  if (exp < -4 || exp >= prec) {
    s = v.toExponential(prec - 1);
    s = s.replace(/\.?0+e/, 'e');
  } else {
    s = v.toFixed(Math.max(0, prec - 1 - exp));
    if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
  }
  return conv === 'G' ? s.toUpperCase() : s;
}

/** 返回格式化后的文本 */
function doFormat(it, fmt, args, ai) {
  let out = '';
  let i = 0;
  while (i < fmt.length) {
    const c = fmt[i];
    if (c !== '%') { out += c; i++; continue; }
    i++;
    if (i >= fmt.length) break;
    if (fmt[i] === '%') { out += '%'; i++; continue; }
    const flags = { left: false, plus: false, space: false, hash: false, zero: false };
    for (; i < fmt.length; i++) {
      const f = fmt[i];
      if (f === '-') flags.left = true;
      else if (f === '+') flags.plus = true;
      else if (f === ' ') flags.space = true;
      else if (f === '#') flags.hash = true;
      else if (f === '0') flags.zero = true;
      else break;
    }
    let width = 0;
    if (fmt[i] === '*') { width = Math.abs(num(args[ai++])); i++; }
    else { let s = ''; while (i < fmt.length && fmt[i] >= '0' && fmt[i] <= '9') { s += fmt[i]; i++; } if (s) width = parseInt(s, 10); }
    let prec = -1;
    if (fmt[i] === '.') {
      i++;
      if (fmt[i] === '*') { prec = Math.abs(num(args[ai++])); i++; }
      else { let s = ''; while (i < fmt.length && fmt[i] >= '0' && fmt[i] <= '9') { s += fmt[i]; i++; } prec = s ? parseInt(s, 10) : 0; }
    }
    let len = '';
    const two = fmt.substr(i, 2);
    if (two === 'hh' || two === 'll') { len = two; i += 2; }
    else if ('hlLzjt'.includes(fmt[i])) { len = fmt[i]; i++; }
    const conv = fmt[i]; i++;
    if (conv === undefined) break;
    let v = args[ai++];
    v = num(v);

    if (conv === 'd' || conv === 'i' || conv === 'u' || conv === 'o' || conv === 'x' || conv === 'X') {
      const size = len === 'hh' ? 1 : len === 'h' ? 2 : (len === 'll' || len === 'j' || len === 'z' || len === 't') ? 8 : 4;
      let iv = Math.trunc(v);
      if (size === 8) { if (!Number.isFinite(iv)) iv = 0; }
      else iv = wrapInt(iv, { kind: 'int', size, signed: conv === 'd' || conv === 'i' });
      let sign = '';
      let body;
      if (conv === 'd' || conv === 'i') {
        const neg = iv < 0;
        if (neg) sign = '-';
        else if (flags.plus) sign = '+';
        else if (flags.space) sign = ' ';
        body = String(Math.abs(iv));
        if (prec >= 0) {
          while (body.length < prec) body = '0' + body;
          if (body === '0' && prec === 0) body = '';
        }
      } else if (conv === 'u') {
        body = intToBase(iv, 10, false);
      } else if (conv === 'o') {
        body = intToBase(iv, 8, false);
        if (flags.hash && body[0] !== '0') body = '0' + body;
      } else {
        body = intToBase(iv, 16, conv === 'X');
        if (flags.hash && iv !== 0) body = (conv === 'X' ? '0X' : '0x') + body;
      }
      out += padBody(body, width, flags, true, sign);
      continue;
    }
    if (conv === 'f' || conv === 'F' || conv === 'e' || conv === 'E' || conv === 'g' || conv === 'G' || conv === 'a' || conv === 'A') {
      let s = fmtFloat(v, conv.toLowerCase() === 'a' ? 'e' : conv.toLowerCase(), prec);
      let sign = '';
      if (s[0] === '-') { sign = '-'; s = s.slice(1); }
      else if (flags.plus) sign = '+';
      else if (flags.space) sign = ' ';
      out += padBody(s, width, flags, true, sign);
      continue;
    }
    if (conv === 'c') {
      const ch = String.fromCharCode(v & 0xff);
      out += padBody(ch, width, flags, false, '');
      continue;
    }
    if (conv === 's') {
      let s = '';
      if (v) {
        try { s = it.mem.readCString(v, 1 << 20) || ''; } catch { s = '(非法字符串指针)'; }
      } else s = '(null)';
      if (prec >= 0) s = s.slice(0, prec);
      out += padBody(s, width, flags, false, '');
      continue;
    }
    if (conv === 'p') {
      const s = v ? '0x' + Math.trunc(v).toString(16) : '0x0';
      out += padBody(s, width, flags, false, '');
      continue;
    }
    if (conv === 'n') {
      if (v) it.mem.writeInt(v, 4, out.length);
      continue;
    }
    // 不认识的转换：原样输出
    out += '%' + conv;
  }
  return out;
}

// ═════════════════════ scanf / sscanf ═════════════════════
class MemSource {
  constructor(it, p) { this.it = it; this.p = p; this.i = 0; }
  async peek() {
    try {
      const u8 = this.it.mem.u8;
      const c = u8[this.p + this.i];
      return c === 0 ? null : String.fromCharCode(c);
    } catch { return null; }
  }
  async next() {
    const c = await this.peek();
    if (c !== null) this.i++;
    return c;
  }
  unget() { if (this.i > 0) this.i--; }
}
class StdinSource {
  constructor(it) { this.it = it; this.un = []; }
  async peek() { if (this.un.length) return this.un[this.un.length - 1]; return this.it.peekChar(); }
  async next() { if (this.un.length) return this.un.pop(); const c = await this.it.needChar(); return c; }
  ungetChar(c) { if (c !== null) this.un.push(c); }
}

async function scan(it, src, fmt, args, ai, isStdin) {
  let assigned = 0;
  let i = 0;
  let sawAny = false;
  while (i < fmt.length) {
    const f = fmt[i];
    if (f === ' ' || f === '\t' || f === '\n') {
      i++;
      for (;;) { const c = await src.peek(); if (c === null) break; if (!isWS(c)) break; await src.next(); }
      continue;
    }
    if (f !== '%') {
      const c = await src.next();
      if (c === null) return assigned;
      if (c !== f) { src.ungetChar ? src.ungetChar(c) : src.unget(); return assigned; }
      sawAny = true; i++;
      continue;
    }
    i++;
    if (fmt[i] === '%') {
      const c = await src.next();
      if (c !== '%') { src.ungetChar ? src.ungetChar(c) : src.unget(); return assigned; }
      i++; continue;
    }
    let suppress = false;
    if (fmt[i] === '*') { suppress = true; i++; }
    let width = 0;
    { let s = ''; while (i < fmt.length && fmt[i] >= '0' && fmt[i] <= '9') { s += fmt[i]; i++; } if (s) width = parseInt(s, 10); }
    let len = '';
    const two = fmt.substr(i, 2);
    if (two === 'hh' || two === 'll') { len = two; i += 2; }
    else if ('hlLzjt'.includes(fmt[i])) { len = fmt[i]; i++; }
    let conv = fmt[i]; i++;
    let scanset = null, negate = false;
    if (conv === '[') {
      negate = fmt[i] === '^';
      if (negate) i++;
      scanset = '';
      while (i < fmt.length && fmt[i] !== ']') {
        if (fmt[i] === '-' && scanset.length && fmt[i + 1] !== ']' && i + 1 < fmt.length) {
          const a = scanset.charCodeAt(scanset.length - 1), b = fmt.charCodeAt(i + 1);
          for (let c = a + 1; c <= b; c++) scanset += String.fromCharCode(c);
          i += 2; continue;
        }
        scanset += fmt[i]; i++;
      }
      i++; // ]
    }
    const ptr = suppress ? 0 : num(args[ai++]);

    // 大多数转换先跳过前导空白（%c 与 %[ 除外）
    if (conv !== 'c' && conv !== '[' && conv !== 'n') {
      for (;;) {
        const c = await src.peek();
        if (c === null) return assigned;
        if (!isWS(c)) break;
        await src.next();
      }
    }

    if (conv === 'd' || conv === 'i' || conv === 'u' || conv === 'o' || conv === 'x' || conv === 'X') {
      let buf = '';
      let base = conv === 'x' || conv === 'X' ? 16 : conv === 'o' ? 8 : 10;
      if (conv === 'i') base = 0;
      let c = await src.peek();
      if (c === '+' || c === '-') { buf += c; await src.next(); c = await src.peek(); }
      if (base === 0) {
        base = 10;
        if (c === '0') {
          buf += c; await src.next(); c = await src.peek();
          if (c === 'x' || c === 'X') { base = 16; buf += c; await src.next(); }
          else base = 8;
        }
      } else if (base === 16 && c === '0') {
        buf += c; await src.next(); c = await src.peek();
        if (c === 'x' || c === 'X') { buf += c; await src.next(); }
        else { /* 允许 0x 省略 */ }
      }
      for (; ;) {
        c = await src.peek();
        if (c === null) break;
        const ok = base === 16 ? /[0-9a-fA-F]/.test(c) : base === 8 ? /[0-7]/.test(c) : /[0-9]/.test(c);
        if (!ok) break;
        if (width && buf.replace(/^[+-]/, '').length >= width) break;
        buf += c; await src.next();
      }
      const neg = buf.trim().startsWith('-');
      const digits = buf.replace(/^[+-]/, '').replace(/^0[xX]/, '').replace(/^0/, base === 8 ? '' : buf.replace(/^[+-]/, ''));
      let val;
      if (!digits.length) {
        if (!/[0-9]/.test(buf)) {
          for (let k = buf.length - 1; k >= 0; k--) src.ungetChar ? src.ungetChar(buf[k]) : src.unget();
          return assigned;
        }
        val = 0;
      } else val = parseInt(digits, base);
      if (!Number.isFinite(val)) val = 0;
      if (neg) val = -val;
      if (!suppress) {
        const size = len === 'hh' ? 1 : len === 'h' ? 2 : (len === 'll' || len === 'j' || len === 'z' || len === 't') ? 8 : 4;
        it.mem.writeInt(ptr, size, wrapInt(val, { kind: 'int', size, signed: conv === 'd' || conv === 'i' || conv === 'i' }));
        assigned++;
      }
      sawAny = true;
      continue;
    }
    if (conv === 'f' || conv === 'F' || conv === 'e' || conv === 'E' || conv === 'g' || conv === 'G') {
      let buf = '';
      for (;;) {
        const c = await src.peek();
        if (c === null) break;
        if (!/[0-9+\-.eE]/.test(c)) break;
        if (width && buf.length >= width) break;
        buf += c; await src.next();
      }
      const v = parseFloat(buf);
      if (Number.isNaN(v) && !/[0-9]/.test(buf)) return assigned;
      if (!suppress) {
        if (len === 'l' || len === 'L') it.mem.writeF64(ptr, Number.isFinite(v) ? v : 0);
        else it.mem.writeF32(ptr, Number.isFinite(v) ? v : 0);
        assigned++;
      }
      sawAny = true;
      continue;
    }
    if (conv === 's') {
      let buf = '';
      for (;;) {
        const c = await src.peek();
        if (c === null || isWS(c)) break;
        if (width && buf.length >= width) break;
        buf += c; await src.next();
      }
      if (!buf.length) return assigned;
      if (!suppress) { it.mem.check(ptr, buf.length + 1, true); it.mem.writeCString(ptr, buf); assigned++; }
      sawAny = true;
      continue;
    }
    if (conv === 'c') {
      let buf = '';
      const n = width || 1;
      for (let k = 0; k < n; k++) {
        const c = await src.next();
        if (c === null) break;
        buf += c;
      }
      if (!buf.length) return assigned;
      if (!suppress) { it.mem.check(ptr, buf.length, true); for (let k = 0; k < buf.length; k++) it.mem.u8[ptr + k] = buf.charCodeAt(k); assigned++; }
      sawAny = true;
      continue;
    }
    if (conv === '[') {
      let buf = '';
      for (;;) {
        const c = await src.peek();
        if (c === null) break;
        const inSet = scanset.includes(c);
        if (negate ? inSet : !inSet) break;
        if (width && buf.length >= width) break;
        buf += c; await src.next();
      }
      if (!buf.length) return assigned;
      if (!suppress) { it.mem.check(ptr, buf.length + 1, true); it.mem.writeCString(ptr, buf); assigned++; }
      sawAny = true;
      continue;
    }
    if (conv === 'n') { if (!suppress) { it.mem.writeInt(ptr, 4, 0); assigned++; } continue; }
    return assigned;
  }
  return assigned;
}

// ═════════════════════ 注册 ═════════════════════
// ── stdio ──
def('printf', INT, 1, 999, async (it, a) => {
  const s = doFormat(it, cstr(it, num(a[0])) ?? '', a, 1);
  it.write(s);
  return s.length;
});
def('fprintf', INT, 2, 999, async (it, a) => {
  const s = doFormat(it, cstr(it, num(a[1])) ?? '', a, 2);
  it.write(s);
  return s.length;
});
def('sprintf', INT, 2, 999, async (it, a) => {
  const s = doFormat(it, cstr(it, num(a[1])) ?? '', a, 2);
  it.mem.check(num(a[0]), s.length + 1, true);
  it.mem.writeCString(num(a[0]), s);
  return s.length;
});
def('snprintf', INT, 3, 999, async (it, a) => {
  const n = num(a[1]);
  let s = doFormat(it, cstr(it, num(a[2])) ?? '', a, 3);
  if (n > 0 && s.length >= n) s = s.slice(0, Math.max(0, n - 1));
  it.mem.check(num(a[0]), s.length + 1, true);
  it.mem.writeCString(num(a[0]), s);
  return s.length;
});
def('puts', INT, 1, 1, async (it, a) => {
  const s = cstr(it, num(a[0]));
  if (s === null) throw new Fault('puts 收到了空指针');
  it.write(s + '\n');
  return s.length + 1;
});
def('fputs', INT, 2, 2, async (it, a) => {
  const s = cstr(it, num(a[0]));
  if (s === null) return -1;
  it.write(s);
  return s.length;
});
def('putchar', INT, 1, 1, async (it, a) => {
  const c = num(a[0]);
  it.write(String.fromCharCode(c & 0xff));
  return c & 0xff;
});
def('putc', INT, 2, 2, async (it, a) => {
  const c = num(a[0]);
  it.write(String.fromCharCode(c & 0xff));
  return c & 0xff;
});
def('fputc', INT, 2, 2, async (it, a) => {
  const c = num(a[0]);
  it.write(String.fromCharCode(c & 0xff));
  return c & 0xff;
});
def('getchar', INT, 0, 0, async (it) => {
  const c = await it.needChar();
  return c === null ? -1 : c.charCodeAt(0);
});
def('getc', INT, 1, 1, async (it) => {
  const c = await it.needChar();
  return c === null ? -1 : c.charCodeAt(0);
});
def('fgetc', INT, 1, 1, async (it) => {
  const c = await it.needChar();
  return c === null ? -1 : c.charCodeAt(0);
});
def('gets', PCHAR, 1, 1, async (it, a) => {
  const p = num(a[0]);
  const line = await it.readLineStr();
  if (line === null) return 0;
  let s = line.replace(/\n$/, '').replace(/\r$/, '');
  if (it.io.echoInput) { /* 已回显 */ }
  it.mem.check(p, s.length + 1, true);
  it.mem.writeCString(p, s);
  return p;
});
def('fgets', PCHAR, 3, 3, async (it, a) => {
  const p = num(a[0]), n = num(a[1]);
  if (n <= 0) return 0;
  const line = await it.readLineStr();
  if (line === null) return 0;
  let s = line;
  if (s.length > n - 1) s = s.slice(0, n - 1);
  it.mem.check(p, s.length + 1, true);
  it.mem.writeCString(p, s);
  return p;
});
def('scanf', INT, 1, 999, async (it, a) => {
  const fmt = cstr(it, num(a[0])) ?? '';
  return scan(it, new StdinSource(it), fmt, a, 1, true);
});
def('sscanf', INT, 2, 999, async (it, a) => {
  const str = cstr(it, num(a[0]));
  if (str === null) return -1;
  const fmt = cstr(it, num(a[1])) ?? '';
  const src = { i: 0, s: str, async peek() { return this.i < this.s.length ? this.s[this.i] : null; }, async next() { return this.i < this.s.length ? this.s[this.i++] : null; }, unget() { if (this.i > 0) this.i--; } };
  return scan(it, src, fmt, a, 2, false);
});
def('fscanf', INT, 2, 999, async (it, a) => {
  const fmt = cstr(it, num(a[1])) ?? '';
  return scan(it, new StdinSource(it), fmt, a, 2, true);
});
def('fflush', INT, 1, 1, async (it) => { it.flush(); return 0; });
def('perror', VOID, 1, 1, async (it, a) => {
  it.write((cstr(it, num(a[0])) ?? '') + '\n');
  return 0;
});
// 文件 I/O：本引擎没有文件系统，统一返回失败（并给出清晰语义）
def('fopen', PVOID, 2, 2, async () => 0);
def('freopen', PVOID, 3, 3, async () => 0);
def('fclose', INT, 1, 1, async () => 0);
def('fread', ULONG, 4, 4, async () => 0);
def('fwrite', ULONG, 4, 4, async (it, a) => num(a[1]) * num(a[2]));
def('fseek', INT, 3, 3, async () => -1);
def('ftell', LONG, 1, 1, async () => -1);
def('rewind', VOID, 1, 1, async () => 0);
def('feof', INT, 1, 1, async () => 0);
def('ferror', INT, 1, 1, async () => 0);
def('clearerr', VOID, 1, 1, async () => 0);
def('remove', INT, 1, 1, async () => -1);
def('rename', INT, 2, 2, async () => -1);
def('tmpfile', PVOID, 0, 0, async () => 0);
def('setbuf', VOID, 2, 2, async () => 0);
def('setvbuf', INT, 4, 4, async () => 0);
// conio（VS 教材里常用的 _getch）
def('_getch', INT, 0, 0, async (it) => {
  const c = await it.needChar();
  return c === null ? -1 : c.charCodeAt(0);
});
def('getch', INT, 0, 0, async (it) => {
  const c = await it.needChar();
  return c === null ? -1 : c.charCodeAt(0);
});
def('_getche', INT, 0, 0, async (it) => {
  const c = await it.needChar();
  if (c !== null) it.write(c);
  return c === null ? -1 : c.charCodeAt(0);
});
def('kbhit', INT, 0, 0, async () => 0);
def('_kbhit', INT, 0, 0, async () => 0);
def('clrscr', VOID, 0, 0, async (it) => { it.write('\x1b[2J\x1b[H'); return 0; });
def('system', INT, 1, 1, async () => 0);

// ── stdlib ──
def('malloc', PVOID, 1, 1, async (it, a) => it.mem.malloc(num(a[0])));
def('calloc', PVOID, 2, 2, async (it, a) => it.mem.malloc(num(a[0]) * num(a[1])));
def('realloc', PVOID, 2, 2, async (it, a) => {
  const p = num(a[0]), n = num(a[1]);
  if (!p) return it.mem.malloc(n);
  if (n === 0) { it.mem.free(p); return 0; }
  const oldSize = it.mem.blocks.get(p);
  if (oldSize === undefined) throw new Fault('realloc：传入的指针不是 malloc 返回的指针（或已被释放）');
  const q = it.mem.malloc(n);
  if (!q) return 0;
  it.mem.copy(q, p, Math.min(oldSize, n));
  it.mem.free(p);
  return q;
});
def('free', VOID, 1, 1, async (it, a) => { it.mem.free(num(a[0])); return 0; });
def('exit', VOID, 1, 1, async (it, a) => { it.flush(); throw new ExitSignal(num(a[0])); });
def('_Exit', VOID, 1, 1, async (it, a) => { it.flush(); throw new ExitSignal(num(a[0])); });
def('abort', VOID, 0, 0, async () => { throw new Fault('程序调用了 abort() 主动中止'); });
def('atexit', INT, 1, 1, async () => 0);
def('atoi', INT, 1, 1, async (it, a) => parseIntLeading(cstr(it, num(a[0]))));
def('atol', LONG, 1, 1, async (it, a) => parseIntLeading(cstr(it, num(a[0]))));
def('atoll', LLONG, 1, 1, async (it, a) => parseIntLeading(cstr(it, num(a[0]))));
def('atof', DOUBLE, 1, 1, async (it, a) => {
  const m = /^[ \t\n\r\f\v]*[+-]?(\d+\.?\d*([eE][+-]?\d+)?|\.\d+([eE][+-]?\d+)?)/.exec(cstr(it, num(a[0])) ?? '');
  return m ? parseFloat(m[0]) : 0;
});
def('strtod', DOUBLE, 2, 2, async (it, a) => {
  const s = cstr(it, num(a[0])) ?? '';
  const m = /^[ \t\n\r\f\v]*[+-]?(\d+\.?\d*([eE][+-]?\d+)?|\.\d+([eE][+-]?\d+)?)/.exec(s);
  const ep = num(a[1]);
  if (ep) it.mem.writeInt(ep, 8, num(a[0]) + (m ? m[0].length : 0));
  return m ? parseFloat(m[0]) : 0;
});
def('strtol', LONG, 3, 3, async (it, a) => parseIntRadix(it, a, 4));
def('strtoul', ULONG, 3, 3, async (it, a) => parseIntRadix(it, a, 4));
def('strtoll', LLONG, 3, 3, async (it, a) => parseIntRadix(it, a, 8));
def('strtoull', ULLONG, 3, 3, async (it, a) => parseIntRadix(it, a, 8));
function parseIntLeading(s) {
  if (!s) return 0;
  const m = /^[ \t\n\r\f\v]*[+-]?\d+/.exec(s);
  return m ? parseInt(m[0], 10) : 0;
}
function parseIntRadix(it, a, size) {
  const s = cstr(it, num(a[0])) ?? '';
  let base = num(a[2]);
  let t = s.replace(/^[ \t\n\r\f\v]+/, '');
  const consumed = s.length - t.length;   // 跳过前导空白消耗的字节数
  let at = consumed;
  let neg = false;
  if (t[0] === '+' || t[0] === '-') { neg = t[0] === '-'; t = t.slice(1); at++; }
  if ((base === 0 || base === 16) && /^0[xX]/.test(t)) { base = 16; t = t.slice(2); at += 2; }
  else if (base === 0) base = t[0] === '0' ? 8 : 10;
  const re = base === 16 ? /^[0-9a-fA-F]+/ : base === 8 ? /^[0-7]+/ : base === 2 ? /^[01]+/ : /^[0-9]+/;
  const m = re.exec(t);
  let v = m ? parseInt(m[0], base) : 0;
  if (neg) v = -v;
  // endptr：指向「第一个没被消耗的字符」；一个都没解析出来时指向原始起点
  const ep = num(a[1]);
  if (ep) it.mem.writeInt(ep, 8, m ? num(a[0]) + at + m[0].length : num(a[0]));
  return v;
}
def('abs', INT, 1, 1, async (it, a) => Math.abs(Math.trunc(num(a[0]))));
def('labs', LONG, 1, 1, async (it, a) => Math.abs(Math.trunc(num(a[0]))));
def('llabs', LLONG, 1, 1, async (it, a) => Math.abs(Math.trunc(num(a[0]))));
def('div', INT, 2, 2, async (it, a) => Math.trunc(num(a[0]) / num(a[1])));
def('ldiv', LONG, 2, 2, async (it, a) => Math.trunc(num(a[0]) / num(a[1])));
def('srand', VOID, 1, 1, async (it, a) => { it.randState = (num(a[0]) >>> 0) || 1; return 0; });
def('rand', INT, 0, 0, async (it) => {
  if (!it.randState) it.randState = 1;
  it.randState = (it.randState * 1103515245 + 12345) & 0x7fffffff;
  return it.randState % 32768;
});
def('qsort', VOID, 4, 4, async (it, a) => {
  const base = num(a[0]), n = num(a[1]), size = num(a[2]), cmp = num(a[3]);
  const fn = it.fns[cmp];
  if (!fn) throw new Fault('qsort：比较函数指针无效');
  if (n <= 1) return 0;
  const tmp = it.mem.staticAlloc(size, 8);
  const call = async (p, q) => {
    const r = await it.callFunction(fn, [p, q], it.frame, 0, [PVOID, PVOID]);
    return Math.trunc(r) || 0;
  };
  // 插入排序：简单、稳定，足够教学使用（元素多时较慢）
  for (let i = 1; i < n; i++) {
    let j = i;
    while (j > 0) {
      const c = await call(base + (j - 1) * size, base + j * size);
      if (c <= 0) break;
      it.mem.copy(tmp, base + (j - 1) * size, size);
      it.mem.copy(base + (j - 1) * size, base + j * size, size);
      it.mem.copy(base + j * size, tmp, size);
      j--;
    }
  }
  return 0;
});
def('bsearch', PVOID, 5, 5, async (it, a) => {
  const key = num(a[0]), base = num(a[1]), n = num(a[2]), size = num(a[3]), cmp = num(a[4]);
  const fn = it.fns[cmp];
  if (!fn) throw new Fault('bsearch：比较函数指针无效');
  let lo = 0, hi = n - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = Math.trunc(await it.callFunction(fn, [key, base + mid * size], it.frame, 0, [PVOID, PVOID]));
    if (r === 0) return base + mid * size;
    if (r < 0) hi = mid - 1; else lo = mid + 1;
  }
  return 0;
});
def('getenv', PCHAR, 1, 1, async () => 0);
def('assert', VOID, 1, 1, async (it, a) => {
  if (!num(a[0])) {
    const pos = it.curPos || {};
    throw new Fault(`断言失败：assert 条件不成立（第 ${pos.line} 行）`);
  }
  return 0;
});
def('__assert', VOID, 1, 1, async (it, a) => {
  if (!num(a[0])) throw new Fault(`断言失败：assert 条件不成立（第 ${it.curPos?.line} 行）`);
  return 0;
});
def('_assert', VOID, 1, 1, async (it, a) => {
  if (!num(a[0])) throw new Fault(`断言失败：assert 条件不成立（第 ${it.curPos?.line} 行）`);
  return 0;
});
def('rand_r', INT, 1, 1, async (it) => {
  it.randState = ((it.randState || 1) * 1103515245 + 12345) & 0x7fffffff;
  return it.randState % 32768;
});

// ── string.h ──
def('strlen', ULONG, 1, 1, async (it, a) => {
  const p = num(a[0]);
  if (!p) throw new Fault('strlen 收到了空指针（NULL）');
  let n = 0;
  it.mem.check(p, 1);
  while (n < (1 << 24)) { if (it.mem.u8[p + n] === 0) return n; n++; }
  throw new Fault('strlen：字符串没有结束符 \\0（越界）');
});
def('strcpy', PCHAR, 2, 2, async (it, a) => {
  const s = cstr(it, num(a[1]));
  if (s === null) throw new Fault('strcpy 的源字符串是空指针');
  it.mem.check(num(a[0]), s.length + 1, true);
  it.mem.writeCString(num(a[0]), s);
  return num(a[0]);
});
def('strncpy', PCHAR, 3, 3, async (it, a) => {
  const s = cstr(it, num(a[1])) ?? '';
  const n = num(a[2]);
  const d = num(a[0]);
  for (let i = 0; i < n; i++) it.mem.writeInt(d + i, 1, i < s.length ? s.charCodeAt(i) : 0);
  return d;
});
def('strcat', PCHAR, 2, 2, async (it, a) => {
  const d = num(a[0]);
  const s1 = cstr(it, d) ?? '';
  const s2 = cstr(it, num(a[1])) ?? '';
  it.mem.check(d, s1.length + s2.length + 1, true);
  it.mem.writeCString(d, s1 + s2);
  return d;
});
def('strncat', PCHAR, 3, 3, async (it, a) => {
  const d = num(a[0]);
  const s1 = cstr(it, d) ?? '';
  const s2 = (cstr(it, num(a[1])) ?? '').slice(0, num(a[2]));
  it.mem.check(d, s1.length + s2.length + 1, true);
  it.mem.writeCString(d, s1 + s2);
  return d;
});
def('strcmp', INT, 2, 2, async (it, a) => cmpStr(cstr(it, num(a[0])) ?? '', cstr(it, num(a[1])) ?? '', 1 << 30));
def('strncmp', INT, 3, 3, async (it, a) => cmpStr(cstr(it, num(a[0])) ?? '', cstr(it, num(a[1])) ?? '', num(a[2])));
def('strcasecmp', INT, 2, 2, async (it, a) => cmpStr((cstr(it, num(a[0])) ?? '').toLowerCase(), (cstr(it, num(a[1])) ?? '').toLowerCase(), 1 << 30));
def('stricmp', INT, 2, 2, async (it, a) => cmpStr((cstr(it, num(a[0])) ?? '').toLowerCase(), (cstr(it, num(a[1])) ?? '').toLowerCase(), 1 << 30));
function cmpStr(a, b, n) {
  const m = Math.min(a.length, b.length, n);
  for (let i = 0; i < m; i++) {
    const ca = a.charCodeAt(i) & 0xff, cb = b.charCodeAt(i) & 0xff;
    if (ca !== cb) return (ca < cb ? -1 : 1) * (ca < cb ? 1 : 1);
  }
  if (a.length !== b.length && m === Math.min(a.length, b.length)) {
    if (m >= n) return 0;
    return a.length < b.length ? -1 : 1;
  }
  return 0;
}
def('strchr', PCHAR, 2, 2, async (it, a) => {
  const s = cstr(it, num(a[0]));
  if (s === null) return 0;
  const c = String.fromCharCode(num(a[1]) & 0xff);
  const i = s.indexOf(c);
  return i < 0 ? 0 : num(a[0]) + i;
});
def('strrchr', PCHAR, 2, 2, async (it, a) => {
  const s = cstr(it, num(a[0]));
  if (s === null) return 0;
  const c = String.fromCharCode(num(a[1]) & 0xff);
  const i = s.lastIndexOf(c);
  return i < 0 ? 0 : num(a[0]) + i;
});
def('strstr', PCHAR, 2, 2, async (it, a) => {
  const s = cstr(it, num(a[0]));
  const t = cstr(it, num(a[1]));
  if (s === null || t === null) return 0;
  const i = s.indexOf(t);
  return i < 0 ? 0 : num(a[0]) + i;
});
def('strdup', PCHAR, 1, 1, async (it, a) => {
  const s = cstr(it, num(a[0]));
  if (s === null) return 0;
  const p = it.mem.malloc(s.length + 1);
  it.mem.writeCString(p, s);
  return p;
});
def('strcpy_s', INT, 3, 3, async (it, a) => {
  const s = cstr(it, num(a[2])) ?? '';
  const n = num(a[1]);
  if (s.length + 1 > n) return -1;
  it.mem.writeCString(num(a[0]), s);
  return 0;
});
def('memset', PVOID, 3, 3, async (it, a) => {
  const p = num(a[0]), c = num(a[1]) & 0xff, n = num(a[2]);
  it.mem.check(p, n, true);
  it.mem.u8.fill(c, p, p + n);
  return p;
});
def('memcpy', PVOID, 3, 3, async (it, a) => {
  const d = num(a[0]), s = num(a[1]), n = num(a[2]);
  it.mem.copy(d, s, n);
  return d;
});
def('memmove', PVOID, 3, 3, async (it, a) => {
  const d = num(a[0]), s = num(a[1]), n = num(a[2]);
  it.mem.check(d, n, true); it.mem.check(s, n);
  if (d === s || n === 0) return d;
  const tmp = it.mem.u8.slice(s, s + n);
  it.mem.u8.set(tmp, d);
  return d;
});
def('memcmp', INT, 3, 3, async (it, a) => {
  const p = num(a[0]), q = num(a[1]), n = num(a[2]);
  for (let i = 0; i < n; i++) {
    const x = it.mem.u8[p + i], y = it.mem.u8[q + i];
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
});
def('memchr', PVOID, 3, 3, async (it, a) => {
  const p = num(a[0]), c = num(a[1]) & 0xff, n = num(a[2]);
  for (let i = 0; i < n; i++) if (it.mem.u8[p + i] === c) return p + i;
  return 0;
});
def('strtok', PCHAR, 2, 2, async (it, a) => {
  const delims = cstr(it, num(a[1])) ?? '';
  let p = num(a[0]);
  if (!p) {
    if (!it.tokState) return 0;
    p = it.tokState;
  }
  const s = cstr(it, p);
  if (s === null || s.length === 0) { it.tokState = 0; return 0; }
  let i = 0;
  while (i < s.length && delims.includes(s[i])) i++;
  if (i >= s.length) { it.tokState = 0; return 0; }
  const start = p + i;
  let j = i;
  while (j < s.length && !delims.includes(s[j])) j++;
  if (j < s.length) { it.mem.writeInt(p + j, 1, 0, true); it.tokState = p + j + 1; }
  else it.tokState = 0;
  return start;
});
def('strspn', ULONG, 2, 2, async (it, a) => {
  const s = cstr(it, num(a[0])) ?? '', t = cstr(it, num(a[1])) ?? '';
  let i = 0; while (i < s.length && t.includes(s[i])) i++;
  return i;
});
def('strcspn', ULONG, 2, 2, async (it, a) => {
  const s = cstr(it, num(a[0])) ?? '', t = cstr(it, num(a[1])) ?? '';
  let i = 0; while (i < s.length && !t.includes(s[i])) i++;
  return i;
});
def('strpbrk', PCHAR, 2, 2, async (it, a) => {
  const s = cstr(it, num(a[0])) ?? '', t = cstr(it, num(a[1])) ?? '';
  for (let i = 0; i < s.length; i++) if (t.includes(s[i])) return num(a[0]) + i;
  return 0;
});
def('strrev', PCHAR, 1, 1, async (it, a) => {
  const p = num(a[0]);
  const s = cstr(it, p) ?? '';
  it.mem.writeCString(p, s.split('').reverse().join(''));
  return p;
});
def('_strrev', PCHAR, 1, 1, async (it, a) => {
  const p = num(a[0]);
  const s = cstr(it, p) ?? '';
  it.mem.writeCString(p, s.split('').reverse().join(''));
  return p;
});
def('strerror', PCHAR, 1, 1, async (it) => it.strerrorPtr || (it.strerrorPtr = it.makeString('error')));

// ── ctype.h ──
const CTYPE = {
  isalpha: (c) => /[A-Za-z]/.test(c),
  isdigit: (c) => /[0-9]/.test(c),
  isalnum: (c) => /[A-Za-z0-9]/.test(c),
  isspace: (c) => /[ \t\n\r\f\v]/.test(c),
  isupper: (c) => /[A-Z]/.test(c),
  islower: (c) => /[a-z]/.test(c),
  ispunct: (c) => /[!-\/:-@\[-`{-~]/.test(c),
  isprint: (c) => c >= ' ' && c <= '~',
  isgraph: (c) => c > ' ' && c <= '~',
  iscntrl: (c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
  isxdigit: (c) => /[0-9A-Fa-f]/.test(c),
  isblank: (c) => c === ' ' || c === '\t',
  isascii: (c) => c.charCodeAt(0) < 128,
};
for (const k of Object.keys(CTYPE)) {
  def(k, INT, 1, 1, async (it, a) => (CTYPE[k](String.fromCharCode(num(a[0]) & 0xff)) ? 1 : 0));
}
def('toupper', INT, 1, 1, async (it, a) => {
  const c = num(a[0]);
  return /[a-z]/.test(String.fromCharCode(c)) ? c - 32 : c;
});
def('tolower', INT, 1, 1, async (it, a) => {
  const c = num(a[0]);
  return /[A-Z]/.test(String.fromCharCode(c)) ? c + 32 : c;
});
def('_toupper', INT, 1, 1, async (it, a) => { const c = num(a[0]); return /[a-z]/.test(String.fromCharCode(c)) ? c - 32 : c; });
def('_tolower', INT, 1, 1, async (it, a) => { const c = num(a[0]); return /[A-Z]/.test(String.fromCharCode(c)) ? c + 32 : c; });

// ── math.h ──
const M1 = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan,
  sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh, exp: Math.exp, log: Math.log, log10: Math.log10,
  log2: Math.log2, sqrt: Math.sqrt, cbrt: Math.cbrt, floor: Math.floor, ceil: Math.ceil,
  round: Math.round, trunc: Math.trunc, fabs: Math.abs, expm1: Math.expm1, log1p: Math.log1p,
  asinh: Math.asinh, acosh: Math.acosh, atanh: Math.atanh,
};
for (const k of Object.keys(M1)) {
  def(k, DOUBLE, 1, 1, async (it, a) => M1[k](num(a[0])));
  def(k + 'f', FLOAT, 1, 1, async (it, a) => M1[k](num(a[0])));
}
const M2 = { pow: Math.pow, atan2: Math.atan2, fmod: (a, b) => a % b, hypot: Math.hypot, fmin: Math.min, fmax: Math.max, copysign: (a, b) => (b < 0 ? -Math.abs(a) : Math.abs(a)), remainder: (a, b) => a % b };
for (const k of Object.keys(M2)) {
  def(k, DOUBLE, 2, 2, async (it, a) => M2[k](num(a[0]), num(a[1])));
  def(k + 'f', FLOAT, 2, 2, async (it, a) => M2[k](num(a[0]), num(a[1])));
}
def('ldexp', DOUBLE, 2, 2, async (it, a) => num(a[0]) * Math.pow(2, num(a[1])));
def('frexp', DOUBLE, 2, 2, async (it, a) => num(a[0]));
def('modf', DOUBLE, 2, 2, async (it, a) => {
  const p = num(a[1]);
  if (p) it.mem.writeF64(p, Math.trunc(num(a[0])));
  return num(a[0]) - Math.trunc(num(a[0]));
});
def('isnan', INT, 1, 1, async (it, a) => (Number.isNaN(num(a[0])) ? 1 : 0));
def('isinf', INT, 1, 1, async (it, a) => (!Number.isFinite(num(a[0])) && !Number.isNaN(num(a[0])) ? 1 : 0));
def('isfinite', INT, 1, 1, async (it, a) => (Number.isFinite(num(a[0])) ? 1 : 0));
def('signbit', INT, 1, 1, async (it, a) => (num(a[0]) < 0 ? 1 : 0));

// ── time.h ──
def('time', LLONG, 1, 1, async (it, a) => {
  const t = Math.floor(Date.now() / 1000);
  const p = num(a[0]);
  if (p) it.mem.writeInt(p, 8, t);
  return t;
});
def('clock', LLONG, 0, 0, async (it) => Math.floor(it.steps));
def('clock_gettime', INT, 2, 2, async (it, a) => {
  const p = num(a[1]);
  if (p) it.mem.writeInt(p, 8, Math.floor(Date.now() / 1000));
  return 0;
});
def('difftime', DOUBLE, 2, 2, async (it, a) => num(a[0]) - num(a[1]));
function fillTm(it, t, utc) {
  const addr = it.tmBuf || (it.tmBuf = it.mem.staticAlloc(40, 8));
  const d = new Date(t * 1000);
  const get = (f, u) => (utc ? d['getUTC' + f]() : d['get' + f]());
  it.mem.writeInt(addr + 0, 4, get('Seconds'));
  it.mem.writeInt(addr + 4, 4, get('Minutes'));
  it.mem.writeInt(addr + 8, 4, get('Hours'));
  it.mem.writeInt(addr + 12, 4, get('Date'));
  it.mem.writeInt(addr + 16, 4, get('Month'));
  it.mem.writeInt(addr + 20, 4, get('FullYear') - 1900);
  it.mem.writeInt(addr + 24, 4, get('Day'));
  it.mem.writeInt(addr + 28, 4, Math.floor((d - new Date(utc ? Date.UTC(d.getUTCFullYear(), 0, 1) : d.getFullYear(), 0, 1)) / 86400000));
  it.mem.writeInt(addr + 32, 4, 0);
  return addr;
}
def('localtime', PVOID, 1, 1, async (it, a) => {
  const p = num(a[0]);
  if (!p) return 0;
  return fillTm(it, it.mem.readInt(p, 8, true), false);
});
def('gmtime', PVOID, 1, 1, async (it, a) => {
  const p = num(a[0]);
  if (!p) return 0;
  return fillTm(it, it.mem.readInt(p, 8, true), true);
});
def('mktime', LLONG, 1, 1, async (it, a) => {
  const p = num(a[0]);
  if (!p) return -1;
  const sec = it.mem.readInt(p, 4, true), min = it.mem.readInt(p + 4, 4, true), hr = it.mem.readInt(p + 8, 4, true);
  const day = it.mem.readInt(p + 12, 4, true), mon = it.mem.readInt(p + 16, 4, true), yr = it.mem.readInt(p + 20, 4, true);
  return Math.floor(new Date(yr + 1900, mon, day, hr, min, sec).getTime() / 1000);
});
def('strftime', ULONG, 4, 4, async (it, a) => {
  const buf = num(a[0]), n = num(a[1]);
  const fmt = cstr(it, num(a[2])) ?? '';
  const tmP = num(a[3]);
  if (!tmP) return 0;
  const d = new Date();
  const y = it.mem.readInt(tmP + 20, 4, true) + 1900;
  const mo = it.mem.readInt(tmP + 16, 4, true) + 1;
  const da = it.mem.readInt(tmP + 12, 4, true);
  const hh = it.mem.readInt(tmP + 8, 4, true);
  const mi = it.mem.readInt(tmP + 4, 4, true);
  const ss = it.mem.readInt(tmP + 0, 4, true);
  const pad = (x) => String(x).padStart(2, '0');
  let s = fmt
    .replace(/%Y/g, String(y)).replace(/%m/g, pad(mo)).replace(/%d/g, pad(da))
    .replace(/%H/g, pad(hh)).replace(/%M/g, pad(mi)).replace(/%S/g, pad(ss))
    .replace(/%F/g, `${y}-${pad(mo)}-${pad(da)}`)
    .replace(/%T/g, `${pad(hh)}:${pad(mi)}:${pad(ss)}`)
    .replace(/%%/g, '%');
  if (s.length + 1 > n) return 0;
  it.mem.writeCString(buf, s);
  return s.length;
});

// ═════════════════════ 预定义常量与类型 ═════════════════════
export const PREDEFINED_CONSTANTS = [
  { name: 'NULL', value: 0, type: 'ptr' },
  { name: 'EOF', value: -1, type: 'int' },
  { name: 'true', value: 1, type: 'int' },
  { name: 'false', value: 0, type: 'int' },
  { name: 'TRUE', value: 1, type: 'int' },
  { name: 'FALSE', value: 0, type: 'int' },
  { name: 'EXIT_SUCCESS', value: 0, type: 'int' },
  { name: 'EXIT_FAILURE', value: 1, type: 'int' },
  { name: 'RAND_MAX', value: 32767, type: 'int' },
  { name: 'INT_MAX', value: 2147483647, type: 'int' },
  { name: 'INT_MIN', value: -2147483648, type: 'int' },
  { name: 'UINT_MAX', value: 4294967295, type: 'uint' },
  { name: 'LONG_MAX', value: 2147483647, type: 'long' },
  { name: 'LONG_MIN', value: -2147483648, type: 'long' },
  { name: 'ULONG_MAX', value: 4294967295, type: 'ulong' },
  { name: 'LLONG_MAX', value: 9223372036854775807, type: 'llong' },
  { name: 'LLONG_MIN', value: -9223372036854775808, type: 'llong' },
  { name: 'ULLONG_MAX', value: 18446744073709551615, type: 'ullong' },
  { name: 'SHRT_MAX', value: 32767, type: 'int' },
  { name: 'SHRT_MIN', value: -32768, type: 'int' },
  { name: 'USHRT_MAX', value: 65535, type: 'uint' },
  { name: 'CHAR_MAX', value: 127, type: 'int' },
  { name: 'CHAR_MIN', value: -128, type: 'int' },
  { name: 'UCHAR_MAX', value: 255, type: 'uint' },
  { name: 'CHAR_BIT', value: 8, type: 'int' },
  { name: 'SIZE_MAX', value: 18446744073709551615, type: 'ullong' },
  { name: 'INT8_MAX', value: 127, type: 'int' },
  { name: 'INT16_MAX', value: 32767, type: 'int' },
  { name: 'INT32_MAX', value: 2147483647, type: 'int' },
  { name: 'INT64_MAX', value: 9223372036854775807, type: 'llong' },
  { name: 'UINT8_MAX', value: 255, type: 'uint' },
  { name: 'UINT16_MAX', value: 65535, type: 'uint' },
  { name: 'UINT32_MAX', value: 4294967295, type: 'uint' },
  { name: 'UINT64_MAX', value: 18446744073709551615, type: 'ullong' },
  { name: 'DBL_MAX', value: 1.7976931348623157e308, type: 'double' },
  { name: 'FLT_MAX', value: 3.4028234663852886e38, type: 'double' },
  { name: 'DBL_MIN', value: 2.2250738585072014e-308, type: 'double' },
  { name: 'DBL_EPSILON', value: 2.220446049250313e-16, type: 'double' },
  { name: 'M_PI', value: 3.141592653589793, type: 'double' },
  { name: 'M_E', value: 2.718281828459045, type: 'double' },
  { name: 'HUGE_VAL', value: Infinity, type: 'double' },
  { name: 'INFINITY', value: Infinity, type: 'double' },
  { name: 'NAN', value: NaN, type: 'double' },
  { name: 'SEEK_SET', value: 0, type: 'int' },
  { name: 'SEEK_CUR', value: 1, type: 'int' },
  { name: 'SEEK_END', value: 2, type: 'int' },
  { name: 'stdin', value: 0, type: 'ptr' },
  { name: 'stdout', value: 0, type: 'ptr' },
  { name: 'stderr', value: 0, type: 'ptr' },
  { name: 'BUFSIZ', value: 8192, type: 'int' },
  { name: 'FILENAME_MAX', value: 260, type: 'int' },
  { name: 'CLOCKS_PER_SEC', value: 1000, type: 'long' },
  { name: 'CLOCK_PER_SEC', value: 1000, type: 'long' },
  { name: 'time_t_MAX', value: 9223372036854775807, type: 'llong' },
];

/** 预定义 typedef 名（头文件里本应出现的类型） */
export const PREDEFINED_TYPEDEFS = {
  size_t: 'ulong', ssize_t: 'llong', ptrdiff_t: 'llong', intptr_t: 'llong', uintptr_t: 'ullong',
  off_t: 'llong', time_t: 'llong', clock_t: 'llong', wchar_t: 'int', va_list: 'char*', FILE: 'void',
  int8_t: 'char', int16_t: 'short', int32_t: 'int', int64_t: 'llong',
  uint8_t: 'uchar', uint16_t: 'ushort', uint32_t: 'uint', uint64_t: 'ullong',
  int_least8_t: 'char', int_least16_t: 'short', int_least32_t: 'int', int_least64_t: 'llong',
  uint_least8_t: 'uchar', uint_least16_t: 'ushort', uint_least32_t: 'uint', uint_least64_t: 'ullong',
  intmax_t: 'llong', uintmax_t: 'ullong', bool: 'bool',
};

/** 预定义结构体（time.h 的 struct tm） */
export const PREDEFINED_STRUCTS = {
  tm: [
    ['tm_sec', 'int'], ['tm_min', 'int'], ['tm_hour', 'int'], ['tm_mday', 'int'],
    ['tm_mon', 'int'], ['tm_year', 'int'], ['tm_wday', 'int'], ['tm_yday', 'int'], ['tm_isdst', 'int'],
  ],
};
