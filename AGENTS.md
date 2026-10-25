# 视频下载器

## 读取规则

- 动扩展的嗅探逻辑、下载调度、aria2 / 助手接口之前，先读 `经验文档/使用说明.md`。
- 改 `helper/server.mjs` 的接口或参数之前，读同一篇的「助手接口」和「坑」两节。
- 只是改文案、颜色、图标，不用读。

## 是什么

Chrome MV3 扩展 + 本地 Node 助手。嗅探页面媒体（MP4 / M3U8 / DASH / TS），
把页面真实的 Referer / UA / Cookie 自动带给 aria2 和 ffmpeg，省掉手抄 cURL 和记参数。

- `extension/` 是扩展本体，直接在 `chrome://extensions` 里「加载已解压的扩展程序」。
- `helper/` 是本地助手，只监听 `127.0.0.1:8765`，负责 M3U8 合并和下载队列。
- `tools/` 是自测脚本，改完代码先跑一遍。

## 目录

- `extension/` — Chrome 扩展：`background.js` 嗅探与调度，`popup.*` 面板，`options.*` 设置
- `helper/` — 本地助手：`server.mjs`、`start.sh`、launchd plist
- `tools/` — `selftest.mjs`（逻辑）、`popup-test.mjs`（渲染）、`cdp-test.mjs`（真浏览器，备用）
- `不推送/` — 私人文件，永不提交

## 经验索引

- `经验文档/使用说明.md`
  - 什么时候读：改嗅探/下载逻辑、改助手接口、加新下载器、Chrome 升级后扩展失效
  - 包含：架构与数据流、请求头怎么来、aria2 与助手的参数约定、测试怎么跑、踩过的坑
  - 不用读：只改样式、图标、文案

## 禁止

- 不把 `node_modules/`、`*.crx`、`*.pem` 提交进仓库
- 不在扩展里做 M3U8 内存拼接（大文件必爆内存，一律走助手 + ffmpeg）
- 助手的端口不改成 `0.0.0.0`，不对外暴露
- 文档里不写 Cookie、签名直链、密钥
