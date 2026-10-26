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
const downloads = [];
let helperOnline = true;
let scanExtra = false;   // 扫出 4 条（多一条 /4），用来测全选/半选和重试
let resolve4Ok = false;  // /4 第一次解析失败，重试才成功

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
              { gid: 'g1', name: 'movie.mp4', kind: 'MP4', status: 'active', totalLength: 1000, completedLength: 512, downloadSpeed: 2048, connections: 8, errorMessage: '', files: [{ path: '/Users/x/Downloads/VideoGrab/movie.mp4' }] },
              { gid: 'g2', name: 'old.mp4', kind: 'MP4', status: 'complete', totalLength: 200, completedLength: 200, downloadSpeed: 0, connections: 0, errorMessage: '', exists: true, files: [{ path: '/Users/x/Downloads/VideoGrab/old.mp4' }] },
              { gid: 'g3', name: 'gone.mp4', kind: 'MP4', status: 'complete', totalLength: 300, completedLength: 300, downloadSpeed: 0, connections: 0, errorMessage: '', exists: false, files: [{ path: '/Users/x/Downloads/VideoGrab/gone.mp4' }] }
            ]
          };
          case 'helper:jobs': return {
            ok: true, data: {
              queued: 1,
              jobs: [
                { id: 'h1', type: 'hls', name: 'stream.mp4', status: 'running', progress: 33, speed: 1024 },
                { id: 'h2', type: 'mp4', name: 'wait.mp4', status: 'queued', progress: 0 }
              ]
            }
          };
          case 'cfg:get': return { ok: true, settings: {} };
          case 'batch:scan': return {
            ok: true,
            helperDown: !helperOnline,
            scan: {
              source: helperOnline ? 'dom' : 'local', title: '列表',
              listing: [{
                template: 'site.com/watch/:id',
                count: scanExtra ? 4 : 3,
                items: (scanExtra ? [1, 2, 3, 4] : [1, 2, 3]).map((n) => (
                  { url: `https://site.com/watch/${n}`, label: '' }
                ))
              }],
              total: scanExtra ? 4 : 3
            }
          };
          case 'batch:resolve': {
            if (!helperOnline) return { ok: false, error: '助手没在运行（127.0.0.1:8765 连不上）' };
            return {
              ok: true,
              items: (msg.urls || []).map((u) => (
                u.endsWith('/1')
                  ? {
                      url: u, ok: true, gone: false, title: 'A',
                      media: { url: 'https://cdn/v/a.mp4', kind: 'MP4', size: 10485760, headers: { ua: 'UA' }, headerMode: 'no-referer' }
                    }
                  : u.endsWith('/2')
                    ? { url: u, ok: false, gone: false, unavailable: true, reason: '播放器里没有媒体配置' }
                    : u.endsWith('/3')
                      ? { url: u, ok: false, gone: true, reason: 'HTTP 404' }
                      : u.endsWith('/4') && !resolve4Ok
                        ? { url: u, ok: false, gone: false, reason: '解析超时' }
                        : {
                            url: u, ok: true, gone: false, title: 'D',
                            media: { url: 'https://cdn/v/d.mp4', kind: 'MP4', size: 20971520, headers: { ua: 'UA' }, headerMode: 'no-referer' }
                          }
              ))
            };
          }
          case 'batch:history': return { ok: true, history: {} };
          case 'batch:submit': return { ok: true, jobs: [{ id: 'j1', name: 'A' }], errors: [], history: {} };
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
      },
      session: {
        get: async () => ({}),
        set: async () => {}
      }
    },
    tabs: {
      query: async () => [{ id: 7, url: 'https://site.com/watch' }],
      get: async (id) => ({ id, url: 'https://site.com/list' })
    },
    scripting: { executeScript: async () => [{ result: ['https://site.com/watch/1'] }] },
    downloads: { download: async (opts) => { downloads.push(opts); return 1; } }
  };
}

const html = fs.readFileSync(path.join(EXT, 'popup.html'), 'utf8');
const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://site.com/watch' });
const { window } = dom;
const { document } = window;

