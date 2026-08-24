/* 「名前が書かれた札」をさがす。
   AIモデルを使わない古典的な画像処理なので，追加のダウンロードも通信も発生しない。

   ねらいは名札・ネームカードにしぼること。
   木の葉・砂利・れんが・服のしま模様・髪の毛といった細かい模様は，
   輪郭だけ見ると文字とよく似ている。そこで「文字らしさ」だけでなく
   「札らしさ」も確かめる。札には次の特徴がある。

     ・地の色が広くて，むらがない（紙やプレートだから）
     ・その上に，はっきり濃さのちがう印（＝文字）がのっている
     ・印は地に対して少数派である
     ・書いてあるのは名前なので，字数が少なく，細長くなりすぎない
     ・写真全体から見ると小さい

   これらを満たさないものは落とす。さらに最後に，
   画面のうちかくす割合に上限を設けて，
   なにかの拍子に画面全体がつぶれることがないようにしている。

   流れ：
     形態学的勾配 → Otsu二値化 → 縦横のクロージングで文字を行のかたまりにまとめる
     → 連結成分のうち「文字らしい形と密度」のものを残す
     → 同じ行・同じ列に並ぶものをつないで，苗字と名前が離れていても1つにする
     → 札のふちまで広げる
     → 「札らしさ」で確かめる（ここでほとんどの誤検出が落ちる）
     → 名前らしい順にならべ，決めた割合まで採る */
