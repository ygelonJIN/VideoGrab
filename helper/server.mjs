#!/usr/bin/env node
/**
 * 视频下载器 · 本地助手
 * 只监听 127.0.0.1，负责扩展做不了的两件事：
 *   1. M3U8 → ffmpeg 合并成 MP4
 *   2. MP4 → aria2c 多线程下载（没有 aria2 时退回 curl 断点续传）
 * 无任何 npm 依赖，Node 18+ 直接跑。
 */
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { discover, looksGone, pathTemplate } from './extract.mjs';
import { extractAria2Error, describeExit } from './errors.mjs';
import { uniqueName, splitExt } from './naming.mjs';

const PORT = Number(process.env.VG_PORT || 8765);
const HOME = os.homedir();
const DEFAULT_OUT = path.join(HOME, 'Desktop');
const VERSION = '1.1.0';
const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const CONCURRENCY = Number(process.env.VG_CONCURRENCY || 2);
const MAX_JOBS = 60;

// 读 macOS 系统代理设置，再确认端口真的在听
function detectSystemProxy() {
  let host = '', port = 0, enabled = false, source = 'none';
  try {
    const out = spawnSync('scutil', ['--proxy'], { encoding: 'utf8', timeout: 3000 }).stdout || '';
    const pick = (re) => { const m = re.exec(out); return m ? m[1].trim() : ''; };
    if (pick(/HTTPEnable\s*:\s*(\d)/) === '1') {
      host = pick(/HTTPProxy\s*:\s*(\S+)/);
      port = Number(pick(/HTTPPort\s*:\s*(\d+)/));
      if (host && port) { enabled = true; source = 'system-http'; }
    }
    if (!enabled && pick(/HTTPSEnable\s*:\s*(\d)/) === '1') {
      host = pick(/HTTPSProxy\s*:\s*(\S+)/);
      port = Number(pick(/HTTPSPort\s*:\s*(\d+)/));
      if (host && port) { enabled = true; source = 'system-https'; }
    }
  } catch { /* 忽略 */ }

  if (!enabled) return { enabled: false, proxy: '', source };

  const alive = spawnSync('nc', ['-z', '-G', '1', host, String(port)], { timeout: 2500 });
  if (alive.status !== 0) {
    return { enabled: false, proxy: '', source: source + '-dead', note: `系统代理指向 ${host}:${port}，但端口没在听` };
  }
  return { enabled: true, proxy: `http://${host}:${port}`, source };
}

const jobs = new Map();      // id -> job
const queue = [];
let running = 0;

