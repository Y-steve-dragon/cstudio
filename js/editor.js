// 掌心 C · 代码编辑器（textarea + 高亮层 + 行号槽，轻量、原生手感）
import { highlightC, countLines } from './highlight.js';

const OPENERS = { '(': ')', '[': ']', '{': '}' };
const PAIRS = new Set(['(', ')', '[', ']', '{', '}']);
const QUOTES = new Set(['"', "'"]);

export class CodeEditor {
  constructor(root, opts = {}) {
    this.root = root;
    this.opts = opts;
    this.onChange = opts.onChange || (() => {});
    this.breakpoints = new Set();
    this.pausedLine = 0;
    this.errorLine = 0;
    this.searchLine = 0;
    this._composing = false;
    this._raf = null;

    root.innerHTML = `
      <div class="ed-gutter" aria-hidden="true">
        <div class="ed-bp"></div>
        <div class="ed-lines"></div>
      </div>
      <div class="ed-body">
        <pre class="ed-hl" aria-hidden="true"><code></code></pre>
        <div class="ed-current" aria-hidden="true"></div>
        <textarea class="ed-ta" spellcheck="false" autocapitalize="off" autocomplete="off"
          autocorrect="off" autocapitalize="off" wrap="off" aria-label="代码编辑器"></textarea>
      </div>`;

    this.gutter = root.querySelector('.ed-gutter');
    this.bpCol = root.querySelector('.ed-bp');
    this.lines = root.querySelector('.ed-lines');
    this.body = root.querySelector('.ed-body');
    this.pre = root.querySelector('.ed-hl');
    this.code = this.pre.querySelector('code');
    this.curLineEl = root.querySelector('.ed-current');
    this.ta = root.querySelector('.ed-ta');

    this.ta.addEventListener('input', () => this._onInput());
    this.ta.addEventListener('scroll', () => this._syncScroll(), { passive: true });
    this.ta.addEventListener('keydown', (e) => this._onKeyDown(e));
    this.ta.addEventListener('beforeinput', (e) => this._onBeforeInput(e));
    this.ta.addEventListener('compositionstart', () => { this._composing = true; });
    this.ta.addEventListener('compositionend', () => { this._composing = false; this.refresh(); });
    this.ta.addEventListener('click', () => this._updateCurrentLine());
    this.ta.addEventListener('keyup', () => this._updateCurrentLine());
    this.bpCol.addEventListener('click', (e) => this._onGutterClick(e));
    this.lines.addEventListener('click', (e) => this._onGutterClick(e));

    this.applySettings(opts.settings || {});
  }

  // ── 内容读写 ──
  get value() { return this.ta.value; }
  setValue(v, { silent = true } = {}) {
    this.ta.value = v;
    this.refresh();
    if (!silent) this.onChange(v);
  }
  applySettings(s) {
    const st = this.root.style;
    if (s.fontSize) st.setProperty('--fs', `${s.fontSize}px`);
    if (s.tabSize) st.setProperty('--tab', String(s.tabSize));
    const fs = s.fontSize || 14;
    const lh = Math.round(fs * 1.55);
    st.setProperty('--lh', `${lh}px`);
    this.lineHeight = lh;
    this.tabSize = s.tabSize || 4;
    if (s.showGutter === false) this.root.classList.add('no-gutter');
    else this.root.classList.remove('no-gutter');
    this.root.classList.toggle('wrap', !!s.lineWrap);
    this.refresh();
  }

  focus() { this.ta.focus({ preventScroll: true }); }
  blur() { this.ta.blur(); }

