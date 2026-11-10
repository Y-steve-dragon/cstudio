// 掌心 C · 引擎自测（node tests/run.mjs）
import { runSource } from '../engine/cengine.js';
import { Session } from '../engine/session.js';

const CASES = [];

function t(name, src, opts = {}) {
  CASES.push({ name, src, ...opts });
}

// ── 基础 ──
t('hello', `#include <stdio.h>
int main(void) { printf("Hello, World!\\n"); return 0; }`, { out: 'Hello, World!\n' });

t('算术与格式', `#include <stdio.h>
int main() {
  int a = 7, b = 3;
  printf("%d %d %d %d %d\\n", a + b, a - b, a * b, a / b, a % b);
  printf("%.3f %5.2f %e\\n", 3.14159, 2.5, 1234.5);
  printf("%%|%c|%s|%5s|%-5s|\\n", 'A', "hi", "ab", "cd");
  printf("%x %X %o %u\\n", 255, 255, 8, 10);
  return 0;
}`, { out: '10 4 21 2 1\n3.142  2.50 1.234500e+03\n%|A|hi|   ab|cd   |\nff FF 10 10\n' });

t('循环与判断', `#include <stdio.h>
int main() {
  int sum = 0;
  for (int i = 1; i <= 100; i++) sum += i;
  printf("%d\\n", sum);
  int n = 10;
  while (n > 0) { printf("%d", n % 3); n--; }
  printf("\\n");
  return 0;
}`, { out: '5050\n1021021021\n' });

t('数组与字符串', `#include <stdio.h>
#include <string.h>
int main() {
  int a[5] = {5, 4, 3, 2, 1};
  int n = 5;
  for (int i = 0; i < n - 1; i++)
    for (int j = 0; j < n - 1 - i; j++)
      if (a[j] > a[j + 1]) { int t = a[j]; a[j] = a[j + 1]; a[j + 1] = t; }
  for (int i = 0; i < n; i++) printf("%d", a[i]);
  printf("\\n");
  char s[32] = "hello";
  strcat(s, " world");
  printf("%s %d\\n", s, (int)strlen(s));
  return 0;
}`, { out: '12345\nhello world 11\n' });

t('递归阶乘', `#include <stdio.h>
long long fact(int n) { return n <= 1 ? 1 : n * fact(n - 1); }
int main() { for (int i = 1; i <= 10; i++) printf("%lld ", fact(i)); printf("\\n"); return 0; }`,
  { out: '1 2 6 24 120 720 5040 40320 362880 3628800 \n' });

t('指针与结构体', `#include <stdio.h>
#include <stdlib.h>
struct Point { int x, y; };
int main() {
  struct Point p = {3, 4};
  struct Point *q = &p;
  q->x = 10;
  printf("%d %d\\n", p.x, q->y);
  int *arr = (int*)malloc(3 * sizeof(int));
  for (int i = 0; i < 3; i++) arr[i] = i * i;
  printf("%d %d %d\\n", arr[0], arr[1], arr[2]);
  free(arr);
  return 0;
}`, { out: '10 4\n0 1 4\n' });

t('scanf 输入', `#include <stdio.h>
int main() {
  int a, b;
  scanf("%d %d", &a, &b);
  printf("%d\\n", a + b);
  char name[16];
  scanf("%s", name);
  printf("hi, %s\\n", name);
  return 0;
}`, { input: ['3 4', 'Tom'], out: '7\nhi, Tom\n' });

t('浮点与数学函数', `#include <stdio.h>
#include <math.h>
int main() {
  printf("%.4f %.4f %.4f\\n", sqrt(2.0), pow(2, 10), fabs(-3.5));
  double x = 1.0 / 3.0;
  printf("%.10f\\n", x);
  printf("%d\\n", (int)(x * 3 + 0.5));
  return 0;
}`, { out: '1.4142 1024.0000 3.5000\n0.3333333333\n1\n' });

