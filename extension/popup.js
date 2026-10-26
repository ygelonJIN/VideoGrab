// 弹窗：列表、点名称展开预览、下载动作、任务面板。按钮一律用文字。
import {
  KIND_LABEL, humanBytes, humanDuration, hostOf, fileNameFromUrl, isHelperDown
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
  lastSig: '',
  batchItems: [],
  batchSelected: new Set(),
  batchGroups: [],
  batchSelTouched: false,   // 用户手动改过勾选后，解析出的条目就不再强行自动勾
  batchHelperDown: false
};

async function send(type, payload = {}) {
  const r = await chrome.runtime.sendMessage({ type, ...payload });
  // 后台是旧代码认不出新消息时，别让用户看到"未知消息 xxx"
  if (r && r.ok === false && /未知消息/.test(String(r.error || ''))) {
    return { ...r, error: '扩展后台还是旧代码：去 chrome://extensions 点一下刷新按钮，再重开这个面板' };
  }
  return r;
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
  await restoreBatchState();
  probeBackends();
  setInterval(tick, 1000);
}

async function probeBackends() {
  const r = await send('diag');
  if (r?.ok) {
    state.aria2Ok = r.aria2;
    state.helperOk = r.helper;
    state.batchHelperDown = r.helper === false && state.batchHelperDown;
  }
  updateHelperUI();
}

// 助手状态是全局的：三个页签都要能看见，批量页还要挂引导卡
function updateHelperUI() {
  const st = $('#helperStatus');
  if (st) {
    st.classList.toggle('on', state.helperOk === true);
    st.classList.toggle('off', state.helperOk === false);
    $('#helperStatusText').textContent =
      state.helperOk === true ? '助手 在线'
        : state.helperOk === false ? '助手 离线'
          : '助手 检测中';
  }
  const guide = $('#batchGuide');
  if (guide) guide.hidden = state.helperOk !== false;
}

let ticking = false;
let probeTick = 0;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    if (++probeTick % 5 === 0) await probeBackends();
    if (state.pane === 'sniff') await refreshList(false);
    else if (state.pane === 'jobs') await refreshJobs();
    else if (state.pane === 'batch' && state.batchItems.length && !resolving && probeTick % 10 === 0) {
      await loadBatchLocal();
      renderBatch();
    }
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
  const hls = d.hls;

  const facts = [];
  if (p?.duration) facts.push('时长 ' + humanDuration(p.duration));
  if (hls?.duration) facts.push('时长 ' + humanDuration(hls.duration));
  if (p?.width) facts.push(`${p.width}×${p.height}`);
  if (p?.videoCodec) facts.push(p.videoCodec + (p.audioCodec ? ' / ' + p.audioCodec : ''));
  const size = p?.size || item.size;
  if (size) facts.push(humanBytes(size));

  const streamFacts = [];
  if (hls?.type === 'media') {
    streamFacts.push(hls.segments + ' 个分片');
    streamFacts.push(hls.encrypted ? 'AES 加密' : '未加密');
    streamFacts.push(hls.live ? '直播流' : '点播');
  }
  if (hls?.type === 'master') streamFacts.push(`${hls.variants.length} 个清晰度`);

  const acts = [];
  if (stream) acts.push(['ffmpeg', '复制 ffmpeg 命令'], ['helper', '交给助手']);
  else acts.push(['aria2', 'aria2 下载'], ['browser', '浏览器下载']);
  acts.push(['copy', '复制链接']);

  let head;
  if (d.err) {
    head = `<div class="facts">${facts.length ? facts.map(esc).join('<i>·</i>') : ''}</div>
      <div class="hintline err">${esc(String(d.err).slice(0, 120))}</div>
      <div class="hintline">${errHint(d.err)}</div>
      <div class="acts">
        ${/助手/.test(String(d.err)) ? '<button class="mini" data-act="helpsheet">怎么启动助手</button>' : ''}
        <button class="mini" data-act="diagcmd">复制诊断命令</button>
      </div>`;
  } else if (d.loading && !facts.length && !streamFacts.length) {
    head = '<div class="facts dim">读取文件信息…</div>';
  } else {
    head = `<div class="facts">${facts.length ? facts.map(esc).join('<i>·</i>') : '<span class="dim">暂无元信息</span>'}</div>
      ${streamFacts.length ? `<div class="facts soft">${streamFacts.map(esc).join('<i>·</i>')}</div>` : ''}`;
  }

  li.innerHTML = `
    ${head}
    ${hls?.type === 'master' ? variantsHtml(hls) : ''}
    ${d.err ? '' : `<div class="acts">${acts.map(([a, label]) => `<button class="mini" data-act="${a}">${label}</button>`).join('')}</div>`}
  `;
  return li;
}

