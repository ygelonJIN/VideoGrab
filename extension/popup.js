// 弹窗逻辑：列表渲染、单条/批量下载、HLS 解析、任务面板。
import {
  KIND_LABEL, humanBytes, humanDuration, hostOf, fileNameFromUrl
} from './common.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const state = {
  tabId: null,
  items: [],
  segCount: 0,
  selected: new Set(),
  filter: '',
  kind: '',
  detailUrl: null,
  pinned: new Map(),
  detailData: null,
  detailErr: '',
  pane: 'sniff',
  aria2Ok: null,
  helperOk: null,
  lastSig: '',
  jobTimer: null
};

function send(type, payload = {}) {
  return chrome.runtime.sendMessage({ type, ...payload });
}

// ------------------------------------------------------------------ 启动
async function init() {
  bindEvents();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  state.tabId = tab?.id ?? null;
  if (!state.tabId) {
    $('#empty').innerHTML = '<p>读不到当前标签页</p>';
    return;
  }
  await refreshList(true);
  probeBackends();
  setInterval(tick, 1000);
}

async function probeBackends() {
  const r = await send('diag');
  if (r?.ok) {
    state.aria2Ok = r.aria2;
    state.helperOk = r.helper;
  }
  updateFooter();
}

let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    if (state.pane === 'sniff') await refreshList(false);
    else await refreshJobs();
  } finally {
    ticking = false;
  }
}

// ------------------------------------------------------------------ 列表
async function refreshList(force) {
  const r = await send('media:list', { tabId: state.tabId });
  if (!r?.ok) return;
  const sig = r.items.map((i) => i.url + ':' + i.size + ':' + i.kind).join('|') + '#' + r.segCount;
  const changed = sig !== state.lastSig;
  state.lastSig = sig;
  state.items = r.items;
  state.segCount = r.segCount || 0;

  // 清掉已经不存在的选中项（含手动加进来的清晰度）
  const alive = new Set([...r.items.map((i) => i.url), ...state.pinned.keys()]);
  for (const u of [...state.selected]) if (!alive.has(u)) state.selected.delete(u);

  $('#cnt').textContent = allItems().length ? String(allItems().length) : '';
  if (changed || force) {
    if (state.detailUrl && !alive.has(state.detailUrl)) {
      state.detailUrl = null;
      state.detailData = null;
    }
    renderList();
  }
  updateFooter();
}

function allItems() {
  const seen = new Set();
  const out = [];
  for (const it of [...state.pinned.values(), ...state.items]) {
    if (seen.has(it.url)) continue;
    seen.add(it.url);
    out.push(it);
  }
  return out;
}

function filtered() {
  const q = state.filter.trim().toLowerCase();
  return allItems().filter((i) => {
    if (state.kind === 'stream' && !['HLS', 'DASH'].includes(i.kind)) return false;
    if (state.kind === 'file' && ['HLS', 'DASH', 'TS', 'AUDIO'].includes(i.kind)) return false;
    if (state.kind === 'audio' && i.kind !== 'AUDIO') return false;
    if (state.kind === 'seg' && i.kind !== 'TS') return false;
    if (!q) return true;
    return (i.name + ' ' + i.url + ' ' + i.kind).toLowerCase().includes(q);
  });
}

function metaBits(item) {
  const bits = [hostOf(item.url)];
  if (item.size) bits.push(humanBytes(item.size));
  if (item.kind === 'HLS' || item.kind === 'DASH') bits.push(item.ranges ? '支持分段' : '未声明分段');
  if (item.status >= 400) bits.push(`HTTP ${item.status}`);
  return bits.filter(Boolean);
}

function opsHtml(item) {
  const isStream = item.kind === 'HLS' || item.kind === 'DASH';
  if (isStream) {
    return `
      <button class="mini" data-act="parse">解析</button>
      <button class="mini" data-act="helper" title="交给本地助手用 ffmpeg 合并">助手</button>
      <button class="mini" data-act="copy" title="复制链接">⧉</button>`;
  }
  return `
    <button class="mini" data-act="aria2" title="交给 aria2 多线程">⚡</button>
    <button class="mini" data-act="browser" title="浏览器直接下载">⬇</button>
    <button class="mini" data-act="copy" title="复制链接">⧉</button>`;
}

