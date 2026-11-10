// 掌心 C · 解释执行器（异步：支持 scanf 中途输入 & 断点单步调试）
import {
  Memory, Fault, REG, isInt, isFloat, isPtr, isArray, isAggr, isFunc, isVoid,
  wrapInt, truncToInt, truthy, formatValue, typeName, decay, toBytes, byteStrToU8,
} from './core.js';

const MAX_CALL_DEPTH = 300;

class GotoSignal { constructor(name) { this.__goto = name; } }

export class Interpreter {
  constructor(program, io = {}, opts = {}) {
    this.program = program;
    this.io = io;
    this.opts = opts;
    this.mem = new Memory();
    // 芯片模型（可选）：接管 0x4000_0000 以上的外设寄存器，并提供 tick 驱动
    if (opts.chip) {
      this.chip = opts.chip;
      this.mem.bus = opts.chip;
    }
    this.fns = program.functions;
    this.fnByName = new Map(program.functions.map((f) => [f.name, f]));
    this.globalByName = new Map(program.globals.map((g) => [g.name, g]));
    this.out = '';
    this.outLen = 0;
    this.inBuf = '';
    this.inPos = 0;
    this.frame = null;
    this.depth = 0;
    this.callStack = [];
    this.curPos = { line: 0, file: '' };
    this.strCache = new Map();
    this.steps = 0;
    this.stepLimit = opts.stepLimit || 0;
    this.deadline = opts.deadline || 0;
    this.dbg = null;      // {breakpoints:Set<string>, mode, onPause}
    this.lastPausedNode = null;
    this.aborted = false;
    this.finished = false;
    // 协作式让步：每执行这么多步让出一次事件循环，
    // 这样在 Worker 里跑死循环时，主线程发来的「停止」消息才送得进来。
    this.yieldEvery = opts.yieldEvery === undefined ? 8192 : opts.yieldEvery;
    this.coop = opts.coop !== false;
    this._chan = null;
  }

  // ───────────── 输出 / 输入 ─────────────
  write(s) {
    this.out += s;
    this.outLen += s.length;
    if (this.outLen > 8192) this.flush();
  }
  flush() {
    if (this.out) {
      const bs = this.out;
      this.out = '';
      this.outLen = 0;
      if (this.io.write) this.io.write(this.decodeOut(bs));
    }
  }
  /** 内存里的输出是 UTF-8 字节串，这里解码成真正的 Unicode 文本再交给宿主 */
  decodeOut(bs) {
    if (typeof TextDecoder !== 'function') return bs;
    if (!this._dec) this._dec = new TextDecoder('utf-8');
    // stream: true —— 一个汉字可能被 flush 边界劈成两半，跨块延续解码
    return this._dec.decode(byteStrToU8(bs), { stream: true });
  }
  async fillInput() {
    if (!this.io.requestInput) return false;
    // 先把手上的输出刷出去，用户才能看见 "请输入：" 这类提示
    this.flush();
    const line = await this.io.requestInput();
    if (line === null || line === undefined) return false;
    // 用户输入的也是 Unicode 文本，进内存前按 UTF-8 转成字节串
    this.inBuf = toBytes(String(line)) + '\n';
    this.inPos = 0;
    if (this.io.echoInput) this.io.echoInput(String(line));
    return true;
  }
  async needChar() {
    while (this.inPos >= this.inBuf.length) {
      const ok = await this.fillInput();
      if (!ok) return null;
    }
    const c = this.inBuf[this.inPos];
    this.inPos++;
    if (c === '\r') return ' ';
    return c;
  }
  /** 读一行（含换行）；到 EOF 返回 null */
  async readLineStr() {
    let s = '';
    for (;;) {
      if (this.inPos >= this.inBuf.length) {
        const ok = await this.fillInput();
        if (!ok) return s.length ? s : null;
      }
      const c = this.inBuf[this.inPos++];
      if (c === '\n') return s + '\n';
      s += c;
    }
  }
  /** 若缓冲区没有数据则预取一行 */
  async peekChar() {
    if (this.inPos >= this.inBuf.length) {
      const ok = await this.fillInput();
      if (!ok) return null;
      return this.inBuf[this.inPos];
    }
    return this.inBuf[this.inPos];
  }

