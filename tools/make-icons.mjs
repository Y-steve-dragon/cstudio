// 掌心 C · 图标生成（纯 JS 画图 + 手写 PNG 编码，不依赖任何第三方库）
// 用法：node tools/make-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

function encodePNG(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── 画布（带 4x4 超采样抗锯齿） ──
function render(size) {
  const S = 4;
  const W = size * S;
  const buf = Buffer.alloc(W * W * 4);
  const put = (x, y, r, g, b, a) => {
    if (a <= 0) return;
    const i = (y * W + x) * 4;
    const sa = a / 255;
    buf[i] = Math.round(buf[i] * (1 - sa) + r * sa);
    buf[i + 1] = Math.round(buf[i + 1] * (1 - sa) + g * sa);
    buf[i + 2] = Math.round(buf[i + 2] * (1 - sa) + b * sa);
    buf[i + 3] = Math.max(buf[i + 3], Math.round(255 * sa));
  };

  const radius = W * 0.235;
  const inRoundRect = (x, y) => {
    const x0 = W * 0.02, y0 = W * 0.02, x1 = W * 0.98, y1 = W * 0.98;
    const cx = Math.min(Math.max(x, x0 + radius), x1 - radius);
    const cy = Math.min(Math.max(y, y0 + radius), y1 - radius);
    const dx = x - cx, dy = y - cy;
    return dx * dx + dy * dy <= radius * radius;
  };

  // 背景：斜向渐变（深蓝 → 亮蓝）
  const c1 = [18, 40, 66], c2 = [53, 184, 255];
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      if (!inRoundRect(x, y)) continue;
      const t = (x / W) * 0.45 + (y / W) * 0.55;
      put(x, y, c1[0] + (c2[0] - c1[0]) * t, c1[1] + (c2[1] - c1[1]) * t, c1[2] + (c2[2] - c1[2]) * t, 255);
    }
  }

  // 一个白色「C」：圆环，右侧留缺口
  const cxc = W * 0.5, cyc = W * 0.5;
  const rOuter = W * 0.30;
  const rInner = W * 0.185;
  const gapStart = -0.30;  // 弧度
  const gapEnd = 0.30;
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const dx = x - cxc, dy = y - cyc;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > rOuter || d < rInner) continue;
      let ang = Math.atan2(dy, dx);
      if (ang >= gapStart && ang <= gapEnd) continue;
      put(x, y, 255, 255, 255, 255);
    }
  }

  // 缺口里的一个小方块（像编辑器光标）
  const bx0 = W * 0.66, bx1 = W * 0.735, by0 = W * 0.46, by1 = W * 0.545;
  for (let y = Math.floor(by0); y < by1; y++) {
    for (let x = Math.floor(bx0); x < bx1; x++) put(x, y, 255, 255, 255, 230);
  }

  // 下采样
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const i = ((y * S + sy) * W + (x * S + sx)) * 4;
          r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; a += buf[i + 3];
        }
      }
      const n = S * S;
      const o = (y * size + x) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = Math.round(a / n);
    }
  }
  return out;
}

const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#122842"/>
      <stop offset="1" stop-color="#35b8ff"/>
    </linearGradient>
  </defs>
  <rect x="10" y="10" width="492" height="492" rx="118" fill="url(#g)"/>
  <path d="M 360 194 A 118 118 0 1 0 360 318" fill="none" stroke="#fff" stroke-width="62" stroke-linecap="round"/>
  <rect x="338" y="236" width="40" height="40" rx="6" fill="#fff"/>
</svg>
`;

mkdirSync(join(root, 'icons'), { recursive: true });
for (const size of [192, 512]) {
  const png = encodePNG(size, size, render(size));
  writeFileSync(join(root, 'icons', `icon-${size}.png`), png);
  console.log(`icons/icon-${size}.png  ${(png.length / 1024).toFixed(1)} KB`);
}
writeFileSync(join(root, 'icons', 'icon.svg'), ICON_SVG);
console.log('icons/icon.svg');
