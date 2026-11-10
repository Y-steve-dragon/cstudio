// 掌心 C · 语法分析器（C89/C99 常用子集 → AST，带类型检查与作用域解析）
import {
  VOID, BOOL, CHAR, SCHAR, UCHAR, SHORT, USHORT, INT, UINT, LONG, ULONG, LLONG, ULLONG,
  FLOAT, DOUBLE, LDOUBLE, ptrTo, arrayOf, funcType, enumType, newStruct, computeLayout,
  isInt, isFloat, isArith, isPtr, isArray, isFunc, isAggr, isVoid, isSigned, promote, usualArith,
  decay, alignTo, typeName, CompileError,
} from './core.js';

const TYPE_KEYWORDS = new Set([
  'void', 'char', 'short', 'int', 'long', 'float', 'double', 'signed', 'unsigned',
  'const', 'volatile', 'restrict', 'static', 'extern', 'auto', 'register', 'typedef',
  'struct', 'union', 'enum', '_Bool', 'bool', 'inline', '__inline', '_Complex',
]);

const PTR_SIZE = 8;

class Scope {
  constructor(parent) { this.parent = parent; this.names = new Map(); this.tags = new Map(); }
  find(name) {
    let s = this;
    while (s) { const v = s.names.get(name); if (v) return v; s = s.parent; }
    return null;
  }
  findTag(name) {
    let s = this;
    while (s) { const v = s.tags.get(name); if (v) return v; s = s.parent; }
    return null;
  }
}

export class Parser {
  constructor(toks, opts = {}) {
    this.toks = toks;
    this.i = 0;
    this.scope = new Scope(null);
    this.functions = [];
    this.globals = [];
    this.errors = [];
    this.warnings = [];
    this.warningsOut = opts.warnings || null;
    this.fn = null;          // 当前函数
    this.frameSize = 0;
    this.loopDepth = 0;
    this.switchDepth = 0;
    this.brokenFunctions = [];
    this.unresolvedCalls = [];
    // 预定义类型名 / 常量 / 结构体（相当于头文件里本应提供的东西）
    if (opts.predefTypes) for (const [n, t] of opts.predefTypes) this.scope.names.set(n, { kind: 'typedef', name: n, type: t });
    if (opts.predefConsts) for (const c of opts.predefConsts) this.scope.names.set(c.name, { kind: 'const', name: c.name, value: c.value, type: c.type });
    if (opts.predefStructs) for (const [tag, st] of opts.predefStructs) this.scope.tags.set(tag, st);
    // 注册内置函数（printf/scanf/malloc…）：无需声明、无需 #include 就能调用
    if (opts.builtins) {
      for (const b of opts.builtins) {
        this.scope.names.set(b.name, {
          kind: 'builtin', name: b.name, fn: b.fn, ret: b.ret, min: b.min, max: b.max,
          type: funcType(b.ret, [], true),
        });
      }
    }
  }

  // ── token 工具 ──
  get tok() { return this.toks[this.i]; }
  peek(n = 1) { return this.toks[Math.min(this.i + n, this.toks.length - 1)]; }
  atEof() { return this.tok.k === 'eof'; }
  is(v) { return this.tok.v === v && (this.tok.k === 'punct' || this.tok.k === 'id'); }
  isId(name) { return this.tok.k === 'id' && this.tok.v === name; }
  next() { const t = this.tok; if (t.k !== 'eof') this.i++; return t; }
  eat(v) { if (this.is(v)) { this.i++; return true; } return false; }
  expect(v) {
    if (this.is(v)) { this.i++; return this.tok; }
    this.err(`此处应为 '${v}'，实际是 ${this.describe(this.tok)}`);
  }
  describe(t) {
    if (t.k === 'eof') return '文件结尾';
    if (t.k === 'str') return `字符串 "${t.v}"`;
    if (t.k === 'chr') return `字符常量`;
    return `'${t.v}'`;
  }
  err(msg) {
    const t = this.tok;
    throw new CompileError(msg, t.line, t.col, t.file);
  }
  errAt(t, msg) { throw new CompileError(msg, t.line, t.col, t.file); }

  // ── 作用域 / 符号 ──
  pushScope() { this.scope = new Scope(this.scope); }
  popScope() { this.scope = this.scope.parent; }
  define(name, sym, tok) {
    const old = this.scope.names.get(name);
    if (old && !old.forward && old.kind !== 'builtin' && old.kind !== 'const' && old.kind !== 'typedef') {
      this.errAt(tok || this.tok, `重复定义：'${name}' 在同一作用域内已声明（第 ${old.line || '?'} 行）`);
    }
    sym.line = (tok || this.tok).line;
    this.scope.names.set(name, sym);
    return sym;
  }
  lookup(name) { return this.scope.find(name); }

  newLocal(name, type, storage = null) {
    const off = alignTo(this.frameSize, Math.max(type.align || 1, 1));
    this.frameSize = off + Math.max(type.size, 1);
    const sym = this.define(name, { kind: 'local', name, type, offset: off, storage, isStatic: false });
    if (this.fn) {
      if (!this.fn.locals) this.fn.locals = [];
      this.fn.locals.push({ name, type, offset: off, line: this.tok.line });
    }
    return sym;
  }
  newGlobal(name, type, storage, init) {
    const sym = { kind: 'global', name, type, addr: 0, init, storage, hasInit: !!init };
    this.define(name, sym);
    this.globals.push(sym);
    return sym;
  }

  // ── 主流程 ──
  run() {
    while (!this.atEof()) {
      try {
        this.topLevel();
      } catch (e) {
        if (e instanceof CompileError) {
          this.errors.push(e);
          if (this.errors.length >= 25) break;
          this.recover();
        } else throw e;
      }
    }
    // 补解析：本文件内后定义的函数（允许先调用后定义，比标准 C 更宽松）
    for (const c of this.unresolvedCalls) {
      const sym = this.scope.find(c.name);
      if (sym && sym.kind === 'func') {
        c.node.sym = sym;
        c.node.ty = sym.type.ret;
        c.node.paramTypes = sym.type.params;
        c.node.variadic = sym.type.variadic;
      } else {
        this.errors.push(new CompileError(`函数 '${c.name}' 没有定义（也没有声明）`, c.line, c.col, c.file));
      }
    }
    if (!this.errors.length && !this.functions.some((f) => f.name === 'main')) {
      this.errors.push(new CompileError('找不到 main 函数 —— C 程序必须有一个 int main() 作为入口', 1, 1, this.toks[0]?.file));
    }
    return {
      functions: this.functions,
      globals: this.globals,
      errors: this.errors,
      warnings: this.warnings,
    };
  }

  recover() {
    let depth = 0;
    while (!this.atEof()) {
      const t = this.tok;
      if (t.v === '{') depth++;
      else if (t.v === '}') {
        depth--;
        if (depth <= 0) { this.i++; if (depth < 0) depth = 0; return; }
      } else if (t.v === ';' && depth === 0) { this.i++; return; }
      this.i++;
    }
  }

