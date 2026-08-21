/* 文字が書かれた領域（名札・ネームカード・背景の掲示物など）をさがす。
   AIモデルを使わない古典的な画像処理なので，追加のダウンロードも通信も発生しない。
   形態学的勾配 → Otsu二値化 → 縦横のクロージングで文字を行のかたまりにまとめ，
   連結成分のうち「文字らしい形と密度」のものだけを残す。 */
window.TextDetect = (function () {
  'use strict';

  const WORK = 1100; // 解析に使う長辺（速度と精度の折り合い）

  const LEVELS = {
    low: { fill: 0.42, minSide: 18, rawLo: 0.08, rawHi: 0.62, elong: 1.50, trans: 3.2 },
    mid: { fill: 0.32, minSide: 14, rawLo: 0.05, rawHi: 0.70, elong: 1.20, trans: 2.5 },
    high: { fill: 0.24, minSide: 10, rawLo: 0.04, rawHi: 0.78, elong: 1.05, trans: 2.0 }
  };

  function toGray(src) {
    const s = Math.min(1, WORK / Math.max(src.width, src.height));
    const w = Math.max(1, Math.round(src.width * s));
    const h = Math.max(1, Math.round(src.height * s));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const cx = c.getContext('2d', { willReadFrequently: true });
    cx.imageSmoothingQuality = 'high';
    cx.drawImage(src, 0, 0, w, h);
    const d = cx.getImageData(0, 0, w, h).data;
    const g = new Uint8Array(w * h);
    for (let i = 0, p = 0; i < g.length; i++, p += 4) {
      g[i] = (d[p] * 77 + d[p + 1] * 150 + d[p + 2] * 29) >> 8;
    }
    return { g: g, w: w, h: h, scale: 1 / s };
  }

  /* 単調デックによる1次元の最大／最小フィルタ。窓の大きさによらずO(n)で走る。
     src と dst は別の配列であること。 */
  function morph1d(src, dst, len, count, stride, base, r, isMax) {
    const idx = new Int32Array(len);
    for (let k = 0; k < count; k++) {
      const o = k * base;
      let head = 0, tail = 0;
      for (let i = 0; i < len + r; i++) {
        if (i < len) {
          const v = src[o + i * stride];
          while (tail > head) {
            const u = src[o + idx[tail - 1] * stride];
            if (isMax ? u <= v : u >= v) tail--; else break;
          }
          idx[tail++] = i;
        }
        const p = i - r;
        if (p >= 0) {
          while (idx[head] < p - r) head++;
          dst[o + p * stride] = src[o + idx[head] * stride];
        }
      }
    }
  }

  const morphH = (src, dst, w, h, r, isMax) => morph1d(src, dst, w, h, 1, w, r, isMax);
  const morphV = (src, dst, w, h, r, isMax) => morph1d(src, dst, h, w, w, 1, r, isMax);

  function otsu(a) {
    const hist = new Int32Array(256);
    for (let i = 0; i < a.length; i++) hist[a[i]]++;
    const total = a.length;
    let sum = 0;
    for (let t = 0; t < 256; t++) sum += t * hist[t];
    let sumB = 0, wB = 0, best = 0, thr = 0;
    for (let t = 0; t < 256; t++) {
      wB += hist[t];
      if (!wB) continue;
      const wF = total - wB;
      if (!wF) break;
      sumB += t * hist[t];
      const mB = sumB / wB, mF = (sum - sumB) / wF;
      const v = wB * wF * (mB - mF) * (mB - mF);
      if (v > best) { best = v; thr = t; }
    }
    return thr;
  }

  /* 走査線上で線が切り替わる回数。文字は画数が多いので大きく，
     塗りつぶしの帯や1本線・枠は小さくなる。誤検出よけの決め手。 */
  function transitions(raw, w, minx, miny, maxx, maxy) {
    let rowSum = 0, colSum = 0;
    for (let y = miny; y <= maxy; y++) {
      const o = y * w;
      let prev = 0;
      for (let x = minx; x <= maxx; x++) {
        const v = raw[o + x];
        if (v && !prev) rowSum++;
        prev = v;
      }
    }
    for (let x = minx; x <= maxx; x++) {
      let prev = 0;
      for (let y = miny; y <= maxy; y++) {
        const v = raw[y * w + x];
        if (v && !prev) colSum++;
        prev = v;
      }
    }
    const rows = maxy - miny + 1, cols = maxx - minx + 1;
    return Math.max(rowSum / rows, colSum / cols);
  }

  /* 二値画像の連結成分（8近傍）から，文字らしいものの外接矩形を集める */
  function components(bin, raw, w, h, cfg, out) {
    const seen = new Uint8Array(w * h);
    const stack = new Int32Array(w * h);
    for (let start = 0; start < bin.length; start++) {
      if (!bin[start] || seen[start]) continue;
      let sp = 0;
      stack[sp++] = start;
      seen[start] = 1;
      let minx = 1e9, miny = 1e9, maxx = -1, maxy = -1, n = 0;
      while (sp) {
        const p = stack[--sp];
        const y = (p / w) | 0, x = p - y * w;
        n++;
        if (x < minx) minx = x;
        if (x > maxx) maxx = x;
        if (y < miny) miny = y;
        if (y > maxy) maxy = y;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= w) continue;
            const q = ny * w + nx;
            if (bin[q] && !seen[q]) { seen[q] = 1; stack[sp++] = q; }
          }
        }
      }
      const bw = maxx - minx + 1, bh = maxy - miny + 1;
      if (bw < cfg.minSide && bh < cfg.minSide) continue;
      if (bw < 8 || bh < 7) continue;
      if (bh > h * 0.45 || bw > w * 0.92) continue;
      if (n / (bw * bh) < cfg.fill) continue;
      const long = bw > bh ? bw / bh : bh / bw;
      if (long < cfg.elong) continue;
      // 元の（クロージング前の）エッジ密度。文字はほどよい密度になる
      let rawN = 0;
      for (let y = miny; y <= maxy; y++) {
        const o = y * w;
        for (let x = minx; x <= maxx; x++) if (raw[o + x]) rawN++;
      }
      const dens = rawN / (bw * bh);
      if (dens < cfg.rawLo || dens > cfg.rawHi) continue;
      if (transitions(raw, w, minx, miny, maxx, maxy) < cfg.trans) continue;
      out.push({ x: minx, y: miny, w: bw, h: bh });
    }
  }

  function overlaps(a, b) {
    const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
    const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
    const i = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    return i / Math.min(a.w * a.h, b.w * b.h);
  }

  function mergeBoxes(list) {
    let boxes = list.slice();
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          if (overlaps(boxes[i], boxes[j]) > 0.25) {
            const a = boxes[i], b = boxes[j];
            const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
            boxes[i] = {
              x: x, y: y,
              w: Math.max(a.x + a.w, b.x + b.w) - x,
              h: Math.max(a.y + a.h, b.y + b.h) - y
            };
            boxes.splice(j, 1);
            changed = true;
            j--;
          }
        }
      }
    }
    return boxes;
  }

  /* src: 画像やcanvas / level: 'low'|'mid'|'high'
     戻り値は src の座標系での矩形の配列 */
  function find(src, level) {
    const cfg = LEVELS[level] || LEVELS.mid;
    const { g, w, h, scale } = toGray(src);
    const n = w * h;
    const a = new Uint8Array(n), b = new Uint8Array(n), grad = new Uint8Array(n);

    morphH(g, a, w, h, 1, true); morphV(a, b, w, h, 1, true);   // 膨張
    morphH(g, a, w, h, 1, false); morphV(a, grad, w, h, 1, false); // 収縮
    for (let i = 0; i < n; i++) grad[i] = b[i] - grad[i];        // 形態学的勾配

    const thr = Math.max(14, otsu(grad));
    const raw = new Uint8Array(n);
    for (let i = 0; i < n; i++) raw[i] = grad[i] > thr ? 1 : 0;

    const kw = Math.max(3, Math.round(w / 90));  // 文字を横につなぐ幅
    const kh = Math.max(3, Math.round(h / 90));  // 縦書き用
    const boxes = [];
    const bin = new Uint8Array(n);

    // 横書き：横方向クロージング
    morphH(raw, a, w, h, kw, true); morphH(a, bin, w, h, kw, false);
    morphV(bin, a, w, h, 1, true); morphV(a, bin, w, h, 1, false);
    components(bin, raw, w, h, cfg, boxes);

    // 縦書き：縦方向クロージング
    morphV(raw, a, w, h, kh, true); morphV(a, bin, w, h, kh, false);
    morphH(bin, a, w, h, 1, true); morphH(a, bin, w, h, 1, false);
    components(bin, raw, w, h, cfg, boxes);

    return mergeBoxes(boxes).map(r => ({
      x: r.x * scale, y: r.y * scale, w: r.w * scale, h: r.h * scale
    }));
  }

  return { find: find };
})();
