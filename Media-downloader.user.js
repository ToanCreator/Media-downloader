// ==UserScript==
// @name         Media Downloader
// @namespace    https://toancreator.dev/
// @version      1.8.3
// @description  Captures network links and downloads Video – Image – Audio (including HLS .m3u8 and YouTube) on hover. Liquid-glass UI with a "Quick download" button that lists everything downloadable on the page.
// @author       ToanCreator
// @match        *://*/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// @grant        GM_registerMenuCommand
// @grant        GM_openInTab
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_addValueChangeListener
// @grant        unsafeWindow
// @connect      *
// @license      MIT
// ==/UserScript==

(function () {
  'use strict';

  /* =====================================================================
   *  CẤU HÌNH
   * ===================================================================== */
  const CFG = {
    IDLE_MS: 3000,        // Sau bao lâu không hover/chạm thì nút tải trên video/ảnh tự ẩn (bảng KHÔNG tự đóng)
    MAX_CAND: 12,         // Số link bắt từ network tối đa hiện cho 1 video/audio
    MIN_BOX: 80,          // Ảnh nhỏ hơn (px) sẽ không hiện nút khi hover
    MIN_IMG_BYTES: 3072,  // Ảnh nhỏ hơn mức này bị coi là icon/pixel theo dõi
    HLS_PARALLEL: 5,      // Số phân đoạn HLS tải song song
    PROBE_PARALLEL: 4,    // Số yêu cầu dò dung lượng chạy song song
    GRAB_AUTO: true,       // Khi tải bị 403: tự tải lại trang và bắt các đoạn video do trình phát tải (Grab)
    GRAB_MAX_RATE: 16,     // Grab: tốc độ phát tối đa khi bắt stream (nếu video bị thiếu đoạn thì thử hạ xuống 4 hoặc 8)
    GRAB_STALL_MS: 20000,  // Grab: không có đoạn mới sau bấy nhiêu ms thì coi là bị đứng và thử lại (seek tới mép đã bắt, hạ tốc độ)
    GRAB_LOG: true,        // Grab: nếu bắt chưa đủ video, lưu thêm file <tên>_grablog.txt (chẩn đoán, không chứa token)
    GRAB_FINALIZE: true,   // Grab: chuyển fMP4 -> MP4 thường (tua được, có thời lượng) sau khi bắt xong, không mã hóa lại
    GRAB_PART_MB: 700,     // Grab: file lớn hơn mức này sẽ được lưu thành nhiều phần (_part1, _part2...) để đỡ tốn RAM
    GRAB_AUTOSUBMIT: true, // Trên grabshorts.com: dán link xong tự bấm nút Download (đặt false nếu chỉ muốn dán)
  };
  const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const IS_TOP = (() => { try { return window.top === window; } catch (_) { return false; } })();
  const IS_YT = /(^|\.)(youtube\.com|youtube-nocookie\.com)$/i.test(location.hostname);
  const IS_GRAB = /(^|\.)grabshorts\.com$/i.test(location.hostname);
  // Các trang nổi tiếng: nút "mở link trong tab mới" sẽ chuyển sang GrabShorts
  const FAMOUS_RE = /(^|\.)(youtube\.com|youtu\.be|tiktok\.com|facebook\.com|fb\.watch|instagram\.com|twitter\.com|x\.com|snapchat\.com|linkedin\.com|pinterest\.[a-z.]+|threads\.net|xiaohongshu\.com|dailymotion\.com|rutube\.ru|spotify\.com|bandcamp\.com|mixcloud\.com)$/i;
  const isFamous = () => FAMOUS_RE.test(location.hostname);
  const isFs = () => !!(document.fullscreenElement || document.webkitFullscreenElement);

  /* =====================================================================
   *  PHÂN LOẠI FILE
   * ===================================================================== */
  const EXT_TYPE = {};
  [
    ['video', 'mp4 m4v webm mkv mov avi flv wmv 3gp ogv'],
    ['audio', 'mp3 m4a aac ogg oga opus wav flac weba'],
    ['image', 'jpg jpeg jfif png gif webp avif bmp svg'],
    ['hls', 'm3u8'],
    ['dash', 'mpd'],
  ].forEach(([t, s]) => s.split(' ').forEach((e) => (EXT_TYPE[e] = t)));

  const MIME_EXT = {
    'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/x-matroska': 'mkv',
    'video/ogg': 'ogv', 'video/x-flv': 'flv', 'video/3gpp': '3gp',
    'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac',
    'audio/ogg': 'ogg', 'audio/opus': 'opus', 'audio/wav': 'wav', 'audio/x-wav': 'wav',
    'audio/webm': 'weba', 'audio/flac': 'flac',
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
    'image/avif': 'avif', 'image/svg+xml': 'svg', 'image/bmp': 'bmp',
  };
  const DEFAULT_EXT = { video: 'mp4', audio: 'mp3', image: 'jpg', hls: 'ts' };
  const TYPE_LABEL = { video: 'Video', audio: 'Audio', image: 'Image', hls: 'HLS' };
  const SEGMENT_RE = /\.(ts|m4s|m4f|cmfv|cmfa|vtt|srt|key)(?:$|[?#])/i;
  const STRIP_PARAMS = ['range', 'bytestart', 'byteend', 'rn', 'rbuf'];

  function typeFromMime(m) {
    m = (m || '').toLowerCase().split(';')[0].trim();
    if (!m) return '';
    if (/mpegurl/.test(m)) return 'hls';
    if (m === 'application/dash+xml') return 'dash';
    if (m === 'video/mp2t' || /iso\.segment/.test(m)) return 'segment';
    if (m.startsWith('video/')) return 'video';
    if (m.startsWith('audio/')) return 'audio';
    if (m.startsWith('image/')) return 'image';
    return '';
  }
  function extOf(u) {
    try {
      const m = /\.([a-z0-9]{2,5})$/i.exec(new URL(u).pathname);
      return m ? m[1].toLowerCase() : '';
    } catch (_) { return ''; }
  }
  function parseUrl(u, base) {
    try { return new URL(u, base || document.baseURI || location.href); } catch (_) { return null; }
  }
  function normKey(href) {
    if (href.startsWith('data:')) return 'data:' + href.length + ':' + href.slice(0, 64);
    if (href.startsWith('blob:')) return href;
    try {
      const x = new URL(href);
      STRIP_PARAMS.forEach((k) => x.searchParams.delete(k));
      x.hash = '';
      return x.href;
    } catch (_) { return href; }
  }
  function guessQuality(u) {
    const m = /[_\-\/.=](2160|1440|1080|720|576|480|360|240|144)p?(?=[_\-\/.&?=]|$)/i.exec(u);
    return m ? m[1] + 'p' : '';
  }
  function fmtSize(n) {
    if (n == null || isNaN(n)) return '—';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (i === 0 ? n : n.toFixed(n >= 100 ? 0 : 1)) + ' ' + u[i];
  }
  function sanitize(s) {
    return String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120);
  }
  function parseHeaders(str) {
    const o = {};
    String(str || '').split(/\r?\n/).forEach((l) => {
      const i = l.indexOf(':');
      if (i > 0) o[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim();
    });
    return o;
  }
  function attrs(s) {
    const o = {};
    s.replace(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g, (_, k, v) => { o[k] = v.replace(/^"|"$/g, ''); return ''; });
    return o;
  }

  /* =====================================================================
   *  KHO DỮ LIỆU (store) + BẮT LINK
   * ===================================================================== */
  /* ---------- Settings (saved with GM_setValue, all enabled by default) ---------- */
  const SET_KEY = 'tc_settings';
  const SET = { menu: true, image: true, audio: true, video: true };
  function loadSettings() {
    let o = null;
    try {
      if (typeof GM_getValue === 'function') {
        const raw = GM_getValue(SET_KEY, '');
        o = typeof raw === 'string' ? JSON.parse(raw || 'null') : raw;
      }
    } catch (_) {}
    Object.keys(SET).forEach((k) => { SET[k] = !(o && o[k] === false); });
  }
  function saveSettings() {
    try { if (typeof GM_setValue === 'function') GM_setValue(SET_KEY, JSON.stringify(SET)); } catch (_) {}
  }
  // Is fetching enabled for this media type? (HLS counts as video)
  const typeOn = (t) => (t === 'image' ? SET.image : t === 'audio' ? SET.audio : (t === 'video' || t === 'hls') ? SET.video : true);
  loadSettings();

  const store = new Map();   // key -> item (chỉ http/https bắt được)
  const cache = new Map();   // key -> kết quả dò (size, mime, ext...)
  const hlsVariants = new Map();

  // Xoá toàn bộ ảnh/video/audio đã bắt được để giảm lag (nút thùng rác trong bảng tải)
  function clearAll() {
    const n = store.size;
    store.clear(); cache.clear(); hlsVariants.clear();
    try { YT.done.clear(); YT.busy.clear(); } catch (_) {}
    try { performance.clearResourceTimings(); } catch (_) {}
    if (bumpT) { clearTimeout(bumpT); bumpT = 0; }
    if (UI) UI.setBadge(0);
    return n;
  }

  function buildItem(url, o) {
    o = o || {};
    if (!url) return null;
    const u = parseUrl(url);
    if (!u || !/^(https?:|blob:|data:)$/.test(u.protocol)) return null;
    const abs = u.href;
    const key = normKey(abs);
    const known = store.get(key) || {};
    const cached = cache.get(key) || {};
    const isHttp = u.protocol.startsWith('http');
    let mime = o.mime || cached.mime || known.mime || '';
    if (!mime && u.protocol === 'data:') { const m = /^data:([^;,]+)/.exec(abs); mime = m ? m[1] : ''; }
    if (isHttp && SEGMENT_RE.test(abs)) return null;
    const ext = isHttp ? extOf(abs) : '';
    let type = typeFromMime(mime);
    if (type === 'segment') return null;
    if (!type) type = EXT_TYPE[ext] || '';
    if (!type) type = o.type || known.type || '';
    if (!type || type === 'dash') return null;
    const fext = EXT_TYPE[ext] && EXT_TYPE[ext] !== 'hls' ? ext : (MIME_EXT[mime.split(';')[0]] || o.ext || '');
    const size = o.size != null ? o.size : (cached.size != null ? cached.size : (known.size != null ? known.size : null));
    return {
      key, url: abs, type, mime, ext: type === 'hls' ? '' : fext, size,
      q: o.q || (type === 'video' || type === 'hls' ? guessQuality(abs) : ''),
      w: o.w || known.w, h: o.h || known.h, bw: o.bw || known.bw || 0,
      note: o.note || '', current: !!o.current, yt: o.yt || known.yt,
      ref: o.ref || known.ref || location.href,
      title: o.title || known.title || document.title || location.hostname,
      t: o.t || Date.now(),
    };
  }

  let bumpT = 0;
  function bump() {
    if (!IS_TOP || bumpT) return;
    bumpT = setTimeout(() => {
      bumpT = 0;
      if (UI) { UI.setBadge(countAll()); UI.refreshIfAll(); }
    }, 400);
  }
  function countAll() {
    let n = 0;
    store.forEach((i) => {
      if (!typeOn(i.type)) return;
      if (!(i.type === 'image' && i.size != null && i.size < CFG.MIN_IMG_BYTES)) n++;
    });
    return n;
  }

  function record(url, o) {
    o = o || {};
    const it = buildItem(url, o);
    if (!it || !/^https?:/.test(it.url)) return null;
    if (!typeOn(it.type)) return null;
    // Mảnh /videoplayback của YouTube chỉ là một đoạn nhỏ -> bỏ; danh sách đầy đủ lấy ở phần YouTube
    if (o.from !== 'yt' && /\/videoplayback/.test(it.url)) {
      const pu = parseUrl(it.url);
      if (pu && /(^|\.)googlevideo\.com$/i.test(pu.hostname)) return null;
    }
    if (it.type === 'image') {
      if (o.from === 'perf' && !(it.size >= CFG.MIN_IMG_BYTES)) return null;
      if (o.from === 'net' && it.size != null && it.size < CFG.MIN_IMG_BYTES) return null;
      if ((o.w && o.w < 64) || (o.h && o.h < 64)) return null;
    }
    const old = store.get(it.key);
    let changed = false;
    if (old) {
      if (it.size != null && old.size !== it.size) { old.size = it.size; changed = true; }
      if (it.mime && !old.mime) old.mime = it.mime;
      if (it.ext && !old.ext) old.ext = it.ext;
      if (it.w && !old.w) { old.w = it.w; old.h = it.h; }
      if (it.q && !old.q) old.q = it.q;
      old.t = Date.now();
    } else {
      store.set(it.key, it);
      changed = true;
    }
    if (changed) {
      bump();
      if (!IS_TOP && !o.relay && o.from !== 'yt') {
        try {
          window.top.postMessage({ tcMedia: 1, item: { url: it.url, mime: it.mime, size: it.size, type: it.type, q: it.q, w: it.w, h: it.h, ref: it.ref, title: it.title } }, '*');
        } catch (_) {}
      }
    }
    return store.get(it.key);
  }

  function sniff(url, mime, len, range, status) {
    if (!url || (status && (status < 200 || status >= 400))) return;
    let size = +len || 0;
    const m = /\/(\d+)\s*$/.exec(range || '');
    if (m) size = +m[1];
    record(url, { mime: mime || '', size: size || null, from: 'net' });
  }

  /* =====================================================================
   *  TAP – lưu lại những gì chính TRÌNH PHÁT tự tải (không bị 403 vì do trang tải, đủ cookie/Origin)
   *  - Playlist .m3u8 và khóa AES-128 (16 byte) luôn được ghi nhớ (rất nhẹ).
   *  - Nội dung các đoạn video chỉ được giữ khi TAP.on = true (chế độ Grab, sau khi tải lại trang).
   * ===================================================================== */
  const TAP = { on: false, want: new Set(), store: new Map(), blind: [], bytes: 0, errs: [] };
  // Ghi lại các request bị lỗi (>=400 / đứt mạng) trong lúc Grab, để biết vì sao trình phát ngừng nạp đoạn (chỉ giữ phần đường dẫn, bỏ query/token)
  const tapErr = (st, u) => { try { if (TAP.errs.length < 60) TAP.errs.push({ s: st, t: Math.round(performance.now() / 1000), u: String(u).split('?')[0].slice(-110) }); } catch (_) {} };
  const PL = new Map();     // url -> { url, text, pm }
  const KEYS = new Map();   // url -> Uint8Array(16)
  // Khóa "đang chờ Grab" theo TÊN MIỀN (không theo đường dẫn/query): nhiều trang đổi URL sau mỗi lần tải lại
  // (token, session id, redirect...) nên khóa theo URL đầy đủ sẽ không bao giờ khớp -> mất record.
  const baseHost = (h) => { const p = String(h || '').toLowerCase().split('.').filter(Boolean); return p.length > 2 ? p.slice(-2).join('.') : p.join('.'); };
  const GRAB_KEY = 'tc_grab_pending:' + baseHost(location.hostname);
  const tapKey = (u) => { try { const x = new URL(u, location.href); x.hash = ''; return x.href; } catch (_) { return String(u); } };
  const isPlUrl = (u, ct) => /\.m3u8(\?|#|$)/i.test(u || '') || /mpegurl/i.test(ct || '');
  function mkBlob(buf) {
    try { return new Blob([buf]); } catch (_) { return new Blob([new Uint8Array(buf).slice()]); }
  }
  function looksMedia(b) {
    try {
      const u = new Uint8Array(b, 0, Math.min(4096, b.byteLength));
      const t = String.fromCharCode(u[4], u[5], u[6], u[7]);
      if (/^(ftyp|styp|moof|moov)$/.test(t)) return true;
      for (let o = 0; o + 376 < u.length && o < 2048; o++) if (u[o] === 0x47 && u[o + 188] === 0x47 && u[o + 376] === 0x47) return true;
    } catch (_) {}
    return false;
  }
  function cachePl(u, t) {
    if (!t || t.indexOf('#EXTM3U') < 0) return;
    const k = tapKey(u);
    const e = { url: k, text: t, pm: null };
    PL.delete(k); PL.set(k, e);
    if (PL.size > 40) PL.delete(PL.keys().next().value);
    if (TAP.on && t.indexOf('#EXTINF') >= 0) {
      try {
        e.pm = parseMedia(t, k);
        e.pm.segs.forEach((s) => TAP.want.add(tapKey(s.url)));
        if (e.pm.map) TAP.want.add(tapKey(e.pm.map));
      } catch (_) {}
    }
  }
  function tapPut(urls, buf) {
    try {
      const len = buf && buf.byteLength;
      if (!len) return;
      const ks = urls.filter(Boolean).map(tapKey);
      if (len === 16) ks.forEach((k) => { if (!KEYS.has(k)) KEYS.set(k, new Uint8Array(buf).slice()); });
      if (!TAP.on) return;
      const k = ks.find((x) => TAP.want.has(x));
      if (!k) {
        // chưa biết playlist (trình phát tự dựng playlist): giữ theo thứ tự đến nếu trông giống dữ liệu video
        if (len > 2048 && ks.length && looksMedia(buf) && !TAP.blind.some((b) => b.k === ks[0])) {
          const blob = mkBlob(buf); TAP.blind.push({ k: ks[0], blob }); TAP.bytes += blob.size;
        }
        return;
      }
      const old = TAP.store.get(k);
      if (old) TAP.bytes -= old.size;
      const blob = mkBlob(buf);
      TAP.store.set(k, blob); TAP.bytes += blob.size;
    } catch (_) {}
  }
  function tapFetch(res, reqUrl) {
    const u = res.url || reqUrl, ct = res.headers.get('content-type') || '';
    if (isPlUrl(u, ct)) { res.clone().text().then((t) => cachePl(u, t)).catch(() => {}); return; }
    if (!res.ok) return;
    const urls = [res.url, reqUrl];
    const cl = +res.headers.get('content-length') || 0;
    if (cl === 16 || (TAP.on && !/^(text|image)\//i.test(ct) && !/json|javascript|css|html/i.test(ct))) {
      res.clone().arrayBuffer().then((b) => tapPut(urls, b)).catch(() => {});
    }
  }
  function tapXhr(x) {
    const u = x.responseURL || x.__tcu;
    if (!u) return;
    const ct = x.getResponseHeader('content-type') || '';
    const rt = x.responseType;
    if (isPlUrl(u, ct)) {
      let t = '';
      if (rt === '' || rt === 'text') t = x.responseText;
      else if (rt === 'arraybuffer' && x.response) t = new TextDecoder().decode(x.response);
      if (t) cachePl(u, t);
      return;
    }
    if (x.status < 200 || x.status >= 300) return;
    if (rt === 'arraybuffer' && x.response) tapPut([x.responseURL, x.__tcu], x.response);
    else if (rt === 'blob' && x.response && x.response.arrayBuffer) x.response.arrayBuffer().then((b) => tapPut([x.responseURL, x.__tcu], b)).catch(() => {});
  }

  /* =====================================================================
   *  MSE TAP – bắt thẳng dữ liệu mà trình phát nạp vào MediaSource (appendBuffer)
   *  Đây là chính xác những byte mà bộ giải mã nhận, nên không phụ thuộc: 403, header ảnh giả,
   *  playlist riêng, Web Worker, blob:, và cũng không cần đọc khung hình (không bị "hình đen").
   *  Hỗ trợ fMP4 (hls.js/dash.js/Shaka...): tự dedupe + sắp xếp theo thời gian, ghép audio+video thành 1 file MP4.
   * ===================================================================== */
  const MSE = { list: [], map: new WeakMap(), count: 0, seq: 0 };
  const u32 = (u, o) => u[o] * 16777216 + ((u[o + 1] << 16) | (u[o + 2] << 8) | u[o + 3]);
  const u64 = (u, o) => u32(u, o) * 4294967296 + u32(u, o + 4);
  const fcc = (u, o) => String.fromCharCode(u[o], u[o + 1], u[o + 2], u[o + 3]);
  const put32 = (u, o, v) => { u[o] = (v >>> 24) & 255; u[o + 1] = (v >>> 16) & 255; u[o + 2] = (v >>> 8) & 255; u[o + 3] = v & 255; };
  function boxesOf(u, s, e) {
    const out = []; let o = s || 0; e = e == null ? u.length : e;
    while (o + 8 <= e) {
      let size = u32(u, o), hdr = 8;
      if (size === 1) { if (o + 16 > e) break; size = u64(u, o + 8); hdr = 16; }
      else if (size === 0) size = e - o;
      if (size < hdr || o + size > e) break;
      out.push({ type: fcc(u, o + 4), start: o, end: o + size, body: o + hdr });
      o += size;
    }
    return out;
  }
  const kids = (u, b, t) => boxesOf(u, b.body, b.end).filter((x) => x.type === t);
  const kid = (u, b, t) => kids(u, b, t)[0];
  const fnv = (u) => { let h = 2166136261; for (let i = 0; i < u.length; i++) { h ^= u[i]; h = Math.imul(h, 16777619); } return (h >>> 0).toString(36) + '.' + u.length; };
  const catU8 = (arrs) => { let n = 0; arrs.forEach((a) => { n += a.length; }); const o = new Uint8Array(n); let p = 0; arrs.forEach((a) => { o.set(a, p); p += a.length; }); return o; };
  function mkBox(type, parts) {
    const body = catU8(parts), o = new Uint8Array(8 + body.length);
    put32(o, 0, o.length); for (let i = 0; i < 4; i++) o[4 + i] = type.charCodeAt(i);
    o.set(body, 8); return o;
  }

  // Thông tin khung (moof): thời gian giải mã + track id
  function fragInfo(u) {
    for (const b of boxesOf(u)) {
      if (b.type !== 'moof') continue;
      const traf = kid(u, b, 'traf'); if (!traf) return null;
      const tfhd = kid(u, traf, 'tfhd'), tfdt = kid(u, traf, 'tfdt');
      return { tid: tfhd ? u32(u, tfhd.body + 4) : 0, time: tfdt ? (u[tfdt.body] === 1 ? u64(u, tfdt.body + 4) : u32(u, tfdt.body + 4)) : null };
    }
    return null;
  }
  // Thông tin init segment: track id, timescale, loại (vide/soun), số track
  function initInfo(u) {
    try {
      const moov = boxesOf(u).find((b) => b.type === 'moov'); if (!moov) return null;
      const traks = kids(u, moov, 'trak'); if (!traks.length) return null;
      const t = traks[0], tkhd = kid(u, t, 'tkhd'), mdia = kid(u, t, 'mdia');
      const mdhd = kid(u, mdia, 'mdhd'), hdlr = kid(u, mdia, 'hdlr');
      return {
        tid: u32(u, tkhd.body + (u[tkhd.body] === 1 ? 20 : 12)),
        ts: u32(u, mdhd.body + (u[mdhd.body] === 1 ? 20 : 12)) || 1,
        kind: hdlr ? fcc(u, hdlr.body + 8) : '', traks: traks.length,
      };
    } catch (_) { return null; }
  }

  function mseAdd(rec, data) {
    if (!rec || !data) return;
    const buf = ArrayBuffer.isView(data) ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data.slice(0);
    const u = new Uint8Array(buf);
    if (u.length < 8) return;
    let cut = 0, hasMoof = false;
    for (const b of boxesOf(u)) { if (b.type === 'moof') { hasMoof = true; break; } if (b.type === 'ftyp' || b.type === 'moov') cut = b.end; }
    if (cut) {
      const iu = u.slice(0, cut), sig = fnv(iu);
      if (!rec.inits.has(sig)) { rec.inits.set(sig, { blob: mkBlob(iu.buffer), info: initInfo(iu) }); TAP.bytes += iu.length; }
      rec.cur = sig;
    }
    const fu = cut ? u.subarray(cut) : u;
    if (fu.length < 16) return;
    const fi = hasMoof ? fragInfo(fu) : null;
    const t = fi && fi.time != null ? fi.time : null;
    const key = (rec.cur || '') + ':' + (fi ? (t != null ? t : 'q' + (rec.n++)) : fnv(fu.subarray(0, Math.min(fu.length, 512))) + '/' + fu.length);
    if (rec.frags.has(key)) return;
    rec.frags.set(key, { init: rec.cur || '', time: t, seq: ++MSE.seq, blob: mkBlob(fu.slice().buffer), size: fu.length, mp4: !!fi });
    TAP.bytes += fu.length; MSE.count++;
  }

  function hookMse(put) {
    try {
      const MS = W.MediaSource, SB = W.SourceBuffer;
      if (!MS || !SB) return;
      const oAdd = MS.prototype.addSourceBuffer, oApp = SB.prototype.appendBuffer;
      put(MS.prototype, 'addSourceBuffer', function (mime) {
        const sb = oAdd.apply(this, arguments);
        try { const r = { mime: String(mime), inits: new Map(), cur: '', frags: new Map(), n: 0 }; MSE.list.push(r); MSE.map.set(sb, r); } catch (_) {}
        return sb;
      });
      put(SB.prototype, 'appendBuffer', function (data) {
        try { if (TAP.on) mseAdd(MSE.map.get(this), data); } catch (_) {}
        return oApp.apply(this, arguments);
      });
    } catch (_) {}
  }

  // Tóm tắt từng SourceBuffer: chọn init chiếm đa số, sắp xếp khung theo thời gian
  function mseSummary() {
    const out = [];
    MSE.list.forEach((r) => {
      if (!r.frags.size) return;
      const cnt = new Map();
      r.frags.forEach((f) => cnt.set(f.init, (cnt.get(f.init) || 0) + 1));
      let best = '', bn = 0; cnt.forEach((n, k) => { if (n > bn) { bn = n; best = k; } });
      const init = r.inits.get(best) || null, info = init && init.info;
      const ts = (info && info.ts) || 1;
      const fr = [...r.frags.values()].filter((f) => f.init === best)
        .sort((a, b) => ((a.time != null && b.time != null) ? a.time - b.time : 0) || a.seq - b.seq);
      const secs = fr.map((f) => (f.time != null ? f.time / ts : null));
      const d = [];
      for (let i = 1; i < secs.length; i++) if (secs[i] != null && secs[i - 1] != null) d.push(secs[i] - secs[i - 1]);
      d.sort((a, b) => a - b);
      out.push({
        mime: r.mime, init, info, frags: fr, secs, gap: d.length ? d[d.length >> 1] : 0,
        first: secs[0], last: secs[secs.length - 1],
        size: fr.reduce((a, f) => a + f.size, 0),
        kind: (info && info.kind) || (/^audio/.test(r.mime) ? 'soun' : 'vide'),
        traks: (info && info.traks) || 1, mp4: !!init && fr.every((f) => f.mp4),
      });
    });
    return out;
  }
  // Chọn luồng chính (hình, hoặc luồng đã gồm cả hình lẫn tiếng) và luồng tiếng riêng (nếu có)
  function mseMain(sum) {
    sum = sum || mseSummary();
    const big = (a) => a.slice().sort((x, y) => y.size - x.size)[0];
    const vids = sum.filter((r) => r.kind === 'vide' || r.traks > 1);
    const main = vids.length ? big(vids) : big(sum);
    if (!main) return null;
    const auds = sum.filter((r) => r !== main && r.kind === 'soun');
    return { main, audio: main.traks === 1 && auds.length ? big(auds) : null };
  }
  // Tiến độ: đã đủ tới cuối video chưa, có "lỗ" nào chưa bắt được không
  function mseProgress(dur, ignoreStart) {
    const pr = mseMain(); if (!pr) return null;
    const chk = (r) => {
      if (!r || !r.gap || r.first == null) return { got: r ? r.frags.length : 0, done: false, hole: null, n: 0 };
      let hole = null;
      if (!ignoreStart && r.first > r.gap * 1.6) hole = 0;
      for (let i = 1; hole == null && i < r.secs.length; i++) if (r.secs[i] - r.secs[i - 1] > r.gap * 1.6) hole = r.secs[i - 1] + r.gap;
      const atEnd = isFinite(dur) && r.last + r.gap >= dur - Math.max(1.5, r.gap * 0.6);
      return { got: r.frags.length, done: atEnd && hole == null, hole, n: isFinite(dur) ? Math.round(dur / r.gap) : 0 };
    };
    const a = chk(pr.main), b = pr.audio ? chk(pr.audio) : null;
    return { got: a.got, n: a.n, done: a.done && (!b || b.done), hole: a.hole != null ? a.hole : (b ? b.hole : null), audio: !!pr.audio };
  }

  // Ghép init của hình + tiếng thành một moov có 2 track
  function muxInit(vi, ai) {
    const V = vi.slice(), A = ai.slice();
    const vm = boxesOf(V).find((b) => b.type === 'moov'), am = boxesOf(A).find((b) => b.type === 'moov');
    const vInfo = initInfo(V);
    const atrak = kid(A, am, 'trak'), atkhd = kid(A, atrak, 'tkhd');
    const off = atkhd.body + (A[atkhd.body] === 1 ? 20 : 12);
    const aId = u32(A, off), newId = aId === vInfo.tid ? aId + 1 : aId;
    put32(A, off, newId);
    let atrex = null;
    const amvex = kid(A, am, 'mvex');
    if (amvex) kids(A, amvex, 'trex').forEach((t) => { if (u32(A, t.body + 4) === aId) { atrex = A.slice(t.start, t.end); put32(atrex, 12, newId); } });
    const mvhd = kid(V, vm, 'mvhd');
    if (mvhd) { const o = mvhd.body + (V[mvhd.body] === 1 ? 108 : 96); if (u32(V, o) <= newId) put32(V, o, newId + 1); }
    const parts = [];
    boxesOf(V, vm.body, vm.end).forEach((c) => {
      if (c.type === 'mvex' && atrex) parts.push(mkBox('mvex', [V.subarray(c.body, c.end), atrex]));
      else parts.push(V.subarray(c.start, c.end));
    });
    parts.push(A.subarray(atrak.start, atrak.end));
    const ft = boxesOf(V).find((b) => b.type === 'ftyp');
    return { head: catU8([ft ? V.subarray(ft.start, ft.end) : new Uint8Array(0), mkBox('moov', parts)]), aId, newId };
  }
  function retag(u, from, to) {
    const c = u.slice();
    boxesOf(c).forEach((b) => { if (b.type === 'moof') kids(c, b, 'traf').forEach((t) => { const h = kid(c, t, 'tfhd'); if (h && u32(c, h.body + 4) === from) put32(c, h.body + 4, to); }); });
    return c;
  }

  // Dựng file từ dữ liệu MSE đã bắt: { files, suffix, ext, total, mixed } hoặc null
  async function mseBuild() {
    const pr = mseMain(); if (!pr || !pr.main.frags.length) return null;
    const { main, audio } = pr;
    const ab = async (b) => new Uint8Array(await b.arrayBuffer());
    const joined = (r) => new Blob([r.init.blob].concat(r.frags.map((f) => f.blob)), { type: 'video/mp4' });
    if (!main.mp4) {
      const t = new Blob(main.frags.map((f) => f.blob), { type: 'video/mp2t' });
      return { files: [t], suffix: [''], ext: 'ts', total: t.size, mixed: ' · MSE raw' };
    }
    if (audio && audio.mp4) {
      try {
        const mx = muxInit(await ab(main.init.blob), await ab(audio.init.blob));
        const items = main.frags.map((f, i) => ({ t: main.secs[i] != null ? main.secs[i] : i * (main.gap || 1), o: 0, b: f.blob }));
        for (let i = 0; i < audio.frags.length; i++) {
          let b = audio.frags[i].blob;
          if (mx.newId !== mx.aId) b = new Blob([retag(await ab(b), mx.aId, mx.newId)]);
          items.push({ t: audio.secs[i] != null ? audio.secs[i] : i * (audio.gap || 1), o: 1, b });
        }
        items.sort((x, y) => x.t - y.t || x.o - y.o);
        const blob = new Blob([mx.head].concat(items.map((x) => x.b)), { type: 'video/mp4' });
        
        return { files: [blob], suffix: [''], ext: 'mp4', total: blob.size, mixed: ' · video+audio merged' };
      } catch (e) { }
      const v = joined(main), a = joined(audio);
      return { files: [v, a], suffix: ['_video', '_audio'], ext: 'mp4', total: v.size + a.size, mixed: ' · video and audio saved separately' };
    }
    const v = joined(main);
    return { files: [v], suffix: [''], ext: 'mp4', total: v.size, mixed: pr.main.traks > 1 ? ' · muxed' : ' · video only (no audio captured)' };
  }
  const mseClear = () => { MSE.list.forEach((r) => { r.frags.clear(); }); MSE.count = 0; };

  /* =====================================================================
   *  FINALIZE: fMP4 (phân mảnh, không tua được) -> MP4 thường (có stts/stsz/stco/stss + duration)
   *  Chỉ đọc lại header (moov/moof) và xếp lại dữ liệu mdat, KHÔNG giải mã / mã hóa lại:
   *  giữ nguyên chất lượng, tỷ lệ khung hình, âm thanh. File mới có moov ở đầu -> tua được ngay.
   *  Trả về { blob, dur, gaps, tracks }. Ném lỗi nếu không phải fMP4 (khi đó giữ file gốc).
   * ===================================================================== */
  async function finalizeMp4(src, opt) {
    opt = opt || {};
    const fillGaps = opt.fillGaps !== false;           // đoạn bị thiếu -> giữ hình cuối / chừa khoảng trống để không lệch A/V
    const rd = async (o, n) => new Uint8Array(await src.slice(o, o + n).arrayBuffer());
    const A = (s) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));
    const W32 = (...v) => { const o = new Uint8Array(v.length * 4); v.forEach((x, i) => put32(o, i * 4, x)); return o; };
    const setDur = (u, o, v1, val) => { if (v1) { put32(u, o, Math.floor(val / 4294967296)); put32(u, o + 4, val % 4294967296); } else put32(u, o, val); };

    /* 1) quét các box cấp cao nhất: moov, các cặp moof+mdat (box cụt ở cuối file sẽ bị bỏ) */
    let moov = null; const frags = []; let pend = null; const total = src.size;
    for (let o = 0; o + 8 <= total;) {
      const h = await rd(o, 16);
      let size = u32(h, 0), hdr = 8; const type = fcc(h, 4);
      if (size === 1) { size = u64(h, 8); hdr = 16; } else if (size === 0) size = total - o;
      if (size < hdr || o + size > total) break;
      if (type === 'moov' && !moov) moov = await rd(o, size);
      else if (type === 'moof') pend = { o, u: await rd(o, size) };
      else if (type === 'mdat' && pend) { frags.push({ moofO: pend.o, moof: pend.u, ps: o + hdr, pe: o + size }); pend = null; }
      o += size;
    }
    if (!moov || !frags.length) throw new Error('not a fragmented MP4');

    /* 2) đọc moov: timescale, trex (giá trị mặc định), danh sách track */
    const mv = boxesOf(moov)[0];
    const mvhd = kid(moov, mv, 'mvhd'); if (!mvhd) throw new Error('no mvhd');
    const mvTs = u32(moov, mvhd.body + (moov[mvhd.body] === 1 ? 20 : 12)) || 1000;
    const trex = new Map(), mvex = kid(moov, mv, 'mvex');
    if (mvex) kids(moov, mvex, 'trex').forEach((t) => trex.set(u32(moov, t.body + 4), { dur: u32(moov, t.body + 12), size: u32(moov, t.body + 16), flags: u32(moov, t.body + 20) }));
    const T = new Map();
    kids(moov, mv, 'trak').forEach((tr) => {
      const tkhd = kid(moov, tr, 'tkhd'), mdia = kid(moov, tr, 'mdia'); if (!tkhd || !mdia) return;
      const mdhd = kid(moov, mdia, 'mdhd'), hdlr = kid(moov, mdia, 'hdlr'), minf = kid(moov, mdia, 'minf');
      const stbl = minf && kid(moov, minf, 'stbl'), stsd = stbl && kid(moov, stbl, 'stsd');
      if (!mdhd || !minf || !stsd) return;
      const id = u32(moov, tkhd.body + (moov[tkhd.body] === 1 ? 20 : 12));
      T.set(id, {
        id, tr, tkhd, mdia, mdhd, hdlr, minf, stsd,
        ts: u32(moov, mdhd.body + (moov[mdhd.body] === 1 ? 20 : 12)) || 1, kind: hdlr ? fcc(moov, hdlr.body + 8) : '',
        dur: [], size: [], flags: [], cts: [], chunks: [], start: null, sum: 0,
      });
    });
    if (!T.size) throw new Error('no tracks');

    /* 3) đọc từng moof: mẫu (duration/size/flags/cts) + vị trí dữ liệu trong mdat */
    const gaps = []; let rel = 0;
    for (const f of frags) {
      const m = f.moof, mf = boxesOf(m)[0];
      for (const tf of kids(m, mf, 'traf')) {
        const tfhd = kid(m, tf, 'tfhd'); if (!tfhd) continue;
        const fl = u32(m, tfhd.body) & 0xffffff, id = u32(m, tfhd.body + 4), t = T.get(id); if (!t) continue;
        const tx = trex.get(id) || {};
        let p = tfhd.body + 8, dDur = tx.dur || 0, dSize = tx.size || 0, dFl = tx.flags || 0;
        if (fl & 1) p += 8;               // base_data_offset tuyệt đối của file gốc: không còn ý nghĩa sau khi ghép -> dùng đầu moof
        if (fl & 2) p += 4;
        if (fl & 8) { dDur = u32(m, p); p += 4; }
        if (fl & 16) { dSize = u32(m, p); p += 4; }
        if (fl & 32) { dFl = u32(m, p); p += 4; }
        const tfdt = kid(m, tf, 'tfdt');
        const bt = tfdt ? (m[tfdt.body] === 1 ? u64(m, tfdt.body + 4) : u32(m, tfdt.body + 4)) : null;
        if (t.start == null) t.start = bt != null ? bt : 0;
        else if (bt != null) {
          const exp = t.start + t.sum, gap = bt - exp;
          if (gap > Math.max(1, t.ts * 0.005)) {
            gaps.push({ track: t.kind, at: exp / t.ts, sec: gap / t.ts });
            if (fillGaps && t.dur.length) { t.dur[t.dur.length - 1] += gap; t.sum += gap; }
          }
        }
        let cur = f.moofO;
        for (const tr of kids(m, tf, 'trun')) {
          const tfl = u32(m, tr.body) & 0xffffff, ver = m[tr.body], n = u32(m, tr.body + 4);
          let q = tr.body + 8, doff = null, first = null;
          if (tfl & 1) { doff = u32(m, q) | 0; q += 4; }
          if (tfl & 4) { first = u32(m, q); q += 4; }
          const at = doff != null ? f.moofO + doff : cur;
          const si = t.size.length; let bytes = 0;
          for (let i = 0; i < n; i++) {
            let d = dDur, s = dSize, fg = dFl, c = 0;
            if (tfl & 0x100) { d = u32(m, q); q += 4; }
            if (tfl & 0x200) { s = u32(m, q); q += 4; }
            if (tfl & 0x400) { fg = u32(m, q); q += 4; }
            if (tfl & 0x800) { c = u32(m, q) | 0; q += 4; }
            if (i === 0 && first != null) fg = first;
            t.dur.push(d); t.size.push(s); t.flags.push(fg); t.cts.push(c); t.sum += d; bytes += s;
          }
          const r0 = at - f.ps;
          if (r0 < 0 || at + bytes > f.pe) throw new Error('bad data offset');
          if (n) t.chunks.push({ off: rel + r0, n, si });
          cur = at + bytes;
        }
      }
      rel += f.pe - f.ps;
    }
    const P = rel;                                     // tổng dung lượng mdat mới
    const tracks = [...T.values()].filter((t) => t.size.length);
    if (!tracks.length) throw new Error('no samples');

    /* 4) mốc bắt đầu từng track (giữ đúng độ lệch hình/tiếng) và tổng thời lượng */
    const minStart = Math.min(...tracks.map((t) => t.start / t.ts));
    let movieSec = 0;
    tracks.forEach((t) => { t.offSec = Math.max(0, t.start / t.ts - minStart); t.durSec = t.sum / t.ts; movieSec = Math.max(movieSec, t.offSec + t.durSec); });

    /* 5) dựng các bảng mẫu */
    const full = (type, ver, words) => { const o = new Uint8Array(12 + words.length * 4); put32(o, 0, o.length); for (let i = 0; i < 4; i++) o[4 + i] = type.charCodeAt(i); o[8] = ver; words.forEach((w, i) => put32(o, 12 + i * 4, w)); return o; };
    const rle = (arr) => { const out = []; for (let i = 0; i < arr.length; i++) { const l = out[out.length - 1]; if (l && l[1] === arr[i]) l[0]++; else out.push([1, arr[i]]); } return out; };
    const flat = (pairs) => { const w = [pairs.length]; pairs.forEach((p) => { w.push(p[0], p[1]); }); return w; };
    const big = P + 8 * tracks.reduce((a, t) => a + t.size.length, 0) + (1 << 20) > 4294967295;
    const hdr64 = P + 8 > 4294967295;

    function stblOf(t, delta) {
      const parts = [moov.slice(t.stsd.start, t.stsd.end)];
      parts.push(full('stts', 0, flat(rle(t.dur))));
      if (t.cts.some((c) => c !== 0)) {
        const neg = t.cts.some((c) => c < 0), pr = rle(t.cts), w = [pr.length];
        pr.forEach((p) => { w.push(p[0], p[1]); });
        parts.push(full('ctts', neg ? 1 : 0, w));
      }
      if (t.kind === 'vide') {
        let sync = t.flags.map((fg) => !((fg >>> 16) & 1));
        if (new Set(t.flags).size === 1) { sync = t.flags.map(() => false); t.chunks.forEach((c) => { sync[c.si] = true; }); } // không có cờ: coi mẫu đầu mỗi đoạn là keyframe
        const idx = []; sync.forEach((s, i) => { if (s) idx.push(i + 1); });
        if (idx.length && idx.length < sync.length) parts.push(full('stss', 0, [idx.length].concat(idx)));
      }
      const sc = []; let lastN = -1;
      t.chunks.forEach((c, i) => { if (c.n !== lastN) { sc.push(i + 1, c.n, 1); lastN = c.n; } });
      parts.push(full('stsc', 0, [sc.length / 3].concat(sc)));
      parts.push(full('stsz', 0, [0, t.size.length].concat(t.size)));
      if (!big) parts.push(full('stco', 0, [t.chunks.length].concat(t.chunks.map((c) => c.off + delta))));
      else {
        const o = new Uint8Array(16 + t.chunks.length * 8); put32(o, 0, o.length); o.set(A('co64'), 4); put32(o, 12, t.chunks.length);
        t.chunks.forEach((c, i) => { const v = c.off + delta; put32(o, 16 + i * 8, Math.floor(v / 4294967296)); put32(o, 20 + i * 8, v % 4294967296); });
        parts.push(o);
      }
      return mkBox('stbl', parts);
    }
    function moovOf(delta) {
      const kidsOut = [];
      const mvh = moov.slice(mvhd.start, mvhd.end), v1 = mvh[8] === 1;
      setDur(mvh, 8 + (v1 ? 24 : 16), v1, Math.round(movieSec * mvTs));
      kidsOut.push(mvh);
      tracks.forEach((t) => {
        const tkhd = moov.slice(t.tkhd.start, t.tkhd.end), tv1 = tkhd[8] === 1;
        setDur(tkhd, 8 + (tv1 ? 28 : 20), tv1, Math.round((t.offSec + t.durSec) * mvTs));
        const tk = [tkhd];
        if (t.offSec > 0.0005) {
          tk.push(mkBox('edts', [full('elst', 0, [2, Math.round(t.offSec * mvTs), -1, 0x10000, Math.round(t.durSec * mvTs), 0, 0x10000])]));
        }
        const mdhd = moov.slice(t.mdhd.start, t.mdhd.end), mv1 = mdhd[8] === 1;
        setDur(mdhd, 8 + (mv1 ? 24 : 16), mv1, t.sum);
        const mi = [];
        boxesOf(moov, t.minf.body, t.minf.end).forEach((b) => { if (b.type !== 'stbl') mi.push(moov.slice(b.start, b.end)); });
        mi.push(stblOf(t, delta));
        const md = [mdhd]; if (t.hdlr) md.push(moov.slice(t.hdlr.start, t.hdlr.end)); md.push(mkBox('minf', mi));
        tk.push(mkBox('mdia', md));
        kidsOut.push(mkBox('trak', tk));
      });
      return mkBox('moov', kidsOut);
    }

    /* 6) ghép file: ftyp + moov (đầu file) + mdat (các phần dữ liệu gốc, không sao chép vào RAM) */
    const ftyp = mkBox('ftyp', [A('isom'), W32(512), A('isom'), A('iso2'), A('avc1'), A('mp41')]);
    const mh = hdr64 ? 16 : 8;
    const len0 = moovOf(0).length;                    // độ dài moov không phụ thuộc giá trị offset
    const out = moovOf(ftyp.length + len0 + mh);
    const mdatHdr = new Uint8Array(mh);
    if (hdr64) { put32(mdatHdr, 0, 1); mdatHdr.set(A('mdat'), 4); put32(mdatHdr, 8, Math.floor((P + 16) / 4294967296)); put32(mdatHdr, 12, (P + 16) % 4294967296); }
    else { put32(mdatHdr, 0, P + 8); mdatHdr.set(A('mdat'), 4); }
    const blob = new Blob([ftyp, out, mdatHdr].concat(frags.map((f) => src.slice(f.ps, f.pe))), { type: 'video/mp4' });
    return { blob, dur: movieSec, gaps, tracks: tracks.map((t) => ({ kind: t.kind, samples: t.size.length, sec: t.durSec })) };
  }



  function hookNetwork() {
    const put = (obj, name, fn) => {
      try { obj[name] = typeof exportFunction === 'function' ? exportFunction(fn, W) : fn; }
      catch (_) { try { obj[name] = fn; } catch (__) {} }
    };
    hookMse(put);
    try {
      const origFetch = W.fetch;
      if (typeof origFetch === 'function') {
        put(W, 'fetch', function (input) {
          const p = origFetch.apply(this, arguments);
          try {
            const reqUrl = typeof input === 'string' ? input : (input && input.url) || String(input);
            p.then((res) => {
              try {
                sniff(res.url || reqUrl, res.headers.get('content-type'), res.headers.get('content-length'), res.headers.get('content-range'), res.status);
              } catch (_) {}
              try { if (TAP.on && res.status >= 400) tapErr(res.status, res.url || reqUrl); } catch (_) {}
              try { tapFetch(res, reqUrl); } catch (_) {}
            }, (e) => { try { if (TAP.on && !(e && e.name === 'AbortError')) tapErr(0, reqUrl); } catch (_) {} });
          } catch (_) {}
          return p;
        });
      }
    } catch (_) {}
    try {
      const XP = W.XMLHttpRequest.prototype;
      const oOpen = XP.open, oSend = XP.send;
      put(XP, 'open', function (m, url) {
        try { this.__tcu = String(url); } catch (_) {}
        return oOpen.apply(this, arguments);
      });
      put(XP, 'send', function () {
        try {
          this.addEventListener('readystatechange', function () {
            if (this.readyState === 2) {
              try {
                sniff(this.responseURL || this.__tcu, this.getResponseHeader('content-type'), this.getResponseHeader('content-length'), this.getResponseHeader('content-range'), this.status);
              } catch (_) {}
            } else if (this.readyState === 4) {
              try { if (TAP.on && this.status >= 400) tapErr(this.status, this.responseURL || this.__tcu); } catch (_) {}
              try { tapXhr(this); } catch (_) {}
            }
          });
        } catch (_) {}
        return oSend.apply(this, arguments);
      });
    } catch (_) {}
    // Resource Timing: bắt cả những gì thẻ <video>/<img>/CSS tự tải
    try {
      const po = new PerformanceObserver((list) => {
        list.getEntries().forEach((e) => {
          const t = e.initiatorType;
          record(e.name, {
            from: 'perf',
            size: e.encodedBodySize || e.decodedBodySize || null,
            type: t === 'video' || t === 'audio' ? t : (t === 'img' ? 'image' : undefined),
          });
        });
      });
      po.observe({ type: 'resource', buffered: true });
    } catch (_) {}
  }

  function scanDom() {
    try {
      document.querySelectorAll('video,audio').forEach((m) => {
        const kind = m.tagName.toLowerCase();
        if (!typeOn(kind)) return;
        [m.currentSrc, m.src].concat([].map.call(m.querySelectorAll('source'), (s) => s.src))
          .forEach((u) => { if (u && /^https?:/.test(u)) record(u, { type: kind }); });
      });
      document.querySelectorAll('img').forEach((i) => {
        if (!SET.image) return;
        if (i.naturalWidth >= 120 && i.naturalHeight >= 120) {
          const u = i.currentSrc || i.src;
          if (u && /^https?:/.test(u)) record(u, { type: 'image', w: i.naturalWidth, h: i.naturalHeight });
        }
      });
    } catch (_) {}
  }

  /* =====================================================================
   *  DÒ DUNG LƯỢNG / HLS / TẢI
   * ===================================================================== */
  // Bản fetch gốc của trang, lấy trước khi bị hook: yêu cầu đi ra với đúng Origin/Referer/cookie của trang,
  // giống hệt cách trình phát (hls.js...) tự tải đoạn video -> thường qua được 403 mà GM_xmlhttpRequest bị chặn.
  let NATIVE_FETCH = null;
  async function pageFetch(opts) {
    const hdr = {};
    Object.keys(opts.headers || {}).forEach((k) => { if (/^(range|accept)$/i.test(k)) hdr[k] = opts.headers[k]; });
    const r = await NATIVE_FETCH(opts.url, { credentials: 'include', headers: hdr, cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    let hs = '';
    r.headers.forEach((v, k) => { hs += k + ': ' + v + '\r\n'; });
    const out = { status: r.status, finalUrl: r.url, responseHeaders: hs };
    if (opts.responseType === 'arraybuffer') out.response = await r.arrayBuffer();
    else { out.responseText = await r.text(); out.response = out.responseText; }
    return out;
  }
  function gm(opts) {
    return gmReq(opts).catch((err) => {
      if (!NATIVE_FETCH || !/HTTP 40[13]|Network error/.test((err && err.message) || '')) throw err;
      return pageFetch(opts).then((r) => { gm.viaPage = (gm.viaPage || 0) + 1; return r; }, () => { throw err; });
    });
  }
  function gmReq(opts) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== 'function') return reject(new Error('GM_xmlhttpRequest is missing'));
      GM_xmlhttpRequest(Object.assign({ method: 'GET', timeout: 60000 }, opts, {
        headers: Object.assign({ Referer: location.href }, opts.headers),
        onload: (r) => (r.status >= 400 ? reject(new Error('HTTP ' + r.status)) : resolve(r)),
        onerror: () => reject(new Error('Network error')),
        ontimeout: () => reject(new Error('Request timed out')),
      }));
    });
  }

  function parseMaster(txt, it) {
    const lines = txt.split(/\r?\n/).map((s) => s.trim());
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith('#EXT-X-STREAM-INF:')) continue;
      const a = attrs(lines[i].slice(18));
      let j = i + 1;
      while (j < lines.length && (!lines[j] || lines[j].startsWith('#'))) j++;
      if (!lines[j]) continue;
      const res = a.RESOLUTION ? a.RESOLUTION.split('x')[1] + 'p' : '';
      const bw = +(a['AVERAGE-BANDWIDTH'] || a.BANDWIDTH) || 0;
      const v = buildItem(new URL(lines[j], it.url).href, {
        type: 'hls', q: res || (bw ? Math.round(bw / 1000) + ' kbps' : ''), bw, ref: it.ref, title: it.title,
        yt: it.yt ? { vid: it.yt.vid, ua: '', rank: it.yt.rank, tag: (res || 'HLS') + ' HLS' } : undefined,
      });
      if (v) out.push(v);
    }
    return out.sort((a, b) => b.bw - a.bw);
  }

  function parseMedia(txt, base) {
    const lines = txt.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    let seq = 0, key = null, map = null, dur = 0, pend = 0;
    const segs = [];
    for (const ln of lines) {
      if (ln.startsWith('#EXT-X-MEDIA-SEQUENCE:')) seq = +ln.split(':')[1] || 0;
      else if (ln.startsWith('#EXT-X-KEY:')) {
        const a = attrs(ln.slice(11));
        key = a.METHOD === 'NONE' ? null : { method: a.METHOD, uri: a.URI ? new URL(a.URI, base).href : '', iv: a.IV };
      } else if (ln.startsWith('#EXT-X-MAP:')) {
        const a = attrs(ln.slice(11));
        if (a.URI) map = new URL(a.URI, base).href;
      } else if (ln.startsWith('#EXTINF:')) pend = parseFloat(ln.slice(8)) || 0;
      else if (!ln.startsWith('#')) {
        segs.push({ url: new URL(ln, base).href, key, seq: seq + segs.length, d: pend });
        dur += pend; pend = 0;
      }
    }
    return { segs, map, dur };
  }

  async function probeHls(it) {
    const r = await gm({ url: it.url, responseType: 'text', headers: { Referer: it.ref } });
    const txt = r.responseText || '';
    if (!/^#EXTM3U/m.test(txt)) return { bad: true };
    if (/#EXT-X-STREAM-INF/.test(txt)) {
      const vs = parseMaster(txt, it);
      if (!vs.length) return { bad: true };
      hlsVariants.set(it.key, vs);
      return { master: true };
    }
    const pm = parseMedia(txt, it.url);
    if (!pm.segs.length) return { bad: true };
    const out = { dur: pm.dur, ext: pm.map ? 'mp4' : 'ts' };
    if (pm.segs.some((s) => s.key && s.key.method !== 'AES-128')) out.drm = true;
    if (it.bw && pm.dur) { out.size = Math.round((it.bw / 8) * pm.dur); out.approx = true; }
    return out;
  }

  function probeHttp(it) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (r) => {
        if (done) return;
        done = true;
        const hd = parseHeaders(r && r.responseHeaders);
        const out = {};
        let size = 0;
        const m = /\/(\d+)\s*$/.exec(hd['content-range'] || '');
        if (m) size = +m[1];
        else if (r && r.status === 200) size = +hd['content-length'] || 0;
        if (size) out.size = size;
        if (hd['content-type']) {
          out.mime = hd['content-type'].split(';')[0].trim().toLowerCase();
          if (r && r.status < 400 && /^(text\/|application\/json)/.test(out.mime)) out.bad = true;
          if (!out.bad && MIME_EXT[out.mime]) out.ext = MIME_EXT[out.mime];
        }
        resolve(out);
      };
      try {
        const req = GM_xmlhttpRequest({
          method: 'GET', url: it.url, timeout: 15000, responseType: 'arraybuffer',
          headers: { Referer: it.ref, Range: 'bytes=0-0' },
          onreadystatechange: (r) => { if (r.readyState >= 2) { finish(r); try { req && req.abort(); } catch (_) {} } },
          onload: finish, onerror: () => finish(null), ontimeout: () => finish(null),
        });
      } catch (_) { finish(null); }
    });
  }

  const inflight = new Set();
  async function probe(it) {
    if (inflight.has(it.key) || (cache.get(it.key) || {}).probed) return;
    inflight.add(it.key);
    let res = {};
    try {
      if (it.type === 'hls') res = await probeHls(it);
      else if (it.url.startsWith('data:')) {
        const i = it.url.indexOf(',');
        res = { size: Math.floor((it.url.length - i - 1) * (/;base64/.test(it.url.slice(0, i)) ? 0.75 : 1)) };
      } else if (it.url.startsWith('blob:')) {
        const b = await (await fetch(it.url)).blob();
        res = { size: b.size, mime: b.type };
      } else res = await probeHttp(it);
    } catch (_) { if (it.url.startsWith('blob:')) res = { bad: true }; }
    res.probed = true;
    cache.set(it.key, Object.assign(cache.get(it.key) || {}, res));
    inflight.delete(it.key);
  }
  const pq = [];
  let pActive = 0;
  function enqueueProbe(it) {
    return new Promise((resolve) => { pq.push([it, resolve]); pump(); });
  }
  function pump() {
    while (pActive < CFG.PROBE_PARALLEL && pq.length) {
      const [it, resolve] = pq.shift();
      pActive++;
      probe(it).then(() => { pActive--; resolve(); pump(); });
    }
  }
  function applyCache(it) {
    const c = cache.get(it.key);
    if (!c) return it;
    ['size', 'mime', 'bad', 'drm', 'approx', 'master', 'probed', 'dur'].forEach((k) => { if (c[k] !== undefined) it[k] = c[k]; });
    if (c.ext && !it.ext) it.ext = c.ext;
    if (it.type === 'hls' && c.ext) it.ext = c.ext;
    return it;
  }

  /* ---------- Tên file ---------- */
  function baseName(it) {
    let n = '';
    if (/^https?:/.test(it.url)) {
      try { n = decodeURIComponent(new URL(it.url).pathname.split('/').filter(Boolean).pop() || ''); } catch (_) {}
      n = n.replace(/\.[a-z0-9]{2,5}$/i, '');
    }
    const generic = !n || n.length < 3 || n.length > 80 ||
      /^(index|playlist|master|video|audio|stream|chunk|media|file|download|image|img|play|manifest)$/i.test(n) ||
      /^[0-9a-f-]{24,}$/i.test(n);
    if (it.yt) return sanitize((it.title || 'youtube') + (it.yt.tag ? ' [' + it.yt.tag + ']' : '')) || 'youtube';
    if (generic || it.type === 'hls') n = (it.title || '').trim() || n || location.hostname;
    return sanitize(n) || 'toancreator';
  }
  const extFor = (it) => it.ext || DEFAULT_EXT[it.type] || 'bin';
  const fileName = (it) => baseName(it) + '.' + extFor(it);
  function finalName(it, raw) {
    let n = sanitize(raw) || fileName(it);
    if (!/\.[a-z0-9]{2,5}$/i.test(n)) n += '.' + extFor(it);
    return n;
  }

  /* ---------- Tải xuống ---------- */
  function saveBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.rel = 'noopener';
    a.style.display = 'none';
    (document.body || document.documentElement).appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 60000);
  }

  function toast(msg, ms) { ui().toast(msg, ms === undefined ? 3000 : ms); }

  const BIG_FILE = 400 * 1024 * 1024; // file lớn hơn mức này ưu tiên GM_download (ghi thẳng ra đĩa)

  function directDownload(it, name) {
    return new Promise((resolve, reject) => {
      let finished = false;
      const ok = () => { if (!finished) { finished = true; resolve(); } };
      const fail = (e) => {
        if (finished) return;
        finished = true;
        reject(e instanceof Error ? e : new Error(String((e && (e.error || e.details)) || e || 'Unknown error')));
      };
      const progress = (loaded, total) => {
        if (!finished && total > 0) toast('Downloading ' + name + ' – ' + Math.round((loaded / total) * 100) + '%', 0);
      };

      if (/^(blob|data):/.test(it.url)) {
        fetch(it.url).then((r) => r.blob()).then((b) => { saveBlob(b, name); ok(); }).catch(fail);
        return;
      }

      // Cách 1: tải bytes bằng GM_xmlhttpRequest rồi lưu qua thẻ <a download>
      const viaBlob = () => {
        gm({
          url: it.url, responseType: 'arraybuffer', timeout: 0, headers: { Referer: it.ref },
          onprogress: (p) => progress(p.loaded, p.total),
        }).then((r) => {
          const buf = r.response;
          if (!buf || !buf.byteLength) throw new Error('The server returned empty data');
          const mime = (parseHeaders(r.responseHeaders)['content-type'] || '').split(';')[0].trim().toLowerCase();
          if (/^text\/html/.test(mime)) throw new Error('The server returned a web page instead of a file (login may be required, or hotlinking is blocked)');
          saveBlob(new Blob([buf], { type: mime || it.mime || 'application/octet-stream' }), name);
          ok();
        }).catch((e) => { if (hasGM && !triedGM) viaGM(() => fail(e)); else fail(e); });
      };

      // Cách 2: GM_download của Tampermonkey
      let triedGM = false;
      const viaGM = (fallback) => {
        triedGM = true;
        try {
          GM_download({
            url: it.url, name, saveAs: false, headers: { Referer: it.ref },
            onload: ok,
            onprogress: (p) => progress(p && p.loaded, p && p.total),
            onerror: (e) => { if (fallback) fallback(); else fail(e); },
            ontimeout: () => { if (fallback) fallback(); else fail(new Error('Request timed out')); },
          });
        } catch (e) { if (fallback) fallback(); else fail(e); }
      };

      const hasGM = typeof GM_download === 'function';
      if (hasGM && it.size > BIG_FILE) viaGM(viaBlob);
      else viaBlob();
    });
  }

  async function decryptSeg(buf, seg, keys, ref) {
    const k = seg.key;
    if (!keys.has(k.uri)) {
      keys.set(k.uri, gm({ url: k.uri, responseType: 'arraybuffer', headers: { Referer: ref } })
        .then((r) => crypto.subtle.importKey('raw', r.response, 'AES-CBC', false, ['decrypt'])));
    }
    const ck = await keys.get(k.uri);
    const iv = new Uint8Array(16);
    if (k.iv) {
      const hex = k.iv.replace(/^0x/i, '').padStart(32, '0');
      for (let i = 0; i < 16; i++) iv[i] = parseInt(hex.substr(i * 2, 2), 16);
    } else new DataView(iv.buffer).setUint32(12, seg.seq >>> 0);
    return crypto.subtle.decrypt({ name: 'AES-CBC', iv }, ck, buf);
  }

  async function downloadHls(it, name) {
    let url = it.url;
    let txt = (await gm({ url, responseType: 'text', headers: { Referer: it.ref } })).responseText;
    if (/#EXT-X-STREAM-INF/.test(txt)) {
      const vs = parseMaster(txt, it);
      if (!vs.length) throw new Error('Empty playlist');
      url = vs[0].url;
      txt = (await gm({ url, responseType: 'text', headers: { Referer: it.ref } })).responseText;
    }
    const pm = parseMedia(txt, url);
    if (!pm.segs.length) throw new Error('No segments found');
    if (pm.segs.some((s) => s.key && s.key.method !== 'AES-128')) throw new Error('DRM-protected / unsupported encrypted stream');
    const getBuf = async (u) => (await gm({ url: u, responseType: 'arraybuffer', headers: { Referer: it.ref } })).response;
    const off = pm.map ? 1 : 0;
    const parts = new Array(pm.segs.length + off);
    if (pm.map) parts[0] = await getBuf(pm.map);
    const keys = new Map();
    let next = 0, done = 0;
    const worker = async () => {
      while (next < pm.segs.length) {
        const i = next++;
        const s = pm.segs[i];
        let buf = await getBuf(s.url);
        if (s.key) buf = await decryptSeg(buf, s, keys, it.ref);
        parts[i + off] = buf;
        done++;
        toast('Downloading HLS ' + Math.round((done / pm.segs.length) * 100) + '% (' + done + '/' + pm.segs.length + ')', 0);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CFG.HLS_PARALLEL, pm.segs.length) }, worker));
    saveBlob(new Blob(parts, { type: pm.map ? 'video/mp4' : 'video/mp2t' }), name);
  }

  // YouTube: tải theo từng khúc (Range) – tải một mạch dễ bị cắt/giới hạn tốc độ
  async function downloadYt(it, name) {
    const CH = 8 * 1024 * 1024;
    const hdr = { Referer: 'https://www.youtube.com/', Origin: 'https://www.youtube.com' };
    if (it.yt && it.yt.ua) hdr['User-Agent'] = it.yt.ua;
    const get = async (s, e) => {
      const want = e - s + 1;
      const r = await gm({
        url: it.url, responseType: 'arraybuffer', timeout: 0,
        headers: Object.assign({ Range: 'bytes=' + s + '-' + e }, hdr),
      }).catch(() => gm({ url: it.url + '&range=' + s + '-' + e, responseType: 'arraybuffer', timeout: 0, headers: hdr }));
      const len = r.response ? r.response.byteLength : 0;
      if (!len) throw new Error('The server returned empty data');
      return { buf: r.response, hd: parseHeaders(r.responseHeaders), want, len };
    };

    const first = await get(0, CH - 1);
    const m = /\/(\d+)\s*$/.exec(first.hd['content-range'] || '');
    const total = m ? +m[1] : (it.size || first.len);
    const ct = (first.hd['content-type'] || it.mime || 'application/octet-stream').split(';')[0].trim();
    if (/^text\//.test(ct)) throw new Error('YouTube returned an error page instead of a file (link expired or request denied)');
    if (first.len >= total) { saveBlob(new Blob([first.buf], { type: ct }), name); return; }

    const n = Math.ceil(total / CH);
    const parts = new Array(n);
    parts[0] = first.buf;
    let next = 1, done = 1;
    const worker = async () => {
      while (next < n) {
        const i = next++;
        const s = i * CH, e = Math.min(total, s + CH) - 1;
        const r = await get(s, e);
        if (r.len !== r.want) throw new Error('A downloaded chunk is missing data');
        parts[i] = r.buf;
        done++;
        toast('Downloading ' + name + ' – ' + Math.round((done / n) * 100) + '%', 0);
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, n - 1) }, worker));
    saveBlob(new Blob(parts, { type: ct }), name);
  }

  async function runDownload(it, name) {
    try {
      toast('Starting download: ' + name, 0);
      if (it.type === 'hls') await downloadHls(it, name);
      else if (it.yt) await downloadYt(it, name);
      else await directDownload(it, name);
      toast('✓ Downloaded: ' + name, 3500);
    } catch (e) {
      let msg = (e && e.message) || String(e);
      // Bị chặn (403/401/trang HTML) -> chuyển sang chế độ GHI HÌNH ngay trên trình phát
      if (/HTTP 40[13]|returned a web page/.test(msg) && it.type !== 'image' && it.type !== 'audio') {
        if (Rec.show({ name, url: it.url, auto: true })) {
          toast('✗ Blocked (' + (/HTTP (\d+)/.exec(msg) || [0, '403'])[1] + ') – capturing the stream through the player: the page will reload once…', 8000);
          return;
        }
      }
      if (it.yt && /HTTP 40[13]/.test(msg)) msg = 'Click "open in new tab" instead.';
      toast('✗ Download failed: ' + msg, 6000);
    }
  }

  /* =====================================================================
   *  YOUTUBE
   *  Trình phát YouTube dùng MediaSource (blob:) nên không thể fetch/tải trực tiếp từ thẻ <video>,
   *  còn các mảnh /videoplayback bắt được từ mạng chỉ là từng đoạn nhỏ.
   *  Ở đây ta hỏi API nội bộ của YouTube (youtubei) để lấy link googlevideo.com đầy đủ,
   *  rồi tải theo từng khúc (xem downloadYt).
   *  Nếu YouTube đổi cách hoạt động, chỉnh danh sách YT_CLIENTS bên dưới (phiên bản, user-agent).
   * ===================================================================== */
  const YT_CLIENTS = [
    {
      name: 'ANDROID_VR', id: 28,
      ua: 'com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
      ctx: {
        clientName: 'ANDROID_VR', clientVersion: '1.65.10', deviceMake: 'Oculus', deviceModel: 'Quest 3',
        osName: 'Android', osVersion: '12L', androidSdkVersion: 32,
      },
    },
    {
      // Safari + HLS: wiki PO Token của yt-dlp ghi web_safari có luồng m3u8 chưa bắt buộc PO token (có hình + tiếng, tới 1080p)
      name: 'WEB_SAFARI', id: 1, web: true, hlsOnly: true,
      ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.5 Safari/605.1.15,gzip(gfe)',
      ctx: { clientName: 'WEB', clientVersion: '2.20250925.01.00' },   // được thay bằng phiên bản thật của trang nếu đọc được
    },
    {
      name: 'IOS', id: 5,
      ua: 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)',
      ctx: {
        clientName: 'IOS', clientVersion: '20.10.4', deviceMake: 'Apple', deviceModel: 'iPhone16,2',
        osName: 'iPhone', osVersion: '18.3.2.22D82',
      },
    },
  ];
  const YT = { busy: new Map(), done: new Map(), err: '', note: '', TTL: 20 * 60 * 1000 };

  function ytVideoId() {
    if (!IS_YT) return '';
    try {
      const u = new URL(location.href);
      if (u.pathname === '/watch') return u.searchParams.get('v') || '';
      const m = /^\/(?:shorts|live|embed|v)\/([\w-]{11})/.exec(u.pathname);
      return m ? m[1] : '';
    } catch (_) { return ''; }
  }
  function ytCfg(k) { try { return (W.ytcfg && W.ytcfg.get && W.ytcfg.get(k)) || ''; } catch (_) { return ''; } }

  async function ytCall(c, vid) {
    const visitor = ytCfg('VISITOR_DATA');
    const ctx = Object.assign({}, c.ctx);
    if (c.web) ctx.clientVersion = ytCfg('INNERTUBE_CLIENT_VERSION') || ctx.clientVersion;   // đúng phiên bản web hiện tại của YouTube
    const client = Object.assign({ hl: 'en' }, ctx);
    if (visitor) client.visitorData = visitor;
    const headers = {
      'Content-Type': 'application/json', 'User-Agent': c.ua,
      'X-YouTube-Client-Name': String(c.id), 'X-YouTube-Client-Version': ctx.clientVersion,
      Origin: 'https://www.youtube.com', Referer: 'https://www.youtube.com/',
    };
    if (visitor) headers['X-Goog-Visitor-Id'] = visitor;
    const r = await gm({
      method: 'POST', url: 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false' + (c.web && ytCfg('INNERTUBE_API_KEY') ? '&key=' + ytCfg('INNERTUBE_API_KEY') : ''),
      timeout: 20000, anonymous: true, responseType: 'text', headers,
      data: JSON.stringify({
        videoId: vid, context: { client }, contentCheckOk: true, racyCheckOk: true,
        playbackContext: { contentPlaybackContext: Object.assign({ html5Preference: 'HTML5_PREF_WANTS' }, c.web && ytCfg('STS') ? { signatureTimestamp: ytCfg('STS') } : {}) },
      }),
    });
    let j;
    try { j = JSON.parse(r.responseText); } catch (_) { throw new Error('invalid response'); }
    const ps = j.playabilityStatus || {};
    if (ps.status && ps.status !== 'OK') throw new Error(String(ps.reason || ps.status));
    if (!j.streamingData) throw new Error('no stream data');
    return j;
  }

  // Phương án cuối: dùng dữ liệu trình phát của chính trang (có thể bị giới hạn tốc độ do tham số n)
  function ytPagePlayer(vid) {
    try {
      const p = W.document.getElementById('movie_player');
      let r = p && typeof p.getPlayerResponse === 'function' ? p.getPlayerResponse() : null;
      const ok = (x) => x && x.streamingData && x.videoDetails && x.videoDetails.videoId === vid;
      if (!ok(r)) r = W.ytInitialPlayerResponse;
      return ok(r) ? r : null;
    } catch (_) { return null; }
  }

  function ytFormats(resp, ua) {
    const sd = resp && resp.streamingData, out = [];
    if (!sd) return out;
    const add = (f, mux) => {
      if (!f || !f.url || f.type === 'FORMAT_STREAM_TYPE_OTF') return;   // bỏ định dạng mã hoá chữ ký / OTF
      const mime = String(f.mimeType || '');
      const aud = /^audio\//.test(mime);
      if (aud && f.audioTrack && f.audioTrack.audioIsDefault === false) return; // bỏ các bản lồng tiếng phụ
      out.push({
        url: f.url, mime, kind: aud ? 'aud' : (mux ? 'mux' : 'vid'), w: f.width, h: f.height || 0, fps: f.fps || 0,
        br: +(f.averageBitrate || f.bitrate) || 0, size: +f.contentLength || null, q: f.qualityLabel || '', ua,
      });
    };
    (sd.formats || []).forEach((f) => add(f, true));
    (sd.adaptiveFormats || []).forEach((f) => add(f, false));
    return out;
  }

  // Rút gọn: mỗi độ phân giải 1 bản (ưu tiên H.264/mp4), âm thanh tốt nhất của mỗi định dạng
  function ytPick(fs) {
    const rows = [];
    const box = (m) => (/webm/.test(m) ? 'webm' : 'mp4');
    const seen = new Set();
    fs.filter((f) => f.kind === 'mux').forEach((f) => {
      const k = f.h + box(f.mime);
      if (seen.has(k)) return;
      seen.add(k);
      const q = f.q || f.h + 'p';
      rows.push({ f, q, tag: q, note: 'Video + audio', rank: -(f.h || 0) });
    });
    // Video-only streams (no sound): one per resolution, MP4/H.264 preferred
    const vb = new Map();
    fs.filter((f) => f.kind === 'vid').forEach((f) => {
      const k = String(f.h);
      const score = (box(f.mime) === 'mp4' ? 2e12 : 0) + (/avc1/.test(f.mime) ? 1e12 : 0) + f.br;
      const c = vb.get(k);
      if (!c || score > c.score) vb.set(k, { f, score });
    });
    vb.forEach(({ f }) => {
      const q = f.q || f.h + 'p';
      rows.push({ f, q, tag: q + ' video-only', note: 'Video only (no sound)', rank: -(f.h || 0) + 0.5 });
    });
    const ab = new Map();
    fs.filter((f) => f.kind === 'aud').forEach((f) => {
      const k = box(f.mime), c = ab.get(k);
      if (!c || f.br > c.br) ab.set(k, f);
    });
    ab.forEach((f) => {
      const kb = Math.round(f.br / 1000);
      rows.push({ f, q: kb + ' kbps', tag: 'audio ' + kb + 'k', note: 'Audio only', rank: 3e6 - kb });
    });
    return rows;
  }

  function ytDrop(fn) {
    let n = 0;
    store.forEach((i, k) => {
      if (i.yt && fn(i.yt)) { store.delete(k); cache.delete(k); hlsVariants.delete(k); n++; }
    });
    return n;
  }
  function ytPurge(keep) {
    const n = ytDrop((y) => y.vid !== keep);
    YT.done.forEach((_, v) => { if (v !== keep) YT.done.delete(v); });
    if (n) bump();
  }
  function ytItems(vid) {
    return Array.from(store.values()).filter((i) => i.yt && i.yt.vid === vid)
      .sort((a, b) => a.yt.rank - b.yt.rank).map((i) => applyCache(Object.assign({}, i)));
  }

  // Thử 1 yêu cầu rất nhỏ (2 byte) để biết link có thật sự tải được không – YouTube trả 403 nếu client đó cần PO token
  async function ytAlive(f) {
    try {
      const hd = { Range: 'bytes=0-1', Referer: 'https://www.youtube.com/', Origin: 'https://www.youtube.com' };
      if (f.ua) hd['User-Agent'] = f.ua;
      const r = await gm({ url: f.url, responseType: 'arraybuffer', timeout: 12000, headers: hd });
      return !!(r.response && r.response.byteLength);
    } catch (_) { return false; }
  }

  async function ytFetch(vid) {
    const errs = [];
    const got = (await Promise.all(YT_CLIENTS.map((c) => ytCall(c, vid).then(
      (j) => ({ c, j }),
      (e) => { errs.push(c.name + ': ' + ((e && e.message) || e)); return null; },
    )))).filter(Boolean);

    let fs = [], hls = '', title = '';
    got.forEach(({ c, j }) => {
      if (!c.hlsOnly) fs = fs.concat(ytFormats(j, c.ua));
      if (!hls && j.streamingData.hlsManifestUrl) hls = j.streamingData.hlsManifestUrl;
      if (!title && j.videoDetails) title = j.videoDetails.title || '';
    });
    if (!fs.length && !hls) {
      const pr = ytPagePlayer(vid);
      if (pr) {
        fs = ytFormats(pr, navigator.userAgent);
        hls = pr.streamingData.hlsManifestUrl || '';
        title = (pr.videoDetails || {}).title || '';
      }
    }
    if (!fs.length && !hls) {
      YT.err = errs.length
        ? 'YouTube refused to provide links: ' + errs.join(' | ')
        : 'YouTube returned no directly downloadable formats (signature-encrypted, SABR-only playback, or a PO token is required).';
      try { console.warn('[ToanCreator]', YT.err); } catch (_) {}
      return false;
    }
    YT.err = '';
    title = (title || document.title.replace(/^\(\d+\)\s*/, '').replace(/\s*-\s*YouTube$/i, '')).trim();
    const ref = 'https://www.youtube.com/watch?v=' + vid;

    // Link nào YouTube chặn (403, cần PO token) thì ẩn đi để không đưa người dùng vào đường cụt
    let rows = ytPick(fs);
    YT.note = '';
    if (rows.length) {
      const alive = await Promise.all(rows.map((r) => ytAlive(r.f)));
      const good = rows.filter((_, i) => alive[i]);
      if (good.length) {
        if (good.length < rows.length) YT.note = 'hid ' + (rows.length - good.length) + ' format(s) blocked by YouTube (PO token required)';
        rows = good;
      } else if (hls) {
        YT.note = 'direct downloads are blocked by YouTube (PO token required), use HLS';
        rows = [];
      } else {
        YT.note = 'links may be blocked by YouTube (403)';
        rows.forEach((r) => { r.warn = true; });
      }
    }

    ytDrop((y) => y.vid === vid);   // làm mới: bỏ link cũ (đã hết hạn) của cùng video
    rows.forEach((r) => {
      const f = r.f;
      const it = record(f.url, {
        from: 'yt', type: f.kind === 'aud' ? 'audio' : 'video', mime: f.mime, size: f.size,
        q: r.q, w: f.w, h: f.h, note: r.warn ? '⚠ May be blocked by YouTube (403)' : r.note, ref, title,
        yt: { vid, ua: f.ua, rank: r.rank, tag: r.tag },
      });
      if (it) cache.set(it.key, Object.assign(cache.get(it.key) || {}, { probed: true }));
    });
    if (hls) {
      record(hls, {
        from: 'yt', type: 'hls', note: 'Multiple resolutions · video + audio', ref, title,
        yt: { vid, ua: '', rank: -1e6, tag: 'HLS' },
      });
    }
    return true;
  }

  function ytLoad() {
    const vid = ytVideoId();
    if (!vid) return Promise.resolve([]);
    ytPurge(vid);
    const t = YT.done.get(vid);
    if (t && Date.now() - t < YT.TTL) return Promise.resolve(ytItems(vid));
    if (YT.busy.has(vid)) return YT.busy.get(vid);
    const p = ytFetch(vid)
      .catch((e) => { YT.err = (e && e.message) || String(e); return false; })
      .then((ok) => {
        YT.busy.delete(vid);
        if (ok) YT.done.set(vid, Date.now());
        return ytItems(vid);
      });
    YT.busy.set(vid, p);
    return p;
  }

  // Theo dõi chuyển video (YouTube là SPA) -> dọn link cũ, tự nạp link mới để số trên nút luôn đúng
  let ytLast = '';
  function ytWatch() {
    const vid = ytVideoId();
    if (vid === ytLast) return;
    ytLast = vid;
    ytPurge(vid);
    if (vid && (SET.video || SET.audio)) setTimeout(() => { if (ytVideoId() === vid) ytLoad().catch(() => {}); }, 1200);
  }

  function ytRefresh(u, mode, tok) {
    u.setPanel(tok, { msg: 'Fetching list from YouTube…', busy: true });
    ytLoad().then((list) => {
      const o = { busy: false, msg: list.length ? '' : (YT.err || 'Could not get download links from YouTube yet.'), note: list.length ? YT.note : '' };
      if (mode === 'hover') o.base = list;
      u.setPanel(tok, o);
    });
  }

  // Mở bảng khi bấm nút nổi trên video/ảnh
  function openHover(t) {
    const u = ui();
    const vid = t.kind !== 'image' ? ytVideoId() : '';
    if (vid) {
      const tok = u.openPanel(ytItems(vid), 'hover');
      ytRefresh(u, 'hover', tok);
    } else u.openPanel(candidates(t), 'hover');
  }
  // Mở bảng "Tải xuống nhanh"
  function openAll() {
    const u = ui();
    const tok = u.openPanel([], 'all');
    if (ytVideoId()) ytRefresh(u, 'all', tok);
  }

  /* =====================================================================
   *  DỰNG GIAO DIỆN (Shadow DOM, không dùng innerHTML để tránh Trusted Types)
   * ===================================================================== */
  const NS = 'http://www.w3.org/2000/svg';
  function h(tag, props) {
    const el = document.createElement(tag);
    for (const k in props || {}) {
      const v = props[k];
      if (v === false || v == null) continue;
      if (k === 'class') el.className = v; else el.setAttribute(k, v);
    }
    for (let i = 2; i < arguments.length; i++) {
      const c = arguments[i];
      if (c != null) el.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return el;
  }
  function icon(d, size, sw) {
    const s = document.createElementNS(NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('width', size); s.setAttribute('height', size);
    s.setAttribute('fill', 'none'); s.setAttribute('stroke', '#fff');
    s.setAttribute('stroke-width', sw); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d);
    s.appendChild(p);
    return s;
  }
  const ARROW_DOWN = 'M12 5v14M6 13l6 6 6-6';
  const ICON_LINK = 'M15 3h6v6M10 14L21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6';

  const CSS = `
  :host{all:initial}
  :host{
    --ink:#fff;--ink-2:#eef2fb;--ink-3:#d6ddee;--accent:#92e6ff;
    --tint:rgba(14,18,32,.56);
    --rim:linear-gradient(135deg,rgba(255,255,255,.92),rgba(255,255,255,.08) 38%,rgba(255,255,255,.08) 62%,rgba(255,255,255,.66));
  }
  *,*::before,*::after{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
  button{font:inherit;color:inherit}
  svg{display:block;filter:drop-shadow(0 1px 1.5px rgba(0,0,0,.6))}

  /* ---------- Liquid glass: kính mờ + viền sáng + bóng nhẹ ---------- */
  .pill,.card,.toast,.welcome{
    color:var(--ink);text-shadow:0 1px 2px rgba(0,0,0,.45);
    background:
      radial-gradient(130% 100% at 10% -10%,rgba(255,255,255,.34),rgba(255,255,255,0) 55%),
      linear-gradient(165deg,rgba(255,255,255,.16),rgba(255,255,255,.02) 50%,rgba(255,255,255,.10)),
      var(--tint);
    -webkit-backdrop-filter:blur(24px) saturate(185%) brightness(.92);
    backdrop-filter:blur(24px) saturate(185%) brightness(.92);
    box-shadow:inset 0 1px 0 rgba(255,255,255,.55),inset 0 0 18px rgba(255,255,255,.08),
      0 12px 34px rgba(5,8,20,.26),0 2px 6px rgba(5,8,20,.16);
  }
  .pill::before,.card::before,.toast::before,.welcome::before{
    content:"";position:absolute;inset:0;border-radius:inherit;padding:1.5px;background:var(--rim);pointer-events:none;
    -webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);
    -webkit-mask-composite:xor;
    mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);
    mask-composite:exclude;
  }

  /* ---------- Nút nổi khi hover: khối vuông bo góc ---------- */
  .pill{position:fixed;z-index:1;left:0;top:0;width:44px;height:44px;padding:0;border:0;border-radius:15px;
    display:grid;place-items:center;cursor:pointer;user-select:none;
    opacity:0;transform:translateY(6px) scale(.94);pointer-events:none;
    transition:opacity .18s ease,transform .18s ease}
  .pill.show{opacity:1;transform:none;pointer-events:auto}
  .pill svg{transition:transform .18s ease}
  .pill:hover svg{transform:translateY(2px)}
  .pill:hover{--tint:rgba(14,18,32,.44)}

  /* ---------- Nút "Tải xuống nhanh": nền trong suốt, chữ trắng viền đen, ô vuông viền đen mỏng ---------- */
  .quick{position:fixed;z-index:1;top:65px;right:20px;width:44px;height:44px;padding:0;border:1px solid #000;border-radius:15px;
    display:grid;place-items:center;cursor:pointer;background:transparent;color:#fff;
    -webkit-tap-highlight-color:transparent;transition:transform .15s ease,background-color .15s ease;
    text-shadow:-1px -1px 0 #000,1px -1px 0 #000,-1px 1px 0 #000,1px 1px 0 #000,0 -1px 0 #000,0 1px 0 #000,-1px 0 0 #000,1px 0 0 #000}
  .quick:hover{transform:translateY(-1px);background:rgba(0,0,0,.14)}
  .num{font-size:19px;font-weight:800;line-height:1;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
  .num.sm{font-size:15px;letter-spacing:-.04em}

  /* ---------- Bảng chọn tệp ---------- */
  .backdrop{position:fixed;z-index:2;inset:0;display:none;align-items:center;justify-content:center;background:rgba(6,9,18,.18)}
  .backdrop.show{display:flex}
  .card{--tint:rgba(14,18,32,.66);position:relative;width:min(500px,94vw);max-height:min(80vh,640px);
    display:flex;flex-direction:column;border-radius:28px;overflow:hidden;animation:pop .2s ease}
  @keyframes pop{from{opacity:0;transform:scale(.96) translateY(6px)}to{opacity:1;transform:none}}
  .head{display:flex;align-items:center;gap:8px;padding:18px 16px 8px 20px}
  .fname{flex:1;min-width:0;background:transparent;border:0;border-bottom:1px solid rgba(255,255,255,.38);color:var(--ink);
    font-size:15px;font-weight:700;padding:6px 0;outline:none;text-overflow:ellipsis}
  .fname:focus{border-bottom-color:var(--accent)}
  .fname:disabled{opacity:.6}
  .x{width:32px;height:32px;border:0;border-radius:50%;background:rgba(255,255,255,.16);color:var(--ink);font-size:20px;
    line-height:1;cursor:pointer;box-shadow:inset 0 0 0 1px rgba(255,255,255,.3)}
  .x:hover{background:rgba(255,255,255,.28)}
  .trash{width:32px;height:32px;padding:0;border:0;border-radius:50%;background:rgba(255,255,255,.16);cursor:pointer;
    display:grid;place-items:center;box-shadow:inset 0 0 0 1px rgba(255,255,255,.3);transition:background-color .15s ease,transform .15s ease}
  .trash:hover{background:rgba(255,92,92,.5)}
  .trash:active{transform:scale(.92)}
  .trash:disabled{opacity:.5;cursor:not-allowed}
  .tabs{display:flex;gap:6px;padding:4px 20px 6px;flex-wrap:wrap}
  .tab{border:0;border-radius:999px;padding:6px 13px;font-size:12.5px;font-weight:700;cursor:pointer;
    background:rgba(255,255,255,.12);color:var(--ink);box-shadow:inset 0 0 0 1px rgba(255,255,255,.24)}
  .tab:hover{background:rgba(255,255,255,.2)}
  .tab.on{background:#fff;color:#0a1020;text-shadow:none;box-shadow:none}
  .list{overflow:auto;padding:6px 10px;display:flex;flex-direction:column;gap:2px;min-height:56px;
    scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.45) transparent}
  .row{display:flex;align-items:center;gap:12px;padding:11px 12px;border-radius:16px;cursor:pointer}
  .row:hover{background:rgba(255,255,255,.10)}
  .row.sel{background:rgba(255,255,255,.18);box-shadow:inset 0 0 0 1px rgba(255,255,255,.38)}
  .row input{appearance:none;-webkit-appearance:none;margin:0;flex:none;width:18px;height:18px;border-radius:50%;
    border:2px solid rgba(255,255,255,.85);display:grid;place-items:center;cursor:pointer;background:transparent}
  .row input::after{content:"";width:8px;height:8px;border-radius:50%;background:var(--accent);transform:scale(0);transition:transform .12s}
  .row input:checked{border-color:var(--accent)}
  .row input:checked::after{transform:scale(1)}
  .l{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
  .m{font-size:14px;font-weight:700;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .s{font-size:12px;color:var(--ink-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .r{flex:none;min-width:70px;text-align:right;font-size:13px;font-weight:700;color:var(--ink);font-variant-numeric:tabular-nums}
  /* Ô xem trước (bên trái dung lượng): ảnh thu nhỏ -> bấm xem full; video/âm thanh -> biểu tượng mở link */
  .thumb{flex:none;position:relative;width:44px;height:44px;padding:0;border:0;border-radius:12px;overflow:hidden;
    display:grid;place-items:center;cursor:pointer;background:rgba(255,255,255,.12)}
  .thumb.img{cursor:zoom-in}
  .thumb::after{content:"";position:absolute;inset:0;border-radius:inherit;box-shadow:inset 0 0 0 1px rgba(255,255,255,.34);pointer-events:none}
  .thumb:hover{background:rgba(255,255,255,.24)}
  .thumb img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block}
  .thumb svg{position:relative}
  .empty{padding:26px 14px;text-align:center;color:var(--ink-2);font-size:13px;line-height:1.55;white-space:pre-line}
  .foot{display:flex;align-items:center;gap:8px;padding:12px 18px 18px;border-top:1px solid rgba(255,255,255,.16)}
  .hint{flex:1;font-size:12px;color:var(--ink-3)}
  .btn{height:38px;padding:0 18px;border:0;border-radius:14px;font-weight:800;font-size:13.5px;cursor:pointer}
  .btn.ghost{background:rgba(255,255,255,.14);color:var(--ink);box-shadow:inset 0 0 0 1px rgba(255,255,255,.3)}
  .btn.ghost:hover{background:rgba(255,255,255,.24)}
  .btn.primary{background:rgba(255,255,255,.94);color:#0a1020;text-shadow:none;box-shadow:0 4px 14px rgba(0,0,0,.25)}
  .btn.primary:hover{background:#fff}
  .btn:disabled{opacity:.5;cursor:not-allowed}

  /* ---------- Settings dialog ---------- */
  .sback{z-index:3}
  .trash.gear:hover{background:rgba(255,255,255,.28)}
  .stitle{flex:1;min-width:0;font-size:16px;font-weight:800;padding:6px 0}
  .srow{display:flex;align-items:center;gap:12px;padding:12px;border-radius:16px;cursor:pointer}
  .srow:hover{background:rgba(255,255,255,.10)}
  .srow .s{white-space:normal}
  .srow input{appearance:none;-webkit-appearance:none;margin:0;flex:none;width:20px;height:20px;border-radius:6px;
    border:2px solid rgba(255,255,255,.85);display:grid;place-items:center;cursor:pointer;background:transparent}
  .srow input::after{content:"";width:10px;height:10px;border-radius:3px;background:var(--accent);transform:scale(0);transition:transform .12s}
  .srow input:checked{border-color:var(--accent)}
  .srow input:checked::after{transform:scale(1)}

  /* ---------- Xem ảnh full: nền mờ xung quanh, bấm ra ngoài để đóng ---------- */
  .lb{position:fixed;z-index:3;inset:0;display:none;align-items:center;justify-content:center;padding:4vmin;cursor:zoom-out;
    background:rgba(6,9,18,.55);-webkit-backdrop-filter:blur(22px) saturate(140%);backdrop-filter:blur(22px) saturate(140%)}
  .lb.show{display:flex;animation:fade .16s ease}
  @keyframes fade{from{opacity:0}to{opacity:1}}
  .lb img{max-width:100%;max-height:100%;object-fit:contain;border-radius:14px;cursor:default;opacity:0;
    box-shadow:0 20px 60px rgba(0,0,0,.5)}
  .lb img.ok{opacity:1}
  .lbmsg{position:absolute;color:#fff;font-size:14px;font-weight:600;text-shadow:0 1px 3px rgba(0,0,0,.6)}

  /* ---------- Bảng chào mừng (chỉ hiện 1 lần duy nhất) ---------- */
  .wback{position:fixed;z-index:5;inset:0;display:none;align-items:center;justify-content:center;background:rgba(6,9,18,.18)}
  .wback.show{display:flex;animation:fade .25s ease}
  .welcome{--tint:rgba(14,18,32,.62);position:relative;width:min(300px,86vw);padding:30px 24px 28px;border-radius:30px;
    display:flex;flex-direction:column;align-items:center;gap:6px;text-align:center;animation:pop .3s ease}
  .wtitle{font-size:22px;font-weight:800;letter-spacing:-.02em}
  .wsub{font-size:15px;font-weight:600;color:var(--ink-2)}
  .wcheck{margin-top:16px;width:64px;height:64px;border-radius:50%;display:grid;place-items:center;font-size:32px;font-weight:800;line-height:1;
    color:#fff;background:radial-gradient(120% 100% at 30% 0%,rgba(255,255,255,.4),rgba(255,255,255,.08) 60%),rgba(146,230,255,.28);
    box-shadow:inset 0 0 0 1.5px rgba(255,255,255,.65),inset 0 1px 0 rgba(255,255,255,.7),0 8px 22px rgba(5,8,20,.3);
    animation:wpop .5s cubic-bezier(.2,1.4,.4,1) .15s both}
  @keyframes wpop{from{opacity:0;transform:scale(.4)}to{opacity:1;transform:none}}

  /* ---------- Thông báo ---------- */
  .toast{position:fixed;z-index:4;left:16px;bottom:16px;max-width:min(380px,90vw);padding:12px 16px;border-radius:18px;
    font-size:13px;font-weight:600;opacity:0;transform:translateY(8px);pointer-events:none;
    transition:opacity .2s,transform .2s;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .toast.show{opacity:1;transform:none}

  /* ---------- Truy cập được: viền focus rõ, giảm chuyển động ---------- */
  .pill:focus-visible,.quick:focus-visible,.btn:focus-visible,.tab:focus-visible,.x:focus-visible,.trash:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
  @media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}

  /* Trình duyệt không hỗ trợ backdrop-filter -> dùng nền đặc hơn để chữ vẫn rõ */
  @supports not ((backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px))){
    .pill,.card,.toast,.welcome{--tint:rgba(18,22,36,.94)}
  }
  `;

  let UI = null;
  const ui = () => UI || (UI = createUI());

  // Lần đầu dùng tiện ích: hiện bảng chào mừng 5 giây, ghi cờ ngay khi hiện nên không bao giờ hiện lại
  function maybeWelcome() {
    const KEY = 'tc_welcome_seen';
    let seen = false;
    try { if (typeof GM_getValue === 'function') seen = !!GM_getValue(KEY, false); } catch (_) {}
    if (seen) return;
    try { if (typeof GM_setValue === 'function') GM_setValue(KEY, 1); } catch (_) {}
    ui().showWelcome();
  }

  // trạng thái hover dùng chung
  const HV = { cur: null, overUI: false, hideT: null };
  function hvClear() { if (HV.hideT) { clearTimeout(HV.hideT); HV.hideT = null; } }
  function hvSched() {
    if (HV.hideT || HV.overUI || !UI || UI.panelOpen()) return;
    HV.hideT = setTimeout(() => {
      HV.hideT = null;
      if (!HV.overUI && UI && !UI.panelOpen()) { UI.hidePill(); HV.cur = null; }
    }, CFG.IDLE_MS);
  }

  function createUI() {
    const host = document.createElement('div');
    host.id = 'toancreator-host';
    host.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;';
    const root = host.attachShadow({ mode: 'closed' });
    try { const sh = new CSSStyleSheet(); sh.replaceSync(CSS); root.adoptedStyleSheets = [sh]; }
    catch (_) { const st = document.createElement('style'); st.textContent = CSS; root.append(st); }

    /* ----- nút nổi khi hover ----- */
    const pill = h('button', { class: 'pill', type: 'button', title: 'Download', 'aria-label': 'Download' },
      icon(ARROW_DOWN, 22, 3));

    /* ----- bảng chọn file ----- */
    const fname = h('input', { class: 'fname', type: 'text', spellcheck: 'false', maxlength: '160' });
    const btnX = h('button', { class: 'x', title: 'Close' }, '×');
    const ICON_TRASH = 'M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6';
    const btnTrash = h('button', { class: 'trash', type: 'button', title: 'Clear all captured images/videos/audio to reduce lag', 'aria-label': 'Clear all captured files' },
      icon(ICON_TRASH, 17, 2));
    const ICON_SLIDERS = 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6';
    const btnSet = h('button', { class: 'trash gear', type: 'button', title: 'Settings', 'aria-label': 'Settings' },
      icon(ICON_SLIDERS, 17, 2));
    const tabs = h('div', { class: 'tabs' });
    const list = h('div', { class: 'list' });
    const hint = h('div', { class: 'hint' }, '');
    const btnClose = h('button', { class: 'btn ghost' }, 'Close');
    const btnDl = h('button', { class: 'btn primary' }, 'Download');
    const card = h('div', { class: 'card', role: 'dialog' },
      h('div', { class: 'head' }, fname, btnSet, btnTrash, btnX), tabs, list, h('div', { class: 'foot' }, hint, btnClose, btnDl));
    const backdrop = h('div', { class: 'backdrop' }, card);

    /* ----- settings dialog ----- */
    const SET_ROWS = [
      ['menu', 'Menu Box', 'Show the square quick-download button in the top-right corner'],
      ['image', 'Fetch Image', 'Detect images and show the download button when hovering over them'],
      ['audio', 'Fetch Audio', 'Detect audio files and list them in the download panel'],
      ['video', 'Fetch Video', 'Detect videos (incl. HLS) and show the download button when hovering over them'],
    ];
    const sChecks = {};
    const sList = h('div', { class: 'list' });
    SET_ROWS.forEach(([k, title, sub]) => {
      const cb = h('input', { type: 'checkbox' });
      cb.checked = !!SET[k];
      cb.addEventListener('change', () => setSetting(k, cb.checked));
      sChecks[k] = cb;
      sList.append(h('label', { class: 'srow' }, cb, h('div', { class: 'l' }, h('div', { class: 'm' }, title), h('div', { class: 's' }, sub))));
    });
    const sX = h('button', { class: 'x', type: 'button', title: 'Close' }, '×');
    const sDone = h('button', { class: 'btn primary', type: 'button' }, 'Done');
    const sCard = h('div', { class: 'card', role: 'dialog', 'aria-label': 'Settings' },
      h('div', { class: 'head' }, h('div', { class: 'stitle' }, 'Settings'), sX),
      sList,
      h('div', { class: 'foot' }, h('div', { class: 'hint' }, 'Changes are saved automatically.'), sDone));
    const sBack = h('div', { class: 'backdrop sback' }, sCard);

    /* ----- nút "Tải xuống nhanh" ----- */
    const num = h('span', { class: 'num' }, '0');
    const quick = h('button', { class: 'quick', type: 'button', title: 'Quick download', 'aria-label': 'Quick download' }, num);
    if (IS_YT) quick.style.top = '100px';   // né thanh đầu trang của YouTube (avatar, chuông thông báo)
    const toastEl = h('div', { class: 'toast' });

    /* ----- bảng chào mừng lần đầu ----- */
    const welcome = h('div', { class: 'welcome', role: 'dialog', 'aria-label': 'Media downloader' },
      h('div', { class: 'wtitle' }, 'Media downloader'),
      h('div', { class: 'wsub' }, 'ToanCreator'),
      h('div', { class: 'wcheck' }, '✓'));
    const wback = h('div', { class: 'wback' }, welcome);

    /* ----- xem ảnh full ----- */
    let lbImg = h('img', { alt: '' });
    const lbMsg = h('div', { class: 'lbmsg' }, 'Loading image…');
    const lightbox = h('div', { class: 'lb', role: 'dialog', 'aria-label': 'Image viewer' }, lbMsg, lbImg);

    root.append(pill, backdrop, sBack, lightbox, toastEl, wback);
    (document.documentElement).appendChild(host);

    // Không để sự kiện lọt ra trang (tránh trang tự đóng popup, phím tắt...)
    [pill, backdrop, sBack, lightbox, quick, toastEl, wback].forEach((n) =>
      ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend', 'dblclick', 'contextmenu']
        .forEach((ev) => n.addEventListener(ev, (e) => e.stopPropagation())));
    ['keydown', 'keyup', 'keypress'].forEach((ev) => { backdrop.addEventListener(ev, (e) => e.stopPropagation()); sBack.addEventListener(ev, (e) => e.stopPropagation()); });

    /* ================= PILL ================= */
    let tgt = null;
    function place() {
      if (!tgt || !tgt.el.isConnected) return false;
      const r = tgt.el.getBoundingClientRect();
      const vw = window.innerWidth, vh = window.innerHeight;
      const l = Math.max(r.left, 0), rt = Math.min(r.right, vw), b = Math.min(r.bottom, vh);
      if (rt - l < 40 || b - Math.max(r.top, 0) < 24) return false;
      const pw = pill.offsetWidth || 44, ph = pill.offsetHeight || 44;
      let x = (l + rt) / 2 - pw / 2;                       // căn giữa theo chiều ngang của phần tử
      let y = r.bottom + 8;                                // nằm ngay bên dưới phần tử
      if (y + ph > vh - 6) y = b - ph - (tgt.kind === 'video' ? 58 : 12); // hết chỗ -> đặt sát đáy bên trong
      x = Math.min(Math.max(6, x), vw - pw - 6);
      y = Math.min(Math.max(6, y), vh - ph - 6);
      pill.style.left = x + 'px';
      pill.style.top = y + 'px';
      return true;
    }
    function showPill(el, kind) {
      if (isFs()) { hidePill(); return; }   // đang xem toàn màn hình -> không làm phiền
      tgt = { el, kind };
      if (place()) pill.classList.add('show'); else pill.classList.remove('show');
    }
    function hidePill() { pill.classList.remove('show'); }
    function reposition() {
      if (!tgt || !pill.classList.contains('show')) return;
      if (!place()) hidePill();
    }
    pill.addEventListener('mouseenter', () => { HV.overUI = true; hvClear(); });
    pill.addEventListener('mouseleave', () => { HV.overUI = false; hvSched(); });
    pill.addEventListener('click', () => { if (HV.cur) openHover(HV.cur); });

    /* ================= PANEL ================= */
    const P = { open: false, mode: 'hover', filter: 'all', base: [], items: [], sel: null, rows: new Map(), edited: {}, msg: '', note: '', busy: false, tok: 0 };
    const FILTERS = [['all', 'All'], ['video', 'Video'], ['audio', 'Audio'], ['image', 'Images']];

    /* ================= XEM TRƯỚC ẢNH / MỞ LINK / XEM FULL ================= */
    const TIP_ZOOM = 'Click to view full size';
    const TIP_LINK = 'Click to open the direct link in a new tab';
    const TIP_GRAB = 'Open GrabShorts in a new tab and auto-paste the video link';
    const imgCache = new Map();   // key -> blob: URL (chỉ có khi trang chặn tải trực tiếp, phải tải bằng GM_xmlhttpRequest)

    // Nạp ảnh vào <img>: thử trực tiếp trước; nếu lỗi (hotlink / CSP) thì tải bằng GM_xmlhttpRequest rồi hiển thị qua blob
    function loadImg(img, it, onOk, onFail) {
      let stage = imgCache.has(it.key) ? 1 : 0;
      img.onload = () => { if (onOk) onOk(); };
      img.onerror = () => {
        if (stage === 0 && /^https?:/.test(it.url)) {
          stage = 1;
          gm({ url: it.url, responseType: 'arraybuffer', headers: { Referer: it.ref } }).then((r) => {
            const mime = (parseHeaders(r.responseHeaders)['content-type'] || '').split(';')[0].trim().toLowerCase();
            if (!r.response || !r.response.byteLength || /^text\//.test(mime)) throw new Error('empty');
            const u = URL.createObjectURL(new Blob([r.response], { type: /^image\//.test(mime) ? mime : (it.mime || 'image/jpeg') }));
            imgCache.set(it.key, u);
            img.src = u;
          }).catch(() => { if (onFail) onFail(); });
        } else if (onFail) onFail();
      };
      img.src = imgCache.get(it.key) || it.url;
    }

    function openLink(it) {
      if (it.type !== 'image' && isFamous()) { openTab(grabTarget(it)); return; }
      openTab(it);
    }
    function openTab(x) {
      const it = typeof x === 'string' ? { url: x } : x;
      const go = (u) => {
        try { if (/^https?:/.test(u) && typeof GM_openInTab === 'function') { GM_openInTab(u, { active: true }); return; } } catch (_) {}
        let w = null;
        try { w = window.open(u, '_blank', 'noopener'); } catch (_) {}
        if (!w) showToast('Your browser is blocked from opening new tabs – please allow pop-ups', 3500);
      };
      if (/^data:/.test(it.url)) {
        fetch(it.url).then((r) => r.blob()).then((b) => go(URL.createObjectURL(b))).catch(() => showToast('Could not open this link', 3000));
      } else go(it.url);
    }

    const LB = { open: false };
    function openLb(it) {
      LB.open = true;
      const img = h('img', { alt: '' });
      lbImg.replaceWith(img);
      lbImg = img;
      lbMsg.textContent = 'Loading image…';
      lbMsg.style.display = '';
      lightbox.classList.add('show');
      loadImg(img, it,
        () => { img.classList.add('ok'); lbMsg.style.display = 'none'; },
        () => { lbMsg.textContent = 'Could not load this image. Click outside to close.'; });
    }
    function closeLb() {
      if (!LB.open) return;
      LB.open = false;
      lightbox.classList.remove('show');
      lbImg.removeAttribute('src');
    }
    lightbox.addEventListener('click', (e) => { if (e.target !== lbImg) closeLb(); });

    function makeThumb(it) {
      const isImg = it.type === 'image';
      const b = h('button', { class: 'thumb' + (isImg ? ' img' : ''), type: 'button' });
      let mode = isImg ? 'zoom' : 'link';
      const tip = (t) => { b.title = t; b.setAttribute('aria-label', t); };
      const asLink = () => {
        mode = 'link';
        b.className = 'thumb';
        b.textContent = '';
        b.append(icon(ICON_LINK, 20, 2.2));
        tip(!isImg && isFamous() ? TIP_GRAB : TIP_LINK);
      };
      if (isImg) {
        tip(TIP_ZOOM);
        const im = h('img', { alt: '', loading: 'lazy', decoding: 'async', draggable: 'false' });
        b.append(im);
        loadImg(im, it, null, asLink);   // ảnh lỗi -> chuyển sang biểu tượng mở link
      } else asLink();
      b.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        if (mode === 'zoom') openLb(it); else openLink(it);
      });
      b.addEventListener('dblclick', (e) => { e.preventDefault(); e.stopPropagation(); });
      return b;
    }

    function labelOf(it) {
      const base = it.type === 'hls' ? 'HLS' : (it.ext ? it.ext.toUpperCase() : TYPE_LABEL[it.type].toUpperCase());
      const q = it.q || (it.w && it.h ? it.w + '×' + it.h : (it.w ? it.w + 'px' : ''));
      return [base, q].filter(Boolean).join(' • ');
    }
    function sizeText(it) {
      if (it.drm) return 'DRM';
      if (it.size == null) return it.probed ? '—' : '…';
      return (it.approx ? '~' : '') + fmtSize(it.size);
    }
    function currentItem() { return P.items.find((i) => i.key === P.sel); }

    function buildList() {
      const src = P.mode === 'all' ? allItems() : P.base;
      const out = [], seen = new Set();
      src.forEach((it) => {
        const vs = it.type === 'hls' && hlsVariants.get(it.key);
        (vs && vs.length ? vs : [it]).forEach((x) => {
          if (seen.has(x.key)) return;
          seen.add(x.key);
          out.push(applyCache(Object.assign({}, x)));
        });
      });
      P.items = out.filter((i) => !i.bad && !i.master && typeOn(i.type));
    }
    function visible() {
      return P.items.filter((i) => {
        if (P.mode === 'all') {
          if (i.type === 'image' && i.size != null && i.size < CFG.MIN_IMG_BYTES) return false;
          if (P.filter === 'video') return i.type === 'video' || i.type === 'hls';
          if (P.filter !== 'all') return i.type === P.filter;
        }
        return true;
      });
    }

    function renderTabs() {
      tabs.textContent = '';
      if (P.mode !== 'all') return;
      FILTERS.filter(([k]) => k === 'all' || SET[k]).forEach(([k, t]) => {
        const b = h('button', { class: 'tab' + (P.filter === k ? ' on' : '') }, t);
        b.addEventListener('click', () => { P.filter = k; render(); });
        tabs.append(b);
      });
    }

    function render() {
      const keepScroll = list.scrollTop;
      if (P.filter !== 'all' && !SET[P.filter]) P.filter = 'all';
      buildList();
      renderTabs();
      const vis = visible();
      list.textContent = '';
      P.rows.clear();
      if (!vis.some((i) => i.key === P.sel)) {
        const pick = vis.find((i) => i.current) || vis[0];
        P.sel = pick ? pick.key : null;
      }
      if (!vis.length) {
        list.append(h('div', { class: 'empty' }, P.msg || (P.mode === 'all'
          ? 'No files captured yet.\nPlay a video or scroll the page so the extension can capture more links.'
          : 'No download links captured yet.\nPlay the video (or wait for the page to finish loading) and try again.')));
      }
      vis.forEach((it) => {
        const inp = h('input', { type: 'radio', name: 'tc-sel' });
        inp.checked = it.key === P.sel;
        const m = h('div', { class: 'm' }, labelOf(it));
        const subTxt = it.note || (P.mode === 'all' ? fileName(it) : (it.current ? 'In use' : ''));
        const s = h('div', { class: 's' }, subTxt);
        const r = h('div', { class: 'r' }, sizeText(it));
        const row = h('label', { class: 'row' + (inp.checked ? ' sel' : '') }, inp, h('div', { class: 'l' }, m, subTxt ? s : null), makeThumb(it), r);
        inp.addEventListener('change', () => select(it.key));
        row.addEventListener('dblclick', doDownload);
        P.rows.set(it.key, { row, m, r });
        list.append(row);
      });
      list.scrollTop = keepScroll;
      hint.textContent = P.busy ? 'Fetching list…' : vis.length + (vis.length === 1 ? ' item' : ' items') + (P.note ? ' · ' + P.note : '');
      updateHead();
      vis.slice(0, 40).forEach((it) => {
        if (!it.probed) enqueueProbe(it).then(() => onProbed(it.key));
      });
    }

    let rt = 0;
    function scheduleRender() { if (!rt) rt = setTimeout(() => { rt = 0; if (P.open) render(); }, 150); }
    function onProbed(key) {
      if (!P.open) return;
      const c = cache.get(key) || {};
      if (c.bad || c.master) return scheduleRender();
      const it = P.items.find((i) => i.key === key);
      const row = P.rows.get(key);
      if (!it || !row) return;
      applyCache(it);
      row.m.textContent = labelOf(it);
      row.r.textContent = sizeText(it);
      if (key === P.sel) updateHead();
    }

    function updateHead() {
      const it = currentItem();
      btnDl.disabled = !it;
      fname.disabled = !it;
      fname.value = it ? (P.edited[it.key] != null ? P.edited[it.key] : fileName(it)) : '';
    }
    function select(key) {
      P.sel = key;
      P.rows.forEach((v, k) => v.row.classList.toggle('sel', k === key));
      updateHead();
    }
    fname.addEventListener('input', () => { if (P.sel) P.edited[P.sel] = fname.value; });

    function doDownload() {
      const it = currentItem();
      if (!it) return;
      const name = finalName(it, fname.value);
      closePanel();
      hidePill();
      runDownload(it, name);
    }
    btnDl.addEventListener('click', doDownload);

    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closePanel(); });
    btnX.addEventListener('click', () => closePanel());
    btnClose.addEventListener('click', () => closePanel());
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (sBack.classList.contains('show')) closeSettings();
      else if (P.open) { if (LB.open) closeLb(); else closePanel(); }
    }, true);

    function openPanel(items, mode) {
      P.open = true; P.mode = mode; P.base = items || []; P.filter = 'all'; P.edited = {}; P.sel = null;
      P.msg = ''; P.note = ''; P.busy = false; P.tok++;
      render();
      backdrop.classList.add('show');
      hidePill();
      return P.tok;
    }
    // Cập nhật bảng đang mở từ tác vụ bất đồng bộ (bỏ qua nếu bảng đã đóng/mở lại cho việc khác)
    function setPanel(tok, o) {
      if (tok !== P.tok || !P.open) return;
      if ('base' in o) P.base = o.base;
      if ('msg' in o) P.msg = o.msg;
      if ('note' in o) P.note = o.note;
      if ('busy' in o) P.busy = o.busy;
      render();
    }
    function closePanel() {
      P.open = false;
      closeLb();
      backdrop.classList.remove('show');
      imgCache.forEach((u) => { try { URL.revokeObjectURL(u); } catch (_) {} });
      imgCache.clear();
    }
    function refreshIfAll() { if (P.open && P.mode === 'all') scheduleRender(); }

    // Thùng rác: xoá sạch dữ liệu đã bắt (kể cả ảnh xem trước đã nạp) rồi làm mới bảng
    btnTrash.addEventListener('click', () => {
      const n = clearAll();
      imgCache.forEach((u) => { try { URL.revokeObjectURL(u); } catch (_) {} });
      imgCache.clear();
      closeLb();
      P.base = []; P.items = []; P.sel = null; P.edited = {}; P.msg = ''; P.note = '';
      render();
      showToast('Cleared ' + n + ' captured file(s)', 2200);
    });

    /* ================= WELCOME (1 lần) ================= */
    function showWelcome() {
      wback.classList.add('show');
      setTimeout(() => wback.classList.remove('show'), 5000);
    }

    /* ================= QUICK BUTTON ================= */
    quick.addEventListener('click', () => {
      if (P.open && P.mode === 'all') closePanel(); else openAll();
    });
    function setFullscreen(on) {
      quick.style.display = (on || !SET.menu) ? 'none' : '';
      if (on) hidePill();
    }
    function mountQuick() { root.append(quick); setBadge(countAll()); setFullscreen(isFs()); }
    function setBadge(n) {
      num.textContent = n > 99 ? '99+' : String(n);
      num.className = n > 99 ? 'num sm' : 'num';
      const t = 'Quick download · ' + n + ' file(s)';
      quick.title = t;
      quick.setAttribute('aria-label', t);
    }

    /* ================= SETTINGS ================= */
    function syncChecks() { Object.keys(sChecks).forEach((k) => { sChecks[k].checked = !!SET[k]; }); }
    function openSettings() { syncChecks(); sBack.classList.add('show'); hidePill(); }
    function closeSettings() { sBack.classList.remove('show'); }
    function applySettings() {
      syncChecks();
      setFullscreen(isFs());
      hidePill(); HV.cur = null;
      if (!SET.menu && P.open && P.mode === 'all') closePanel();
      else if (P.open) render();
      setBadge(countAll());
    }
    function setSetting(k, v) { SET[k] = !!v; saveSettings(); applySettings(); }
    btnSet.addEventListener('click', openSettings);
    sX.addEventListener('click', closeSettings);
    sDone.addEventListener('click', closeSettings);
    sBack.addEventListener('click', (e) => { if (e.target === sBack) closeSettings(); });

    /* ================= TOAST ================= */
    let toastT = 0;
    function showToast(msg, ms) {
      toastEl.textContent = msg;
      toastEl.classList.add('show');
      clearTimeout(toastT);
      if (ms > 0) toastT = setTimeout(() => toastEl.classList.remove('show'), ms);
    }

    return {
      host, showPill, hidePill, setFullscreen, reposition, openPanel, closePanel, refreshIfAll, mountQuick, setBadge,
      toast: showToast, panelOpen: () => P.open || sBack.classList.contains('show'), setPanel, showWelcome, applySettings, openSettings,
    };
  }

  /* =====================================================================
   *  GRABSHORTS: mở trong tab mới + tự dán link video
   * ===================================================================== */
  function grabTarget(it) {
    const link = it && it.yt && it.ref ? it.ref : location.href;
    try { if (typeof GM_setValue === 'function') GM_setValue('tc_grab', JSON.stringify({ u: link, t: Date.now() })); } catch (_) {}
    return 'https://www.grabshorts.com/#tc-url=' + encodeURIComponent(link);
  }

  function grabAutofill() {
    let link = '';
    const m = /[#&]tc-url=([^&]+)/.exec(location.hash);
    if (m) { try { link = decodeURIComponent(m[1]); } catch (_) {} }
    if (!link && typeof GM_getValue === 'function') {
      try { const d = JSON.parse(GM_getValue('tc_grab', '') || 'null'); if (d && Date.now() - d.t < 120000) link = d.u; } catch (_) {}
    }
    if (!/^https?:\/\//i.test(link)) return;
    try { if (typeof GM_deleteValue === 'function') GM_deleteValue('tc_grab'); } catch (_) {}

    const visible = (el) => !!(el && (el.offsetParent || el.getClientRects().length));
    const findInput = () => Array.from(document.querySelectorAll('input')).find((i) =>
      /^(text|url|search|)$/i.test(i.type) && !i.disabled && !i.readOnly && visible(i));
    const fill = (inp) => {
      try {
        const proto = (W.HTMLInputElement || HTMLInputElement).prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(inp, link);
      } catch (_) { inp.value = link; }
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new Event('change', { bubbles: true }));
      try { inp.focus(); } catch (_) {}
    };
    const submit = (inp) => {
      let scope = inp.closest('form') || inp.parentElement;
      for (let i = 0; i < 4 && scope; i++, scope = scope.parentElement) {
        const b = Array.from(scope.querySelectorAll('button,input[type=submit]')).find((x) =>
          !x.disabled && visible(x) && (x.type === 'submit' || /download|tải|get|start|go/i.test(x.textContent || x.value || '')));
        if (b) { b.click(); return true; }
      }
      return false;
    };

    let tries = 0, filled = false, sub = 0;
    const timer = setInterval(() => {
      tries++;
      if (!filled) {
        const inp = findInput();
        if (inp) { fill(inp); filled = true; tries = 0; }
      } else if (!CFG.GRAB_AUTOSUBMIT) {
        clearInterval(timer);
      } else {
        const inp = findInput();
        if ((inp && submit(inp)) || ++sub > 8) clearInterval(timer);
      }
      if (tries > 80) clearInterval(timer);   // quá ~20 giây vẫn không thấy ô nhập thì bỏ
    }, 250);
  }

  function allItems() {
    scanDom();
    const all = Array.from(store.values()).map((i) => Object.assign({}, i));
    const yt = all.filter((i) => i.yt).sort((a, b) => a.yt.rank - b.yt.rank);   // link YouTube xếp trước, theo chất lượng
    const rest = all.filter((i) => !i.yt).sort((a, b) => b.t - a.t);
    return yt.concat(rest);
  }

  /* =====================================================================
   *  TÌM PHẦN TỬ DƯỚI CON TRỎ + LẤY DANH SÁCH LINK
   * ===================================================================== */
  function deepFromPoint(x, y, root, depth) {
    const out = [];
    let els = [];
    try { els = root.elementsFromPoint(x, y); } catch (_) {}
    els.forEach((el) => {
      if (el.shadowRoot && depth < 3) deepFromPoint(x, y, el.shadowRoot, depth + 1).forEach((e) => out.push(e));
      out.push(el);
    });
    return out;
  }

  function findTarget(x, y) {
    const list = deepFromPoint(x, y, document, 0).filter((el) => !UI || el !== UI.host);
    for (const el of list) {
      const tag = el.tagName;
      if (tag === 'VIDEO' || tag === 'AUDIO') {
        if (typeOn(tag.toLowerCase())) return { el, kind: tag.toLowerCase() };
        continue;
      }
      if (tag === 'IMG' && SET.image) {
        const r = el.getBoundingClientRect();
        if (r.width >= CFG.MIN_BOX && r.height >= CFG.MIN_BOX) return { el, kind: 'image' };
      }
    }
    for (const el of (SET.image ? list.slice(0, 6) : [])) {
      if (el === document.documentElement || el === document.body) continue;
      let bg = '';
      try { bg = getComputedStyle(el).backgroundImage; } catch (_) {}
      if (!bg || bg === 'none') continue;
      const m = /url\((['"]?)(.*?)\1\)/.exec(bg);
      if (!m || /^data:image\/svg/.test(m[2])) continue;
      const r = el.getBoundingClientRect();
      if (r.width >= CFG.MIN_BOX && r.height >= CFG.MIN_BOX) return { el, kind: 'image', bg: m[2] };
    }
    return null;
  }

  function parseSrcset(s) {
    if (!s) return [];
    return s.trim().split(/,\s+/).map((part) => {
      const p = part.trim().split(/\s+/);
      const d = p[1] || '';
      return { url: p[0], w: /w$/.test(d) ? parseInt(d, 10) : undefined, x: /x$/.test(d) ? d : '' };
    }).filter((c) => c.url);
  }

  function candidates(t) {
    const el = t.el, out = [], seen = new Set();
    const add = (it) => { if (it && !seen.has(it.key)) { seen.add(it.key); out.push(it); } };
    if (t.kind === 'image') {
      if (t.bg) add(buildItem(t.bg, { type: 'image' }));
      else {
        add(buildItem(el.currentSrc || el.src, { type: 'image', w: el.naturalWidth, h: el.naturalHeight, current: true }));
        const others = [];
        const sets = [el.getAttribute('srcset'), el.getAttribute('data-srcset')];
        if (el.parentElement && el.parentElement.tagName === 'PICTURE') {
          el.parentElement.querySelectorAll('source').forEach((s) => sets.push(s.getAttribute('srcset')));
        }
        sets.forEach((s) => parseSrcset(s).forEach((c) => others.push(buildItem(c.url, { type: 'image', w: c.w, q: c.x }))));
        ['data-src', 'data-original', 'data-lazy-src', 'data-full', 'data-large', 'data-zoom-src'].forEach((a) => {
          const v = el.getAttribute(a);
          if (v) others.push(buildItem(v, { type: 'image', note: 'Lazy-loaded image' }));
        });
        const a = el.closest && el.closest('a[href]');
        if (a && EXT_TYPE[extOf(a.href)] === 'image') others.push(buildItem(a.href, { type: 'image', note: 'Original image (from link)' }));
        others.filter(Boolean).sort((p, q) => (q.w || 0) - (p.w || 0)).forEach(add);
      }
    } else {
      const kind = t.kind;
      const own = [el.currentSrc, el.src].concat([].map.call(el.querySelectorAll('source'), (s) => s.src));
      own.filter(Boolean).forEach((u) => add(buildItem(u, {
        type: kind, current: true, q: u === el.currentSrc && el.videoHeight ? el.videoHeight + 'p' : '',
      })));
      const wanted = kind === 'video' ? ['video', 'hls', 'audio'] : ['audio', 'hls'];
      Array.from(store.values()).filter((i) => wanted.includes(i.type))
        .sort((a, b) => b.t - a.t).slice(0, CFG.MAX_CAND).forEach((i) => add(Object.assign({}, i)));
    }
    return out.filter((i) => typeOn(i.type));
  }

  /* =====================================================================
   *  HOVER
   * ===================================================================== */
  function initHover() {
    let raf = 0, px = 0, py = 0;
    const tick = () => {
      raf = 0;
      if (UI && UI.panelOpen()) return;
      if (isFs()) { if (UI) UI.hidePill(); return; }
      const t = findTarget(px, py);
      if (t) { HV.cur = t; hvClear(); ui().showPill(t.el, t.kind); }
      else if (HV.cur) hvSched();
    };
    document.addEventListener('mousemove', (e) => {
      if (UI && e.target === UI.host) return;
      px = e.clientX; py = e.clientY;
      if (!raf) raf = requestAnimationFrame(tick);
    }, { capture: true, passive: true });
    document.addEventListener('touchstart', (e) => {
      if (UI && e.target === UI.host) return;
      const t = e.touches && e.touches[0];
      if (!t) return;
      px = t.clientX; py = t.clientY;
      if (!raf) raf = requestAnimationFrame(tick);
    }, { capture: true, passive: true });
    document.addEventListener('touchend', () => hvSched(), { capture: true, passive: true });
    (document.documentElement || document).addEventListener('mouseleave', () => hvSched());
    const rep = () => { if (UI && !raf) raf = requestAnimationFrame(() => { raf = 0; UI.reposition(); }); };
    window.addEventListener('scroll', rep, { capture: true, passive: true });
    window.addEventListener('resize', rep, { passive: true });

    // Bắt thêm khi media tự nạp
    document.addEventListener('load', (e) => {
      const t = e.target;
      if (SET.image && t && t.tagName === 'IMG' && t.naturalWidth >= 120 && t.naturalHeight >= 120) {
        const u = t.currentSrc || t.src;
        if (u && /^https?:/.test(u)) record(u, { type: 'image', w: t.naturalWidth, h: t.naturalHeight });
      }
    }, true);
    ['loadedmetadata', 'play'].forEach((ev) => document.addEventListener(ev, (e) => {
      const t = e.target;
      if (!t || (t.tagName !== 'VIDEO' && t.tagName !== 'AUDIO')) return;
      const u = t.currentSrc || t.src;
      if (u && /^https?:/.test(u)) record(u, { type: t.tagName.toLowerCase() });
    }, true));

    // Toàn màn hình: ẩn nút nhanh + nút nổi; vẫn chuyển giao diện vào phần tử fullscreen để bảng (mở từ menu) còn thấy được
    const onFs = () => {
      if (!UI) return;
      UI.setFullscreen(isFs());
      const fs = document.fullscreenElement || document.webkitFullscreenElement;
      const p = fs && fs.tagName !== 'VIDEO' ? fs : document.documentElement;
      if (UI.host.parentNode !== p) p.appendChild(UI.host);
    };
    document.addEventListener('fullscreenchange', onFs);
    document.addEventListener('webkitfullscreenchange', onFs);
  }

  /* =====================================================================
   *  TẢI STREAM (GRAB) – khi tải trực tiếp bị 403 (HLS/DASH/MSE...)
   *  Cách hoạt động: tải lại trang một lần, ghi lại các đoạn video mà chính trình phát tải
   *  (playlist .m3u8 hoặc dữ liệu nạp vào MediaSource), rồi ghép thành một file gốc, không mã hóa lại.
   *  Chạy ở MỌI frame: nếu video nằm trong iframe thì thanh nổi hiện ngay trong iframe đó.
   * ===================================================================== */
  const Rec = (() => {
    const S = {
      host: null, box: null, label: null, x: null, gbtn: null,
      state: 'idle',            // idle | grabbing
      msg: '', msgT: 0, name: '', v: null, cancel: false, gtxt: '', gdone: 0, gtotal: 0, url: '',
    };

    /* ---------- tìm video ---------- */
    function allVideos(root, out, depth) {
      root = root || document; out = out || []; depth = depth || 0;
      try {
        root.querySelectorAll('video').forEach((v) => out.push(v));
        if (depth < 5) root.querySelectorAll('*').forEach((el) => { if (el.shadowRoot) allVideos(el.shadowRoot, out, depth + 1); });
      } catch (_) {}
      return out;
    }
    function pickVideo() {
      let best = null, bs = -1;
      allVideos().forEach((v) => {
        if (!v.currentSrc && !v.src && !v.srcObject) return;
        const r = v.getBoundingClientRect();
        const area = (v.videoWidth * v.videoHeight) || (r.width * r.height);
        const s = area + (!v.paused && !v.ended ? 1e9 : 0) + (v.readyState > 0 ? 1e6 : 0);
        if (s > bs) { bs = s; best = v; }
      });
      return best;
    }

    function flash(msg, ms) {
      S.msg = msg; render();
      clearTimeout(S.msgT);
      S.msgT = setTimeout(() => { S.msg = ''; render(); }, ms || 4500);
    }

    /* ---------- GRAB: lưu lại các đoạn video mà trình phát tự tải, rồi ghép lại ---------- */
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // Gom các playlist đã thấy -> đoạn nào đã lưu / còn thiếu. Các chất lượng (variant) cùng số đoạn được coi là cùng một video.
    function coverage() {
      const R = { n: 0, got: 0, missing: [], start: [], group: [], live: false };
      const media = [];
      PL.forEach((e) => {
        if (e.text.indexOf('#EXTINF') < 0) return;
        if (!e.pm) { try { e.pm = parseMedia(e.text, e.url); } catch (_) { return; } }
        if (e.pm.segs.length) media.push(e);
      });
      if (!media.length) return R;
      const byN = new Map();
      media.forEach((e) => { const n = e.pm.segs.length; if (!byN.has(n)) byN.set(n, []); byN.get(n).push(e); });
      const cnt = (e) => e.pm.segs.reduce((a, s) => a + (TAP.store.has(tapKey(s.url)) ? 1 : 0), 0);
      let best = null;
      byN.forEach((arr, n) => {
        let g = arr;
        if (g.some((e) => e.pm.map)) g = [g.slice().sort((a, b) => cnt(b) - cnt(a))[0]]; // fMP4: không trộn các chất lượng
        let got = 0; const missing = [];
        for (let i = 0; i < n; i++) {
          if (g.some((e) => TAP.store.has(tapKey(e.pm.segs[i].url)))) got++; else missing.push(i);
        }
        if (!best || got > best.got || (got === best.got && n > best.n)) best = { n, got, missing, group: g };
      });
      let acc = 0;
      best.start = best.group[0].pm.segs.map((s) => { const t = acc; acc += s.d || 0; return t; });
      best.live = !/#EXT-X-ENDLIST/.test(best.group[0].text);
      return best;
    }

    // Một số máy chủ giấu đoạn .ts sau phần đầu giả (vd. header ảnh): tìm vị trí bắt đầu thật của luồng MPEG-TS (0x47 mỗi 188 byte)
    async function tsFix(b) {
      try {
        const head = new Uint8Array(await b.slice(0, 4096).arrayBuffer());
        if (head.length < 400 || (head[0] === 0x47 && head[188] === 0x47)) return b;
        for (let o = 1; o + 376 < head.length; o++) {
          if (head[o] === 0x47 && head[o + 188] === 0x47 && head[o + 376] === 0x47) return b.slice(o);
        }
      } catch (_) {}
      return b;
    }

    async function assemble() {
      const c = coverage();
      if (MSE.count && (!c.n || c.got < c.n)) {
        try {
          const mp = mseProgress(S.v && S.v.duration, true);
          if (mp && (!c.n || mp.got >= c.got)) {
            const o = await mseBuild();
            if (o) { o.miss = 0; return o; }
          }
        } catch (e) { }
      }
      const segBlobs = [];
      let ext = 'ts', miss = 0, mixed = '';
      if (c.n) {
        const g = c.group, pm0 = g[0].pm;
        if (g.some((e) => e.pm.segs.some((s) => s.key && s.key.method !== 'AES-128'))) throw new Error('DRM-protected / unsupported encryption');
        // đoạn còn thiếu: thử tải trực tiếp lần cuối (có thể vẫn 403, không sao)
        if (c.missing.length) {
          S.gtxt = 'Fetching ' + c.missing.length + ' missing segments…'; render();
          for (const i of c.missing.slice(0, 300)) {
            for (const e of g) {
              const s = e.pm.segs[i];
              try {
                const r = await gm({ url: s.url, responseType: 'arraybuffer', headers: { Referer: location.href } });
                if (r.response && r.response.byteLength) { TAP.store.set(tapKey(s.url), mkBlob(r.response)); break; }
              } catch (_) {}
            }
          }
        }
        const keys = new Map();
        g.forEach((e) => e.pm.segs.forEach((s) => {
          if (s.key && s.key.uri && !keys.has(s.key.uri)) {
            const kb = KEYS.get(tapKey(s.key.uri));
            if (kb) keys.set(s.key.uri, crypto.subtle.importKey('raw', kb, 'AES-CBC', false, ['decrypt']));
          }
        }));
        const used = new Map();
        S.gtxt = 'Assembling…'; render();
        for (let i = 0; i < c.n; i++) {
          let pick = null, rate = -1;
          g.forEach((e) => {
            const s = e.pm.segs[i], b = TAP.store.get(tapKey(s.url));
            if (b && b.size / (s.d || 1) > rate) { rate = b.size / (s.d || 1); pick = { e, s, b }; } // nhiều chất lượng -> lấy bản nặng nhất
          });
          if (!pick) { miss++; continue; }
          let b = pick.b;
          if (pick.s.key) b = new Blob([await decryptSeg(await b.arrayBuffer(), pick.s, keys, location.href)]);
          if (!pm0.map) b = await tsFix(b);
          segBlobs.push(b);
          used.set(pick.e.url, (used.get(pick.e.url) || 0) + 1);
        }
        if (pm0.map) {
          ext = 'mp4';
          let mb = TAP.store.get(tapKey(pm0.map));
          if (!mb) { const r = await gm({ url: pm0.map, responseType: 'arraybuffer', headers: { Referer: location.href } }); mb = mkBlob(r.response); }
          segBlobs.unshift(mb);
        }
        if (used.size > 1) mixed = ' · mixed qualities (' + used.size + ' levels)';
        
      } else {
        // không thấy playlist: dùng các khối video đã bắt, theo thứ tự đến
        if (!TAP.blind.length) throw new Error('Nothing was captured');
        for (const x of TAP.blind) segBlobs.push(await tsFix(x.blob));
        const h8 = new Uint8Array(await TAP.blind[0].blob.slice(0, 12).arrayBuffer());
        if (/^(ftyp|styp|moof|moov)$/.test(String.fromCharCode(h8[4], h8[5], h8[6], h8[7]))) ext = 'mp4';
        mixed = ' · no playlist, arrival order';
        
      }
      const limit = (CFG.GRAB_PART_MB || 700) * 1048576;
      const parts = []; let cur = [], sz = 0;
      segBlobs.forEach((b) => { if (sz + b.size > limit && cur.length) { parts.push(cur); cur = []; sz = 0; } cur.push(b); sz += b.size; });
      if (cur.length) parts.push(cur);
      const type = ext === 'mp4' ? 'video/mp4' : 'video/mp2t';
      return { files: parts.map((a) => new Blob(a, { type })), ext, miss, mixed, total: segBlobs.reduce((a, b) => a + b.size, 0) };
    }

    function c0Incomplete() { try { const c = coverage(); return !!(c.n && c.got < c.n); } catch (_) { return false; } }

    function grabName() {
      let b = String(S.name || '').replace(/\.[a-z0-9]{2,4}$/i, '');
      return sanitize(b || document.title) || 'video';
    }

    // Khi bắt bị đứng: seek tới "lỗ" (nếu có) hoặc tới mép phía sau đoạn đã bắt; mỗi lần thử lại ở mép thì hạ tốc độ phát một nửa
    function stallPlan(hole, front, dur, seeks, rateMax) {
      const target = hole != null ? hole : front;
      if (target == null) return { stop: 'nothing to seek to' };
      if (seeks >= 5) return { stop: 'gave up after ' + seeks + ' retries' };
      if (isFinite(dur) && target >= dur - 0.5) return { stop: 'reached end of video' };
      return { target: target + 0.05, rateMax: hole != null ? rateMax : Math.max(1, rateMax / 2) };
    }
    // Chẩn đoán: tình trạng video + dữ liệu MSE đã bắt (số init khác nhau = có đổi luồng/quảng cáo?)
    function grabDiag(v, why, extra) {
      const rg = (tr) => { const o = []; try { for (let i = 0; i < tr.length; i++) o.push([+tr.start(i).toFixed(1), +tr.end(i).toFixed(1)]); } catch (_) {} return o; };
      const D = { why, page: location.hostname, time: new Date().toISOString(), extra: extra || {} };
      try {
        D.video = { cur: +(v.currentTime || 0).toFixed(1), dur: v.duration, ready: v.readyState, net: v.networkState, paused: v.paused, ended: v.ended, err: v.error ? v.error.code : null, buffered: rg(v.buffered), connected: v.isConnected, src: String(v.currentSrc || '').slice(0, 50) };
        D.videos = allVideos().map((x) => ({ dur: x.duration, cur: +(x.currentTime || 0).toFixed(1), paused: x.paused, same: x === v, w: x.videoWidth }));
      } catch (_) {}
      try {
        D.mse = MSE.list.map((r) => {
          const g = new Map();
          r.frags.forEach((f) => {
            const inf = r.inits.get(f.init), ts = (inf && inf.info && inf.info.ts) || 1, sec = f.time != null ? f.time / ts : null;
            const e = g.get(f.init) || { n: 0, a: Infinity, b: -Infinity };
            e.n++; if (sec != null) { e.a = Math.min(e.a, sec); e.b = Math.max(e.b, sec); } g.set(f.init, e);
          });
          return { mime: r.mime.slice(0, 40), inits: r.inits.size, groups: [...g.values()].map((e) => ({ n: e.n, from: isFinite(e.a) ? +e.a.toFixed(1) : null, to: isFinite(e.b) ? +e.b.toFixed(1) : null })) };
        });
      } catch (_) {}
      D.netErrors = TAP.errs.slice(0, 25);
      return D;
    }

    async function runGrab() {
      if (S.state !== 'idle') return;
      S.state = 'grabbing'; S.cancel = false; S.msg = ''; S.gtxt = 'Waiting for the player…';
      S.gdone = 0; S.gtotal = 0; render();
      const undo = [];
      try {
        TAP.on = true; TAP.errs = [];
        let v = null;
        const t0 = performance.now();
        while (!S.cancel && performance.now() - t0 < 180000) {
          v = pickVideo();
          if (v && (v.readyState > 0 || PL.size)) break;
          v = null; S.gtxt = 'Press play on the video to start…'; render();
          await sleep(500);
        }
        if (S.cancel) throw new Error('Cancelled');
        if (!v) throw new Error('No video found. Press play, then press ⤓ again.');
        S.v = v;
        
        const prev = { muted: v.muted, rate: v.playbackRate, loop: v.loop, paused: v.paused };
        undo.push(() => { try { v.playbackRate = prev.rate; v.muted = prev.muted; v.loop = prev.loop; v.currentTime = 0; if (prev.paused) v.pause(); } catch (_) {} });
        v.muted = true; v.loop = false;
        let rateMax = CFG.GRAB_MAX_RATE || 16, why = 'done';
        const setRate = () => { for (const r of [16, 8, 4, 2, 1].filter((x) => x <= rateMax)) { try { v.playbackRate = r; if (Math.abs(v.playbackRate - r) < 0.01) return r; } catch (_) {} } return 1; };
        let rate = setRate();
        try { if (v.currentTime > 0.5) v.currentTime = 0; } catch (_) {}
        try { await v.play(); } catch (_) {}

        const start = performance.now();
        let lastKey = '', lastT = start, seeks = 0, ign = false;
        for (;;) {
          if (S.cancel) throw new Error('Cancelled');
          const c = coverage();
          const mp = MSE.count ? mseProgress(v.duration, ign) : null;
          const useMse = !!mp && !(c.n && c.got >= c.n);
          const blind = !c.n && !useMse;
          const key = useMse ? 'm' + mp.got + (c.n ? '|c' + c.got : '') : (blind ? 'b' + TAP.blind.length : 'c' + c.got + '/' + c.n);
          S.gdone = useMse ? mp.got : (blind ? TAP.blind.length : c.got); S.gtotal = useMse ? mp.n : c.n;
          S.gtxt = blind ? 'Capturing… ' + TAP.blind.length + ' chunks' : '';
          const now = performance.now();
          if (key !== lastKey) { lastKey = key; lastT = now; seeks = 0; }
          render();
          if (!blind && !useMse && c.got >= c.n) break;
          if (useMse && mp.done) break;
          if (v.paused && !v.ended) v.play().catch(() => {});
          if (Math.abs(v.playbackRate - rate) > 0.01) rate = setRate();
          const stalled = now - lastT > (CFG.GRAB_STALL_MS || 20000);
          if (v.ended || stalled) {
            if (blind) { if (stalled || now - lastT > 4000) break; }
            else if (useMse) {
              const pr0 = mseMain(), front = pr0 && pr0.main && pr0.main.last != null ? pr0.main.last + (pr0.main.gap || 0) : null;
              const pl = stallPlan(mp.hole, front, v.duration, seeks, rateMax);
              if (pl.stop) { why = (v.ended ? 'ended' : 'stalled') + ': ' + pl.stop; break; }
              seeks++;
              if (mp.hole === 0) ign = true;
              if (pl.rateMax !== rateMax) { rateMax = pl.rateMax; rate = setRate(); }
              try { v.currentTime = Math.max(0, pl.target); } catch (_) {}
              v.play().catch(() => {});
              lastT = now;
            } else {
              if (seeks >= 6) { why = 'hls: gave up after ' + seeks + ' retries'; break; }
              seeks++;
              const m = c.missing[0];
              
              try { v.currentTime = Math.max(0, (c.start[m] || 0) + 0.05); } catch (_) {}
              v.play().catch(() => {});
              lastT = now;
            }
          }
          if (now - start > 4 * 3600e3) { why = 'timeout 4h'; break; }
          await sleep(400);
        }
        const diag = grabDiag(v, why, { rateMax, seeks, gotFrags: S.gdone, totalFrags: S.gtotal });
        while (undo.length) { try { undo.pop()(); } catch (_) {} }

        // Đã bắt đủ tới cuối video chưa? (nếu thiếu thì báo rõ, tránh tưởng đã đủ rồi mới phát hiện khi xem)
        let warn = '';
        try {
          const vd = v.duration, mm = (x) => Math.floor(x / 60) + ':' + String(Math.floor(x % 60)).padStart(2, '0');
          const pr = MSE.count ? mseMain() : null;
          if (pr && pr.main && isFinite(vd) && pr.main.last != null) {
            const got = pr.main.last + (pr.main.gap || 0);
            if (got < vd - Math.max(3, (pr.main.gap || 0) * 1.5)) warn = ' · ⚠ INCOMPLETE: captured ' + mm(got) + ' / ' + mm(vd);
          } else if (c0Incomplete()) warn = ' · ⚠ INCOMPLETE: missing segments';
        } catch (_) {}

        if (warn) { try { console.warn('[Media Downloader] grab incomplete', diag); } catch (_) {} }
        S.gtxt = 'Saving…'; render();
        const out = await assemble();
        if (CFG.GRAB_FINALIZE && out.ext === 'mp4') {
          S.gtxt = 'Finalizing (making it seekable)…'; render();
          let tot = 0;
          for (let i = 0; i < out.files.length; i++) {
            try {
              const r = await finalizeMp4(out.files[i]);
              out.files[i] = r.blob;
              if (r.gaps.length) warn += ' · ' + r.gaps.length + ' gap(s) (' + r.gaps.reduce((a, g) => a + g.sec, 0).toFixed(1) + 's) filled';
            } catch (_) { /* không phải fMP4 / lỗi: giữ nguyên file gốc */ }
            tot += out.files[i].size;
          }
          out.total = tot;
        }
        const base = grabName();
        for (let i = 0; i < out.files.length; i++) {
          const sfx = out.suffix ? out.suffix[i] : (out.files.length > 1 ? '_part' + (i + 1) : '');
          saveBlob(out.files[i], base + sfx + '.' + (out.suffix && /audio/.test(sfx) ? 'm4a' : out.ext));
          if (i < out.files.length - 1) await sleep(1500);
        }
        if (warn && CFG.GRAB_LOG) { try { await sleep(1500); saveBlob(new Blob([JSON.stringify(diag, null, 1)], { type: 'text/plain' }), base + '_grablog.txt'); } catch (_) {} }
        TAP.store.clear(); TAP.blind = []; TAP.bytes = 0; TAP.want.clear(); TAP.on = false; mseClear();
        S.state = 'idle';
        flash('Saved ✓ ' + fmtSize(out.total) + (out.files.length > 1 ? ' in ' + out.files.length + ' parts' : '') + (out.miss ? ' · ' + out.miss + ' segments missing' : '') + out.mixed + warn, warn ? 20000 : 0);
      } catch (e) {
        while (undo.length) { try { undo.pop()(); } catch (_) {} }
        TAP.on = false; TAP.store.clear(); TAP.blind = []; TAP.bytes = 0; TAP.want.clear(); mseClear();
        S.state = 'idle';
        
        flash((e && e.message) || 'Grab failed');
      }
    }

    // Tải lại trang (đánh dấu trước) để bắt TỪ ĐẦU mọi thứ trình phát tải; sau khi tải lại sẽ tự chạy runGrab()
    function reloadGrab() {
      if (S.state !== 'idle') return;
      try { GM_setValue(GRAB_KEY, { t: Date.now(), name: S.name, h: location.href }); } catch (_) { return flash('Can’t reload: storage unavailable'); }
      flash('Reloading the page to capture the stream…');
      setTimeout(() => location.reload(), 700);
    }

    /* ---------- giao diện (div nổi, kéo thả được) ---------- */
    const REC_CSS = `
.box{display:flex;align-items:center;gap:10px;padding:7px 8px 7px 7px;border-radius:999px;
  background:rgba(28,28,34,.58);-webkit-backdrop-filter:blur(18px) saturate(1.7);backdrop-filter:blur(18px) saturate(1.7);
  border:1px solid rgba(255,255,255,.22);box-shadow:0 8px 28px rgba(0,0,0,.38),inset 0 1px 0 rgba(255,255,255,.28);
  color:#fff;font:600 13px/1 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;cursor:grab;user-select:none;-webkit-user-select:none;touch-action:none}
button{all:unset;box-sizing:border-box;cursor:pointer}
.btn{width:36px;height:36px;border-radius:50%;background:rgba(255,255,255,.16);display:grid;place-items:center}
.btn:hover{background:rgba(255,255,255,.26)}
.btn[disabled]{opacity:.5;cursor:default}
.sq{display:none;width:13px;height:13px;border-radius:3px;background:#fff}
@keyframes pulse{50%{background:rgba(255,69,58,.45)}}
.label{font-variant-numeric:tabular-nums;white-space:nowrap;padding:0 2px;max-width:260px;overflow:hidden;text-overflow:ellipsis}
.x{width:24px;height:24px;border-radius:50%;display:grid;place-items:center;font-size:16px;color:rgba(255,255,255,.75)}
.x:hover{background:rgba(255,255,255,.18);color:#fff}
.x.hide{display:none}
.box.grab{border-color:rgba(10,132,255,.85);box-shadow:0 8px 28px rgba(0,0,0,.38),0 0 0 3px rgba(10,132,255,.25)}
.g svg{display:block}.g .sq{display:none}.grab .g svg{display:none}.grab .g .sq{display:block}
.grab .g{animation:pulse 1.4s ease-in-out infinite}`;

    function render() {
      if (!S.host) return;
      const grabbing = S.state === 'grabbing';
      S.box.classList.toggle('grab', grabbing);
      S.gbtn.title = grabbing ? 'Cancel' : 'Download this video: the page reloads once while the stream is captured (original quality)';
      S.x.classList.toggle('hide', grabbing);
      let t;
      if (grabbing) {
        t = S.gtotal ? 'Downloading ' + S.gdone + '/' + S.gtotal + ' · ' + fmtSize(TAP.bytes) : (S.gtxt || 'Downloading…');
        if (S.gtotal && S.gtxt) t = S.gtxt;
      } else t = S.msg || 'Download video';
      if (S.label.textContent !== t) S.label.textContent = t;
    }

    function mount() {
      if (S.host) { if (!S.host.isConnected) (document.documentElement).appendChild(S.host); return; }
      const host = document.createElement('div');
      host.id = 'tc-rec-host';
      host.style.cssText = 'all:initial;position:fixed;right:20px;bottom:90px;z-index:2147483647;';
      const root = host.attachShadow({ mode: 'closed' });
      try { const sh = new CSSStyleSheet(); sh.replaceSync(REC_CSS); root.adoptedStyleSheets = [sh]; }
      catch (_) { const st = document.createElement('style'); st.textContent = REC_CSS; root.append(st); }

      const gbtn = h('button', { class: 'btn g', type: 'button', 'aria-label': 'Grab stream' }, icon(ARROW_DOWN, 20, 2.5), h('span', { class: 'sq' }));
      const label = h('span', { class: 'label' }, 'Download video');
      const x = h('button', { class: 'x', type: 'button', title: 'Close', 'aria-label': 'Close' }, '×');
      const box = h('div', { class: 'box' }, gbtn, label, x);
      root.append(box);
      Object.assign(S, { host, box, gbtn, label, x });

      gbtn.addEventListener('click', () => { if (S.state === 'grabbing') S.cancel = true; else reloadGrab(); });
      x.addEventListener('click', () => { if (S.state === 'idle') { host.remove(); } });

      // không để sự kiện lọt ra trang
      ['click', 'mousedown', 'mouseup', 'pointerup', 'touchstart', 'touchend', 'dblclick', 'contextmenu']
        .forEach((ev) => box.addEventListener(ev, (e) => e.stopPropagation()));

      // kéo thả
      let drag = null;
      box.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        if (e.target.closest && e.target.closest('button')) return;
        const r = host.getBoundingClientRect();
        drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
        try { box.setPointerCapture(e.pointerId); } catch (_) {}
        box.style.cursor = 'grabbing';
      });
      box.addEventListener('pointermove', (e) => {
        if (!drag) return;
        const r = host.getBoundingClientRect();
        const l = Math.min(Math.max(0, e.clientX - drag.dx), Math.max(0, innerWidth - r.width));
        const t = Math.min(Math.max(0, e.clientY - drag.dy), Math.max(0, innerHeight - r.height));
        host.style.left = l + 'px'; host.style.top = t + 'px'; host.style.right = 'auto'; host.style.bottom = 'auto';
      });
      const end = () => { drag = null; box.style.cursor = ''; };
      box.addEventListener('pointerup', end);
      box.addEventListener('pointercancel', end);

      document.documentElement.appendChild(host);
      render();
    }

    /* ---------- API ---------- */
    // Hiện div ghi hình. Frame này có video -> hiện ở đây; không có -> chuyển lệnh xuống các iframe con.
    function show(o) {
      o = o || {};
      if (o.name) S.name = o.name;
      if (o.url) S.url = o.url;
      if (pickVideo()) {
        mount();
        if (o.auto && CFG.GRAB_AUTO && S.state === 'idle') reloadGrab();
        return true;
      }
      let sent = false;
      document.querySelectorAll('iframe,frame').forEach((f) => {
        try { f.contentWindow.postMessage({ tcRec: 1, name: o.name || '', url: o.url || '', auto: !!o.auto }, '*'); sent = true; } catch (_) {}
      });
      return sent;
    }

    function init() {
      // frame con nhận lệnh từ frame cha
      window.addEventListener('message', (e) => {
        const d = e.data;
        if (!d || d.tcRec !== 1 || e.source !== window.parent || e.source === window) return;
        show({ name: typeof d.name === 'string' ? d.name : '', url: typeof d.url === 'string' ? d.url : '', auto: !!d.auto });
      });
      // Vừa tải lại trang theo yêu cầu Grab: hiện div và tự bắt đầu
      if (GRAB_ARMED) {
        S.name = GRAB_ARMED.name || '';
        const disarm = () => {
          GRAB_ARMED = null;
          TAP.on = false; TAP.store.clear(); TAP.blind = []; TAP.bytes = 0; TAP.want.clear();
        };
        const go = async () => {
          // Chờ video xuất hiện (trang có thể đổi URL/redirect rồi mới dựng trình phát)
          const t0 = performance.now();
          while (performance.now() - t0 < 20000 && !pickVideo()) await sleep(400);
          // Frame không có video: bỏ qua (frame cha vẫn giữ lệnh để chạy kiểu "bấm play")
          if (!pickVideo() && !IS_TOP) { disarm(); return; }
          // Khóa chỉ bị xóa khi có frame nhận lệnh; frame khác đã nhận rồi thì bỏ
          let still = null;
          try { still = GM_getValue(GRAB_KEY, null); } catch (_) {}
          if (!still) { disarm(); return; }
          try { GM_deleteValue(GRAB_KEY); } catch (_) {}
          mount(); runGrab();
        };
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go); else go();
      }
      // fullscreen: đưa div vào phần tử fullscreen để vẫn nhìn thấy
      document.addEventListener('fullscreenchange', () => {
        if (!S.host) return;
        const fe = document.fullscreenElement;
        const t = fe && fe.tagName !== 'VIDEO' ? fe : document.documentElement;
        if (S.host.parentNode !== t) t.appendChild(S.host);
      });
    }

    return { init, show };
  })();

  /* =====================================================================
   *  KHỞI ĐỘNG
   * ===================================================================== */
  // Keep settings in sync when they are changed from another tab
  if (typeof GM_addValueChangeListener === 'function') {
    try {
      GM_addValueChangeListener(SET_KEY, (name, oldV, newV, remote) => {
        if (!remote) return;
        loadSettings();
        if (UI) UI.applySettings();
        bump();
      });
    } catch (_) {}
  }

  let GRAB_ARMED = null;
  try {
    const o = typeof GM_getValue === 'function' ? GM_getValue(GRAB_KEY, null) : null;
    if (o) {
      if (o.t && Date.now() - o.t < 5 * 60e3) { GRAB_ARMED = o; TAP.on = true; }
      else { try { GM_deleteValue(GRAB_KEY); } catch (_) {} }
    }
  } catch (_) {}
  try { NATIVE_FETCH = W.fetch ? W.fetch.bind(W) : null; } catch (_) {}
  hookNetwork();
  Rec.init();
  initHover();
  if (IS_GRAB && IS_TOP) grabAutofill();

  if (IS_TOP) {
    // Nhận link bắt được từ các iframe (trình phát nhúng)
    window.addEventListener('message', (e) => {
      const d = e.data;
      if (!d || d.tcMedia !== 1 || !d.item || typeof d.item.url !== 'string' || e.source === window) return;
      const i = d.item;
      record(i.url, {
        relay: true, mime: String(i.mime || ''), size: +i.size || null,
        type: DEFAULT_EXT[i.type] ? i.type : undefined,
        q: String(i.q || ''), w: +i.w || undefined, h: +i.h || undefined,
        ref: typeof i.ref === 'string' ? i.ref : undefined, title: typeof i.title === 'string' ? i.title : undefined,
      });
    });

    const ready = (fn) => (document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', fn) : fn());
    ready(() => {
      ui().mountQuick();
      maybeWelcome();
      window.addEventListener('load', () => { scanDom(); bump(); });
    });
    if (IS_YT) {
      ytWatch();
      document.addEventListener('yt-navigate-finish', ytWatch, true);
      window.addEventListener('popstate', () => setTimeout(ytWatch, 300));
      setInterval(ytWatch, 2000);
    }
    if (typeof GM_registerMenuCommand === 'function') {
      GM_registerMenuCommand('⬇ Quick download (open list)', () => openAll());
      GM_registerMenuCommand('⬇ Download video on this page', () => { if (!Rec.show({})) ui().toast('No video found on this page', 3000); });
      GM_registerMenuCommand('⚙ Settings', () => ui().openSettings());
    }
  }
})();