function renderList() {
  const list = $('#list');
  const rows = filtered();
  list.innerHTML = '';
  $('#empty').hidden = rows.length > 0 || state.segCount > 0;
  $('#hint').textContent = state.segCount
    ? `另有 ${state.segCount} 个分片已折叠（设置里可显示）`
    : '';

  for (const item of rows) {
    const li = document.createElement('li');
    li.className = 'row';
    li.dataset.url = item.url;
    li.innerHTML = `
      <input type="checkbox" class="sel" ${state.selected.has(item.url) ? 'checked' : ''}>
      <div class="main">
        <div class="title">
          <span class="badge k-${esc(item.kind)}">${esc(KIND_LABEL[item.kind] || item.kind)}</span>
          <span class="name" title="${esc(item.name)}">${esc(item.name)}</span>
        </div>
        <div class="meta">${metaBits(item).map(esc).join('<i>·</i>')}</div>
      </div>
      <div class="ops">${opsHtml(item)}</div>`;
    list.appendChild(li);

    if (state.detailUrl === item.url) {
      list.appendChild(detailEl(item));
    }
  }
  syncSelAll();
  updateFooter();
}

// ------------------------------------------------------------------ HLS 解析面板
function detailEl(item) {
  const box = document.createElement('li');
  box.className = 'detail';

  if (state.detailErr) {
    box.innerHTML = `<div class="line" style="color:var(--red)">${esc(state.detailErr)}</div>
      <div class="acts"><button class="mini" data-act="copy">复制链接</button></div>`;
    return box;
  }
  if (!state.detailData) {
    box.innerHTML = '<div class="line">解析中…</div>';
    return box;
  }

  const d = state.detailData;
  if (d.type === 'master') {
    box.innerHTML = `
      <div class="line">主播放列表 · ${d.variants.length} 个清晰度</div>
      ${d.variants.map((v, idx) => `
        <div class="variant" data-idx="${idx}">
          <div class="v-main">
            <div class="v-name">${esc(v.resolution || '未知清晰度')}${v.frameRate ? ` · ${esc(v.frameRate)}fps` : ''}</div>
            <div class="v-sub">${v.bandwidth ? (v.bandwidth / 1e6).toFixed(2) + ' Mbps' : ''}${v.codecs ? ' · ' + esc(v.codecs.split(',')[0]) : ''}</div>
          </div>
          <button class="mini" data-act="variant">查看分片</button>
          <button class="mini" data-act="copy-variant">复制</button>
        </div>`).join('')}`;
    return box;
  }

  if (d.type === 'dash') {
    box.innerHTML = `
      <div class="line">DASH 清单，ffmpeg 能直接拉取合并</div>
      <div class="acts">
        <button class="mini" data-act="ffmpeg">复制 ffmpeg 命令</button>
        <button class="mini" data-act="helper">交给助手</button>
        <button class="mini" data-act="copy">复制链接</button>
      </div>`;
    return box;
  }

  if (d.type === 'media') {
    const bits = [
      `${d.segments} 个分片`,
      d.duration ? `时长 ${humanDuration(d.duration)}` : '时长未知',
      d.encrypted ? 'AES 加密' : '未加密',
      d.live ? '直播流' : '点播'
    ];
    box.innerHTML = `
      <div class="line">${bits.map(esc).join('<i>·</i>')}</div>
      <div class="acts">
        <button class="mini" data-act="ffmpeg">复制 ffmpeg 命令</button>
        <button class="mini" data-act="helper">交给助手</button>
        <button class="mini" data-act="copy">复制链接</button>
        <button class="mini" data-act="copy-key">复制 KEY 地址</button>
      </div>`;
    if (d.encrypted) {
      box.insertAdjacentHTML('beforeend',
        `<div class="line" style="margin-top:6px">加密流 ffmpeg 也能解，需要能访问 KEY：${esc(d.keyUri || '未知')}</div>`);
    }
    return box;
  }

  box.innerHTML = '<div class="line" style="color:var(--red)">不是有效的 m3u8 播放列表</div>';
  return box;
}

async function parseItem(item) {
  if (item.kind === 'DASH') {
    state.detailUrl = item.url;
    state.detailErr = '';
    state.detailData = { type: 'dash' };
    renderList();
    return;
  }
  if (state.detailUrl === item.url) {
    state.detailUrl = null;
    state.detailData = null;
    state.detailErr = '';
    renderList();
    return;
  }
  state.detailUrl = item.url;
  state.detailData = null;
  state.detailErr = '';
  renderList();
  const r = await send('hls:parse', { item });
  if (state.detailUrl !== item.url) return;
  if (!r?.ok) {
    state.detailErr = r?.error || '解析失败';
  } else {
    state.detailData = r.result;
  }
  renderList();
}