t('位运算与枚举', `#include <stdio.h>
enum Color { RED, GREEN = 5, BLUE };
int main() {
  printf("%d %d %d\\n", RED, GREEN, BLUE);
  printf("%d %d %d %d\\n", 6 & 3, 6 | 3, 6 ^ 3, ~6);
  printf("%d %d\\n", 1 << 4, 256 >> 3);
  return 0;
}`, { out: '0 5 6\n2 7 5 -7\n16 32\n' });

t('switch 与 goto', `#include <stdio.h>
int main() {
  for (int i = 0; i < 4; i++) {
    switch (i) {
      case 0: printf("zero "); break;
      case 1: printf("one "); break;
      case 2: printf("two ");
      case 3: printf("three "); break;
      default: printf("other ");
    }
  }
  printf("\\n");
  int i = 0;
loop:
  if (i < 3) { printf("%d", i); i++; goto loop; }
  printf("\\n");
  return 0;
}`, { out: 'zero one two three three \n012\n' });

t('do-while 与 break/continue', `#include <stdio.h>
int main() {
  int i = 0, s = 0;
  do { i++; if (i % 2 == 0) continue; if (i > 7) break; s += i; } while (1);
  printf("%d %d\\n", i, s);
  return 0;
}`, { out: '9 16\n' });

t('字符串函数', `#include <stdio.h>
#include <string.h>
int main() {
  char a[64] = "abc", b[64] = "abd";
  printf("%d %d\\n", strcmp(a, b) < 0, strcmp(a, a) == 0);
  printf("%d\\n", (int)strlen("hello"));
  char *p = strchr("abcdef", 'd');
  printf("%s\\n", p);
  char s[16] = "x,y,z";
  char *tok = strtok(s, ",");
  while (tok) { printf("[%s]", tok); tok = strtok(NULL, ","); }
  printf("\\n");
  return 0;
}`, { out: '1 1\n5\ndef\n[x][y][z]\n' });

t('可变参数', `#include <stdio.h>
#include <stdarg.h>
int sum(int n, ...) {
  va_list ap;
  va_start(ap, n);
  int s = 0;
  for (int i = 0; i < n; i++) s += va_arg(ap, int);
  va_end(ap);
  return s;
}
int main() { printf("%d\\n", sum(4, 1, 2, 3, 4)); return 0; }`, { out: '10\n' });

t('typedef 与函数指针', `#include <stdio.h>
typedef int (*Op)(int, int);
int add(int a, int b) { return a + b; }
int mul(int a, int b) { return a * b; }
int apply(Op f, int a, int b) { return f(a, b); }
int main() {
  printf("%d %d\\n", apply(add, 3, 4), apply(mul, 3, 4));
  Op fns[2] = {add, mul};
  printf("%d\\n", fns[1](5, 6));
  return 0;
}`, { out: '7 12\n30\n' });

t('二维数组与矩阵', `#include <stdio.h>
int main() {
  int a[3][3];
  for (int i = 0; i < 3; i++) for (int j = 0; j < 3; j++) a[i][j] = i * 3 + j;
  int s = 0;
  for (int i = 0; i < 3; i++) s += a[i][i];
  printf("%d %d\\n", s, a[2][1]);
  return 0;
}`, { out: '12 7\n' });

t('联合体与 sizeof', `#include <stdio.h>
union U { int i; char c[4]; };
int main() {
  printf("%d %d %d %d %d\\n", (int)sizeof(int), (int)sizeof(char), (int)sizeof(long), (int)sizeof(long long), (int)sizeof(double));
  printf("%d %d\\n", (int)sizeof(union U), (int)sizeof(int*));
  union U u;
  u.i = 0;
  u.c[0] = 65;
  printf("%c %d\\n", u.c[0], (int)sizeof(u));
  return 0;
}`, { out: '4 1 4 8 8\n4 8\nA 4\n' });