  topLevel() {
    if (this.eat(';')) return;
    if (this.isId('__attribute__')) { this.skipAttributes(); return; }
    const start = this.tok;
    const specs = this.declSpecs();
    if (this.eat(';')) {
      // 只声明了 struct/enum/union 标签
      return;
    }
    let first = true;
    for (;;) {
      const d = this.declarator(specs.type, false);
      let type = d.type;
      if (!d.name) this.errAt(start, '声明缺少变量名或函数名');

      if (specs.storage === 'typedef') {
        this.define(d.name, { kind: 'typedef', name: d.name, type }, start);
        if (this.eat(',')) continue;
        if (this.eat(';')) return;
        this.err(`typedef 声明后应为 ',' 或 ';'，实际是 ${this.describe(this.tok)}`);
      }

      if (type.kind === 'func') {
        const sym = { kind: 'func', name: d.name, type, params: [], frameSize: 0, body: null, funcIndex: this.functions.length, storage: specs.storage, defToken: this.tok };
        const fnObj = { name: d.name, type, params: [], frameSize: 0, body: null, isStatic: specs.storage === 'static', defToken: this.tok, returned: false };
        sym.fn = fnObj;
        this.define(d.name, sym, start);
        this.functions.push(fnObj);
        if (this.is('{')) {
          this.parseFunctionBody(fnObj);
          return;
        }
      } else {
        // 全局变量
        if (!first) { /* 多个声明符 */ }
        let init = null;
        if (this.eat('=')) {
          const inited = this.initializer(type);
          type = inited.type;
          init = inited;
        }
        if (specs.storage === 'extern') {
          // 仅声明，不分配
          this.define(d.name, { kind: 'global', name: d.name, type, addr: 0, init: null, extern: true, storage: 'extern' }, start);
        } else {
          this.newGlobal(d.name, type, specs.storage, init);
        }
      }
      first = false;
      if (this.eat(',')) continue;
      if (this.eat(';')) return;
      this.err(`声明后应为 ',' 或 ';'，实际是 ${this.describe(this.tok)}`);
    }
  }

  skipAttributes() {
    this.next();
    if (this.is('(')) {
      let d = 0;
      do {
        if (this.is('(')) d++;
        if (this.is(')')) d--;
        this.i++;
      } while (d > 0 && !this.atEof());
    }
  }

  parseFunctionBody(fnObj) {
    this.expect('{');
    const savedFn = this.fn, savedFrame = this.frameSize, savedLoop = this.loopDepth, savedSwitch = this.switchDepth;
    this.fn = fnObj;
    this.frameSize = 0;
    this.loopDepth = 0;
    this.switchDepth = 0;
    fnObj.locals = [];
    this.pushScope();
    // 参数入作用域 + 分配帧偏移
    fnObj.params = [];
    for (const p of fnObj.type.params) {
      if (!p.name) {
        // 定义里参数必须有名字：用占位名，避免崩溃
        const sym = this.newLocal(`__arg${fnObj.params.length}`, p.type);
        fnObj.params.push({ name: '__arg' + fnObj.params.length, sym, type: p.type });
        continue;
      }
      const sym = this.newLocal(p.name, p.type);
      fnObj.params.push({ name: p.name, sym, type: p.type });
    }
    // 函数体
    fnObj.body = this.blockStatement({ preOpened: true, isFunctionBody: true });
    fnObj.frameSize = alignTo(this.frameSize, 16);
    this.popScope();
    this.fn = savedFn;
    this.frameSize = savedFrame;
    this.loopDepth = savedLoop;
    this.switchDepth = savedSwitch;
    if (fnObj.type.ret.kind !== 'void' && !this.returnsValue(fnObj.body)) {
      this.warnings.push({ message: `函数 '${fnObj.name}' 声明返回 ${typeName(fnObj.type.ret)}，但可能没有 return 语句`, line: fnObj.defToken.line, file: fnObj.defToken.file });
    }
  }
  returnsValue(node) {
    if (!node) return false;
    if (node.k === 'return') return node.expr !== null;
    if (node.k === 'block') return node.stmts.some((s) => this.returnsValue(s));
    if (node.k === 'if') return this.returnsValue(node.then) && this.returnsValue(node.els);
    if (node.k === 'while' || node.k === 'for' || node.k === 'do') return this.returnsValue(node.body);
    return false;
  }

  // ── 类型说明符 ──
  isTypeStart() {
    const t = this.tok;
    if (t.k !== 'id') return false;
    if (TYPE_KEYWORDS.has(t.v)) return true;
    const s = this.scope.find(t.v);
    return !!(s && s.kind === 'typedef');
  }

  declSpecs() {
    const t0 = this.tok;
    let base = null, sign = 0, size = 0, isLong = 0, storage = null, sawAny = false;
    const tokOf = () => this.tok;
    for (;;) {
      const t = this.tok;
      if (t.k !== 'id') break;
      const v = t.v;
      if (v === 'typedef' || v === 'static' || v === 'extern' || v === 'auto' || v === 'register' || v === 'inline' || v === '__inline') {
        if (v !== 'inline' && v !== '__inline') storage = v;
        sawAny = true; this.next(); continue;
      }
      if (v === 'const' || v === 'volatile' || v === 'restrict') { sawAny = true; this.next(); continue; }
      if (v === '_Complex') { this.next(); continue; }
      if (v === 'struct' || v === 'union') {
        this.next();
        base = this.structOrUnion(v === 'union');
        sawAny = true; continue;
      }
      if (v === 'enum') { this.next(); base = this.enumSpec(); sawAny = true; continue; }
      if (v === 'void') { this.next(); base = VOID; sawAny = true; continue; }
      if (v === 'char') { this.next(); base = CHAR; sawAny = true; continue; }
      if (v === '_Bool' || v === 'bool') { this.next(); base = BOOL; sawAny = true; continue; }
      if (v === 'float') { this.next(); base = FLOAT; sawAny = true; continue; }
      if (v === 'double') { this.next(); base = DOUBLE; sawAny = true; continue; }
      if (v === 'signed') { this.next(); sign = 1; sawAny = true; continue; }
      if (v === 'unsigned') { this.next(); sign = -1; sawAny = true; continue; }
      if (v === 'short') { this.next(); size = 1; sawAny = true; continue; }
      if (v === 'int') { this.next(); if (!size) size = 2; sawAny = true; continue; }
      if (v === 'long') { this.next(); isLong++; size = size || 2; sawAny = true; continue; }
      if (v === 'unsigned') { this.next(); sign = -1; sawAny = true; continue; }
      // typedef 名
      const s = this.scope.find(v);
      if (s && s.kind === 'typedef' && !base) { this.next(); base = s.type; sawAny = true; continue; }
      break;
    }
    if (!sawAny) {
      // C89 隐式 int（main() { ... } 之类）
      return { type: INT, storage };
    }
    if (base && !isInt(base) && !(base.kind === 'int')) {
      // char/float/double/struct 等：忽略 signed/short/long 修饰（非法组合已容忍）
      if (sign || size || isLong) {
        if (base === CHAR && !(sign === 0 && !isLong)) {
          if (sign === -1) return { type: UCHAR, storage };
          if (sign === 1) return { type: SCHAR, storage };
        }
        if (base === DOUBLE && isLong) return { type: LDOUBLE, storage };
      }
      return { type: base, storage };
    }
    // 纯整数组合
    let ty;
    if (!base && !sign && !size && !isLong) ty = INT;
    else if (size === 1) ty = sign === -1 ? USHORT : SHORT;
    else if (isLong >= 2) ty = sign === -1 ? ULLONG : LLONG;
    else if (isLong === 1) ty = sign === -1 ? ULONG : LONG;
    else ty = sign === -1 ? UINT : INT;
    if (base === VOID) ty = VOID;
    if (base === CHAR) ty = sign === -1 ? UCHAR : sign === 1 ? SCHAR : CHAR;
    if (base === BOOL) ty = BOOL;
    if (base === FLOAT) ty = FLOAT;
    if (base === DOUBLE) ty = isLong ? LDOUBLE : DOUBLE;
    if (base && base.kind === 'int' && base.bool) ty = BOOL;
    return { type: ty, storage };
  }

