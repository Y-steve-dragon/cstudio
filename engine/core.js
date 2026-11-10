// 掌心 C · 引擎核心：C 类型系统 + 线性内存模型（32 MiB）
// 数据模型对齐 Visual Studio x64：int 4 / long 4 / long long 8 / 指针 8 / double 8

export const MEM_SIZE = 32 * 1024 * 1024;
export const REG = {
  nullEnd: 0x1000,
  staticStart: 0x1000,
  staticEnd: 0x200000,   //   2 MiB 静态区（全局变量、字符串常量）
  heapStart: 0x200000,
  heapEnd: 0x1800000,    //  22 MiB 堆
  stackLimit: 0x1800000, //   8 MiB 栈（向下生长）
  stackTop: MEM_SIZE,
};

// ───────────── 字符串与字节 ─────────────
// 约定：内存里的 C 字符串是「字节串」——JS 字符串的每个字符就是一个字节（0–255）。
// 源码里的中文按 UTF-8 编码进内存（见 lexer），输出时再解码回真 Unicode（见 interp.flush）。
const UTF8_ENC = typeof TextEncoder === 'function' ? new TextEncoder() : null;

/** JS 字符串（真 Unicode）→ 字节串（每字符 1 字节） */
export function toBytes(s) {
  s = String(s);
  if (!UTF8_ENC) return s;
  const b = UTF8_ENC.encode(s);
  let out = '';
  for (let i = 0; i < b.length; i += 8192) {
    out += String.fromCharCode.apply(null, b.subarray(i, Math.min(i + 8192, b.length)));
  }
  return out;
}

/** 字节串 → Uint8Array */
export function byteStrToU8(bs) {
  const u8 = new Uint8Array(bs.length);
  for (let i = 0; i < bs.length; i++) u8[i] = bs.charCodeAt(i) & 0xff;
  return u8;
}

/** 字节串 → JS 字符串（按 UTF-8 解码；非法序列会变成 U+FFFD） */
export function fromBytes(bs) {
  if (typeof TextDecoder !== 'function') return bs;
  return new TextDecoder('utf-8').decode(byteStrToU8(bs));
}

export class CError extends Error {
  constructor(msg) { super(msg); this.name = 'CError'; }
}
/** 运行期错误（段错误、除零……） */
export class Fault extends CError {
  constructor(msg) { super(msg); this.name = 'Fault'; }
}
/** 语法/语义错误（带位置） */
export class CompileError extends CError {
  constructor(msg, line, col, file) {
    super(msg); this.name = 'CompileError';
    this.line = line; this.col = col; this.file = file;
  }
}
/** 程序调用 exit() 主动结束 */
export class ExitSignal extends CError {
  constructor(code) { super('程序正常结束'); this.name = 'ExitSignal'; this.code = code; }
}

// ───────────────────────────── 类型系统 ─────────────────────────────
let _tid = 1;
function T(o) { o.id = _tid++; if (o.name === undefined) o.name = ''; return o; }

export const VOID = T({ kind: 'void', size: 0, align: 1, name: 'void' });
export const BOOL = T({ kind: 'int', size: 1, align: 1, signed: false, name: '_Bool', bool: true });
export const CHAR = T({ kind: 'int', size: 1, align: 1, signed: true, name: 'char' });
export const SCHAR = T({ kind: 'int', size: 1, align: 1, signed: true, name: 'signed char' });
export const UCHAR = T({ kind: 'int', size: 1, align: 1, signed: false, name: 'unsigned char' });
export const SHORT = T({ kind: 'int', size: 2, align: 2, signed: true, name: 'short' });
export const USHORT = T({ kind: 'int', size: 2, align: 2, signed: false, name: 'unsigned short' });
export const INT = T({ kind: 'int', size: 4, align: 4, signed: true, name: 'int' });
export const UINT = T({ kind: 'int', size: 4, align: 4, signed: false, name: 'unsigned int' });
export const LONG = T({ kind: 'int', size: 4, align: 4, signed: true, name: 'long' });
export const ULONG = T({ kind: 'int', size: 4, align: 4, signed: false, name: 'unsigned long' });
export const LLONG = T({ kind: 'int', size: 8, align: 8, signed: true, name: 'long long' });
export const ULLONG = T({ kind: 'int', size: 8, align: 8, signed: false, name: 'unsigned long long' });
export const FLOAT = T({ kind: 'float', size: 4, align: 4, name: 'float' });
export const DOUBLE = T({ kind: 'float', size: 8, align: 8, name: 'double' });
export const LDOUBLE = T({ kind: 'float', size: 8, align: 8, name: 'long double' });

