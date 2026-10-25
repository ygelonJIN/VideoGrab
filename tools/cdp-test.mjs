#!/usr/bin/env node
/**
 * 集成测试：真的起一个 Chrome，加载扩展，开页面嗅探媒体，再问扩展要结果。
 * 用法：node tools/cdp-test.mjs
 * 依赖：本机 Chrome、/tmp/vgtest 里的测试素材（见 tools/make-fixtures.sh）
 */
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const EXT = path.resolve('extension');
const PROFILE = '/tmp/vg-profile';
const PORT = 9333;
const BASE = 'http://127.0.0.1:8899';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------ 极简 WebSocket 客户端
class WS {
  constructor(sock) {
    this.sock = sock;
    this.buf = Buffer.alloc(0);
    this.handlers = new Map();
    this.nextId = 1;
    this.frags = [];
    this.waiters = [];
    sock.on('data', (d) => this.onData(d));
  }

  static async connect(url) {
    const u = new URL(url);
    const key = crypto.randomBytes(16).toString('base64');
    const sock = net.connect(Number(u.port), u.hostname);
    await new Promise((res, rej) => { sock.once('connect', res); sock.once('error', rej); });
    sock.write(
      `GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.host}\r\n` +
      'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
    );
    let head = Buffer.alloc(0);
    await new Promise((res, rej) => {
      const onData = (d) => {
        head = Buffer.concat([head, d]);
        const i = head.indexOf('\r\n\r\n');
        if (i >= 0) {
          sock.off('data', onData);
          head = head.subarray(i + 4);
          res();
        }
      };
      sock.on('data', onData);
      sock.once('error', rej);
    });
    const ws = new WS(sock);
    if (head.length) ws.onData(head);
    return ws;
  }

  sendText(str) {
    const payload = Buffer.from(str);
    const len = payload.length;
    let header;
    if (len < 126) header = Buffer.from([0x81, 0x80 | len]);
    else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2);
    }
    const mask = crypto.randomBytes(4);
    const masked = Buffer.from(payload);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
    this.sock.write(Buffer.concat([header, mask, masked]));
  }

  onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const opcode = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
      let maskKey = null;
      if (masked) { if (b.length < off + 4) return; maskKey = b.subarray(off, off + 4); off += 4; }
      if (b.length < off + len) return;
      let payload = b.subarray(off, off + len);
      if (maskKey) payload = Buffer.from(payload.map((x, i) => x ^ maskKey[i % 4]));
      this.buf = b.subarray(off + len);
      if (opcode === 0x8) { this.sock.end(); return; }
      if (opcode === 0x9) continue;
      if (opcode === 0x1 || opcode === 0x0) {
        this.frags.push(payload);
        const fin = (b[0] & 0x80) !== 0;
        if (fin) {
          const msg = Buffer.concat(this.frags).toString('utf8');
          this.frags = [];
          this.onMessage(msg);
        }
      }
    }
  }

  onMessage(msg) {
    let data;
    try { data = JSON.parse(msg); } catch { return; }
    if (data.id && this.handlers.has(data.id)) {
      const { res, rej } = this.handlers.get(data.id);
      this.handlers.delete(data.id);
      data.error ? rej(new Error(data.error.message)) : res(data.result);
    }
  }

  call(method, params = {}) {
    const id = this.nextId++;
    return new Promise((res, rej) => {
      this.handlers.set(id, { res, rej });
      this.sendText(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.handlers.has(id)) { this.handlers.delete(id); rej(new Error('CDP 超时 ' + method)); } }, 15000);
    });
  }

  close() { try { this.sock.end(); } catch {} }
}

// ------------------------------------------------------------ 工具
async function httpJson(url, method = 'GET') {
  const r = await fetch(url, { method });
  return r.json().catch(() => ({}));
}

async function waitFor(fn, timeoutMs, label) {
  const t0 = Date.now();
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch {}
    if (Date.now() - t0 > timeoutMs) throw new Error('超时：' + label);
    await sleep(300);
  }
}

