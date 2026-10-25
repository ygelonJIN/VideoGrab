// 弹窗：列表、点名称展开预览、下载动作、任务面板。按钮一律用文字。
import {
  KIND_LABEL, humanBytes, humanDuration, hostOf, fileNameFromUrl
} from './common.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const HELPER_CMD = 'cd "/Volumes/TUF ESD-T1A Media/视频下载器/helper" && ./start.sh';

const state = {
  tabId: null,
  items: [],
  pinned: new Map(),
  segCount: 0,
  selected: new Set(),
  filter: '',
  kind: '',
  detailUrl: null,
  detail: null,
  pane: 'sniff',
  aria2Ok: null,
  helperOk: null,
  lastSig: ''
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

async function refreshList(force) {
  const r = await send('media:list', { tabId: state.tabId });
  if (!r?.ok) return;
  const sig = r.items.map((i) => i.url + ':' + i.size + ':' + i.kind).join('|') + '#' + r.segCount;
  const changed = sig !== state.lastSig;
  state.lastSig = sig;
  state.items = r.items;
  state.segCount = r.segCount || 0;

  const alive = new Set([...r.items.map((i) => i.url), ...state.pinned.keys()]);
  for (const u of [...state.selected]) if (!alive.has(u)) state.selected.delete(u);
  if (state.detailUrl && !alive.has(state.detailUrl)) {
    state.detailUrl = null;
    state.detail = null;
  }

  $('#cnt').textContent = allItems().length ? String(allItems().length) : '';
  if (changed || force) renderList();
  updateFooter();
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

function rowOps(item) {
  const stream = item.kind === 'HLS' || item.kind === 'DASH';
  if (stream) {
    return '<button class="mini" data-act="helper">交给助手</button>' +
           '<button class="mini" data-act="copy">复制链接</button>';
  }
  return '<button class="mini" data-act="aria2">aria2 下载</button>' +
         '<button class="mini" data-act="browser">浏览器下载</button>' +
         '<button class="mini" data-act="copy">复制链接</button>';
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
    li.className = 'row' + (state.detailUrl === item.url ? ' open' : '');
    li.dataset.url = item.url;
    li.innerHTML = `
      <input type="checkbox" class="sel" ${state.selected.has(item.url) ? 'checked' : ''}>
      <div class="main">
        <div class="title">
          <span class="badge k-${esc(item.kind)}">${esc(KIND_LABEL[item.kind] || item.kind)}</span>
          <span class="name" title="${esc(item.name)}">${esc(item.name)}</span>
        </div>
        <div class="sub">
          <span class="meta">${metaBits(item).map(esc).join('<i>·</i>')}</span>
          <span class="ops">${rowOps(item)}</span>
        </div>
      </div>`;
    list.appendChild(li);
    if (state.detailUrl === item.url) list.appendChild(detailEl(item));
  }
  syncSelAll();
  updateFooter();
}

// ------------------------------------------------------------------ 详情 / 预览
function detailEl(item) {
  const li = document.createElement('li');
  li.className = 'detail';
  const d = state.detail || {};
  const p = d.probe || null;
  const stream = item.kind === 'HLS' || item.kind === 'DASH';

  let thumb;
  if (p?.thumbnail) {
    thumb = `<img src="${p.thumbnail}" alt="预览帧">`;
  } else if (d.loading) {
    thumb = '<div class="ph">抓预览帧…</div>';
  } else if (d.err) {
    thumb = '<div class="ph">无法预览</div>';
  } else {
    thumb = '<div class="ph">无预览</div>';
  }

  const facts = [];
  if (p?.duration) facts.push('时长 ' + humanDuration(p.duration));
  if (p?.width) facts.push(`${p.width}×${p.height}`);
  if (p?.videoCodec) facts.push(p.videoCodec + (p.audioCodec ? ' / ' + p.audioCodec : ''));
  if (!stream && item.size) facts.push(humanBytes(item.size));

  const hls = d.hls;
  const streamFacts = [];
  if (hls?.type === 'media') {
    streamFacts.push(hls.segments + ' 个分片');
    if (hls.duration) streamFacts.push('总长 ' + humanDuration(hls.duration));
    streamFacts.push(hls.encrypted ? 'AES 加密' : '未加密');
    streamFacts.push(hls.live ? '直播流' : '点播');
  }
  if (hls?.type === 'master') streamFacts.push(`${hls.variants.length} 个清晰度`);

  const acts = [];
  if (stream) acts.push(['ffmpeg', '复制 ffmpeg 命令'], ['helper', '交给助手']);
  else acts.push(['aria2', 'aria2 下载'], ['browser', '浏览器下载']);
  acts.push(['copy', '复制链接']);

  li.innerHTML = `
    <div class="preview">
      <div class="thumb">${thumb}</div>
      <div class="info">
        ${facts.length ? `<div class="facts">${facts.map(esc).join('<i>·</i>')}</div>` : '<div class="facts dim">暂无元信息</div>'}
        ${streamFacts.length ? `<div class="facts soft">${streamFacts.map(esc).join('<i>·</i>')}</div>` : ''}
        ${d.err ? `<div class="hintline">预览要助手带 Referer 抓帧：<a href="#" data-act="copydir">复制启动命令</a></div>` : ''}
      </div>
    </div>
    ${hls?.type === 'master' ? variantsHtml(hls) : ''}
    <div class="acts">
      ${acts.map(([a, label]) => `<button class="mini" data-act="${a}">${label}</button>`).join('')}
    </div>
  `;
  return li;
}

function variantsHtml(master) {
  return `
    <div class="variants">
      ${master.variants.map((v, i) => `
        <div class="variant">
          <span class="v-name">${esc(v.resolution || '未知清晰度')}</span>
          <span class="v-sub">${v.bandwidth ? (v.bandwidth / 1e6).toFixed(2) + ' Mbps' : ''}</span>
          <button class="mini" data-act="variant" data-idx="${i}">看这条</button>
        </div>`).join('')}
    </div>`;
}

async function openDetail(item) {
  if (state.detailUrl === item.url) {
    state.detailUrl = null;
    state.detail = null;
    renderList();
    return;
  }
  state.detailUrl = item.url;
  state.detail = { loading: true, probe: null, hls: null, err: '' };
  renderList();

  const d = state.detail;
  const alive = () => state.detail === d;

  send('probe', { item })
    .then((r) => {
      if (!alive()) return;
      if (r?.ok && r.media) d.probe = r.media;
      else d.err = r?.error || '预览失败';
    })
    .catch((e) => { if (alive()) d.err = e.message; })
    .finally(() => { if (alive()) { d.loading = false; renderList(); } });

  if (item.kind === 'HLS' || item.kind === 'DASH') {
    send('hls:parse', { item })
      .then((r) => { if (alive() && r?.ok) { d.hls = r.result; renderList(); } })
      .catch(() => {});
  }
}

// ------------------------------------------------------------------ 动作
async function actAria2(items) {
  if (!items.length) return toast('先勾选要下载的条目');
  const streams = items.filter((i) => ['HLS', 'DASH'].includes(i.kind));
  const files = items.filter((i) => !['HLS', 'DASH'].includes(i.kind));
  if (streams.length && !files.length) return toast('流请用「复制 ffmpeg 命令」或「交给助手」', true);

  const r = await send('dl:aria2', { items: files });
  if (!r?.ok) return toast(r?.error || 'aria2 调用失败', true);
  if (r.gids?.length) {
    toast(`已加入 aria2：${r.gids.length} 个`);
    state.aria2Ok = true;
    switchPane('jobs');
    setTimeout(refreshJobs, 300);
  }
  if (r.errors?.length) { toast(r.errors[0], true); state.aria2Ok = false; }
  if (streams.length) toast('流请用「复制 ffmpeg 命令」或「交给助手」', true);
}

async function actBrowser(item) {
  const r = await send('dl:browser', { items: [{ url: item.url, name: item.name }] });
  if (!r?.ok) toast(r?.error || '下载失败', true);
  else toast('已交给浏览器（单连接，大文件慢）');
}

async function actCopy(text, label = '链接') {
  if (!text) return toast('没有内容可复制', true);
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast(`已复制${label}`);
}

async function actHelper(item) {
  const r = await send('helper:submit', {
    kind: item.kind, url: item.url, name: item.name, headers: item.headers
  });
  if (!r?.ok) {
    toast('助手没启动，先跑：' + HELPER_CMD, true);
    return;
  }
  toast('已交给助手，去「任务」看进度');
  switchPane('jobs');
  setTimeout(refreshJobs, 300);
}

async function actFfmpeg(item) {
  const base = (item.name || 'video').replace(/\.[^.]+$/, '');
  const r = await send('hls:ffmpeg', { item, outPath: `${base}.mp4` });
  if (!r?.ok) return toast(r?.error || '生成命令失败', true);
  await actCopy(r.command, ' ffmpeg 命令');
}

// ------------------------------------------------------------------ 任务
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
    } else state.aria2Ok = false;
  }

  try {
    const h = await send('helper:jobs');
    if (h?.ok) {
      state.helperOk = true;
      for (const j of (h.data.jobs || [])) parts.push(helperJobEl(j));
    }
  } catch { state.helperOk = false; }

  const list = $('#jobList');
  list.innerHTML = '';
  for (const el of parts) list.appendChild(el);
  $('#jobEmpty').hidden = parts.length > 0;
  const running = parts.filter((el) => el.classList.contains('running')).length;
  $('#jobStat').textContent = parts.length ? `共 ${parts.length} 个，进行中 ${running}` : '';
}

