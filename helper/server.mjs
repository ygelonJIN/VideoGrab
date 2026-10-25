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


// ---------------------------------------------------------------- 预览探针
const probeCache = new Map();      // key -> {at, data}
const PROBE_TTL = 10 * 60 * 1000;
let probing = 0;

// HLS 专有的参数不能喂给 MP4，否则 ffmpeg 会报 "Option not found"
const HLS_OPTS = ['-allowed_extensions', 'ALL', '-allowed_segment_extensions', 'ALL', '-extension_picky', '0'];

function inputOpts(headers = {}, hls = false) {
  const args = [];
  const hdr = headerEntries(headers).filter(([k]) => k !== 'User-Agent')
    .map(([k, v]) => `${k}: ${v}`).join('\r\n');
  if (hdr) args.push('-headers', hdr + '\r\n');
  if (headers.ua) args.push('-user_agent', headers.ua);
  args.push('-protocol_whitelist', 'file,http,https,tcp,tls,crypto');
  if (hls) args.push(...HLS_OPTS);
  args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5');
  return args;
}

function runCapture(bin, args, timeoutMs = 25000) {
  return new Promise((resolve) => {
    const chunks = [];
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, timeoutMs);
    child.stdout.on('data', (d) => chunks.push(d));
    child.stderr.on('data', (d) => { err = (err + d).slice(-1200); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out: Buffer.concat(chunks), err });
    });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out: Buffer.alloc(0), err: e.message }); });
  });
}

const lastLine = (s) => String(s || '').split('\n').map((x) => x.trim()).filter(Boolean).slice(-1)[0] || '';

function parseMeta(raw) {
  const meta = { duration: 0, width: 0, height: 0, bitrate: 0, videoCodec: '', audioCodec: '', thumbnail: '' };
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

async function grabFrame(url, opts, at) {
  const head = ['-v', 'error', '-nostdin', ...opts];
  const tail = ['-frames:v', '1', '-vf', 'scale=480:-2', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'];
  // 先试输入端快进，再试从头抓（有的源不支持 seek）
  const variants = [
    [...head, '-ss', String(at), '-i', url, ...tail],
    [...head, '-i', url, ...tail]
  ];
  for (const args of variants) {
    const r = await runCapture('ffmpeg', args, 30000);
    if (r.code === 0 && r.out.length > 500) {
      return { dataUrl: 'data:image/jpeg;base64,' + r.out.toString('base64'), at };
    }
  }
  return null;
}

async function probeOnce(url, headers, hls) {
  const opts = inputOpts(headers, hls);
  const p = await runCapture('ffprobe', [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', ...opts, '-i', url
  ]);
  if (p.code !== 0) throw new Error(lastLine(p.err) || 'ffprobe 打不开这个地址');
  const meta = parseMeta(p.out);
  // HLS 跳转便宜（按分片取），MP4 远程 seek 可能要拉很多字节，跨度压小
  const cap = hls ? 600 : 60;
  const at = meta.duration > cap ? cap : Math.max(1, Math.round(meta.duration / 3));
  const frame = await grabFrame(url, opts, at);
  if (frame) {
    meta.thumbnail = frame.dataUrl;
    meta.thumbAt = frame.at;
  } else {
    meta.probeError = '元信息拿到了，但抓帧失败';
  }
  return meta;
}

async function probeMedia(url, headers) {
  const key = url + '|' + (headers.referer || '') + '|' + (headers.cookie || '').slice(0, 24);
  const hit = probeCache.get(key);
  if (hit && Date.now() - hit.at < PROBE_TTL) return hit.data;

  const ffmpeg = which('ffmpeg');
  const ffprobe = which('ffprobe');
  if (!ffmpeg || !ffprobe) throw new Error('找不到 ffmpeg / ffprobe');
  if (probing >= 3) throw new Error('预览任务太多，稍等一下');

  const looksHls = /\.m3u8?(\?|$)/i.test(url) || /mpegurl|m3u8/i.test(url);
  const order = looksHls ? [true, false] : [false, true];

  probing++;
  try {
    let lastErr = null;
    for (const hls of order) {
      try {
        const meta = await probeOnce(url, headers, hls);
        probeCache.set(key, { at: Date.now(), data: meta });
        if (probeCache.size > 60) {
          const oldest = [...probeCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
          if (oldest) probeCache.delete(oldest[0]);
        }
        return meta;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error('预览失败');
  } finally {
    probing--;
  }
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
      '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
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
  args.push(url);
  return args;
}

// ---------------------------------------------------------------- 执行
function startJob(job) {
  job.status = 'running';
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
    for (const [k, v] of headerEntries(headersOf(job))) args.push('-H', `${k}: ${v}`);
    args.push(job.url);
    tracker = (chunk) => pushLog(job, chunk);
  } else {
    return fail(job, '系统里没有 curl，无法下载');
  }

  job.cmd = [cmd, ...args].join(' ');
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
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
      try {
        const media = await probeMedia(body.url, body.headers || {});
        return json(res, 200, { ok: true, media });
      } catch (e) {
        return json(res, 200, { ok: false, error: e?.message || String(e) });
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