const which = (bin) => {
  const r = spawnSync('which', [bin], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '';
};

const FFMPEG = which('ffmpeg');
const FFPROBE = which('ffprobe');
const ARIA2C = which('aria2c');
const CURL = which('curl');

// ---------------------------------------------------------------- 工具
const now = () => Date.now();

function sanitize(name, fallback) {
  const base = String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
  return (base || fallback).slice(0, 180);
}

function ensureExt(name, ext) {
  return /\.[a-z0-9]{2,5}$/i.test(name) ? name : `${name}.${ext}`;
}

function expandHome(p) {
  if (!p) return '';
  return p.startsWith('~') ? path.join(HOME, p.slice(1)) : p;
}

function headerEntries(headers = {}) {
  const out = [];
  if (headers.ua) out.push(['User-Agent', headers.ua]);
  if (headers.referer) out.push(['Referer', headers.referer]);
  if (headers.origin) out.push(['Origin', headers.origin]);
  if (headers.cookie) out.push(['Cookie', headers.cookie]);
  return out;
}

function fetchHeaders(headers = {}) {
  const h = {};
  for (const [k, v] of headerEntries(headers)) h[k] = v;
  return h;
}

async function probeLength(url, headers) {
  const opts = { headers: fetchHeaders(headers), redirect: 'follow' };
  try {
    const r = await fetch(url, { ...opts, method: 'HEAD' });
    const n = Number(r.headers.get('content-length'));
    if (Number.isFinite(n) && n > 0) return n;
  } catch { /* 继续试 Range */ }
  try {
    const r = await fetch(url, { ...opts, headers: { ...opts.headers, Range: 'bytes=0-0' } });
    const cr = r.headers.get('content-range') || '';
    const m = cr.match(/\/(\d+)\s*$/);
    if (m) return Number(m[1]);
    const n = Number(r.headers.get('content-length'));
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

function pushLog(job, chunk) {
  const text = String(chunk);
  job.logTail = (job.logTail + text).slice(-4000);
  const lines = text.split(/[\r\n]+/).filter(Boolean);
  if (lines.length) job.lastLine = lines[lines.length - 1].slice(0, 300);
}

// ffmpeg stderr：Duration 与 time= 换算进度
function trackFfmpeg(job, chunk) {
  const s = String(chunk);
  pushLog(job, s);
  const dur = s.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (dur) {
    job.duration = (+dur[1]) * 3600 + (+dur[2]) * 60 + parseFloat(dur[3]);
  }
  const t = [...s.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)].pop();
  if (t) {
    const cur = (+t[1]) * 3600 + (+t[2]) * 60 + parseFloat(t[3]);
    job.position = cur;
    if (job.duration > 0) job.progress = Math.min(99.5, (cur / job.duration) * 100);
  }
}

async function fileSize(p) {
  try { return (await fsp.stat(p)).size; } catch { return 0; }
}

// 按输出文件大小估算进度（curl 用；aria2 不是这样写的，见 trackAria2）
function watchOutput(job) {
  let probing = false;
  const timer = setInterval(async () => {
    if (job.status !== 'running') return;
    // aria2 最近 5 秒报过进度就别跟它抢：它会把整段缓存在内存里，最后才落盘，
    // 这期间文件一直是 0 字节，按文件算永远 0%。
    if (job._aria2At && Date.now() - job._aria2At < 5000) return;
    const size = await fileSize(job.out);
    if (size <= 0) return;
    job.speed = Math.max(0, (size - (job._lastSize || 0)) / 0.9);
    job._lastSize = size;
    job.received = Math.max(job.received || 0, size);
    if (!job.total && !probing) {
      probing = true;
      const n = await probeLength(job.url, job.headers);
      if (n) job.total = n;
      probing = false;
    }
    if (job.total > 0) {
      job.progress = Math.max(job.progress, Math.min(99.5, (size / job.total) * 100));
    }
  }, 900);
  return () => clearInterval(timer);
}

const SIZE_UNIT = {
  B: 1, KB: 1000, MB: 1e6, GB: 1e9, TB: 1e12,
  KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, TiB: 1024 ** 4
};

function toBytes(n, unit) {
  return Math.round(Number(n) * (SIZE_UNIT[unit] || 1));
}

/**
 * 从 aria2 的输出里读进度。它自己会打这样的行：
 *   [#gid 11MiB/12MiB(88%) CN:10 DL:129KiB ETA:12s]
 * 这才是唯一可信的进度来源 —— 文件大小在下载结束前一直是 0。
 */
function trackAria2(job, chunk) {
  pushLog(job, chunk);
  const text = String(chunk);
  let last = null;
  for (const m of text.matchAll(/\[#[0-9a-z]+\s+([\d.]+)([A-Za-z]{1,3})\/([\d.]+)([A-Za-z]{1,3})\((\d+)%\)([^\n]*)/g)) {
    last = m;
  }
  if (!last) return;

  const recv = toBytes(last[1], last[2]);
  const total = toBytes(last[3], last[4]);
  const pct = Number(last[5]) || 0;
  const dl = last[6].match(/DL:([\d.]+)([A-Za-z]{1,3})/);

  job.received = recv;
  if (total > 0) job.total = total;
  job.speed = dl ? toBytes(dl[1], dl[2]) : 0;
  job._aria2At = Date.now();
  job.progress = Math.min(99.5, pct);
  if (recv > (job._lastRecv || 0)) {
    job._lastRecv = recv;
    job._recvAt = Date.now();
  }
}


// ---------------------------------------------------------------- 进程与参数工具
function proxyEnv(proxy) {
  if (!proxy) return process.env;
  return {
    ...process.env,
    http_proxy: proxy, https_proxy: proxy,
    HTTP_PROXY: proxy, HTTPS_PROXY: proxy,
    all_proxy: proxy, ALL_PROXY: proxy
  };
}

function runCapture(bin, args, timeoutMs = 25000, proxy = '') {
  return new Promise((resolve) => {
    const chunks = [];
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], env: proxyEnv(proxy) });
    let err = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, timeoutMs);
    child.stdout.on('data', (d) => chunks.push(d));
    child.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out: Buffer.concat(chunks), err }); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out: Buffer.alloc(0), err: e.message }); });
  });
}

const lastLine = (s) => String(s || '').split('\n').map((x) => x.trim()).filter(Boolean).slice(-1)[0] || '';

function whitelist(proxy) {
  // 走代理时 ffmpeg 用 httpproxy 这个独立协议，不在白名单里会报 Invalid argument
  return 'file,http,https,tcp,tls,crypto' + (proxy ? ',httpproxy' : '');
}

function inputOpts(headers = {}, hls = false, proxy = '') {
  const args = [];
  const hdr = headerEntries(headers).filter(([k]) => k !== 'User-Agent')
    .map(([k, v]) => `${k}: ${v}`).join('\r\n');
  if (hdr) args.push('-headers', hdr + '\r\n');
  if (headers.ua) args.push('-user_agent', headers.ua);
  args.push('-protocol_whitelist', whitelist(proxy));
  if (hls) args.push('-allowed_extensions', 'ALL', '-allowed_segment_extensions', 'ALL', '-extension_picky', '0');
  args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5');
  return args;
}

function parseMeta(raw) {
  const meta = { duration: 0, width: 0, height: 0, bitrate: 0, videoCodec: '', audioCodec: '' };
  try {
    const j = JSON.parse(raw.toString('utf8'));
    const v = (j.streams || []).find((s) => s.codec_type === 'video');
    const a = (j.streams || []).find((s) => s.codec_type === 'audio');
    meta.duration = Math.round(Number(j.format?.duration) || 0);
    meta.width = v?.width || 0;
    meta.height = v?.height || 0;
    meta.bitrate = Number(j.format?.bit_rate) || 0;
    meta.videoCodec = v?.codec_name || '';
    meta.audioCodec = a?.codec_name || '';
  } catch { /* 忽略 */ }
  return meta;
}