function pct(job) {
  const total = Number(job.totalLength) || 0;
  const done = Number(job.completedLength) || 0;
  return total ? Math.min(100, (done / total) * 100) : 0;
}

function statusText(s) {
  return ({
    active: '下载中', waiting: '排队', paused: '已暂停',
    complete: '已完成', error: '出错', removed: '已移除', unknown: '未知'
  })[s] || s;
}

function aria2JobEl(j) {
  const el = document.createElement('li');
  const status = j.status || 'unknown';
  const running = ['active', 'waiting', 'paused'].includes(status);
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
      <button class="mini" data-job="${esc(j.gid)}" data-op="${status === 'paused' ? 'unpause' : 'pause'}">${status === 'paused' ? '继续' : '暂停'}</button>
      <button class="mini" data-job="${esc(j.gid)}" data-op="remove">取消</button>
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
  if (j.status === 'running') meta.push(p.toFixed(0) + '%');
  meta.push(j.type === 'hls' ? 'ffmpeg 合并' : 'aria2/curl');

  el.innerHTML = `
    <div class="j-top">
      <span class="badge k-HLS">助手</span>
      <span class="j-name" title="${esc(j.name || '')}">${esc(j.name || j.url)}</span>
      ${running ? `<button class="mini" data-hjob="${esc(j.id)}" data-op="cancel">取消</button>` : ''}
    </div>
    <div class="bar ${j.status === 'done' ? 'done' : ''}"><i style="width:${p.toFixed(1)}%"></i></div>
    <div class="j-meta">${meta.map(esc).join('<i>·</i>')}</div>
    ${j.error ? `<div class="j-err">${esc(j.error)}</div>` : ''}`;
  return el;
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
    state.detail = null;
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
    toast('已导出；终端跑 aria2c -i 这个文件就能批量下');
  });

  $('#list').addEventListener('click', onListClick);
  $('#jobList').addEventListener('click', onJobClick);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.close(); });
}

