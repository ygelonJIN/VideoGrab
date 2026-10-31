/**
 * MP4 容器体检 / 修复。
 *
 * 为什么要有这一层：从 HLS 直接拼出来的「分片 MP4」（fMP4）把每段样本的索引
 * 放在各自的 moof 里，moov 只剩初始化信息。ffmpeg 系播放器（VLC / IINA / mpv）
 * 边读边建表，能播；macOS 的 AVFoundation（QuickTime / 预览 / 空格预览 / Safari）
 * 读不出样本，表现就是「双击没反应、黑屏、卡在 0:00」。
 *
 * 修复 = ffmpeg -c copy 重封装：码流字节原样搬，只把碎片索引合并回一张完整
 * stbl，顺带 +faststart 把 moov 挪到文件头。不重编码，画质和体积基本不变。
 *
 * 这里的函数都是纯逻辑（scanContainerBytes）或受控 IO（scanContainerFile /
 * repairContainer），不碰网络，方便 tools/selftest.mjs 直接测。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const HEAD_BYTES = 2 << 20;   // 2 MB：ftyp + 初始化 moov + 第一个 moof 都在里面
const TAIL_BYTES = 2 << 20;   // moov 在尾部的普通 MP4 也认得出

const EMPTY = Buffer.alloc(0);

// ---------------------------------------------------------------- 体积/空间
export function humanBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let x = v / 1024;
  let i = 0;
  while (x >= 1024 && i < units.length - 1) { x /= 1024; i++; }
  return `${x >= 100 ? x.toFixed(0) : x.toFixed(1)} ${units[i]}`;
}

/** 目录可用空间；Node 18.15 以下没有 statfs，返回 0 表示"查不到，别拦" */
export function freeSpace(dir) {
  try {
    const st = fs.statfsSync(dir);
    return Number(st.bsize) * Number(st.bavail);
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------- 解析
function readBoxHeader(buf, off) {
  if (off + 8 > buf.length) return null;
  let size = buf.readUInt32BE(off);
  const type = buf.toString('latin1', off + 4, off + 8);
  let hdr = 8;
  if (size === 1) {
    if (off + 16 > buf.length) return null;
    size = Number(buf.readBigUInt64BE(off + 8));
    hdr = 16;
  } else if (size === 0) {
    size = buf.length - off;     // 一直到文件尾
  }
  if (size < hdr) return null;
  return { size, type, hdr };
}

/** 从一段 buffer 的开头顺序走顶层 box；遇到被截断的 box 就停 */
export function topLevelBoxes(buf, base = 0) {
  const out = [];
  let off = 0;
  let guard = 0;
  while (off + 8 <= buf.length && guard++ < 20000) {
    const b = readBoxHeader(buf, off);
    if (!b) break;
    const truncated = off + b.size > buf.length;
    out.push({ type: b.type, offset: base + off, size: b.size, truncated });
    if (truncated) break;
    off += b.size;
  }
  return out;
}

/** 在尾部 buffer 里从后往前找一个完整的 box（moov 通常就是最后一个） */
export function findLastBox(buf, type = 'moov') {
  const needle = Buffer.from(type, 'latin1');
  let idx = buf.lastIndexOf(needle);
  while (idx >= 4) {
    const size = buf.readUInt32BE(idx - 4);
    const start = idx - 4;
    if (size >= 8 && start + size === buf.length) return { offset: start, size };
    idx = buf.lastIndexOf(needle, idx - 1);
  }
  return null;
}

/**
 * 判定一段 MP4 头/尾。不需要读全文件：moov 在头或尾，moof / mdat 都在头几 MB 里。
 * @returns {{kind:string, fragmented:boolean, moovFront:boolean, brand:string, moovSize:number, size:number}}
 */
export function scanContainerBytes(head, tail = EMPTY, fileSize = head.length) {
  const boxes = topLevelBoxes(head, 0);
  const at = (t) => boxes.findIndex((b) => b.type === t);

  const ftyp = boxes.find((b) => b.type === 'ftyp');
  const brand = ftyp
    ? head.toString('latin1', ftyp.offset + 8, Math.min(ftyp.offset + 12, ftyp.offset + ftyp.size))
    : '';

  const moofAt = at('moof');
  const mdatAt = at('mdat');
  const moovAt = at('moov');

  let moov = moovAt >= 0 ? boxes[moovAt] : null;
  if (!moov && tail.length) {
    const t = findLastBox(tail, 'moov');
    if (t) moov = { type: 'moov', offset: fileSize - tail.length + t.offset, size: t.size, truncated: false };
  }

  // mvex 只出现在分片 MP4 的初始化 moov 里，是 moof 之外的第二判据
  let hasMvex = false;
  if (moov && moov.offset >= 0 && moov.offset < head.length) {
    const end = Math.min(moov.offset + moov.size, head.length);
    hasMvex = head.subarray(moov.offset, end).includes('mvex');
  }

  const fragmented = moofAt >= 0 || hasMvex;
  const moovFront = Boolean(moov) && (mdatAt >= 0
    ? moov.offset < boxes[mdatAt].offset
    : moovAt >= 0);          // 头里先看到 moov、还没看到 mdat，说明 moov 在前

  let kind = 'unknown';
  if (fragmented) kind = 'fragmented';
  else if (moov) kind = moovFront ? 'normal' : 'moov-tail';

  return {
    kind,
    fragmented,
    moovFront,
    brand,
    moovSize: moov ? moov.size : 0,
    size: fileSize
  };
}

export function describeScan(scan) {
  if (!scan) return '';
  switch (scan.kind) {
    case 'fragmented':
      return '分片 MP4：索引分散在 moof 碎片里，QuickTime / 预览读不出画面';
    case 'moov-tail':
      return '普通 MP4，但索引在文件尾部（能播，只是边下边播不友好）';
    case 'normal':
      return '普通 MP4：索引在文件头，结构正常';
    default:
      return '认不出容器（可能不是 MP4，或者文件不完整）';
  }
}

/** 读文件头和文件尾做体检，不读全文件 */
export async function scanContainerFile(filePath) {
  const st = await fsp.stat(filePath);
  if (!st.isFile()) throw new Error('不是普通文件');
  const headLen = Math.min(HEAD_BYTES, st.size);
  const tailLen = st.size > headLen ? Math.min(TAIL_BYTES, st.size) : 0;

  const fh = await fsp.open(filePath, 'r');
  try {
    const head = Buffer.alloc(headLen);
    if (headLen) await fh.read(head, 0, headLen, 0);
    let tail = EMPTY;
    if (tailLen) {
      tail = Buffer.alloc(tailLen);
      await fh.read(tail, 0, tailLen, st.size - tailLen);
    }
    return scanContainerBytes(head, tail, st.size);
  } finally {
    await fh.close();
  }
}

// ---------------------------------------------------------------- 执行
function run(cmd, args, timeoutMs = 0) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err = (err + d).slice(-8000); });
    const timer = timeoutMs
      ? setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 已经退出 */ } }, timeoutMs)
      : null;
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({ code, signal, err });
    });
  });
}

