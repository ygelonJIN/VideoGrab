// 后台：嗅探媒体请求、保存请求头、调度下载。
import {
  DEFAULT_SETTINGS, classify, fileNameFromUrl, aria2Call, aria2Options,
  aria2InputText, parsePlaylist, helperCall, toTask, ffmpegCommandOneLine
} from './common.js';

const MAX_ITEMS = 300;
const segCounts = new Map();     // tabId -> 折叠掉的分片数
const tabItems = new Map();      // tabId -> Map(url -> item)
const loading = new Map();       // tabId -> Promise
const saveTimers = new Map();
const pending = new Map();       // requestId -> 请求头

let settings = { ...DEFAULT_SETTINGS };
const settingsReady = chrome.storage.local.get('settings').then((got) => {
  settings = { ...DEFAULT_SETTINGS, ...(got.settings || {}) };
}).catch(() => {});

const keyOf = (tabId) => `tab:${tabId}`;

// ---------------------------------------------------------------- 设置
async function getSettings() {
  await settingsReady;
  return settings;
}

let proxyCache = { at: 0, value: '', info: null };
async function resolveProxy(force = false) {
  const s = await getSettings();
  if (s.proxyMode === 'off') return '';
  if (s.proxyMode === 'manual') return s.proxy || '';
  // auto：问助手系统代理开没开
  if (!force && Date.now() - proxyCache.at < 20000) return proxyCache.value;
  try {
    const r = await helperCall(s, '/api/proxy', {}, 4000);
    proxyCache = { at: Date.now(), value: r.enabled ? (r.proxy || '') : '', info: r };
    return proxyCache.value;
  } catch {
    proxyCache = { at: Date.now(), value: s.proxy || '', info: { enabled: !!s.proxy, proxy: s.proxy || '', source: 'fallback' } };
    return proxyCache.value;
  }
}

// ---------------------------------------------------------------- 状态读写
async function getTabMap(tabId) {
  if (tabItems.has(tabId)) return tabItems.get(tabId);
  if (loading.has(tabId)) return loading.get(tabId);
  const p = (async () => {
    const map = new Map();
    try {
      const got = await chrome.storage.session.get(keyOf(tabId));
      const saved = got[keyOf(tabId)];
      if (saved?.items) for (const it of saved.items) map.set(it.url, it);
      if (saved?.segCount) segCounts.set(tabId, saved.segCount);
    } catch { /* session 存储不可用时忽略 */ }
    tabItems.set(tabId, map);
    return map;
  })();
  loading.set(tabId, p);
  const m = await p;
  loading.delete(tabId);
  return m;
}

function scheduleSave(tabId) {
  clearTimeout(saveTimers.get(tabId));
  saveTimers.set(tabId, setTimeout(() => saveTab(tabId), 600));
}

async function saveTab(tabId) {
  const m = tabItems.get(tabId);
  if (!m) return;
  try {
    await chrome.storage.session.set({
      [keyOf(tabId)]: { items: [...m.values()], segCount: segCounts.get(tabId) || 0, ts: Date.now() }
    });
  } catch { /* 忽略配额错误 */ }
}

async function refreshBadge(tabId) {
  const m = tabItems.get(tabId);
  const n = m ? m.size : 0;
  try {
    await chrome.action.setBadgeText({ tabId, text: n ? String(n) : '' });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#2563eb' });
  } catch { /* 标签页可能已关闭 */ }
}

async function clearTab(tabId) {
  tabItems.delete(tabId);
  segCounts.delete(tabId);
  try { await chrome.storage.session.remove(keyOf(tabId)); } catch {}
  await refreshBadge(tabId);
}

// ---------------------------------------------------------------- 嗅探
chrome.webRequest.onBeforeSendHeaders.addListener(
  (d) => {
    const h = {};
    for (const x of d.requestHeaders || []) h[x.name.toLowerCase()] = x.value;
    pending.set(d.requestId, {
      referer: h['referer'] || '',
      origin: h['origin'] || '',
      cookie: h['cookie'] || '',
      ua: h['user-agent'] || ''
    });
    if (pending.size > 3000) {
      const drop = pending.size - 2000;
      let i = 0;
      for (const k of pending.keys()) { pending.delete(k); if (++i >= drop) break; }
    }
  },
  { urls: ['<all_urls>'] },
  ['requestHeaders', 'extraHeaders']
);

