/**
 * 通用媒体发现器 —— 只按"特征"识别，不认识任何具体站点。
 *
 * 三种发现器，按可靠性排序：
 *   1. 直出：<video src> / <source src> / og:video / JSON-LD contentUrl
 *   2. 打包：播放器把配置塞进 eval(function(p,a,c,k,e,d){...})，解开再找
 *   3. 嵌入：<iframe> 指向播放器，需要再抓一层才能拿到真地址
 *
 * 列表页另有一个"链接模板分组"：同一站内路径结构重复 >= 3 次的，基本就是条目列表。
 *
 * 全是纯函数、不联网，方便单测。
 */

const EXT_ALT = 'mp4|m4v|mov|webm|mkv|flv|avi|m3u8|m3u|mpd|ts|m4s';

// (https?:)?// 两种写法都收；路径里不许出现引号/尖括号/反斜杠
const URL_RE = new RegExp(
  `(?:(?:https?:)?//)[^\\s"'<>()\\\\]*?\\.(?:${EXT_ALT})(?:\\?[^\\s"'<>()\\\\]*)?`,
  'gi'
);

// 打包器：eval(function(p,a,c,k,e,d){...}('payload',62,35,'dict'.split('|'),0,{}))
const PACK_RE =
  /eval\(\s*function\s*\(\s*p\s*,\s*a\s*,\s*c\s*,\s*k\s*,\s*e\s*,\s*\w\s*\)[\s\S]*?\}\s*\(\s*'([\s\S]*?)'\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*'([\s\S]*?)'\.split\(\s*['"]\|['"]\s*\)/g;

const B62 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

// 导航栏、法律页、登录页，当条目列表看会全是噪音
const NAV_HINT =
  /\/(?:login|logout|register|signup|signin|terms|privacy|dmca|support|contact|about|faq|help|upload|press|service|tos|cookies?|2257|rss|feed)\/?$/i;

export function decodeHtml(s) {
  return String(s)
    .replace(/\\\//g, '/')          // JS 字符串里的 \/ 
    .replace(/\\u002f/gi, '/')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

export function kindOf(url) {
  const clean = String(url).split('?')[0];
  const ext = (clean.match(/\.([a-z0-9]{2,5})$/i) || [, ''])[1].toLowerCase();
  if (ext === 'm3u8' || ext === 'm3u') return 'HLS';
  if (ext === 'mpd') return 'DASH';
  if (ext === 'webm') return 'WEBM';
  if (ext === 'mkv') return 'MKV';
  if (ext === 'flv') return 'FLV';
  if (ext === 'avi') return 'AVI';
  if (ext === 'ts' || ext === 'm4s') return 'TS';
  if (ext === 'mp4' || ext === 'm4v' || ext === 'mov') return 'MP4';
  return 'OTHER';
}

function normalize(u) {
  let s = String(u || '').trim();
  if (!s) return '';
  s = decodeHtml(s).replace(/^["']|["']$/g, '');
  if (s.startsWith('//')) s = 'https:' + s;
  return s;
}

export function absUrl(u, base) {
  const s = normalize(u);
  if (!s) return '';
  try { return new URL(s, base).href; } catch { return s; }
}

/** 从任意文本里捞媒体地址（会先反转义 \/ 和 &amp;） */
export function scanUrls(text) {
  const out = [];
  const src = decodeHtml(text);
  for (const m of src.matchAll(URL_RE)) out.push(normalize(m[0]));
  return unique(out.filter(Boolean));
}

export function unique(list) {
  const seen = new Set();
  const out = [];
  for (const x of list) {
    if (!x || seen.has(x)) continue;
    seen.add(x);
    out.push(x);
  }
  return out;
}

// ---------------------------------------------------------------- 打包器
function fromBase(str, base) {
  let n = 0;
  for (const ch of str) {
    const d = B62.indexOf(ch);
    if (d < 0 || d >= base) return -1;
    n = n * base + d;
  }
  return n;
}

/** 解一段 packer：payload 里每个 \w+ 是 base-a 的字典下标 */
export function unpackOne(payload, base, keys) {
  if (!payload || base < 2 || base > 62) return '';
  const joined = keys.split('|');
  const text = payload.replace(/\b\w+\b/g, (tok) => {
    const idx = fromBase(tok, base);
    if (idx < 0 || idx >= joined.length) return tok;
    return joined[idx] || tok;
  });
  return text.replace(/\\'/g, "'").replace(/\\\\/g, '\\');
}

/** 把页面里所有打包脚本都解开，返回解出来的文本数组 */
export function unpackAll(html) {
  const src = String(html || '');
  const out = [];
  for (const m of src.matchAll(PACK_RE)) {
    const text = unpackOne(m[1], Number(m[2]), m[4]);
    if (text) out.push(text);
  }
  return out;
}

// ---------------------------------------------------------------- 各类发现器

function attr(html, name) {
  const re = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i');
  const m = String(html).match(re);
  return m ? (m[2] ?? m[3] ?? '') : '';
}

/** 页面里直接写出来的媒体 */
export function discoverDirect(html, baseUrl) {
  const hits = [];
  const src = String(html || '');
  const push = (u, from) => {
    const url = absUrl(u, baseUrl);
    if (url) hits.push({ url, kind: kindOf(url), from });
  };

  for (const tag of src.match(/<video\b[^>]*>/gi) || []) push(attr(tag, 'src'), 'tag');
  for (const tag of src.match(/<source\b[^>]*>/gi) || []) push(attr(tag, 'src'), 'tag');
  for (const tag of src.match(/<audio\b[^>]*>/gi) || []) push(attr(tag, 'src'), 'tag');

  for (const tag of src.match(/<meta\b[^>]*>/gi) || []) {
    const prop = (attr(tag, 'property') || attr(tag, 'name')).toLowerCase();
    if (/^(og:video|og:video:url|og:video:secure_url|twitter:player:stream)$/.test(prop)) {
      push(attr(tag, 'content'), 'og');
    }
  }

  for (const m of src.matchAll(/"(?:contentUrl|contentURL)"\s*:\s*"([^"]+)"/g)) push(m[1], 'jsonld');

  return hits;
}

/** 解包后的播放器配置：优先找显式字段，再退化成扫 URL */
export function discoverPacked(html, baseUrl) {
  const hits = [];
  const texts = unpackAll(html);
  const fieldRe =
    /(?:wurl|vurl|file|src|url|playlist|hls|mp4|stream)\s*[:=]\s*["']([^"']{12,})["']/gi;

  for (const text of texts) {
    for (const m of text.matchAll(fieldRe)) {
      const raw = normalize(m[1]);
      if (!raw) continue;
      if (!/^https?:\/\//i.test(raw) && !raw.startsWith('//')) continue;
      const url = absUrl(raw, baseUrl);
      if (!url) continue;
      if (!/\.(mp4|m4v|mov|webm|mkv|m3u8|mpd|flv|ts)(\?|$)/i.test(url)) continue;
      hits.push({ url, kind: kindOf(url), from: 'packed' });
    }
    for (const url of scanUrls(text)) {
      hits.push({ url: absUrl(url, baseUrl), kind: kindOf(url), from: 'packed' });
    }
  }
  return hits;
}

/** 页面里零散出现（内联 script、data 属性）的媒体地址 */
export function discoverInline(html, baseUrl) {
  return scanUrls(html).map((u) => {
    const url = absUrl(u, baseUrl);
    return { url, kind: kindOf(url), from: 'inline' };
  });
}

/** 播放器 iframe */
export function discoverEmbeds(html, baseUrl) {
  const out = [];
  const src = String(html || '');
  for (const tag of src.match(/<iframe\b[^>]*>/gi) || []) {
    const raw = attr(tag, 'src');
    if (!raw) continue;
    const url = absUrl(raw, baseUrl);
    if (!url) continue;
    let host = '';
    let path = '';
    try { const u = new URL(url); host = u.host; path = u.pathname; } catch {}
    // /e/123、/embed/123、/v/123、/player?id= 这类基本就是播放器
    const hint = /\/(?:e|embed|v|player|iframe|watch)\//i.test(path) || /[?&](?:id|v|video)=/i.test(url);
    out.push({ url, host, hint });
  }
  return out;
}

/** 路径模板：把数字 id / uuid 抹成 :id，用来认出"重复的条目结构" */
export function pathTemplate(href) {
  let s = String(href || '');
  try {
    const u = new URL(s);
    s = u.host + u.pathname;
  } catch { return s; }
  return s
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/:id')
    .replace(/\/\d{3,}/g, '/:id')
    .replace(/\/[0-9a-f]{16,}/gi, '/:id');
}

function stripTags(s) {
  return decodeHtml(String(s).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** 页面里的链接，带可读标签 */
export function discoverLinks(html, baseUrl) {
  const out = [];
  const src = String(html || '');
  for (const m of src.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const tag = m[1] || '';
    const href = attr(tag, 'href');
    if (!href || /^(?:#|javascript:|mailto:|tel:)/i.test(href.trim())) continue;
    const url = absUrl(href, baseUrl);
    if (!url || !/^https?:/i.test(url)) continue;
    let host = '';
    try { host = new URL(url).host; } catch { continue; }
    let baseHost = '';
    try { baseHost = new URL(baseUrl).host; } catch {}
    if (baseHost && host !== baseHost) continue;          // 站外链接不进条目
    const label = stripTags(m[2]) || attr(tag, 'title') || attr(tag, 'aria-label');
    out.push({ url, label: label.slice(0, 80), template: pathTemplate(url) });
  }
  // 同一 URL 可能被图片链接和标题链接各包一层
  const byUrl = new Map();
  for (const it of out) {
    const prev = byUrl.get(it.url);
    if (!prev || (it.label.length > prev.label.length)) byUrl.set(it.url, it);
  }
  return [...byUrl.values()];
}

/**
 * 主入口：一次分析出所有线索。
 * 返回的 media 已按可靠性排好序（直出 > og > jsonld > 打包 > 内联）。
 */
export function discover(html, baseUrl) {
  const raw = String(html || '');

  const title =
    (raw.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) || [])[1] ||
    (raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] ||
    '';
  const cleanTitle = stripTags(title).slice(0, 120);

  const order = { tag: 0, og: 0, jsonld: 1, packed: 2, inline: 3 };
  const media = [
    ...discoverDirect(raw, baseUrl),
    ...discoverPacked(raw, baseUrl),
    ...discoverInline(raw, baseUrl)
  ]
    .filter((x) => x.url && /^https?:/i.test(x.url))
    .sort((a, b) => (order[a.from] ?? 9) - (order[b.from] ?? 9));

  const seen = new Set();
  const mediaClean = [];
  for (const it of media) {
    if (seen.has(it.url)) continue;
    seen.add(it.url);
    mediaClean.push(it);
  }

  const links = discoverLinks(raw, baseUrl).filter((l) => !NAV_HINT.test(new URL(l.url).pathname));

  // 模板重复 >= 3 次 = 条目列表
  const groups = new Map();
  for (const l of links) {
    if (!groups.has(l.template)) groups.set(l.template, []);
    groups.get(l.template).push(l);
  }
  const listing = [...groups.entries()]
    .filter(([, items]) => items.length >= 3)
    .map(([template, items]) => ({
      template,
      count: items.length,
      items: items.map((i) => ({ url: i.url, label: i.label }))
    }))
    .sort((a, b) => b.count - a.count);

  return { title: cleanTitle, media: mediaClean, embeds: discoverEmbeds(raw, baseUrl), links, listing };
}

/** 页面看着像"内容没了" */
export function looksGone(html, status) {
  if (status === 404 || status === 410) return true;
  const t = stripTags(String(html || '')).slice(0, 4000);
  return /(video|page|content)\s+(was\s+)?(removed|deleted|unavailable|not\s+found)|no\s+longer\s+available|已删除|不存在|已下架/i.test(t);
}
