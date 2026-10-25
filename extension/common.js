// 公共工具：类型识别、体积格式化、aria2 / 助手调用、播放列表解析、命令生成。

export const DEFAULT_SETTINGS = {
  aria2Rpc: 'http://127.0.0.1:6800/jsonrpc',
  aria2Secret: '',
  aria2Conns: 16,
  aria2Split: 16,
  aria2MinSplit: '1M',
  aria2Dir: '',            // 空 = 用 aria2 自己的默认目录
  helperUrl: 'http://127.0.0.1:8765',
  outputDir: '',           // 空 = 用助手默认目录（~/Desktop）
  proxyMode: 'auto',       // auto = 跟随系统代理；off = 直连；manual = 用下面的地址
  proxy: '',               // manual 模式下的地址，如 http://127.0.0.1:7897
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  showSegments: false,     // 是否在列表里显示 .ts / .m4s 分片
  minSizeKB: 0,            // 小于这个体积的响应忽略（0 = 不过滤）
  autoClean: true          // 切换页面时清空该标签页的旧记录
};

export const KIND_LABEL = {
  HLS: 'HLS 流',
  DASH: 'DASH',
  MP4: 'MP4',
  WEBM: 'WebM',
  MKV: 'MKV',
  FLV: 'FLV',
  AVI: 'AVI',
  AUDIO: '音频',
  TS: '分片',
  OTHER: '其他'
};

const EXT_KIND = {
  m3u8: 'HLS', m3u: 'HLS',
  mpd: 'DASH',
  mp4: 'MP4', m4v: 'MP4', mov: 'MP4', qt: 'MP4',
  webm: 'WEBM', mkv: 'MKV', flv: 'FLV', avi: 'AVI', f4v: 'FLV',
  ts: 'TS', m4s: 'TS', cmfv: 'TS', cmfa: 'TS',
  m4a: 'AUDIO', mp3: 'AUDIO', aac: 'AUDIO', ogg: 'AUDIO', opus: 'AUDIO', flac: 'AUDIO', wav: 'AUDIO', mka: 'AUDIO'
};

export function extOf(url) {
  try {
    const p = new URL(url).pathname;
    const seg = p.split('/').pop() || '';
    const i = seg.lastIndexOf('.');
    return i >= 0 ? seg.slice(i + 1).toLowerCase() : '';
  } catch {
    return '';
  }
}

/** 返回媒体类型，非媒体返回 null。contentType 可为空。 */
export function classify(url, contentType = '') {
  const ct = String(contentType || '').toLowerCase();
  const ext = extOf(url);

  if (ct.includes('mpegurl') || ext === 'm3u8' || ext === 'm3u') return 'HLS';
  if (ct.includes('dash+xml') || ext === 'mpd') return 'DASH';

  if (ext === 'ts' || ext === 'm4s') {
    // .ts 也可能是 TypeScript 源文件，只认视频类 content-type
    if (ct.includes('mp2t') || ct.includes('iso.segment') || ct.includes('octet-stream') || ct.includes('video/')) {
      return 'TS';
    }
    return null;
  }

  if (ct.startsWith('video/')) {
    if (ct.includes('mp4')) return 'MP4';
    if (ct.includes('webm')) return 'WEBM';
    if (ct.includes('matroska')) return 'MKV';
    if (ct.includes('flv')) return 'FLV';
    return EXT_KIND[ext] || 'MP4';
  }
  if (ct.startsWith('audio/')) return 'AUDIO';

  const k = EXT_KIND[ext];
  if (k && k !== 'TS') return k;
  return null;
}

export function humanBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let x = v;
  while (x >= 1024 && i < units.length - 1) { x /= 1024; i++; }
  return `${x >= 100 || i === 0 ? Math.round(x) : x.toFixed(1)} ${units[i]}`;
}

export function humanDuration(sec) {
  const s = Math.round(Number(sec) || 0);
  if (!s) return '';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
           : `${m}:${String(ss).padStart(2, '0')}`;
}