  // ───────────── 启动 ─────────────
  async run() {
    this.initGlobals();
    const main = this.fnByName.get('main');
    if (!main) throw new Fault('找不到 main 函数');
    let args = [];
    if (main.type.params.length >= 2) {
      const argvList = [this.makeString('main')];
      const argvArr = this.mem.staticAlloc((argvList.length + 1) * 8, 8);
      for (let i = 0; i < argvList.length; i++) this.mem.writeInt(argvArr + i * 8, 8, argvList[i]);
      this.mem.writeInt(argvArr + argvList.length * 8, 8, 0);
      args = [argvList.length, argvArr];
    }
    this.flush();
    this.finished = false;
    await this.callFunction(main, args, null, null);
    this.finished = true;
    this.flush();
    return { ok: true };
  }

  makeString(s) {
    const addr = this.mem.staticAlloc(s.length + 1, 1);
    this.mem.writeCString(addr, s);
    this.mem.markReadOnly(addr, s.length + 1);
    return addr;
  }

  initGlobals() {
    for (const g of this.program.globals) {
      if (g.extern) continue;
      let size = g.type.size;
      if (g.type.kind === 'array' && g.type.len === null) size = 0;
      g.addr = this.mem.staticAlloc(Math.max(size, 1), Math.max(g.type.align || 1, 1));
    }
    // 初始化（先分配地址，才能处理 &x 这类初值）
    const self = this;
    for (const g of this.program.globals) {
      if (g.extern || !g.init) continue;
      for (const it of g.init.items) {
        const addr = g.addr + it.offset;
        if (it.str !== undefined) {
          this.writeStrItem(addr, it);
        } else if (it.expr) {
          const v = this.evalSync(it.expr, null);
          this.mem.store(addr, it.type, toStoreValue(v));
        }
      }
    }
  }
  writeStrItem(addr, it) {
    const s = it.str;
    let max = it.type.kind === 'array' ? (it.type.len == null ? s.length + 1 : it.type.len) : s.length + 1;
    const n = Math.min(s.length, Math.max(0, max - 1));
    this.mem.check(addr, n + 1, true);
    for (let i = 0; i < n; i++) this.mem.u8[addr + i] = s.charCodeAt(i) & 0xff;
    if (n < max) this.mem.u8[addr + n] = 0;
  }

  /** 全局初始化只允许简单表达式，这里提供一个同步快速路径 */
  evalSync(node, frame) {
    switch (node.k) {
      case 'num': return node.v;
      case 'str': return this.strAddr(node);
      case 'neg': { const v = this.evalSync(node.expr, frame); return -v; }
      case 'not': return this.evalSync(node.expr, frame) ? 0 : 1;
      case 'cast': {
        const v = this.evalSync(node.expr, frame);
        return castValue(v, node.expr.ty, node.ty);
      }
      case 'bin': {
        const a = this.evalSync(node.a, frame), b = this.evalSync(node.b, frame);
        return this.binOp(node.op, a, b, node);
      }
      case 'var': {
        if (node.sym.kind === 'func') return node.sym.funcIndex;
        const addr = this.varAddr(node.sym, frame);
        const v = this.mem.load(addr, node.sym.type);
        return isAggr(node.sym.type) ? { agg: true, addr, type: node.sym.type } : v;
      }
      case 'addr': return this.lvAddrSync(node.expr, frame);
      case 'funcaddr': return node.sym.funcIndex;
      case 'member': { const a = this.lvAddrSync(node, frame); const v = this.mem.load(a, node.ty); return isAggr(node.ty) ? { agg: true, addr: a, type: node.ty } : v; }
      case 'commma': case 'comma': { this.evalSync(node.a, frame); return this.evalSync(node.b, frame); }
      case 'cond': return this.evalSync(node.cond, frame) ? this.evalSync(node.a, frame) : this.evalSync(node.b, frame);
      case 'sizeof': return node.v;
      default:
        throw new Fault(`这里不能使用需要调用函数的表达式（表达式类型：${node.k}）`);
    }
  }
  strAddr(node) {
    let a = this.strCache.get(node);
    if (!a) { a = this.makeString(node.v); this.strCache.set(node, a); }
    return a;
  }

  // ───────────── 地址 ─────────────
  varAddr(sym, frame) {
    if (sym.kind === 'local') {
      if (!frame) throw new Fault(`内部错误：没有函数上下文却访问了局部变量 '${sym.name}'`);
      return frame.base + sym.offset;
    }
    if (sym.addr === 0 && !sym.extern) throw new Fault(`内部错误：全局变量 '${sym.name}' 未分配地址`);
    return sym.addr;
  }