function errHint(err) {
  const e = String(err || '');
  if (/未知消息/.test(e)) {
    return '后台代码还是旧的：去 chrome://extensions 点这个扩展卡片上的刷新按钮，然后重开面板。';
  }
  if (/Failed to fetch|NetworkError|ECONNREFUSED|助手|HTTP 500/.test(e)) {
    return '助手没在跑。<a href="#" data-act="copydir">复制启动命令</a> 到终端执行，窗口留着别关。';
  }
  if (/40[13]|Forbidden|access denied/i.test(e)) {
    return '源站拒绝了这次请求：多半是链接过期，回页面重新播一次。';
  }
  return '可以点「复制 ffmpeg 命令」手动跑，终端里的报错更具体。';
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
  // 弹窗里 execCommand 最可靠；clipboard API 有时 resolve 了但没写进去
  let ok = false;
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    ta.setAttribute('readonly', '');
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    ok = document.execCommand('copy');
    ta.remove();
  } catch { ok = false; }
  if (!ok) {
    try { await navigator.clipboard.writeText(text); ok = true; } catch { ok = false; }
  }
  toast(ok ? `已复制${label}` : '复制失败：请手动选中文本', !ok);
}

async function actHelper(item) {
  const r = await send('helper:submit', {
    kind: item.kind, url: item.url, name: item.name, headers: item.headers
  });
  if (!r?.ok) {
    if (isHelperDown(r?.error)) {
      state.helperOk = false;
      state.batchHelperDown = true;
      updateHelperUI();
    }
    openHelperSheet();
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
// 存到哪儿必须写出来：助手默认落在 ~/Desktop，文件名又是网页标题，
// 不显示全路径的话，用户根本找不到自己刚下的东西。
function shortPath(p) {
  return String(p || '').replace(/^\/Users\/[^/]+/, '~');
}

function pathLine(p) {
  if (!p) return '';
  return `<div class="j-path" title="${esc(p)}">${esc(shortPath(p))}</div>`;
}

function pathOps(p) {
  if (!p) return '';
  return `<button class="mini" data-reveal="${esc(p)}">打开文件夹</button>
          <button class="mini" data-copypath="${esc(p)}">复制路径</button>`;
}

async function revealFile(p) {
  const r = await send('file:reveal', { path: p });
  if (!r?.ok) toast(r?.error || '打不开这个位置', true);
}

async function refreshJobs() {
  const got = await chrome.storage.local.get('jobs');
  const aria2Jobs = (got.jobs || []).filter((j) => j.gid);
  const parts = [];
  let queuedN = 0;

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
      for (const j of (h.data.jobs || [])) {
        if (j.status === 'queued') queuedN++;
        parts.push(helperJobEl(j));
      }
    } else state.helperOk = false;
  } catch { state.helperOk = false; }
  updateHelperUI();

  const list = $('#jobList');
  list.innerHTML = '';
  for (const el of parts) list.appendChild(el);
  $('#jobEmpty').hidden = parts.length > 0;
  const running = parts.filter((el) => el.classList.contains('running')).length;
  $('#jobStat').textContent = parts.length
    ? `共 ${parts.length} 个，进行中 ${running - queuedN}${queuedN ? `，排队 ${queuedN}` : ''}`
    : '';
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
  const done = status === 'complete';
  // aria2 说"下完了"，但文件可能早被手动删了 —— 别再挂个"已完成"骗人
  const missing = done && j.exists === false;
  el.className = `job ${running ? 'running' : ''} ${done && !missing ? 'done' : ''} ${missing ? 'warn' : ''} ${status === 'error' ? 'err' : ''}`;

  const p = done ? 100 : pct(j);
  const speed = Number(j.downloadSpeed) || 0;
  const conns = Number(j.connections) || 0;
  const filePath = (j.files && j.files[0] && j.files[0].path) || '';
  const name = j.name || j.url;

  const meta = [];
  if (j.totalLength) meta.push(`${humanBytes(j.completedLength)} / ${humanBytes(j.totalLength)}`);
  if (speed > 0) meta.push(humanBytes(speed) + '/s');
  if (conns > 0) meta.push(`${conns} 线程`);
  meta.push(missing ? '文件已删除' : statusText(status));

  let ops = '';
  if (status === 'active' || status === 'waiting') {
    ops = `<button class="mini" data-job="${esc(j.gid)}" data-op="pause">暂停</button>
           <button class="mini" data-job="${esc(j.gid)}" data-op="remove">取消</button>`;
  } else if (status === 'paused') {
    ops = `<button class="mini" data-job="${esc(j.gid)}" data-op="unpause">继续</button>
           <button class="mini" data-job="${esc(j.gid)}" data-op="remove">取消</button>`;
  } else {
    ops = `${pathOps(filePath)}
           ${filePath ? `<button class="mini danger" data-del="${esc(filePath)}" data-gid="${esc(j.gid)}" data-name="${esc(name)}">删除文件</button>` : ''}
           <button class="mini" data-forget="${esc(j.gid)}">删除记录</button>`;
  }

  el.innerHTML = `
    <div class="j-top">
      <span class="badge k-${esc(j.kind || 'MP4')}">aria2</span>
      <span class="j-name" title="${esc(name)}">${esc(name)}</span>
      ${ops}
    </div>
    <div class="bar ${done && !missing ? 'done' : ''}"><i style="width:${p.toFixed(1)}%"></i></div>
    <div class="j-meta">${meta.map(esc).join('<i>·</i>')}</div>
    ${pathLine(filePath)}
    ${missing ? '<div class="j-err">本地文件已经不在了。点「删除记录」把它从列表里去掉。</div>' : ''}
    ${j.errorMessage ? `<div class="j-err">${esc(j.errorMessage)}</div>` : ''}`;
  return el;
}