chrome.webRequest.onCompleted.addListener((d) => pending.delete(d.requestId), { urls: ['<all_urls>'] });
chrome.webRequest.onErrorOccurred.addListener((d) => pending.delete(d.requestId), { urls: ['<all_urls>'] });

chrome.webRequest.onHeadersReceived.addListener(
  (d) => {
    if (d.tabId < 0 || !/^https?:/i.test(d.url)) return;
    const rh = {};
    for (const x of d.responseHeaders || []) rh[x.name.toLowerCase()] = x.value;
    const contentType = rh['content-type'] || '';
    const kind = classify(d.url, contentType);
    if (!kind) return;

    const size = Number(rh['content-length']) || 0;
    const headers = { ...(pending.get(d.requestId) || {}) };
    if (!headers.referer && d.initiator) headers.referer = d.initiator + '/';

    addItem(d.tabId, {
      url: d.url,
      kind,
      contentType,
      size,
      status: d.statusCode,
      ranges: (rh['accept-ranges'] || '').toLowerCase().includes('bytes'),
      headers
    }).catch(() => {});
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders', 'extraHeaders']
);

async function addItem(tabId, raw) {
  await settingsReady;
  if (raw.kind === 'TS' && !settings.showSegments) {
    segCounts.set(tabId, (segCounts.get(tabId) || 0) + 1);
    scheduleSave(tabId);
    return;
  }
  if (settings.minSizeKB > 0 && raw.size > 0 && raw.size < settings.minSizeKB * 1024) return;

  const map = await getTabMap(tabId);
  const prev = map.get(raw.url);
  const item = {
    url: raw.url,
    kind: raw.kind,
    contentType: raw.contentType || '',
    size: raw.size || prev?.size || 0,
    ranges: raw.ranges ?? prev?.ranges ?? false,
    status: raw.status,
    headers: Object.keys(raw.headers || {}).length ? raw.headers : (prev?.headers || {}),
    ts: prev?.ts || Date.now(),
    hits: (prev?.hits || 0) + 1,
    name: fileNameFromUrl(raw.url, raw.kind)
  };
  map.set(raw.url, item);

  if (map.size > MAX_ITEMS) {
    const victim = [...map.keys()].find((k) => k !== raw.url);
    if (victim) map.delete(victim);
  }

  scheduleSave(tabId);
  await refreshBadge(tabId);
}

// ---------------------------------------------------------------- 标签页生命周期
chrome.tabs.onRemoved.addListener((tabId) => {
  tabItems.delete(tabId);
  segCounts.delete(tabId);
  try { chrome.storage.session.remove(keyOf(tabId)); } catch {}
});

chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (!info.url) return;
  await settingsReady;
  if (!settings.autoClean) return;
  const m = tabItems.get(tabId);
  if (!m) return;
  // 同一站点内的跳转保留，跨站才清空
  const oldHosts = new Set([...m.values()].map((i) => { try { return new URL(i.url).host; } catch { return ''; } }));
  let newHost = '';
  try { newHost = new URL(info.url).host; } catch {}
  const sameSite = [...oldHosts].some((h) => {
    if (!h || !newHost) return false;
    const a = h.split('.').slice(-2).join('.');
    const b = newHost.split('.').slice(-2).join('.');
    return a === b;
  });
  if (!sameSite) await clearTab(tabId);
});

// ---------------------------------------------------------------- 右键菜单
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'vg-add-link',
      title: '把链接交给视频下载器',
      contexts: ['link', 'video', 'audio']
    });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'vg-add-link' || !tab?.id) return;
  const url = info.linkUrl || info.srcUrl;
  if (!url) return;
  const kind = classify(url, '') || 'MP4';
  await addItem(tab.id, {
    url, kind, size: 0, status: 0, ranges: false,
    contentType: '', headers: { referer: tab.url || '', ua: settings.userAgent }
  });
  try { await chrome.action.openPopup(); } catch { /* 老版本 Chrome 不支持 */ }
});

