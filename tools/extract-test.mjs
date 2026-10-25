#!/usr/bin/env node
/**
 * 助手侧纯函数的自测：通用发现器（合成 HTML）+ aria2 错误提取。不联网、不碰真实站点。
 * 用法：node tools/extract-test.mjs
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const E = await import(path.join(ROOT, 'helper', 'extract.mjs'));

let pass = 0;
const fails = [];
function check(name, cond, detail = '') {
  if (cond) pass++;
  else fails.push(`${name}${detail ? '  — ' + detail : ''}`);
}

// ---------------------------------------------------------------- 打包器
const B62 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
/** 按 packer 的规则把文本打包，用来反向验证 unpackAll */
function pack(text, base = 62) {
  const dict = [];
  const index = new Map();
  const enc = (n) => {
    let s = '';
    do { s = B62[n % base] + s; n = Math.floor(n / base); } while (n > 0);
    return s;
  };
  const payload = text.replace(/\b\w+\b/g, (w) => {
    if (!index.has(w)) { index.set(w, dict.length); dict.push(w); }
    return enc(index.get(w));
  });
  return (
    `eval(function(p,a,c,k,e,d){e=function(c){return c.toString(36)};` +
    `if(!''.replace(/^/,String)){while(c--){d[c.toString(a)]=k[c]||c.toString(a)}` +
    `k=[function(e){return d[e]}];e=function(){return'\\\\w+'};c=1};` +
    `while(c--){if(k[c]){p=p.replace(new RegExp('\\\\b'+e(c)+'\\\\b','g'),k[c])}}` +
    `return p}('${payload}',${base},${dict.length},'${dict.join('|')}'.split('|'),0,{}))`
  );
}

const cfg = 'MDCore.wurl="//cdn.example.test/v2/abc123def456.mp4?s=sig&e=123";';
const packed = pack(cfg);
const unpacked = E.unpackAll(packed);
check('能解出一段 packer', unpacked.length === 1, String(unpacked.length));
check('解出的文本含原字段', unpacked[0]?.includes('MDCore.wurl'), unpacked[0]?.slice(0, 60));
check('解出的直链完整', unpacked[0]?.includes('abc123def456.mp4?s=sig&e=123'), unpacked[0]?.slice(-80));

const packedHits = E.discoverPacked(`<script>${packed}</script>`, 'https://site.test/watch/1');
check('打包配置里能发现直链',
  packedHits.some((h) => h.url === 'https://cdn.example.test/v2/abc123def456.mp4?s=sig&e=123'),
  JSON.stringify(packedHits.map((h) => h.url)));
check('打包发现的类型是 MP4', packedHits.some((h) => h.kind === 'MP4'));

// ---------------------------------------------------------------- 直出媒体
const directHtml = `
<html><head>
<meta property="og:title" content="  一个   标题  ">
<meta property="og:video" content="//cdn.test/a.mp4">
<script type="application/ld+json">{"contentUrl":"https://cdn.test/b.mp4"}</script>
</head><body>
<video src="/v/c.mp4" poster="/p.jpg"></video>
<video preload="none"><source src="https://cdn.test/d.m3u8"></video>
<a href="/v/1">x</a>
</body></html>`;
const d = E.discover(directHtml, 'https://site.test/watch/1');
check('video src 能发现', d.media.some((m) => m.url === 'https://site.test/v/c.mp4'));
check('source src 能发现', d.media.some((m) => m.url === 'https://cdn.test/d.m3u8'));
check('og:video 能发现', d.media.some((m) => m.url === 'https://cdn.test/a.mp4'));
check('JSON-LD 能发现', d.media.some((m) => m.url === 'https://cdn.test/b.mp4'));
check('og:title 去空白', d.title === '一个 标题', JSON.stringify(d.title));
check('m3u8 判成 HLS', d.media.find((m) => m.url.endsWith('.m3u8'))?.kind === 'HLS');

// ---------------------------------------------------------------- 预览片 vs 正片
const splash = `<video preload="none" class="splash"><source src="https://thumb.cdn.test/t/u1.mp4"></video>`;
check('preload=none 的预览片也能被读到（只是不会自己发请求）',
  E.discover(splash, 'https://site.test/').media.some((m) => m.url.includes('thumb.cdn.test')));

// ---------------------------------------------------------------- iframe 嵌入
const embedHtml = `
<iframe src="https://player.test/e/abcdef"></iframe>
<iframe src="https://ads.test/x"></iframe>
<iframe id="x" src="https://site.test/embed/9"></iframe>`;
const em = E.discoverEmbeds(embedHtml, 'https://site.test/watch/1');
check('嵌入 iframe 收全', em.length === 3, String(em.length));
check('播放器形态被标 hint', em.find((x) => x.url.includes('player.test/e/'))?.hint === true);
check('普通 iframe 不误标', em.find((x) => x.url.includes('ads.test'))?.hint === false);

// ---------------------------------------------------------------- 列表模板分组
const listHtml = `
<nav><a href="/login">登录</a><a href="/terms">条款</a><a href="/dmca">DMCA</a></nav>
<div class="grid">
  <a href="/watch/16143196"><img src="a.jpg"></a><a href="/watch/16143196">视频 A</a>
  <a href="/watch/16143158">视频 B</a>
  <a href="/watch/16143128">视频 C</a>
  <a href="/watch/16126257">视频 D</a>
  <a href="https://other.test/watch/1">外站链接</a>
</div>`;
const li = E.discover(listHtml, 'https://site.test/profile/x?page=2');
check('列表模板被认出来', li.listing.length >= 1, JSON.stringify(li.listing.map((x) => x.template)));
check('同模板 4 条', li.listing[0]?.count === 4, String(li.listing[0]?.count));
check('站外链接被排除', !li.links.some((l) => l.url.includes('other.test')));
check('登录/条款不进条目', li.links.every((l) => !NAV_HINT_OK(l.url)));
check('同一 URL 去重取更长标签',
  li.links.filter((l) => l.url.endsWith('/watch/16143196')).length === 1);