function helperJobEl(j) {
  const el = document.createElement('li');
  const running = j.status === 'running' || j.status === 'queued';
  const done = j.status === 'done';
  // 完成了但文件不在本地 —— 多半是自己删了，别再糊一个"已完成"
  const missing = done && j.exists === false;
  el.className = `job ${running ? 'running' : ''} ${done && !missing ? 'done' : ''} ${missing ? 'warn' : ''} ${j.status === 'error' ? 'err' : ''}`;

  const p = done ? 100 : Math.max(0, Math.min(100, Number(j.progress) || 0));
  const meta = [];
  if (missing) meta.push('文件已删除');
  else if (done) meta.push('已完成');
  else if (j.status === 'queued') meta.push('排队中');
  if (j.speed) meta.push(humanBytes(j.speed) + '/s');
  if (j.status === 'running') meta.push(p.toFixed(0) + '%');
  meta.push(j.type === 'hls' ? 'ffmpeg 合并' : 'aria2/curl');

  const ops = running
    ? `<button class="mini" data-hjob="${esc(j.id)}" data-op="cancel">取消</button>`
    : `${pathOps(j.out)}
       <button class="mini danger" data-hdel="${esc(j.out || '')}" data-hid="${esc(j.id)}" data-name="${esc(j.name || '')}">删除文件</button>
       <button class="mini" data-hforget="${esc(j.id)}">删除记录</button>`;

  el.innerHTML = `
    <div class="j-top">
      <span class="badge k-HLS">助手</span>
      <span class="j-name" title="${esc(j.name || '')}">${esc(j.name || j.url)}</span>
      ${ops}
    </div>
    <div class="bar ${done && !missing ? 'done' : ''}"><i style="width:${p.toFixed(1)}%"></i></div>
    <div class="j-meta">${meta.map(esc).join('<i>·</i>')}</div>
    ${pathLine(j.out)}
    ${missing ? '<div class="j-err">本地文件已经不在了。直链会过期，要重下请到「批量」页重新解析。</div>' : ''}
    ${j.error ? `<div class="j-err">${esc(j.error)}</div>` : ''}`;
  return el;
}