// ---------------------------------------------------------------- 消息入口
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg, sender)
    .then((r) => sendResponse({ ok: true, ...r }))
    .catch((e) => sendResponse({ ok: false, error: e?.message || String(e) }));
  return true;
});

async function handle(msg) {
  await settingsReady;
  switch (msg.type) {
    case 'media:list': {
      const map = await getTabMap(msg.tabId);
      const items = [...map.values()].sort((a, b) => b.ts - a.ts);
      return { items, segCount: segCounts.get(msg.tabId) || 0 };
    }
    case 'media:clear':
      await clearTab(msg.tabId);
      return {};
    case 'media:remove': {
      const map = await getTabMap(msg.tabId);
      map.delete(msg.url);
      scheduleSave(msg.tabId);
      await refreshBadge(msg.tabId);
      return {};
    }
    case 'dl:aria2': {
      const s = { ...(await getSettings()), proxy: await resolveProxy() };
      const gids = [];
      const errors = [];
      for (const raw of msg.items) {
        const task = toTask(raw, s);
        if (task.kind === 'HLS' || task.kind === 'DASH') {
          errors.push(`${task.name}: ${task.kind} 不能直接给 aria2，请用 ffmpeg`);
          continue;
        }
        try {
          const opt = aria2Options(s, task, task.name);
          const gid = await aria2Call(s, 'aria2.addUri', [[task.url], opt]);
          gids.push({ gid, url: task.url, name: task.name, kind: task.kind, ts: Date.now() });
        } catch (e) {
          errors.push(`${task.name}: ${e.message}`);
        }
      }
      if (gids.length) {
        const got = await chrome.storage.local.get('jobs');
        const jobs = [...(got.jobs || []), ...gids].slice(-80);
        await chrome.storage.local.set({ jobs });
      }
      return { gids, errors };
    }
    case 'dl:browser': {
      for (const it of msg.items) {
        await chrome.downloads.download({
          url: it.url,
          filename: it.name || undefined,
          saveAs: msg.saveAs === true
        });
      }
      return {};
    }
    case 'dl:txt': {
      const s = await getSettings();
      return { text: aria2InputText(msg.items, s) };
    }
    case 'probe': {
      const s = await getSettings();
      const r = await helperCall(s, '/api/probe', {
        method: 'POST',
        body: JSON.stringify({ url: msg.item.url, headers: msg.item.headers || {}, proxy: await resolveProxy() })
      }, 150000);
      if (r && r.ok === false) {
        const msg = String(r.error || '');
        if (/40[13]/.test(msg) && !s.proxy) {
          throw new Error('直连被拒（403）。这个站多半绑定出口 IP：去「设置 → 网络代理」填 http://127.0.0.1:7897');
        }
        throw new Error(msg || '预览失败');
      }
      if (!r || !r.media) throw new Error('助手没有返回预览数据');
      return { media: r.media };
    }
    case 'hls:parse': {
      const s = await getSettings();
      const item = msg.item;
      let text = '';
      let via = 'direct';
      try {
        const r = await helperCall(s, '/api/parse', {
          method: 'POST',
          body: JSON.stringify({ url: item.url, headers: item.headers || {}, proxy: await resolveProxy() })
        }, 25000);
        text = r.text;
        via = 'helper';
      } catch {
        const res = await fetch(item.url, { cache: 'no-store' });
        if (!res.ok) throw new Error(`拉取播放列表失败 HTTP ${res.status}（可在设置里启动本地助手，它会带上 Referer）`);
        text = await res.text();
      }
      return { result: parsePlaylist(text, item.url), via };
    }
    case 'hls:ffmpeg': {
      const s = await getSettings();
      const out = msg.outPath || `~/Desktop/${(msg.item.name || 'video').replace(/\.[^.]+$/, '')}.mp4`;
      return { command: ffmpegCommandOneLine(msg.item, out, s) };
    }
    case 'aria2:status': {
      const s = await getSettings();
      const list = [];
      const dead = [];
      for (const job of msg.jobs) {
        try {
          const r = await aria2Call(s, 'aria2.tellStatus', [job.gid, [
            'gid', 'status', 'totalLength', 'completedLength', 'downloadSpeed',
            'connections', 'errorMessage', 'files', 'dir'
          ]], 6000);
          list.push({ ...job, ...r });
        } catch {
          dead.push(job.gid);
          list.push({ ...job, status: 'removed', completedLength: 0, totalLength: 0, downloadSpeed: 0 });
        }
      }
      return { list, dead };
    }
    case 'aria2:op': {
      const s = await getSettings();
      const map = { pause: 'aria2.pause', unpause: 'aria2.unpause', remove: 'aria2.remove' };
      const method = map[msg.op];
      if (!method) throw new Error('未知操作');
      await aria2Call(s, method, [msg.gid]);
      return {};
    }
    case 'file:delete': {
      const s = await getSettings();
      const r = await helperCall(s, '/api/file/delete', {
        method: 'POST',
        body: JSON.stringify({ path: msg.path })
      }, 10000);
      if (r && r.ok === false) throw new Error(r.error || '删除失败');
      return { removed: !!r?.removed };
    }
    case 'job:forget': {
      const s = await getSettings();
      try { await aria2Call(s, 'aria2.removeDownloadResult', [msg.gid], 4000); } catch { /* 已经不在列表里也无所谓 */ }
      return {};
    }
    case 'helper:forget': {
      const s = await getSettings();
      try {
        await helperCall(s, `/api/jobs/${encodeURIComponent(msg.id)}/forget`, { method: 'POST' }, 5000);
      } catch { /* 忽略 */ }
      return {};
    }
    case 'helper:health':
      return { data: await helperCall(settings, '/api/health', {}, 5000) };
    case 'helper:submit': {
      const s = await getSettings();
      const body = {
        type: msg.kind === 'HLS' ? 'hls' : 'mp4',
        url: msg.url,
        name: msg.name,
        headers: msg.headers || {},
        outDir: s.outputDir || '',
        proxy: await resolveProxy()
      };
      const r = await helperCall(s, '/api/jobs', { method: 'POST', body: JSON.stringify(body) }, 15000);
      return { job: r };
    }
    case 'helper:jobs':
      return { data: await helperCall(settings, '/api/jobs', {}, 6000) };
    case 'helper:cancel': {
      await helperCall(settings, `/api/jobs/${encodeURIComponent(msg.id)}/cancel`, { method: 'POST' }, 6000);
      return {};
    }
    case 'proxy:detect': {
      proxyCache = { at: 0, value: '', info: null };
      const proxy = await resolveProxy(true);
      return { proxy, info: proxyCache.info || null };
    }
    case 'cfg:get':
      return { settings: await getSettings() };
    case 'cfg:set': {
      settings = { ...DEFAULT_SETTINGS, ...(msg.settings || {}) };
      await chrome.storage.local.set({ settings });
      return { settings };
    }
    case 'diag': {
      const out = { aria2: false, helper: false, helperInfo: null, aria2Info: null };
      try {
        const v = await aria2Call(settings, 'aria2.getVersion', [], 4000);
        out.aria2 = true;
        out.aria2Info = v;
      } catch (e) { out.aria2Error = e.message; }
      try {
        out.helperInfo = await helperCall(settings, '/api/health', {}, 4000);
        out.helper = true;
      } catch (e) { out.helperError = e.message; }
      return out;
    }
    default:
      throw new Error(`未知消息 ${msg.type}`);
  }
}

// 调试钩子：CDP 测试和手动排查用，不影响正常逻辑
globalThis.__vg = {
  snapshot: () => [...tabItems.entries()].map(([tabId, m]) => ({ tabId, items: [...m.values()] })),
  settings: () => settings
};