window.chrome = makeChrome();
window.confirm = () => true;
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
check('任务面板 5 个', jobs.length === 5, String(jobs.length));
check('进度条宽度', jobs[0].querySelector('.bar > i')?.style.width === '51.2%');
const jobBtns = $$('#jobList button').map((b) => b.textContent.trim());
check('任务按钮都是文字', jobBtns.every((t) => /^[\u4e00-\u9fa5]+$/.test(t)), jobBtns.join('/'));
const activeJob = $$('#jobList .job').find((el) => el.textContent.includes('movie.mp4'));
const doneJob = $$('#jobList .job').find((el) => el.textContent.includes('old.mp4'));
check('进行中：有暂停和取消', activeJob.textContent.includes('暂停') && activeJob.textContent.includes('取消'));
check('已完成：不显示暂停', !doneJob.textContent.includes('暂停') && !doneJob.textContent.includes('取消'));
check('已完成：有删除文件', doneJob.textContent.includes('删除文件'));
check('已完成：有删除记录', doneJob.textContent.includes('删除记录'));
check('已完成：样式带 done', doneJob.classList.contains('done'));
check('已完成：显示落盘路径', doneJob.textContent.includes('~/Downloads/VideoGrab/old.mp4'), doneJob.textContent.slice(0,120));
check('已完成：有打开文件夹', doneJob.textContent.includes('打开文件夹'));
check('已完成：有复制路径', doneJob.textContent.includes('复制路径'));

// 本地文件被删了：不能再显示"已完成"
const goneJob = $$('#jobList .job').find((el) => el.textContent.includes('gone.mp4'));
check('文件已删：不显示已完成', goneJob && !goneJob.textContent.includes('已完成'));
check('文件已删：显示文件已删除', goneJob && goneJob.textContent.includes('文件已删除'));
check('文件已删：样式带 warn', goneJob && goneJob.classList.contains('warn'));
check('文件已删：不再挂绿条', goneJob && !goneJob.querySelector('.bar').classList.contains('done'));

// 排队中的任务：别说成 0%
const queuedJob = $$('#jobList .job').find((el) => el.textContent.includes('wait.mp4'));
check('排队中：标明排队中', queuedJob && queuedJob.textContent.includes('排队中'));
check('排队中：不显示 0%', queuedJob && !queuedJob.textContent.includes('0%'));
check('任务栏统计带排队数', $('#jobStat').textContent.includes('排队 1'), $('#jobStat').textContent);

// 删除文件：先确认，再发 file:delete
click([...doneJob.querySelectorAll('button')].find((b) => b.textContent.includes('删除文件')));
await sleep(150);
check('删除文件发出请求', sent.includes('file:delete'), sent.join(','));
check('删除后同步删记录', sent.includes('job:forget'));

// 删除记录（不删文件）
const before = sent.filter((x) => x === 'file:delete').length;
click([...doneJob.querySelectorAll('button')].find((b) => b.textContent.includes('删除记录')));
await sleep(150);
check('删除记录不发 file:delete', sent.filter((x) => x === 'file:delete').length === before);

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

// 12. 批量面板：扫描完自动解析，只有解析出地址的才能勾
click($('#tabBatch'));
await sleep(60);
check('批量面板可见', $('#paneBatch').hidden === false);
check('批量初始是空状态', $('#batchEmpty').hidden === false);
check('没扫之前全选禁用', $('#batchSelAll').disabled === true);

click($('#btnScan'));
await sleep(600);                       // 扫描 + 自动解析（假数据即时返回）

const brows = $$('#batchList li.row');
check('扫描出 3 条', brows.length === 3, String(brows.length));
check('扫描后自动解析，不停在待解析', !$$('#batchList .chip.b-pending').length,
  $$('#batchList .chip.b-pending').length + ' 条仍是待解析');
check('第 1 条可下', brows[0].textContent.includes('可下'));
check('第 2 条源已失效', brows[1].textContent.includes('源已失效'));
check('第 3 条已下架', brows[2].textContent.includes('已下架'));
check('可下的勾选框能点', brows[0].querySelector('.bsel').disabled === false);
check('失效的勾选框禁用', brows[1].querySelector('.bsel').disabled === true);
check('有可下项后全选可用', $('#batchSelAll').disabled === false);

$('#batchSelAll').checked = true;
$('#batchSelAll').dispatchEvent(new window.Event('change', { bubbles: true }));
await sleep(60);
check('全选只勾中可下的那条', $('#batchSelInfo').textContent.includes('已勾 1'), $('#batchSelInfo').textContent);