  structOrUnion(isUnion) {
    let tag = null;
    if (this.tok.k === 'id' && !this.is('{')) { tag = this.next().v; }
    if (this.is('{')) {
      let st = tag ? this.scope.findTag(tag) : null;
      if (!st) st = newStruct(tag, isUnion);
      if (tag) this.scope.tags.set(tag, st);
      this.next();
      st.members = [];
      while (!this.is('}') && !this.atEof()) {
        const specs = this.declSpecs();
        if (this.eat(';')) {
          // 匿名结构成员：展开为成员
          if (specs.type.kind === 'struct' || specs.type.kind === 'union') {
            for (const m of specs.type.members) st.members.push({ ...m });
            continue;
          }
          continue;
        }
        for (;;) {
          const d = this.declarator(specs.type, true);
          if (this.is('{') || this.is(';')) { /* 函数指针成员 */ }
          let mtype = d.type;
          let bitWidth = -1;
          if (this.eat(':')) {
            const bw = this.constExpr();
            bitWidth = bw;
            // 位域：按基类型单独占位（不做位打包，保证读写正确）
            mtype = d.type;
          }
          st.members.push({ name: d.name || '', type: mtype, offset: 0, bitWidth });
          if (this.eat(',')) continue;
          if (this.eat(';')) break;
          this.err("结构体成员之间应为 ',' 或 ';'");
        }
      }
      this.expect('}');
      computeLayout(st);
      // 位域按独立槽位重排布局
      if (st.members.some((m) => m.bitWidth >= 0)) {
        let off = 0, maxA = 1;
        for (const m of st.members) {
          const a = Math.max(m.type.align || 1, 1);
          maxA = Math.max(maxA, a);
          if (isUnion) { m.offset = 0; continue; }
          off = alignTo(off, a);
          m.offset = off; off += m.type.size;
        }
        st.align = maxA;
        st.size = alignTo(isUnion ? Math.max(...st.members.map((m) => m.type.size)) : off, maxA);
        st.complete = true;
      }
      return st;
    }
    if (!tag) this.err('struct/union 用法错误：缺少标签或成员列表');
    let st = this.scope.findTag(tag);
    if (!st) { st = newStruct(tag, isUnion); this.scope.tags.set(tag, st); }
    return st;
  }

  enumSpec() {
    let tag = null;
    if (this.tok.k === 'id' && !this.is('{')) tag = this.next().v;
    if (this.is('{')) {
      this.next();
      let val = 0;
      while (!this.is('}') && !this.atEof()) {
        const nameTok = this.next();
        if (nameTok.k !== 'id') this.errAt(nameTok, '枚举成员应为标识符');
        if (this.eat('=')) val = this.constExpr();
        this.define(nameTok.v, { kind: 'enum', name: nameTok.v, value: val, type: INT }, nameTok);
        val++;
        if (this.eat(',')) continue;
        break;
      }
      this.expect('}');
    }
    const et = enumType(tag);
    return et;
  }

  // ── 声明符 ──
  declarator(base, allowAbstract) {
    base = this.pointers(base);
    let name = null;
    let type = base;
    if (this.is('(') && this.isParenDeclarator()) {
      const start = this.i;
      this.next();
      // 先用占位解析找出结尾，再用真实基类型重解
      const dummy = this.declarator(INT, true);
      this.expect(')');
      const after = this.typeSuffix(base);
      this.i = start + 1;
      const real = this.declarator(after, true);
      this.expect(')');
      // 外层后缀（如 (*f)(int) 里的 (int)）已经在 after 里算进类型了，这里只需跳过 token
      this.typeSuffix(INT);
      return { type: real.type, name: real.name };
    }
    if (this.tok.k === 'id' && !TYPE_KEYWORDS.has(this.tok.v)) {
      name = this.next().v;
    } else if (!allowAbstract) {
      // 允许省略名字的抽象声明符
    }
    // 后缀：数组 / 函数
    while (this.is('[') || this.is('(')) {
      if (this.is('[')) {
        this.next();
        let len = null;
        if (!this.is(']')) len = this.constExpr();
        this.expect(']');
        type = arrayOf(type, len);
      } else {
        this.next();
        const fp = this.paramList();
        type = funcType(type, fp.params, fp.variadic);
      }
    }
    if (this.isId('__attribute__')) this.skipAttributes();
    return { type, name };
  }

  isParenDeclarator() {
    // '(' 后面跟 '*'(指针) 或 '(' 或 ')' 或 标识符（非类型名）→ 是嵌套声明符
    const t = this.peek(1);
    if (!t) return false;
    if (t.v === '*' || t.v === '(') return true;
    if (t.v === ')') return false;
    if (t.k === 'id' && !TYPE_KEYWORDS.has(t.v)) {
      const s = this.scope.find(t.v);
      if (s && s.kind === 'typedef') return false;
      return true;
    }
    return false;
  }

  pointers(base) {
    let type = base;
    for (;;) {
      if (this.is('*')) {
        this.next();
        while (this.is('const') || this.is('volatile') || this.is('restrict')) this.next();
        type = ptrTo(type);
        continue;
      }
      break;
    }
    return type;
  }

  typeSuffix(base) {
    let type = base;
    while (this.is('[') || this.is('(')) {
      if (this.is('[')) {
        this.next();
        let len = null;
        if (!this.is(']')) len = this.constExpr();
        this.expect(']');
        type = arrayOf(type, len);
      } else {
        this.next();
        const fp = this.paramList();
        type = funcType(type, fp.params, fp.variadic);
      }
    }
    return type;
  }

  paramList() {
    const params = [];
    let variadic = false;
    if (this.is(')')) { this.next(); return { params, variadic: true, oldStyle: true }; }
    if (this.is('void') && this.peek(1).v === ')') { this.next(); this.next(); return { params, variadic: false }; }
    for (;;) {
      if (this.is('...')) { this.next(); variadic = true; break; }
      const specs = this.declSpecs();
      // 抽象声明符可能为空（原型里的 int）
      let name = null;
      let type = specs.type;
      if (!this.is(',') && !this.is(')')) {
        const d = this.declarator(specs.type, true);
        name = d.name; type = d.type;
      }
      if (type.kind === 'array') type = ptrTo(type.base);
      if (type.kind === 'func') type = ptrTo(type);
      params.push({ name, type });
      if (this.eat(',')) continue;
      break;
    }
    this.expect(')');
    return { params, variadic };
  }

