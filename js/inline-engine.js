// 掌心 C · 单文件离线版的「引擎外壳」
// 有的运行环境里用不了 Web Worker（最典型：手机上直接打开本地的 .html 文件，file:// 下
// new Worker(...) 会被浏览器拦掉）。这里给出一个和 Worker 接口一致的替代品：
//   postMessage / onmessage / onerror / terminate
// 真正的引擎跑在主线程里，靠解释器的协作式让出（每 8192 步让一次）保证界面不卡、
// 「停止」按钮依然有效。
import { createDriver } from '../engine/driver.js';

export function createInlineEngine() {
  let terminated = false;

  const engine = {
    isInline: true,
    onmessage: null,
    onerror: null,
    postMessage(msg) {
      if (!terminated) driver.handle(msg || {});
    },
    terminate() {
      terminated = true;
      driver.dispose();
    },
  };

  const driver = createDriver((msg) => {
    if (terminated) return;
    // 模拟 Worker 的异步投递：不在 postMessage 的调用栈里同步回调，
    // 免得界面在处理消息时又触发新的消息（Worker 版天然没有这个问题）。
    setTimeout(() => {
      if (terminated) return;
      if (typeof engine.onmessage === 'function') {
        try {
          engine.onmessage({ data: msg });
        } catch (e) {
          console.error('处理引擎消息出错', e);
        }
      }
    }, 0);
  });

  return engine;
}