  async lvAddr(node, frame) {
    switch (node.k) {
      case 'var': {
        const s = node.sym;
        if (s.kind === 'func') throw new Fault(`函数名 '${s.name}' 不能取地址后赋值`);
        return this.varAddr(s, frame);
      }
      case 'deref': {
        const p = numOf(await this.evalExpr(node.expr, frame));
        this.mem.check(p, 1);
        return p;
      }
      case 'member': {
        let base;
        if (node.arrow) {
          const p = numOf(await this.evalExpr(node.expr, frame));
          this.mem.check(p, 1);
          base = p;
        } else {
          base = await this.lvAddr(node.expr, frame);
        }
        return base + node.member.offset;
      }
      case 'comma': { await this.evalExpr(node.a, frame); return this.lvAddr(node.b, frame); }
      default:
        throw new Fault('内部错误：需要左值');
    }
  }

  /** 同步版左值求值：只用于全局初始化这类没有函数调用的场合 */
  lvAddrSync(node, frame) {
    switch (node.k) {
      case 'var': {
        const s = node.sym;
        if (s.kind === 'func') throw new Fault(`函数名 '${s.name}' 不能取地址后赋值`);
        return this.varAddr(s, frame);
      }
      case 'deref': return this.evalNum(node.expr, frame);
      case 'member': {
        const base = node.arrow ? this.evalNum(node.expr, frame) : this.lvAddrSync(node.expr, frame);
        return base + node.member.offset;
      }
      case 'comma': { this.evalSync(node.a, frame); return this.lvAddrSync(node.b, frame); }
      default:
        throw new Fault('内部错误：需要左值');
    }
  }

  evalNum(node, frame) {
    const v = this.evalSync(node, frame);
    if (v && v.agg) throw new Fault(`这里需要一个数值，但得到的是 ${typeName(node.ty)} 类型的整体对象`);
    return v;
  }