  // ── 初始化 ──
  initializer(type) {
    const items = [];
    if (type.kind === 'array' && type.base.kind === 'int' && type.base.size === 1 && this.tok.k === 'str') {
      const t = this.next();
      let len = type.len;
      if (len === null) len = t.v.length + 1;
      const ty2 = arrayOf(type.base, len);
      items.push({ offset: 0, type: ty2, str: t.v });
      return { type: ty2, items };
    }
    if (type.kind === 'array' && this.is('{')) {
      this.next();
      let idx = 0, maxIdx = -1;
      const elems = [];
      while (!this.is('}') && !this.atEof()) {
        if (this.is('[')) {
          this.next();
          idx = this.constExpr();
          this.expect(']');
          this.expect('=');
        }
        const sub = this.initializer(type.base);
        elems.push({ idx, sub });
        maxIdx = Math.max(maxIdx, idx);
        idx++;
        if (this.eat(',')) { if (this.is('}')) break; continue; }
        break;
      }
      this.expect('}');
      let len = type.len;
      if (len === null) len = maxIdx + 1;
      for (const e of elems) {
        for (const it of e.sub.items) {
          items.push({ offset: e.idx * type.base.size + it.offset, type: it.type, expr: it.expr, str: it.str });
        }
        if (e.sub.str) items.push({ offset: e.idx * type.base.size, type: type.base, str: e.sub.str });
      }
      const ty2 = arrayOf(type.base, len);
      return { type: ty2, items };
    }
    if ((type.kind === 'struct' || type.kind === 'union') && this.is('{')) {
      this.next();
      let mi = 0;
      const outItems = [];
      while (!this.is('}') && !this.atEof()) {
        let member;
        if (this.is('.')) {
          this.next();
          const nm = this.next().v;
          this.expect('=');
          mi = type.members.findIndex((m) => m.name === nm);
          if (mi < 0) this.err(`结构体/联合体没有成员 '${nm}'`);
          member = type.members[mi];
        } else {
          member = type.members[mi];
          if (!member) { this.constExprOrSkip(); break; }
        }
        const sub = this.initializer(member.type);
        for (const it of sub.items) {
          outItems.push({ offset: member.offset + it.offset, type: it.type, expr: it.expr, str: it.str });
        }
        if (sub.str) outItems.push({ offset: member.offset, type: member.type, str: sub.str });
        mi++;
        if (type.kind === 'union') { if (this.eat(',')) continue; break; }
        if (this.eat(',')) { if (this.is('}')) break; continue; }
        break;
      }
      this.expect('}');
      return { type, items: outItems };
    }
    // 标量
    const expr = this.assign();
    items.push({ offset: 0, type, expr });
    return { type, items };
  }
  constExprOrSkip() { try { this.constExpr(); } catch { /* ignore */ } }

  // ── 语句 ──
  blockStatement(opts = {}) {
    const scopePushed = !opts.preOpened;
    if (!opts.preOpened) this.expect('{');
    if (!scopePushed) { /* 函数体作用域已由 parseFunctionBody 压入 */ }
    else this.pushScope();
    const stmts = [];
    while (!this.is('}') && !this.atEof()) {
      const s = this.statement();
      if (s) stmts.push(s);
    }
    this.expect('}');
    if (scopePushed) this.popScope();
    // 收集 label → 下标（用于 goto）
    const labels = new Map();
    stmts.forEach((s, idx) => { if (s.k === 'label') labels.set(s.name, idx); });
    const node = { k: 'block', stmts };
    if (labels.size) node.labels = labels;
    return node;
  }

  statement() {
    const t = this.tok;
    const node = this._statement();
    if (node && !node.pos) node.pos = { line: t.line, file: t.file };
    return node;
  }

  _statement() {
    const t = this.tok;
    if (t.k === 'punct') {
      if (t.v === ';') { this.next(); return { k: 'empty' }; }
      if (t.v === '{') return this.blockStatement();
    }
    if (t.k === 'id') {
      switch (t.v) {
        case 'if': {
          this.next(); this.expect('(');
          const cond = this.expr(); this.expect(')');
          const then = this.statement();
          let els = null;
          if (this.isId('else')) { this.next(); els = this.statement(); }
          return { k: 'if', cond, then, els };
        }
        case 'while': {
          this.next(); this.expect('(');
          const cond = this.expr(); this.expect(')');
          this.loopDepth++;
          const body = this.statement();
          this.loopDepth--;
          return { k: 'while', cond, body };
        }
        case 'do': {
          this.next();
          this.loopDepth++;
          const body = this.statement();
          this.loopDepth--;
          if (!this.isId('while')) this.err('do 循环缺少 while');
          this.next(); this.expect('(');
          const cond = this.expr(); this.expect(')'); this.expect(';');
          return { k: 'do', body, cond };
        }
        case 'for': {
          this.next(); this.expect('(');
          this.pushScope();
          let init = null;
          if (this.is(';')) { this.next(); }
          else if (this.isTypeStart()) {
            init = this.declarationStatement(true);
          } else {
            init = { k: 'expr', expr: this.expr() };
            this.expect(';');
          }
          let cond = null;
          if (!this.is(';')) cond = this.expr();
          this.expect(';');
          let step = null;
          if (!this.is(')')) step = this.expr();
          this.expect(')');
          this.loopDepth++;
          const body = this.statement();
          this.loopDepth--;
          this.popScope();
          return { k: 'for', init, cond, step, body };
        }
        case 'switch': {
          this.next(); this.expect('(');
          const cond = this.expr(); this.expect(')');
          this.switchDepth++;
          const body = this.statement();
          this.switchDepth--;
          return this.buildSwitch(cond, body);
        }
        case 'case': {
          this.next();
          const v = this.constExpr();
          this.expect(':');
          const inner = this.statement();
          return { k: 'case', value: v, stmt: inner };
        }
        case 'default': {
          this.next(); this.expect(':');
          const inner = this.statement();
          return { k: 'case', value: null, stmt: inner, isDefault: true };
        }
        case 'break': {
          this.next(); this.expect(';');
          if (!this.loopDepth && !this.switchDepth) this.errAt(t, 'break 只能用在循环或 switch 内部');
          return { k: 'break' };
        }
        case 'continue': {
          this.next(); this.expect(';');
          if (!this.loopDepth) this.errAt(t, 'continue 只能用在循环内部');
          return { k: 'continue' };
        }
        case 'return': {
          this.next();
          let expr = null;
          if (!this.is(';')) {
            expr = this.expr();
            const ret = this.fn ? this.fn.type.ret : INT;
            if (ret.kind === 'void') {
              this.warnings.push({ message: 'void 函数里 return 了值（已忽略该值）', line: t.line, file: t.file });
              expr = null;
            } else if (isAggr(ret)) {
              // 结构体返回：由调用方提供返回槽
            } else {
              expr = this.cast(expr, ret, '返回值的类型与函数返回类型不一致');
            }
          }
          this.expect(';');
          return { k: 'return', expr, ret: this.fn ? this.fn.type.ret : INT };
        }
        case 'goto': {
          this.next();
          const name = this.next().v;
          this.expect(';');
          return { k: 'goto', name };
        }
        case 'else': this.err("'else' 前面没有对应的 if");
      }
      // 标签： ident ':'（排除 默认 等）
      if (t.k === 'id' && this.peek(1).v === ':' && !this.isTypeStart()) {
        const name = this.next().v;
        this.next();
        const inner = this.statement();
        return { k: 'label', name, stmt: inner };
      }
      if (this.isTypeStart()) {
        const d = this.declarationStatement(true);
        return d;
      }
    }
    const expr = this.expr();
    if (!this.is(';')) {
      this.err(`语句末尾缺少 ';'（实际是 ${this.describe(this.tok)}）`);
    }
    this.next();
    return { k: 'expr', expr };
  }