// ------------------------------------------------------------------ 下载动作
async function actAria2(items) {
  if (!items.length) return toast('先勾选要下载的条目');
  const streams = items.filter((i) => ['HLS', 'DASH'].includes(i.kind));
  const files = items.filter((i) => !['HLS', 'DASH'].includes(i.kind));
  if (streams.length && !files.length) {
    return toast('流不能直接给 aria2，点「解析」后用 ffmpeg', true);
  }
  const r = await send('dl:aria2', { items: files });
  if (!r?.ok) return toast(r?.error || 'aria2 调用失败', true);
  if (r.gids?.length) {
    toast(`已加入 aria2：${r.gids.length} 个任务`);
    state.aria2Ok = true;
    switchPane('jobs');
    setTimeout(refreshJobs, 300);
  }
  if (r.errors?.length) {
    toast(r.errors[0], true);
    state.aria2Ok = false;
  }
  if (streams.length) toast('流请用「解析 → 复制 ffmpeg 命令」或「交给助手」', true);
}

async function actBrowser(item) {
  const r = await send('dl:browser', { items: [{ url: item.url, name: item.name }] });
  if (!r?.ok) toast(r?.error || '下载失败', true);
  else toast('已交给浏览器下载（单连接，大文件慢）');
}

async function actCopy(text, label = '链接') {
  try {
    await navigator.clipboard.writeText(text);
    toast(`已复制${label}`);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    toast(`已复制${label}`);
  }
}

async function actHelper(item) {
  if (state.helperOk === false) {
    return toast('本地助手没启动：node helper/server.mjs', true);
  }
  const r = await send('helper:submit', {
    kind: item.kind, url: item.url, name: item.name, headers: item.headers
  });
  if (!r?.ok) {
    toast((r?.error || '助手调用失败') + '（先启动 node helper/server.mjs）', true);
    state.helperOk = false;
    return;
  }
  toast('已交给助手，去「任务」看进度');
  switchPane('jobs');
  setTimeout(refreshJobs, 300);
}

async function actFfmpeg(item) {
  const base = (item.name || 'video').replace(/\.[^.]+$/, '');
  const out = `${base}.mp4`;
  const r = await send('hls:ffmpeg', { item, outPath: out });
  if (!r?.ok) return toast(r?.error || '生成命令失败', true);
  await actCopy(r.command, ' ffmpeg 命令');
  toast('已复制，粘到终端跑；输出文件落在当前目录', false);
}

// ------------------------------------------------------------------ 任务面板
async function refreshJobs() {
  const got = await chrome.storage.local.get('jobs');
  const aria2Jobs = (got.jobs || []).filter((j) => j.gid);
  const parts = [];

  if (aria2Jobs.length) {
    const r = await send('aria2:status', { jobs: aria2Jobs });
    if (r?.ok) {
      if (r.dead?.length) {
        const keep = aria2Jobs.filter((j) => !r.dead.includes(j.gid));
        await chrome.storage.local.set({ jobs: keep });
      }
      for (const j of r.list) parts.push(aria2JobEl(j));
      if (r.list.length) state.aria2Ok = true;
    } else {
      state.aria2Ok = false;
    }
  }

  try {
    const h = await send('helper:jobs');
    if (h?.ok) {
      state.helperOk = true;
      for (const j of (h.data.jobs || [])) parts.push(helperJobEl(j));
    }
  } catch {
    state.helperOk = false;
  }

  const list = $('#jobList');
  list.innerHTML = '';
  for (const el of parts) list.appendChild(el);
  $('#jobEmpty').hidden = parts.length > 0;

  const running = [...list.querySelectorAll('.job.running')].length;
  $('#jobStat').textContent = parts.length ? `共 ${parts.length} 个，进行中 ${running}` : '';
}

function pct(job) {
  const total = Number(job.totalLength) || 0;
  const done = Number(job.completedLength) || 0;
  return total ? Math.min(100, (done / total) * 100) : 0;
}

function sortByStatus(jobs) { return jobs; }

