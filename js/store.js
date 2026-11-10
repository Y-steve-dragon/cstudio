// 掌心 C · 数据层：文件、设置、断点的本地持久化
const KEY = 'cstudio.v1';

export const SAMPLE_MAIN = `#include <stdio.h>

/* 欢迎使用「掌心 C」——
   你的手机 C 语言练习场。
   点右上角的 ▶ 运行，看看结果。 */

int main(void)
{
    printf("Hello, C!\\n");

    int sum = 0;
    for (int i = 1; i <= 10; i++) {
        sum += i;
    }
    printf("1+2+...+10 = %d\\n", sum);

    double pi = 3.1415926535;
    printf("pi = %.4f\\n", pi);

    return 0;
}
`;

export const SAMPLE_STRUCT = `#include <stdio.h>
#include <string.h>

typedef struct {
    int id;
    char name[24];
    double score;
} Student;

void print_student(const Student *s)
{
    printf("#%d %-10s %.2f\\n", s->id, s->name, s->score);
}

int main(void)
{
    Student list[3];
    list[0].id = 1; strcpy(list[0].name, "小明"); list[0].score = 92.5;
    list[1].id = 2; strcpy(list[1].name, "小红"); list[1].score = 88.0;
    list[2].id = 3; strcpy(list[2].name, "小刚"); list[2].score = 76.5;

    printf("学号 姓名       分数\\n");
    for (int i = 0; i < 3; i++) {
        print_student(&list[i]);
    }
    return 0;
}
`;

export const SAMPLE_POINTER = `#include <stdio.h>
#include <stdlib.h>

/* 指针与动态内存：手动实现一个可变长数组 */
int main(void)
{
    int n = 8;
    int *a = (int *)malloc(n * sizeof(int));
    if (a == NULL) {
        printf("内存分配失败\\n");
        return 1;
    }

    for (int i = 0; i < n; i++) {
        a[i] = i * i;
    }

    int *p = a;
    for (int i = 0; i < n; i++) {
        printf("a[%d] = %d\\n", i, *(p + i));
    }

    free(a);
    a = NULL;
    return 0;
}
`;

export const SAMPLE_INPUT = `#include <stdio.h>

/* 交互示例：运行时下方会出现输入框，
   输入两个整数（用空格或换行隔开）后按回车。 */
int main(void)
{
    int a, b;
    printf("请输入两个整数：");
    if (scanf("%d %d", &a, &b) != 2) {
        printf("输入有误\\n");
        return 1;
    }
    printf("%d + %d = %d\\n", a, b, a + b);
    printf("%d * %d = %d\\n", a, b, a * b);
    return 0;
}
`;

export const SAMPLE_DEBUG = `#include <stdio.h>

/* 调试示例：在第 12 行左侧的行号上点一下打上红点（断点），
   然后点工具栏的「调试」按钮，程序会停在那里。
   用「单步」一步步走，右边可以看到每个变量的当前值。 */

int fib(int n)
{
    if (n <= 1) return n;
    return fib(n - 1) + fib(n - 2);
}

int main(void)
{
    int n = 6;
    long total = 0;
    for (int i = 0; i < n; i++) {
        int v = fib(i);
        total += v;
    }
    printf("fib(0..%d) 之和 = %ld\\n", n - 1, total);
    return 0;
}
`;

export const SAMPLE_RECURSION = `#include <stdio.h>
#include <string.h>

/* 汉诺塔：递归的经典例子 */
int moves = 0;

void hanoi(int n, char from, char to, char via)
{
    if (n == 0) return;
    hanoi(n - 1, from, via, to);
    printf("%c -> %c\\n", from, to);
    moves++;
    hanoi(n - 1, via, to, from);
}

int main(void)
{
    int n = 3;
    hanoi(n, 'A', 'C', 'B');
    printf("共移动 %d 次\\n", moves);
    return 0;
}
`;

export const SAMPLES = [
  { name: '入门示例', file: 'main.c', code: SAMPLE_MAIN },
  { name: '结构体', file: 'struct.c', code: SAMPLE_STRUCT },
  { name: '指针与内存', file: 'pointer.c', code: SAMPLE_POINTER },
  { name: '交互输入', file: 'input.c', code: SAMPLE_INPUT },
  { name: '断点调试', file: 'debug.c', code: SAMPLE_DEBUG },
  { name: '递归（汉诺塔）', file: 'recursion.c', code: SAMPLE_RECURSION },
];

// ───────────── 存储适配 ─────────────
// 单文件离线版常常是「直接打开本地 .html」（file:// 源），部分浏览器这时会禁用
// localStorage（甚至连读写都抛异常）。为了界面不因此崩掉，退化到内存存储：
// 本次会话里照常自动保存，关掉页面后需要用户用「下载」把代码导出去。
let _storage = null;
function storage() {
  if (_storage) return _storage;
  try {
    const probe = '__cstudio_probe__';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    _storage = {
      kind: 'local',
      getItem: (k) => localStorage.getItem(k),
      setItem: (k, v) => localStorage.setItem(k, v),
    };
  } catch (e) {
    const mem = new Map();
    _storage = {
      kind: 'memory',
      getItem: (k) => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => { mem.set(k, v); },
    };
  }
  return _storage;
}