  buildSwitch(cond, body) {
    const stmts = [];
    let pending = undefined;
    let defaultIdx = -1;
    const caseValues = [];
    const flat = (node, label) => {
      if (!node) return;
      if (node.k === 'block') {
        for (const s of node.stmts) flat(s, undefined);
        return;
      }
      if (node.k === 'case') {
        flat(node.stmt, node.isDefault ? { isDefault: true } : { value: node.value });
        return;
      }
      const entry = { node, label: label || null };
      if (label) {
        if (label.isDefault) { if (defaultIdx < 0) defaultIdx = stmts.length; }
        else {
          if (caseValues.includes(label.value)) this.errAt(this.tok, `switch 里重复的 case 值 ${label.value}`);
          caseValues.push(label.value);
        }
      }
      stmts.push(entry);
    };
    flat(body, undefined);
    return { k: 'switch', cond, stmts, caseValues, defaultIdx };
  }

  declarationStatement(expectSemi = true) {
    const specs = this.declSpecs();
    const vars = [];
    if (this.eat(';')) return { k: 'decl', vars };
    for (;;) {
      const d = this.declarator(specs.type, false);
      if (!d.name) this.err('变量声明缺少名字');
      if (d.type.kind === 'func') {
        // 函数声明出现在语句块里：注册到全局作用域
        this.define(d.name, { kind: 'func', name: d.name, type: d.type, params: [], frameSize: 0, body: null, funcIndex: -1, storage: 'extern' });
        if (specs.storage === 'typedef') this.err('块内不支持函数原型的 typedef');
      } else if (specs.storage === 'typedef') {
        this.define(d.name, { kind: 'typedef', name: d.name, type: d.type });
      } else if (specs.storage === 'static' || specs.storage === 'extern') {
        // 块内静态变量 → 提到全局静态区（名字加唯一后缀）
        let type = d.type;
        let init = null;
        if (this.eat('=')) { const inited = this.initializer(type); type = inited.type; init = inited; }
        const uname = `${d.name}$${this.fn ? this.fn.name : 'g'}$${this.functions.length}_${this.globals.length}`;
        const g = { kind: 'global', name: d.name, realName: uname, type, addr: 0, init, storage: 'static', blockStatic: true };
        this.scope.names.set(d.name, g);
        this.globals.push(g);
        vars.push({ sym: g, init, type });
      } else {
        let type = d.type;
        let init = null;
        if (this.eat('=')) {
          const inited = this.initializer(type);
          type = inited.type;
          init = inited;
        }
        if (type.kind === 'array' && type.len === null) {
          this.errAt(this.tok, `数组 '${d.name}' 必须指定长度或提供初始化列表`);
        }
        if (type.kind === 'struct' && !type.complete) this.errAt(this.tok, `结构体 '${type.name}' 是不完整类型，需要先定义成员`);
        const sym = this.newLocal(d.name, type, specs.storage);
        vars.push({ sym, init, type });
      }
      if (this.eat(',')) continue;
      break;
    }
    if (expectSemi) this.expect(';');
    return { k: 'decl', vars };
  }

  // ── 表达式 ──
  expr() {
    let node = this.assign();
    while (this.is(',')) {
      this.next();
      const right = this.assign();
      node = { k: 'comma', a: node, b: right, ty: right.ty };
    }
    return node;
  }

  assign() {
    const lhs = this.conditional();
    const t = this.tok;
    if (t.k === 'punct') {
      const simple = ['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>='];
      if (simple.includes(t.v)) {
        this.next();
        const rhs = this.assign();
        if (t.v === '=') {
          if (!this.isLValue(lhs)) this.errAt(t, '赋值号左边必须是变量、数组元素、结构体成员或指针所指对象');
          const ty = lhs.ty;
          if (isArray(ty)) this.errAt(t, '数组不能直接赋值（请逐个元素赋值或使用 memcpy）');
          if (isAggr(ty)) {
            if (!this.sameAggr(ty, rhs.ty)) this.errAt(t, `类型不匹配：不能把 ${typeName(rhs.ty)} 赋给 ${typeName(ty)}`);
            return { k: 'assign', lhs, rhs, ty };
          }
          return { k: 'assign', lhs, rhs: this.cast(rhs, ty, '赋值类型不匹配'), ty };
        }
        const op = t.v.slice(0, -1);
        if (!this.isLValue(lhs)) this.errAt(t, '复合赋值左边必须是左值');
        const bin = this.makeBinary(op, lhs, rhs, t);
        const ty = lhs.ty;
        if (isAggr(ty)) this.errAt(t, `不能对 ${typeName(ty)} 使用 ${t.v}`);
        return { k: 'assign', lhs, rhs: this.cast(bin, ty, '复合赋值类型不匹配'), ty };
      }
    }
    return lhs;
  }

  conditional() {
    const cond = this.logicalOr();
    if (this.is('?')) {
      this.next();
      const a = this.expr();
      this.expect(':');
      const b = this.conditional();
      let ty;
      if (isArith(a.ty) && isArith(b.ty)) ty = usualArith(a.ty, b.ty);
      else if (isPtr(a.ty)) ty = a.ty;
      else if (isPtr(b.ty)) ty = b.ty;
      else ty = a.ty;
      return { k: 'cond', cond, a, b, ty };
    }
    return cond;
  }

  logicalOr() {
    let l = this.logicalAnd();
    while (this.is('||')) {
      const t = this.next();
      const r = this.logicalAnd();
      l = { k: 'logor', a: l, b: r, ty: INT, op: '||' };
    }
    return l;
  }
  logicalAnd() {
    let l = this.bitOr();
    while (this.is('&&')) {
      this.next();
      const r = this.bitOr();
      l = { k: 'logand', a: l, b: r, ty: INT, op: '&&' };
    }
    return l;
  }
  bitOr() {
    let l = this.bitXor();
    while (this.is('|')) { const t = this.next(); l = this.makeBinary('|', l, this.bitXor(), t); }
    return l;
  }
  bitXor() {
    let l = this.bitAnd();
    while (this.is('^')) { const t = this.next(); l = this.makeBinary('^', l, this.bitAnd(), t); }
    return l;
  }
  bitAnd() {
    let l = this.equality();
    while (this.is('&')) { const t = this.next(); l = this.makeBinary('&', l, this.equality(), t); }
    return l;
  }
  equality() {
    let l = this.relational();
    while (this.is('==') || this.is('!=')) { const t = this.next(); l = this.makeBinary(t.v, l, this.relational(), t); }
    return l;
  }
  relational() {
    let l = this.shift();
    while (this.is('<') || this.is('>') || this.is('<=') || this.is('>=')) {
      const t = this.next();
      l = this.makeBinary(t.v, l, this.shift(), t);
    }
    return l;
  }
  shift() {
    let l = this.additive();
    while (this.is('<<') || this.is('>>')) { const t = this.next(); l = this.makeBinary(t.v, l, this.additive(), t); }
    return l;
  }
  additive() {
    let l = this.multiplicative();
    while (this.is('+') || this.is('-')) {
      const t = this.next();
      l = this.makeBinary(t.v, l, this.multiplicative(), t);
    }
    return l;
  }
  multiplicative() {
    let l = this.unary();
    while (this.is('*') || this.is('/') || this.is('%')) {
      const t = this.next();
      l = this.makeBinary(t.v, l, this.unary(), t);
    }
    return l;
  }