function aria2JobEl(j) {
  const el = document.createElement('li');
  const status = j.status || 'unknown';
  const running = status === 'active' || status === 'waiting' || status === 'paused';
  el.className = `job ${running ? 'running' : ''} ${status === 'error' ? 'err' : ''}`;
  const done = status === 'complete';
  const p = done ? 100 : pct(j);
  const speed = Number(j.downloadSpeed) || 0;
  const conns = Number(j.connections) || 0;
  const meta = [];
  if (j.totalLength) meta.push(`${humanBytes(j.completedLength)} / ${humanBytes(j.totalLength)}`);
  if (speed > 0) meta.push(humanBytes(speed) + '/s');
  if (conns > 0) meta.push(`${conns} 线程`);
  meta.push(statusText(status));

  el.innerHTML = `
    <div class="j-top">
      <span class="badge k-${esc(j.kind || 'MP4')}">aria2</span>
      <span class="j-name" title="${esc(j.name || '')}">${esc(j.name || j.url)}</span>
      <button class="mini" data-job="${esc(j.gid)}" data-op="${status === 'paused' ? 'unpause' : 'pause'}">${status === 'paused' ? '▶' : '⏸'}</button>
      <button class="mini" data-job="${esc(j.gid)}" data-op="remove">✕</button>
    </div>
    <div class="bar ${done ? 'done' : ''}"><i style="width:${p.toFixed(1)}%"></i></div>
    <div class="j-meta">${meta.map(esc).join('<i>·</i>')}</div>
    ${j.errorMessage ? `<div class="j-err">${esc(j.errorMessage)}</div>` : ''}`;
  return el;
}

function helperJobEl(j) {
  const el = document.createElement('li');
  const running = j.status === 'running' || j.status === 'queued';
  el.className = `job ${running ? 'running' : ''} ${j.status === 'error' ? 'err' : ''}`;
  const p = j.status === 'done' ? 100 : Math.max(0, Math.min(100, Number(j.progress) || 0));
  const meta = [];
  if (j.status === 'done') meta.push('已完成');
  if (j.speed) meta.push(humanBytes(j.speed) + '/s');
  if (j.status === 'running') meta.push(`${p.toFixed(0)}%`);
  meta.push(esc(j.type === 'hls' ? 'ffmpeg 合并' : 'aria2/curl'));

  el.innerHTML = `
    <div class="j-top">
      <span class="badge k-HLS">助手</span>
      <span class="j-name" title="${esc(j.name || '')}">${esc(j.name || j.url)}</span>
      ${running ? `<button class="mini" data-hjob="${esc(j.id)}" data-op="cancel">✕</button>` : ''}
    </div>
    <div class="bar ${j.status === 'done' ? 'done' : ''}"><i style="width:${p.toFixed(1)}%"></i></div>
    <div class="j-meta">${meta.join('<i>·</i>')}</div>
    ${j.error ? `<div class="j-err">${esc(j.error)}</div>` : ''}`;
  return el;
}

function statusText(s) {
  return ({
    active: '下载中', waiting: '排队', paused: '已暂停',
    complete: '已完成', error: '出错', removed: '已移除', unknown: '未知'
  })[s] || s;
}

// ------------------------------------------------------------------ 事件
function bindEvents() {
  $('#tabSniff').addEventListener('click', () => switchPane('sniff'));
  $('#tabJobs').addEventListener('click', () => switchPane('jobs'));
  $('#btnOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('#btnRefresh').addEventListener('click', () => refreshList(true));
  $('#btnJobRefresh').addEventListener('click', () => refreshJobs());
  $('#btnClear').addEventListener('click', async () => {
    await send('media:clear', { tabId: state.tabId });
    state.selected.clear();
    state.detailUrl = null;
    state.lastSig = '';
    await refreshList(true);
  });

  $('#q').addEventListener('input', (e) => { state.filter = e.target.value; renderList(); });
  $('#kind').addEventListener('change', (e) => { state.kind = e.target.value; renderList(); });

  $('#selAll').addEventListener('change', (e) => {
    const rows = filtered();
    if (e.target.checked) rows.forEach((i) => state.selected.add(i.url));
    else state.selected.clear();
    renderList();
  });

  $('#btnAria2').addEventListener('click', () => {
    const items = state.selected.size
      ? allItems().filter((i) => state.selected.has(i.url))
      : filtered();
    actAria2(items);
  });

  $('#btnTxt').addEventListener('click', async () => {
    const items = state.selected.size
      ? allItems().filter((i) => state.selected.has(i.url))
      : filtered();
    if (!items.length) return toast('没有可导出的条目');
    const r = await send('dl:txt', { items });
    if (!r?.ok) return toast(r?.error || '生成失败', true);
    const url = 'data:text/plain;charset=utf-8,' + encodeURIComponent(r.text);
    await chrome.downloads.download({ url, filename: 'aria2-任务.txt', saveAs: true });
    toast('已导出，终端跑：aria2c -i 文件.txt');
  });

  $('#list').addEventListener('click', onListClick);
  $('#jobList').addEventListener('click', onJobClick);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.close(); });
}

