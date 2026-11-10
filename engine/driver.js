// 掌心 C · 引擎驱动：把「一条消息」翻译成 Session 操作。
// Worker 版（engine/worker.js）和单文件离线版（js/inline-engine.js）都复用它，
// 保证 Worker 通信协议只有一份实现。
import { Session } from './session.js';

export function createDriver(emit) {
  let session = null;

  const safeEmit = (msg) => {
    try { emit(msg); } catch (e) { /* 宿主的转发失败不应该让引擎崩掉 */ }
  };

  return {
    handle(m = {}) {
      switch (m.type) {
        case 'start':
          session = new Session(safeEmit);
          session.start({
            files: m.files || {},
            main: m.main || 'main.c',
            mode: m.mode || 'run',
            breakpoints: m.breakpoints || [],
            stepLimit: m.stepLimit || 0,
            deadlineMs: m.deadlineMs || 0,
          }).catch((e) => {
            safeEmit({ type: 'error', error: { message: '引擎启动失败：' + (e && e.message ? e.message : e), line: 0, file: '', stack: [] } });
            safeEmit({ type: 'done', ok: false, exitCode: -1, steps: 0, ms: 0 });
          });
          break;
        case 'input':
          if (session) session.input(m.text);
          break;
        case 'eof':
          if (session) session.eof();
          break;
        case 'resume':
          if (session) session.resume(m.action);
          break;
        case 'stop':
          if (session) session.stop();
          break;
        default:
          break;
      }
    },
    dispose() {
      if (session) {
        try { session.stop(); } catch (e) { /* 已经停了 */ }
        session = null;
      }
    },
  };
}
