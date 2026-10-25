# 视频下载器 VideoGrab

Chrome 扩展 + 本地助手。嗅探页面里的 **MP4 / M3U8 / DASH / WebM / TS** 等媒体，
把捕获到的**真实 Referer、User-Agent、Cookie** 一起交给 **aria2**（多线程）或 **ffmpeg**（流合并），
不用再手动 Copy as cURL、不用记那一长串参数。

![面板](screenshots/list.png)

<sub>列表：全文字按钮，MP4 直接 aria2，HLS 交给助手或拿 ffmpeg 命令</sub>

---

## 解决什么问题

| 原来的痛点 | 现在 |
|---|---|
| 浏览器单连接下载，被 CDN 按连接限速，1.3 GB 要几小时 | 扩展把完整请求头交给 aria2，`-x16 -s16` 多线程，通常几分钟 |
| 直链有防盗链，浏览器能下、curl 403 | 头是从页面请求里抓的，原样转发，403 自然消失 |
| M3U8 要记 `-protocol_whitelist` / `-extension_picky 0` 一长串 | 解析后一键复制命令，或直接交给助手跑 |
| 一页里好几个视频，要一个个复制 | 勾选批量入队 / 导出 aria2 `-i` 任务文件 |
| 文件名是乱码，看不出是哪个视频 | 点名称展开预览：抓一帧缩略图，配时长、分辨率、编码 |

![预览](screenshots/detail.png)

<sub>点名称展开：缩略图 + 时长 + 分辨率 + 编码，HLS 还会多一行分片/加密信息</sub>

---

## 安装

### 1. 扩展

Chrome 里打开 `chrome://extensions` → 右上角打开「开发者模式」→「加载已解压的扩展程序」→ 选本仓库的 `extension/` 目录。

> Google Chrome 品牌版从 137 起禁止了 `--load-extension` 命令行侧载，只能这样手动加载。
> 快捷键 `Alt+Shift+V` 可以直接呼出面板。

### 2. aria2（MP4 多线程，强烈建议）

```bash
brew install aria2
aria2c --enable-rpc --rpc-allow-origin-all --rpc-listen-all=false \
  --continue=true --max-connection-per-server=16 --split=16 --min-split-size=1M
```

想要开机自启就 `brew services start aria2`，并把上面参数写进 `~/.aria2/aria2.conf`。
装完在扩展「设置」里点 **测试 aria2**，看到版本号就通了。

### 3. 本地助手（M3U8 合并，可选）

```bash
cd helper
./start.sh          # 前台跑，Ctrl+C 停
```

想常驻（开机自启）：

```bash
sed "s#__HELPER_PATH__#$PWD#" helper/com.videograb.helper.plist > ~/Library/LaunchAgents/com.videograb.helper.plist
launchctl load ~/Library/LaunchAgents/com.videograb.helper.plist
```

助手只监听 `127.0.0.1:8765`，不对外。默认输出到 `~/Desktop`，可在设置里改。

---

## 用法

1. 打开播放页，点一次播放（让请求真的发出去）。
2. 点扩展图标。列表里出现媒体：类型、大小、域名。
3. **点名称（或整行）展开预览**：助手用 ffmpeg 带 Referer 抓一帧，配上时长、分辨率、编码。确认是你要的那个再下。
4. **MP4 / WebM 这类完整文件** → 点 `aria2 下载`（多线程）；没开 aria2 就先 `浏览器下载`。
5. **M3U8 / DASH** → 展开后点 `复制 ffmpeg 命令` 粘到终端，或 `交给助手` 后台跑，进度在「任务」里看。
6. **批量**：勾选多条 → `aria2 下载`；或 `导出清单` 后在终端 `aria2c -i 那个文件.txt`。

分片 `.ts` 默认折叠，设置里可以打开。

---

## 目录

```
extension/          Chrome 扩展（MV3）
  manifest.json
  background.js     嗅探 webRequest、调度下载、aria2 RPC
  common.js         类型识别、m3u8 解析、参数/命令生成
  popup.*           主面板
  options.*         设置页
  icons/
helper/             本地助手（Node，无依赖）
  server.mjs        /api/health /api/parse /api/jobs
  start.sh
  com.videograb.helper.plist
tools/              自测
  selftest.mjs      common + background 逻辑（假 chrome API）
  popup-test.mjs    弹窗渲染（jsdom）
  cdp-test.mjs      真浏览器端到端（需要 Chromium，品牌版 Chrome 不行）
```

---

## 自测

```bash
node tools/selftest.mjs     # 52 项：类型识别、m3u8、aria2 参数、ffmpeg 命令、嗅探逻辑
node tools/popup-test.mjs   # 23 项：列表渲染、解析面板、任务面板、筛选
```

`popup-test.mjs` 依赖 jsdom，先 `mkdir -p /tmp/vgdom && cd /tmp/vgdom && npm i jsdom`。

---

## 排错

| 现象 | 原因 / 处理 |
|---|---|
| 列表是空的 | 页面还没真正请求视频：点一下播放；或该页用的是 `blob:`，去设置里打开「显示分片」找 m3u8 |
| 条目上显示 `HTTP 403` | 链接是签名直链且已过期，重新播放页面拿新链接 |
| `⚡` 报 aria2 连不上 | aria2 没开 RPC，或端口/密钥和设置页不一致 |
| `交给助手` 没反应 | 助手没启动：`cd helper && ./start.sh` |
| HLS 解析失败 | 播放列表本身要 Referer：让助手在线（它带 Referer），扩展自己直连时不带头 |
| 下载完是 548 字节的小文件 | 那就是 403 错误页，说明头没带对或链接过期 |
| 下载很慢 | 设置里把连接数调到 16；有些 CDN 按 IP 限速，加连接没用 |
| 展开后一直「抓预览帧…」 | 助手没在跑，或源站很慢；先 `cd helper && ./start.sh` |
| 预览报 403 | 这个 CDN 连 ffmpeg 都拒，直接下也一样；回页面重新播一次拿新链接 |

---

## 隐私

- 嗅探数据只存在浏览器的 `storage.session`，关浏览器就没。
- Cookie 只在本地转发给 aria2 / 助手，不往外发。
- 助手只绑定 `127.0.0.1`。
