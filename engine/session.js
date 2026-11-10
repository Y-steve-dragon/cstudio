// 掌心 C · 运行会话：把「编译 → 执行 → 交互输入 → 断点暂停」封装成事件流。
// 浏览器里由 worker.js 适配成 postMessage；Node 里可直接 new Session(emit) 做集成测试。
import { compileSources, describeRuntimeError } from './cengine.js';
import { Interpreter } from './interp.js';
import { Fault, ExitSignal } from './core.js';

/**
 * 会话事件（type 字段）：
 *   compile        { ok, diagnostics }            编译结束
 *   out            { text }                       程序输出
 *   input-request  { prompt }                     需要一行输入（scanf/gets/getchar）
 *   paused         { snapshot }                   断点/单步暂停
 *   error          { error, output }              运行时错误（段错误、除零…）
 *   exit           { code }                       正常结束（含 exit(n)）
 *   done           { ok, exitCode, steps, ms }    会话收尾（一定最后发出）
 */
export class Session {
  constructor(emit) {
    this.emit = emit;
    this.interp = null;
    this.waiters = [];        // 等待输入的 resolve
    this.pending = [];        // 用户提前输入的文本
    this.pauseResolve = null; // 等待调试器继续的 resolve
    this.stopped = false;
    this.running = false;
  }

  /** 用户提交一行输入（可早于请求，会排队） */
  input(text) {
    if (this.waiters.length) this.waiters.shift()(String(text));
    else this.pending.push(String(text));
  }

  /** 输入结束（EOF）：scanf 会返回 EOF / 读到 NULL */
  eof() {
    if (this.waiters.length) this.waiters.shift()(null);
    else this.pending.push(null);
  }

  /** 调试器：{ action: 'run'|'stepIn'|'stepOver'|'stepOut'|'stop', breakpoints?: string[] } */
  resume(action) {
    if (this.pauseResolve) {
      const r = this.pauseResolve;
      this.pauseResolve = null;
      this.emit({ type: 'resumed', action: action && action.action });
      r(action || { action: 'run' });
      return true;
    }
    return false;
  }

  stop() {
    this.stopped = true;
    // 正在等输入 → 当作 EOF，让 scanf 返回而不是永远挂着
    while (this.waiters.length) this.waiters.shift()(null);
    if (this.pauseResolve) {
      const r = this.pauseResolve;
      this.pauseResolve = null;
      r({ action: 'stop' });
    }
    if (this.interp) this.interp.aborted = true;
  }

  requestInput() {
    if (this.pending.length) {
      const v = this.pending.shift();
      return Promise.resolve(v);
    }
    return new Promise((resolve) => {
      this.waiters.push(resolve);
      this.emit({ type: 'input-request', prompt: '程序正在等待输入（scanf / gets / getchar）' });
    });
  }

  async start(opts = {}) {
    const t0 = Date.now();
    this.running = true;
    const c = compileSources(opts.files || {}, opts.main || 'main.c');
    this.emit({ type: 'compile', ok: c.ok, diagnostics: c.diagnostics, includes: [...(c.includes || [])] });
    if (!c.ok) {
      this.running = false;
      this.emit({ type: 'done', ok: false, exitCode: -1, steps: 0, ms: Date.now() - t0, phase: 'compile' });
      return { ok: false, phase: 'compile', diagnostics: c.diagnostics };
    }

    let outBuf = '';
    const io = {
      write: (t) => { outBuf += t; this.emit({ type: 'out', text: t }); },
      requestInput: () => this.requestInput(),
      echoInput: (t) => { this.emit({ type: 'out', text: t + '\n' }); },
    };
    const it = new Interpreter(c.program, io, {
      stepLimit: opts.stepLimit || 0,
      deadline: opts.deadlineMs ? t0 + opts.deadlineMs : 0,
    });
    this.interp = it;

    if (opts.mode === 'debug') {
      it.dbg = {
        breakpoints: new Set(opts.breakpoints || []),
        mode: 'run',
        targetDepth: 0,
        onPause: (snapshot) => new Promise((resolve) => {
          this.pauseResolve = resolve;
          this.emit({ type: 'paused', snapshot, output: outBuf });
        }),
      };
    }

    let outcome;
    try {
      await it.run();
      outcome = { ok: true, exitCode: 0 };
      this.emit({ type: 'exit', code: 0 });
    } catch (e) {
      if (e instanceof ExitSignal) {
        outcome = { ok: true, exitCode: e.code };
        this.emit({ type: 'exit', code: e.code });
      } else if (e instanceof Fault) {
        outcome = { ok: false, error: describeRuntimeError(e, it) };
        this.emit({ type: 'error', error: outcome.error, output: outBuf });
      } else if (this.stopped) {
        outcome = { ok: false, stopped: true, exitCode: -1 };
      } else {
        outcome = { ok: false, internal: String(e && e.stack ? e.stack : e) };
        this.emit({ type: 'error', error: { message: '引擎内部错误：' + (e && e.message ? e.message : e), line: 0, file: '', stack: [] } });
      }
    }
    this.running = false;
    this.emit({
      type: 'done',
      ok: outcome.ok,
      exitCode: outcome.exitCode,
      stopped: !!outcome.stopped,
      steps: it.steps,
      ms: Date.now() - t0,
      internal: outcome.internal,
    });
    return outcome;
  }
}
