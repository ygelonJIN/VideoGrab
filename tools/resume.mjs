#!/usr/bin/env node
/**
 * 按「不推送/续传清单.md」把任务重新交给助手。
 *
 * 为什么需要它：助手重启后内存里的队列就没了，但桌面上的 .mp4 + .aria2 还在。
 * 只要用**原文件名**重新提交同一条链接，aria2 就会读 .aria2 续传；
 * 排队中那些本来就没下过，同名提交会从 0 开始。
 *
 * 用法：
 *   node tools/resume.mjs            # 提交
 *   node tools/resume.mjs --dry      # 只打印，不提交
 *
 * 前置：助手在跑（http://127.0.0.1:8765），且清单里的链接还没过期。
 * 链接过期就回页面重新解析，把新链接替换进清单，再跑这个脚本。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIST = path.join(ROOT, '不推送', '续传清单.md');
const HELPER = (process.env.VG_HELPER || 'http://127.0.0.1:8765').replace(/\/$/, '');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const DRY = process.argv.includes('--dry');

if (!fs.existsSync(LIST)) {
  console.error(`没有清单：${LIST}\n先在下一次下载时生成，或手动按格式写一份。`);
  process.exit(1);
}

const md = fs.readFileSync(LIST, 'utf8');
const items = [];
let cur = null;
for (const line of md.split('\n')) {
  const h = line.match(/^### (.+)$/);
  if (h) { cur = { name: h[1].trim(), url: '' }; items.push(cur); continue; }
  const u = line.match(/^- 链接（[^）]*）：(https?:\S+)/);
  if (u && cur) cur.url = u[1];
}
const list = items.filter((x) => x.url);
if (!list.length) {
  console.error('清单里没解析出任务（每条需要 `### 文件名` + `- 链接（…）：https://…`）');
  process.exit(1);
}
console.log(`清单 ${list.length} 条，助手 ${HELPER}${DRY ? '（dry run）' : ''}`);

// 打码：链接里带签名，日志里别整条甩出来
const mask = (u) => {
  try { const x = new URL(u); return `${x.host}/…${x.pathname.slice(-8)}`; } catch { return '（链接格式不对）'; }
};

let ok = 0, resumed = 0, failed = 0;
for (const it of list) {
  const name = it.name.replace(/\.mp4$/i, '') + '.mp4';
  if (DRY) { console.log(`  待提交 ${name}  ${mask(it.url)}`); continue; }
  try {
    const res = await fetch(`${HELPER}/api/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'mp4',
        url: it.url,
        name,
        headers: { ua: UA },
        outDir: path.join(os.homedir(), 'Desktop')
      })
    });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
    const same = j.name === name;
    if (same) resumed++; else console.log(`  ⚠️  ${name} → 助手改名成 ${j.name}（可能接不上旧断点）`);
    ok++;
    console.log(`  ✅ ${j.name}  ${j.id}  ${mask(it.url)}`);
  } catch (e) {
    failed++;
    console.log(`  ❌ ${name}  ${e.message}`);
  }
}
if (!DRY) {
  console.log(`\n提交 ${ok} 个，其中同名续传 ${resumed} 个，失败 ${failed} 个。`);
  if (failed) console.log('失败的多半是链接过期（403）或助手没开：链接过期就重新解析再跑一次。');
}
