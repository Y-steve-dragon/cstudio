// 性能基准：衡量「自带引擎」在真实设备上的执行速度
// 用法：node tests/perf.mjs
import { compileSources, execute } from '../engine/cengine.js';

const cases = [
  {
    name: 'hello（示例程序）',
    src: `#include <stdio.h>
int main(void){ printf("Hello, C!\\n"); return 0; }`,
    unit: (s) => `${s.toFixed(0)} 千步/秒`,
  },
  {
    name: '空循环 100 万次（累加 long）',
    src: `#include <stdio.h>
int main(void){ long s = 0; for (long i = 0; i < 1000000; i++) s += i; printf("%ld\\n", s); return 0; }`,
    unit: (s) => `${s.toFixed(0)} 千步/秒`,
  },
  {
    name: '空循环 1000 万次（累加 long）',
    src: `#include <stdio.h>
int main(void){ long s = 0; for (long i = 0; i < 10000000; i++) s += i; printf("%ld\\n", s); return 0; }`,
    unit: (s) => `${s.toFixed(0)} 千步/秒`,
  },
  {
    name: '递归 fib(26)',
    src: `#include <stdio.h>
long fib(int n){ return n < 2 ? n : fib(n-1) + fib(n-2); }
int main(void){ printf("%ld\\n", fib(26)); return 0; }`,
    unit: (s) => `${s.toFixed(0)} 千步/秒`,
  },
  {
    name: '冒泡排序 300 个随机数',
    src: `#include <stdio.h>
#include <stdlib.h>
int main(void){
    int a[300];
    srand(7);
    for (int i = 0; i < 300; i++) a[i] = rand() % 10000;
    for (int i = 0; i < 299; i++)
        for (int j = 0; j < 299 - i; j++)
            if (a[j] > a[j+1]) { int t = a[j]; a[j] = a[j+1]; a[j+1] = t; }
    printf("%d %d\\n", a[0], a[299]);
    return 0;
}`,
    unit: (s) => `${s.toFixed(0)} 千步/秒`,
  },
  {
    name: 'printf 两万行输出（约 200 KB）',
    src: `#include <stdio.h>
int main(void){ for (int i = 0; i < 20000; i++) printf("第 %d 行：数值 %d\\n", i, i * i); return 0; }`,
    unit: (s) => `${s.toFixed(0)} 千步/秒`,
  },
  {
    name: 'malloc/free 一万轮 + 数组读写',
    src: `#include <stdio.h>
#include <stdlib.h>
int main(void){
    long total = 0;
    for (int k = 0; k < 10000; k++) {
        int *p = (int *)malloc(64 * sizeof(int));
        for (int i = 0; i < 64; i++) p[i] = i;
        for (int i = 0; i < 64; i++) total += p[i];
        free(p);
    }
    printf("%ld\\n", total);
    return 0;
}`,
    unit: (s) => `${s.toFixed(0)} 千步/秒`,
  },
  {
    name: '字符串处理：拼接与 strlen 五千次',
    src: `#include <stdio.h>
#include <string.h>
int main(void){
    char buf[512];
    long total = 0;
    for (int i = 0; i < 5000; i++) {
        buf[0] = 0;
        strcat(buf, "hello ");
        strcat(buf, "world ");
        strcat(buf, "cstudio");
        total += strlen(buf);
    }
    printf("%ld\\n", total);
    return 0;
}`,
    unit: (s) => `${s.toFixed(0)} 千步/秒`,
  },
];

const rows = [];
for (const c of cases) {
  const files = { 'main.c': c.src };
  const comp = compileSources(files, 'main.c');
  if (!comp.ok) {
    rows.push({ name: c.name, ok: false, note: '编译失败：' + (comp.diagnostics[0] || {}).message });
    continue;
  }
  const t0 = performance.now();
  const r = await execute(comp.program, { write() {} }, {});
  const ms = performance.now() - t0;
  const steps = r.interpreter ? r.interpreter.steps : 0;
  rows.push({
    name: c.name,
    ok: r.ok,
    ms,
    steps,
    rate: steps / Math.max(ms, 0.001),
    note: r.ok ? c.unit(steps / Math.max(ms, 0.001)) : String(r.error && r.error.message),
  });
}

const pad = (s, n) => {
  const w = [...String(s)].reduce((a, ch) => a + (ch.charCodeAt(0) > 127 ? 2 : 1), 0);
  return String(s) + ' '.repeat(Math.max(0, n - w));
};
console.log(pad('用例', 34) + pad('耗时(ms)', 12) + pad('步数', 14) + '速度');
console.log('─'.repeat(88));
for (const r of rows) {
  if (r.ok === false && !r.ms) {
    console.log(pad(r.name, 34) + pad('—', 12) + pad('—', 14) + r.note);
    continue;
  }
  console.log(pad(r.name, 34) + pad(r.ms.toFixed(1), 12) + pad(r.steps, 14) + (r.ok ? r.note : '失败：' + r.note));
}
const bad = rows.filter((r) => r.ms === undefined || !r.ok).length;
console.log('\n' + (bad ? `${bad} 个基准未通过` : '全部基准完成'));
process.exitCode = bad ? 1 : 0;