// ---------------------------------------------------------------- 元信息（读文件头，不走 ffmpeg）
const metaCache = new Map();      // key -> {at, data}
const META_TTL = 10 * 60 * 1000;

// 用 curl 取一段字节：能带 Referer/Cookie，也能走代理
const HDR_SENTINEL = '__VG_HDR__';

async function curlRange(url, headers, proxy, start, end, timeoutMs = 20000) {
  const args = ['-sS', '-f', '--max-time', String(Math.round(timeoutMs / 1000)), '-r', `${start}-${end}`];
  if (proxy) args.push('-x', proxy);
  // 不带浏览器 UA 时 curl 会自报 curl/x.y，不少 CDN 直接 403 —— 这里统一兜底
  const hdr = { ...headers, ua: headers?.ua || DEFAULT_UA };
  for (const [k, v] of headerEntries(hdr)) args.push('-H', `${k}: ${v}`);
  args.push('-w', HDR_SENTINEL + '%{header_json}');
  args.push(url);
  const res = await runCapture(CURL || 'curl', args, timeoutMs + 2000);
  const raw = res.out;
  const idx = raw.lastIndexOf(HDR_SENTINEL);
  let body = raw;
  let hdrs = {};
  if (idx > 0) {
    body = raw.subarray(0, idx);
    try { hdrs = JSON.parse(raw.subarray(idx + HDR_SENTINEL.length).toString('utf8')); } catch {}
  }
  return { code: res.code, out: body, err: res.err, headers: hdrs };
}

function boxWalk(buf, start, end, visit, depth = 0) {
  let off = start;
  let guard = 0;
  while (off + 8 <= end && guard++ < 500) {
    let size = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    let hdr = 8;
    if (size === 1) {                       // 64 位长度
      if (off + 16 > end) return;
      size = Number(buf.readBigUInt64BE(off + 8));
      hdr = 16;
    } else if (size === 0) {                // 一直到文件尾
      size = end - off;
    }
    if (size < hdr) return;
    // box 可能比我们抓到的这段还长（moov 常常好几 MB），先按可见部分处理
    const visibleEnd = Math.min(off + size, end);
    visit(type, off, visibleEnd, hdr);
    if (depth < 6 && ['moov', 'trak', 'mdia', 'minf', 'stbl'].includes(type)) {
      boxWalk(buf, off + hdr, visibleEnd, visit, depth + 1);
    }
    if (off + size > end) return;
    off += size;
  }
}

function parseMp4Head(buf) {
  const out = { duration: 0, width: 0, height: 0, videoCodec: '', audioCodec: '', brand: '' };
  let found = false;

  boxWalk(buf, 0, buf.length, (type, start, end, hdr) => {
    const p = start + hdr;
    if (type === 'ftyp' && !out.brand) {
      out.brand = buf.toString('latin1', p, Math.min(p + 4, end));
    } else if (type === 'mvhd') {
      const ver = buf[p];
      if (ver === 1) {
        const timescale = buf.readUInt32BE(p + 20);
        const duration = Number(buf.readBigUInt64BE(p + 24));
        if (timescale) out.duration = Math.round(duration / timescale);
      } else {
        const timescale = buf.readUInt32BE(p + 12);
        const duration = buf.readUInt32BE(p + 16);
        if (timescale) out.duration = Math.round(duration / timescale);
      }
      found = true;
    } else if (type === 'tkhd') {
      const ver = buf[p];
      const wOff = ver === 1 ? p + 88 : p + 76;
      if (wOff + 8 <= end) {
        const w = Math.round(buf.readUInt32BE(wOff) / 65536);
        const h = Math.round(buf.readUInt32BE(wOff + 4) / 65536);
        if (w > 0 && h > 0 && (!out.width || w > out.width)) { out.width = w; out.height = h; }
      }
    } else if (type === 'stsd') {
      const n = buf.readUInt32BE(p + 4);
      if (n > 0 && p + 16 <= end) {
        const fourcc = buf.toString('latin1', p + 12, p + 16);
        const kind = fourcc.startsWith('avc') || fourcc.startsWith('hvc') || fourcc.startsWith('hev')
          || fourcc.startsWith('vp') || fourcc === 'av01' ? 'video' : 'audio';
        if (kind === 'video' && !out.videoCodec) out.videoCodec = fourcc;
        else if (kind === 'audio' && !out.audioCodec) out.audioCodec = fourcc;
      }
    }
  });

  return found ? out : null;
}

async function probeMeta(url, headers, proxy) {
  const key = url + '|' + (headers.referer || '') + '|' + (proxy || '');
  const hit = metaCache.get(key);
  if (hit && Date.now() - hit.at < META_TTL) return hit.data;

  const SIZE = 262144;   // 先取 256KB，绝大多数 faststart 文件的 moov 都在里面
  const r1 = await curlRange(url, headers, proxy, 0, SIZE - 1);
  if (r1.code !== 0) {
    throw new Error(lastLine(r1.err) || '读取文件头失败（403 或链接过期）');
  }

  let size = r1.out.length;
  const cr = (r1.headers?.['content-range'] || [])[0] || '';
  const m = cr.match(/\/(\d+)\s*$/);
  if (m) size = Number(m[1]);

  let parsed = null;
  try { parsed = parseMp4Head(r1.out); } catch { parsed = null; }

  // moov 不在开头：再取尾部 512KB 找一次
  if (!parsed && size > SIZE) {
    const r2 = await curlRange(url, headers, proxy, Math.max(0, size - 524288), size - 1);
    if (r2.code === 0) {
      try { parsed = parseMp4Head(r2.out); } catch { parsed = null; }
    }
  }

  if (!parsed) throw new Error('不是 MP4，或者索引读不出来（可以改用「复制 ffmpeg 命令」）');

  const data = { ...parsed, size, source: 'mp4-head', thumbnail: '' };
  metaCache.set(key, { at: Date.now(), data });
  if (metaCache.size > 60) {
    const oldest = [...metaCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) metaCache.delete(oldest[0]);
  }
  return data;
}