  // ───────────── 异步表达式求值（主路径） ─────────────
  async evalExpr(node, frame) {
    switch (node.k) {
      case 'num': return node.v;
      case 'str': return this.strAddr(node);
      case 'var': {
        const s = node.sym;
        if (!s) throw new Fault('内部错误：未解析的标识符');
        if (s.kind === 'func') return s.funcIndex;
        if (s.kind === 'builtin') throw new Fault(`内置函数 '${s.name}' 不能当值使用`);
        const addr = this.varAddr(s, frame);
        if (isAggr(s.type)) return { agg: true, addr, type: s.type };
        return this.mem.load(addr, s.type);
      }
      case 'member': {
        const addr = await this.lvAddr(node, frame);
        if (isAggr(node.ty)) return { agg: true, addr, type: node.ty };
        return this.mem.load(addr, node.ty);
      }
      case 'deref': {
        const addr = await this.lvAddr(node, frame);
        if (isAggr(node.ty)) return { agg: true, addr, type: node.ty };
        return this.mem.load(addr, node.ty);
      }
      case 'addr': return this.lvAddr(node.expr, frame);
      case 'funcaddr': return node.sym.funcIndex;
      case 'cast': {
        const v = await this.evalExpr(node.expr, frame);
        return castValue(v, node.expr.ty, node.ty);
      }
      case 'neg': {
        const v = await this.evalExpr(node.expr, frame);
        return wrapInt(-numOf(v), node.ty);
      }
      case 'not': {
        const v = await this.evalExpr(node.expr, frame);
        return truthy(numOf(v)) ? 0 : 1;
      }
      case 'bin': {
        if (node.op === '~') {
          const a = numOf(await this.evalExpr(node.a, frame));
          return wrapInt(~a, node.ty);
        }
        const a = await this.evalExpr(node.a, frame);
        const b = await this.evalExpr(node.b, frame);
        return this.binOp(node.op, numOf(a), numOf(b), node);
      }
      case 'logand': {
        const a = await this.evalExpr(node.a, frame);
        if (!truthy(numOf(a))) return 0;
        const b = await this.evalExpr(node.b, frame);
        return truthy(numOf(b)) ? 1 : 0;
      }
      case 'logor': {
        const a = await this.evalExpr(node.a, frame);
        if (truthy(numOf(a))) return 1;
        const b = await this.evalExpr(node.b, frame);
        return truthy(numOf(b)) ? 1 : 0;
      }
      case 'cond': {
        const c = await this.evalExpr(node.cond, frame);
        return truthy(numOf(c)) ? this.evalExpr(node.a, frame) : this.evalExpr(node.b, frame);
      }
      case 'comma': {
        await this.evalExpr(node.a, frame);
        return this.evalExpr(node.b, frame);
      }
      case 'ptrarith': {
        const p = numOf(await this.evalExpr(node.ptr, frame));
        const base = node.ty.base.size;
        const idx = numOf(await this.evalExpr(node.index, frame));
        return p + (node.op === '-' ? -idx : idx) * base;
      }
      case 'ptrsub': {
        const a = numOf(await this.evalExpr(node.a, frame));
        const b = numOf(await this.evalExpr(node.b, frame));
        const sz = node.a.ty.kind === 'array' ? node.a.ty.base.size : node.a.ty.base.size;
        return Math.trunc((a - b) / sz);
      }
      case 'incdec': {
        const addr = await this.lvAddr(node.expr, frame);
        const ty = node.expr.ty;
        const step = isPtr(ty) ? Math.max(1, ty.base.size) : 1;
        const old = this.mem.load(addr, ty);
        const nv = this.mem.store(addr, ty, wrapInt(numOf(old) + node.delta * (isPtr(ty) ? step : 1), ty));
        return node.prefix ? numOf(this.mem.load(addr, ty)) : numOf(old);
      }
      case 'assign': {
        const addr = await this.lvAddr(node.lhs, frame);
        const v = await this.evalExpr(node.rhs, frame);
        if (isAggr(node.lhs.ty)) { this.mem.store(addr, node.ty, v); return v; }
        const nv = storeScalar(this.mem, addr, node.ty, numOf(v));
        return nv;
      }
      case 'call': return this.doCall(node, frame);
      case 'callp': return this.doIndirectCall(node, frame);
      case 'builtin': {
        const vals = [];
        for (const a of node.args) {
          const v = await this.evalExpr(a, frame);
          vals.push(v && v.agg ? { agg: true, addr: v.addr, type: a.ty } : v);
        }
        const r = await node.fn(this, vals, node);
        return r === undefined ? 0 : r;
      }
      case 'vaarg': {
        const lap = await this.lvAddr(node.ap, frame);
        const p = this.mem.readInt(lap, 8, false);
        this.mem.check(p, 8);
        let v;
        if (isFloat(node.ty)) v = this.mem.readF64(p);
        else if (isPtr(node.ty)) v = this.mem.readInt(p, 8, false);
        else v = this.mem.readInt(p, Math.max(1, node.ty.size), !!node.ty.signed);
        this.mem.writeInt(lap, 8, p + 8);
        return v;
      }
      case 'vabuiltin': {
        if (node.op === 'start') {
          const lap = await this.lvAddr(node.ap, frame);
          // 可变参数统一放在局部变量区之后（按 8 字节对齐），与 callFunction 的摆放一致
          const base = frame.base + alignUp(frame.fn.frameSize, 8);
          this.mem.writeInt(lap, 8, base);
          return 0;
        }
        if (node.op === 'copy') {
          const d = await this.lvAddr(node.ap, frame);
          const s = await this.lvAddr(node.lastNode, frame);
          this.mem.writeInt(d, 8, this.mem.readInt(s, 8, false));
          return 0;
        }
        return 0;
      }
      default:
        throw new Fault(`内部错误：无法求值的表达式类型 ${node.k}`);
    }
  }

  binOp(op, a, b, node) {
    const ty = node.operandTy || node.ty;
    const isF = isFloat(node.a ? node.a.ty : ty) || (node.b && node.b.ty && isFloat(node.b.ty));
    switch (op) {
      case '+': return isF ? a + b : wrapInt(a + b, ty);
      case '-': return isF ? a - b : wrapInt(a - b, ty);
      case '*': return isF ? a * b : wrapInt(a * b, ty);
      case '/':
        if (isF) return a / b;
        if (b === 0) throw new Fault('整数除以 0（除数为 0）');
        return wrapInt(Math.trunc(a / b), ty);
      case '%':
        if (b === 0) throw new Fault('整数取余时除数为 0');
        return wrapInt(a % b, ty);
      case '&': return wrapInt(a & b, ty);
      case '|': return wrapInt(a | b, ty);
      case '^': return wrapInt(a ^ b, ty);
      case '<<': return wrapInt(shiftLeft(a, b), ty);
      case '>>': return wrapInt(shiftRight(a, b, node.ty), ty);
      case '==': return a === b ? 1 : 0;
      case '!=': return a !== b ? 1 : 0;
      case '<': return a < b ? 1 : 0;
      case '>': return a > b ? 1 : 0;
      case '<=': return a <= b ? 1 : 0;
      case '>=': return a >= b ? 1 : 0;
      default: throw new Fault(`内部错误：未知运算符 ${op}`);
    }
  }

