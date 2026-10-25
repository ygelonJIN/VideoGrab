#!/usr/bin/env node
/**
 * 弹窗渲染测试：jsdom 载入 popup.html，把 common.js + popup.js 拼成一段脚本跑，
 * 假 chrome API 喂数据，检查列表、点开的预览、任务面板。
 * 用法：node tools/popup-test.mjs （需要 jsdom：/tmp/vgdom 里 npm i jsdom）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire('/tmp/vgdom/');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'extension');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const log = [];
const check = (name, cond, detail = '') => {
  if (cond) { pass++; log.push('✅ ' + name); }
  else { fail++; log.push('❌ ' + name + (detail ? '  — ' + detail : '')); }
};

const common = fs.readFileSync(path.join(EXT, 'common.js'), 'utf8').replace(/^export /gm, '');
const popup = fs.readFileSync(path.join(EXT, 'popup.js'), 'utf8')
  .replace(/^import\s*\{[\s\S]*?\}\s*from\s*'\.\/common\.js';/m, '');
const bundle = `${common}\n${popup}`;

const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA==';

const ITEMS = [
  {
    url: 'https://cdn.com/v/movie.mp4?sig=1', kind: 'MP4', name: 'movie.mp4',
    size: 1395864371, ranges: true, status: 200, hits: 1, ts: Date.now(),
    headers: { referer: 'https://site.com/watch', ua: 'UA', cookie: 'sid=1' }
  },
  {
    url: 'https://cdn.com/v/index.m3u8?t=2', kind: 'HLS', name: 'index.m3u8',
    size: 812, ranges: true, status: 200, hits: 1, ts: Date.now(),
    headers: { referer: 'https://site.com/watch', ua: 'UA' }
  }
];

const clipboard = [];
const sent = [];
let helperOnline = true;

function makeChrome() {
  return {
    runtime: {
      id: 'test-ext',
      sendMessage: async (msg) => {
        sent.push(msg.type);
        switch (msg.type) {
          case 'media:list': return { ok: true, items: ITEMS, segCount: 3 };
          case 'diag': return { ok: true, aria2: true, helper: helperOnline };
          case 'probe': return {
            ok: true, media: {
              duration: 7261, width: 1920, height: 1080, bitrate: 4000000,
              videoCodec: 'h264', audioCodec: 'aac', thumbnail: JPEG, thumbAt: 10
            }
          };
          case 'hls:parse': return {
            ok: true, result: { type: 'media', segments: 128, duration: 7261, encrypted: true, keyUri: 'https://cdn/key', live: false }
          };
          case 'hls:ffmpeg': return { ok: true, command: 'ffmpeg -i x -c copy y.mp4' };
          case 'dl:txt': return { ok: true, text: 'https://cdn/v/movie.mp4\n  header=Referer: x\n' };
          case 'dl:aria2': return { ok: true, gids: [{ gid: 'g1', url: msg.items[0].url, name: 'movie.mp4', kind: 'MP4' }], errors: [] };
          case 'dl:browser': return { ok: true };
          case 'helper:submit': return helperOnline ? { ok: true } : { ok: false, error: '助手没在运行（127.0.0.1:8765 连不上）' };
          case 'aria2:status': return {
            ok: true, dead: [], list: [
              { gid: 'g1', name: 'movie.mp4', kind: 'MP4', status: 'active', totalLength: 1000, completedLength: 512, downloadSpeed: 2048, connections: 8, errorMessage: '' },
              { gid: 'g2', name: 'old.mp4', kind: 'MP4', status: 'complete', totalLength: 200, completedLength: 200, downloadSpeed: 0, connections: 0, errorMessage: '' }
            ]
          };
          case 'helper:jobs': return {
            ok: true, data: { jobs: [{ id: 'h1', type: 'hls', name: 'stream.mp4', status: 'running', progress: 33, speed: 1024 }] }
          };
          case 'cfg:get': return { ok: true, settings: {} };
          default: return { ok: true };
        }
      },
      openOptionsPage: () => {},
      onMessage: { addListener: () => {} }
    },
    storage: {
      local: {
        get: async (k) => (k === 'jobs' ? { jobs: [{ gid: 'g1', name: 'movie.mp4', kind: 'MP4', ts: 1 }] } : {}),
        set: async () => {}
      }
    },
    tabs: { query: async () => [{ id: 7, url: 'https://site.com/watch' }] },
    downloads: { download: async () => 1 }
  };
}

const html = fs.readFileSync(path.join(EXT, 'popup.html'), 'utf8');
const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://site.com/watch' });
const { window } = dom;
const { document } = window;

window.chrome = makeChrome();
document.execCommand = () => {          // 模拟 execCommand 复制
  const ta = document.querySelector('textarea');
  if (ta) clipboard.push(ta.value);
  return true;
};
Object.defineProperty(window.navigator, 'clipboard', {
  value: { writeText: async (t) => { clipboard.push(t); } },
  configurable: true
});
window.eval(bundle);
await sleep(150);

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

// 1. 列表
const rows = $$('li.row');
check('列表渲染 2 行', rows.length === 2, String(rows.length));
check('计数徽章 = 2', $('#cnt').textContent === '2', $('#cnt').textContent);
check('体积格式化', rows[0].querySelector('.meta').textContent.includes('1.3 GB'));
check('分片折叠提示', $('#hint').textContent.includes('3 个分片'));

// 2. 纯文字按钮：不能有图标符号
const btnTexts = $$('button').map((b) => b.textContent.trim()).filter(Boolean);
const bad = btnTexts.filter((t) => /[^\u4e00-\u9fa5A-Za-z0-9 .+\-]/.test(t));
check('按钮全是文字（无图标）', bad.length === 0, bad.join(' / '));
check('没有残留 img 图标', $$('header img').length === 0);

// 3. 点行 → 预览
click(rows[0].querySelector('.main'));
await sleep(150);
const detail = $('li.detail');
check('点名称展开详情', detail !== null);
check('详情里不再有缩略图', detail?.querySelector('img') === null);
check('详情有文件大小', detail?.textContent.includes('1.3 GB'));
check('详情显示时长', detail?.textContent.includes('2:01:01'), detail?.textContent.slice(0, 80));
check('详情显示分辨率', detail?.textContent.includes('1920×1080'));
check('详情显示编码', detail?.textContent.includes('h264 / aac'));
check('MP4 详情有 aria2', detail?.textContent.includes('aria2 下载'));
check('MP4 详情没有 ffmpeg', !detail?.textContent.includes('ffmpeg'));

// 4. 详情里复制链接
click(detail.querySelector('[data-act="copy"]'));
await sleep(60);
check('详情里复制链接', clipboard.some((c) => c.includes('movie.mp4')));

// 5. 收起
click($$('li.row')[0].querySelector('.main'));
await sleep(60);
check('再点一次收起', $('li.detail') === null);

// 6. HLS 行：详情有 ffmpeg 和分片信息
click($$('li.row')[1].querySelector('.main'));
await sleep(200);
const d2 = $('li.detail');
check('HLS 详情有 ffmpeg 命令', d2?.textContent.includes('复制 ffmpeg 命令'));
check('HLS 详情有分片数', d2?.textContent.includes('128 个分片'), d2?.textContent.slice(0, 120));
check('HLS 详情有加密标记', d2?.textContent.includes('AES 加密'));
check('HLS 行没有 aria2 按钮', !d2?.textContent.includes('aria2 下载'));

// 7. 全选 + 批量
$('#selAll').checked = true;
$('#selAll').dispatchEvent(new window.Event('change', { bubbles: true }));
await sleep(40);
check('全选提示', $('#selInfo').textContent.includes('已选 2'), $('#selInfo').textContent);
click($('#btnAria2'));
await sleep(150);
check('批量 aria2 发出请求', sent.includes('dl:aria2'));

// 8. 任务面板
click($('#tabJobs'));
await sleep(220);
const jobs = $$('#jobList .job');
check('任务面板 3 个', jobs.length === 3, String(jobs.length));
check('进度条宽度', jobs[0].querySelector('.bar > i')?.style.width === '51.2%');
check('任务按钮是文字', $$('#jobList button').every((b) => /^[\u4e00-\u9fa5]+$/.test(b.textContent.trim())), $$('#jobList button').map((b) => b.textContent).join('/'));

// 9. 筛选
click($('#tabSniff'));
await sleep(40);
$('#kind').value = 'stream';
$('#kind').dispatchEvent(new window.Event('change', { bubbles: true }));
await sleep(40);
check('只看流', $$('li.row').length === 1 && $$('li.row')[0].textContent.includes('HLS'));

// 11. 助手没开时的引导面板
check('引导面板默认隐藏', $('#sheet').hidden === true);
helperOnline = false;
$('#q').value = ''; $('#kind').value = '';
$('#kind').dispatchEvent(new window.Event('change', { bubbles: true }));
await sleep(40);
const hlsRow = $$('li.row').find((r) => r.textContent.includes('HLS'));
click(hlsRow.querySelector('[data-act="helper"]'));
await sleep(120);
check('点「交给助手」弹出引导', $('#sheet').hidden === false);
check('引导里有启动命令', $('#sheetCmd').textContent.includes('start.sh'));
check('引导里有终端提示', $('#sheet').textContent.includes('终端'));

click($('#sheetRecheck'));
await sleep(120);
check('重新检测：仍连不上', $('#sheetState').textContent.includes('还是连不上'), $('#sheetState').textContent);

helperOnline = true;
click($('#sheetRecheck'));
await sleep(120);
check('重新检测：连上了', $('#sheetState').textContent.includes('连上了'), $('#sheetState').textContent);

click($('#sheetClose'));
await sleep(40);
check('引导可关闭', $('#sheet').hidden === true);

console.log(log.join('\n'));
console.log(`\n通过 ${pass}，失败 ${fail}`);
dom.window.close();
process.exit(fail ? 1 : 0);
