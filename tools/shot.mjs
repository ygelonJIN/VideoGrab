#!/usr/bin/env node
/**
 * UI 截图：把 popup.html + popup.css + popup.js 拼成静态页，喂假数据渲染出各面板状态，
 * 再交给 Chrome 无头截图。改完全局样式先跑这个看效果，不用手动开扩展。
 * 用法：node tools/shot.mjs [输出目录]   （默认 screenshots/）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'extension');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'screenshots'));
const TMP = '/tmp/vgshots';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

fs.mkdirSync(TMP, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

const common = fs.readFileSync(path.join(EXT, 'common.js'), 'utf8').replace(/^export /gm, '');
const popup = fs.readFileSync(path.join(EXT, 'popup.js'), 'utf8')
  .replace(/^import\s*\{[\s\S]*?\}\s*from\s*'\.\/common\.js';/m, '');
const css = fs.readFileSync(path.join(EXT, 'popup.css'), 'utf8');
const html = fs.readFileSync(path.join(EXT, 'popup.html'), 'utf8')
  .replace('<link rel="stylesheet" href="popup.css">', () => `<style>${css}</style>`)
  .replace('<script type="module" src="popup.js"></script>', '');

// 假 chrome API + 假数据：和 tools/popup-test.mjs 的场景保持一致
const fake = `
window.__flags = { helperOnline: true };
const ITEMS = [
  { url: 'https://cdn.com/v/movie.mp4?sig=1', kind: 'MP4', name: 'movie.mp4', size: 1395864371, ranges: true, status: 200, hits: 1, ts: Date.now(), headers: { referer: 'https://site.com/watch', ua: 'UA', cookie: 'sid=1' } },
  { url: 'https://cdn.com/v/index.m3u8?t=2', kind: 'HLS', name: 'index.m3u8', size: 812, ranges: true, status: 200, hits: 1, ts: Date.now(), headers: { referer: 'https://site.com/watch', ua: 'UA' } }
];
window.chrome = {
  runtime: {
    id: 'shot',
    sendMessage: async (msg) => {
      const on = window.__flags.helperOnline;
      switch (msg.type) {
        case 'media:list': return { ok: true, items: ITEMS, segCount: 3 };
        case 'diag': return { ok: true, aria2: true, helper: on };
        case 'probe': return { ok: true, media: { duration: 7261, width: 1920, height: 1080, videoCodec: 'h264', audioCodec: 'aac', size: 1395864371 } };
        case 'hls:parse': return { ok: true, result: { type: 'media', segments: 128, duration: 7261, encrypted: true, live: false } };
        case 'helper:jobs': return { ok: true, data: { queued: 1, jobs: [
          { id: 'h1', type: 'hls', name: '第01集.m3u8', status: 'running', progress: 62, speed: 2411724 },
          { id: 'h2', type: 'mp4', name: '第02集.mp4', status: 'queued', progress: 0 }
        ] } };
        case 'aria2:status': return { ok: true, dead: [], list: [
          { gid: 'g1', name: 'movie.mp4', kind: 'MP4', status: 'active', totalLength: 1395864371, completedLength: 714032168, downloadSpeed: 8945664, connections: 16, errorMessage: '', files: [{ path: '/Users/x/Downloads/VideoGrab/movie.mp4' }] },
          { gid: 'g2', name: 'old.mp4', kind: 'MP4', status: 'complete', totalLength: 734003200, completedLength: 734003200, downloadSpeed: 0, connections: 0, errorMessage: '', exists: true, files: [{ path: '/Users/x/Downloads/VideoGrab/old.mp4' }] },
          { gid: 'g3', name: 'gone.mp4', kind: 'MP4', status: 'complete', totalLength: 300, completedLength: 300, downloadSpeed: 0, connections: 0, errorMessage: '', exists: false, files: [{ path: '/Users/x/Downloads/VideoGrab/gone.mp4' }] }
        ] };
        case 'helper:submit': return on ? { ok: true } : { ok: false, error: '助手没在运行（127.0.0.1:8765 连不上）' };
        case 'file:scan': return { ok: true, total: 3, fragmented: 1, items: [
          { path: '/Users/x/Downloads/合集.mp4', size: 4415522090, kind: 'fragmented', fragmented: true },
          { path: '/Users/x/Downloads/第01集.mp4', size: 734003200, kind: 'normal', fragmented: false },
          { path: '/Users/x/Downloads/老片子.mp4', size: 1395864371, kind: 'moov-tail', fragmented: false }
        ] };
        case 'file:repairs': return { ok: true, items: [] };
        case 'batch:history': return { ok: true, history: {} };
        case 'batch:scan': return { ok: true, helperDown: !on, scan: { source: on ? 'dom' : 'local', listing: [{ template: 'site.com/watch/:id', count: 3, items: [
          { url: 'https://site.com/watch/101', label: '第 01 集' },
          { url: 'https://site.com/watch/102', label: '第 02 集' },
          { url: 'https://site.com/watch/103', label: '第 03 集' }
        ] }] } };
        case 'batch:resolve': {
          if (window.__flags.resolveDelay) {
            await new Promise((r) => setTimeout(r, window.__flags.resolveDelay));
          }
          return on ? { ok: true, items: (msg.urls || []).map((u, i) => (
            i === 0 ? { url: u, ok: true, title: '第 01 集', media: { url: 'https://cdn/v/a.mp4', kind: 'MP4', size: 1610612736 } }
              : i === 1 ? { url: u, ok: false, unavailable: true, reason: '播放器里没有媒体配置' }
                : { url: u, ok: false, gone: true, reason: 'HTTP 404' }
          )) } : { ok: false, error: '助手没在运行（127.0.0.1:8765 连不上）' };
        }
        default: return { ok: true };
      }
    },
    openOptionsPage: () => {}
  },
  storage: {
    local: { get: async () => ({ jobs: [{ gid: 'g1', name: 'movie.mp4', kind: 'MP4', ts: 1 }] }), set: async () => {} },
    // 预置 320 MB：任务面板截图里要能看到「现在换 IP 代价还小」那条提示
    session: {
      get: async (k) => {
        const keys = Array.isArray(k) ? k : [k];
        const out = {};
        for (const key of keys) {
          if (key === 'ipMeter') out.ipMeter = { bytes: 320 * 1024 * 1024, at: Date.now() };
          if (key === 'ipHintState') out.ipHintState = {};
        }
        return out;
      },
      set: async () => {}
    }
  },
  tabs: {
    query: async () => [{ id: 7, url: 'https://site.com/watch' }],
    get: async (id) => ({ id, url: 'https://site.com/list' })
  },
  downloads: { download: async () => 1 }
};
window.confirm = () => true;
`;

const STATES = [
  { name: 'list', after: '' },
  {
    name: 'detail',
    after: `setTimeout(() => { document.querySelector('li.row .main').click(); }, 300);`
  },
  {
    name: 'jobs',
    after: `setTimeout(() => { document.querySelector('#tabJobs').click(); }, 300);`
  },
  {
    name: 'batch',
    after: `setTimeout(() => { document.querySelector('#tabBatch').click(); document.querySelector('#btnScan').click(); }, 300);`
  },
  {
    // 解析卡在第一批上，900 ms 时点「停止解析」：拍下来就是「已停止」的样子
    name: 'batch-stopped',
    after: `window.__flags.resolveDelay = 4000;
            setTimeout(() => { document.querySelector('#tabBatch').click(); document.querySelector('#btnScan').click(); }, 300);
            setTimeout(() => { document.querySelector('#btnResolve').click(); }, 900);`
  },
  {
    name: 'batch-offline',
    after: `window.__flags.helperOnline = false;
            setTimeout(() => { document.querySelector('#tabBatch').click(); document.querySelector('#btnScan').click(); }, 300);`
  },
  {
    name: 'helper-sheet',
    after: `setTimeout(() => {
      window.__flags.helperOnline = false;
      const row = [...document.querySelectorAll('li.row')].find((r) => r.textContent.includes('HLS'));
      row.querySelector('[data-act="helper"]').click();
    }, 300);`
  },
  {
    // 「修复」页：进页不自动扫，点「扫描下载目录」才列出来，分片的那条才有修复按钮
    name: 'repair',
    after: `setTimeout(() => {
      document.querySelector('#tabRepair').click();
      document.querySelector('#btnRepairScan').click();
    }, 300);`
  }
];

for (const st of STATES) {
  // 用函数式替换：脚本里有 $&、$` 之类，当替换串会被 String.replace 展开啃坏
  const page = html.replace('</body>', () =>
    `<script>\n${fake}\n${common}\n${popup}\n${st.after}</script></body>`);
  const file = path.join(TMP, st.name + '.html');
  fs.writeFileSync(file, page);
  const out = path.join(OUT, st.name + '.png');
  try {
    execFileSync(CHROME, [
      '--headless=new', '--disable-gpu', '--hide-scrollbars',
      '--no-sandbox', '--disable-crash-reporter', '--disable-breakpad',
      // 截图固定浅色：README 里的图要一致，不能跟着生成时系统的深浅色变
      '--blink-settings=preferredColorScheme=1',
      `--user-data-dir=${path.join(TMP, 'profile-' + st.name)}`,
      '--window-size=560,600', '--virtual-time-budget=6000',
      `--screenshot=${out}`, `file://${file}`
    ], { stdio: 'pipe' });
    console.log('已生成 ' + path.relative(ROOT, out));
  } catch (e) {
    console.log('截图失败 ' + st.name + ': ' + (e?.message || e));
  }
}