  makeBinary(op, a, b, tok) {
    const at = a.ty, bt = b.ty;
    if (op === '+' || op === '-') {
      if (isPtr(at) || isPtr(bt)) {
        if (isPtr(at) && isPtr(bt)) {
          if (op === '+') this.errAt(tok, '两个指针不能相加');
          if (!this.compatiblePtr(at, bt)) this.errAt(tok, `指针类型不同：${typeName(at)} 与 ${typeName(bt)}`);
          return { k: 'ptrsub', a, b, ty: LONG };
        }
        if (op === '+') {
          if (isPtr(at)) return { k: 'ptrarith', ptr: a, index: this.cast(b, LONG, '指针加法只支持整数偏移'), ty: at, op: '+' };
          return { k: 'ptrarith', ptr: b, index: this.cast(a, LONG, '指针加法只支持整数偏移'), ty: bt, op: '+' };
        }
        // ptr - int
        if (!isPtr(at)) this.errAt(tok, '整数减指针是非法的');
        return { k: 'ptrarith', ptr: a, index: this.cast(b, LONG, '指针减法只支持整数偏移'), ty: at, op: '-' };
      }
    }
    if (['==', '!=', '<', '>', '<=', '>='].includes(op) && (isPtr(at) || isPtr(bt))) {
      return { k: 'bin', op, a, b, ty: INT, ptrCmp: true };
    }
    if (!isArith(at) || !isArith(bt)) {
      if (['&', '|', '^', '<<', '>>', '%'].includes(op)) this.errAt(tok, `运算符 '${op}' 需要整数操作数，实际是 ${typeName(at)} 与 ${typeName(bt)}`);
      this.errAt(tok, `运算符 '${op}' 不能用于 ${typeName(at)} 与 ${typeName(bt)}`);
    }
    if (['&', '|', '^', '%', '<<', '>>'].includes(op)) {
      if (!isInt(at) || !isInt(bt)) this.errAt(tok, `运算符 '${op}' 需要整数操作数，实际是 ${typeName(at)} 与 ${typeName(bt)}`);
      const ty = (op === '<<' || op === '>>') ? promote(at) : usualArith(at, bt);
      return { k: 'bin', op, a: this.arithCast(a, ty), b: this.arithCast(b, op === '<<' || op === '>>' ? INT : ty), ty };
    }
    const ty = usualArith(at, bt);
    const resTy = ['==', '!=', '<', '>', '<=', '>='].includes(op) ? INT : ty;
    return { k: 'bin', op, a: this.arithCast(a, ty), b: this.arithCast(b, ty), ty: resTy, operandTy: ty };
  }

  compatiblePtr(a, b) {
    if (a.kind !== 'ptr' || b.kind !== 'ptr') return false;
    if (a.base.kind === 'void' || b.base.kind === 'void') return true;
    return a.base.id === b.base.id || (isInt(a.base) && isInt(b.base) && a.base.size === b.base.size);
  }

  arithCast(node, to) {
    if (node.ty.id === to.id) return node;
    return { k: 'cast', expr: node, ty: to, implicit: true };
  }

  /** 隐式/显式类型转换，带合理性检查 */
  cast(node, to, hint) {
    const from = node.ty;
    if (from.id === to.id) return node;
    if (isPtr(to)) {
      if (isPtr(from)) return { k: 'cast', expr: node, ty: to, implicit: true };
      if (isInt(from)) return { k: 'cast', expr: node, ty: to, implicit: true };
      if (isArray(from)) return { k: 'cast', expr: node, ty: to, implicit: true };
    }
    if (isArith(to) && (isArith(from) || isPtr(from))) return { k: 'cast', expr: node, ty: to, implicit: true };
    if (isVoid(to)) return { k: 'cast', expr: node, ty: to, implicit: true };
    if (isAggr(from) || isAggr(to)) {
      this.err(`${hint || '类型不匹配'}：${typeName(from)} → ${typeName(to)}`);
    }
    this.err(`${hint || '类型不匹配'}：${typeName(from)} → ${typeName(to)}`);
  }

  unary() {
    const t = this.tok;
    if (t.k === 'punct') {
      if (t.v === '+') { this.next(); const e = this.unary(); return isArith(e.ty) ? this.arithCast(e, promote(e.ty)) : e; }
      if (t.v === '-') {
        this.next();
        const e = this.unary();
        if (!isArith(e.ty)) this.errAt(t, `一元负号需要算术类型，实际是 ${typeName(e.ty)}`);
        return { k: 'neg', expr: e, ty: promote(e.ty) };
      }
      if (t.v === '!') { this.next(); const e = this.unary(); return { k: 'not', expr: e, ty: INT }; }
      if (t.v === '~') {
        this.next(); const e = this.unary();
        if (!isInt(e.ty)) this.errAt(t, `运算符 '~' 需要整数，实际是 ${typeName(e.ty)}`);
        return { k: 'bin', op: '~', a: e, ty: promote(e.ty) };
      }
      if (t.v === '*') {
        this.next();
        const e = this.unary();
        const ty = decay(e.ty);
        if (!isPtr(ty)) this.errAt(t, `'*' 需要指针，实际是 ${typeName(e.ty)}`);
        return { k: 'deref', expr: e, ty: ty.base };
      }
      if (t.v === '&') {
        this.next();
        const e = this.unary();
        if (!this.isLValue(e)) this.errAt(t, "'&' 需要左值（变量、数组元素、结构体成员或函数）");
        if (e.k === 'var' && e.sym.kind === 'func') {
          return { k: 'funcaddr', sym: e.sym, ty: ptrTo(e.sym.type) };
        }
        return { k: 'addr', expr: e, ty: ptrTo(e.ty) };
      }
      if (t.v === '++' || t.v === '--') {
        this.next();
        const e = this.unary();
        if (!this.isLValue(e)) this.errAt(t, `${t.v} 需要左值（变量）`);
        this.checkScalar(e.ty, t.v);
        return { k: 'incdec', expr: e, delta: t.v === '++' ? 1 : -1, prefix: true, ty: e.ty };
      }
      if (t.v === '(') {
        if (this.isCastStart()) {
          this.next();
          const specs = this.declSpecs();
          let ty = specs.type;
          if (!this.is(')')) {
            const d = this.declarator(ty, true);
            ty = d.type;
          }
          this.expect(')');
          const e = this.unary();
          if (isVoid(ty)) return { k: 'cast', expr: e, ty: VOID };
          if (isAggr(ty)) this.errAt(t, '不能强制转换为结构体/数组类型');
          return { k: 'cast', expr: e, ty, explicit: true };
        }
      }
    }
    if (t.k === 'id') {
      if (t.v === 'sizeof') {
        this.next();
        if (this.is('(') && this.isCastStart()) {
          this.next();
          const specs = this.declSpecs();
          let ty = specs.type;
          if (!this.is(')')) { const d = this.declarator(ty, true); ty = d.type; }
          this.expect(')');
          return { k: 'num', v: ty.size, ty: ULONG };
        }
        const e = this.unary();
        return { k: 'num', v: e.ty.size, ty: ULONG };
      }
      if (t.v === '_Alignof' || t.v === 'alignof') {
        this.next(); this.expect('(');
        const specs = this.declSpecs();
        let ty = specs.type;
        if (!this.is(')')) { const d = this.declarator(ty, true); ty = d.type; }
        this.expect(')');
        return { k: 'num', v: ty.align, ty: ULONG };
      }
      if (t.v === 'va_start' || t.v === 'va_end' || t.v === 'va_copy') {
        this.next(); this.expect('(');
        const ap = this.assign();
        let last = null;
        if (t.v !== 'va_end') { this.expect(','); last = this.assign(); }
        this.expect(')');
        return {
          k: 'vabuiltin', op: t.v === 'va_start' ? 'start' : t.v === 'va_copy' ? 'copy' : 'end',
          ap, lastNode: last, ty: VOID,
        };
      }
      if (t.v === 'va_arg') {
        this.next(); this.expect('(');
        const ap = this.assign();
        this.expect(',');
        const specs = this.declSpecs();
        let ty = specs.type;
        if (!this.is(')')) { const d = this.declarator(ty, true); ty = d.type; }
        this.expect(')');
        return { k: 'vaarg', ap, ty };
      }
    }
    return this.postfix();
  }

