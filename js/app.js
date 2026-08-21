/* 顔かくし — すべての処理は端末内で完結します */
(function () {
  'use strict';

  const MAX_SIDE = 4096;      // 作業用画像の最大辺
  const MAX_BACKING = 1800;   // 画面表示用キャンバスの最大ピクセル幅
  const $ = id => document.getElementById(id);

  const el = {
    stage: $('stage'), welcome: $('welcome'), editor: $('editor'),
    wrap: $('canvasWrap'), view: $('view'), overlay: $('overlay'),
    dropzone: $('dropzone'), file: $('fileInput'),
    panel: $('panel'), chkAuto: $('chkAuto'), autoSub: $('autoSub'),
    selSens: $('selSensitivity'), selPad: $('selPadding'), btnRedetect: $('btnRedetect'),
    textSub: $('textSub'), chkText: $('chkText'), selTextLevel: $('selTextLevel'),
    catTabs: $('catTabs'), fxStrip: $('effectStrip'),
    rngStrength: $('rngStrength'), outStrength: $('outStrength'),
    rngBrush: $('rngBrush'), outBrush: $('outBrush'), brushRow: $('brushRow'),
    selRow: $('selRow'), rngSize: $('rngSize'), outSize: $('outSize'),
    btnSelDelete: $('btnSelDelete'), btnSelDone: $('btnSelDone'),
    cropBar: $('cropBar'), btnCropApply: $('btnCropApply'), btnCropReset: $('btnCropReset'),
    btnUndo: $('btnUndo'), btnRedo: $('btnRedo'), btnSave: $('btnSave'), btnNew: $('btnNew'),
    btnClear: $('btnClear'), countLabel: $('countLabel'), targetHint: $('targetHint'),
    busy: $('busy'), busyText: $('busyText'), toast: $('toast'),
    modal: $('saveModal'), fmtSeg: $('fmtSeg'), fmtNote: $('fmtNote'),
    qualityRow: $('qualityRow'), rngQuality: $('rngQuality'), outQuality: $('outQuality'),
    saveInfo: $('saveInfo'), btnSaveDo: $('btnSaveDo'), btnSaveCancel: $('btnSaveCancel'),
    btnShare: $('btnShare'), zoomHint: $('zoomHint')
  };

  const vctx = el.view.getContext('2d', { willReadFrequently: true });
  const octx = el.overlay.getContext('2d');

  const S = {
    img: null, crop: null, regions: [], nextId: 1,
    autoMode: true, tool: 'rect', effect: 'square', strength: 45, brush: 40,
    selected: null, cat: 'モザイク',
    cropDraft: null, ratio: 'free',
    history: [], hi: -1,
    fmt: 'jpeg'
  };
  const V = { z: 1, tx: 0, ty: 0 };

  /* ================= utils ================= */
  const mk = (w, h) => { const c = document.createElement('canvas'); c.width = Math.max(1, w | 0); c.height = Math.max(1, h | 0); return c; };
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  let toastTimer;
  function toast(msg) {
    el.toast.textContent = msg; el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.toast.hidden = true; }, 2200);
  }
  function busy(text) { el.busyText.textContent = text || '処理中…'; el.busy.hidden = false; }
  function unbusy() { el.busy.hidden = true; }
  // タブが非表示のときrAFは発火しないので，タイマーで必ず先へ進める
  const nextFrame = () => new Promise(r => {
    let done = false;
    const go = () => { if (!done) { done = true; r(); } };
    requestAnimationFrame(() => requestAnimationFrame(go));
    setTimeout(go, 120);
  });

  /* ================= 画像読み込み ================= */
  async function decodeFile(file) {
    const name = (file.name || '').toLowerCase();
    const type = (file.type || '').toLowerCase();

    if (/\.tiff?$/.test(name) || type.indexOf('tiff') >= 0) {
      try { return decodeTiff(await file.arrayBuffer()); } catch (e) { /* 続行 */ }
    }
    try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (e) { }
    try { return await createImageBitmap(file); } catch (e) { }

    if (/hei[cf]/.test(type) || /\.(heic|heif)$/.test(name)) {
      const out = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.95 });
      const blob = Array.isArray(out) ? out[0] : out;
      try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }); }
      catch (e) { return await decodeViaImg(blob); }
    }
    return await decodeViaImg(file);
  }

  function decodeViaImg(blob) {
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(blob);
      const im = new Image();
      im.onload = () => { URL.revokeObjectURL(url); res(im); };
      im.onerror = () => { URL.revokeObjectURL(url); rej(new Error('decode failed')); };
      im.src = url;
    });
  }

  function decodeTiff(buf) {
    const ifds = UTIF.decode(buf);
    UTIF.decodeImage(buf, ifds[0], ifds);
    const rgba = UTIF.toRGBA8(ifds[0]);
    const w = ifds[0].width, h = ifds[0].height;
    const c = mk(w, h);
    c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba), w, h), 0, 0);
    return c;
  }

  async function openFile(file) {
    if (!file) return;
    busy('写真を読み込んでいます…');
    await nextFrame();
    let src;
    try { src = await decodeFile(file); }
    catch (e) {
      unbusy();
      toast('この形式の写真は開けませんでした');
      return;
    }
    const sw = src.width || src.naturalWidth, sh = src.height || src.naturalHeight;
    if (!sw || !sh) { unbusy(); toast('写真を読み込めませんでした'); return; }

    const k = Math.min(1, MAX_SIDE / Math.max(sw, sh));
    const w = Math.round(sw * k), h = Math.round(sh * k);
    const c = mk(w, h);
    c.getContext('2d').drawImage(src, 0, 0, w, h);
    if (src.close) src.close();

    S.img = c; S.crop = null; S.regions = []; S.nextId = 1; S.selected = null;
    S.tool = 'rect'; S.cropDraft = null;
    S.history = []; S.hi = -1;
    V.z = 1; V.tx = 0; V.ty = 0;

    el.welcome.hidden = true; el.editor.hidden = false;
    el.panel.hidden = false; el.btnSave.hidden = false; el.btnNew.hidden = false;

    syncTools(); layout(); render();
    buildThumbs();
    pushHistory();
    unbusy();

    if (S.autoMode) await detectFaces(true);
  }

  /* ================= 顔検出 ================= */
  let modelsReady = false;
  async function ensureModels() {
    if (modelsReady) return;
    busy('顔認識の準備をしています…（初回のみ）');
    await faceapi.nets.ssdMobilenetv1.loadFromUri('models');
    await faceapi.nets.tinyFaceDetector.loadFromUri('models');
    modelsReady = true;
  }

  function iou(a, b) {
    const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
    const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
    const i = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    return i / (a.w * a.h + b.w * b.h - i || 1);
  }

  async function detectFaces(silent) {
    if (!S.img) return;
    busy('顔をさがしています…');
    await nextFrame();
    let boxes = [];
    try {
      await ensureModels();
      busy('顔をさがしています…');
      await nextFrame();
      const conf = parseFloat(el.selSens.value);
      const collect = dets => {
        for (const d of dets) {
          const b = { x: d.box.x, y: d.box.y, w: d.box.width, h: d.box.height };
          if (!boxes.some(o => iou(o, b) > 0.3)) boxes.push(b);
        }
      };
      collect(await faceapi.detectAllFaces(S.img,
        new faceapi.SsdMobilenetv1Options({ minConfidence: conf, maxResults: 300 })));
      collect(await faceapi.detectAllFaces(S.img,
        new faceapi.TinyFaceDetectorOptions({ inputSize: 608, scoreThreshold: 0.5 })));
    } catch (e) {
      unbusy();
      toast('顔検出を読み込めませんでした。手動モードでお使いください');
      return;
    }

    const pad = parseFloat(el.selPad.value);
    let added = 0;
    for (const b of boxes) {
      const px = b.w * pad, py = b.h * pad;
      const r = {
        id: S.nextId++, shape: 'ellipse', auto: true, kind: 'face',
        x: clamp(b.x - px, 0, S.img.width),
        y: clamp(b.y - py * 1.25, 0, S.img.height),
        w: b.w + px * 2, h: b.h + py * 2.2,
        effect: S.effect, strength: S.strength
      };
      r.w = Math.min(r.w, S.img.width - r.x);
      r.h = Math.min(r.h, S.img.height - r.y);
      if (S.regions.some(o => iou(bbox(o), r) > 0.4)) continue;
      S.regions.push(r); added++;
    }
    const texts = await detectText();

    render(); pushHistory(); buildThumbs(); unbusy();
    if (added && texts) toast(added + '人の顔と，文字' + texts + 'か所をぼかしました');
    else if (added) toast(added + '人の顔をぼかしました');
    else if (texts) toast('文字' + texts + 'か所をぼかしました');
    else if (!silent) toast('顔が見つかりませんでした。手動で囲んでください');
    else toast('顔が見つかりません。手動で囲んでください');
  }

  /* 名札・ネームカード・掲示物など，文字が書かれた場所をさがす */
  async function detectText() {
    if (!S.img || !el.chkText.checked || !window.TextDetect) return 0;
    busy('名前や文字をさがしています…');
    await nextFrame();
    S.regions = S.regions.filter(r => r.kind !== 'text');
    if (S.selected && !getRegion(S.selected)) S.selected = null;
    let boxes;
    try {
      boxes = TextDetect.find(S.img, el.selTextLevel.value);
    } catch (e) {
      return 0;
    }
    let added = 0;
    for (const b of boxes) {
      const px = Math.max(3, b.w * 0.08), py = Math.max(3, b.h * 0.18);
      const r = {
        id: S.nextId++, shape: 'rect', auto: true, kind: 'text',
        x: clamp(b.x - px, 0, S.img.width),
        y: clamp(b.y - py, 0, S.img.height),
        w: b.w + px * 2, h: b.h + py * 2,
        effect: S.effect, strength: S.strength
      };
      r.w = Math.min(r.w, S.img.width - r.x);
      r.h = Math.min(r.h, S.img.height - r.y);
      if (S.regions.some(o => iou(bbox(o), r) > 0.35)) continue;
      S.regions.push(r); added++;
    }
    return added;
  }

  /* ================= 範囲 ================= */
  function bbox(r) {
    if (r.shape === 'brush') {
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      for (const p of r.pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
      return { x: x0 - r.r, y: y0 - r.r, w: (x1 - x0) + r.r * 2, h: (y1 - y0) + r.r * 2 };
    }
    return { x: Math.min(r.x, r.x + r.w), y: Math.min(r.y, r.y + r.h), w: Math.abs(r.w), h: Math.abs(r.h) };
  }
  function normalize(r) {
    if (r.shape === 'brush') return r;
    const b = bbox(r); r.x = b.x; r.y = b.y; r.w = b.w; r.h = b.h; return r;
  }
  const getRegion = id => S.regions.find(r => r.id === id);

  function cropRect() {
    if (!S.img) return { x: 0, y: 0, w: 1, h: 1 };
    if (S.tool === 'crop' || !S.crop) return { x: 0, y: 0, w: S.img.width, h: S.img.height };
    return S.crop;
  }

  /* ================= 描画 ================= */
  function layout() {
    if (!S.img) return;
    const cr = cropRect();
    const availW = Math.max(80, el.stage.clientWidth - 26);
    const availH = Math.max(80, el.stage.clientHeight - 26);
    const fit = Math.min(availW / cr.w, availH / cr.h);
    const cssW = Math.max(40, Math.round(cr.w * fit));
    const cssH = Math.max(40, Math.round(cr.h * fit));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const bw = Math.round(Math.min(cr.w, cssW * dpr, MAX_BACKING));
    const bh = Math.max(1, Math.round(bw * cr.h / cr.w));
    el.view.width = bw; el.view.height = bh;
    el.overlay.width = bw; el.overlay.height = bh;
    for (const c of [el.view, el.overlay]) { c.style.width = cssW + 'px'; c.style.height = cssH + 'px'; }
    el.wrap.style.width = cssW + 'px'; el.wrap.style.height = cssH + 'px';
    applyTransform();
  }

  function applyTransform() {
    el.wrap.style.transform = 'translate(' + V.tx + 'px,' + V.ty + 'px) scale(' + V.z + ')';
    el.zoomHint.hidden = V.z <= 1.01;
    if (!el.zoomHint.hidden) el.zoomHint.textContent = Math.round(V.z * 100) + '%（ダブルタップで戻る）';
  }

  const supportsFilter = typeof vctx.filter === 'string';

  function maskPath(ctx, r, k, cr, ox, oy) {
    ctx.fillStyle = '#fff'; ctx.strokeStyle = '#fff';
    const X = v => (v - cr.x) * k + ox, Y = v => (v - cr.y) * k + oy;
    if (r.shape === 'rect') {
      const b = bbox(r);
      ctx.fillRect(X(b.x), Y(b.y), b.w * k, b.h * k);
    } else if (r.shape === 'ellipse') {
      const b = bbox(r);
      ctx.beginPath();
      ctx.ellipse(X(b.x + b.w / 2), Y(b.y + b.h / 2), b.w * k / 2, b.h * k / 2, 0, 0, 6.2832);
      ctx.fill();
    } else {
      ctx.lineWidth = r.r * 2 * k; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath();
      r.pts.forEach((p, i) => i ? ctx.lineTo(X(p.x), Y(p.y)) : ctx.moveTo(X(p.x), Y(p.y)));
      if (r.pts.length === 1) { ctx.lineTo(X(r.pts[0].x) + 0.01, Y(r.pts[0].y)); }
      ctx.stroke();
    }
  }

  function paintRegion(ctx, r, k, cr) {
    const b = bbox(r);
    const pad = r.shape === 'brush' ? r.r : 0;
    const x0 = Math.floor((b.x - pad - cr.x) * k), y0 = Math.floor((b.y - pad - cr.y) * k);
    const x1 = Math.ceil((b.x + b.w + pad - cr.x) * k), y1 = Math.ceil((b.y + b.h + pad - cr.y) * k);
    const cx0 = clamp(x0, 0, ctx.canvas.width), cy0 = clamp(y0, 0, ctx.canvas.height);
    const cx1 = clamp(x1, 0, ctx.canvas.width), cy1 = clamp(y1, 0, ctx.canvas.height);
    const w = cx1 - cx0, h = cy1 - cy0;
    if (w < 2 || h < 2) return;

    const tmp = mk(w, h);
    const tc = tmp.getContext('2d', { willReadFrequently: true });
    tc.drawImage(ctx.canvas, cx0, cy0, w, h, 0, 0, w, h);
    MosaicEffects.apply(r.effect, tc, w, h, r.strength);

    tc.save();
    tc.globalCompositeOperation = 'destination-in';
    if (supportsFilter && r.shape !== 'rect') {
      tc.filter = 'blur(' + Math.max(1, Math.min(w, h) * 0.035).toFixed(1) + 'px)';
    }
    maskPath(tc, r, k, cr, -cx0, -cy0);
    tc.restore();

    ctx.drawImage(tmp, cx0, cy0);
  }

  function renderTo(ctx, cr) {
    const k = ctx.canvas.width / cr.w;
    ctx.save();
    ctx.imageSmoothingQuality = 'high';
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.drawImage(S.img, cr.x, cr.y, cr.w, cr.h, 0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.restore();
    for (const r of S.regions) paintRegion(ctx, r, k, cr);
  }

  let rafPending = false;
  function scheduleRender() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; render(); });
  }

  function render() {
    if (!S.img) return;
    const cr = cropRect();
    renderTo(vctx, cr);
    drawOverlay(cr);
    el.countLabel.textContent = 'かくし範囲：' + S.regions.length;
    el.targetHint.textContent = S.selected ? '選んだ範囲だけに適用' : '全体に適用';
    syncSelRow();
  }

  /* ---- 選んだ範囲の個別設定 ---- */
  let sizeBaseId = null, sizeBase = null;

  function captureSizeBase(r) {
    sizeBase = r.shape === 'brush'
      ? { r: r.r }
      : { w: Math.abs(r.w), h: Math.abs(r.h), cx: r.x + r.w / 2, cy: r.y + r.h / 2 };
    sizeBaseId = r.id;
    el.rngSize.value = 100; el.outSize.value = 100;
  }

  function syncSelRow() {
    const r = S.selected ? getRegion(S.selected) : null;
    el.selRow.hidden = !r || S.tool === 'crop';
    if (!r) { sizeBaseId = null; sizeBase = null; return; }
    if (sizeBaseId !== r.id) captureSizeBase(r);
  }

  el.rngSize.addEventListener('input', () => {
    const r = S.selected ? getRegion(S.selected) : null;
    if (!r || !sizeBase) return;
    const k = +el.rngSize.value / 100;
    el.outSize.value = el.rngSize.value;
    if (r.shape === 'brush') {
      r.r = Math.max(2, sizeBase.r * k);
    } else {
      r.w = Math.max(8, sizeBase.w * k);
      r.h = Math.max(8, sizeBase.h * k);
      r.x = sizeBase.cx - r.w / 2;
      r.y = sizeBase.cy - r.h / 2;
    }
    scheduleRender();
  });
  el.rngSize.addEventListener('change', () => { pushHistory(); buildThumbs(); });

  el.btnSelDelete.addEventListener('click', () => {
    if (!S.selected) return;
    S.regions = S.regions.filter(r => r.id !== S.selected);
    S.selected = null;
    render(); pushHistory(); buildThumbs();
  });
  el.btnSelDone.addEventListener('click', () => { S.selected = null; render(); buildThumbs(); });

  function drawOverlay(cr) {
    const k = el.overlay.width / cr.w;
    const W = el.overlay.width, H = el.overlay.height;
    const px = W / parseFloat(el.overlay.style.width || W); // 1CSSpxあたりのキャンバスpx
    octx.clearRect(0, 0, W, H);
    const X = v => (v - cr.x) * k, Y = v => (v - cr.y) * k;

    if (S.tool === 'crop' && S.cropDraft) {
      const d = S.cropDraft;
      octx.fillStyle = 'rgba(0,0,0,.62)';
      octx.fillRect(0, 0, W, H);
      octx.clearRect(X(d.x), Y(d.y), d.w * k, d.h * k);
      octx.save();
      octx.strokeStyle = '#fff'; octx.lineWidth = 1.5 * px;
      octx.strokeRect(X(d.x), Y(d.y), d.w * k, d.h * k);
      octx.globalAlpha = .45;
      octx.lineWidth = 1 * px;
      for (let i = 1; i < 3; i++) {
        octx.beginPath();
        octx.moveTo(X(d.x) + d.w * k * i / 3, Y(d.y)); octx.lineTo(X(d.x) + d.w * k * i / 3, Y(d.y) + d.h * k);
        octx.moveTo(X(d.x), Y(d.y) + d.h * k * i / 3); octx.lineTo(X(d.x) + d.w * k, Y(d.y) + d.h * k * i / 3);
        octx.stroke();
      }
      octx.restore();
      const hs = 9 * px;
      octx.fillStyle = '#fff';
      for (const c of corners({ x: X(d.x), y: Y(d.y), w: d.w * k, h: d.h * k })) {
        octx.fillRect(c.x - hs / 2, c.y - hs / 2, hs, hs);
      }
      return;
    }

    // 各範囲の枠
    for (const r of S.regions) {
      const b = bbox(r);
      const sel = r.id === S.selected;
      octx.save();
      octx.setLineDash(sel ? [] : [5 * px, 4 * px]);
      octx.lineWidth = (sel ? 2.2 : 1.3) * px;
      octx.strokeStyle = sel ? '#0095f6' : 'rgba(255,255,255,.55)';
      if (r.shape === 'ellipse') {
        octx.beginPath();
        octx.ellipse(X(b.x + b.w / 2), Y(b.y + b.h / 2), b.w * k / 2, b.h * k / 2, 0, 0, 6.2832);
        octx.stroke();
      } else if (r.shape === 'brush') {
        octx.strokeRect(X(b.x), Y(b.y), b.w * k, b.h * k);
      } else {
        octx.strokeRect(X(b.x), Y(b.y), b.w * k, b.h * k);
      }
      octx.restore();
      if (sel && r.shape !== 'brush') {
        const hs = 10 * px;
        octx.fillStyle = '#fff'; octx.strokeStyle = '#0095f6'; octx.lineWidth = 1.6 * px;
        for (const c of corners({ x: X(b.x), y: Y(b.y), w: b.w * k, h: b.h * k })) {
          octx.beginPath(); octx.arc(c.x, c.y, hs / 2, 0, 6.2832); octx.fill(); octx.stroke();
        }
      }
    }

    // 新規ドラッグ中のプレビュー
    if (drag && drag.mode === 'create' && drag.preview) {
      const p = drag.preview;
      octx.save();
      octx.setLineDash([6 * px, 4 * px]); octx.lineWidth = 1.8 * px; octx.strokeStyle = '#0095f6';
      if (S.tool === 'ellipse') {
        octx.beginPath();
        octx.ellipse(X(p.x + p.w / 2), Y(p.y + p.h / 2), Math.abs(p.w) * k / 2, Math.abs(p.h) * k / 2, 0, 0, 6.2832);
        octx.stroke();
      } else octx.strokeRect(X(p.x), Y(p.y), p.w * k, p.h * k);
      octx.restore();
    }
  }

  function corners(b) {
    return [
      { x: b.x, y: b.y, id: 'nw' }, { x: b.x + b.w / 2, y: b.y, id: 'n' }, { x: b.x + b.w, y: b.y, id: 'ne' },
      { x: b.x + b.w, y: b.y + b.h / 2, id: 'e' }, { x: b.x + b.w, y: b.y + b.h, id: 'se' },
      { x: b.x + b.w / 2, y: b.y + b.h, id: 's' }, { x: b.x, y: b.y + b.h, id: 'sw' },
      { x: b.x, y: b.y + b.h / 2, id: 'w' }
    ];
  }

  /* ================= 操作 ================= */
  function toImg(e) {
    const rect = el.overlay.getBoundingClientRect();
    const cr = cropRect();
    const fx = (e.clientX - rect.left) / rect.width;
    const fy = (e.clientY - rect.top) / rect.height;
    return { x: cr.x + fx * cr.w, y: cr.y + fy * cr.h };
  }
  function imgPerCss() {
    const rect = el.overlay.getBoundingClientRect();
    return cropRect().w / Math.max(1, rect.width);
  }

  function hitRegion(p) {
    for (let i = S.regions.length - 1; i >= 0; i--) {
      const r = S.regions[i], b = bbox(r);
      if (r.shape === 'ellipse') {
        const dx = (p.x - (b.x + b.w / 2)) / (b.w / 2), dy = (p.y - (b.y + b.h / 2)) / (b.h / 2);
        if (dx * dx + dy * dy <= 1.04) return r;
      } else if (p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) return r;
    }
    return null;
  }
  function hitHandle(p, b) {
    const tol = 13 * imgPerCss();
    for (const c of corners(b)) {
      if (Math.abs(p.x - c.x) <= tol && Math.abs(p.y - c.y) <= tol) return c.id;
    }
    return null;
  }

  let drag = null;
  const pointers = new Map();
  let pinch = null;

  el.overlay.addEventListener('pointerdown', onDown);
  el.overlay.addEventListener('pointermove', onMove);
  el.overlay.addEventListener('pointerup', onUp);
  el.overlay.addEventListener('pointercancel', onUp);

  function onDown(e) {
    if (!S.img) return;
    pointers.set(e.pointerId, e);
    if (pointers.size === 2) { startPinch(); drag = null; return; }
    if (pointers.size > 2) return;
    if (e.pointerType === 'mouse' && (e.button === 1 || e.shiftKey)) {
      drag = { mode: 'pan', sx: e.clientX, sy: e.clientY, tx: V.tx, ty: V.ty };
      el.overlay.setPointerCapture(e.pointerId);
      return;
    }
    el.overlay.setPointerCapture(e.pointerId);
    const p = toImg(e);

    if (S.tool === 'crop') { startCropDrag(p); return; }

    if (S.tool === 'erase') {
      const r = hitRegion(p);
      if (r) {
        S.regions = S.regions.filter(x => x !== r);
        if (S.selected === r.id) S.selected = null;
        render(); pushHistory();
      }
      drag = null;
      return;
    }

    if (S.tool === 'brush') {
      const r = {
        id: S.nextId++, shape: 'brush', auto: false, r: S.brush / 2 * imgPerCss(),
        pts: [p], effect: S.effect, strength: S.strength
      };
      S.regions.push(r);
      S.selected = null;
      drag = { mode: 'brush', region: r };
      scheduleRender();
      return;
    }

    // rect / ellipse
    const sel = S.selected ? getRegion(S.selected) : null;
    if (sel && sel.shape !== 'brush') {
      const h = hitHandle(p, bbox(sel));
      if (h) { drag = { mode: 'resize', region: sel, handle: h, start: bbox(sel) }; return; }
    }
    const hitR = hitRegion(p);
    if (hitR) {
      S.selected = hitR.id;
      syncEffectUI(hitR);
      drag = hitR.shape === 'brush'
        ? { mode: 'moveBrush', region: hitR, last: p }
        : { mode: 'move', region: hitR, dx: p.x - bbox(hitR).x, dy: p.y - bbox(hitR).y };
      render();
      return;
    }
    S.selected = null;
    drag = { mode: 'create', start: p, preview: { x: p.x, y: p.y, w: 0, h: 0 } };
    render();
  }

  function onMove(e) {
    if (!S.img) return;
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, e);
    if (pointers.size === 2 && pinch) { movePinch(); return; }
    if (!drag) return;

    if (drag.mode === 'pan') {
      V.tx = drag.tx + (e.clientX - drag.sx);
      V.ty = drag.ty + (e.clientY - drag.sy);
      applyTransform(); return;
    }
    const p = toImg(e);

    if (drag.mode === 'cropMove' || drag.mode === 'cropResize' || drag.mode === 'cropCreate') { moveCropDrag(p); return; }

    if (drag.mode === 'brush') {
      const pts = drag.region.pts, last = pts[pts.length - 1];
      const min = drag.region.r * 0.35;
      if (Math.hypot(p.x - last.x, p.y - last.y) > min) { pts.push(p); scheduleRender(); }
      return;
    }
    if (drag.mode === 'moveBrush') {
      const dx = p.x - drag.last.x, dy = p.y - drag.last.y;
      drag.region.pts.forEach(q => { q.x += dx; q.y += dy; });
      drag.last = p; scheduleRender(); return;
    }
    if (drag.mode === 'move') {
      const b = bbox(drag.region);
      drag.region.x = clamp(p.x - drag.dx, -b.w * 0.3, S.img.width - b.w * 0.7);
      drag.region.y = clamp(p.y - drag.dy, -b.h * 0.3, S.img.height - b.h * 0.7);
      drag.region.w = b.w; drag.region.h = b.h;
      scheduleRender(); return;
    }
    if (drag.mode === 'resize') {
      const s = drag.start, r = drag.region, h = drag.handle;
      let x0 = s.x, y0 = s.y, x1 = s.x + s.w, y1 = s.y + s.h;
      if (h.indexOf('w') >= 0) x0 = p.x;
      if (h.indexOf('e') >= 0) x1 = p.x;
      if (h.indexOf('n') >= 0) y0 = p.y;
      if (h.indexOf('s') >= 0) y1 = p.y;
      const min = 8 * imgPerCss();
      r.x = Math.min(x0, x1); r.y = Math.min(y0, y1);
      r.w = Math.max(min, Math.abs(x1 - x0)); r.h = Math.max(min, Math.abs(y1 - y0));
      scheduleRender(); return;
    }
    if (drag.mode === 'create') {
      const a = drag.start;
      drag.preview = { x: Math.min(a.x, p.x), y: Math.min(a.y, p.y), w: Math.abs(p.x - a.x), h: Math.abs(p.y - a.y) };
      scheduleRender(); return;
    }
  }

  function onUp(e) {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (!drag) return;
    const d = drag; drag = null;

    if (d.mode === 'create') {
      const p = d.preview;
      const min = 10 * imgPerCss();
      if (p.w > min && p.h > min) {
        const r = {
          id: S.nextId++, shape: S.tool === 'ellipse' ? 'ellipse' : 'rect', auto: false,
          x: p.x, y: p.y, w: p.w, h: p.h, effect: S.effect, strength: S.strength
        };
        S.regions.push(r); S.selected = r.id;
      }
      render(); pushHistory(); return;
    }
    if (d.mode === 'brush' && d.region.pts.length < 1) {
      S.regions = S.regions.filter(x => x !== d.region);
    }
    if (['brush', 'move', 'moveBrush', 'resize'].indexOf(d.mode) >= 0) {
      if (d.region && d.region.shape !== 'brush') normalize(d.region);
      if (d.region && d.region.id === S.selected) captureSizeBase(d.region);
      render(); pushHistory(); return;
    }
    if (d.mode.indexOf('crop') === 0) { render(); return; }
    render();
  }

  /* ---- ズーム ---- */
  function setZoom(z, ax, ay) {
    z = clamp(z, 1, 8);
    const r0 = el.wrap.getBoundingClientRect();
    const fx = (ax - r0.left) / r0.width, fy = (ay - r0.top) / r0.height;
    V.z = z; applyTransform();
    const r1 = el.wrap.getBoundingClientRect();
    V.tx += ax - (r1.left + fx * r1.width);
    V.ty += ay - (r1.top + fy * r1.height);
    if (V.z <= 1.001) { V.tx = 0; V.ty = 0; }
    applyTransform();
  }
  function startPinch() {
    const [a, b] = [...pointers.values()];
    pinch = { d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), z: V.z, mx: (a.clientX + b.clientX) / 2, my: (a.clientY + b.clientY) / 2, tx: V.tx, ty: V.ty };
  }
  function movePinch() {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    const mx = (a.clientX + b.clientX) / 2, my = (a.clientY + b.clientY) / 2;
    V.tx = pinch.tx + (mx - pinch.mx); V.ty = pinch.ty + (my - pinch.my);
    applyTransform();
    setZoom(pinch.z * (d / (pinch.d || 1)), mx, my);
  }
  el.stage.addEventListener('wheel', e => {
    if (!S.img) return;
    e.preventDefault();
    setZoom(V.z * (e.deltaY < 0 ? 1.12 : 1 / 1.12), e.clientX, e.clientY);
  }, { passive: false });

  let lastTap = 0;
  el.overlay.addEventListener('pointerup', e => {
    const now = Date.now();
    if (now - lastTap < 300 && pointers.size === 0) { V.z = 1; V.tx = 0; V.ty = 0; applyTransform(); }
    lastTap = now;
  });

  /* ================= 切り抜き ================= */
  function startCropDrag(p) {
    const d = S.cropDraft;
    const k = 1;
    const b = { x: d.x, y: d.y, w: d.w, h: d.h };
    const h = hitHandle(p, b);
    if (h) { drag = { mode: 'cropResize', handle: h, start: Object.assign({}, d) }; return; }
    if (p.x >= d.x && p.x <= d.x + d.w && p.y >= d.y && p.y <= d.y + d.h) {
      drag = { mode: 'cropMove', dx: p.x - d.x, dy: p.y - d.y }; return;
    }
    drag = { mode: 'cropCreate', start: p };
  }

  function moveCropDrag(p) {
    const W = S.img.width, H = S.img.height;
    const d = S.cropDraft;
    const ratio = S.ratio === 'free' ? null : parseFloat(S.ratio);
    if (drag.mode === 'cropMove') {
      d.x = clamp(p.x - drag.dx, 0, W - d.w);
      d.y = clamp(p.y - drag.dy, 0, H - d.h);
    } else if (drag.mode === 'cropResize') {
      const s = drag.start, h = drag.handle;
      let x0 = s.x, y0 = s.y, x1 = s.x + s.w, y1 = s.y + s.h;
      if (h.indexOf('w') >= 0) x0 = clamp(p.x, 0, x1 - 20);
      if (h.indexOf('e') >= 0) x1 = clamp(p.x, x0 + 20, W);
      if (h.indexOf('n') >= 0) y0 = clamp(p.y, 0, y1 - 20);
      if (h.indexOf('s') >= 0) y1 = clamp(p.y, y0 + 20, H);
      d.x = x0; d.y = y0; d.w = x1 - x0; d.h = y1 - y0;
      if (ratio) applyRatio(d, ratio, h);
    } else {
      const a = drag.start;
      d.x = clamp(Math.min(a.x, p.x), 0, W); d.y = clamp(Math.min(a.y, p.y), 0, H);
      d.w = Math.min(Math.abs(p.x - a.x), W - d.x); d.h = Math.min(Math.abs(p.y - a.y), H - d.y);
      if (ratio) applyRatio(d, ratio, 'se');
    }
    d.w = Math.max(20, Math.min(d.w, W - d.x));
    d.h = Math.max(20, Math.min(d.h, H - d.y));
    scheduleRender();
  }

  function applyRatio(d, ratio, handle) {
    const W = S.img.width, H = S.img.height;
    let w = d.w, h = w / ratio;
    if (h > H) { h = H; w = h * ratio; }
    if (handle.indexOf('n') >= 0) d.y = d.y + d.h - h;
    if (handle.indexOf('w') >= 0) d.x = d.x + d.w - w;
    d.w = w; d.h = h;
    d.x = clamp(d.x, 0, W - w); d.y = clamp(d.y, 0, H - h);
  }

  el.cropBar.querySelectorAll('.ratio').forEach(b => b.addEventListener('click', () => {
    el.cropBar.querySelectorAll('.ratio').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    S.ratio = b.dataset.ratio;
    if (S.ratio !== 'free' && S.cropDraft) { applyRatio(S.cropDraft, parseFloat(S.ratio), 'se'); render(); }
  }));

  el.btnCropApply.addEventListener('click', () => {
    const d = S.cropDraft;
    S.crop = { x: Math.round(d.x), y: Math.round(d.y), w: Math.round(d.w), h: Math.round(d.h) };
    setTool('rect'); pushHistory(); toast('切り抜きました');
  });
  el.btnCropReset.addEventListener('click', () => {
    S.crop = null;
    S.cropDraft = { x: 0, y: 0, w: S.img.width, h: S.img.height };
    render(); pushHistory();
  });

  /* ================= 履歴 ================= */
  function snapshot() {
    return JSON.stringify({ crop: S.crop, regions: S.regions, nextId: S.nextId });
  }
  function pushHistory() {
    const s = snapshot();
    if (S.hi >= 0 && S.history[S.hi] === s) return;
    S.history = S.history.slice(0, S.hi + 1);
    S.history.push(s);
    if (S.history.length > 60) S.history.shift();
    S.hi = S.history.length - 1;
    syncHistoryUI();
  }
  function restore(i) {
    const o = JSON.parse(S.history[i]);
    S.crop = o.crop; S.regions = o.regions; S.nextId = o.nextId;
    S.selected = null; S.hi = i;
    if (S.tool === 'crop') S.cropDraft = S.crop ? Object.assign({}, S.crop) : { x: 0, y: 0, w: S.img.width, h: S.img.height };
    layout(); render(); syncHistoryUI();
  }
  function syncHistoryUI() {
    el.btnUndo.disabled = S.hi <= 0;
    el.btnRedo.disabled = S.hi >= S.history.length - 1;
  }
  el.btnUndo.addEventListener('click', () => { if (S.hi > 0) restore(S.hi - 1); });
  el.btnRedo.addEventListener('click', () => { if (S.hi < S.history.length - 1) restore(S.hi + 1); });

  /* ================= UI ================= */
  function setTool(t) {
    S.tool = t;
    if (t === 'crop') {
      S.cropDraft = S.crop ? Object.assign({}, S.crop) : { x: 0, y: 0, w: S.img.width, h: S.img.height };
      S.selected = null;
    }
    syncTools(); layout(); render();
  }
  function syncTools() {
    document.querySelectorAll('.tool').forEach(b => b.classList.toggle('active', b.dataset.tool === S.tool));
    el.cropBar.hidden = S.tool !== 'crop';
    el.brushRow.hidden = S.tool !== 'brush';
  }
  document.querySelectorAll('.tool').forEach(b => b.addEventListener('click', () => setTool(b.dataset.tool)));

  function syncEffectUI(r) {
    S.effect = r.effect; S.strength = r.strength;
    el.rngStrength.value = r.strength; el.outStrength.value = r.strength;
    const e = MosaicEffects.byId(r.effect);
    if (e && e.cat !== S.cat) { S.cat = e.cat; buildCatTabs(); }
    buildThumbs();
  }

  function buildCatTabs() {
    const cats = [...new Set(MosaicEffects.list.map(e => e.cat))];
    el.catTabs.innerHTML = '';
    cats.forEach(c => {
      const b = document.createElement('button');
      b.className = 'cat-tab' + (c === S.cat ? ' active' : '');
      b.textContent = c;
      b.addEventListener('click', () => { S.cat = c; buildCatTabs(); buildThumbs(); });
      el.catTabs.appendChild(b);
    });
  }

  let thumbSrc = null;
  function makeThumbSource() {
    if (!S.img) return null;
    let sx, sy, sw;
    const target = S.selected ? getRegion(S.selected) : S.regions[0];
    if (target) {
      const b = bbox(target);
      sw = Math.max(24, Math.max(b.w, b.h));
      sx = b.x + b.w / 2 - sw / 2; sy = b.y + b.h / 2 - sw / 2;
    } else {
      sw = Math.min(S.img.width, S.img.height) * 0.42;
      sx = (S.img.width - sw) / 2; sy = (S.img.height - sw) / 2;
    }
    sx = clamp(sx, 0, S.img.width - 1); sy = clamp(sy, 0, S.img.height - 1);
    sw = Math.min(sw, S.img.width - sx, S.img.height - sy);
    const c = mk(64, 64);
    c.getContext('2d').drawImage(S.img, sx, sy, sw, sw, 0, 0, 64, 64);
    return c;
  }

  function buildThumbs() {
    if (!S.img) return;
    thumbSrc = makeThumbSource();
    el.fxStrip.innerHTML = '';
    MosaicEffects.list.filter(e => e.cat === S.cat).forEach(e => {
      const wrap = document.createElement('button');
      wrap.className = 'fx' + (e.id === S.effect ? ' active' : '');
      wrap.title = e.name;
      const c = mk(64, 64);
      const cc = c.getContext('2d', { willReadFrequently: true });
      cc.drawImage(thumbSrc, 0, 0);
      try { MosaicEffects.apply(e.id, cc, 64, 64, 55); } catch (err) { }
      const label = document.createElement('span');
      label.textContent = e.name;
      wrap.appendChild(c); wrap.appendChild(label);
      wrap.addEventListener('click', () => applyEffectChoice(e.id));
      el.fxStrip.appendChild(wrap);
    });
  }

  function applyEffectChoice(id) {
    S.effect = id;
    if (S.selected) {
      const r = getRegion(S.selected);
      if (r) r.effect = id;
    } else {
      S.regions.forEach(r => { r.effect = id; });
    }
    [...el.fxStrip.children].forEach((c, i) => {
      const e = MosaicEffects.list.filter(x => x.cat === S.cat)[i];
      c.classList.toggle('active', e && e.id === id);
    });
    render(); pushHistory();
  }

  el.rngStrength.addEventListener('input', () => {
    S.strength = +el.rngStrength.value;
    el.outStrength.value = S.strength;
    if (S.selected) { const r = getRegion(S.selected); if (r) r.strength = S.strength; }
    else S.regions.forEach(r => { r.strength = S.strength; });
    scheduleRender();
  });
  el.rngStrength.addEventListener('change', () => { pushHistory(); buildThumbs(); });

  el.rngBrush.addEventListener('input', () => { S.brush = +el.rngBrush.value; el.outBrush.value = S.brush; });

  el.chkAuto.addEventListener('change', async () => {
    S.autoMode = el.chkAuto.checked;
    el.autoSub.classList.toggle('off', !S.autoMode);
    el.textSub.classList.toggle('off', !S.autoMode);
    el.btnRedetect.disabled = !S.autoMode;
    if (S.autoMode && S.img) await detectFaces(false);
    else if (!S.autoMode) toast('手動モード：これまでの加工はそのまま編集できます');
  });
  el.btnRedetect.addEventListener('click', () => detectFaces(false));

  el.chkText.addEventListener('change', async () => {
    if (!S.img) return;
    if (el.chkText.checked) {
      const n = await detectText();
      render(); pushHistory(); buildThumbs(); unbusy();
      toast(n ? '文字' + n + 'か所をぼかしました' : '文字らしい場所は見つかりませんでした');
    } else {
      const before = S.regions.length;
      S.regions = S.regions.filter(r => r.kind !== 'text');
      if (S.selected && !getRegion(S.selected)) S.selected = null;
      render(); pushHistory(); buildThumbs();
      if (before !== S.regions.length) toast('文字のぼかしを外しました');
    }
  });
  el.selTextLevel.addEventListener('change', async () => {
    if (!S.img || !el.chkText.checked) return;
    const n = await detectText();
    render(); pushHistory(); buildThumbs(); unbusy();
    toast(n ? '文字' + n + 'か所をぼかしました' : '文字らしい場所は見つかりませんでした');
  });

  el.btnClear.addEventListener('click', () => {
    if (!S.regions.length) return;
    S.regions = []; S.selected = null; render(); pushHistory(); buildThumbs();
  });

  el.btnNew.addEventListener('click', () => el.file.click());

  /* ================= 入力 ================= */
  el.dropzone.addEventListener('click', () => el.file.click());
  el.dropzone.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') el.file.click(); });
  el.file.addEventListener('change', e => { if (e.target.files[0]) openFile(e.target.files[0]); el.file.value = ''; });
  ['dragenter', 'dragover'].forEach(t => document.addEventListener(t, e => {
    e.preventDefault(); el.dropzone.classList.add('over');
  }));
  ['dragleave', 'drop'].forEach(t => document.addEventListener(t, e => {
    e.preventDefault(); el.dropzone.classList.remove('over');
  }));
  document.addEventListener('drop', e => {
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) openFile(f);
  });
  document.addEventListener('paste', e => {
    const items = e.clipboardData && e.clipboardData.files;
    if (items && items[0]) openFile(items[0]);
  });

  document.addEventListener('keydown', e => {
    if (!S.img) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) { if (S.hi < S.history.length - 1) restore(S.hi + 1); }
      else if (S.hi > 0) restore(S.hi - 1);
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && S.selected) {
      S.regions = S.regions.filter(r => r.id !== S.selected);
      S.selected = null; render(); pushHistory();
    }
    if (e.key === 'Escape') { S.selected = null; render(); }
  });

  let rzTimer;
  window.addEventListener('resize', () => {
    clearTimeout(rzTimer);
    rzTimer = setTimeout(() => { if (S.img) { layout(); render(); } }, 120);
  });

  /* ================= 保存 ================= */
  el.btnSave.addEventListener('click', () => {
    const cr = S.crop || { x: 0, y: 0, w: S.img.width, h: S.img.height };
    el.saveInfo.innerHTML =
      '画像サイズ：' + Math.round(cr.w) + ' × ' + Math.round(cr.h) + ' px<br>' +
      'かくし範囲：' + S.regions.length + ' か所<br>' +
      '位置情報などのExifは保存時に消去されます。';
    el.btnShare.hidden = !(navigator.canShare && navigator.share);
    el.modal.hidden = false;
  });
  el.btnSaveCancel.addEventListener('click', () => { el.modal.hidden = true; });
  el.modal.addEventListener('click', e => { if (e.target === el.modal) el.modal.hidden = true; });

  el.fmtSeg.querySelectorAll('.seg-btn').forEach(b => b.addEventListener('click', () => {
    el.fmtSeg.querySelectorAll('.seg-btn').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    S.fmt = b.dataset.fmt;
    el.qualityRow.hidden = S.fmt !== 'jpeg';
    el.fmtNote.textContent = S.fmt === 'jpeg'
      ? '写真向き。ファイルが軽くなります。'
      : '文字や線がくっきり。ファイルは大きめです。';
  }));
  el.rngQuality.addEventListener('input', () => { el.outQuality.value = el.rngQuality.value; });

  function stamp() {
    const d = new Date(), p = n => String(n).padStart(2, '0');
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }

  async function exportBlob() {
    const cr = S.crop || { x: 0, y: 0, w: S.img.width, h: S.img.height };
    const out = mk(Math.round(cr.w), Math.round(cr.h));
    const oc = out.getContext('2d', { willReadFrequently: true });
    const keepTool = S.tool;
    S.tool = 'rect';
    renderTo(oc, cr);
    S.tool = keepTool;
    const type = S.fmt === 'png' ? 'image/png' : 'image/jpeg';
    const q = +el.rngQuality.value / 100;
    return await new Promise(res => out.toBlob(res, type, q));
  }

  el.btnSaveDo.addEventListener('click', async () => {
    el.modal.hidden = true;
    busy('保存用の画像をつくっています…');
    await nextFrame();
    try {
      const blob = await exportBlob();
      const name = 'kaokakushi_' + stamp() + (S.fmt === 'png' ? '.png' : '.jpg');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      unbusy(); toast('保存しました（' + name + '）');
    } catch (e) { unbusy(); toast('保存に失敗しました'); }
  });

  el.btnShare.addEventListener('click', async () => {
    el.modal.hidden = true;
    busy('画像を準備しています…');
    await nextFrame();
    try {
      const blob = await exportBlob();
      const name = 'kaokakushi_' + stamp() + (S.fmt === 'png' ? '.png' : '.jpg');
      const file = new File([blob], name, { type: blob.type });
      unbusy();
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: name });
      } else toast('この端末では共有できません');
    } catch (e) { unbusy(); }
  });

  /* ================= 初期化 ================= */
  buildCatTabs();
  el.outStrength.value = S.strength;
  el.outBrush.value = S.brush;
  el.outQuality.value = el.rngQuality.value;
  syncTools();
  window.addEventListener('beforeunload', e => {
    if (S.img && S.regions.length) { e.preventDefault(); e.returnValue = ''; }
  });
})();
