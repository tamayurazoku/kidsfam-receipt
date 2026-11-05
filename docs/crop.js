/* 領収書の四隅の自動検出と、台形補正（まっすぐに切り抜き） */
(function (g) {
  'use strict';

  /** 画像（canvas）から紙の四隅を推定する。返り値は元画像座標の [左上, 右上, 右下, 左下] */
  function detectCorners(src) {
    const W = src.width, H = src.height;
    const scale = 360 / Math.max(W, H);
    const w = Math.max(1, Math.round(W * scale)), h = Math.max(1, Math.round(H * scale));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(src, 0, 0, w, h);
    const px = ctx.getImageData(0, 0, w, h).data;

    // 明るさ（紙は明るく、色味が少ない）
    const gray = new Float32Array(w * h);
    const hist = new Array(256).fill(0);
    for (let i = 0, j = 0; i < px.length; i += 4, j++) {
      const r = px[i], gg = px[i + 1], b = px[i + 2];
      const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b);
      const v = 0.299 * r + 0.587 * gg + 0.114 * b - 0.35 * (mx - mn); // 彩度の高い所（木目など）を暗く扱う
      const vv = Math.max(0, Math.min(255, Math.round(v)));
      gray[j] = vv; hist[vv]++;
    }
    const t = otsu(hist, w * h);
    const mask = new Uint8Array(w * h);
    for (let j = 0; j < gray.length; j++) mask[j] = gray[j] > t ? 1 : 0;
    // 小さな穴・ノイズをならす（文字や印鑑で穴が開くのを防ぐ）
    const closed = erode(dilate(mask, w, h, 2), w, h, 2);
    const opened = dilate(erode(closed, w, h, 2), w, h, 2);

    // 一番大きい明るい領域
    const label = new Int32Array(w * h).fill(-1);
    let best = null;
    const stack = [];
    for (let s = 0; s < opened.length; s++) {
      if (!opened[s] || label[s] !== -1) continue;
      const pts = [];
      label[s] = s; stack.push(s);
      while (stack.length) {
        const p = stack.pop(); pts.push(p);
        const x = p % w, y = (p / w) | 0;
        if (x > 0 && opened[p - 1] && label[p - 1] === -1) { label[p - 1] = s; stack.push(p - 1); }
        if (x < w - 1 && opened[p + 1] && label[p + 1] === -1) { label[p + 1] = s; stack.push(p + 1); }
        if (y > 0 && opened[p - w] && label[p - w] === -1) { label[p - w] = s; stack.push(p - w); }
        if (y < h - 1 && opened[p + w] && label[p + w] === -1) { label[p + w] = s; stack.push(p + w); }
      }
      if (!best || pts.length > best.length) best = pts;
    }
    const fallback = defaultCorners(W, H);
    if (!best || best.length < w * h * 0.08 || best.length > w * h * 0.985) return fallback;

    // 四隅 = x+y 最小/最大、x-y 最大/最小
    let tl = null, tr = null, br = null, bl = null;
    let sMin = Infinity, sMax = -Infinity, dMin = Infinity, dMax = -Infinity;
    for (const p of best) {
      const x = p % w, y = (p / w) | 0;
      const s = x + y, d = x - y;
      if (s < sMin) { sMin = s; tl = [x, y]; }
      if (s > sMax) { sMax = s; br = [x, y]; }
      if (d > dMax) { dMax = d; tr = [x, y]; }
      if (d < dMin) { dMin = d; bl = [x, y]; }
    }
    const quad = [tl, tr, br, bl].map(([x, y]) => [(x + 0.5) / scale, (y + 0.5) / scale]);
    if (polygonArea(quad) < W * H * 0.08) return fallback;
    return quad;
  }

  function defaultCorners(W, H) {
    const mx = W * 0.04, my = H * 0.04;
    return [[mx, my], [W - mx, my], [W - mx, H - my], [mx, H - my]];
  }

  function otsu(hist, total) {
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, best = 0, thr = 128;
    for (let i = 0; i < 256; i++) {
      wB += hist[i]; if (!wB) continue;
      const wF = total - wB; if (!wF) break;
      sumB += i * hist[i];
      const mB = sumB / wB, mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) { best = between; thr = i; }
    }
    return thr;
  }

  function dilate(m, w, h, r) { return morph(m, w, h, r, true); }
  function erode(m, w, h, r) { return morph(m, w, h, r, false); }
  function morph(m, w, h, r, isDilate) {
    // 分離可能な正方形カーネル（横→縦）
    const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let v = isDilate ? 0 : 1;
      for (let k = -r; k <= r; k++) {
        const xx = Math.min(w - 1, Math.max(0, x + k));
        const q = m[y * w + xx];
        if (isDilate ? q : !q) { v = isDilate ? 1 : 0; break; }
      }
      tmp[y * w + x] = v;
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let v = isDilate ? 0 : 1;
      for (let k = -r; k <= r; k++) {
        const yy = Math.min(h - 1, Math.max(0, y + k));
        const q = tmp[yy * w + x];
        if (isDilate ? q : !q) { v = isDilate ? 1 : 0; break; }
      }
      out[y * w + x] = v;
    }
    return out;
  }

  function polygonArea(p) {
    let a = 0;
    for (let i = 0; i < p.length; i++) { const [x1, y1] = p[i], [x2, y2] = p[(i + 1) % p.length]; a += x1 * y2 - x2 * y1; }
    return Math.abs(a) / 2;
  }

  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

  /** 出力の長方形 → 元画像の四角形 への射影変換行列を求める */
  function homography(dst, src) {
    // dst(u,v) -> src(x,y): x = (h0 u + h1 v + h2)/(h6 u + h7 v + 1)
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const [u, v] = dst[i], [x, y] = src[i];
      A.push([u, v, 1, 0, 0, 0, -u * x, -v * x]); b.push(x);
      A.push([0, 0, 0, u, v, 1, -u * y, -v * y]); b.push(y);
    }
    return solve(A, b).concat([1]);
  }

  function solve(A, b) {
    const n = b.length;
    const M = A.map((row, i) => row.concat([b[i]]));
    for (let c = 0; c < n; c++) {
      let piv = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
      [M[c], M[piv]] = [M[piv], M[c]];
      const d = M[c][c] || 1e-12;
      for (let k = c; k <= n; k++) M[c][k] /= d;
      for (let r = 0; r < n; r++) {
        if (r === c) continue;
        const f = M[r][c];
        if (f) for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
      }
    }
    return M.map((row) => row[n]);
  }

  /** 四隅 quad を長方形に補正して切り抜く（長辺 maxSide px） */
  function warp(src, quad, maxSide) {
    maxSide = maxSide || 1600;
    const [tl, tr, br, bl] = quad;
    let ow = Math.max(dist(tl, tr), dist(bl, br));
    let oh = Math.max(dist(tl, bl), dist(tr, br));
    const s = Math.min(1, maxSide / Math.max(ow, oh));
    ow = Math.max(1, Math.round(ow * s)); oh = Math.max(1, Math.round(oh * s));

    const sctx = src.getContext('2d', { willReadFrequently: true });
    const sw = src.width, sh = src.height;
    const sp = sctx.getImageData(0, 0, sw, sh).data;
    const out = document.createElement('canvas');
    out.width = ow; out.height = oh;
    const octx = out.getContext('2d');
    const od = octx.createImageData(ow, oh);
    const o = od.data;
    const H = homography([[0, 0], [ow, 0], [ow, oh], [0, oh]], quad);

    for (let v = 0; v < oh; v++) {
      for (let u = 0; u < ow; u++) {
        const uu = u + 0.5, vv = v + 0.5;
        const den = H[6] * uu + H[7] * vv + 1;
        let x = (H[0] * uu + H[1] * vv + H[2]) / den - 0.5;
        let y = (H[3] * uu + H[4] * vv + H[5]) / den - 0.5;
        if (x < 0) x = 0; if (y < 0) y = 0;
        if (x > sw - 1.001) x = sw - 1.001; if (y > sh - 1.001) y = sh - 1.001;
        const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0;
        const i00 = (y0 * sw + x0) * 4, i10 = i00 + 4, i01 = i00 + sw * 4, i11 = i01 + 4;
        const oi = (v * ow + u) * 4;
        for (let ch = 0; ch < 3; ch++) {
          const top = sp[i00 + ch] * (1 - fx) + sp[i10 + ch] * fx;
          const bot = sp[i01 + ch] * (1 - fx) + sp[i11 + ch] * fx;
          o[oi + ch] = top * (1 - fy) + bot * fy;
        }
        o[oi + 3] = 255;
      }
    }
    octx.putImageData(od, 0, 0);
    return out;
  }

  /** 画像を長辺 maxSide に縮小した canvas にする（回転 deg も可） */
  function toCanvas(img, maxSide, deg) {
    const iw = img.naturalWidth || img.videoWidth || img.width;
    const ih = img.naturalHeight || img.videoHeight || img.height;
    const s = Math.min(1, maxSide / Math.max(iw, ih));
    const w = Math.round(iw * s), h = Math.round(ih * s);
    const rot = ((deg || 0) % 360 + 360) % 360;
    const c = document.createElement('canvas');
    c.width = rot % 180 ? h : w; c.height = rot % 180 ? w : h;
    const ctx = c.getContext('2d');
    ctx.translate(c.width / 2, c.height / 2);
    ctx.rotate(rot * Math.PI / 180);
    ctx.drawImage(img, -w / 2, -h / 2, w, h);
    return c;
  }

  function rotateCanvas(c, deg) { return toCanvas(c, Math.max(c.width, c.height), deg); }

  g.Crop = { detectCorners, defaultCorners, warp, toCanvas, rotateCanvas };
})(window);
