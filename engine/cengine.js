// 掌心 C · 引擎门面：预处理 → 词法 → 语法 → 执行
import {
  VOID, BOOL, CHAR, SCHAR, UCHAR, SHORT, USHORT, INT, UINT, LONG, ULONG, LLONG, ULLONG,
  FLOAT, DOUBLE, ptrTo, newStruct, computeLayout, CompileError, Fault, ExitSignal, typeName,
} from './core.js';
import { preprocess } from './preproc.js';
import { tokenize } from './lexer.js';
import { parseProgram } from './parser.js';
import { Interpreter } from './interp.js';
import { BUILTIN_FUNCS, PREDEFINED_CONSTANTS, PREDEFINED_TYPEDEFS, PREDEFINED_STRUCTS } from './builtins.js';

const TYPE_BY_NAME = {
  void: VOID, bool: BOOL, char: CHAR, uchar: UCHAR, short: SHORT, ushort: USHORT,
  int: INT, uint: UINT, long: LONG, ulong: ULONG, llong: LLONG, ullong: ULLONG,
  float: FLOAT, double: DOUBLE, 'char*': ptrTo(CHAR),
};

let _predef = null;
function predef() {
  if (_predef) return _predef;
  const types = [];
  for (const [n, s] of Object.entries(PREDEFINED_TYPEDEFS)) {
    const t = TYPE_BY_NAME[s];
    if (t) types.push([n, t]);
  }
  const consts = PREDEFINED_CONSTANTS.map((c) => ({
    name: c.name,
    value: c.value,
    type: c.type === 'ptr' ? ptrTo(VOID) : (TYPE_BY_NAME[c.type] || INT),
  }));
  const structs = [];
  for (const [tag, members] of Object.entries(PREDEFINED_STRUCTS)) {
    const st = newStruct(tag, false);
    for (const [mn, mt] of members) st.members.push({ name: mn, type: TYPE_BY_NAME[mt] || INT });
    computeLayout(st);
    structs.push([tag, st]);
  }
  _predef = { types, consts, structs };
  return _predef;
}

const diag = (e, severity = 'error') => ({
  severity,
  message: e.message || String(e),
  line: e.line || 0,
  col: e.col || 0,
  file: e.file || '',
});

/**
 * 编译（不执行）
 * @param {Object<string,string>} filesObj 文件名 → 内容
 * @param {string} mainName 入口文件名（默认 main.c，找不到则取第一个 .c）
 */
export function compileSources(filesObj, mainName = 'main.c', opts = {}) {
  const files = new Map(Object.entries(filesObj));
  // 芯片/平台自带的系统头文件（如 STM32 的 stm32f10x.h）：只参与预处理，不算工程文件
  const extra = opts.extraFiles || null;
  if (extra) for (const [k, v] of Object.entries(extra)) if (!files.has(k)) files.set(k, v);
  if (!files.size) {
    return { ok: false, program: null, diagnostics: [diag({ message: '没有可编译的源文件' })] };
  }
  if (!files.has(mainName)) {
    const first = [...files.keys()].find((k) => /\.c$/i.test(k)) || [...files.keys()][0];
    mainName = first;
  }
  const diagnostics = [];
  try {
    const pp = preprocess(mainName, files);
    for (const w of pp.warnings || []) diagnostics.push(diag(w, 'warning'));
    const toks = tokenize(pp.text, pp.posOf);
    const p = predef();
    const res = parseProgram(toks, {
      builtins: BUILTIN_FUNCS,
      predefTypes: p.types,
      predefConsts: p.consts,
      predefStructs: p.structs,
    });
    for (const e of res.errors) diagnostics.push(diag(e));
    for (const w of res.warnings || []) diagnostics.push(diag(w, 'warning'));
    const ok = !res.errors.length;
    return { ok, program: ok ? res : null, diagnostics, parsed: res, includes: pp.includes };
  } catch (e) {
    if (e instanceof CompileError) {
      diagnostics.push(diag(e));
      return { ok: false, program: null, diagnostics };
    }
    throw e;
  }
}

/**
 * 执行已编译的程序
 * io: { write(text), requestInput()→Promise<string|null>, echoInput(text) }
 */
export async function execute(program, io = {}, opts = {}) {
  const it = new Interpreter(program, io, opts);
  try {
    await it.run();
    return { ok: true, exitCode: 0, interpreter: it };
  } catch (e) {
    if (e instanceof ExitSignal) return { ok: true, exitCode: e.code, interpreter: it };
    if (e instanceof Fault) {
      return { ok: false, error: describeRuntimeError(e, it), interpreter: it };
    }
    throw e;
  }
}

export function describeRuntimeError(e, it) {
  const pos = it ? it.curPos : null;
  const stack = [];
  if (it && it.callStack) {
    for (let i = it.callStack.length - 1; i >= 0; i--) {
      const fr = it.callStack[i];
      if (fr && fr.fn) stack.push({ name: fr.fn.name, line: fr.pos ? fr.pos.line : (fr.fn.defToken ? fr.fn.defToken.line : 0) });
    }
  }
  return {
    message: e.message || String(e),
    line: pos && pos.line ? pos.line : 0,
    file: pos && pos.file ? pos.file : '',
    stack,
  };
}

/** 一步到位：编译并运行（测试与小工具用） */
export async function runSource(source, opts = {}) {
  const files = Object.assign({ 'main.c': source }, opts.files || {});
  const c = compileSources(files, opts.mainName || 'main.c');
  if (!c.ok) return { ok: false, diagnostics: c.diagnostics, output: '', exitCode: -1 };
  let out = '';
  const inputLines = (opts.input || []).slice();
  const io = {
    write: (t) => { out += t; },
    echoInput: opts.echo ? (t) => { out += t + '\n'; } : null,
    requestInput: async () => (inputLines.length ? inputLines.shift() : null),
  };
  const r = await execute(c.program, io, opts.engineOpts || {});
  return {
    ok: r.ok,
    output: out,
    exitCode: r.exitCode,
    error: r.error || null,
    diagnostics: c.diagnostics,
  };
}

export { BUILTIN_FUNCS, PREDEFINED_CONSTANTS, PREDEFINED_TYPEDEFS, PREDEFINED_STRUCTS, typeName };
