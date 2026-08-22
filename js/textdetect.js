/* 文字が書かれた領域（名札・ネームカード・背景の掲示物など）をさがす。
   AIモデルを使わない古典的な画像処理なので，追加のダウンロードも通信も発生しない。

   流れ：
     形態学的勾配 → Otsu二値化 → 縦横のクロージングで文字を行のかたまりにまとめる
     → 連結成分のうち「文字らしい形と密度」のものを残す
     → 名札の余白と枠線まで広げる（カード全体をかくすため）
     → 同じ行・同じ列に並ぶものをつないで，苗字と名前が離れていても1つにする
   さらに複数の解像度で走らせるので，遠くの小さな名札や一文字だけの名札も拾える。 */
window.TextDetect = (function () {
  'use strict';

  const BASE = 1100;   // 基準の長辺
  const CAP = 2100;    // 解析に使う長辺の上限（メモリと速度のため）

  /* scales: 基準の何倍の解像度で走らせるか。大きいほど小さな文字が見つかる。
     trans: 走査線上で線が切り替わる回数の下限。文字は画数があるので大きい。
     grow: 名札のふちをさがしに，外へ何歩まで見にいくか（かたまりの短辺の倍率）。
           大きくしすぎると，となりの掲示物のふちまで飲みこんでしまう。 */
  const LEVELS = {
    low: {
      fill: 0.30, minSide: 11, minPx: 8, rawLo: 0.045, rawHi: 0.74,
      elong: 1.05, trans: 2.1, scales: [1], grow: 0.9
    },
    mid: {
      fill: 0.22, minSide: 8, minPx: 7, rawLo: 0.032, rawHi: 0.84,
      elong: 1.00, trans: 1.9, scales: [1, 1.4], grow: 0.9
    },
    high: {
      fill: 0.14, minSide: 6, minPx: 5, rawLo: 0.022, rawHi: 0.92,
      elong: 1.00, trans: 1.4, scales: [1, 1.4, 1.9], grow: 0.9
    }
  };

  function toGray(src, target) {
    const long = Math.max(src.width, src.height);
    const s = Math.min(target / long, 4);
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

  /* ---- 名札のふちまで広げる ----
     文字のまわりの余白をたどっていき，カードの枠線に当たったらそこで止める。
     名札やネームカードなら，カード全体がかくれることになる。 */
  function rowDens(raw, w, y, x0, x1) {
    let n = 0;
    const o = y * w;
    for (let x = x0; x <= x1; x++) if (raw[o + x]) n++;
    return n / (x1 - x0 + 1);
  }
  function colDens(raw, w, x, y0, y1) {
    let n = 0;
    for (let y = y0; y <= y1; y++) if (raw[y * w + x]) n++;
    return n / (y1 - y0 + 1);
  }
  /* dens(i) は i 歩ぶん外側の線の密度。画像の外なら -1 を返すこと。
     余白をたどって「ふち」に当たったらその位置を返す。
     ふちが見つからなければ 0（＝広げない）。
     見つからないのに広げると，背景のどこまでも伸びてしまう。 */
  function walkOut(dens, lim) {
    for (let i = 1; i <= lim; i++) {
      const d = dens(i);
      if (d < 0) break;
      if (d >= 0.28) return i;   // 枠線・カードのふちに当たった：その線ごと含める
    }
    return 0;
  }

  function expandToCard(raw, w, h, b, grow) {
    const bw = b.maxx - b.minx + 1, bh = b.maxy - b.miny + 1;
    const unit = Math.min(bw, bh);
    const lim = Math.max(2, Math.round(unit * grow));
    const pad = Math.max(1, Math.round(unit * 0.14));  // 文字ぎりぎりにしない
    const up = walkOut(i => (b.miny - i < 0 ? -1 : rowDens(raw, w, b.miny - i, b.minx, b.maxx)), lim);
    const dn = walkOut(i => (b.maxy + i >= h ? -1 : rowDens(raw, w, b.maxy + i, b.minx, b.maxx)), lim);
    const lf = walkOut(i => (b.minx - i < 0 ? -1 : colDens(raw, w, b.minx - i, b.miny, b.maxy)), lim);
    const rt = walkOut(i => (b.maxx + i >= w ? -1 : colDens(raw, w, b.maxx + i, b.miny, b.maxy)), lim);
    b.miny -= Math.max(up, pad); b.maxy += Math.max(dn, pad);
    b.minx -= Math.max(lf, pad); b.maxx += Math.max(rt, pad);
    b.miny = Math.max(0, b.miny); b.minx = Math.max(0, b.minx);
    b.maxy = Math.min(h - 1, b.maxy); b.maxx = Math.min(w - 1, b.maxx);
    return b;
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
      if (bw < cfg.minPx || bh < cfg.minPx) continue;
      if (bh > h * 0.5 || bw > w * 0.94) continue;
      if (n / (bw * bh) < cfg.fill) continue;
      if (cfg.elong > 1.001) {
        const long = bw > bh ? bw / bh : bh / bw;
        if (long < cfg.elong) continue;
      }
      // 元の（クロージング前の）エッジ密度。文字はほどよい密度になる
      let rawN = 0;
      for (let y = miny; y <= maxy; y++) {
        const o = y * w;
        for (let x = minx; x <= maxx; x++) if (raw[o + x]) rawN++;
      }
      const dens = rawN / (bw * bh);
      if (dens < cfg.rawLo || dens > cfg.rawHi) continue;
      if (transitions(raw, w, minx, miny, maxx, maxy) < cfg.trans) continue;

      // ここではまだ広げない。同じ行のものをつないでから，まとめてカードのふちまで広げる
      out.push({ x: minx, y: miny, w: bw, h: bh, u: Math.min(bw, bh) });
    }
  }

  function overlaps(a, b) {
    const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
    const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
    const i = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    return i / Math.min(a.w * a.h, b.w * b.h);
  }

  function union(a, b) {
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    return {
      x: x, y: y,
      w: Math.max(a.x + a.w, b.x + b.w) - x,
      h: Math.max(a.y + a.h, b.y + b.h) - y
    };
  }

  /* 苗字と名前が離れて書かれていても，同じ行（縦書きなら同じ列）に
     並んでいれば1つのかたまりとして扱う。
     すきまの許容は，つないだ結果の大きさではなく，
     もとの文字の大きさ（u）で決める。そうしないと，
     つなぐたびに許容が広がって画面全体に育ってしまう。 */
  function sameLine(a, b) {
    const lim = Math.max(Math.min(a.u, b.u) * 1.2, 6);
    const hr = a.h > b.h ? a.h / b.h : b.h / a.h;
    const wr = a.w > b.w ? a.w / b.w : b.w / a.w;

    const ovY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    if (hr <= 2.4 && ovY >= Math.min(a.h, b.h) * 0.55) {
      const gap = Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w);
      if (gap <= lim) return true;
    }
    const ovX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    if (wr <= 2.4 && ovX >= Math.min(a.w, b.w) * 0.55) {
      const gap = Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h);
      if (gap <= lim) return true;
    }
    return false;
  }

  const nearDup = (a, b) => overlaps(a, b) > 0.34;

  /* ok が真になる組をまとめていく。
     slack は「つないだ四角の面積 ÷ もとの2つの面積の和」の上限。
     離れたものどうしをつなぐと，すかすかの四角になるので弾ける。 */
  function combine(boxes, ok, maxW, maxH, slack) {
    let changed = true, guard = 0;
    while (changed && guard++ < 40) {
      changed = false;
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i], b = boxes[j];
          if (!ok(a, b)) continue;
          const u = union(a, b);
          const ua = u.w * u.h;
          const aa = a.w * a.h, ba = b.w * b.h;
          if (ua > (aa + ba) * slack) continue;
          // ほぼ同じ四角（別の解像度で見つけた同じもの）は，
          // 大きさの上限にかかわらず1つにまとめる
          const dup = ua <= Math.max(aa, ba) * 1.15;
          if (!dup && (u.w > maxW || u.h > maxH)) continue;
          u.u = Math.min(a.u, b.u);
          boxes[i] = u;
          boxes.splice(j, 1);
          changed = true;
          j--;
        }
      }
    }
    return boxes;
  }

  function mergeBoxes(list, w, h) {
    const maxW = w * 0.9, maxH = h * 0.5;
    let boxes = list.map(b => ({ x: b.x, y: b.y, w: b.w, h: b.h, u: b.u || Math.min(b.w, b.h) }));
    boxes = combine(boxes, nearDup, maxW, maxH, 3.0);   // 重なりの整理
    boxes = combine(boxes, sameLine, maxW, maxH, 2.2);  // 同じ行・列をつなぐ
    return boxes;
  }

  /* ひとつの解像度で解析する */
  function pass(src, target, cfg, out) {
    const { g, w, h, scale } = toGray(src, target);
    const n = w * h;
    const a = new Uint8Array(n), b = new Uint8Array(n), grad = new Uint8Array(n);

    morphH(g, a, w, h, 1, true); morphV(a, b, w, h, 1, true);   // 膨張
    morphH(g, a, w, h, 1, false); morphV(a, grad, w, h, 1, false); // 収縮
    for (let i = 0; i < n; i++) grad[i] = b[i] - grad[i];        // 形態学的勾配

    const thr = Math.max(12, otsu(grad));
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

    // 先に同じ行・列のものをつないでから，そのかたまりごとカードのふちまで広げる。
    // 順番が逆だと，苗字と名前が別々に広がってしまい，カード全体をおおえない。
    for (const r of mergeBoxes(boxes, w, h)) {
      const e = expandToCard(raw, w, h,
        { minx: r.x, miny: r.y, maxx: r.x + r.w - 1, maxy: r.y + r.h - 1 }, cfg.grow);
      out.push({
        x: e.minx * scale, y: e.miny * scale,
        w: (e.maxx - e.minx + 1) * scale, h: (e.maxy - e.miny + 1) * scale,
        u: r.u * scale
      });
    }
  }

  /* src: 画像やcanvas / level: 'low'|'mid'|'high'
     戻り値は src の座標系での矩形の配列 */
  function find(src, level) {
    const cfg = LEVELS[level] || LEVELS.mid;
    const long = Math.max(src.width, src.height);
    const out = [];
    let last = 0;
    for (const s of cfg.scales) {
      const target = Math.min(BASE * s, CAP, Math.max(long, BASE));
      if (target <= last * 1.08) continue;   // ほぼ同じ解像度なら省く
      last = target;
      pass(src, target, cfg, out);
    }
    return mergeBoxes(out, src.width, src.height)
      .map(b => ({ x: b.x, y: b.y, w: b.w, h: b.h }));
  }

  return { find: find };
})();