function itemByUrl(url) { return allItems().find((i) => i.url === url); }

async function onListClick(e) {
  const btn = e.target.closest('button[data-act], a[data-act]');
  const row = e.target.closest('li.row');

  // 勾选框
  if (e.target.classList.contains('sel') && row) {
    if (e.target.checked) state.selected.add(row.dataset.url);
    else state.selected.delete(row.dataset.url);
    updateFooter();
    syncSelAll();
    return;
  }

  // 详情面板里的按钮：往前找所属的 row
  let owner = row;
  if (!owner) {
    const panel = e.target.closest('li.detail');
    if (!panel) return;
    owner = panel.previousElementSibling;
    while (owner && !owner.classList.contains('row')) owner = owner.previousElementSibling;
  }
  if (!owner) return;
  const item = itemByUrl(owner.dataset.url);
  if (!item) return;

  if (btn) {
    const act = btn.dataset.act;
    if (btn.tagName === 'A') e.preventDefault();
    if (act === 'copy') return actCopy(item.url);
    if (act === 'aria2') return actAria2([item]);
    if (act === 'browser') return actBrowser(item);
    if (act === 'helper') return actHelper(item);
    if (act === 'ffmpeg') return actFfmpeg(item);
    if (act === 'copydir') return actCopy(HELPER_CMD, '启动命令');
    if (act === 'variant') {
      const idx = Number(btn.dataset.idx);
      const v = state.detail?.hls?.variants?.[idx];
      if (!v) return;
      const child = { ...item, url: v.url, name: fileNameFromUrl(v.url, 'HLS'), kind: 'HLS' };
      state.pinned.set(child.url, child);
      state.lastSig = '';
      return openDetail(child);
    }
    return;
  }

  // 点整行 → 展开/收起预览
  if (e.target.closest('.ops')) return;
  return openDetail(item);
}

async function onJobClick(e) {
  const b = e.target.closest('button[data-op]');
  if (!b) return;
  if (b.dataset.job) {
    const r = await send('aria2:op', { gid: b.dataset.job, op: b.dataset.op });
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
  toastTimer = setTimeout(() => { el.hidden = true; }, isErr ? 5000 : 2400);
}

init();
