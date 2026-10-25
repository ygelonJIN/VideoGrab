/**
 * 输出文件名去重。
 *
 * 批量下载时名字多半取自网页标题，同一批里重名很常见。
 * 重名直接交给 aria2 会得到 errorCode=13「文件已存在」，
 * 更糟的是它可能拿新任务的响应去覆盖已经下好的那个文件。
 *
 * 所以落盘前自己先分配一个不冲突的名字：`名字 (2).mp4`。
 * `taken` 由调用方注入，方便单测。
 */
export function uniqueName(stem, suffix, taken, max = 99) {
  const base = String(stem || 'video');
  const ext = String(suffix || '');

  for (let n = 0; n <= max; n++) {
    const name = n === 0 ? `${base}${ext}` : `${base} (${n})${ext}`;
    if (!taken(name)) return name;
  }
  // 极端情况：同名超过 100 个，用时间戳兜底
  return `${base} (${Date.now()})${ext}`;
}

/** 把 xxx.mp4 拆成 ['xxx', '.mp4']；没有扩展名时后缀为空串 */
export function splitExt(name) {
  const s = String(name || '');
  const i = s.lastIndexOf('.');
  if (i <= 0 || i === s.length - 1) return [s, ''];
  return [s.slice(0, i), s.slice(i)];
}
