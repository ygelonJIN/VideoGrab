#!/usr/bin/env node
/**
 * 无浏览器自测：
 *   1. common.js 纯函数（类型识别、m3u8 解析、aria2 参数、ffmpeg 命令）
 *   2. background.js 逻辑（用假 chrome API 模拟嗅探事件和消息）
 *   3. HTML/JS 的 id 交叉检查（防止 $('') 写错）
 * 用法：node tools/selftest.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'extension');
let pass = 0, fail = 0;
const results = [];

function check(name, cond, detail = '') {
  if (cond) { pass++; results.push(`✅ ${name}`); }
  else { fail++; results.push(`❌ ${name}${detail ? '  — ' + detail : ''}`); }
}

// ---------------------------------------------------------------- 1. common.js
const C = await import(path.join(EXT, 'common.js'));

check('默认代理模式是自动', C.DEFAULT_SETTINGS.proxyMode === 'auto', String(C.DEFAULT_SETTINGS.proxyMode));
check('classify mp4', C.classify('https://a.com/v/x.mp4', 'video/mp4') === 'MP4');
check('classify m3u8 by ext', C.classify('https://a.com/v/index.m3u8', 'text/plain') === 'HLS');
check('classify m3u8 by type', C.classify('https://a.com/v/play', 'application/vnd.apple.mpegurl') === 'HLS');
check('classify mpd', C.classify('https://a.com/v/manifest.mpd', 'application/dash+xml') === 'DASH');
check('classify ts(视频)', C.classify('https://a.com/v/seg1.ts', 'video/mp2t') === 'TS');
check('classify ts(TypeScript) 不误判', C.classify('https://a.com/src/app.ts', 'application/javascript') === null);
check('classify mp3', C.classify('https://a.com/a/x.mp3', 'audio/mpeg') === 'AUDIO');
check('classify 普通 json 不是媒体', C.classify('https://a.com/api/list.json', 'application/json') === null);
check('classify woff2 伪装分片（无类型）', C.classify('https://a.com/seg.woff2', 'application/octet-stream') === null);

check('humanBytes 1.3G', C.humanBytes(1395864371) === '1.3 GB', C.humanBytes(1395864371));
check('humanDuration 2h', C.humanDuration(7200) === '2:00:00', C.humanDuration(7200));

const master = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2"
720/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080
1080/index.m3u8`;
const pm = C.parsePlaylist(master, 'https://cdn.com/hls/master.m3u8');
check('m3u8 master 变体数', pm.type === 'master' && pm.variants.length === 2, JSON.stringify(pm).slice(0, 120));
check('m3u8 master 按码率排序', pm.variants[0].bandwidth === 5000000);
check('m3u8 相对地址解析', pm.variants[0].url === 'https://cdn.com/hls/1080/index.m3u8', pm.variants[0].url);

const media = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:6
#EXT-X-KEY:METHOD=AES-128,URI="https://cdn.com/key?id=1"
#EXTINF:6.000000,
seg0.ts
#EXTINF:5.500000,
seg1.ts
#EXT-X-ENDLIST`;
const md = C.parsePlaylist(media, 'https://cdn.com/x/index.m3u8');
check('m3u8 media 分片数', md.segments === 2);
check('m3u8 media 时长', Math.round(md.duration) === 12, String(md.duration));
check('m3u8 media 加密识别', md.encrypted === true && md.keyUri.includes('key?id=1'));
check('m3u8 直播判定', md.live === false);

const item = {
  url: 'https://cdn.com/v/x.mp4?s=1&e=2', kind: 'MP4',
  headers: { referer: 'https://site.com/watch/1', ua: 'UA/1', cookie: 'a=b', origin: 'https://site.com' }
};
const s = { ...C.DEFAULT_SETTINGS, aria2Conns: 16, aria2Split: 16, aria2Dir: '' };
const opt = C.aria2Options(s, item, 'x.mp4');
check('aria2 选项 header', opt.header.includes('Referer: https://site.com/watch/1') && opt.header.includes('Cookie: a=b'));
check('aria2 选项 并发', opt['max-connection-per-server'] === '16' && opt.split === '16');
check('aria2 选项 out', opt.out === 'x.mp4');
const optProxy = C.aria2Options({ ...s, proxy: 'http://127.0.0.1:7897' }, item, 'x.mp4');
check('aria2 选项带代理', optProxy['all-proxy'] === 'http://127.0.0.1:7897', JSON.stringify(optProxy['all-proxy']));
check('代理为空时不写 all-proxy', !('all-proxy' in C.aria2Options(s, item, 'x.mp4')));

const txt = C.aria2InputText([item, { ...item, url: 'https://cdn.com/v/y.mp4' }], s);
check('aria2 -i 文本 两条', txt.split('\n\n').length === 2);
check('aria2 -i 文本 带 header', txt.includes('header=Referer: https://site.com/watch/1'));
check('aria2 -i 文本 带 out', txt.includes('out=x.mp4'));

const cmd = C.ffmpegCommandOneLine({ ...item, kind: 'HLS', url: 'https://cdn.com/x/index.m3u8' }, '/tmp/a.mp4', s);
for (const frag of ['-extension_picky 0', '-allowed_extensions ALL', '-allowed_segment_extensions ALL', '-protocol_whitelist file,http,https,tcp,tls,crypto', 'Referer: https://site.com/watch/1', '-c copy']) {
  check('ffmpeg 命令片段 ' + frag.slice(0, 24), cmd.includes(frag));
}

// 批量兜底：本地分组的模板规则必须和助手里的发现器一致
const E = await import(path.join(ROOT, 'helper', 'extract.mjs'));
const sampleUrls = [
  'https://site.com/watch/123', 'https://site.com/watch/45678',
  'https://site.com/v/11111111-2222-3333-4444-555555555555',
  'https://site.com/clip/abcdef0123456789abcdef0'
];
check('pathTemplate 与助手实现一致', sampleUrls.every((u) => C.pathTemplate(u) === E.pathTemplate(u)),
  sampleUrls.map((u) => C.pathTemplate(u) + ' / ' + E.pathTemplate(u)).join(' | '));

const links = [
  ...[101, 102, 103, 104].map((n) => ({ url: `https://site.com/watch/${n}`, label: `第 ${n} 集` })),
  { url: 'https://site.com/about', label: '关于' }
];
const listing = C.groupListing(links);
check('groupListing 认出条目组', listing.length === 1 && listing[0].count === 4, JSON.stringify(listing).slice(0, 120));
check('groupListing 保留标签', listing[0]?.items?.[0]?.label === '第 101 集');
check('groupListing 排除导航页', !listing[0].items.some((i) => i.url.includes('/about')));
check('groupListing 不足 3 条不算列表', C.groupListing(['https://site.com/a/111', 'https://site.com/a/222']).length === 0);
check('groupListing 兼容纯字符串', C.groupListing([1, 2, 3].map((n) => `https://site.com/p/${n}00`)).length === 1);
check('groupListing 短数字 id 也认', C.groupListing(['https://site.com/v/12', 'https://site.com/v/13', 'https://site.com/v/14'])
  .some((g) => g.template === 'site.com/v/:id'));
check('groupListing slug 目录兜底', (() => {
  const g = C.groupListing(['https://site.com/videos/ep-one', 'https://site.com/videos/ep-two', 'https://site.com/videos/ep-three']);
  return g.length === 1 && g[0].template === 'site.com/videos/*' && g[0].count === 3;
})());
check('groupListing 根目录不兜底（导航全挤在根上）',
  C.groupListing(['https://site.com/alpha', 'https://site.com/bravo', 'https://site.com/charlie']).length === 0);
check('groupListing 过滤静态资源',
  C.groupListing(['https://site.com/assets/a.css', 'https://site.com/assets/b.png', 'https://site.com/assets/c.js']).length === 0);
check('groupListing 过滤翻页链接',
  C.groupListing(['https://site.com/videos/x?page=2', 'https://site.com/videos/y?page=3', 'https://site.com/videos/z?page=4']).length === 0);
check('groupListing 与助手实现结果一致', (() => {
  const sample = [...links,
    { url: 'https://site.com/videos/ep-one' }, { url: 'https://site.com/videos/ep-two' }, { url: 'https://site.com/videos/ep-three' },
    'https://site.com/v/12', 'https://site.com/v/13', 'https://site.com/v/14'];
  return JSON.stringify(C.groupListing(sample)) === JSON.stringify(E.groupDomLinks(sample));
})());
check('isHelperDown 认出连不上', C.isHelperDown('助手没在运行（127.0.0.1:8765 连不上）'));
check('isHelperDown 不误判旧版本', !C.isHelperDown('助手还是旧版本，没有这个接口：重启一下助手再试'));

// ---------------------------------------------------------------- 2. background.js（假 chrome）
const store = { session: new Map(), local: new Map() };
const mkStore = (m) => ({
  get: async (k) => {
    if (typeof k === 'string') return m.has(k) ? { [k]: m.get(k) } : {};
    return {};
  },
  set: async (o) => { for (const [k, v] of Object.entries(o)) m.set(k, v); },
  remove: async (k) => { m.delete(k); }
});

const L = {};
const noop = { addListener: () => {} };
globalThis.chrome = {
  webRequest: {
    onBeforeSendHeaders: { addListener: (fn) => { L.beforeSend = fn; } },
    onHeadersReceived: { addListener: (fn) => { L.headers = fn; } },
    onCompleted: { addListener: (fn) => { L.completed = fn; } },
    onErrorOccurred: { addListener: (fn) => { L.err = fn; } }
  },
  tabs: { onRemoved: noop, onUpdated: noop, query: async () => [] },
  action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, openPopup: async () => {} },
  storage: { session: mkStore(store.session), local: mkStore(store.local) },
  runtime: { onMessage: { addListener: (fn) => { L.msg = fn; } }, onInstalled: noop, openOptionsPage: () => {} },
  contextMenus: { removeAll: () => {}, create: () => {}, onClicked: noop },
  downloads: { download: async () => 1 },
  scripting: {
    executeScript: async () => [{ result: [
      { url: 'https://site.com/watch/101', label: '第 101 集' },
      { url: 'https://site.com/watch/102', label: '第 102 集' },
      { url: 'https://site.com/watch/103', label: '第 103 集' }
    ] }]
  }
};

let rpcBodies = [];
let scanBodies = [];
let scanOnline = false;   // true = /api/scan 返回真 JSON（助手在线）；false = 没有 json()，helperCall 会抛
globalThis.fetch = async (url, init) => {
  if (String(url).includes('6800')) {
    rpcBodies.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({ result: 'gid-' + rpcBodies.length }) };
  }
  if (String(url).includes('/api/probe')) {
    return { ok: true, status: 200, json: async () => ({ ok: true, media: { duration: 42, width: 1280, height: 720, thumbnail: 'data:image/jpeg;base64,xxxx' } }) };
  }
  if (String(url).includes('/api/scan')) {
    scanBodies.push(JSON.parse(init.body));
    if (!scanOnline) return { ok: true, status: 200, text: async () => '' };
    return {
      ok: true, status: 200,
      json: async () => ({
        ok: true, source: 'dom', title: '',
        listing: [{
          template: 'site.com/watch/:id', count: 3,
          items: [
            { url: 'https://site.com/watch/101', label: '' },
            { url: 'https://site.com/watch/102', label: '' },
            { url: 'https://site.com/watch/103', label: '' }
          ]
        }],
        total: 3
      })
    };
  }
  return { ok: true, text: async () => media, status: 200 };
};

await import(path.join(EXT, 'background.js'));
await new Promise((r) => setTimeout(r, 50));

const send = (msg) => new Promise((res) => L.msg(msg, {}, res));

// 造三个请求：mp4、m3u8、ts 分片
function req(rid, url, type, len, status = 200, reqHeaders = {}) {
  L.beforeSend({
    requestId: rid, url,
    requestHeaders: [
      { name: 'Referer', value: 'https://site.com/watch/1' },
      { name: 'User-Agent', value: 'UA/2' },
      { name: 'Cookie', value: 'sid=abc' },
      { name: 'Origin', value: 'https://site.com' }
    ]
  });
  L.headers({
    requestId: rid, tabId: 7, url, statusCode: status, initiator: 'https://site.com',
    responseHeaders: [
      { name: 'content-type', value: type },
      { name: 'content-length', value: String(len) },
      { name: 'accept-ranges', value: 'bytes' }
    ]
  });
}

req('r1', 'https://cdn.com/v/movie.mp4?sig=1', 'video/mp4', 1395864371);
req('r2', 'https://cdn.com/v/index.m3u8?t=2', 'application/vnd.apple.mpegurl', 800);
req('r3', 'https://cdn.com/v/seg0.ts', 'video/mp2t', 400000);
req('r4', 'https://cdn.com/v/old.mp4', 'video/mp4', 100, 403);
await new Promise((r) => setTimeout(r, 200));

let res = await send({ type: 'media:list', tabId: 7 });
check('background 消息可用', res && res.ok === true, JSON.stringify(res).slice(0, 200));
const items = res.items || [];
check('嗅探到 3 条（分片被折叠）', items.length === 3, items.map((i) => i.kind).join(','));
check('分片计数 1', res.segCount === 1, String(res.segCount));
const mp4 = items.find((i) => i.kind === 'MP4' && i.status === 200);
check('MP4 记录大小', mp4 && mp4.size === 1395864371);
check('MP4 抓到 Referer', mp4 && mp4.headers.referer === 'https://site.com/watch/1');
check('MP4 抓到 Cookie', mp4 && mp4.headers.cookie === 'sid=abc');
check('MP4 支持分段', mp4 && mp4.ranges === true);
check('403 也记录', items.some((i) => i.status === 403));

res = await send({ type: 'dl:txt', items });
check('dl:txt 生成', res.ok && res.text.includes('header=Referer: https://site.com/watch/1'));
check('dl:txt 文件名', res.text.includes('out=movie.mp4'), res.text.split('\n').slice(0, 4).join(' | '));

res = await send({ type: 'dl:aria2', items: [mp4] });
check('dl:aria2 拿到 gid', res.ok && res.gids.length === 1 && res.gids[0].gid === 'gid-1', JSON.stringify(res).slice(0, 200));
const rpc = rpcBodies[rpcBodies.length - 1];
const rpcOpt = rpc?.params?.[2] || {};
check('dl:aria2 传了 header', rpcOpt.header?.some((h) => h.startsWith('Referer:')), JSON.stringify(rpcOpt).slice(0, 200));
check('dl:aria2 传了并发', rpcOpt['max-connection-per-server'] === '16' && rpcOpt.split === '16');

res = await send({ type: 'dl:aria2', items: [{ ...mp4, kind: 'HLS', url: 'https://cdn.com/x.m3u8' }] });
check('dl:aria2 拒绝 HLS', res.ok && res.errors.length === 1 && res.gids.length === 0);

res = await send({ type: 'probe', item: mp4 });
check('probe 返回元信息', res.ok && res.media.duration === 42, JSON.stringify(res).slice(0, 160));
check('probe 带缩略图', String(res.media?.thumbnail || '').startsWith('data:image/jpeg'));

res = await send({ type: 'hls:parse', item: { url: 'https://cdn.com/x/index.m3u8', headers: {} } });
check('hls:parse 走 fetch 兜底', res.ok && res.result.type === 'media', JSON.stringify(res).slice(0, 200));

res = await send({ type: 'cfg:set', settings: { showSegments: true } });
check('cfg:set 生效', res.ok && res.settings.showSegments === true);
req('r5', 'https://cdn.com/v/seg1.ts', 'video/mp2t', 300000);
await new Promise((r) => setTimeout(r, 150));
res = await send({ type: 'media:list', tabId: 7 });
check('打开分片后能看到 TS', res.items.some((i) => i.kind === 'TS'));

// 批量扫描：助手（/api/scan）不通时退回本地分组，条目照样列得出来
res = await send({ type: 'batch:scan', tabId: 7, pageUrl: 'https://site.com/list' });
check('batch:scan 助手不通走本地分组', res.ok && res.helperDown === true && res.scan?.listing?.length === 1,
  JSON.stringify(res).slice(0, 160));
check('本地分组认出 3 条', res.scan?.listing?.[0]?.items?.length === 3);
check('本地分组保留标签', res.scan?.listing?.[0]?.items?.[0]?.label === '第 101 集');

// 助手在线链路：发给 /api/scan 的必须是纯字符串（对象会被老版助手按 /^https?:/ 整批丢掉）
scanOnline = true;
res = await send({ type: 'batch:scan', tabId: 7, pageUrl: 'https://site.com/list' });
const sentLinks = scanBodies.at(-1)?.links || [];
check('batch:scan 发给助手的是纯字符串', sentLinks.length === 3 && sentLinks.every((x) => typeof x === 'string'),
  JSON.stringify(sentLinks).slice(0, 120));
check('助手在线不误标本地兜底', res.ok && res.helperDown === false);
check('助手结果回填标签', res.scan?.listing?.[0]?.items?.[0]?.label === '第 101 集',
  JSON.stringify(res.scan?.listing?.[0]?.items?.[0]));

// ---------------------------------------------------------------- 3. id 交叉检查
function idsIn(file) {
  const html = fs.readFileSync(file, 'utf8');
  return new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
}
for (const [js, html] of [['popup.js', 'popup.html'], ['options.js', 'options.html']]) {
  const ids = idsIn(path.join(EXT, html));
  const src = fs.readFileSync(path.join(EXT, js), 'utf8');
  const used = new Set([...src.matchAll(/\$\('#([\w-]+)'\)/g)].map((m) => m[1]));
  const missing = [...used].filter((x) => !ids.has(x));
  check(`${js} 里引用的 id 都存在`, missing.length === 0, missing.join(','));
  const declared = [...src.matchAll(/getElementById\('([\w-]+)'\)/g)].map((m) => m[1]);
  const missing2 = declared.filter((x) => !ids.has(x));
  check(`${js} getElementById 都存在`, missing2.length === 0, missing2.join(','));
  const fieldIds = ['aria2Rpc', 'aria2Secret', 'aria2Conns', 'aria2Split', 'aria2MinSplit', 'aria2Dir',
    'helperUrl', 'outputDir', 'userAgent', 'minSizeKB', 'showSegments', 'autoClean'];
  if (js === 'options.js') {
    const miss3 = fieldIds.filter((x) => !ids.has(x));
    check('设置项字段齐全', miss3.length === 0, miss3.join(','));
  }
}

// CSS 里 [hidden] 必须压得住 display:flex，否则空状态会盖在列表上
const css = fs.readFileSync(path.join(EXT, 'popup.css'), 'utf8');
check('popup.css 有空状态 [hidden] 规则', css.includes('.empty[hidden]'));
check('popup.css 有 pane [hidden] 规则', css.includes('.pane[hidden]'));
check('popup.css 有 toast [hidden] 规则', css.includes('.toast[hidden]'));

// ---------------------------------------------------------------- 结果
console.log(results.join('\n'));
console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