export function enumType(tag) {
  return T({ kind: 'enum', size: 4, align: 4, signed: true, name: tag ? `enum ${tag}` : 'enum' });
}
export function newStruct(tag, isUnion) {
  return T({
    kind: isUnion ? 'union' : 'struct', tag: tag || null, members: [], size: 0, align: 1,
    complete: false, name: (isUnion ? 'union ' : 'struct ') + (tag || '<匿名>'),
  });
}

const _ptrCache = new Map();
export function ptrTo(base) {
  let r = _ptrCache.get(base.id);
  if (!r) { r = T({ kind: 'ptr', base, size: 8, align: 8 }); r.name = ''; _ptrCache.set(base.id, r); }
  return r;
}
const _arrCache = new Map();
export function arrayOf(base, len) {
  const key = base.id + 'x' + (len === null ? '?' : len);
  let r = _arrCache.get(key);
  if (!r) {
    r = T({ kind: 'array', base, len, size: len === null ? 0 : base.size * len, align: base.align });
    _arrCache.set(key, r);
  }
  return r;
}
export function funcType(ret, params, variadic, paramNames) {
  return T({
    kind: 'func', ret, params: params || [], variadic: !!variadic, paramNames: paramNames || null,
    size: 8, align: 8, name: '',
  });
}

export const isInt = (t) => t.kind === 'int' || t.kind === 'enum';
export const isFloat = (t) => t.kind === 'float';
export const isArith = (t) => isInt(t) || isFloat(t);
export const isPtr = (t) => t.kind === 'ptr';
export const isArray = (t) => t.kind === 'array';
export const isFunc = (t) => t.kind === 'func';
export const isAggr = (t) => t.kind === 'struct' || t.kind === 'union' || t.kind === 'array';
export const isVoid = (t) => t.kind === 'void';
export const isSigned = (t) => isFloat(t) || !!t.signed;

/** 整型提升：char/short/_Bool/enum → int */
export function promote(t) {
  if (t.kind === 'enum') return INT;
  if (t.kind === 'int' && t.size < 4) return INT;
  return t;
}
function rank(t) {
  switch (t.size) {
    case 1: return 1;
    case 2: return 2;
    case 4: return 3;
    default: return 4;
  }
}
/** 常用算术转换：决定二元运算的结果类型 */
export function usualArith(a, b) {
  if (!isArith(a) || !isArith(b)) return a;
  a = promote(a); b = promote(b);
  if (a.kind === 'float' && b.kind === 'float') return a.size >= b.size ? a : b;
  if (a.kind === 'float') return a;
  if (b.kind === 'float') return b;
  if (a.size !== b.size) return rank(a) > rank(b) ? a : b;
  // 同宽度：有符号 vs 无符号 → 无符号
  if (!a.signed || !b.signed) {
    if (a.size === 4) return UINT;
    if (a.size === 8) return ULLONG;
    return a.size === 1 ? UCHAR : USHORT;
  }
  return a;
}
/** 数组/函数自动退化（array-to-pointer decay） */
export function decay(t) {
  if (t.kind === 'array') return ptrTo(t.base);
  if (t.kind === 'func') return ptrTo(t);
  return t;
}

export function alignTo(n, a) { return Math.ceil(n / (a || 1)) * (a || 1); }

export function computeLayout(s) {
  let off = 0, maxAlign = 1;
  for (const m of s.members) {
    const a = m.type.align || 1;
    if (a > maxAlign) maxAlign = a;
    if (s.kind === 'union') { m.offset = 0; }
    else { off = alignTo(off, a); m.offset = off; off += m.type.size; }
  }
  s.align = maxAlign;
  s.size = s.kind === 'union'
    ? Math.max(0, ...s.members.map((m) => m.type.size))
    : alignTo(off, maxAlign);
  s.size = Math.max(s.align, s.size);
  s.complete = true;
  return s;
}

export function typeName(t) {
  if (!t) return '?';
  switch (t.kind) {
    case 'ptr': return typeName(t.base) + ' *';
    case 'array': return typeName(t.base) + (t.len === null ? '[]' : `[${t.len}]`);
    case 'func': return typeName(t.ret) + ' (*)(' + t.params.map(typeName).join(', ') + ')';
    case 'struct': case 'union': case 'enum': return t.name;
    default: return t.name || 'int';
  }
}

