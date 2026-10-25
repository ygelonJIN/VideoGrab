/**
 * 从进程输出里抽出"人话"错误。
 *
 * aria2 失败时最后几行永远是这段页脚：
 *   If there are any errors, then see the log file. See '-l' option in help/man page for details.
 * 真正的 cause 在更上面：errorCode=22 / status=403 之类。
 * 只取最后一行 = 把最有用的信息扔掉。
 */

const HINTS = {
  1: '未知错误',
  2: '超时',
  3: '资源不存在（404）',
  6: '网络问题',
  9: '磁盘空间不足',
  13: '目标文件已存在（重名，或上次没删干净）',
  16: '文件读写失败',
  18: '文件名非法',
  19: '域名解析失败',
  22: 'HTTP 状态不对，多半是 403：直链过期、请求头不对，或被限速',
  23: '重定向过多',
  24: '需要认证'
};

// aria2 收尾那几行，没有任何信息量
const NOISE =
  /see the log file|help\/man page|'-l' option|Download Results|Status Legend|\(INPR\)|\(ERR\)|aria2 will resume|^gid\s*\||^=+\+?=*$|^gid\s*\|?/i;

/** 把签名直链打码，别让它出现在界面上 */
function maskUri(s) {
  return String(s).replace(/URI=\S+/gi, 'URI=…');
}

/**
 * 返回一句可读的错误；什么线索都没有就返回空串（交给调用方兜底）。
 */
export function extractAria2Error(text) {
  const lines = String(text || '')
    .split(/[\r\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!lines.length) return '';

  // 1) errorCode 那两行：最准
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/errorCode=(\d+)/);
    if (!m) continue;
    const hint = HINTS[Number(m[1])] || '';
    const detail = maskUri(lines.slice(i, i + 2).join(' '))
      .replace(/\s*(?:Download Results|Status Legend)\s*:?[\s\S]*$/i, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 240);
    return hint ? `${hint}｜${detail}` : detail;
  }

  // 2) [ERROR] / Exception 行
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/\[ERROR\]|Exception:/.test(lines[i])) return maskUri(lines[i]).slice(0, 240);
  }

  // 3) 兜底：最后一行不是页脚的话
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!NOISE.test(lines[i])) return maskUri(lines[i]).slice(0, 240);
  }
  return '';
}

/** 给退出码补一句人话 */
export function describeExit(code, signal) {
  return `进程退出码 ${code}${signal ? ` (${signal})` : ''}`;
}
