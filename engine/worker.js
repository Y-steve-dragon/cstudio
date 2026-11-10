// 掌心 C · Web Worker 适配层：把 Session 事件转发到主线程。
// 浏览器里主线程用 new Worker('engine/worker.js', { type: 'module' }) 启动。
import { createDriver } from './driver.js';

const emit = (msg) => {
  try { self.postMessage(msg); } catch (e) { /* 结构化克隆失败时忽略，避免整体崩掉 */ }
};

const driver = createDriver(emit);

self.onmessage = (ev) => driver.handle(ev.data || {});
