// 设置页：读写配置、测试 aria2 / 助手连通性。
import { DEFAULT_SETTINGS } from './common.js';

const FIELDS = [
  'aria2Rpc', 'aria2Secret', 'aria2Conns', 'aria2Split', 'aria2MinSplit', 'aria2Dir',
  'helperUrl', 'outputDir', 'userAgent', 'minSizeKB', 'showSegments', 'autoClean', 'proxy'
];

const $ = (id) => document.getElementById(id);
const send = (type, payload = {}) => chrome.runtime.sendMessage({ type, ...payload });

async function load() {
  const r = await send('cfg:get');
  const s = { ...DEFAULT_SETTINGS, ...(r?.settings || {}) };
  for (const k of FIELDS) {
    const el = $(k);
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = !!s[k];
    else el.value = s[k] ?? '';
  }
  $('aria2Cmd').textContent = aria2Command(s);
  $('helperCmd').textContent = helperCommand();
}

function aria2Command(s) {
  const dir = s.aria2Dir || '$HOME/Downloads/VideoGrab';
  return `aria2c --enable-rpc --rpc-allow-origin-all --rpc-listen-all=false \\\n  --continue=true --max-connection-per-server=16 --split=16 --min-split-size=1M \\\n  --dir="${dir}"`;
}

function helperCommand() {
  return 'node "$HOME/视频下载器/helper/server.mjs"\n# 或者：cd 视频下载器/helper && ./start.sh';
}

function collect() {
  const out = {};
  for (const k of FIELDS) {
    const el = $(k);
    if (!el) continue;
    if (el.type === 'checkbox') out[k] = el.checked;
    else if (el.type === 'number') out[k] = Number(el.value) || 0;
    else out[k] = el.value.trim();
  }
  return out;
}

async function save() {
  const settings = collect();
  const r = await send('cfg:set', { settings });
  const st = $('saveState');
  if (r?.ok) {
    st.textContent = '已保存';
    st.className = 'state ok';
    $('aria2Cmd').textContent = aria2Command(settings);
    setTimeout(() => { st.textContent = ''; }, 1800);
  } else {
    st.textContent = '保存失败：' + (r?.error || '未知错误');
    st.className = 'state err';
  }
}

async function test(kind) {
  const el = kind === 'aria2' ? $('aria2State') : $('helperState');
  el.textContent = '测试中…';
  el.className = 'state';
  const r = await send('diag');
  if (!r?.ok) { el.textContent = '测试失败'; el.className = 'state err'; return; }

  if (kind === 'aria2') {
    if (r.aria2) {
      el.textContent = `已连接 · aria2 ${r.aria2Info?.version || ''}`;
      el.className = 'state ok';
    } else {
      el.textContent = `连不上：${r.aria2Error || '检查 aria2 是否在跑'}`;
      el.className = 'state err';
    }
  } else {
    if (r.helper) {
      const i = r.helperInfo || {};
      el.textContent = `已连接 · ffmpeg ${i.ffmpeg ? '✓' : '✗'} · aria2c ${i.aria2c ? '✓' : '✗'}`;
      el.className = 'state ok';
    } else {
      el.textContent = `连不上：${r.helperError || '助手没启动'}`;
      el.className = 'state err';
    }
  }
}

async function copy(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
  } catch { /* 忽略 */ }
  const old = btn.textContent;
  btn.textContent = '已复制';
  setTimeout(() => { btn.textContent = old; }, 1400);
}

$('save').addEventListener('click', save);
$('reset').addEventListener('click', async () => {
  await send('cfg:set', { settings: DEFAULT_SETTINGS });
  await load();
  $('saveState').textContent = '已恢复默认';
  $('saveState').className = 'state ok';
});
$('testAria2').addEventListener('click', () => test('aria2'));
$('testHelper').addEventListener('click', () => test('helper'));
$('copyAria2Cmd').addEventListener('click', (e) => copy($('aria2Cmd').textContent, e.currentTarget));
$('copyHelperCmd').addEventListener('click', (e) => copy($('helperCmd').textContent, e.currentTarget));

load();
