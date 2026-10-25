#!/usr/bin/env node
/**
 * 弹窗渲染测试：用 jsdom 载入 popup.html，把 common.js + popup.js 合成一段脚本跑起来，
 * 用假 chrome API 喂数据，检查列表/解析/任务面板是否正常渲染。
 * 用法：node tools/popup-test.mjs   （需要 jsdom：在 /tmp/vgdom 里 npm i jsdom）
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

// ---------------------------------------------------------------- 合成脚本
const common = fs.readFileSync(path.join(EXT, 'common.js'), 'utf8').replace(/^export /gm, '');
const popup = fs.readFileSync(path.join(EXT, 'popup.js'), 'utf8')
  .replace(/^import\s*\{[\s\S]*?\}\s*from\s*'\.\/common\.js';/m, '');
const bundle = `${common}\n${popup}`;

// ---------------------------------------------------------------- 假数据
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

function makeChrome() {
  return {
    runtime: {
      id: 'test-ext',
      sendMessage: async (msg) => {
        sent.push(msg.type);
        switch (msg.type) {
          case 'media:list': return { ok: true, items: ITEMS, segCount: 3 };
          case 'diag': return { ok: true, aria2: true, helper: true, aria2Info: { version: '1.37' } };
          case 'hls:parse': return {
            ok: true, result: {
              type: 'media', segments: 42, duration: 7261, encrypted: true,
              keyUri: 'https://cdn.com/key/1', live: false
            }
          };
          case 'hls:ffmpeg': return { ok: true, command: 'ffmpeg -i x -c copy y.mp4' };
          case 'dl:txt': return { ok: true, text: 'https://cdn.com/v/movie.mp4\n  header=Referer: x\n' };
          case 'dl:aria2': return { ok: true, gids: [{ gid: 'g1', url: msg.items[0].url, name: 'movie.mp4', kind: 'MP4' }], errors: [] };
          case 'dl:browser': return { ok: true };
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

// ---------------------------------------------------------------- 跑起来
const html = fs.readFileSync(path.join(EXT, 'popup.html'), 'utf8');
const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://site.com/watch' });
const { window } = dom;
const { document } = window;

window.chrome = makeChrome();
document.execCommand = () => true;
Object.defineProperty(window.navigator, 'clipboard', {
  value: { writeText: async (t) => { clipboard.push(t); } },
  configurable: true
});
window.eval(bundle);
await sleep(120);

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

// 1. 列表渲染
const rows = $$('li.row');
check('列表渲染 2 行', rows.length === 2, String(rows.length));
check('计数徽章 = 2', $('#cnt').textContent === '2', $('#cnt').textContent);
check('MP4 类型徽章', rows[0].querySelector('.badge').textContent === 'MP4', rows[0].querySelector('.badge')?.textContent);
check('体积格式化', rows[0].querySelector('.meta').textContent.includes('1.3 GB'), rows[0].querySelector('.meta').textContent);
check('分片折叠提示', $('#hint').textContent.includes('3 个分片'), $('#hint').textContent);
check('空状态隐藏', $('#empty').hidden === true);

// 2. HLS 行有「解析」按钮，MP4 行是 ⚡
check('HLS 行有解析', rows[1].querySelector('[data-act="parse"]') !== null);
check('MP4 行有 aria2', rows[0].querySelector('[data-act="aria2"]') !== null);

// 3. 点解析 → 展开面板
rows[1].querySelector('[data-act="parse"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await sleep(120);
const detail = $('li.detail');
check('解析面板出现', detail !== null);
check('解析显示分片数', detail?.textContent.includes('42 个分片'), detail?.textContent?.slice(0, 80));
check('解析显示时长', detail?.textContent.includes('2:01:01'), detail?.textContent?.slice(0, 120));
check('解析显示加密', detail?.textContent.includes('AES 加密'));
check('面板里有 ffmpeg 按钮', detail?.querySelector('[data-act="ffmpeg"]') !== null);

// 4. 点面板里的「复制 ffmpeg 命令」
detail.querySelector('[data-act="ffmpeg"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await sleep(120);
check('复制 ffmpeg 命令', clipboard.some((c) => c.includes('ffmpeg')), JSON.stringify(clipboard));

// 5. 点复制链接（列表已重渲染，重新取节点）
$$('li.row')[0].querySelector('[data-act="copy"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await sleep(60);
check('复制链接', clipboard.some((c) => c.includes('movie.mp4')));

// 6. 全选 + 批量
$('#selAll').checked = true;
$('#selAll').dispatchEvent(new window.Event('change', { bubbles: true }));
await sleep(30);
check('全选后提示', $('#selInfo').textContent.includes('已选 2'), $('#selInfo').textContent);

$('#btnAria2').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await sleep(150);
check('批量 aria2 发出请求', sent.includes('dl:aria2'));

// 7. 任务面板
$('#tabJobs').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await sleep(200);
const jobs = $$('#jobList .job');
check('任务面板 3 个任务', jobs.length === 3, String(jobs.length));
check('aria2 进度条', jobs[0].querySelector('.bar > i')?.style.width === '51.2%', jobs[0].querySelector('.bar > i')?.style.width);
check('任务里有 ffmpeg 助手任务', $('#jobList').textContent.includes('ffmpeg 合并'));

// 8. 任务面板隐藏底部工具条
check('任务面板隐藏底栏', $('#bar').style.display === 'none', $('#bar').style.display);

// 9. 搜索过滤
$('#tabSniff').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await sleep(30);
$('#q').value = 'm3u8';
$('#q').dispatchEvent(new window.Event('input', { bubbles: true }));
await sleep(30);
check('搜索过滤剩 1 行', $$('li.row').length === 1, String($$('li.row').length));
$('#q').value = '';
$('#q').dispatchEvent(new window.Event('input', { bubbles: true }));

// 10. 类型筛选
await sleep(30);
$('#kind').value = 'stream';
$('#kind').dispatchEvent(new window.Event('change', { bubbles: true }));
await sleep(30);
check('筛选只看流', $$('li.row').length === 1 && $$('li.row')[0].textContent.includes('HLS'));

console.log(log.join('\n'));
console.log(`\n通过 ${pass}，失败 ${fail}`);
dom.window.close();
process.exit(fail ? 1 : 0);