// ───────────────────────────── 数值处理 ─────────────────────────────
/** 整型按宽度/符号截断，模拟真实 C 的回绕 */
export function wrapInt(v, t) {
  if (t.kind === 'float') return v;
  const size = t.size, signed = !!t.signed;
  if (size === 1) return signed ? (v << 24) >> 24 : v & 0xff;
  if (size === 2) return signed ? (v << 16) >> 16 : v & 0xffff;
  if (size === 4) return signed ? (v | 0) : (v >>> 0);
  return v;
}
export function truncToInt(v) {
  if (typeof v === 'bigint') v = Number(v);
  if (!isFinite(v)) throw new Fault('浮点数转换为整数时溢出（请检查数学运算）');
  return v < 0 ? Math.ceil(v) : Math.floor(v);
}
export function toNumber(v) {
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}
export function truthy(v) {
  if (typeof v === 'number') return v !== 0 && !Number.isNaN(v);
  if (v && v.agg) return true;
  return !!v;
}

// ───────────────────────────── 内存 ─────────────────────────────
export class Memory {
  constructor(size = MEM_SIZE) {
    this.size = size;
    this.buf = new ArrayBuffer(size);
    this.u8 = new Uint8Array(this.buf);
    this.dv = new DataView(this.buf);
    this.staticTop = REG.staticStart;
    this.sp = REG.stackTop;
    this.heapFree = [{ addr: REG.heapStart, size: REG.heapEnd - REG.heapStart }];
    this.blocks = new Map();       // addr → size
    this.freedPages = new Map();   // page → [[start,end],...]
    this.roRanges = [];            // 只读区间（字符串常量）
    this.roPages = new Set();      // 粗粒度页标记，快速判定
    this.stackHigh = REG.stackTop;
    this.blockSorted = [];         // 排序后的堆块索引（惰性重建）
    this.blockDirty = false;
  }

  fault(msg) { throw new Fault(msg); }

  /** 堆块索引失效（malloc/free/realloc 后调用） */
  invalidateBlocks() { this.blockDirty = true; }