// 旧接口保留：HLS 或解析失败时才退回 ffprobe（慢，但兜底）
async function probeWithFfprobe(url, headers, hls, proxy) {
  const opts = inputOpts(headers, hls, proxy);
  const p = await runCapture('ffprobe', [
    '-v', 'error', '-probesize', '65536', '-analyzeduration', '0',
    '-print_format', 'json', '-show_format', '-show_streams', ...opts, '-i', url
  ], 90000, proxy);
  if (p.code !== 0) throw new Error(lastLine(p.err) || 'ffprobe 打不开这个地址');
  return { ...parseMeta(p.out), thumbnail: '', source: 'ffprobe' };
}

// ---------------------------------------------------------------- 参数拼装
function ffmpegArgs(job) {
  const { url, type, out, headers } = job;
  const hdr = headerEntries(headers).filter(([k]) => k !== 'User-Agent')
    .map(([k, v]) => `${k}: ${v}`).join('\r\n');
  const args = ['-hide_banner', '-nostdin', '-y'];
  if (hdr) args.push('-headers', hdr + '\r\n');
  if (headers.ua) args.push('-user_agent', headers.ua);
  if (type === 'hls') {
    args.push(
      '-protocol_whitelist', whitelist(job.proxy),
      '-allowed_extensions', 'ALL',
      '-allowed_segment_extensions', 'ALL',
      '-extension_picky', '0'
    );
  }
  if (process.env.VG_FASTSTART === '1') args.push('-movflags', '+faststart');
  args.push('-i', url, '-c', 'copy', out);
  return args;
}

function aria2Args(job, total) {
  const { url, out, headers } = job;
  const dir = path.dirname(out);
  const args = [
    '-x', '16', '-s', '16', '-k', '1M',
    '--continue=true', '--file-allocation=none',
    '--auto-file-renaming=false', '--allow-overwrite=false',
    '--retry-wait=3', '--max-tries=0',
    '--console-log-level=warn', '--summary-interval=1',
    '--dir', dir, '--out', path.basename(out)
  ];
  for (const [k, v] of headerEntries(headers)) args.push(`--header=${k}: ${v}`);
  if (job.proxy) args.push(`--all-proxy=${job.proxy}`);
  args.push(url);
  return args;
}

// ---------------------------------------------------------------- 执行
function startJob(job) {
  job.status = 'running';
  const proxy = job.proxy || '';
  job.startedAt = now();
  job.progress = 0;

  let cmd;
  let args;
  let tracker;

  if (job.type === 'hls') {
    if (!FFMPEG) return fail(job, '找不到 ffmpeg，先 brew install ffmpeg');
    cmd = FFMPEG;
    args = ffmpegArgs(job);
    tracker = (chunk) => trackFfmpeg(job, chunk);
  } else if (ARIA2C) {
    cmd = ARIA2C;
    args = aria2Args(job, job.total);
    tracker = (chunk) => trackAria2(job, chunk);
  } else if (CURL) {
    cmd = CURL;
    args = ['-f', '-L', '-C', '-', '-o', job.out];
    if (job.proxy) args.push('-x', job.proxy);
    for (const [k, v] of headerEntries(headersOf(job))) args.push('-H', `${k}: ${v}`);
    args.push(job.url);
    tracker = (chunk) => pushLog(job, chunk);
  } else {
    return fail(job, '系统里没有 curl，无法下载');
  }

  job.cmd = [cmd, ...args].join(' ');
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: proxyEnv(proxy) });
  job.child = child;

  const stopWatch = job.type === 'hls' ? () => {} : watchOutput(job);
  if (job.type !== 'hls') {
    probeLength(job.url, job.headers).then((n) => { if (n && !job.total) job.total = n; }).catch(() => {});
  }

  // 卡死保护：一个任务长期一点数据都没收到，就别让它占着并发位把整队堵住
  const stallTimer = setInterval(() => {
    if (job.status !== 'running') return;
    const idleSince = job._recvAt || job.startedAt || job.createdAt;
    if ((job.received || 0) === 0 && Date.now() - idleSince > 5 * 60 * 1000) {
      clearInterval(stallTimer);
      try { child.kill('SIGKILL'); } catch {}
      fail(job, '5 分钟没收到任何数据：多半是直链过期或被限速，回批量页重新解析再下');
    }
  }, 30000);

  child.stderr.on('data', (d) => tracker(d));
  child.stdout.on('data', (d) => tracker(d));

  child.on('error', (e) => {
    if (job._settled) return;
    job._settled = true;
    clearInterval(stallTimer);
    stopWatch();
    fail(job, e.message);
  });

  child.on('close', (code, signal) => {
    if (job._settled) return;
    job._settled = true;
    clearInterval(stallTimer);
    stopWatch();
    job.child = null;
    if (job.status === 'canceled') return finish();
    if (code === 0) {
      job.status = 'done';
      job.progress = 100;
      job.speed = 0;
      job.endedAt = now();
      job.received = job.total || job.received;
      finish();
    } else {
      job.status = 'error';
      job.endedAt = now();
      // aria2 只留页脚没用，要从日志里挖出 errorCode / status
      job.error = job.type === 'hls'
        ? (job.lastLine || describeExit(code, signal))
        : (extractAria2Error(job.logTail) || describeExit(code, signal));
      finish();
    }
  });

  function finish() {
    running = Math.max(0, running - 1);
    pump();
  }
}