window.TextDetect = (function () {
  'use strict';

  const BASE = 1100;   // 基準の長辺
  const CAP = 2100;    // 解析に使う長辺の上限（メモリと速度のため）

  /* scales: 基準の何倍の解像度で走らせるか。大きいほど小さな文字が見つかる。
     trans: 走査線上で線が切り替わる回数の下限。文字は画数があるので大きい。
     grow: 名札のふちをさがしに，外へ何歩まで見にいくか（かたまりの短辺の倍率）。

     ここから下が「札らしさ」の関門。
     contrast: 地と印の明るさの差の下限。模様はここが小さい。
     paperFlat: 同じ色の地が最低これだけ広いこと。木の葉や砂利はここが小さい。
     inkLo/Hi: 印が占める割合。文字なら地のほうが多い。
     maxSide/maxArea: 写真に対する大きさの上限。
     maxCover: 画面のうちかくしてよい割合の合計。
     txCard: 札の中で線が切りかわる回数の下限。字は画数があるので大きく，
             水玉・粒・光の点は小さい。 */
  const LEVELS = {
    low: {
      fill: 0.30, minSide: 11, minPx: 8, rawLo: 0.045, rawHi: 0.74,
      elong: 1.05, trans: 2.1, scales: [1, 1.4], grow: 0.9,
      contrast: 62, paperFlat: 0.34, paperMin: 150, inkLo: 0.05, inkHi: 0.38,
      maxAspect: 6.0, maxSide: 0.26, maxArea: 0.030, maxCover: 0.12,
      txCard: 2.6
    },
    mid: {
      fill: 0.22, minSide: 8, minPx: 7, rawLo: 0.032, rawHi: 0.84,
      elong: 1.00, trans: 1.9, scales: [1, 1.4], grow: 0.9,
      contrast: 50, paperFlat: 0.26, paperMin: 135, inkLo: 0.04, inkHi: 0.44,
      maxAspect: 7.0, maxSide: 0.32, maxArea: 0.042, maxCover: 0.18,
      txCard: 2.1
    },
    /* 「強」は，小さい札・うすい札まで見つけるための段。
       ここで下げてよいのは「大きさ」と「濃さ」の下限だけで，
       「札らしさ」（地の平らさ・地と字の差・画数）まで下げてはいけない。
       そこを下げると，木の葉も服の模様も掲示物も札とみなしてしまい，
       写真ぜんたいがモザイクでうまる。
       だから，見つける細かさ（scales と minSide）だけを上げ，
       関門は「中」とほぼ同じに保つ。 */
    high: {
      fill: 0.19, minSide: 7, minPx: 6, rawLo: 0.028, rawHi: 0.86,
      elong: 1.00, trans: 1.8, scales: [1, 1.4, 1.9], grow: 0.9,
      contrast: 47, paperFlat: 0.25, paperMin: 130, inkLo: 0.04, inkHi: 0.46,
      maxAspect: 7.5, maxSide: 0.30, maxArea: 0.034, maxCover: 0.20,
      txCard: 2.0
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

  /* 文字のある行（縦書きなら列）だけを見て，線の切りかわり回数を測る。
     transitions() を四角ぜんぶに使うと，札の余白のぶんだけ数字が薄まって，
     一文字だけの名札が「画数が足りない」と誤って落ちてしまう。 */
  function strokeTx(raw, w, bx, by, bw, bh) {
    let rowSum = 0, rowN = 0, colSum = 0, colN = 0;
    for (let y = by; y < by + bh; y++) {
      const o = y * w;
      let n = 0, prev = 0;
      for (let x = bx; x < bx + bw; x++) {
        const v = raw[o + x];
        if (v && !prev) n++;
        prev = v;
      }
      if (n) { rowSum += n; rowN++; }
    }
    for (let x = bx; x < bx + bw; x++) {
      let n = 0, prev = 0;
      for (let y = by; y < by + bh; y++) {
        const v = raw[y * w + x];
        if (v && !prev) n++;
        prev = v;
      }
      if (n) { colSum += n; colN++; }
    }
    return Math.max(rowN ? rowSum / rowN : 0, colN ? colSum / colN : 0);
  }

  /* ---- 札らしさを確かめる ----
     切り出した四角の中を，明るさで「地」と「印」の2つに分ける。
     名札なら，地が広くてむらがなく，印ははっきり濃さがちがって少数派になる。
     木の葉・砂利・しま模様は，地と印の差が小さいか，地がざらついているので落ちる。

     戻り値は名前らしさの点数（大きいほど名前らしい）。0以下なら落とす。 */
  function cardScore(g, raw, w, h, bx, by, bw, bh, cfg) {
    const total = bw * bh;
    if (total < 16) return 0;

    // 中の明るさのヒストグラムから，地と印の境目を決める
    const hist = new Int32Array(256);
    for (let y = by; y < by + bh; y++) {
      const o = y * w;
      for (let x = bx; x < bx + bw; x++) hist[g[o + x]]++;
    }
    let sum = 0;
    for (let t = 0; t < 256; t++) sum += t * hist[t];
    let sumB = 0, wB = 0, best = 0, thr = 128;
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

    // 暗い側と明るい側の，数・平均・ちらばり
    let nD = 0, sD = 0, qD = 0, nL = 0, sL = 0, qL = 0;
    for (let t = 0; t <= thr; t++) { nD += hist[t]; sD += t * hist[t]; qD += t * t * hist[t]; }
    for (let t = thr + 1; t < 256; t++) { nL += hist[t]; sL += t * hist[t]; qL += t * t * hist[t]; }
    if (!nD || !nL) return 0;
    const mD = sD / nD, mL = sL / nL;
    const contrast = mL - mD;
    if (contrast < cfg.contrast) return 0;

    // 少ないほうが「印（文字）」，多いほうが「地（紙）」
    const inkDark = nD <= nL;
    const inkRatio = (inkDark ? nD : nL) / total;
    if (inkRatio < cfg.inkLo || inkRatio > cfg.inkHi) return 0;

    /* 名札は「明るい地に，暗い字」である。白い紙・白いプレートに黒で書く。
       この向きを決めておくと，水玉のシャツ・しま模様の服・木もれ日のように
       「暗い地に，明るい点」が並ぶものが，ここでまとめて落ちる。
       濃い色の札に白い字，というものは学校ではまず使わないので，
       取りこぼしよりも，画面がつぶれないことを選ぶ。 */
    if (!inkDark) return 0;
    if (mL < cfg.paperMin) return 0;

    /* 地が「一色」であることを確かめる。
       紙やプレートは，ほとんど同じ明るさの面が広がっている。
       木の葉・砂利・れんが・服のしまは，明るいほうの画素もばらばらの明るさをもつ。

       ここをちらばり（標準偏差や四分位範囲）で測ってはいけない。
       字のふちは，写真を小さくしたときに中間の色ににじむ。そのにじみも
       「地」の仲間に数えられるので，まっ白な紙でも数字が大きく出てしまう。
       そこで「散らばりの小ささ」ではなく「同じ色がどれだけ広いか」で測る。
       にじみは少数派なので，広さで測ればじゃまをしない。 */
    const nP = inkDark ? nL : nD;
    const lo = inkDark ? thr + 1 : 0;
    const hi = inkDark ? 255 : thr;
    let mode = lo, modeN = -1;
    for (let t = lo; t <= hi; t++) if (hist[t] > modeN) { modeN = hist[t]; mode = t; }
    let flatN = 0;
    for (let t = Math.max(0, mode - 8); t <= Math.min(255, mode + 8); t++) flatN += hist[t];
    const flat = flatN / total;
    if (flat < cfg.paperFlat) return 0;

    /* 印が「字」であることを確かめる。
       字は画数があるので，走査線の上で線が何度も切りかわる。
       水玉・粒・光のあたった点は，切りかわりがほとんどないのでここで落ちる。
       これがないと，服の模様や砂利までカードに見えてしまう。 */
    const tx = strokeTx(raw, w, bx, by, bw, bh);
    if (tx < cfg.txCard) return 0;

    /* 名前らしさ。地が一色で広く，はっきりしていて，字数が少ないほど高い。 */
    const aspect = bw > bh ? bw / bh : bh / bw;
    const clean = Math.min(1, flat / 0.5);
    const clear = Math.min(1, contrast / 120);
    const few = 1 - Math.min(1, (aspect - 1) / (cfg.maxAspect + 1));
    return (clean * 0.4 + clear * 0.3 + few * 0.3) * 100 * (nP / total);
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
          u.score = Math.max(a.score || 0, b.score || 0);
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
    let boxes = list.map(b => ({
      x: b.x, y: b.y, w: b.w, h: b.h,
      u: b.u || Math.min(b.w, b.h), score: b.score || 0
    }));
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

    /* 文字を1つのかたまりにまとめるために，となりあう線をつなぐ（クロージング）。
       つなぐ幅は2通り試す。
         広い幅：苗字と名前が離れていても1つにできる。
         せまい幅：小さな名札が，となりのしま模様の服や砂利とくっついてしまうのを防ぐ。
       広い幅だけだと，服の上の小さな名札が服ぜんぶと一体になり，
       「大きすぎる」として落ちてしまう。両方やって，あとで重なりをまとめる。 */
    const bin = new Uint8Array(n);
    const wide = [Math.max(3, Math.round(w / 90)), Math.max(3, Math.round(h / 90))];
    const fine = [Math.max(2, Math.round(w / 260)), Math.max(2, Math.round(h / 260))];

    /* つないだかたまりを，札として確かめて出すところまで。
       だいじなのは，つなぐ幅ごとに最後まで別々に進めること。
       とちゅうで一緒にすると，せまい幅でうまく取れた小さな名札が，
       広い幅で服ぜんぶをのみこんだ大きなかたまりと合体して，消えてしまう。 */
    const emit = (boxes) => {
      /* つないだかたまりと，つなぐ前の一つ一つの，両方を確かめる。
         つないだものだけを見ると，たまたま近くにあった別のもの
         （服のしま模様など）と一緒になった名札が，
         「札らしくない」として落ちてしまう。
         つなぐ前のものも見ておけば，その名札は単独で助かる。
         札でないものはどのみち下の関門で落ちるので，増やしても害はない。 */
      // 先に同じ行・列のものをつないでから，そのかたまりごとカードのふちまで広げる。
      // 順番が逆だと，苗字と名前が別々に広がってしまい，カード全体をおおえない。
      for (const r of mergeBoxes(boxes, w, h).concat(boxes)) {
        const e = expandToCard(raw, w, h,
          { minx: r.x, miny: r.y, maxx: r.x + r.w - 1, maxy: r.y + r.h - 1 }, cfg.grow);
        const bw2 = e.maxx - e.minx + 1, bh2 = e.maxy - e.miny + 1;

        /* 名前は，それほど細長くならない。
           広げたあとの四角ではなく，文字そのものの四角で見る。
           日本語は字と字がくっつくので，「長さ÷字の高さ」がおおよその字数になる。 */
        const aspect = r.w > r.h ? r.w / r.h : r.h / r.w;
        if (aspect > cfg.maxAspect) continue;

        /* 広げたあとの四角でも見ておく。
           長い文の一部分を切り取ると，それだけなら名前くらいの長さに見える。
           けれども，ふちをさがして広げていくと，となりの字までのみこんで
           細長くなる。名札なら，カードのふちで止まるので細長くならない。 */
        const eAspect = bw2 > bh2 ? bw2 / bh2 : bh2 / bw2;
        if (eAspect > cfg.maxAspect) continue;

        /* 札らしさは，文字のまわりを少しだけ広げたところで測る。
           広げきった四角で測ると，札の外の景色まで「地」に入ってしまい，
           まっ白な名札でも「むらがある」ことになってしまう。 */
        const q = Math.max(1, Math.round(r.u * 0.3));
        const sx = Math.max(0, r.x - q), sy = Math.max(0, r.y - q);
        const ex = Math.min(w - 1, r.x + r.w - 1 + q), ey = Math.min(h - 1, r.y + r.h - 1 + q);
        const score = cardScore(g, raw, w, h, sx, sy, ex - sx + 1, ey - sy + 1, cfg);
        if (score <= 0) continue;

        out.push({
          x: e.minx * scale, y: e.miny * scale,
          w: bw2 * scale, h: bh2 * scale,
          u: r.u * scale, score: score
        });
      }
    };

    for (const [kw, kh] of [wide, fine]) {
      const boxes = [];

      // 横書き：横方向クロージング
      morphH(raw, a, w, h, kw, true); morphH(a, bin, w, h, kw, false);
      morphV(bin, a, w, h, 1, true); morphV(a, bin, w, h, 1, false);
      components(bin, raw, w, h, cfg, boxes);

      // 縦書き：縦方向クロージング
      morphV(raw, a, w, h, kh, true); morphV(a, bin, w, h, kh, false);
      morphH(bin, a, w, h, 1, true); morphH(a, bin, w, h, 1, false);
      components(bin, raw, w, h, cfg, boxes);

      emit(boxes);
    }
  }

  /* ---- 最後の関門 ----
     名札は写真の中では小さい。大きすぎる四角は名札ではないので落とす。
     そのうえで名前らしい順に採っていき，画面のうちかくす割合が
     決めた上限に届いたらそこで打ち切る。
     こうしておけば，どんな写真でも画面全体がつぶれることはない。 */
  function limit(boxes, iw, ih, cfg) {
    const long = Math.max(iw, ih), area = iw * ih;
    const keep = boxes.filter(b =>
      Math.max(b.w, b.h) <= long * cfg.maxSide && b.w * b.h <= area * cfg.maxArea);
    keep.sort((a, b) => (b.score || 0) - (a.score || 0));

    // ざっくりした重なりつきの面積を測るための粗いマス目
    const gw = 160, gh = Math.max(1, Math.round(gw * ih / iw));
    const mask = new Uint8Array(gw * gh);
    const budget = gw * gh * cfg.maxCover;
    let used = 0;
    const out = [];
    for (const b of keep) {
      const x0 = Math.max(0, Math.floor(b.x / iw * gw));
      const y0 = Math.max(0, Math.floor(b.y / ih * gh));
      const x1 = Math.min(gw - 1, Math.ceil((b.x + b.w) / iw * gw) - 1);
      const y1 = Math.min(gh - 1, Math.ceil((b.y + b.h) / ih * gh) - 1);
      let add = 0;
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) if (!mask[y * gw + x]) add++;
      }
      if (used + add > budget && out.length) break;   // 予算ぎれ。ここまで
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) mask[y * gw + x] = 1;
      }
      used += add;
      out.push(b);
    }
    return out;
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
    /* 大きすぎるものは，つなぐ前に落としておく。
       あとで落とすのでは間にあわない。つなぐと，せっかくうまく取れた
       小さな名札が，となりの大きなはずれと合体して，一緒に消えてしまう。 */
    const area = src.width * src.height;
    const fit = out.filter(b =>
      Math.max(b.w, b.h) <= long * cfg.maxSide && b.w * b.h <= area * cfg.maxArea);
    const merged = mergeBoxes(fit, src.width, src.height);
    return limit(merged, src.width, src.height, cfg)
      .map(b => ({ x: b.x, y: b.y, w: b.w, h: b.h }));
  }

  return { find: find };
})();