// ------------------------------------------------------------------ 批量
// 状态要分清楚，别把"源没了"和"解析失败"混成一个"没成功"
const BATCH_STATUS = {
  pending: { label: '待解析', cls: 'b-pending' },
  ok: { label: '可下', cls: 'b-ok' },
  gone: { label: '已下架', cls: 'b-gone' },
  unavailable: { label: '源已失效', cls: 'b-gone' },
  failed: { label: '解析失败', cls: 'b-fail' }
};

// 弹窗一关内存就没了，而解析一页要几十秒 —— 结果必须落到 session 里
const BATCH_STORE = 'batchPanel';

async function saveBatchState() {
  try {
    await chrome.storage.session.set({
      [BATCH_STORE]: {
        items: state.batchItems,
        selected: [...state.batchSelected],
        selTouched: state.batchSelTouched,
        ts: Date.now()
      }
    });
  } catch { /* 配额满了就算了，不影响当前这一屏 */ }
}

async function restoreBatchState() {
  try {
    const got = await chrome.storage.session.get(BATCH_STORE);
    const saved = got[BATCH_STORE];
    if (saved?.items?.length) {
      state.batchItems = saved.items;
      // 勾选也要接上：弹窗重开不该把勾好的又清掉
      if (Array.isArray(saved.selected)) {
        state.batchSelected = new Set(saved.selected);
        state.batchSelTouched = !!saved.selTouched;
      }
    }
  } catch { /* ignore */ }
  renderBatch();
  if (!state.batchItems.length) return;
  await loadBatchLocal();
  renderBatch();
  // 解析是在弹窗里跑的，弹窗一关就断 —— 重开时看到「待解析」要自动续上，
  // 否则用户只会看到一屏永远不动的「待解析」
  if (state.batchItems.some((i) => i.status === 'pending')) resolveBatch();
}

function labelOf(it) {
  if (it.title) return it.title;
  if (it.label) return it.label;
  try {
    const u = new URL(it.url);
    return decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || u.host);
  } catch { return it.url; }
}

async function loadBatchLocal() {
  const [h, jobs] = await Promise.all([send('batch:history'), send('helper:jobs')]);
  const hist = h?.ok ? (h.history || {}) : {};
  const byName = new Map();
  if (jobs?.ok) for (const j of (jobs.data?.jobs || [])) byName.set(j.name, j);

  for (const it of state.batchItems) {
    it.local = '';
    it.job = null;
    const rec = hist[it.url];
    if (!rec) continue;
    const j = byName.get(rec.name);
    if (!j) { it.local = 'saved'; continue; }
    it.job = j;
    if (j.status === 'done') it.local = j.exists === false ? 'deleted' : 'saved';
    else if (j.status === 'running' || j.status === 'queued') it.local = 'running';
    else it.local = 'saved';
  }
}

async function scanPage() {
  if (!state.tabId) return toast('读不到当前标签页', true);
  const btn = $('#btnScan');
  btn.disabled = true;
  $('#batchHint').textContent = '正在读取页面…';
  try {
    let pageUrl = '';
    try { pageUrl = (await chrome.tabs.get(state.tabId))?.url || ''; } catch {}
    const r = await send('batch:scan', { tabId: state.tabId, pageUrl });
    if (!r?.ok) {
      $('#batchHint').textContent = '';
      if (isHelperDown(r?.error)) {
        state.helperOk = false;
        updateHelperUI();
        openHelperSheet();
      }
      toast(r?.error || '扫描失败', true);
      return;
    }
    if (r.helperDown) {
      // 助手没开：本地也能按链接结构认条目，但解析直链必须有助手
      state.batchHelperDown = true;
      state.helperOk = false;
      updateHelperUI();
    }

    const listing = r.scan?.listing || [];
    // 3 条以上才算一组：老版助手会把单条链接也塞进 listing，不设下限会“认出”一堆垃圾
    const groups = listing.filter((g) => (g.items?.length || 0) >= 3);
    state.batchGroups = groups;
    if (!groups.length) {
      state.batchItems = [];
      renderBatch();
      const maxG = listing.reduce((m, g) => Math.max(m, g.items?.length || 0), 0);
      const stats = `读到 ${r.linkCount || 0} 条链接，最多的一组只有 ${maxG} 条（3 条以上才算一组）`;
      $('#batchHint').textContent = r.helperDown
        ? `助手没开，${stats}。启动助手后能扫得更全`
        : `${stats}。滚到底等卡片都出来，再点「扫描本页」`;
      toast(r.helperDown
        ? `助手没开，${stats}：启动助手后能扫得更全`
        : `这一页没认出条目列表：${stats}`, true);
      return;
    }

    // 条目最多的那个模板就是列表本体
    const best = groups[0];
    state.batchItems = best.items.map((it) => ({
      url: it.url, label: it.label || '', title: '', status: 'pending', media: null, reason: ''
    }));
    state.batchSelected = new Set();
    state.batchSelTouched = false;
    $('#batchHint').textContent = r.helperDown
      ? `认出 ${best.count} 条（路径模板 ${best.template}）。助手没开，只能先列条目：启动助手后点「解析剩余 ${best.count} 条」`
      : `认出 ${best.count} 条（路径模板 ${best.template}），开始解析…`;
    await loadBatchLocal();
    renderBatch();
    await saveBatchState();
  } catch (e) {
    $('#batchHint').textContent = '';
    toast(e?.message || '扫描失败', true);
  } finally {
    btn.disabled = false;
  }

  // 扫描完直接解析：否则用户会看到一屏灰勾选框，根本不知道下一步该点什么
  // （助手没开时解析不了，条目先停在「待解析」，引导卡会告诉用户怎么办）
  if (!state.batchHelperDown && state.batchItems.some((i) => i.status === 'pending')) resolveBatch();
}