function headersOf(job) { return job.headers || {}; }

function fail(job, msg) {
  if (job._settled && job.status === 'error') return;
  job._settled = true;
  job.status = 'error';
  job.error = msg;
  job.endedAt = now();
  running = Math.max(0, running - 1);
  pump();
}

function pump() {
  while (running < CONCURRENCY && queue.length) {
    const job = queue.shift();
    if (job.status !== 'queued') continue;
    running++;
    startJob(job);
  }
}

function createJob(input) {
  const type = input.type === 'hls' ? 'hls' : 'mp4';
  const ext = type === 'hls' ? 'mp4' : (input.ext || 'mp4');
  const dir = expandHome(input.outDir) || DEFAULT_OUT;
  fs.mkdirSync(dir, { recursive: true });
  const base = sanitize(input.name, `video-${now()}`);
  const wanted = type === 'hls'
    ? base.replace(/\.[a-z0-9]{2,5}$/i, '') + '.mp4'
    : ensureExt(base, ext);

  // 同名冲突就换名字，别让两个任务抢同一个文件（抢的结果是后到的把先到的覆盖掉）
  const [stem, suffix] = splitExt(wanted);
  const taken = (nm) => {
    const target = path.join(dir, nm);
    // 已经在队列里、还没落盘的任务也算占用（同一秒创建时磁盘上还是空的）
    const owner = [...jobs.values()].find((j) => j.out === target);
    if (owner) return owner.url !== input.url;      // 同一个源地址重下 = 续传，放行
    let st = null;
    try { st = fs.statSync(target); } catch { return false; }
    if (fs.existsSync(target + '.aria2')) return false;   // 有控制文件，可以续传
    if (st.size === 0) return false;                      // 0 字节残骸，下面会删掉
    return true;                                          // 别人的成品，换名保护
  };
  const name = uniqueName(stem, suffix, taken);
  const out = path.join(dir, name);

  // 上次失败的残骸：0 字节的成品 + 没有 .aria2 控制文件。
  // 留着它，aria2 会直接报 errorCode=13「文件已存在」，重下永远卡在这一步。
  try {
    if (fs.existsSync(out) && fs.statSync(out).size === 0 && !fs.existsSync(out + '.aria2')) {
      fs.unlinkSync(out);
    }
  } catch { /* 删不掉就交给 aria2 报错 */ }

  const job = {
    id: randomUUID().slice(0, 8),
    type,
    url: input.url,
    name,
    out,
    headers: input.headers || {},
    proxy: input.proxy || '',
    status: 'queued',
    progress: 0,
    speed: 0,
    received: 0,
    total: 0,
    duration: 0,
    position: 0,
    createdAt: now(),
    logTail: '',
    lastLine: ''
  };

  jobs.set(job.id, job);
  if (jobs.size > MAX_JOBS) {
    for (const [id, j] of jobs) {
      if (j.status === 'done' || j.status === 'error' || j.status === 'canceled') { jobs.delete(id); break; }
    }
  }
  queue.push(job);
  pump();
  return job;
}

function publicJob(j) {
  const o = {
    id: j.id, type: j.type, name: j.name, out: j.out, url: j.url,
    status: j.status, progress: Math.round(j.progress * 10) / 10,
    speed: Math.round(j.speed || 0), received: j.received, total: j.total,
    duration: j.duration, position: j.position,
    error: j.error || '', createdAt: j.createdAt, endedAt: j.endedAt || 0
  };
  // 结束了的任务顺手看一眼文件还在不在：本地删了就别再显示"已完成"
  if (j.status === 'done' || j.status === 'error' || j.status === 'canceled') {
    try { o.exists = fs.existsSync(j.out); } catch { o.exists = false; }
  }
  return o;
}

// ---------------------------------------------------------------- 通用抓取
// 页面一律走 curl：能带 Referer/Cookie、能走代理、能跟 302（播放器经常先跳一次域名）
const PAGE_MARK = '__VG_PAGE__';
const PAGE_MAX = 4 * 1024 * 1024;