function parseEvalResult(r) {
  if (r.exceptionDetails) throw new Error('页面异常：' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result?.value;
}

// ------------------------------------------------------------ 主流程
async function main() {
  fs.rmSync(PROFILE, { recursive: true, force: true });
  const chrome = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=DialMediaRouteProvider',
    `--user-data-dir=${PROFILE}`,
    `--load-extension=${EXT}`,
    `--disable-extensions-except=${EXT}`,
    `--remote-debugging-port=${PORT}`,
    'about:blank'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let chromeLog = '';
  chrome.stderr.on('data', (d) => { chromeLog += d; });
  chrome.stdout.on('data', (d) => { chromeLog += d; });

  const cleanup = () => { try { chrome.kill('SIGKILL'); } catch {} };
  process.on('exit', cleanup);

  const results = [];
  const ok = (name, detail = '') => results.push({ ok: true, name, detail });
  const bad = (name, detail = '') => results.push({ ok: false, name, detail });

  try {
    await waitFor(async () => (await httpJson(`http://127.0.0.1:${PORT}/json/version`)).Browser, 20000, 'Chrome 调试端口');

    const sw = await waitFor(async () => {
      const list = await httpJson(`http://127.0.0.1:${PORT}/json/list`);
      return list.find((t) => t.type === 'service_worker' && t.url.includes('background.js'));
    }, 20000, '扩展 Service Worker');
    ok('扩展已加载', sw.url);

    const ws = await WS.connect(sw.webSocketDebuggerUrl);
    await ws.call('Runtime.enable');

    const info = parseEvalResult(await ws.call('Runtime.evaluate', {
      expression: `JSON.stringify({ name: chrome.runtime.getManifest().name, version: chrome.runtime.getManifest().version, hasVg: typeof __vg })`,
      returnByValue: true
    }));
    const meta = JSON.parse(info);
    ok('manifest 可读', `${meta.name} v${meta.version}`);
    if (meta.hasVg === 'object') ok('调试钩子就位');
    else bad('调试钩子就位', meta.hasVg);

    // 打开测试页
    await httpJson(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(BASE + '/page.html')}`, 'PUT');
    await sleep(3500);

    const snapRaw = parseEvalResult(await ws.call('Runtime.evaluate', {
      expression: `JSON.stringify(__vg.snapshot())`,
      returnByValue: true
    }));
    const snap = JSON.parse(snapRaw);
    const all = snap.flatMap((t) => t.items);
    const kinds = [...new Set(all.map((i) => i.kind))];

    if (all.length) ok('嗅探到媒体', all.length + ' 条，类型 ' + kinds.join('/'));
    else bad('嗅探到媒体', '0 条');

    const mp4 = all.find((i) => i.kind === 'MP4');
    if (mp4) ok('MP4 记录', `${mp4.name} · ${mp4.size}B`);
    else bad('MP4 记录', '没抓到 mp4');

    const hls = all.find((i) => i.kind === 'HLS');
    if (hls) ok('M3U8 记录', `${hls.name}`);
    else bad('M3U8 记录', '没抓到 m3u8');

    // 验证请求头是否被捕获（测试页由 127.0.0.1:8899 提供，带 Referer）
    const withHeaders = all.filter((i) => i.headers && (i.headers.referer || i.headers.ua));
    if (withHeaders.length) ok('抓到请求头', `${withHeaders.length} 条，例：${JSON.stringify(withHeaders[0].headers).slice(0, 120)}`);
    else bad('抓到请求头', '没有 referer/ua');

    // 让扩展自己下载一次 m3u8 解析（走网络）
    if (hls) {
      const parsed = parseEvalResult(await ws.call('Runtime.evaluate', {
        expression: `(async()=>{ try { const r = await chrome.runtime.sendMessage({type:'hls:parse', item:${JSON.stringify({ url: hls.url, headers: hls.headers })} }); return JSON.stringify(r).slice(0,300);} catch(e){ return 'ERR '+e.message; } })()`,
        awaitPromise: true,
        returnByValue: true
      }));
      if (String(parsed).includes('"ok":true')) ok('扩展内解析 HLS', String(parsed).slice(0, 160));
      else bad('扩展内解析 HLS', String(parsed));
    }

    // 配置读写
    const cfg = parseEvalResult(await ws.call('Runtime.evaluate', {
      expression: `(async()=>{ const r = await chrome.runtime.sendMessage({type:'cfg:set', settings:{aria2Conns:12}}); const g = await chrome.runtime.sendMessage({type:'cfg:get'}); return String(g.settings.aria2Conns); })()`,
      awaitPromise: true,
      returnByValue: true
    }));
    cfg === '12' ? ok('配置读写') : bad('配置读写', String(cfg));

    ws.close();
  } catch (e) {
    bad('流程异常', e.message);
  } finally {
    cleanup();
  }

  console.log('\n================ 结果 ================');
  let fail = 0;
  for (const r of results) {
    console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? '  — ' + r.detail : ''}`);
    if (!r.ok) fail++;
  }
  if (fail) {
    console.log('\n--- Chrome 日志尾部 ---');
    console.log(chromeLog.slice(-1500));
  }
  process.exit(fail ? 1 : 0);
}

main();
