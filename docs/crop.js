/* 領収書の四隅の自動検出と、台形補正（まっすぐに切り抜き） */
(function (g) {
  'use strict';

  /**
   * 画像（canvas）から紙の四隅を推定する。返り値は元画像座標の [左上, 右上, 右下, 左下]
   * いくつかの明るさの基準で「紙らしい領域」を作り、四角形にいちばんきれいに収まるもの（光の反射などを含まないもの）を選ぶ
   */
  function detectCorners(src) {
    const W = src.width, H = src.height;
    const res = analyze(src);
    if (!res) return defaultCorners(W, H);
    return res.map(([x, y]) => [Math.max(0, Math.min(W, x)), Math.max(0, Math.min(H, y))]);
  }

  function analyze(src) {
    const W = src.width, H = src.height;
    const scale = 360 / Math.max(W, H);
    const w = Math.max(1, Math.round(W * scale)), h = Math.max(1, Math.round(H * scale));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(src, 0, 0, w, h);
    const px = ctx.getImageData(0, 0, w, h).data;
    const N = w * h;

    // 明るさ（紙は明るく、色味が少ない）
    const gray = new Uint8Array(N);
    const hist = new Array(256).fill(0);
    for (let i = 0, j = 0; i < px.length; i += 4, j++) {
      const r = px[i], gg = px[i + 1], b = px[i + 2];
      const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b);
      const v = 0.299 * r + 0.587 * gg + 0.114 * b - 0.35 * (mx - mn);
      const vv = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
      gray[j] = vv; hist[vv]++;
    }
    const t0 = otsu(hist, N);
    // 明るい方から3%の明るさ（＝紙の明るさの目安）
    let acc = 0, p97 = 255;
    for (let i = 255; i >= 0; i--) { acc += hist[i]; if (acc >= N * 0.03) { p97 = i; break; } }

    const imgArea = N;
    const cands = [];
    const levels = [0, 0.3, 0.55];
    for (const lv of levels) {
      const t = t0 + (p97 - t0) * lv;
      const mask = new Uint8Array(N);
      for (let j = 0; j < N; j++) mask[j] = gray[j] > t ? 1 : 0;
      const closed = erode(dilate(mask, w, h, 2), w, h, 2);    // 文字・印鑑の穴を埋める
      const base = dilate(erode(closed, w, h, 2), w, h, 2);    // 小さなノイズを消す
      collect(base, 0);
      if (!lv) collect(erode(base, w, h, 5), 5);               // 細くつながった反射を切り離す
    }

    function collect(m, grow) {
      const comps = components(m, w, h, 2);
      for (const pts of comps) {
        const q = extremes(pts, w, grow);
        const qa = polygonArea(q);
        if (qa < imgArea * 0.06 || qa > imgArea * 0.97) continue;
        const area = pts.length + (grow ? perimeterGrow(q, grow) : 0);
        const fill = Math.min(1, area / qa);
        if (!isConvex(q)) continue;
        // 画像のふちに角がある四角形は、光の反射や机の明るい部分を含んでいることが多いので少し減点
        const edge = Math.max(w, h) * 0.015;
        const touches = q.filter(([x, y]) => x <= edge || y <= edge || x >= w - 1 - edge || y >= h - 1 - edge).length;
        cands.push({ q, fill, area: qa, score: fill - 0.06 * touches });
      }
    }

    // まっすぐな線（紙のふち）から四角形を探す方法の候補も加え、線のつながり具合で最終判断する
    const lineQuads = edgeQuads(gray, w, h);
    const scored = [];
    cands.forEach((c) => scored.push({ q: c.q, s: quadScore(c.q, gray, w, h, c.score) }));
    lineQuads.forEach((q) => scored.push({ q, s: quadScore(q, gray, w, h, 0.9) }));
    if (typeof window !== 'undefined' && window.__cropDebug2) window.__cropDebug2(scored);
    if (scored.length) {
      scored.sort((a, b) => b.s - a.s);
      return scored[0].q.map(([x, y]) => [(x + 0.5) / scale, (y + 0.5) / scale]);
    }
    if (!cands.length) return null;
    // 四角形への収まり（fill）が良いものの中から、いちばん大きいものを選ぶ
    if (typeof window !== 'undefined' && window.__cropDebug) window.__cropDebug(cands);
    const bestScore = Math.max.apply(null, cands.map((x) => x.score));
    const good = cands.filter((x) => x.score >= bestScore - 0.025 && x.fill >= 0.8);
    const pick = (good.length ? good : cands).sort((a, b) => b.area - a.area)[0];
    return pick.q.map(([x, y]) => [(x + 0.5) / scale, (y + 0.5) / scale]);
  }

  /* ---------- まっすぐな線から四角形を探す ---------- */
  let edgeCache = null;
  function gradients(gray, w, h) {
    const N = w * h;
    const g = new Float32Array(N);
    // 3x3 ぼかし
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      g[i] = (gray[i - w - 1] + gray[i - w] + gray[i - w + 1] + gray[i - 1] + gray[i] + gray[i + 1] + gray[i + w - 1] + gray[i + w] + gray[i + w + 1]) / 9;
    }
    const mag = new Float32Array(N), ang = new Float32Array(N);
    for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++) {
      const i = y * w + x;
      const gx = (g[i - w + 1] + 2 * g[i + 1] + g[i + w + 1]) - (g[i - w - 1] + 2 * g[i - 1] + g[i + w - 1]);
      const gy = (g[i + w - 1] + 2 * g[i + w] + g[i + w + 1]) - (g[i - w - 1] + 2 * g[i - w] + g[i - w + 1]);
      mag[i] = Math.hypot(gx, gy);
      let a = Math.atan2(gy, gx); if (a < 0) a += Math.PI; if (a >= Math.PI) a -= Math.PI;
      ang[i] = a;
    }
    // 強い線のしきい値（上位 7%）
    const sample = [];
    for (let i = 0; i < N; i += 7) sample.push(mag[i]);
    sample.sort((a, b) => b - a);
    const thr = Math.max(40, sample[Math.floor(sample.length * 0.07)] || 40);
    return { mag, ang, thr };
  }

  function edgeQuads(gray, w, h) {
    const G = gradients(gray, w, h);
    edgeCache = { G, w, h };
    const { mag, ang, thr } = G;
    const NT = 180, diag = Math.ceil(Math.hypot(w, h)), NR = diag * 2 + 1;
    const acc = new Float32Array(NT * NR);
    const cosT = new Float32Array(NT), sinT = new Float32Array(NT);
    for (let t = 0; t < NT; t++) { cosT[t] = Math.cos(t * Math.PI / NT); sinT[t] = Math.sin(t * Math.PI / NT); }
    for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++) {
      const i = y * w + x;
      if (mag[i] < thr) continue;
      const t0 = Math.round(ang[i] * NT / Math.PI);
      for (let dt = -4; dt <= 4; dt++) {
        const t = (t0 + dt + NT) % NT;
        const r = Math.round(x * cosT[t] + y * sinT[t]) + diag;
        acc[t * NR + r] += 1;
      }
    }
    // ピーク（線）を取り出す
    const peaks = [];
    for (let t = 0; t < NT; t++) for (let r = 1; r < NR - 1; r++) {
      const v = acc[t * NR + r];
      if (v < Math.min(w, h) * 0.12) continue;
      let isMax = true;
      for (let dt = -3; dt <= 3 && isMax; dt++) for (let dr = -4; dr <= 4; dr++) {
        if (!dt && !dr) continue;
        const tt = (t + dt + NT) % NT, rr = r + dr;
        if (rr < 0 || rr >= NR) continue;
        if (acc[tt * NR + rr] > v) { isMax = false; break; }
      }
      if (isMax) peaks.push({ t, rho: r - diag, v });
    }
    peaks.sort((a, b) => b.v - a.v);
    const lines = peaks.slice(0, 40).map((p) => ({ c: cosT[p.t], s: sinT[p.t], rho: p.rho, deg: p.t, v: p.v }));
    // 画像のふちも「線」の候補にする（紙がはみ出している場合）
    lines.push({ c: 0, s: 1, rho: 0, deg: 90, border: true }, { c: 0, s: 1, rho: h - 1, deg: 90, border: true },
      { c: 1, s: 0, rho: 0, deg: 0, border: true }, { c: 1, s: 0, rho: w - 1, deg: 0, border: true });
    const horiz = [], vert = [];
    lines.forEach((L) => {
      if (Math.abs(L.deg - 90) < 35) { L.pos = (L.rho - (w / 2) * L.c) / L.s; horiz.push(L); }
      else if (L.deg < 35 || L.deg > 145) { L.pos = (L.rho - (h / 2) * L.s) / L.c; vert.push(L); }
    });
    // 横・縦それぞれ強い線の上位10本＋画像のふちだけで組み合わせる（処理を軽くする）
    const pickTop = (arr) => arr.filter((L) => !L.border).sort((x, y) => y.v - x.v).slice(0, 10).concat(arr.filter((L) => L.border));
    horiz.splice(0, horiz.length, ...pickTop(horiz)); vert.splice(0, vert.length, ...pickTop(vert));
    const quads = [];
    for (let a = 0; a < horiz.length; a++) for (let b = 0; b < horiz.length; b++) {
      const T = horiz[a], B = horiz[b];
      if (B.pos - T.pos < h * 0.2) continue;
      for (let c = 0; c < vert.length; c++) for (let d = 0; d < vert.length; d++) {
        const Lf = vert[c], R = vert[d];
        if (R.pos - Lf.pos < w * 0.2) continue;
        const q = [inter(T, Lf), inter(T, R), inter(B, R), inter(B, Lf)];
        if (q.some((p) => !p || p[0] < -w * 0.02 || p[0] > w * 1.02 || p[1] < -h * 0.02 || p[1] > h * 1.02)) continue;
        if (!isConvex(q)) continue;
        const ar = polygonArea(q);
        if (ar < w * h * 0.06 || ar > w * h * 0.995) continue;
        quads.push(q);
      }
    }
    return quads;
  }

  function inter(A, B) {
    const det = A.c * B.s - A.s * B.c;
    if (Math.abs(det) < 1e-6) return null;
    return [(A.rho * B.s - A.s * B.rho) / det, (A.c * B.rho - A.rho * B.c) / det];
  }

  /** 四角形の良さ：4辺がどれだけ「くっきりした線」に沿っているか＋内側が外側より明るいか＋大きさ */
  function quadScore(q, gray, w, h, prior) {
    if (!edgeCache) edgeCache = { G: gradients(gray, w, h), w, h };
    const { mag, ang, thr } = edgeCache.G;
    let support = 0;
    let inSum = 0, inN = 0, outSum = 0, outN = 0;
    const cx = (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, cy = (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4;
    for (let k = 0; k < 4; k++) {
      const a = q[k], b = q[(k + 1) % 4];
      const len = dist(a, b);
      const nx = -(b[1] - a[1]) / len, ny = (b[0] - a[0]) / len; // 辺の法線
      let na = Math.atan2(ny, nx); if (na < 0) na += Math.PI; if (na >= Math.PI) na -= Math.PI;
      // 外向きの法線
      const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
      const sgn = ((mx + nx * 5 - cx) ** 2 + (my + ny * 5 - cy) ** 2) > ((mx - cx) ** 2 + (my - cy) ** 2) ? 1 : -1;
      const S = 36;
      let hit = 0, onBorder = 0;
      for (let i = 1; i < S; i++) {
        const px = a[0] + (b[0] - a[0]) * i / S, py = a[1] + (b[1] - a[1]) * i / S;
        if (px < 3 || py < 3 || px > w - 4 || py > h - 4) { onBorder++; continue; }
        let ok = false;
        for (let o = -2; o <= 2 && !ok; o++) {
          const xx = Math.round(px + nx * o), yy = Math.round(py + ny * o);
          const j = yy * w + xx;
          if (mag[j] >= thr * 0.6) {
            let d = Math.abs(ang[j] - na); if (d > Math.PI / 2) d = Math.PI - d;
            if (d < 0.3) ok = true;
          }
        }
        if (ok) hit++;
        // 内側と外側の明るさ
        const ix = Math.round(px - sgn * nx * 6), iy = Math.round(py - sgn * ny * 6);
        const ox = Math.round(px + sgn * nx * 6), oy = Math.round(py + sgn * ny * 6);
        if (ix >= 0 && iy >= 0 && ix < w && iy < h) { inSum += gray[iy * w + ix]; inN++; }
        if (ox >= 0 && oy >= 0 && ox < w && oy < h) { outSum += gray[oy * w + ox]; outN++; }
      }
      const valid = S - 1 - onBorder;
      // 画像のふちに沿った辺は「はみ出し」とみなし、ほどほどの点数
      support += valid > 0 ? (hit / valid) * (valid / (S - 1)) + 0.55 * (onBorder / (S - 1)) : 0.55;
    }
    const contrast = inN && outN ? (inSum / inN - outSum / outN) / 255 : 0;
    const areaFrac = polygonArea(q) / (w * h);
    return support / 4 * 2 + contrast * 1.5 + Math.sqrt(areaFrac) * 0.35 + (prior || 0) * 0.1;
  }

  // 連結成分（大きい順に top 個）
  function components(m, w, h, top) {
    const label = new Uint8Array(m.length);
    const out = [];
    const stack = [];
    for (let s = 0; s < m.length; s++) {
      if (!m[s] || label[s]) continue;
      const pts = [];
      label[s] = 1; stack.push(s);
      while (stack.length) {
        const p = stack.pop(); pts.push(p);
        const x = p % w;
        if (x > 0 && m[p - 1] && !label[p - 1]) { label[p - 1] = 1; stack.push(p - 1); }
        if (x < w - 1 && m[p + 1] && !label[p + 1]) { label[p + 1] = 1; stack.push(p + 1); }
        if (p >= w && m[p - w] && !label[p - w]) { label[p - w] = 1; stack.push(p - w); }
        if (p < m.length - w && m[p + w] && !label[p + w]) { label[p + w] = 1; stack.push(p + w); }
      }
      if (pts.length > m.length * 0.03) out.push(pts);
    }
    return out.sort((a, b) => b.length - a.length).slice(0, top);
  }

  // 四隅 = x+y 最小/最大、x-y 最大/最小（grow: 削った分だけ外側へ戻す）
  function extremes(pts, w, grow) {
    let tl, tr, br, bl, sMin = Infinity, sMax = -Infinity, dMin = Infinity, dMax = -Infinity;
    for (const p of pts) {
      const x = p % w, y = (p / w) | 0, s = x + y, d = x - y;
      if (s < sMin) { sMin = s; tl = [x, y]; }
      if (s > sMax) { sMax = s; br = [x, y]; }
      if (d > dMax) { dMax = d; tr = [x, y]; }
      if (d < dMin) { dMin = d; bl = [x, y]; }
    }
    if (grow) { tl = [tl[0] - grow, tl[1] - grow]; tr = [tr[0] + grow, tr[1] - grow]; br = [br[0] + grow, br[1] + grow]; bl = [bl[0] - grow, bl[1] + grow]; }
    return [tl, tr, br, bl];
  }

  function perimeterGrow(q, g) {
    let per = 0;
    for (let i = 0; i < 4; i++) per += dist(q[i], q[(i + 1) % 4]);
    return per * g;
  }

  function isConvex(q) {
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
      const cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
      if (Math.abs(cr) < 1e-6) return false;
      if (!sign) sign = Math.sign(cr); else if (Math.sign(cr) !== sign) return false;
    }
    return true;
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