export function fileNameFromUrl(url, kind = '') {
  try {
    const u = new URL(url);
    let name = decodeURIComponent((u.pathname.split('/').pop() || '').trim());
    if (!name || !/\.[a-z0-9]{2,5}$/i.test(name)) {
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
      const ext = kind === 'HLS' ? 'mp4' : kind === 'DASH' ? 'mp4' : kind === 'AUDIO' ? 'm4a' : 'mp4';
      name = `video-${stamp}.${ext}`;
    }
    return name.replace(/[\\/:*?"<>|]/g, '_');
  } catch {
    return 'video.mp4';
  }
}

export function hostOf(url) {
  try { return new URL(url).host; } catch { return ''; }
}

/** 把嗅探到的头转成 aria2 能用的 ["Referer: ..."] 数组 */
export function headerLines(item, settings = DEFAULT_SETTINGS) {
  const h = item.headers || {};
  const out = [];
  const ua = h.ua || settings.userAgent;
  if (ua) out.push(`User-Agent: ${ua}`);
  if (h.referer) out.push(`Referer: ${h.referer}`);
  if (h.origin) out.push(`Origin: ${h.origin}`);
  if (h.cookie) out.push(`Cookie: ${h.cookie}`);
  return out;
}

export async function aria2Call(settings, method, params = [], timeoutMs = 8000) {
  const body = {
    jsonrpc: '2.0',
    id: 'vg-' + Date.now(),
    method,
    params: [`token:${settings.aria2Secret || ''}`, ...params]
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(settings.aria2Rpc, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    if (!res.ok) throw new Error(`aria2 HTTP ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error.message || 'aria2 返回错误');
    return data.result;
  } catch (e) {
    if (e?.name === 'AbortError') throw new Error('aria2 超时没响应');
    if (String(e?.message || '').includes('fetch')) {
      throw new Error('aria2 没在跑（127.0.0.1:6800 连不上）');
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** 生成 aria2.addUri 的参数 */
export function aria2Options(settings, item, name) {
  const opt = {
    'max-connection-per-server': String(settings.aria2Conns || 16),
    split: String(settings.aria2Split || 16),
    'min-split-size': settings.aria2MinSplit || '1M',
    continue: 'true',
    'file-allocation': 'none',
    'auto-file-renaming': 'false',
    'allow-overwrite': 'false',
    'retry-wait': '3',
    'max-tries': '0',
    header: headerLines(item, settings)
  };
  if (name) opt.out = name;
  if (settings.aria2Dir) opt.dir = settings.aria2Dir;
  if (settings.proxy) opt['all-proxy'] = settings.proxy;
  return opt;
}

/** aria2 -i 输入文件：一条 URL + 缩进选项，可带 header */
export function aria2InputText(items, settings = DEFAULT_SETTINGS) {
  const blocks = [];
  for (const item of items) {
    const name = item.name || fileNameFromUrl(item.url, item.kind);
    const lines = [item.url];
    if (settings.aria2Dir) lines.push(`  dir=${settings.aria2Dir}`);
    lines.push(`  out=${name}`);
    lines.push(`  max-connection-per-server=${settings.aria2Conns || 16}`);
    lines.push(`  split=${settings.aria2Split || 16}`);
    lines.push(`  min-split-size=${settings.aria2MinSplit || '1M'}`);
    lines.push('  continue=true');
    for (const h of headerLines(item, settings)) lines.push(`  header=${h}`);
    blocks.push(lines.join('\n'));
  }
  return blocks.join('\n\n') + '\n';
}

function shellQuote(s) {
  return `"${String(s).replace(/(["\\$`])/g, '\\$1')}"`;
}

/** 可直接粘到终端的 ffmpeg 命令（HLS 用） */
export function ffmpegCommand(item, outPath, settings = DEFAULT_SETTINGS) {
  const h = item.headers || {};
  const hdr = [];
  const ua = h.ua || settings.userAgent;
  if (h.referer) hdr.push(`Referer: ${h.referer}`);
  if (h.origin) hdr.push(`Origin: ${h.origin}`);
  if (h.cookie) hdr.push(`Cookie: ${h.cookie}`);
  const headArgs = [];
  if (hdr.length) headArgs.push(`-headers ${shellQuote(hdr.join('\r\n'))}`);
  if (ua) headArgs.push(`-user_agent ${shellQuote(ua)}`);
  return [
    'ffmpeg',
    ...headArgs,
    '-protocol_whitelist file,http,https,tcp,tls,crypto',
    '-allowed_extensions ALL',
    '-allowed_segment_extensions ALL',
    '-extension_picky 0',
    `-i ${shellQuote(item.url)}`,
    '-c copy',
    shellQuote(outPath)
  ].join(' \\\n  ');
}

/** 复制到剪贴板的纯命令（不带换行装饰） */
export function ffmpegCommandOneLine(item, outPath, settings = DEFAULT_SETTINGS) {
  return ffmpegCommand(item, outPath, settings).replace(/\\\n\s*/g, '');
}

function parseAttrs(s) {
  const out = {};
  let depth = 0;
  let cur = '';
  const parts = [];
  for (const ch of s) {
    if (ch === '"') depth = depth ? 0 : 1;
    if (ch === ',' && !depth) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur) parts.push(cur);
  for (const p of parts) {
    const i = p.indexOf('=');
    if (i < 0) continue;
    const k = p.slice(0, i).trim().toUpperCase();
    let v = p.slice(i + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    out[k] = v;
  }
  return out;
}

function resolveUrl(u, base) {
  try { return new URL(u, base).href; } catch { return u; }
}

/** 解析 m3u8 文本：master 返回变体列表，media 返回时长/分片数/加密 */
export function parsePlaylist(text, baseUrl) {
  const lines = String(text).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length || !lines[0].startsWith('#EXTM3U')) return { type: 'invalid' };

  const isMaster = lines.some(l => l.startsWith('#EXT-X-STREAM-INF'));
  if (isMaster) {
    const variants = [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (!l.startsWith('#EXT-X-STREAM-INF')) continue;
      const attrs = parseAttrs(l.slice(l.indexOf(':') + 1));
      let next = '';
      for (let j = i + 1; j < lines.length; j++) {
        if (!lines[j].startsWith('#')) { next = lines[j]; break; }
      }
      if (!next) continue;
      variants.push({
        url: resolveUrl(next, baseUrl),
        bandwidth: Number(attrs.BANDWIDTH) || 0,
        resolution: attrs.RESOLUTION || '',
        codecs: attrs.CODECS || '',
        frameRate: attrs['FRAME-RATE'] || ''
      });
    }
    variants.sort((a, b) => b.bandwidth - a.bandwidth);
    return { type: 'master', variants };
  }

  const segments = lines.filter(l => !l.startsWith('#')).length;
  let duration = 0;
  for (const l of lines) {
    if (l.startsWith('#EXTINF:')) duration += parseFloat(l.slice(8)) || 0;
  }
  const keys = lines.filter(l => l.startsWith('#EXT-X-KEY')).map(l => parseAttrs(l.slice(l.indexOf(':') + 1)));
  const encrypted = keys.some(k => (k.METHOD || 'NONE').toUpperCase() !== 'NONE');
  const ended = lines.some(l => l.startsWith('#EXT-X-ENDLIST'));
  return {
    type: 'media',
    segments,
    duration: Math.round(duration),
    encrypted,
    keyUri: encrypted ? (keys.find(k => k.URI) || {}).URI || '' : '',
    live: !ended
  };
}

export async function helperCall(settings, path, init = {}, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(settings.helperUrl.replace(/\/$/, '') + path, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
      signal: ctrl.signal
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `助手 HTTP ${res.status}`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/** 从嗅探记录生成一个"下载任务"对象 */
export function toTask(item, settings = DEFAULT_SETTINGS) {
  return {
    url: item.url,
    kind: item.kind,
    name: item.name || fileNameFromUrl(item.url, item.kind),
    headers: { ...(item.headers || {}) },
    ua: (item.headers || {}).ua || settings.userAgent
  };
}