  /**
   * 命中堆区时检查地址确实落在某个仍存活的 malloc 块内。
   * 这样 a[3] 越过 malloc 出来的 2*sizeof(int) 会报错，而不是静默写到邻居块里。
   */
  checkHeapBlock(addr, len) {
    if (this.blockDirty) {
      this.blockSorted = [...this.blocks.entries()]
        .map(([a, n]) => ({ addr: a, size: n }))
        .sort((x, y) => x.addr - y.addr);
      this.blockDirty = false;
    }
    const list = this.blockSorted;
    let lo = 0, hi = list.length - 1, hit = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].addr <= addr) { hit = list[mid]; lo = mid + 1; } else hi = mid - 1;
    }
    if (!hit || addr + len > hit.addr + hit.size) {
      this.fault(`段错误：堆越界访问（地址 0x${addr.toString(16)}，长度 ${len}，不落在任何 malloc 分配的块内）`);
    }
  }

  check(addr, len, write = false) {
    if (typeof addr !== 'number' || Number.isNaN(addr)) this.fault('指针地址无效');
    if (addr === 0) this.fault('段错误：解引用空指针（地址 0）');
    if (addr < REG.nullEnd || addr < 0) this.fault(`段错误：非法内存地址 0x${(addr >>> 0).toString(16)}`);
    if (addr + len > this.size) this.fault(`段错误：越界访问（地址 0x${addr.toString(16)} 超出可访问内存上限）`);
    if (addr >= REG.heapStart && addr < REG.heapEnd) this.checkHeapBlock(addr, len);
    if (write) {
      const page = addr >> 12;
      if (this.roPages.has(page)) {
        for (const [s, e] of this.roRanges) {
          if (addr < e && addr + len > s) this.fault('段错误：试图修改只读内存（字符串常量不可写）');
        }
      }
      if (this.freedPages.size) {
        const list = this.freedPages.get(page);
        if (list) for (const [s, e] of list) {
          if (addr < e && addr + len > s) this.fault('段错误：访问了已经 free 释放的内存');
        }
      }
    }
  }

  readInt(addr, size, signed) {
    this.check(addr, size);
    switch (size) {
      case 1: { const v = this.u8[addr]; return signed ? (v << 24) >> 24 : v; }
      case 2: { const v = this.dv.getUint16(addr, true); return signed ? (v << 16) >> 16 : v; }
      case 4: return signed ? this.dv.getInt32(addr, true) : this.dv.getUint32(addr, true);
      case 8: {
        const lo = this.dv.getUint32(addr, true), hi = this.dv.getUint32(addr + 4, true);
        const v = hi * 4294967296 + lo;
        return v;
      }
      default: this.fault(`不支持的整数宽度 ${size}`);
    }
  }
  writeInt(addr, size, v) {
    this.check(addr, size, true);
    v = Math.trunc(v) || 0;
    switch (size) {
      case 1: this.u8[addr] = v & 0xff; break;
      case 2: this.dv.setUint16(addr, v & 0xffff, true); break;
      case 4: this.dv.setUint32(addr, v >>> 0, true); break;
      case 8: {
        const neg = v < 0;
        let u = neg ? v + 18446744073709551616 : v;
        const lo = u % 4294967296, hi = Math.floor(u / 4294967296);
        this.dv.setUint32(addr, lo >>> 0, true);
        this.dv.setUint32(addr + 4, hi >>> 0, true);
        break;
      }
      default: this.fault(`不支持的整数宽度 ${size}`);
    }
  }
  readF32(a) { this.check(a, 4); return this.dv.getFloat32(a, true); }
  writeF32(a, v) { this.check(a, 4, true); this.dv.setFloat32(a, v, true); }
  readF64(a) { this.check(a, 8); return this.dv.getFloat64(a, true); }
  writeF64(a, v) { this.check(a, 8, true); this.dv.setFloat64(a, v, true); }

  load(addr, t) {
    if (t.kind === 'float') return t.size === 4 ? this.readF32(addr) : this.readF64(addr);
    if (t.kind === 'ptr' || t.kind === 'func') return this.readInt(addr, 8, false);
    if (isInt(t)) return this.readInt(addr, t.size, !!t.signed);
    if (isAggr(t)) return { agg: true, addr, type: t };
    this.fault(`无法读取类型 ${typeName(t)}`);
  }
  store(addr, t, v) {
    if (t.kind === 'float') { t.size === 4 ? this.writeF32(addr, v) : this.writeF64(addr, v); return; }
    if (t.kind === 'ptr' || t.kind === 'func') { this.writeInt(addr, 8, v); return; }
    if (isInt(t)) { this.writeInt(addr, t.size, wrapInt(v, t)); return; }
    if (isAggr(t)) {
      if (!v || !v.agg) this.fault('内部错误：聚合类型赋值缺少来源');
      this.copy(addr, v.addr, t.size);
      return;
    }
    this.fault(`无法写入类型 ${typeName(t)}`);
  }
  copy(dst, src, n) {
    this.check(dst, n, true); this.check(src, n);
    this.u8.copyWithin(dst, src, src + n);
  }
  fill(addr, n, byte = 0) { this.check(addr, n, true); this.u8.fill(byte, addr, addr + n); }

  staticAlloc(n, align = 1) {
    n = Math.max(1, n);
    const addr = alignTo(this.staticTop, align);
    if (addr + n > REG.staticEnd) this.fault('静态存储区已满（全局变量/字符串常量过多）');
    this.staticTop = addr + n;
    return addr;
  }
  /** 标记一段只读（字符串常量） */
  markReadOnly(addr, n) {
    this.roRanges.push([addr, addr + n]);
    for (let p = addr >> 12; p <= (addr + n) >> 12; p++) this.roPages.add(p);
  }
  alloca(n, align = 1) {
    const addr = alignTo(this.sp - Math.max(1, n), align);
    if (addr < REG.stackLimit) this.fault('栈溢出：递归层数过深或局部变量过大');
    this.sp = addr;
    return addr;
  }

  malloc(n) {
    if (n < 0) this.fault('malloc 的参数为负数');
    n = Math.max(1, Math.ceil(n / 16) * 16);
    for (let i = 0; i < this.heapFree.length; i++) {
      const b = this.heapFree[i];
      if (b.size >= n) {
        const addr = b.addr;
        if (b.size === n) this.heapFree.splice(i, 1);
        else { b.addr += n; b.size -= n; }
        this.blocks.set(addr, n);
        this.invalidateBlocks();
        this._clearFreed(addr, n);
        this.u8.fill(0, addr, addr + n);
        return addr;
      }
    }
    return 0; // malloc 失败返回 NULL
  }
  free(p) {
    if (!p) return;
    const n = this.blocks.get(p);
    if (n === undefined) this.fault('非法 free：该地址不是 malloc/calloc/realloc 返回的指针（或已被释放）');
    this.blocks.delete(p);
    this.invalidateBlocks();
    this._rememberFreed(p, n);
    this.heapFree.push({ addr: p, size: n });
    this.heapFree.sort((a, b) => a.addr - b.addr);
    for (let i = 0; i < this.heapFree.length - 1; i++) {
      const a = this.heapFree[i], b = this.heapFree[i + 1];
      if (a.addr + a.size === b.addr) { a.size += b.size; this.heapFree.splice(i + 1, 1); i--; }
    }
  }
  _rememberFreed(addr, n) {
    for (let p = addr >> 12; p <= (addr + n) >> 12; p++) {
      let l = this.freedPages.get(p);
      if (!l) { l = []; this.freedPages.set(p, l); }
      l.push([addr, addr + n]);
      if (l.length > 64) l.shift();
    }
    if (this.freedPages.size > 4096) this.freedPages.clear();
  }

  /** 重新分配到的地址不再算「已释放」，否则复用堆块会被误报为 free 后使用 */
  _clearFreed(addr, n) {
    if (!this.freedPages.size) return;
    const end = addr + n;
    for (let p = addr >> 12; p <= (end - 1) >> 12; p++) {
      const l = this.freedPages.get(p);
      if (!l) continue;
      const keep = l.filter(([s, e]) => e <= addr || s >= end);
      if (keep.length) this.freedPages.set(p, keep);
      else this.freedPages.delete(p);
    }
  }

  readCString(addr, limit = 4096) {
    if (!addr) return null;
    this.check(addr, 1);
    let end = addr;
    const max = Math.min(addr + limit, this.size);
    while (end < max && this.u8[end] !== 0) end++;
    let s = '';
    const CH = 8192;
    for (let i = addr; i < end; i += CH) {
      s += String.fromCharCode.apply(null, this.u8.subarray(i, Math.min(i + CH, end)));
    }
    return s;
  }
  writeCString(addr, s) {
    this.check(addr, s.length + 1, true);
    for (let i = 0; i < s.length; i++) this.u8[addr + i] = s.charCodeAt(i) & 0xff;
    this.u8[addr + s.length] = 0;
  }
  /** 从指针读一个 wchar 无关：按字节读任意 UTF-8 兼容串（本引擎内部字符串均为字节串） */
}