let resolving = false;

async function resolveBatch(retryFailed = false) {
  if (resolving) return;
  if (retryFailed) {
    for (const it of state.batchItems) {
      if (it.status === 'failed') { it.status = 'pending'; it.reason = ''; }
    }
    renderBatch();
  }
  const pending = state.batchItems.filter((i) => i.status === 'pending');
  if (!pending.length) return toast('没有待解析的条目');

  resolving = true;
  const btnResolve = $('#btnResolve');
  const btnScan = $('#btnScan');
  btnResolve.disabled = true;
  btnScan.disabled = true;

  try {
    // 5 条一批：能边解析边出结果，弹窗中途关了也只丢最后一批
    const CHUNK = 5;
    for (let i = 0; i < pending.length; i += CHUNK) {
      const chunk = pending.slice(i, i + CHUNK);
      $('#batchHint').textContent =
        `解析中 ${i + 1}~${Math.min(i + CHUNK, pending.length)} / ${pending.length} …`;

      let r;
      try {
        r = await send('batch:resolve', { urls: chunk.map((x) => x.url) });
      } catch (e) {
        r = { ok: false, error: e?.message || String(e) };
      }
      if (!r?.ok) {
        const err = String(r?.error || '解析失败');
        if (isHelperDown(err)) {
          // 助手掉了，后面的批次也是白试：停下来给引导，别一条条报错刷屏
          state.helperOk = false;
          state.batchHelperDown = true;
          updateHelperUI();
          openHelperSheet();
          toast(err, true);
          break;
        }
        // 这一批失败不影响后面的批次
        for (const it of chunk) {
          it.status = 'failed';
          it.reason = err.slice(0, 120);
        }
        renderBatch();
        await saveBatchState();
        continue;
      }

      const byUrl = new Map((r.items || []).map((x) => [x.url, x]));
      for (const it of chunk) {
        const got = byUrl.get(it.url);
        if (!got) { it.status = 'failed'; it.reason = '没有返回结果'; continue; }
        it.media = got.media || null;
        it.title = got.title || '';
        it.reason = got.reason || '';
        it.status = got.ok ? 'ok' : got.gone ? 'gone' : got.unavailable ? 'unavailable' : 'failed';
        // 用户手动改过勾选就不再强行自动勾，不然刚取消的又会被后解析出来的带上去
        if (got.ok && !state.batchSelTouched) state.batchSelected.add(it.url);
      }
      renderBatch();
      await saveBatchState();
    }
  } catch (e) {
    $('#batchHint').textContent = '';
    toast(e?.message || '解析失败', true);
  } finally {
    resolving = false;
    btnResolve.disabled = false;
    btnScan.disabled = false;
    const n = (s) => state.batchItems.filter((i) => i.status === s).length;
    if (state.batchItems.length) {
      const left = n('pending');
      $('#batchHint').textContent = (state.batchHelperDown && left)
        ? `助手没开，还有 ${left} 条待解析：启动助手后点「解析剩余 ${left} 条」`
        : `可下 ${n('ok')} · 源失效 ${n('unavailable')} · 已下架 ${n('gone')} · 失败 ${n('failed')}`;
    }
    renderBatch();
    await saveBatchState();
  }
}