const lastLine = (s) => String(s || '').trim().split(/[\r\n]+/).filter(Boolean).pop() || '';

/**
 * 把一个分片 MP4 重封装成普通 MP4（同目录临时文件 + 原子替换）。
 * 结构本来就正常时什么都不做，返回 action:'none'。
 *
 * 任何一步失败都保证原文件不被破坏：临时文件删掉，源文件一个字节没动。
 */
export async function repairContainer(filePath, opts = {}) {
  const ffmpeg = opts.ffmpeg || 'ffmpeg';
  const startedAt = Date.now();
  const st = await fsp.stat(filePath);
  if (!st.isFile()) throw new Error('不是普通文件');
  if (!/\.(mp4|m4v|mov)$/i.test(filePath)) throw new Error('只处理 mp4 / m4v / mov');

  const before = await scanContainerFile(filePath);
  if (!before.fragmented) {
    return { ok: true, action: 'none', before, after: before, size: st.size, ms: Date.now() - startedAt };
  }

  const dir = path.dirname(filePath);
  const free = freeSpace(dir);
  const need = Math.ceil(st.size * 1.15);
  if (free && free < need) {
    throw new Error(`空间不够：重封装要先写一份临时副本，需要 ${humanBytes(need)}，这个目录只剩 ${humanBytes(free)}`);
  }

  const tmp = path.join(dir, `.vg-fix-${Date.now().toString(36)}${path.extname(filePath) || '.mp4'}`);
  try {
    // -c copy：不重编码；+faststart：moov 挪到文件头
    const r = await run(ffmpeg, [
      '-hide_banner', '-nostdin', '-y',
      '-i', filePath,
      '-c', 'copy',
      '-movflags', '+faststart',
      '-f', 'mp4', tmp
    ], opts.timeoutMs || 0);
    if (r.code !== 0) throw new Error(lastLine(r.err) || `ffmpeg 退出码 ${r.code}`);

    const after = await scanContainerFile(tmp);
    if (after.fragmented) throw new Error('重封装后仍然是分片结构，放弃替换（原文件没动）');

    const size = (await fsp.stat(tmp)).size;
    await fsp.rename(tmp, filePath);          // 同目录，原子替换
    return { ok: true, action: 'repaired', before, after, size, ms: Date.now() - startedAt };
  } catch (e) {
    try { await fsp.unlink(tmp); } catch { /* 没生成就算了 */ }
    throw e;
  }
}

/** 助手被强杀留下的临时文件；只在指定目录里扫一层，别全盘翻 */
export function cleanupStaleFixes(dirs = []) {
  let removed = 0;
  for (const dir of dirs) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (!n.startsWith('.vg-fix-')) continue;
      try { fs.unlinkSync(path.join(dir, n)); removed++; } catch { /* 忽略 */ }
    }
  }
  return removed;
}