const DEFAULT_STATE = {
  files: { 'main.c': SAMPLE_MAIN },
  activeFile: 'main.c',
  mainFile: 'main.c',
  settings: {
    fontSize: 14,
    tabSize: 4,
    theme: 'dark',
    autoIndent: true,
    autoClose: true,
    lineWrap: false,
    showGutter: true,
    symbolBar: true,
  },
  breakpoints: {}, // 文件名 → [行号]
};

function clone(o) {
  return JSON.parse(JSON.stringify(o));
}

export class Store {
  constructor() {
    this.state = clone(DEFAULT_STATE);
    this._load();
    this._timer = null;
  }

  /** 'local' = 浏览器本地存储可用；'memory' = 只能本会话保存（file:// 常见） */
  get storageKind() {
    return storage().kind;
  }

  _load() {
    try {
      const raw = storage().getItem(KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (saved && typeof saved === 'object') {
        this.state = {
          ...clone(DEFAULT_STATE),
          ...saved,
          settings: { ...DEFAULT_STATE.settings, ...(saved.settings || {}) },
          files: { ...(saved.files || {}) },
          breakpoints: { ...(saved.breakpoints || {}) },
        };
        if (!this.state.files[this.state.activeFile]) {
          this.state.activeFile = Object.keys(this.state.files)[0] || 'main.c';
        }
        if (!this.state.files[this.state.mainFile]) this.state.mainFile = this.state.activeFile;
      }
    } catch (e) {
      console.warn('读取本地数据失败，使用默认内容', e);
    }
  }

  save() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => this.saveNow(), 400);
  }

  saveNow() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    try {
      storage().setItem(KEY, JSON.stringify(this.state));
    } catch (e) {
      console.warn('保存失败（可能是存储空间已满）', e);
    }
  }

  // ── 文件 ──
  get fileNames() {
    return Object.keys(this.state.files).sort((a, b) => {
      if (a === this.state.mainFile) return -1;
      if (b === this.state.mainFile) return 1;
      const ac = a.endsWith('.c'), bc = b.endsWith('.c');
      if (ac !== bc) return ac ? -1 : 1;
      return a.localeCompare(b, 'zh-CN');
    });
  }
  get activeFile() { return this.state.activeFile; }
  get mainFile() { return this.state.mainFile; }
  getFile(name) {
    const v = this.state.files[name];
    return v === undefined ? null : v;
  }
  setFile(name, content) {
    this.state.files[name] = content;
    this.save();
  }
  addFile(name, content = '') {
    if (this.state.files[name] !== undefined) return false;
    this.state.files[name] = content;
    this.saveNow();
    return true;
  }
  deleteFile(name) {
    const names = Object.keys(this.state.files);
    if (names.length <= 1) return false;
    delete this.state.files[name];
    delete this.state.breakpoints[name];
    if (this.state.activeFile === name) this.state.activeFile = Object.keys(this.state.files)[0];
    if (this.state.mainFile === name) this.state.mainFile = this.state.activeFile;
    this.saveNow();
    return true;
  }
  renameFile(oldName, newName) {
    if (!this.state.files[oldName] || this.state.files[newName] !== undefined) return false;
    this.state.files[newName] = this.state.files[oldName];
    delete this.state.files[oldName];
    if (this.state.breakpoints[oldName]) {
      this.state.breakpoints[newName] = this.state.breakpoints[oldName];
      delete this.state.breakpoints[oldName];
    }
    if (this.state.activeFile === oldName) this.state.activeFile = newName;
    if (this.state.mainFile === oldName) this.state.mainFile = newName;
    this.saveNow();
    return true;
  }
  setActiveFile(name) {
    if (this.state.files[name] === undefined) return;
    this.state.activeFile = name;
    this.save();
  }
  setMainFile(name) {
    if (this.state.files[name] === undefined) return;
    this.state.mainFile = name;
    this.save();
  }
  /** 参与编译的所有源文件 */
  sourceFiles() {
    const out = {};
    for (const [n, c] of Object.entries(this.state.files)) {
      if (n.endsWith('.c') || n.endsWith('.h')) out[n] = c;
    }
    return out;
  }

  // ── 设置 ──
  get settings() { return this.state.settings; }
  setSetting(k, v) {
    this.state.settings[k] = v;
    this.save();
  }

  // ── 断点 ──
  breakpointsOf(file) {
    return this.state.breakpoints[file] || [];
  }
  allBreakpoints() {
    const out = [];
    for (const [f, lines] of Object.entries(this.state.breakpoints)) {
      for (const l of lines) out.push(`${f}:${l}`);
    }
    return out;
  }
  toggleBreakpoint(file, line) {
    const arr = this.state.breakpoints[file] || [];
    const i = arr.indexOf(line);
    if (i >= 0) arr.splice(i, 1);
    else arr.push(line);
    arr.sort((a, b) => a - b);
    if (arr.length) this.state.breakpoints[file] = arr;
    else delete this.state.breakpoints[file];
    this.save();
    return arr.includes(line);
  }
  clearBreakpoints() {
    this.state.breakpoints = {};
    this.save();
  }
}