async function submitBatch() {
  const items = state.batchItems.filter((i) => i.status === 'ok' && state.batchSelected.has(i.url));
  if (!items.length) return toast('没有勾选「可下」的条目');
  const btn = $('#btnBatchDown');
  btn.disabled = true;
  try {
    const r = await send('batch:submit', {
      items: items.map((i) => ({ url: i.url, name: i.title || i.label, media: i.media }))
    });
    if (!r?.ok) {
      if (isHelperDown(r?.error)) {
        state.helperOk = false;
        updateHelperUI();
        openHelperSheet();
      }
      toast(r?.error || '提交失败', true);
      return;
    }
    const okN = (r.jobs || []).length;
    toast(`已加入 ${okN} 个下载任务${r.errors?.length ? `，${r.errors.length} 个失败` : ''}`, !okN);
    await loadBatchLocal();
    renderBatch();
    await saveBatchState();
  } finally {
    btn.disabled = false;
  }
}

function renderBatch() {
  const list = $('#batchList');
  list.innerHTML = '';
  const rows = state.batchItems;
  $('#batchEmpty').hidden = rows.length > 0;

  const pendingN = rows.filter((i) => i.status === 'pending').length;
  const failedN = rows.filter((i) => i.status === 'failed').length;
  const btnR = $('#btnResolve');
  if (!rows.length) {
    btnR.textContent = '解析条目';
    btnR.disabled = true;
    btnR.title = '先扫描本页';
  } else {
    // 按钮要自己说清楚还剩什么活，别停在一个和现状对不上的名字上
    btnR.textContent = resolving ? '解析中'
      : pendingN ? `解析剩余 ${pendingN} 条`
        : failedN ? `重试失败 ${failedN} 条`
          : '全部已解析';
    btnR.disabled = resolving || (!pendingN && !failedN);
    btnR.title = failedN && !pendingN ? '把解析失败的条目再试一遍' : '把还没解析的条目解析出直链';
  }
  $('#btnScan').disabled = resolving;

  for (const it of rows) {
    const st = BATCH_STATUS[it.status] || BATCH_STATUS.pending;
    const chips = [`<span class="chip ${st.cls}">${st.label}</span>`];
    if (it.local === 'saved') chips.push('<span class="chip b-saved">已下载</span>');
    if (it.local === 'deleted') chips.push('<span class="chip b-warn">文件已删</span>');
    if (it.local === 'running') chips.push('<span class="chip b-pending">下载中</span>');
    const size = it.media?.size ? humanBytes(it.media.size) : '';

    const pickable = it.status === 'ok';
    const why = pickable ? '' :
      it.status === 'pending' ? 'title="解析完才能勾选"' : 'title="这条没有可下地址"';

    const li = document.createElement('li');
    li.className = 'row batch';
    li.dataset.url = it.url;
    li.innerHTML = `
      <input type="checkbox" class="bsel" ${state.batchSelected.has(it.url) ? 'checked' : ''}
        ${pickable ? '' : 'disabled'} ${why}>
      <div class="main">
        <div class="title"><span class="name" title="${esc(labelOf(it))}">${esc(labelOf(it))}</span></div>
        <div class="sub">
          <span class="meta">${chips.join('')}${size ? `<i>·</i>${esc(size)}` : ''}</span>
          <span class="ops"><button class="mini" data-bact="copy">复制链接</button></span>
          ${it.reason && it.status !== 'ok' ? `<span class="why" title="${esc(it.reason)}">${esc(it.reason)}</span>` : ''}
        </div>
      </div>`;
    list.appendChild(li);
  }

  syncBatchSelUI();
}