t('冒泡排序函数', `#include <stdio.h>
void sort(int a[], int n) {
  for (int i = 0; i < n - 1; i++)
    for (int j = 0; j < n - 1 - i; j++)
      if (a[j] > a[j + 1]) { int t = a[j]; a[j] = a[j + 1]; a[j + 1] = t; }
}
int main() {
  int a[] = {9, 2, 7, 1, 5};
  int n = sizeof(a) / sizeof(a[0]);
  sort(a, n);
  for (int i = 0; i < n; i++) printf("%d ", a[i]);
  printf("\\n");
  return 0;
}`, { out: '1 2 5 7 9 \n' });

// ── 中文与 UTF-8 ──
t('中文字符串能正确输出', `#include <stdio.h>
int main(void) { printf("平方和=%d 中文测试\\n", 91); return 0; }`, { out: '平方和=91 中文测试\n' });

t('strlen 按字节数（中文 3 字节）', `#include <stdio.h>
#include <string.h>
int main(void) {
  char s[] = "你好";
  printf("%d %d\\n", (int)strlen(s), (int)sizeof(s));
  return 0;
}`, { out: '6 7\n' });

t('sprintf 写入中文再读出', `#include <stdio.h>
#include <string.h>
int main(void) {
  char buf[64];
  sprintf(buf, "名字：%s", "张三");
  printf("%s|%d\\n", buf, (int)strlen(buf));
  return 0;
}`, { out: '名字：张三|15\n' });

t('scanf 读入中文再输出', `#include <stdio.h>
int main(void) {
  char name[32];
  scanf("%s", name);
  printf("你好，%s！\\n", name);
  return 0;
}`, { out: '你好，张三！\n', input: ['张三'] });

t('转义字节 \\xE4 仍是单字节', `#include <stdio.h>
int main(void) {
  printf("[%d]\\n", (int)sizeof("\\xE4\\xB8\\xAD"));
  printf("%s\\n", "\\xE4\\xB8\\xAD");
  return 0;
}`, { out: '[4]\n中\n' });

// ── 错误处理 ──
t('语法错误要报错', `int main() { int a = ; return 0; }`, { err: true });
t('未定义变量要报错', `int main() { return x; }`, { err: true });
t('除零要报错', `#include <stdio.h>
int main() { int z = 0; printf("%d", 1 / z); return 0; }`, { err: true });
t('堆越界要报错', `#include <stdio.h>
#include <stdlib.h>
int main() { int *a = (int*)malloc(2 * sizeof(int)); a[10] = 1; return 0; }`, { err: true });
t('死循环可被步数限制打断', `int main() { for(;;){} }`, { err: true, engineOpts: { stepLimit: 200000 } });
t('往字符串常量里写要报错', `#include <stdio.h>
int main() { char *s = "abc"; s[0] = 'x'; return 0; }`, { err: true });

// ── 会话与调试（与浏览器 worker 用同一套 Session 接口） ──
const SESS = [];
function ts(name, fn) { SESS.push({ name, fn }); }

function assertEq(actual, expected, what) {
  if (actual !== expected) {
    throw new Error(`${what} 不符\n  期望：${JSON.stringify(expected)}\n  实际：${JSON.stringify(actual)}`);
  }
}

ts('scanf 交互输入', async () => {
  const outs = [];
  const inputs = ['12 34', 'abc'];
  const s = new Session((m) => {
    if (m.type === 'out') outs.push(m.text);
    if (m.type === 'input-request') {
      if (inputs.length) s.input(inputs.shift());
      else s.eof();
    }
    if (m.type === 'error') throw new Error('运行错误：' + m.error.message);
  });
  const r = await s.start({
    files: {
      'main.c': `#include <stdio.h>
int main() {
  int a, b;
  printf("a=");
  scanf("%d %d", &a, &b);
  printf("sum=%d\\n", a + b);
  char s[16];
  scanf("%s", s);
  printf("s=%s\\n", s);
  return 0;
}`,
    },
  });
  assertEq(r.ok, true, '会话成功');
  assertEq(outs.join(''), 'a=12 34\nsum=46\nabc\ns=abc\n', '输出');
});

