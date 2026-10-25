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
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.VG_PORT || 8765);
const HOME = os.homedir();
const DEFAULT_OUT = path.join(HOME, 'Desktop');
const VERSION = '1.0.0';
const CONCURRENCY = Number(process.env.VG_CONCURRENCY || 2);
const MAX_JOBS = 60;

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

// 按输出文件大小估算进度（aria2c / curl 通用）
function watchOutput(job) {
  let probing = false;
  const timer = setInterval(async () => {
    if (job.status !== 'running') return;
    const size = await fileSize(job.out);
    job.speed = Math.max(0, (size - (job._lastSize || 0)) / 0.9);
    job._lastSize = size;
    job.received = size;
    if (!job.total && !probing && size > 0) {
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
  for (const [k, v] of headerEntries(headers)) args.push('-H', `${k}: ${v}`);
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
    tracker = (chunk) => pushLog(job, chunk);
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

  child.stderr.on('data', (d) => tracker(d));
  child.stdout.on('data', (d) => tracker(d));

  child.on('error', (e) => {
    if (job._settled) return;
    job._settled = true;
    stopWatch();
    fail(job, e.message);
  });

  child.on('close', (code, signal) => {
    if (job._settled) return;
    job._settled = true;
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
      job.error = job.lastLine || `进程退出码 ${code}${signal ? ' (' + signal + ')' : ''}`;
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
  const name = type === 'hls'
    ? base.replace(/\.[a-z0-9]{2,5}$/i, '') + '.mp4'
    : ensureExt(base, ext);
  const out = path.join(dir, name);

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
  return {
    id: j.id, type: j.type, name: j.name, out: j.out, url: j.url,
    status: j.status, progress: Math.round(j.progress * 10) / 10,
    speed: Math.round(j.speed || 0), received: j.received, total: j.total,
    duration: j.duration, position: j.position,
    error: j.error || '', createdAt: j.createdAt, endedAt: j.endedAt || 0
  };
}

// ---------------------------------------------------------------- HTTP
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
    if (p === '/api/health' && req.method === 'GET') {
      return json(res, 200, {
        ok: true, version: VERSION, home: HOME, defaultOut: DEFAULT_OUT,
        ffmpeg: Boolean(FFMPEG), ffmpegPath: FFMPEG, ffprobe: Boolean(FFPROBE),
        aria2c: Boolean(ARIA2C), aria2cPath: ARIA2C,
        curl: Boolean(CURL), concurrency: CONCURRENCY
      });
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

    const m = p.match(/^\/api\/jobs\/([\w-]+)(\/cancel|\/log)?$/);
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