// 勾选状态原地同步：整表重建会把勾选框、滚动位置全搞乱
function syncBatchSelUI() {
  const rows = state.batchItems;
  const okAll = rows.filter((i) => i.status === 'ok').length;
  for (const li of $('#batchList').querySelectorAll('li.row')) {
    const box = li.querySelector('.bsel');
    if (box && !box.disabled) box.checked = state.batchSelected.has(li.dataset.url);
  }
  const selAll = $('#batchSelAll');
  const picked = state.batchSelected.size;
  // 没有「可下」的时候，全选框要自己说明不能点，否则就是个死控件
  selAll.disabled = okAll === 0;
  selAll.checked = okAll > 0 && picked === okAll;
  selAll.indeterminate = picked > 0 && picked < okAll;
  selAll.title = okAll === 0 ? (rows.length ? '这一页没有可下的条目' : '先扫描本页') : '全选可下的条目';
  $('#batchSelInfo').textContent = rows.length ? `已勾 ${picked} / 可下 ${okAll} 条` : '';
  $('#btnBatchDown').disabled = picked === 0;
}

// ------------------------------------------------------------------ 事件
function bindEvents() {
  $('#tabSniff').addEventListener('click', () => switchPane('sniff'));
  $('#tabJobs').addEventListener('click', () => switchPane('jobs'));
  $('#tabBatch').addEventListener('click', () => switchPane('batch'));
  $('#btnScan').addEventListener('click', scanPage);
  // 点按钮 = 把待解析和失败的都再跑一遍（自动续解析只捡 pending）
  $('#btnResolve').addEventListener('click', () => resolveBatch(true));
  $('#btnBatchDown').addEventListener('click', submitBatch);
  $('#btnBatchRefresh').addEventListener('click', async () => {
    await loadBatchLocal();
    renderBatch();
    toast('状态已刷新');
  });
  $('#btnExport').addEventListener('click', exportBatchLinks);
  $('#batchGuideCopy').addEventListener('click', () => actCopy(HELPER_CMD, '启动命令'));
  $('#batchGuideRecheck').addEventListener('click', recheckGuide);
  $('#batchGuideSteps').addEventListener('click', openHelperSheet);
  $('#helperStatus').addEventListener('click', () => {
    if (state.helperOk === false) openHelperSheet();
    else if (state.helperOk === true) toast('本地助手已连接（127.0.0.1:8765）');
    else probeBackends();
  });
  $('#batchSelAll').addEventListener('change', (e) => {
    state.batchSelTouched = true;
    if (e.target.checked) {
      for (const i of state.batchItems) if (i.status === 'ok') state.batchSelected.add(i.url);
    } else {
      state.batchSelected.clear();
    }
    syncBatchSelUI();
    saveBatchState();
  });
  $('#batchList').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-bact]');
    if (!btn) return;
    const row = e.target.closest('li.row');
    if (!row) return;
    const it = state.batchItems.find((x) => x.url === row.dataset.url);
    if (it && btn.dataset.bact === 'copy') return actCopy(it.url);
  });
  $('#batchList').addEventListener('change', (e) => {
    if (!e.target.classList.contains('bsel')) return;
    const row = e.target.closest('li.row');
    if (!row) return;
    state.batchSelTouched = true;
    if (e.target.checked) state.batchSelected.add(row.dataset.url);
    else state.batchSelected.delete(row.dataset.url);
    syncBatchSelUI();
    saveBatchState();
  });
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

  $('#sheetClose').addEventListener('click', closeHelperSheet);
  $('#sheet').addEventListener('click', (e) => { if (e.target.id === 'sheet') closeHelperSheet(); });
  $('#sheetCopy').addEventListener('click', () => actCopy(HELPER_CMD, '启动命令'));
  $('#sheetCopy2').addEventListener('click', () => actCopy(HELPER_CMD, '启动命令'));
  $('#sheetRecheck').addEventListener('click', recheckHelper);

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
    if (act === 'diagcmd') return actCopy(diagCommand(item), '诊断命令');
    if (act === 'helpsheet') return openHelperSheet();
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

async function dropJobRecord(gid) {
  try {
    const got = await chrome.storage.local.get('jobs');
    await chrome.storage.local.set({ jobs: (got.jobs || []).filter((j) => j.gid !== gid) });
  } catch { /* 忽略 */ }
}

async function deleteAria2File(gid, path, name) {
  if (!path) return toast('拿不到文件路径，只能删记录', true);
  if (!window.confirm(`从磁盘删除？\n${name}\n\n删了就找不回来了。`)) return;
  const r = await send('file:delete', { path });
  if (!r?.ok) return toast(r.error || '删除失败', true);
  await send('job:forget', { gid });
  await dropJobRecord(gid);
  toast('文件已从磁盘删除');
  refreshJobs();
}