// ───────────────────────────── 调试取值格式化 ─────────────────────────────
export function formatValue(mem, addr, t, depth = 0) {
  try {
    if (t.kind === 'ptr') {
      const p = mem.load(addr, t);
      if (!p) return 'NULL';
      if (t.base.kind === 'int' && t.base.size === 1) {
        const s = mem.readCString(p, 80);
        if (s !== null) {
          const u = fromBytes(s);
          return `"${u.length > 40 ? u.slice(0, 40) + '…' : u}"`;
        }
      }
      return `0x${p.toString(16)}`;
    }
    if (isInt(t) && t.size === 1) {
      const c = mem.load(addr, t);
      const ch = (c >= 32 && c < 127) ? String.fromCharCode(c) : null;
      return ch ? `${c} ('${ch}')` : String(c);
    }
    if (isArith(t)) {
      const v = mem.load(addr, t);
      if (isFloat(t)) return Number.isInteger(v) ? v.toFixed(1) : String(Number(v.toPrecision(10)));
      return String(v);
    }
    if (t.kind === 'array') {
      if (depth > 2) return '{…}';
      const n = Math.min(t.len === null ? 0 : t.len, 16);
      const parts = [];
      for (let i = 0; i < n; i++) parts.push(formatValue(mem, addr + i * t.base.size, t.base, depth + 1));
      const more = t.len > n ? ', …' : '';
      return `{${parts.join(', ')}${more}}`;
    }
    if (t.kind === 'struct' || t.kind === 'union') {
      if (depth > 2) return '{…}';
      const parts = t.members.map((m) => `${m.name}=${formatValue(mem, addr + m.offset, m.type, depth + 1)}`);
      return `{${parts.join(', ')}}`;
    }
    if (t.kind === 'func') return '<函数>';
    return '?';
  } catch (e) {
    return `<无法读取: ${e.message}>`;
  }
}