  // ───────────── 函数调用 ─────────────
  async doCall(node, frame) {
    let fn = node.sym ? node.sym.fn : null;
    if (node.sym && !fn) {
      // 补解析后写回
      fn = this.fnByName.get(node.sym.name);
      if (fn) node.sym.fn = fn;
    }
    if (!fn) {
      const nm = node.name || node.sym?.name || '?';
      const f = this.fnByName.get(nm);
      if (f) fn = f;
      else throw new Fault(`调用了未定义的函数 '${nm}'`);
    }
    const args = [];
    const n = node.args.length;
    for (let i = 0; i < n; i++) {
      const v = await this.evalExpr(node.args[i], frame);
      args.push(v);
    }
    let retSlot = 0;
    if (isAggr(fn.type.ret)) retSlot = this.allocTemp(fn.type.ret);
    return this.callFunction(fn, args, frame, retSlot, node.args.map((a) => a.ty));
  }

  async doIndirectCall(node, frame) {
    const idx = numOf(await this.evalExpr(node.fnExpr, frame));
    const fn = this.fns[idx];
    if (!fn) throw new Fault('函数指针无效（调用了未定义的函数地址）');
    const args = [];
    for (const a of node.args) args.push(await this.evalExpr(a, frame));
    let retSlot = 0;
    if (isAggr(fn.type.ret)) retSlot = this.allocTemp(fn.type.ret);
    return this.callFunction(fn, args, frame, retSlot, node.args.map((a) => a.ty));
  }

  /** 在“当前帧”里分配临时空间（用于返回结构体） */
  allocTemp(type) {
    const f = this.frame;
    const size = Math.max(type.size, 1);
    if (!f) throw new Fault('内部错误：没有函数上下文');
    if (f.tempUsed === undefined) f.tempUsed = 0;
    const off = alignUp(f.tempUsed, Math.max(type.align, 1));
    f.tempUsed = off + size;
    if (f.tempUsed > f.tempSize) throw new Fault('返回结构体所需的临时空间不足（一次调用里返回了过多结构体）');
    return f.tempBase + off;
  }