  isCastStart() {
    if (!this.is('(')) return false;
    const save = this.i;
    this.i++;
    let ok = false;
    if (this.tok.k === 'id' && TYPE_KEYWORDS.has(this.tok.v)) ok = true;
    else if (this.tok.k === 'id') {
      const s = this.scope.find(this.tok.v);
      if (s && s.kind === 'typedef') ok = true;
    }
    this.i = save;
    return ok;
  }

  checkScalar(ty, op) {
    if (isAggr(ty)) this.err(`运算符 '${op}' 不能用于 ${typeName(ty)}`);
    if (ty.kind === 'void') this.err(`运算符 '${op}' 不能用于 void`);
  }

  postfix() {
    let node = this.primary();
    for (;;) {
      const t = this.tok;
      if (t.k === 'punct') {
        if (t.v === '[') {
          this.next();
          const idx = this.expr();
          this.expect(']');
          const pty = decay(node.ty);
          if (!isPtr(pty)) this.errAt(t, `下标运算需要指针或数组，实际是 ${typeName(node.ty)}`);
          const base = { k: 'ptrarith', ptr: node, index: this.cast(idx, LONG, '下标必须是整数'), ty: pty, op: '+' };
          node = { k: 'deref', expr: base, ty: pty.base };
          continue;
        }
        if (t.v === '(') {
          this.next();
          const args = [];
          if (!this.is(')')) {
            for (;;) {
              args.push(this.assign());
              if (this.eat(',')) continue;
              break;
            }
          }
          this.expect(')');
          node = this.buildCall(node, args, t);
          continue;
        }
        if (t.v === '.' || t.v === '->') {
          this.next();
          const nm = this.next();
          if (nm.k !== 'id') this.errAt(nm, `. 或 -> 后面应为成员名`);
          let baseTy = node.ty;
          if (t.v === '->') {
            const pty = decay(node.ty);
            if (!isPtr(pty)) this.errAt(t, `'->' 左边应为结构体指针，实际是 ${typeName(node.ty)}`);
            baseTy = pty.base;
          }
          if (baseTy.kind !== 'struct' && baseTy.kind !== 'union') this.errAt(t, `'${t.v}' 左边应为结构体或联合体，实际是 ${typeName(baseTy)}`);
          if (!baseTy.complete) this.errAt(t, `结构体 ${typeName(baseTy)} 是不完整类型`);
          const mem = baseTy.members.find((m) => m.name === nm.v);
          if (!mem) this.errAt(nm, `${baseTy.kind === 'union' ? '联合体' : '结构体'} ${typeName(baseTy)} 没有成员 '${nm.v}'${this.hintMembers(baseTy)}`);
          node = { k: 'member', expr: node, arrow: t.v === '->', member: mem, ty: mem.type };
          continue;
        }
        if (t.v === '++' || t.v === '--') {
          this.next();
          if (!this.isLValue(node)) this.errAt(t, `${t.v} 需要左值`);
          this.checkScalar(node.ty, t.v);
          node = { k: 'incdec', expr: node, delta: t.v === '++' ? 1 : -1, prefix: false, ty: node.ty };
          continue;
        }
      }
      break;
    }
    return node;
  }

  hintMembers(st) {
    const names = st.members.map((m) => m.name).filter(Boolean);
    return names.length ? `（可用成员：${names.slice(0, 8).join(', ')}）` : '（它没有成员）';
  }

  buildCall(calleeNode, args, tok) {
    let paramTypes = null, variadic = true, retTy = INT;
    if (calleeNode.k === 'var') {
      const sym = calleeNode.sym;
      if (sym.kind === 'func') {
        const ft = sym.type;
        paramTypes = ft.params.map((p) => p.type);
        variadic = ft.variadic;
        retTy = ft.ret;
        this.checkArgs(paramTypes, variadic, args, tok, sym.name);
        const node = { k: 'call', sym, args, ty: retTy, paramTypes, variadic };
        return node;
      }
      if (sym.kind === 'builtin') {
        const mn = sym.min || 0, mx = sym.max == null ? 999 : sym.max;
        if (args.length < mn) this.errAt(tok, `函数 '${sym.name}' 需要${mn === mx ? ' ' + mn : '至少 ' + mn} 个参数，实际给了 ${args.length} 个`);
        if (args.length > mx) this.errAt(tok, `函数 '${sym.name}' 最多接受 ${mx} 个参数，实际给了 ${args.length} 个`);
        return { k: 'builtin', name: sym.name, args, fn: sym.fn, ty: sym.ret || INT };
      }
      // 变量里存的是函数指针
      const pty = decay(calleeNode.ty);
      if (!isPtr(pty) || pty.base.kind !== 'func') this.errAt(tok, `'${calleeNode.name}' 不是函数，不能调用`);
      paramTypes = pty.base.params.map((p) => p.type);
      variadic = pty.base.variadic;
      retTy = pty.base.ret;
      return { k: 'callp', fnExpr: calleeNode, args, ty: retTy, paramTypes, variadic };
    }
    if (calleeNode.k === 'unresolved') {
      // 允许调用本文件后面才定义的函数
      const node = { k: 'call', sym: null, name: calleeNode.name, args, ty: INT, paramTypes: null, variadic: true };
      this.unresolvedCalls.push({ name: calleeNode.name, node, line: tok.line, col: tok.col, file: tok.file });
      // 把该标识符登记成函数占位（避免后续再报未声明）
      this.scope.names.set(calleeNode.name, { kind: 'func', name: calleeNode.name, type: funcType(INT, [], true), params: [], frameSize: 0, body: null, funcIndex: -1, forward: true });
      return node;
    }
    const pty = decay(calleeNode.ty);
    if (!isPtr(pty) || pty.base.kind !== 'func') this.errAt(tok, `被调用的表达式不是函数（类型是 ${typeName(calleeNode.ty)}）`);
    paramTypes = pty.base.params.map((p) => p.type);
    variadic = pty.base.variadic;
    const cargs = args.map((a, i) => (i < paramTypes.length ? this.cast(a, decay(paramTypes[i]), '实参类型不匹配') : a));
    return { k: 'callp', fnExpr: calleeNode, args: cargs, ty: pty.base.ret, paramTypes, variadic };
  }