async function fetchPage(url, headers = {}, proxy = '', timeoutMs = 20000) {
  const args = ['-sS', '-L', '--compressed', '--max-time', String(Math.round(timeoutMs / 1000))];
  if (proxy) args.push('-x', proxy);
  args.push('-A', headers.ua || DEFAULT_UA);
  for (const [k, v] of headerEntries(headers)) {
    if (k !== 'User-Agent' && v) args.push('-H', `${k}: ${v}`);
  }
  args.push('-w', '\n' + PAGE_MARK + '%{http_code} %{url_effective}');
  args.push(url);

  const res = await runCapture(CURL || 'curl', args, timeoutMs + 3000);
  const raw = res.out;
  const idx = raw.lastIndexOf(PAGE_MARK);
  let body = raw;
  let status = 0;
  let finalUrl = url;
  if (idx >= 0) {
    body = raw.subarray(0, idx);
    const tail = raw.subarray(idx + PAGE_MARK.length).toString('utf8').trim();
    const m = tail.match(/^(\d{3})\s+(.*)$/);
    if (m) { status = Number(m[1]); finalUrl = m[2].trim() || url; }
  }
  return {
    ok: res.code === 0,
    status,
    finalUrl,
    html: body.subarray(0, PAGE_MAX).toString('utf8'),
    err: res.err
  };
}

const firstHeader = (v) => (Array.isArray(v) ? v[0] : v) || '';

/**
 * 探一条直链能不能下。带 Referer 和不带各试一次：
 * 有的站防盗链，没 Referer 403；有的站反过来，带 Referer 就 403。
 * 哪种能过就用哪种，顺便把能用的 headers 一起返回，下载端照抄即可。
 */
async function probeMedia(url, headers = {}, proxy = '') {
  const headers0 = { ...headers, ua: headers.ua || DEFAULT_UA };
  const hasReferer = Boolean(headers0.referer);
  const attempts = hasReferer
    ? [{ mode: 'with-referer', h: headers0 }, { mode: 'no-referer', h: { ...headers0, referer: '' } }]
    : [{ mode: 'no-referer', h: headers0 }];

  let lastError = '';
  for (const a of attempts) {
    const r = await curlRange(url, a.h, proxy, 0, 0, 15000);
    if (r.code !== 0) { lastError = lastLine(r.err) || `curl ${r.code}`; continue; }
    const ct = firstHeader(r.headers['content-type']).toLowerCase();
    const cr = firstHeader(r.headers['content-range']);
    const size =
      Number((cr.match(/\/(\d+)\s*$/) || [])[1] || 0) ||
      Number(firstHeader(r.headers['content-length']) || 0) ||
      0;
    const isMedia =
      /^(?:video|audio)\//.test(ct) ||
      /mpegurl|dash\+xml/.test(ct) ||
      (ct.includes('octet-stream') && /\.(?:mp4|m4v|mov|webm|mkv|m3u8|mpd|ts|flv)$/i.test(url.split('?')[0]));
    if (isMedia) {
      const clean = { ...a.h };
      if (a.mode === 'no-referer') clean.referer = '';
      return { ok: true, mode: a.mode, headers: clean, size, contentType: ct };
    }
  }
  return { ok: false, error: lastError || '不是媒体响应' };
}

const resolveCache = new Map();      // url -> {at, result}
const RESOLVE_TTL = 5 * 60 * 1000;