  async callFunction(fn, args, callerFrame, retSlot, argTypes) {
    if (!fn.body) throw new Fault(`函数 '${fn.name}' 只有声明，没有实现（缺少函数体）`);
    if (++this.depth > MAX_CALL_DEPTH) {
      this.depth--;
      throw new Fault(`函数调用层数超过 ${MAX_CALL_DEPTH} 层，可能是递归没有终止条件`);
    }
    const savedFrame = this.frame;
    const savedSp = this.mem.sp;
    const named = fn.params.length;
    const extra = Math.max(0, args.length - named);
    const TEMP = 2048;
    // 可变参数紧跟在局部变量区之后，并对齐到 8 字节（va_start 也是按这个规则推算）
    const extraBase = alignUp(fn.frameSize, 8);
    const size = extraBase + extra * 8 + TEMP + 32;
    let base;
    try {
      base = this.mem.alloca(size, 16);
    } catch (e) {
      this.depth--;
      this.frame = savedFrame;
      throw e;
    }
    this.mem.fill(base, size);
    const frame = {
      fn, base, retSlot: retSlot || 0, retValue: 0, depth: this.depth,
      tempBase: base + extraBase + extra * 8, tempSize: TEMP, tempUsed: 0,
    };
    // 参数落位
    for (let i = 0; i < named; i++) {
      const p = fn.params[i];
      const addr = base + p.sym.offset;
      const v = args[i];
      const pt = p.type;
      if (isAggr(pt)) {
        if (v && v.agg) this.mem.store(addr, pt, v);
      } else if (pt.kind === 'ptr' || pt.kind === 'func') {
        this.mem.store(addr, pt, numOf(v));
      } else if (isFloat(pt)) {
        this.mem.store(addr, pt, numOf(v));
      } else {
        this.mem.store(addr, pt, wrapInt(truncToInt(numOf(v)), pt));
      }
    }
    // 可变参数槽（8 字节一格，浮点存 double，其余存 64 位整数）
    for (let i = 0; i < extra; i++) {
      const addr = base + extraBase + i * 8;
      const v = args[named + i];
      const at = argTypes && argTypes[named + i];
      if (v && v.agg) this.mem.writeInt(addr, 8, v.addr);
      else if (at && (isFloat(at) || at.kind === 'float')) this.mem.writeF64(addr, numOf(v));
      else this.mem.writeInt(addr, 8, Math.trunc(numOf(v)));
    }
    this.frame = frame;
    this.callStack.push({ name: fn.name, line: fn.defToken?.line || 0, file: fn.defToken?.file || '' });
    await this.checkpoint(fn.body, frame, true);
    let sig = null;
    try {
      sig = await this.execBlock(fn.body, frame);
    } catch (e) {
      if (e instanceof GotoSignal) throw new Fault(`找不到标签 '${e.__goto}'（goto 只能跳到同一函数内的标签）`);
      throw e;
    }
    this.callStack.pop();
    this.frame = savedFrame;
    this.mem.sp = savedSp;
    this.depth--;
    if (sig === 'return') {
      const rv = frame.retValue;
      if (isAggr(fn.type.ret)) {
        return { agg: true, addr: retSlot, type: fn.type.ret };
      }
      if (isFloat(fn.type.ret)) return numOf(rv);
      if (isPtr(fn.type.ret)) return numOf(rv);
      if (isVoid(fn.type.ret)) return 0;
      return wrapInt(truncToInt(numOf(rv)), fn.type.ret);
    }
    if (isVoid(fn.type.ret)) return 0;
    // 没写 return 就走到结尾：返回 0（并告警过）
    return 0;
  }