check('模板把 id 抹成 :id', li.listing[0]?.template === 'site.test/watch/:id', li.listing[0]?.template);
function NAV_HINT_OK(u) { return /\/(login|terms|dmca)$/.test(new URL(u).pathname); }

// ---------------------------------------------------------------- JS 渲染的列表页（HTML 是空的）
const skeleton = `<div class="skeleton"></div><div class="skeleton"></div><nav><a href="/login">x</a></nav>`;
const sk = E.discover(skeleton, 'https://site.test/profile/x');
check('骨架屏页面发现不到条目', sk.listing.length === 0, JSON.stringify(sk.listing));
check('骨架屏页面也没有媒体', sk.media.length === 0, JSON.stringify(sk.media));

// ---------------------------------------------------------------- 各种边界
check('相对路径能解析', E.absUrl('/a/b.mp4', 'https://h.test/x/y') === 'https://h.test/a/b.mp4');
check('协议相对能解析', E.absUrl('//c.test/a.mp4', 'https://h.test/') === 'https://c.test/a.mp4');
check('\\/ 转义能解开', E.scanUrls('"https:\\/\\/c.test\\/a.mp4"')[0] === 'https://c.test/a.mp4');
check('&amp; 转义能解开', E.scanUrls('https://c.test/a.mp4?a=1&amp;b=2')[0] === 'https://c.test/a.mp4?a=1&b=2');
check('null 输入不炸', E.discover(null, 'https://h.test/').media.length === 0);
check('空字符串不炸', E.scanUrls('').length === 0);
check('不带扩展名的地址不硬猜', E.scanUrls('https://c.test/api/play?id=1').length === 0);

check('404 判下架', E.looksGone('', 404) === true);
check('410 判下架', E.looksGone('', 410) === true);
check('正文含 removed 判下架', E.looksGone('<p>This video was removed</p>', 200) === true);
check('正常页不判下架', E.looksGone('<p>播放中</p>', 200) === false);

// ---------------------------------------------------------------- aria2 错误提取
const ER = await import(path.join(ROOT, 'helper', 'errors.mjs'));

const aria2Fail = `
[#1 0B/0B(0%) CN:1 DL:0B]
10/25 23:00:01 [ERROR] CUID#7 - Download aborted. URI=https://cdn.test/v/a.mp4?s=SECRET
Exception: [AbstractCommand.cc:351] errorCode=22 URI=https://cdn.test/v/a.mp4?s=SECRET
  -> [HttpSkipResponseCommand.cc:240] errorCode=22 The response status is not successful. status=403
Download Results:
gid   |stat|avg speed  |path/URI
1      |ERR |       0B/s|/tmp/x.mp4
Status Legend:
(ERR):error occurred.
aria2 will resume download if the transfer is restarted.
If there are any errors, then see the log file. See '-l' option in help/man page for details.
`;
const e1 = ER.extractAria2Error(aria2Fail);
check('aria2 错误不再取页脚', !/see the log file/i.test(e1), e1);
check('aria2 错误带 HTTP 状态', e1.includes('403'), e1);
check('aria2 错误有中文提示', e1.includes('HTTP 状态不对'), e1);
check('aria2 错误把签名链接打码', !e1.includes('SECRET'), e1);
check('文件已存在能认出来',
  ER.extractAria2Error('Exception: [AbstractCommand.cc:351] errorCode=13 URI=x\n  -> errorCode=13 File already exists.').includes('文件已存在'));
check('只有页脚时返回空串',
  ER.extractAria2Error("If there are any errors, then see the log file. See '-l' option in help/man page for details.") === '');
check('非 aria2 的错误也能兜底（取最后一行）',
  ER.extractAria2Error('frame= 10 fps=0\nError while decoding stream #0:0').includes('Error while decoding'));
check('退出码描述带信号', ER.describeExit(1, 'SIGKILL').includes('SIGKILL'));

// ---------------------------------------------------------------- 文件名去重
const NM = await import(path.join(ROOT, 'helper', 'naming.mjs'));

const used = new Set(['片名.mp4', '片名 (1).mp4']);
const got = NM.uniqueName('片名', '.mp4', (n) => used.has(n));
check('重名自动加序号', got === '片名 (2).mp4', got);
check('本来不重名就原样', NM.uniqueName('别的', '.mp4', () => false) === '别的.mp4');
check('同名太多有兜底', NM.uniqueName('x', '.mp4', () => true).includes('('));

const [st, sx] = NM.splitExt('视频 1080p.mp4');
check('拆扩展名', st === '视频 1080p' && sx === '.mp4', st + '|' + sx);
const [st2, sx2] = NM.splitExt('没有扩展名');
check('没有扩展名时后缀为空', st2 === '没有扩展名' && sx2 === '', st2 + '|' + sx2);

// ---------------------------------------------------------------- 结果
if (fails.length) {
  console.log('失败项：');
  for (const f of fails) console.log('  ❌ ' + f);
}
console.log(`\n通用发现器：通过 ${pass}，失败 ${fails.length}`);
process.exit(fails.length ? 1 : 0);