function itemByUrl(url) { return allItems().find((i) => i.url === url); }

async function onListClick(e) {
  const btn = e.target.closest('button[data-act]');
  const row = e.target.closest('li.row');
  if (e.target.classList.contains('sel') && row) {
    if (e.target.checked) state.selected.add(row.dataset.url);
    else state.selected.delete(row.dataset.url);
    updateFooter();
    syncSelAll();
    return;
  }
  if (!btn) return;
  let owner = row;
  if (!owner) {
    // 解析面板里的按钮：往前找同一条目的 row
    const detail = btn.closest('li.detail');
    if (!detail) return;
    owner = detail.previousElementSibling;
    while (owner && !owner.classList.contains('row')) owner = owner.previousElementSibling;
  }
  if (!owner) return;
  const item = itemByUrl(owner.dataset.url);
  if (!item) return;
  const act = btn.dataset.act;

  if (act === 'copy') return actCopy(item.url);
  if (act === 'parse') return parseItem(item);
  if (act === 'helper') return actHelper(item);
  if (act === 'aria2') return actAria2([item]);
  if (act === 'browser') return actBrowser(item);
  if (act === 'ffmpeg') return actFfmpeg(item);
  if (act === 'copy-key') {
    return actCopy(state.detailData?.keyUri || '', ' KEY 地址');
  }
  if (act === 'variant') {
    const idx = Number(btn.closest('.variant').dataset.idx);
    const v = state.detailData?.variants?.[idx];
    if (!v) return;
    const child = {
      ...item,
      url: v.url,
      name: fileNameFromUrl(v.url, 'HLS'),
      kind: 'HLS'
    };
    state.pinned.set(child.url, child);
    state.lastSig = '';
    return parseItem(child);
  }
  if (act === 'copy-variant') {
    const idx = Number(btn.closest('.variant').dataset.idx);
    const v = state.detailData?.variants?.[idx];
    if (v) actCopy(v.url);
  }
}

async function onJobClick(e) {
  const b = e.target.closest('button[data-op]');
  if (!b) return;
  if (b.dataset.job) {
    const op = b.dataset.op;
    const r = await send('aria2:op', { gid: b.dataset.job, op });
    if (!r?.ok) toast(r?.error || '操作失败', true);
    setTimeout(refreshJobs, 500);
  } else if (b.dataset.hjob) {
    const r = await send('helper:cancel', { id: b.dataset.hjob });
    if (!r?.ok) toast(r?.error || '取消失败', true);
    setTimeout(refreshJobs, 500);
  }
}

function syncSelAll() {
  const rows = filtered();
  const all = rows.length > 0 && rows.every((i) => state.selected.has(i.url));
  $('#selAll').checked = all;
  $('#selAll').indeterminate = !all && rows.some((i) => state.selected.has(i.url));
}

function updateFooter() {
  const n = state.selected.size;
  $('#selInfo').textContent = n ? `已选 ${n} 项` : `共 ${filtered().length} 项`;
  $('#btnAria2').disabled = filtered().length === 0;
}

function switchPane(pane) {
  state.pane = pane;
  $('#paneSniff').hidden = pane !== 'sniff';
  $('#paneJobs').hidden = pane !== 'jobs';
  $('#bar').style.display = pane === 'sniff' ? '' : 'none';
  $('#tabSniff').classList.toggle('active', pane === 'sniff');
  $('#tabJobs').classList.toggle('active', pane === 'jobs');
  if (pane === 'jobs') refreshJobs();
}

let toastTimer = null;
function toast(msg, isErr = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('err', !!isErr);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, isErr ? 4200 : 2200);
}

init();