ts('断点暂停与单步', async () => {
  const paused = [];
  const outs = [];
  let steps = 0;
  const s = new Session((m) => {
    if (m.type === 'out') outs.push(m.text);
    if (m.type === 'paused') {
      paused.push(m.snapshot);
      steps++;
      if (steps === 1) s.resume({ action: 'stepIn' });
      else if (steps === 2) s.resume({ action: 'stepIn' });
      else s.resume({ action: 'run' });
    }
  });
  const r = await s.start({
    mode: 'debug',
    breakpoints: ['main.c:3'],
    files: {
      'main.c': `#include <stdio.h>
int f(int x) { return x * 2; }
int main() { int a = 1; int b = f(a); printf("%d\\n", b); return 0; }`,
    },
  });
  assertEq(r.ok, true, '调试运行成功');
  if (paused.length < 2) throw new Error(`暂停次数太少：${paused.length}`);
  assertEq(paused[0].fn, 'main', '首个断点在 main');
  if (!paused.some((p) => p.fn === 'f')) throw new Error('单步没有进入函数 f');
  const v = paused[0].vars.find((x) => x.name === 'a');
  if (!v) throw new Error('快照里没有局部变量 a');
  assertEq(outs.join(''), '2\n', '输出');
});

ts('等待输入时可以停止', async () => {
  const s = new Session(() => {});
  let done = null;
  const p = s.start({
    files: { 'main.c': `#include <stdio.h>\nint main() { int x; scanf("%d", &x); return 0; }` },
  });
  setTimeout(() => s.stop(), 30);
  const r = await p;
  done = r;
  assertEq(done.ok, false, '被停止');
});

ts('死循环可被步数限制打断', async () => {
  const s = new Session(() => {});
  const r = await s.start({
    stepLimit: 100000,
    files: { 'main.c': `int main() { for(;;){} }` },
  });
  assertEq(r.ok, false, '被步数限制中止');
});

// ═════════════════════ 运行 ═════════════════════
const filter = process.argv[2];
let pass = 0, fail = 0;
const failures = [];
for (const c of CASES) {
  if (filter && !c.name.includes(filter)) continue;
  let r;
  try {
    r = await runSource(c.src, { input: c.input || [], engineOpts: c.engineOpts || {} });
  } catch (e) {
    fail++;
    failures.push({ name: c.name, why: '引擎异常：' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n') : e) });
    continue;
  }
  const diagText = (r.diagnostics || []).map((d) => `  ${d.severity}: ${d.message}${d.line ? ` (第 ${d.line} 行)` : ''}`).join('\n');
  if (c.err) {
    const bad = r.ok && !r.error;
    if (bad) { fail++; failures.push({ name: c.name, why: `期望报错，但运行成功。输出：${JSON.stringify(r.output)}` }); }
    else pass++;
    continue;
  }
  if (!r.ok || r.error) {
    fail++;
    failures.push({ name: c.name, why: `运行失败：${r.error ? r.error.message + (r.error.line ? `（第 ${r.error.line} 行）` : '') : '编译错误'}\n${diagText}` });
    continue;
  }
  if (r.output !== c.out) {
    fail++;
    failures.push({ name: c.name, why: `输出不符\n  期望：${JSON.stringify(c.out)}\n  实际：${JSON.stringify(r.output)}` });
    continue;
  }
  pass++;
}

// ── 会话测试 ──
for (const c of SESS) {
  if (filter && !c.name.includes(filter)) continue;
  try {
    await c.fn();
    pass++;
  } catch (e) {
    fail++;
    failures.push({ name: c.name, why: '会话测试失败：' + (e && e.message ? e.message : e) });
  }
}

console.log(`\n通过 ${pass} / ${pass + fail}`);
if (failures.length) {
  console.log('\n失败用例：');
  for (const f of failures) console.log(`\n✗ ${f.name}\n  ${f.why.split('\n').join('\n  ')}`);
  process.exitCode = 1;
}
