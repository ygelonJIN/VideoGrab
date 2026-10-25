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
const BATCH_KEY = 'batchHistory';

/**
 * 注入到页面里跑：把 DOM 里的链接全收上来。
 * 列表页往往是懒加载/JS 渲染的，后台直接抓 HTML 是空的，所以必须借页面自己的 DOM。
 * 注意：这个函数会被序列化后注入，不能引用外部变量。
 */
function collectPageLinks() {
  const out = [];
  for (const a of document.querySelectorAll('a[href]')) {
    const raw = a.getAttribute('href');
    if (!raw || /^(?:#|javascript:|mailto:|tel:)/i.test(String(raw).trim())) continue;
    try {
      const u = new URL(raw, location.href);
      if (u.protocol === 'http:' || u.protocol === 'https:') out.push(u.href);
    } catch { /* 畸形链接跳过 */ }
  }
  return [...new Set(out)];
}

function safeName(s, fallback) {
  const t = String(s || '').replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80);
  return t || fallback;
}

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

    // ------------------------------------------------------ 批量抓取
    // 页面里到底有哪些条目，只有跑过 JS 的 DOM 知道（列表常常是懒加载的），
    // 所以这一步必须注入脚本读 DOM，不能靠后台直接抓 HTML。
    case 'batch:scan': {
      const s = await getSettings();
      let links = [];
      try {
        const probe = await chrome.scripting.executeScript({
          target: { tabId: msg.tabId },
          func: collectPageLinks
        });
        links = Array.isArray(probe?.[0]?.result) ? probe[0].result : [];
      } catch (e) {
        throw new Error('读不到这个页面的内容：' + (e?.message || e));
      }
      const scan = await helperCall(s, '/api/scan', {
        method: 'POST',
        body: JSON.stringify({
          url: msg.pageUrl || '',
          links,
          headers: { ua: s.userAgent },
          proxy: await resolveProxy()
        })
      }, 60000);
      return { scan, linkCount: links.length };
    }
    case 'batch:resolve': {
      const s = await getSettings();
      const proxy = await resolveProxy();
      const urls = (msg.urls || []).filter(Boolean).slice(0, 60);
      const items = [];
      // 10 条一批，批间停一下，别把对方站打疼
      for (let i = 0; i < urls.length; i += 10) {
        const chunk = urls.slice(i, i + 10);
        const r = await helperCall(s, '/api/resolve', {
          method: 'POST',
          body: JSON.stringify({ urls: chunk, headers: { ua: s.userAgent }, proxy })
        }, 150000);
        items.push(...(r.items || []));
        if (i + 10 < urls.length) await new Promise((ok) => setTimeout(ok, 800));
      }
      return { items };
    }
    case 'batch:submit': {
      const s = await getSettings();
      const proxy = await resolveProxy();
      const got = await chrome.storage.local.get(BATCH_KEY);
      const history = { ...(got[BATCH_KEY] || {}) };
      const jobs = [];
      const errors = [];
      for (const it of msg.items || []) {
        const m = it.media;
        if (!m?.url) { errors.push(`${it.url}: 没有可下地址`); continue; }
        try {
          const job = await helperCall(s, '/api/jobs', {
            method: 'POST',
            body: JSON.stringify({
              type: 'mp4',
              url: m.url,
              name: safeName(it.name || it.title, fileNameFromUrl(m.url, 'MP4')),
              // 这里直接用探测时验证过的那套头：该带 Referer 的带，该不带的不带
              headers: m.headers || { ua: s.userAgent },
              outDir: s.outputDir || '',
              proxy
            })
          }, 15000);
          jobs.push(job);
          history[it.url] = { name: job.name, jobId: job.id, ts: Date.now() };
        } catch (e) {
          errors.push(`${it.url}: ${e.message}`);
        }
      }
      if (jobs.length) await chrome.storage.local.set({ [BATCH_KEY]: history });
      return { jobs, errors, history };
    }
    case 'batch:history': {
      const got = await chrome.storage.local.get(BATCH_KEY);
      return { history: got[BATCH_KEY] || {} };
    }
    case 'batch:forget': {
      const got = await chrome.storage.local.get(BATCH_KEY);
      const history = { ...(got[BATCH_KEY] || {}) };
      for (const u of msg.urls || []) delete history[u];
      await chrome.storage.local.set({ [BATCH_KEY]: history });
      return { history };
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

      // aria2 只知道"下完了"，不知道文件后来还在不在 —— 问一下助手
      const donePaths = list
        .filter((j) => j.status === 'complete')
        .map((j) => j.files?.[0]?.path)
        .filter(Boolean);
      if (donePaths.length) {
        try {
          const r = await helperCall(s, '/api/files/exists', {
            method: 'POST',
            body: JSON.stringify({ paths: donePaths })
          }, 5000);
          if (r?.exists) {
            for (const j of list) {
              const fp = j.files?.[0]?.path;
              if (fp && Object.prototype.hasOwnProperty.call(r.exists, fp) && r.exists[fp] !== null) {
                j.exists = r.exists[fp];
              }
            }
          }
        } catch { /* 助手不在/太旧：查不了就保持未知，别乱标 */ }
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
    case 'file:reveal': {
      const s = await getSettings();
      const r = await helperCall(s, '/api/file/reveal', {
        method: 'POST',
        body: JSON.stringify({ path: msg.path })
      }, 8000);
      if (r && r.ok === false) throw new Error(r.error || '打开失败');
      return { opened: true };
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