click($('#btnBatchDown'));
await sleep(120);
check('加入队列发出 batch:submit', sent.includes('batch:submit'));

// 13. 勾选体验：全选 / 半选 / 手动改过就不再自动勾回
scanExtra = true;                       // 扫出 4 条：/1 可下 /2 失效 /3 下架 /4 解析失败
resolve4Ok = false;
click($('#btnScan'));
await sleep(700);
let brows2 = $$('#batchList li.row');
check('重新扫描出 4 条', brows2.length === 4, String(brows2.length));
check('解析失败单独标出来', brows2[3].textContent.includes('解析失败'), brows2[3].textContent.slice(0, 60));
check('按钮文案跟着剩余走', $('#btnResolve').textContent.includes('重试失败'), $('#btnResolve').textContent);
check('可下自动勾上', brows2[0].querySelector('.bsel').checked === true);
check('全选跟着打勾', $('#batchSelAll').checked === true);
check('全选不是半选', $('#batchSelAll').indeterminate === false);

let boxN = (n) => $$('#batchList li.row')[n].querySelector('.bsel');
boxN(0).checked = false;
boxN(0).dispatchEvent(new window.Event('change', { bubbles: true }));
await sleep(40);
check('取消单条后计数更新', $('#batchSelInfo').textContent.includes('已勾 0'), $('#batchSelInfo').textContent);
check('取消单条后全选松开', $('#batchSelAll').checked === false);

resolve4Ok = true;                      // 重试后 /4 变可下
click($('#btnResolve'));
await sleep(600);
brows2 = $$('#batchList li.row');
check('重试后失败变可下', brows2[3].textContent.includes('可下'), brows2[3].textContent.slice(0, 60));
check('手动改过勾选不再自动勾回', boxN(3).checked === false);
check('计数没被带跑', $('#batchSelInfo').textContent.includes('已勾 0'), $('#batchSelInfo').textContent);

$('#batchSelAll').checked = true;
$('#batchSelAll').dispatchEvent(new window.Event('change', { bubbles: true }));
await sleep(40);
check('全选能重新勾全', $('#batchSelInfo').textContent.includes('已勾 2'), $('#batchSelInfo').textContent);
boxN(3).checked = false;
boxN(3).dispatchEvent(new window.Event('change', { bubbles: true }));
await sleep(40);
check('取消一条进半选', $('#batchSelAll').indeterminate === true && $('#batchSelAll').checked === false);

// 14. 助手没开：批量照样列得出条目，引导卡和弹层都在
helperOnline = false;
click($('#btnScan'));
await sleep(700);
check('没开助手也能扫出条目', $$('#batchList li.row').length === 4, String($$('#batchList li.row').length));
check('没解析的保持待解析', $$('#batchList .chip.b-pending').length === 4,
  $$('#batchList .chip.b-pending').length + ' 条待解析');
check('批量页引导卡出现', $('#batchGuide').hidden === false);
check('提示说清助手没开', $('#batchHint').textContent.includes('助手没开'), $('#batchHint').textContent);
check('解析按钮写明剩余', $('#btnResolve').textContent.includes('解析剩余'), $('#btnResolve').textContent);
check('没开助手勾选框仍禁用', $$('#batchList .bsel').every((b) => b.disabled === true));

click($('#btnResolve'));
await sleep(200);
check('没开助手点解析弹引导', $('#sheet').hidden === false);
click($('#sheetClose'));
await sleep(30);

click($('#batchGuideCopy'));
await sleep(60);
check('引导卡能复制启动命令', clipboard.some((c) => c.includes('start.sh')));

const dlBefore = downloads.length;
click($('#btnExport'));
await sleep(120);
check('没开助手也能导出链接', downloads.length === dlBefore + 1, String(downloads.length));
check('导出内容是链接清单', String(downloads.at(-1)?.url || '').includes(encodeURIComponent('site.com/watch')),
  String(downloads.at(-1)?.url || '').slice(0, 80));

console.log(log.join('\n'));
console.log(`\n通过 ${pass}，失败 ${fail}`);
dom.window.close();
process.exit(fail ? 1 : 0);