  // ── 渲染 ──
  refresh() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = requestAnimationFrame(() => {
      this._raf = null;
      this._render();
    });
  }

  _render() {
    const src = this.ta.value;
    const html = highlightC(src);
    this.code.innerHTML = html.endsWith('\n') ? html + '\n' : html;
    if (!src) this.code.innerHTML = '\n';
    this._renderGutter(src);
    this._syncScroll();
    this._updateCurrentLine();
    if (this.searchLine) this._scrollLineIntoView(this.searchLine);
  }

  _renderGutter(src) {
    const n = countLines(src);
    const parts = [];
    for (let i = 1; i <= n; i++) {
      const cls = [
        'ln',
        this.breakpoints.has(i) ? 'has-bp' : '',
        this.pausedLine === i ? 'is-paused' : '',
        this.errorLine === i ? 'is-error' : '',
      ].filter(Boolean).join(' ');
      parts.push(`<div class="${cls}" data-line="${i}">${i}</div>`);
    }
    this.lines.innerHTML = parts.join('');
    const bps = [];
    for (let i = 1; i <= n; i++) {
      if (!this.breakpoints.has(i)) continue;
      const extra = this.pausedLine === i ? ' cur' : '';
      bps.push(`<div class="bp${extra}" data-line="${i}" style="top:${(i - 1) * this.lineHeight}px">●</div>`);
    }
    this.bpCol.innerHTML = bps.join('');
    this.lines.style.height = `${n * this.lineHeight}px`;
  }

  _syncScroll() {
    const x = this.ta.scrollLeft, y = this.ta.scrollTop;
    if (this.root.classList.contains('wrap')) {
      this.pre.style.transform = `translate(0px, ${-y}px)`;
    } else {
      this.pre.style.transform = `translate(${-x}px, ${-y}px)`;
    }
    this.lines.style.transform = `translateY(${-y}px)`;
    this.bpCol.style.transform = `translateY(${-y}px)`;
    this._positionCurrentLine(y);
  }

  _updateCurrentLine() {
    this._currentLine = this.caretLine();
    this._positionCurrentLine(this.ta.scrollTop);
  }

  _positionCurrentLine(scrollTop) {
    if (!this._currentLine) return;
    const top = (this._currentLine - 1) * this.lineHeight - scrollTop;
    this.curLineEl.style.transform = `translateY(${top}px)`;
    this.curLineEl.style.display = 'block';
  }

  caretLine(sel) {
    const pos = sel === undefined ? this.ta.selectionStart : sel;
    let line = 1;
    const v = this.ta.value;
    for (let i = 0; i < pos && i < v.length; i++) if (v[i] === '\n') line++;
    return line;
  }

  // ── 断点 / 暂停行 ──
  setBreakpoints(arr) {
    this.breakpoints = new Set(arr);
    this._render(this.ta.value);
  }
  setPausedLine(n) {
    this.pausedLine = n || 0;
    this._render(this.ta.value);
    if (n) this.gotoLine(n, { focus: false });
  }
  setErrorLine(n) {
    this.errorLine = n || 0;
    this._render(this.ta.value);
  }
  setSearchLine(n) {
    this.searchLine = n || 0;
    if (n) this._scrollLineIntoView(n);
  }

  _onGutterClick(e) {
    const el = e.target.closest('[data-line]');
    if (!el) return;
    const line = Number(el.dataset.line);
    const on = !this.breakpoints.has(line);
    if (on) this.breakpoints.add(line); else this.breakpoints.delete(line);
    this._render(this.ta.value);
    if (this.opts.onBreakpoint) this.opts.onBreakpoint(line, on);
  }

  // ── 定位 ──
  gotoLine(line, { focus = false, select = false } = {}) {
    const lines = this.ta.value.split('\n');
    line = Math.max(1, Math.min(line, lines.length));
    let pos = 0;
    for (let i = 0; i < line - 1; i++) pos += lines[i].length + 1;
    if (select) this.ta.setSelectionRange(pos, pos + lines[line - 1].length);
    else this.ta.setSelectionRange(pos, pos);
    this._scrollLineIntoView(line);
    this._updateCurrentLine();
    if (focus) this.focus();
  }

  _scrollLineIntoView(line) {
    const y = (line - 1) * this.lineHeight;
    const view = this.ta.clientHeight;
    if (y < this.ta.scrollTop + this.lineHeight || y > this.ta.scrollTop + view - this.lineHeight * 2) {
      this.ta.scrollTop = Math.max(0, y - view / 2);
    }
    this._syncScroll();
  }

  // ── 输入处理 ──
  _onInput() {
    if (this._composing) return;
    this.refresh();
    this.onChange(this.ta.value);
  }

  _onBeforeInput(e) {
    const s = this.opts.settings || {};
    if (s.lineWrap) { /* 换行仍按原样 */ }
    if (e.inputType === 'insertLineBreak' || (e.inputType === 'insertText' && e.data === '\n')) {
      if (s.autoIndent === false) return;
      e.preventDefault();
      this._insertNewlineWithIndent();
      return;
    }
    if (e.inputType === 'insertText' && e.data && e.data.length === 1) {
      const ch = e.data;
      if (s.autoClose !== false) {
        const handled = this._handleBracket(ch);
        if (handled) { e.preventDefault(); return; }
      }
    }
  }

  _lineStartOf(pos) {
    const v = this.ta.value;
    let i = pos;
    while (i > 0 && v[i - 1] !== '\n') i--;
    return i;
  }

  _currentIndent() {
    const v = this.ta.value;
    const start = this._lineStartOf(this.ta.selectionStart);
    let i = start;
    let indent = '';
    while (i < v.length && (v[i] === ' ' || v[i] === '\t')) { indent += v[i]; i++; }
    return indent;
  }

  _insertTextAtCaret(text, caretOffsetFromEnd = 0) {
    const ok = document.execCommand && document.execCommand('insertText', false, text);
    if (!ok) {
      const ta = this.ta;
      const s = ta.selectionStart, e = ta.selectionEnd;
      const v = ta.value;
      ta.value = v.slice(0, s) + text + v.slice(e);
      ta.setSelectionRange(s + text.length, s + text.length);
    }
    if (caretOffsetFromEnd) {
      const p = this.ta.selectionStart - caretOffsetFromEnd;
      this.ta.setSelectionRange(p, p);
    }
    this._onInput();
  }

  _insertNewlineWithIndent() {
    const v = this.ta.value;
    const pos = this.ta.selectionStart;
    let indent = this._currentIndent();
    let before = v.slice(0, pos);
    const trimmed = before.replace(/[ \t]+$/, '');
    const last = trimmed[trimmed.length - 1];
    const prevLineEndsOpen = last === '{' || last === '(' || last === '[' || last === ':' || last === ',';
    const rest = v.slice(pos);
    const unit = ' '.repeat(this.tabSize);
    let text = '\n' + indent + (prevLineEndsOpen ? unit : '');
    // 如果是 { 后面直接换行到了 }，把 } 缩进回去
    const nextChar = rest[0];
    if (prevLineEndsOpen && (last === '{' || last === '(') &&
        ((last === '{' && nextChar === '}') || (last === '(' && nextChar === ')'))) {
      text = '\n' + indent + unit + '\n' + indent;
      this._insertTextAtCaret(text, indent.length + 1);
      return;
    }
    this._insertTextAtCaret(text);
  }

  _handleBracket(ch) {
    const ta = this.ta;
    const s = ta.selectionStart, e = ta.selectionEnd;
    if (PAIRS.has(ch) && s !== e) {
      // 选中文本按 ( 包起来
      if (OPENERS[ch]) {
        const sel = ta.value.slice(s, e);
        const text = ch + sel + OPENERS[ch];
        const ok = document.execCommand && document.execCommand('insertText', false, text);
        if (!ok) return false;
        this.ta.setSelectionRange(s + 1, s + 1 + sel.length);
        this._onInput();
        return true;
      }
      return false;
    }
    if (QUOTES.has(ch)) {
      if (s !== e) {
        const sel = ta.value.slice(s, e);
        document.execCommand && document.execCommand('insertText', false, ch + sel + ch);
        this.ta.setSelectionRange(s + 1, s + 1 + sel.length);
        this._onInput();
        return true;
      }
      const next = ta.value[s];
      if (next === ch) {
        ta.setSelectionRange(s + 1, s + 1);
        return true;
      }
      const prev = ta.value[s - 1];
      if (prev && /[\w"'\\]/.test(prev)) return false;
      this._insertTextAtCaret(ch + ch, 1);
      return true;
    }
    if (OPENERS[ch]) {
      const next = ta.value[s];
      if (next === OPENERS[ch]) { return false; }
      this._insertTextAtCaret(ch + OPENERS[ch], 1);
      return true;
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      const next = ta.value[s];
      if (next === ch) { ta.setSelectionRange(s + 1, s + 1); return true; }
      return false;
    }
    return false;
  }

  _onKeyDown(e) {
    const ta = this.ta;
    if (e.key === 'Tab') {
      e.preventDefault();
      const s = ta.selectionStart, en = ta.selectionEnd;
      if (s === en) {
        this._insertTextAtCaret(' '.repeat(this.tabSize));
      } else {
        // 多行缩进
        const v = ta.value;
        const startLine = this._lineStartOf(s);
        let endPos = en;
        while (endPos > startLine && v[endPos - 1] !== '\n') {
          if (v[endPos] === '\n') break;
          endPos++;
        }
        const block = v.slice(startLine, en);
        const lines = block.split('\n');
        const add = ' '.repeat(this.tabSize);
        const newBlock = lines.map((l) => (e.shiftKey ? l.replace(/^ {1,4}/, '') : add + l)).join('\n');
        ta.setRangeText(newBlock, startLine, en, 'select');
        this._onInput();
      }
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === '/' || e.key === '?')) {
      e.preventDefault();
      this.toggleComment();
      return;
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (this.opts.onRunShortcut) this.opts.onRunShortcut();
      return;
    }
    // 退格：成对括号一起删
    if (e.key === 'Backspace' && this.opts.settings.autoClose !== false) {
      const s = ta.selectionStart;
      if (s === ta.selectionEnd && s > 0) {
        const a = ta.value[s - 1], b = ta.value[s];
        if ((OPENERS[a] && OPENERS[a] === b) || (QUOTES.has(a) && b === a)) {
          e.preventDefault();
          ta.setSelectionRange(s - 1, s + 1);
          document.execCommand && document.execCommand('delete');
          this._onInput();
        }
      }
    }
  }

  toggleComment() {
    const ta = this.ta;
    const v = ta.value;
    const s = ta.selectionStart, e = ta.selectionEnd;
    const startLine = this._lineStartOf(s);
    let end = e;
    if (end > startLine) {
      // 让选区覆盖到行尾
      while (end < v.length && v[end] !== '\n') end++;
    }
    const block = v.slice(startLine, end);
    const lines = block.split('\n');
    const allCommented = lines.every((l) => l.trim() === '' || /^\s*\/\//.test(l));
    const out = lines.map((l) => {
      if (l.trim() === '') return l;
      if (allCommented) return l.replace(/^(\s*)\/\/ ?/, '$1');
      const m = /^(\s*)/.exec(l);
      return m[1] + '// ' + l.slice(m[1].length);
    }).join('\n');
    ta.setRangeText(out, startLine, end, 'select');
    this._onInput();
  }

  insertText(t) {
    this.focus();
    this._insertTextAtCaret(t);
  }

  // ── 查找 ──
  findNext(needle, { backwards = false, from } = {}) {
    if (!needle) return false;
    const v = this.ta.value;
    let idx;
    if (from !== undefined) {
      idx = v.indexOf(needle, from);
    } else if (!backwards) {
      idx = v.indexOf(needle, this.ta.selectionEnd);
      if (idx < 0) idx = v.indexOf(needle, 0);
    } else {
      idx = v.lastIndexOf(needle, Math.max(0, this.ta.selectionStart - needle.length - 1));
      if (idx < 0) idx = v.lastIndexOf(needle);
    }
    if (idx < 0) return false;
    this.ta.setSelectionRange(idx, idx + needle.length);
    this._scrollLineIntoView(this.caretLine(idx));
    this._updateCurrentLine();
    return true;
  }

  replaceSelection(text) {
    const ta = this.ta;
    const s = ta.selectionStart, e = ta.selectionEnd;
    ta.setRangeText(text, s, e, 'end');
    this._onInput();
  }

  getSelection() {
    return { start: this.ta.selectionStart, end: this.ta.selectionEnd };
  }

  selectAll() { this.ta.select(); }

  destroy() {
    if (this._raf) cancelAnimationFrame(this._raf);
  }
}