/** 抓一个详情页，拿到能直接下的一条媒体；拿不到就再钻一层播放器 iframe */
async function resolveOne(url, headers = {}, proxy = '', depth = 0) {
  const cached = resolveCache.get(url);
  if (cached && Date.now() - cached.at < RESOLVE_TTL) return { ...cached.result, cached: true };

  const page = await fetchPage(url, headers, proxy);
  const found = discover(page.html, page.finalUrl || url);
  const base = { page: { status: page.status, url: page.finalUrl }, title: found.title };

  if (looksGone(page.html, page.status)) {
    const r = { ok: false, gone: true, ...base, reason: page.status === 404 || page.status === 410 ? `HTTP ${page.status}` : '页面提示内容已删除' };
    resolveCache.set(url, { at: Date.now(), result: r });
    return r;
  }

  for (const m of found.media.slice(0, 4)) {
    const probe = await probeMedia(m.url, headers, proxy);
    if (probe.ok) {
      const r = {
        ok: true, gone: false, ...base,
        media: { url: m.url, kind: m.kind, size: probe.size, contentType: probe.contentType, headers: probe.headers, headerMode: probe.mode },
        candidates: found.media.length
      };
      resolveCache.set(url, { at: Date.now(), result: r });
      return r;
    }
  }

  if (depth < 1 && found.embeds.length) {
    // 播放器基本都排在最前面，试前 3 个就够
    const tried = [];
    for (const e of found.embeds.slice(0, 3)) {
      const r = await resolveOne(e.url, { ...headers, referer: url }, proxy, depth + 1);
      if (r.ok) {
        const out = { ...r, ...base, via: e.url };
        resolveCache.set(url, { at: Date.now(), result: out });
        return out;
      }
      tried.push(r);
    }
    if (tried.length) {
      let host = '';
      try { host = new URL(tried[0]?.page?.url || '').host; } catch {}
      const gone = tried.some((x) => x.gone);
      const first = tried.find((x) => x.reason) || {};
      const r = {
        ok: false,
        gone,
        unavailable: !gone,          // 页面还在，但里面没有可播的东西
        ...base,
        reason: `播放器${host ? '（' + host + '）' : ''}：${first.reason || '没解出可下地址'}`,
        steps: tried.map((x) => ({ url: x.page?.url || '', status: x.page?.status || 0, gone: !!x.gone, reason: x.reason || '' }))
      };
      resolveCache.set(url, { at: Date.now(), result: r });
      return r;
    }
  }

  const r = { ok: false, gone: false, unavailable: false, ...base, reason: '页面里没找到能下的地址（可能是纯 JS 播放或加密流）' };
  resolveCache.set(url, { at: Date.now(), result: r });
  return r;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

// ---------------------------------------------------------------- HTTP
// 只允许删这几个目录里的文件，防止被网页调去删别的东西
const DELETE_ROOTS = [
  DEFAULT_OUT,
  path.join(HOME, 'Downloads'),
  path.join(HOME, 'Movies')
].map((x) => path.resolve(x));

function safeDeletePath(input, what = '删除') {
  const abs = path.resolve(expandHome(input));
  const ok = DELETE_ROOTS.some((root) => abs === root || abs.startsWith(root + path.sep));
  if (!ok) throw new Error(`只允许${what}下载目录里的文件`);
  if (!/\.[a-z0-9]{2,5}$/i.test(abs)) throw new Error('不是普通文件');
  return abs;
}

// 有 Origin 但不是扩展发来的，一律拒（浏览器会给网页带上自己的 Origin，伪造不了）
function originAllowed(req) {
  const o = req.headers.origin;
  if (!o) return true;                       // curl / 本地脚本
  return o.startsWith('chrome-extension://');
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400'
};

function json(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(s) });
  res.end(s);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 2 * 1024 * 1024) throw new Error('请求体过大');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = url.pathname;

  try {
    if (!originAllowed(req)) return json(res, 403, { error: 'forbidden origin' });

    if (p === '/api/health' && req.method === 'GET') {
      return json(res, 200, {
        ok: true, version: VERSION, home: HOME, defaultOut: DEFAULT_OUT,
        ffmpeg: Boolean(FFMPEG), ffmpegPath: FFMPEG, ffprobe: Boolean(FFPROBE),
        aria2c: Boolean(ARIA2C), aria2cPath: ARIA2C,
        curl: Boolean(CURL), concurrency: CONCURRENCY
      });
    }

    if (p === '/api/proxy' && req.method === 'GET') {
      return json(res, 200, detectSystemProxy());
    }

    if (p === '/api/parse' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.url) return json(res, 400, { error: '缺 url' });
      const r = await fetch(body.url, {
        headers: fetchHeaders(body.headers),
        redirect: 'follow'
      });
      const text = await r.text();
      return json(res, 200, { status: r.status, text: text.slice(0, 4 * 1024 * 1024) });
    }

    if (p === '/api/scan' && req.method === 'POST') {
      const body = await readBody(req);
      const proxy = body.proxy || '';
      const headers = body.headers || {};
      const domLinks = Array.isArray(body.links)
        ? [...new Set(body.links.filter((x) => /^https?:/i.test(String(x))))]
        : [];

      let page = null;
      let found = { title: '', media: [], embeds: [], links: [], listing: [] };
      if (body.url) {
        page = await fetchPage(body.url, headers, proxy);
        found = discover(page.html, page.finalUrl || body.url);
      }

      // 扩展从 DOM 抠出来的链接优先：JS 渲染的列表页，HTML 里本来就是空的
      let listing = found.listing;
      let source = listing.length ? 'html' : '';
      if (domLinks.length) {
        const groups = new Map();
        for (const u of domLinks) {
          const t = pathTemplate(u);
          if (!groups.has(t)) groups.set(t, []);
          groups.get(t).push(u);
        }
        listing = [...groups.entries()]
          .map(([template, urls]) => ({
            template, count: urls.length,
            items: urls.map((u) => ({ url: u, label: '' }))
          }))
          .sort((a, b) => b.count - a.count);
        source = 'dom';
      }

      return json(res, 200, {
        ok: true,
        source,
        title: found.title,
        page: page ? { status: page.status, url: page.finalUrl } : null,
        media: found.media.slice(0, 12),
        listing: listing.slice(0, 30),
        total: listing.reduce((n, g) => n + g.count, 0)
      });
    }

    if (p === '/api/resolve' && req.method === 'POST') {
      const body = await readBody(req);
      const proxy = body.proxy || '';
      const headers = body.headers || {};
      const urls = Array.isArray(body.urls) ? body.urls.filter(Boolean) : (body.url ? [body.url] : []);
      if (!urls.length) return json(res, 400, { error: '缺 url' });
      if (urls.length > 20) return json(res, 400, { error: '一次最多 20 条，分批来' });

      const out = await mapLimit(urls, 3, async (u) => {
        try {
          return { url: u, ...(await resolveOne(u, headers, proxy, 0)) };
        } catch (e) {
          return { url: u, ok: false, gone: false, reason: e?.message || String(e) };
        }
      });

      const summary = {
        ok: out.filter((x) => x.ok).length,
        gone: out.filter((x) => x.gone).length,
        unavailable: out.filter((x) => x.unavailable).length,
        failed: out.filter((x) => !x.ok && !x.gone && !x.unavailable).length
      };
      if (!Array.isArray(body.urls)) return json(res, 200, { ...out[0], summary });
      return json(res, 200, { items: out, summary });
    }

    if (p === '/api/probe' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.url) return json(res, 400, { error: '缺 url' });
      const url = body.url;
      const headers = body.headers || {};
      const proxy = body.proxy || '';
      const isHls = /\.m3u8?(\?|$)/i.test(url) || body.kind === 'HLS';

      // HLS 不抓帧：时长/分片由前端解析播放列表拿到，这里不联网
      if (isHls) {
        return json(res, 200, {
          ok: true,
          media: { duration: 0, width: 0, height: 0, videoCodec: '', audioCodec: '', thumbnail: '', hls: true }
        });
      }

      try {
        const media = await probeMeta(url, headers, proxy);
        return json(res, 200, { ok: true, media });
      } catch (e) {
        try {
          const media = await probeWithFfprobe(url, headers, false, proxy);
          return json(res, 200, { ok: true, media });
        } catch (e2) {
          return json(res, 200, { ok: false, error: e2.message || e.message });
        }
      }
    }

    if (p === '/api/jobs' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.url) return json(res, 400, { error: '缺 url' });
      const job = createJob(body);
      return json(res, 200, publicJob(job));
    }

    if (p === '/api/jobs' && req.method === 'GET') {
      const list = [...jobs.values()].map(publicJob)
        .sort((a, b) => b.createdAt - a.createdAt);
      return json(res, 200, { jobs: list, running, queued: queue.length });
    }

    if (p === '/api/file/delete' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.path) return json(res, 400, { error: '缺 path' });
      try {
        const abs = safeDeletePath(body.path);
        let removed = false;
        for (const target of [abs, abs + '.aria2']) {
          try { await fsp.unlink(target); removed = true; } catch (e) { if (e.code !== 'ENOENT') throw e; }
        }
        return json(res, 200, { ok: true, removed, path: abs });
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }

    if (p === '/api/files/exists' && req.method === 'POST') {
      const body = await readBody(req);
      const list = Array.isArray(body.paths) ? body.paths.slice(0, 50) : [];
      const exists = {};
      for (const raw of list) {
        if (typeof raw !== 'string' || !raw) continue;
        const abs = path.resolve(expandHome(raw));
        // 只回答 home 和外接盘里的路径，别把它变成全盘探测工具
        const allowed = abs.startsWith(HOME + path.sep) || abs.startsWith('/Volumes/');
        if (!allowed) { exists[raw] = null; continue; }
        try { exists[raw] = fs.existsSync(abs) && fs.statSync(abs).isFile(); }
        catch { exists[raw] = false; }
      }
      return json(res, 200, { ok: true, exists });
    }

    if (p === '/api/file/reveal' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.path) return json(res, 400, { error: '缺 path' });
      try {
        const abs = safeDeletePath(body.path, '打开');   // 和删除共用同一套白名单
        if (!fs.existsSync(abs)) return json(res, 404, { error: '文件已经不在了' });
        spawn('open', ['-R', abs], { detached: true, stdio: 'ignore' }).unref();
        return json(res, 200, { ok: true, path: abs });
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }

    const m = p.match(/^\/api\/jobs\/([\w-]+)(\/cancel|\/log|\/forget)?$/);
    if (m) {
      const job = jobs.get(m[1]);
      if (!job) return json(res, 404, { error: '任务不存在' });
      if (m[2] === '/cancel' && req.method === 'POST') {
        job.status = 'canceled';
        job.error = '已取消';
        job.endedAt = now();
        if (job.child) { try { job.child.kill('SIGTERM'); } catch {} }
        return json(res, 200, publicJob(job));
      }
      if (m[2] === '/forget' && req.method === 'POST') {
        jobs.delete(m[1]);
        return json(res, 200, { ok: true });
      }
      if (m[2] === '/log' && req.method === 'GET') {
        return json(res, 200, { log: job.logTail });
      }
      return json(res, 200, publicJob(job));
    }

    if (p === '/' ) {
      res.writeHead(200, { ...CORS, 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(`视频下载器助手 ${VERSION}\nffmpeg: ${FFMPEG || '无'}\naria2c: ${ARIA2C || '无'}\n`);
    }

    return json(res, 404, { error: 'not found' });
  } catch (e) {
    return json(res, 500, { error: e?.message || String(e) });
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.log(`端口 ${PORT} 已被占用 —— 助手多半已经在运行了，不用再启动。`);
    console.log(`想看它状态：curl -s http://127.0.0.1:${PORT}/api/health`);
    console.log(`想重启它  ：lsof -ti :${PORT} | xargs kill; ./start.sh`);
    process.exit(0);
  }
  console.error(e);
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`视频下载器助手已启动 http://127.0.0.1:${PORT}`);
  console.log(`  ffmpeg : ${FFMPEG || '未安装（M3U8 合并不可用）'}`);
  console.log(`  ffprobe: ${FFPROBE || '未安装（预览元信息不可用）'}`);
  console.log(`  aria2c : ${ARIA2C || '未安装（自动退回 curl 单连接）'}`);
  console.log(`  输出目录: ${DEFAULT_OUT}`);
  console.log('');
  console.log(`  自检：curl -s http://127.0.0.1:${PORT}/api/health`);
  console.log(`  这个窗口别关，关了就停了（想常驻见 README 的 launchd 一段）`);
});

process.on('SIGINT', () => {
  for (const j of jobs.values()) if (j.child) { try { j.child.kill('SIGTERM'); } catch {} }
  process.exit(0);
});