  // ───────────── 语句执行 ─────────────
  // 让出一次事件循环（宏任务），让 Worker 能在长时间运行的循环里收到消息。
  yieldControl() {
    if (typeof MessageChannel === 'function') {
      // 每次新建并关闭：常驻通道会让 Node 进程无法退出（测试与基准会挂住）
      const ch = new MessageChannel();
      return new Promise((resolve) => {
        ch.port1.onmessage = () => { ch.port1.close(); ch.port2.close(); resolve(); };
        ch.port2.postMessage(0);
      });
    }
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  async checkpoint(node, frame, isCallEnter) {
    const pos = node && node.pos;
    if (pos) { this.curPos = pos; }
    if (this.callStack.length) {
      const top = this.callStack[this.callStack.length - 1];
      if (pos) { top.line = pos.line; top.file = pos.file; }
    }
    this.steps++;
    // 芯片模型：每执行若干步推进一次外设时间（SysTick 递减、TIM2 计数）
    if (this.chip && this.chip.tickEvery && (this.steps % this.chip.tickEvery) === 0) {
      this.chip.tick(this.chip.tickEvery);
    }
    if (this.stepLimit && this.steps > this.stepLimit) {
      throw new Fault(`程序执行步数超过上限（${this.stepLimit}），可能是死循环`);
    }
    if (this.deadline && (this.steps & 8191) === 0 && Date.now() > this.deadline) {
      throw new Fault('程序运行超时（可能有死循环），已自动中止');
    }
    if (this.aborted) throw new Fault('程序已被用户停止');
    if (this.coop && this.yieldEvery && (this.steps % this.yieldEvery) === 0) {
      await this.yieldControl();
      if (this.aborted) throw new Fault('程序已被用户停止');
    }
    if (!this.dbg || !pos) return;
    const d = this.dbg;
    const key = `${pos.file}:${pos.line}`;
    let shouldPause = false;
    if (d.mode === 'pause') shouldPause = true;
    else if (d.mode === 'stepIn') shouldPause = true;
    else if (d.mode === 'stepOver') shouldPause = this.depth <= d.targetDepth;
    else if (d.mode === 'stepOut') shouldPause = this.depth < d.targetDepth;
    else if (d.mode === 'run') shouldPause = d.breakpoints.has(key) || d.breakpoints.has(String(pos.line));
    if (shouldPause && this.lastPausedNode === node && !isCallEnter) shouldPause = false;
    if (!shouldPause) { if (d.mode === 'run') d.mode = 'run'; return; }
    d.mode = 'run';
    this.lastPausedNode = node;
    this.flush();
    const action = await d.onPause(this.snapshot(pos));
    if (!action) return;
    if (action.action === 'stop') { this.aborted = true; throw new Fault('程序已被用户停止'); }
    if (action.action === 'stepIn') { d.mode = 'stepIn'; }
    else if (action.action === 'stepOver') { d.mode = 'stepOver'; d.targetDepth = this.depth; }
    else if (action.action === 'stepOut') { d.mode = 'stepOut'; d.targetDepth = this.depth; }
    else if (action.action === 'pause') { d.mode = 'pause'; }
    else d.mode = 'run';
    if (action.breakpoints) {
      d.breakpoints = new Set(action.breakpoints);
    }
  }

  snapshot(pos) {
    const vars = [];
    const frame = this.frame;
    const seen = new Set();
    if (frame && frame.fn.locals) {
      for (let i = frame.fn.locals.length - 1; i >= 0; i--) {
        const l = frame.fn.locals[i];
        if (seen.has(l.name)) continue;
        seen.add(l.name);
        try {
          vars.push({ name: l.name, type: typeName(l.type), value: this.formatV(frame.base + l.offset, l.type), scope: 'local' });
        } catch { /* 忽略无法读取的变量 */ }
      }
    }
    const globals = [];
    for (const g of this.program.globals) {
      if (g.extern || g.blockStatic) continue;
      try {
        globals.push({ name: g.name, type: typeName(g.type), value: this.formatV(g.addr, g.type), scope: 'global' });
      } catch { /* ignore */ }
      if (globals.length > 60) break;
    }
    return {
      line: pos.line, file: pos.file,
      fn: frame ? frame.fn.name : '?',
      depth: this.depth,
      vars, globals,
      stack: this.callStack.slice(-24).reverse().map((s) => ({ name: s.name, line: s.line, file: s.file })),
      output: this.out,
    };
  }
  formatV(addr, type) { return formatValue(this.mem, addr, type); }

  async execBlock(node, frame) {
    const stmts = node.stmts;
    const labels = node.labels;
    for (let i = 0; i < stmts.length; i++) {
      if (labels) {
        try {
          const sig = await this.execStmt(stmts[i], frame);
          if (sig) return sig;
        } catch (e) {
          if (e instanceof GotoSignal && labels.has(e.__goto)) { i = labels.get(e.__goto) - 1; continue; }
          throw e;
        }
      } else {
        const sig = await this.execStmt(stmts[i], frame);
        if (sig) return sig;
      }
    }
    return null;
  }

  async execStmt(node, frame) {
    await this.checkpoint(node, frame);
    switch (node.k) {
      case 'block': return this.execBlock(node, frame);
      case 'empty': return null;
      case 'expr': await this.evalExpr(node.expr, frame); return null;
      case 'decl': {
        for (const v of node.vars) {
          if (!v.init) continue;
          const base = v.sym.kind === 'global' ? v.sym.addr : frame.base + v.sym.offset;
          await this.applyInit(v.init.items, base, frame, v.sym.type);
        }
        return null;
      }
      case 'if': {
        const c = await this.evalExpr(node.cond, frame);
        if (truthy(numOf(c))) return this.execStmt(node.then, frame);
        if (node.els) return this.execStmt(node.els, frame);
        return null;
      }
      case 'while': {
        for (;;) {
          await this.checkpoint(node, frame);
          const c = await this.evalExpr(node.cond, frame);
          if (!truthy(numOf(c))) break;
          const sig = await this.execStmt(node.body, frame);
          if (sig === 'break') break;
          if (sig && sig !== 'continue') return sig;
        }
        return null;
      }
      case 'do': {
        for (;;) {
          await this.checkpoint(node, frame);
          const sig = await this.execStmt(node.body, frame);
          if (sig === 'break') break;
          if (sig && sig !== 'continue') return sig;
          const c = await this.evalExpr(node.cond, frame);
          if (!truthy(numOf(c))) break;
        }
        return null;
      }
      case 'for': {
        if (node.init) {
          if (node.init.k === 'decl') {
            for (const v of node.init.vars) {
              if (!v.init) continue;
              const base = v.sym.kind === 'global' ? v.sym.addr : frame.base + v.sym.offset;
              await this.applyInit(v.init.items, base, frame, v.sym.type);
            }
          } else {
            await this.evalExpr(node.init.expr, frame);
          }
        }
        for (;;) {
          await this.checkpoint(node, frame);
          if (node.cond) {
            const c = await this.evalExpr(node.cond, frame);
            if (!truthy(numOf(c))) break;
          }
          const sig = await this.execStmt(node.body, frame);
          if (sig === 'break') break;
          if (sig && sig !== 'continue') return sig;
          if (node.step) await this.evalExpr(node.step, frame);
        }
        return null;
      }
      case 'switch': {
        const v = numOf(await this.evalExpr(node.cond, frame));
        let start = -1;
        for (let i = 0; i < node.stmts.length; i++) {
          const l = node.stmts[i].label;
          if (l && !l.isDefault && l.value === v) { start = i; break; }
        }
        if (start < 0) start = node.defaultIdx;
        if (start < 0) return null;
        for (let i = start; i < node.stmts.length; i++) {
          const sig = await this.execStmt(node.stmts[i].node, frame);
          if (sig === 'break') return null;
          if (sig) return sig;
        }
        return null;
      }
      case 'break': return 'break';
      case 'continue': return 'continue';
      case 'return': {
        if (node.expr) {
          const v = await this.evalExpr(node.expr, frame);
          if (isAggr(node.ret)) {
            if (frame.retSlot) this.mem.store(frame.retSlot, node.ret, v);
            frame.retValue = { agg: true, addr: frame.retSlot, type: node.ret };
          } else if (isPtr(node.ret)) {
            frame.retValue = numOf(v);
          } else {
            frame.retValue = numOf(v);
          }
        } else frame.retValue = 0;
        return 'return';
      }
      case 'goto': throw new GotoSignal(node.name);
      case 'label': return this.execStmt(node.stmt, frame);
      case 'case': return this.execStmt(node.stmt, frame);
      default:
        throw new Fault(`内部错误：未知语句类型 ${node.k}`);
    }
  }

  async applyInit(items, base, frame, type) {
    for (const it of items) {
      const addr = base + it.offset;
      if (it.str !== undefined) { this.writeStrItem(addr, it); continue; }
      if (!it.expr) continue;
      const v = await this.evalExpr(it.expr, frame);
      if (isAggr(it.type)) this.mem.store(addr, it.type, v);
      else this.mem.store(addr, it.type, numOf(v));
    }
  }
}

// ───────────── 小工具 ─────────────
function numOf(v) {
  if (v && v.agg) return v.addr;  // 罕见的整体对象当数值：退化成地址
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v === undefined || v === null) return 0;
  return v;
}
function nodeArgType() { return 'int'; }
function alignUp(n, a) { return Math.ceil(n / a) * a; }
function toStoreValue(v) { return v; }