  checkArgs(paramTypes, variadic, args, tok, name) {
    const min = paramTypes.length;
    if (variadic) {
      if (args.length < min) {
        this.errAt(tok, `函数 '${name}' 需要至少 ${min} 个参数，实际给了 ${args.length} 个`);
      }
    } else if (args.length !== min) {
      this.errAt(tok, `函数 '${name}' 需要 ${min} 个参数，实际给了 ${args.length} 个`);
    }
    for (let i = 0; i < Math.min(min, args.length); i++) {
      const want = paramTypes[i];
      const got = args[i].ty;
      if (isAggr(want) && isAggr(got)) {
        if (!this.sameAggr(want, got)) this.errAt(tok, `函数 '${name}' 第 ${i + 1} 个参数类型不匹配：需要 ${typeName(want)}，实际 ${typeName(got)}`);
        continue;
      }
      if (isPtr(want)) {
        if (isInt(got) && got.size === 8) continue;
        if (isPtr(got) || isArray(got)) {
          const g = isArray(got) ? decay(got) : got;
          if (!this.compatiblePtr(want, g) && !(want.base.kind === 'void')) {
            this.warnings.push({ message: `函数 '${name}' 第 ${i + 1} 个参数：指针类型不同（${typeName(want)} ← ${typeName(g)}）`, line: tok.line, file: tok.file });
          }
          continue;
        }
        continue;
      }
      if (isArith(want) || isVoid(want)) continue;
    }
  }

  sameAggr(a, b) {
    if (a.kind !== b.kind) return false;
    if (a.kind === 'array') return a.len === b.len && this.sameAggr(a.base, b.base);
    if (a.kind === 'struct' || a.kind === 'union') return a === b || (!!a.tag && a.tag === b.tag);
    return a.id === b.id;
  }

  isLValue(node) {
    if (!node) return false;
    switch (node.k) {
      case 'var': return node.sym.kind === 'local' || node.sym.kind === 'global' || node.sym.kind === 'func';
      case 'deref': case 'member': return true;
      case 'comma': return this.isLValue(node.b);
      default: return false;
    }
  }

  primary() {
    const t = this.tok;
    if (t.k === 'num') {
      this.next();
      if (t.isFloat) return { k: 'num', v: t.v, ty: t.f === 4 ? FLOAT : DOUBLE };
      let ty = INT;
      if (t.l === 2) ty = t.u ? ULLONG : LLONG;
      else if (t.l === 1) ty = t.u ? ULONG : LONG;
      else if (t.u) ty = UINT;
      if (!t.u && !t.l && t.v > 2147483647) ty = LLONG;
      return { k: 'num', v: t.v, ty };
    }
    if (t.k === 'chr') { this.next(); return { k: 'num', v: t.v, ty: INT }; }
    if (t.k === 'str') {
      let s = '';
      while (this.tok.k === 'str') { s += this.tok.v; this.next(); }
      return { k: 'str', v: s, ty: arrayOf(CHAR, s.length + 1) };
    }
    if (this.is('(')) {
      this.next();
      const e = this.expr();
      this.expect(')');
      return e;
    }
    if (t.k === 'id') {
      this.next();
      const sym = this.lookup(t.v);
      if (!sym) {
        if (this.is('(')) return { k: 'unresolved', name: t.v };
        // 常见错误提示
        const hint = ['printf', 'scanf', 'malloc'].includes(t.v) ? `（是否忘了 #include <${t.v === 'malloc' ? 'stdlib' : 'stdio'}.h>？本引擎即使没有 include 也提供这些函数）` : '';
        this.errAt(t, `未声明的标识符 '${t.v}'${hint}`);
      }
      if (sym.kind === 'enum') return { k: 'num', v: sym.value, ty: INT };
      if (sym.kind === 'const') return { k: 'num', v: sym.value, ty: sym.type };
      if (sym.kind === 'typedef') this.errAt(t, `'${t.v}' 是类型名，不能当变量使用`);
      if (sym.kind === 'func') {
        if (sym.forward || sym.funcIndex < 0) return { k: 'unresolved', name: t.v };
        return { k: 'var', sym, ty: sym.type };
      }
      if (sym.kind === 'builtin') {
        // 作为值使用时返回函数地址节点；buildCall 会在调用处拦截为 builtin 节点
        return { k: 'var', sym, ty: sym.type };
      }
      if (sym.kind === 'local' && sym.isStatic === false && sym.storage === 'extern') {
        return { k: 'var', sym, ty: sym.type };
      }
      if (sym.type.kind === 'array' && sym.type.len === null) this.errAt(t, `数组 '${t.v}' 长度未知`);
      return { k: 'var', sym, ty: sym.type };
    }
    this.err(`这里应该是一个表达式，实际是 ${this.describe(t)}`);
  }

  // ── 常量表达式 ──
  constExpr() {
    const node = this.conditional();
    const v = constEval(node);
    if (v === null) this.err('这里需要编译期常量（例如数组长度、case 标签、枚举值）');
    return v;
  }
}

export function constEval(node) {
  if (!node) return null;
  switch (node.k) {
    case 'num': return node.v;
    case 'cast': { const v = constEval(node.expr); return v === null ? null : (isFloat(node.ty) ? v : Math.trunc(v)); }
    case 'neg': { const v = constEval(node.expr); return v === null ? null : -v; }
    case 'not': { const v = constEval(node.expr); return v === null ? null : (v ? 0 : 1); }
    case 'bin': {
      const a = constEval(node.a);
      const b = constEval(node.b);
      if (a === null || b === null) return null;
      switch (node.op) {
        case '+': return a + b;
        case '-': return a - b;
        case '*': return a * b;
        case '/': return b === 0 ? null : Math.trunc(a / b);
        case '%': return b === 0 ? null : a % b;
        case '&': return a & b;
        case '|': return a | b;
        case '^': return a ^ b;
        case '<<': return a << b;
        case '>>': return a >> b;
        case '~': return ~a;
        case '==': return a === b ? 1 : 0;
        case '!=': return a !== b ? 1 : 0;
        case '<': return a < b ? 1 : 0;
        case '>': return a > b ? 1 : 0;
        case '<=': return a <= b ? 1 : 0;
        case '>=': return a >= b ? 1 : 0;
        default: return null;
      }
    }
    case 'cond': { const c = constEval(node.cond); if (c === null) return null; return c ? constEval(node.a) : constEval(node.b); }
    case 'comma': return constEval(node.b);
    case 'logand': { const a = constEval(node.a); if (a === null) return null; if (!a) return 0; const b = constEval(node.b); return b === null ? null : (b ? 1 : 0); }
    case 'logor': { const a = constEval(node.a); if (a === null) return null; if (a) return 1; const b = constEval(node.b); return b === null ? null : (b ? 1 : 0); }
    case 'var': return null;
    default: return null;
  }
}

export function parseProgram(tokens, opts = {}) {
  const p = new Parser(tokens, opts);
  return p.run();
}
