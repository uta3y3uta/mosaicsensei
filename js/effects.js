/* モザイク・ぼかしエフェクト集（30種） すべて端末内で処理 */
(function (global) {
  'use strict';

  const EFFECTS = [
    { id: 'square',    name: '四角',      cat: 'モザイク' },
    { id: 'circle',    name: '丸',        cat: 'モザイク' },
    { id: 'diamond',   name: 'ひし形',    cat: 'モザイク' },
    { id: 'hex',       name: '六角',      cat: 'モザイク' },
    { id: 'triangle',  name: '三角',      cat: 'モザイク' },
    { id: 'cross',     name: '十字',      cat: 'モザイク' },
    { id: 'star',      name: '星',        cat: 'モザイク' },
    { id: 'heart',     name: 'ハート',    cat: 'モザイク' },
    { id: 'hbar',      name: '横ライン',  cat: 'モザイク' },
    { id: 'vbar',      name: '縦ライン',  cat: 'モザイク' },
    { id: 'diag',      name: '斜め',      cat: 'モザイク' },
    { id: 'radial',    name: '放射',      cat: 'モザイク' },
    { id: 'ring',      name: '同心円',    cat: 'モザイク' },

    { id: 'gauss',     name: 'ぼかし',    cat: 'ぼかし' },
    { id: 'strong',    name: '強力',      cat: 'ぼかし' },
    { id: 'motionH',   name: '横流し',    cat: 'ぼかし' },
    { id: 'motionV',   name: '縦流し',    cat: 'ぼかし' },
    { id: 'zoom',      name: 'ズーム',    cat: 'ぼかし' },
    { id: 'spin',      name: '回転',      cat: 'ぼかし' },
    { id: 'swirl',     name: 'うずまき',  cat: 'ぼかし' },
    { id: 'frost',     name: 'すりガラス', cat: 'ぼかし' },
    { id: 'wave',      name: '波',        cat: 'ぼかし' },
    { id: 'pixelblur', name: 'やわらか',  cat: 'ぼかし' },

    { id: 'halftone',  name: '網点',      cat: 'とくしゅ' },
    { id: 'ascii',     name: '文字',      cat: 'とくしゅ' },
    { id: 'lowpoly',   name: 'ポリゴン',  cat: 'とくしゅ' },
    { id: 'noise',     name: 'ノイズ',    cat: 'とくしゅ' },
    { id: 'solid',     name: '単色',      cat: 'とくしゅ' },
    { id: 'black',     name: '黒ベタ',    cat: 'とくしゅ' },
    { id: 'white',     name: '白ベタ',    cat: 'とくしゅ' }
  ];

  function mk(w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, w | 0);
    c.height = Math.max(1, h | 0);
    return c;
  }
  function ctx2d(c) { return c.getContext('2d', { willReadFrequently: true }); }

  // 段階的に半分ずつ縮小して、確実に平均化された縮小画像をつくる
  function downscaleTo(src, tw, th) {
    tw = Math.max(1, tw | 0);
    th = Math.max(1, th | 0);
    let cur = src, cw = src.width, ch = src.height;
    while (cw > tw * 2 || ch > th * 2) {
      const nw = Math.max(tw, Math.round(cw / 2));
      const nh = Math.max(th, Math.round(ch / 2));
      const c = mk(nw, nh);
      c.getContext('2d').drawImage(cur, 0, 0, nw, nh);
      cur = c; cw = nw; ch = nh;
    }
    if (cw !== tw || ch !== th) {
      const c = mk(tw, th);
      c.getContext('2d').drawImage(cur, 0, 0, tw, th);
      cur = c;
    }
    return cur;
  }

  // 強さ(0-100) → セルサイズ。領域サイズに対する比率なので拡大縮小に依存しない
  function unit(w, h, s) {
    const m = Math.min(w, h);
    return Math.max(2, Math.round(m * (0.025 + (s / 100) * 0.30)));
  }
  function radiusOf(w, h, s) {
    const m = Math.min(w, h);
    return Math.max(1, Math.round(m * (0.012 + (s / 100) * 0.17)));
  }

  function cellData(canvas, w, h, cell) {
    const cols = Math.max(1, Math.round(w / cell));
    const rows = Math.max(1, Math.round(h / cell));
    const small = downscaleTo(canvas, cols, rows);
    const d = ctx2d(small).getImageData(0, 0, cols, rows).data;
    return { cols, rows, d, cw: w / cols, ch: h / rows, small };
  }

  function avgColor(canvas) {
    const one = downscaleTo(canvas, 1, 1);
    const d = ctx2d(one).getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2]];
  }
  const rgb = (r, g, b) => 'rgb(' + (r | 0) + ',' + (g | 0) + ',' + (b | 0) + ')';

  function pixelate(ctx, w, h, cell) {
    const cols = Math.max(1, Math.round(w / cell));
    const rows = Math.max(1, Math.round(h / cell));
    const small = downscaleTo(ctx.canvas, cols, rows);
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(small, 0, 0, cols, rows, 0, 0, w, h);
    ctx.restore();
  }

  /* ---------- ぼかし基礎 ---------- */
  function blurH(src, dst, w, h, r) {
    const win = r * 2 + 1;
    for (let y = 0; y < h; y++) {
      const row = y * w * 4;
      let sr = 0, sg = 0, sb = 0;
      for (let i = -r; i <= r; i++) {
        const o = row + Math.min(w - 1, Math.max(0, i)) * 4;
        sr += src[o]; sg += src[o + 1]; sb += src[o + 2];
      }
      for (let x = 0; x < w; x++) {
        const o = row + x * 4;
        dst[o] = sr / win; dst[o + 1] = sg / win; dst[o + 2] = sb / win; dst[o + 3] = 255;
        const a = row + Math.min(w - 1, x + r + 1) * 4;
        const b = row + Math.max(0, x - r) * 4;
        sr += src[a] - src[b]; sg += src[a + 1] - src[b + 1]; sb += src[a + 2] - src[b + 2];
      }
    }
  }
  function blurV(src, dst, w, h, r) {
    const win = r * 2 + 1, stride = w * 4;
    for (let x = 0; x < w; x++) {
      const col = x * 4;
      let sr = 0, sg = 0, sb = 0;
      for (let i = -r; i <= r; i++) {
        const o = col + Math.min(h - 1, Math.max(0, i)) * stride;
        sr += src[o]; sg += src[o + 1]; sb += src[o + 2];
      }
      for (let y = 0; y < h; y++) {
        const o = col + y * stride;
        dst[o] = sr / win; dst[o + 1] = sg / win; dst[o + 2] = sb / win; dst[o + 3] = 255;
        const a = col + Math.min(h - 1, y + r + 1) * stride;
        const b = col + Math.max(0, y - r) * stride;
        sr += src[a] - src[b]; sg += src[a + 1] - src[b + 1]; sb += src[a + 2] - src[b + 2];
      }
    }
  }
  function blur(ctx, w, h, rx, ry, passes) {
    // 半径が小数だと型付き配列の添字が壊れるので必ず整数にする
    rx = Math.round(rx); ry = Math.round(ry);
    if (rx < 1 && ry < 1) return;
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    const tmp = new Uint8ClampedArray(d.length);
    for (let p = 0; p < (passes || 3); p++) {
      if (rx >= 1) { blurH(d, tmp, w, h, rx); d.set(tmp); }
      if (ry >= 1) { blurV(d, tmp, w, h, ry); d.set(tmp); }
    }
    ctx.putImageData(img, 0, 0);
  }

  /* ---------- 図形描画 ---------- */
  function pDiamond(ctx, x, y, s) {
    const r = s / 2;
    ctx.beginPath();
    ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y);
    ctx.closePath(); ctx.fill();
  }
  function pHex(ctx, x, y, s) {
    const r = s / 2 * 1.12;
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = Math.PI / 180 * (60 * i - 30);
      const px = x + r * Math.cos(a), py = y + r * Math.sin(a);
      i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    }
    ctx.closePath(); ctx.fill();
  }
  function pTri(ctx, x, y, s, up) {
    const r = s / 2 * 1.15;
    ctx.beginPath();
    if (up) { ctx.moveTo(x, y - r); ctx.lineTo(x + r, y + r); ctx.lineTo(x - r, y + r); }
    else { ctx.moveTo(x, y + r); ctx.lineTo(x + r, y - r); ctx.lineTo(x - r, y - r); }
    ctx.closePath(); ctx.fill();
  }
  function pCross(ctx, x, y, s) {
    const a = s * 0.52, b = s * 0.18;
    ctx.fillRect(x - a, y - b, a * 2, b * 2);
    ctx.fillRect(x - b, y - a, b * 2, a * 2);
  }
  function pStar(ctx, x, y, s) {
    const R = s / 2 * 1.25, r = R * 0.45;
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const rad = i % 2 ? r : R;
      const a = Math.PI / 5 * i - Math.PI / 2;
      const px = x + rad * Math.cos(a), py = y + rad * Math.sin(a);
      i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    }
    ctx.closePath(); ctx.fill();
  }
  function pHeart(ctx, x, y, s) {
    const k = s / 2 * 1.2;
    ctx.beginPath();
    ctx.moveTo(x, y + k * 0.85);
    ctx.bezierCurveTo(x - k * 1.5, y - k * 0.2, x - k * 0.55, y - k * 1.15, x, y - k * 0.35);
    ctx.bezierCurveTo(x + k * 0.55, y - k * 1.15, x + k * 1.5, y - k * 0.2, x, y + k * 0.85);
    ctx.closePath(); ctx.fill();
  }

  function shapeMosaic(ctx, w, h, s, draw, bgMode) {
    const cell = unit(w, h, s);
    const c = cellData(ctx.canvas, w, h, cell);
    const g = avgColor(ctx.canvas);
    ctx.save();
    if (bgMode === 'white') ctx.fillStyle = '#fff';
    else if (bgMode === 'dark') ctx.fillStyle = rgb(g[0] * 0.35, g[1] * 0.35, g[2] * 0.35);
    else ctx.fillStyle = rgb(g[0], g[1], g[2]);
    ctx.fillRect(0, 0, w, h);
    for (let j = 0; j < c.rows; j++) {
      for (let i = 0; i < c.cols; i++) {
        const o = (j * c.cols + i) * 4;
        ctx.fillStyle = rgb(c.d[o], c.d[o + 1], c.d[o + 2]);
        draw(ctx, (i + 0.5) * c.cw, (j + 0.5) * c.ch, Math.max(c.cw, c.ch), i, j, c);
      }
    }
    ctx.restore();
  }

  /* ---------- 変位系ヘルパ ---------- */
  function displace(ctx, w, h, fn) {
    const img = ctx.getImageData(0, 0, w, h);
    const src = new Uint8ClampedArray(img.data);
    const d = img.data;
    const p = [0, 0];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        fn(x, y, p);
        const sx = Math.min(w - 1, Math.max(0, p[0] | 0));
        const sy = Math.min(h - 1, Math.max(0, p[1] | 0));
        const so = (sy * w + sx) * 4, o = (y * w + x) * 4;
        d[o] = src[so]; d[o + 1] = src[so + 1]; d[o + 2] = src[so + 2]; d[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  function sampleBlur(ctx, w, h, n, mapFn) {
    const img = ctx.getImageData(0, 0, w, h);
    const src = new Uint8ClampedArray(img.data);
    const d = img.data;
    const p = [0, 0];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let r = 0, g = 0, b = 0;
        for (let k = 0; k < n; k++) {
          mapFn(x, y, k / (n - 1), p);
          const sx = Math.min(w - 1, Math.max(0, p[0] | 0));
          const sy = Math.min(h - 1, Math.max(0, p[1] | 0));
          const so = (sy * w + sx) * 4;
          r += src[so]; g += src[so + 1]; b += src[so + 2];
        }
        const o = (y * w + x) * 4;
        d[o] = r / n; d[o + 1] = g / n; d[o + 2] = b / n; d[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  /* ---------- 各エフェクト ---------- */
  const R = {
    square(ctx, w, h, s) { pixelate(ctx, w, h, unit(w, h, s)); },

    circle(ctx, w, h, s) {
      shapeMosaic(ctx, w, h, s, (c, x, y, u) => {
        c.beginPath(); c.arc(x, y, u / 2 * 1.02, 0, 6.2832); c.fill();
      });
    },
    diamond(ctx, w, h, s) { shapeMosaic(ctx, w, h, s, (c, x, y, u) => pDiamond(c, x, y, u * 1.25)); },
    hex(ctx, w, h, s) {
      const cell = unit(w, h, s);
      const g = avgColor(ctx.canvas);
      const cols = Math.max(1, Math.round(w / cell)) + 1;
      const rows = Math.max(1, Math.round(h / (cell * 0.866))) + 1;
      const small = downscaleTo(ctx.canvas, cols, rows);
      const d = ctx2d(small).getImageData(0, 0, cols, rows).data;
      ctx.save();
      ctx.fillStyle = rgb(g[0], g[1], g[2]); ctx.fillRect(0, 0, w, h);
      const cw = w / (cols - 1 || 1), ch = h / (rows - 1 || 1);
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          const o = (j * cols + i) * 4;
          ctx.fillStyle = rgb(d[o], d[o + 1], d[o + 2]);
          pHex(ctx, (i + (j % 2 ? 0.5 : 0)) * cw, j * ch, Math.max(cw, ch) * 1.16);
        }
      }
      ctx.restore();
    },
    triangle(ctx, w, h, s) {
      shapeMosaic(ctx, w, h, s, (c, x, y, u, i, j) => pTri(c, x, y, u, (i + j) % 2 === 0));
    },
    cross(ctx, w, h, s) { shapeMosaic(ctx, w, h, s, (c, x, y, u) => pCross(c, x, y, u), 'dark'); },
    star(ctx, w, h, s) { shapeMosaic(ctx, w, h, s, (c, x, y, u) => pStar(c, x, y, u), 'dark'); },
    heart(ctx, w, h, s) { shapeMosaic(ctx, w, h, s, (c, x, y, u) => pHeart(c, x, y, u), 'dark'); },

    hbar(ctx, w, h, s) {
      const cell = unit(w, h, s);
      const rows = Math.max(1, Math.round(h / cell));
      const small = downscaleTo(ctx.canvas, 1, rows);
      ctx.save(); ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(small, 0, 0, 1, rows, 0, 0, w, h);
      ctx.restore();
    },
    vbar(ctx, w, h, s) {
      const cell = unit(w, h, s);
      const cols = Math.max(1, Math.round(w / cell));
      const small = downscaleTo(ctx.canvas, cols, 1);
      ctx.save(); ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(small, 0, 0, cols, 1, 0, 0, w, h);
      ctx.restore();
    },
    diag(ctx, w, h, s) {
      const ang = Math.PI / 6;
      const D = Math.ceil(Math.hypot(w, h)) + 2;
      const g = avgColor(ctx.canvas);
      const t = mk(D, D), tc = ctx2d(t);
      tc.fillStyle = rgb(g[0], g[1], g[2]); tc.fillRect(0, 0, D, D);
      tc.save(); tc.translate(D / 2, D / 2); tc.rotate(-ang);
      tc.drawImage(ctx.canvas, -w / 2, -h / 2); tc.restore();
      pixelate(tc, D, D, unit(w, h, s));
      ctx.save();
      ctx.clearRect(0, 0, w, h);
      ctx.translate(w / 2, h / 2); ctx.rotate(ang);
      ctx.drawImage(t, -D / 2, -D / 2);
      ctx.restore();
    },
    radial(ctx, w, h, s) {
      const cell = unit(w, h, s);
      const cx = w / 2, cy = h / 2, maxR = Math.hypot(w, h) / 2;
      const rb = Math.max(2, Math.round(maxR / cell));
      const ab = Math.max(6, Math.round((2 * Math.PI * maxR) / (cell * 1.6)));
      const img = ctx.getImageData(0, 0, w, h), d = img.data;
      const n = rb * ab;
      const acc = new Float64Array(n * 4);
      const idx = new Int32Array(w * h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const dx = x - cx, dy = y - cy;
          let ri = Math.min(rb - 1, (Math.hypot(dx, dy) / maxR * rb) | 0);
          let ai = ((Math.atan2(dy, dx) + Math.PI) / (2 * Math.PI) * ab) | 0;
          if (ai >= ab) ai = ab - 1;
          const k = ri * ab + ai, o = (y * w + x) * 4;
          idx[y * w + x] = k;
          acc[k * 4] += d[o]; acc[k * 4 + 1] += d[o + 1]; acc[k * 4 + 2] += d[o + 2]; acc[k * 4 + 3]++;
        }
      }
      for (let i = 0; i < w * h; i++) {
        const k = idx[i], c = acc[k * 4 + 3] || 1, o = i * 4;
        d[o] = acc[k * 4] / c; d[o + 1] = acc[k * 4 + 1] / c; d[o + 2] = acc[k * 4 + 2] / c; d[o + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
    },
    ring(ctx, w, h, s) {
      const cell = unit(w, h, s);
      const cx = w / 2, cy = h / 2, maxR = Math.hypot(w, h) / 2;
      const rb = Math.max(2, Math.round(maxR / cell));
      const img = ctx.getImageData(0, 0, w, h), d = img.data;
      const acc = new Float64Array(rb * 4);
      const idx = new Int32Array(w * h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const k = Math.min(rb - 1, (Math.hypot(x - cx, y - cy) / maxR * rb) | 0);
          const o = (y * w + x) * 4;
          idx[y * w + x] = k;
          acc[k * 4] += d[o]; acc[k * 4 + 1] += d[o + 1]; acc[k * 4 + 2] += d[o + 2]; acc[k * 4 + 3]++;
        }
      }
      for (let i = 0; i < w * h; i++) {
        const k = idx[i], c = acc[k * 4 + 3] || 1, o = i * 4;
        d[o] = acc[k * 4] / c; d[o + 1] = acc[k * 4 + 1] / c; d[o + 2] = acc[k * 4 + 2] / c; d[o + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
    },

    gauss(ctx, w, h, s) { const r = radiusOf(w, h, s); blur(ctx, w, h, r, r, 3); },
    strong(ctx, w, h, s) {
      pixelate(ctx, w, h, unit(w, h, s) * 0.9);
      const r = radiusOf(w, h, s);
      blur(ctx, w, h, r, r, 3);
    },
    motionH(ctx, w, h, s) { blur(ctx, w, h, Math.max(2, radiusOf(w, h, s) * 2.4), 0, 3); },
    motionV(ctx, w, h, s) { blur(ctx, w, h, 0, Math.max(2, radiusOf(w, h, s) * 2.4), 3); },
    zoom(ctx, w, h, s) {
      const cx = w / 2, cy = h / 2, k = 0.06 + (s / 100) * 0.55;
      sampleBlur(ctx, w, h, 14, (x, y, t, p) => {
        const f = 1 - k + t * k * 2;
        p[0] = cx + (x - cx) * f; p[1] = cy + (y - cy) * f;
      });
    },
    spin(ctx, w, h, s) {
      const cx = w / 2, cy = h / 2, A = 0.05 + (s / 100) * 0.75;
      sampleBlur(ctx, w, h, 14, (x, y, t, p) => {
        const a = -A + t * A * 2, c = Math.cos(a), sn = Math.sin(a);
        const dx = x - cx, dy = y - cy;
        p[0] = cx + dx * c - dy * sn; p[1] = cy + dx * sn + dy * c;
      });
    },
    swirl(ctx, w, h, s) {
      pixelate(ctx, w, h, Math.max(2, unit(w, h, s) * 0.55));
      const cx = w / 2, cy = h / 2, maxR = Math.hypot(w, h) / 2;
      const A = 1.2 + (s / 100) * 5;
      displace(ctx, w, h, (x, y, p) => {
        const dx = x - cx, dy = y - cy, r = Math.hypot(dx, dy);
        const a = Math.atan2(dy, dx) + A * (1 - r / maxR);
        p[0] = cx + r * Math.cos(a); p[1] = cy + r * Math.sin(a);
      });
    },
    frost(ctx, w, h, s) {
      const r = Math.max(2, radiusOf(w, h, s) * 1.6);
      displace(ctx, w, h, (x, y, p) => {
        p[0] = x + (Math.random() - 0.5) * r * 2;
        p[1] = y + (Math.random() - 0.5) * r * 2;
      });
      blur(ctx, w, h, 1, 1, 1);
    },
    wave(ctx, w, h, s) {
      pixelate(ctx, w, h, Math.max(2, unit(w, h, s) * 0.5));
      const A = Math.max(2, radiusOf(w, h, s) * 1.4);
      const L = Math.max(4, Math.min(w, h) / 6);
      displace(ctx, w, h, (x, y, p) => {
        p[0] = x + A * Math.sin(y / L * 6.283);
        p[1] = y + A * Math.sin(x / L * 6.283);
      });
      blur(ctx, w, h, 1, 1, 1);
    },
    pixelblur(ctx, w, h, s) {
      pixelate(ctx, w, h, unit(w, h, s));
      blur(ctx, w, h, Math.max(1, radiusOf(w, h, s) * 0.5), Math.max(1, radiusOf(w, h, s) * 0.5), 2);
    },

    halftone(ctx, w, h, s) {
      const cell = unit(w, h, s);
      const c = cellData(ctx.canvas, w, h, cell);
      ctx.save();
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
      const u = Math.max(c.cw, c.ch);
      for (let j = 0; j < c.rows; j++) {
        for (let i = 0; i < c.cols; i++) {
          const o = (j * c.cols + i) * 4;
          const r = c.d[o], g = c.d[o + 1], b = c.d[o + 2];
          const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
          const rad = u / 2 * Math.sqrt(Math.max(0, 1 - lum * 0.92)) * 1.28;
          ctx.fillStyle = rgb(r, g, b);
          ctx.beginPath(); ctx.arc((i + 0.5) * c.cw, (j + 0.5) * c.ch, rad, 0, 6.2832); ctx.fill();
        }
      }
      ctx.restore();
    },
    ascii(ctx, w, h, s) {
      const cell = Math.max(4, unit(w, h, s));
      const c = cellData(ctx.canvas, w, h, cell);
      const ramp = ' .,:;+*?%S#@';
      ctx.save();
      ctx.fillStyle = '#0d0d0d'; ctx.fillRect(0, 0, w, h);
      const u = Math.max(c.cw, c.ch);
      ctx.font = Math.round(u * 1.25) + 'px monospace';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      for (let j = 0; j < c.rows; j++) {
        for (let i = 0; i < c.cols; i++) {
          const o = (j * c.cols + i) * 4;
          const r = c.d[o], g = c.d[o + 1], b = c.d[o + 2];
          const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
          const ch = ramp[Math.min(ramp.length - 1, Math.round(lum * (ramp.length - 1)))];
          ctx.fillStyle = rgb(Math.min(255, r * 1.25), Math.min(255, g * 1.25), Math.min(255, b * 1.25));
          ctx.fillText(ch, (i + 0.5) * c.cw, (j + 0.5) * c.ch);
        }
      }
      ctx.restore();
    },
    lowpoly(ctx, w, h, s) {
      const cell = unit(w, h, s);
      const cols = Math.max(1, Math.round(w / cell));
      const rows = Math.max(1, Math.round(h / cell));
      const hi = downscaleTo(ctx.canvas, cols * 2, rows * 2);
      const d = ctx2d(hi).getImageData(0, 0, cols * 2, rows * 2).data;
      const cw = w / cols, chh = h / rows;
      const g = avgColor(ctx.canvas);
      ctx.save();
      ctx.fillStyle = rgb(g[0], g[1], g[2]); ctx.fillRect(0, 0, w, h);
      const at = (i, j) => { const o = (j * cols * 2 + i) * 4; return [d[o], d[o + 1], d[o + 2]]; };
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          const x0 = i * cw, y0 = j * chh, x1 = x0 + cw + 0.6, y1 = y0 + chh + 0.6;
          const a = at(i * 2, j * 2), b = at(i * 2 + 1, j * 2 + 1);
          ctx.fillStyle = rgb(a[0], a[1], a[2]);
          ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y0); ctx.lineTo(x0, y1); ctx.closePath(); ctx.fill();
          ctx.fillStyle = rgb(b[0], b[1], b[2]);
          ctx.beginPath(); ctx.moveTo(x1, y0); ctx.lineTo(x1, y1); ctx.lineTo(x0, y1); ctx.closePath(); ctx.fill();
        }
      }
      ctx.restore();
    },
    noise(ctx, w, h, s) {
      pixelate(ctx, w, h, Math.max(2, unit(w, h, s) * 0.7));
      const amt = 45 + (s / 100) * 120;
      const img = ctx.getImageData(0, 0, w, h), d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        const n = (Math.random() - 0.5) * amt;
        d[i] += n; d[i + 1] += n; d[i + 2] += n; d[i + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
    },
    solid(ctx, w, h) {
      const g = avgColor(ctx.canvas);
      ctx.save(); ctx.fillStyle = rgb(g[0], g[1], g[2]); ctx.fillRect(0, 0, w, h); ctx.restore();
    },
    black(ctx, w, h) { ctx.save(); ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h); ctx.restore(); },
    white(ctx, w, h) { ctx.save(); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); ctx.restore(); }
  };

  function apply(id, ctx, w, h, strength) {
    const fn = R[id] || R.square;
    fn(ctx, w, h, Math.max(0, Math.min(100, strength)));
  }

  global.MosaicEffects = { list: EFFECTS, apply: apply, byId: id => EFFECTS.find(e => e.id === id) };
})(window);