function castValue(v, from, to) {
  if (!from || !to) return v;
  if (to.kind === 'void') return 0;
  if (isAggr(to)) {
    if (v && v.agg) return v;
    throw new Fault(`不能把 ${typeName(from)} 转换为 ${typeName(to)}`);
  }
  if (isAggr(from)) {
    // 结构体/数组 → 指针：取地址
    return v && v.agg ? v.addr : numOf(v);
  }
  const n = numOf(v);
  if (isPtr(to) || isPtr(from)) return n;
  if (isFloat(to)) return n;
  return wrapInt(truncToInt(n), to);
}

function storeScalar(mem, addr, ty, v) {
  const t = isInt(ty) ? ty : ty;
  mem.store(addr, t, isFloat(t) ? v : wrapInt(truncToInt(v), t));
  return isFloat(t) ? v : wrapInt(truncToInt(v), t);
}

function shiftLeft(a, b) {
  if (b < 0) throw new Fault('移位位数不能为负数');
  if (b >= 32) return a * Math.pow(2, b);
  return a * Math.pow(2, b);
}
function shiftRight(a, b, ty) {
  if (b < 0) throw new Fault('移位位数不能为负数');
  if (b >= 32) {
    if (ty && ty.signed) return a < 0 ? -1 : 0;
    return 0;
  }
  if (ty && ty.size === 8) return Math.floor(a / Math.pow(2, b));
  return a >> b;
}
