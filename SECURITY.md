# 安全策略

## 报告漏洞

请**不要**开公开 Issue。用 GitHub 的 [私密漏洞报告](https://github.com/lijishuang/apiflow/security/advisories/new) 提交，或在 Issue 里只写「有一处安全问题，请提供私下联系方式」。48 小时内会有人回。

## 这个项目会存什么

APIFlow 是**自托管**的，所有数据都在你自己机器的 `data/` 目录里，不上传任何服务端：

| 文件 | 内容 | 敏感度 |
|---|---|---|
| `data/creds.json` | AK/SK 凭证、接口级绑定关系 | **高**——明文存储 |
| `data/sources.json` | 接入的 OpenAPI 地址、鉴权头 | 高 |
| `data/flows.json` | 流程定义（可能含示例参数） | 中 |
| `data/runs.json` | 运行历史（请求/响应全量快照） | 高——响应里可能有业务数据 |
| `data/materials/`、`data/sdk/` | 从 SDK 抽取的符号与源码片段 | 中 |
| `data/docs/` | 从帮助手册抓取的正文与截图文本 | 低 |

`data/` 已在 `.gitignore` 中，**任何情况下都不要提交**。分享截图、日志、复现用例前，请先脱敏。

## 部署建议

- **不要**把本服务直接暴露在公网。默认监听 `127.0.0.1:3300`，仅本机可访问。
- 需要跨机访问时，放在反向代理后面并启用 HTTPS，同时给 `/api/*` 加上 `auth` 中间件已有的 AK/SK 校验。
- 凭证签名用 HMAC-SHA256 + 时间窗，密钥材料来自 `data/creds.json`；轮换密钥后旧绑定会立即失效。
- Chrome 插件通过 token 或 AK/SK 访问本机服务，不要把 token 贴进 Issue。

## 已知取舍

- 凭证以明文 JSON 落盘（为了零依赖、可离线）。生产环境请替换 `lib/store.js` 的存储层为加密存储或密钥管理服务。
- 演示用的上游沙箱 `/upstream/_sandbox/*` 会回显请求内容，仅用于本地调试。