async function forgetAria2(gid) {
  await send('job:forget', { gid });
  await dropJobRecord(gid);
  toast('记录已删除，文件还在');
  refreshJobs();
}

async function deleteHelperFile(id, path, name) {
  if (!path) return toast('拿不到文件路径，只能删记录', true);
  if (!window.confirm(`从磁盘删除？\n${name}\n\n删了就找不回来了。`)) return;
  const r = await send('file:delete', { path });
  if (!r?.ok) return toast(r.error || '删除失败', true);
  await send('helper:forget', { id });
  toast('文件已从磁盘删除');
  refreshJobs();
}

async function forgetHelper(id) {
  await send('helper:forget', { id });
  toast('记录已删除，文件还在');
  refreshJobs();
}

async function onJobClick(e) {
  const b = e.target.closest('button');
  if (!b) return;

  if (b.dataset.reveal) return revealFile(b.dataset.reveal);
  if (b.dataset.copypath) return actCopy(b.dataset.copypath, '路径');
  if (b.dataset.del) return deleteAria2File(b.dataset.gid, b.dataset.del, b.dataset.name);
  if (b.dataset.forget) return forgetAria2(b.dataset.forget);
  if (b.dataset.hdel) return deleteHelperFile(b.dataset.hid, b.dataset.hdel, b.dataset.name);
  if (b.dataset.hforget) return forgetHelper(b.dataset.hforget);

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
  $('#paneBatch').hidden = pane !== 'batch';
  $('#bar').style.display = pane === 'sniff' ? '' : 'none';
  $('#tabSniff').classList.toggle('active', pane === 'sniff');
  $('#tabJobs').classList.toggle('active', pane === 'jobs');
  $('#tabBatch').classList.toggle('active', pane === 'batch');
  if (pane === 'jobs') refreshJobs();
  if (pane === 'batch' && state.batchItems.length) { loadBatchLocal().then(renderBatch); }
}

function openHelperSheet() {
  const el = $('#sheet');
  if (!el) return;
  $('#sheetState').textContent = '';
  $('#sheetState').className = 'd';
  el.hidden = false;
}

function closeHelperSheet() {
  const el = $('#sheet');
  if (el) el.hidden = true;
}

async function recheckHelper() {
  const st = $('#sheetState');
  st.textContent = '检测中…';
  st.className = 'd';
  const r = await send('diag');
  if (r?.ok && r.helper) {
    st.textContent = '✅ 连上了，关掉这个提示就能用';
    st.className = 'd ok';
    state.helperOk = true;
    state.batchHelperDown = false;
    updateHelperUI();
    // 助手回来了就接着干活，别让用户再点一次
    if (state.batchItems.some((i) => i.status === 'pending')) resolveBatch();
  } else {
    st.textContent = '还是连不上：确认那个终端窗口还开着、命令没报错';
    st.className = 'd err';
    state.helperOk = false;
    updateHelperUI();
  }
}

// 批量页引导卡上的「重新检测」：轻量版，不弹整页引导
async function recheckGuide() {
  const st = $('#batchGuideState');
  st.textContent = '检测中…';
  const r = await send('diag');
  if (r?.ok && r.helper) {
    st.textContent = '连上了，开始干活';
    state.helperOk = true;
    state.batchHelperDown = false;
    updateHelperUI();
    if (state.batchItems.some((i) => i.status === 'pending')) resolveBatch();
  } else {
    state.helperOk = false;
    updateHelperUI();
    st.textContent = '还是连不上：确认终端窗口还开着、命令没报错';
  }
}

// 没有助手时批量页还能干的事：把条目链接导出来
async function exportBatchLinks() {
  const items = state.batchSelected.size
    ? state.batchItems.filter((i) => state.batchSelected.has(i.url))
    : state.batchItems;
  if (!items.length) return toast('还没有可导出的条目', true);
  const text = items.map((i) => `${i.title || labelOf(i)}\t${i.url}`).join('\n') + '\n';
  const url = 'data:text/plain;charset=utf-8,' + encodeURIComponent(text);
  await chrome.downloads.download({ url, filename: '批量链接.txt', saveAs: true });
  toast(`已导出 ${items.length} 条链接${state.batchSelected.size ? '' : '（全部）'}`);
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
