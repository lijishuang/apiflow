# 贡献指南

感谢你愿意改进 APIFlow。这个项目的目标是：**用自然语言把接口拼成流程，但运行时不引入任何不确定性**。任何改动只要碰到这条底线（运行期出现 LLM 调用、随机、隐式重试），都会被拒绝。

## 开发环境

```bash
node -v          # 需要 ≥ 22（依赖内置 fetch / AbortController / TextDecoder）
node server.js   # 零依赖，不需要 npm install
# → http://127.0.0.1:3300
```

首次启动会自动创建 `data/` 目录并写入空数据文件。

## 改代码前先跑一遍回归

回归脚本都要求服务已在 3300 端口运行。它们**自建夹具、退出自动清理**，不会动你平台里的真实数据。

```bash
npm test                  # 全量串行
bash test-docs.sh         # 只跑某一块
```

新增能力时请连同回归一起提：一个特性没有断言覆盖，等于没做完。

## 提交约定

提交信息用 [Conventional Commits](https://www.conventionalcommits.org/)：

```
feat(docs): 支持 PDF 按字体表还原中文
fix(agent): 手册兜底在候选同分时被误判为歧义
docs(readme): 补充插件端安装步骤
```

- `feat` / `fix` / `docs` / `refactor` / `perf` / `test` / `chore`
- 作用域写模块名（`agent` / `engine` / `docs` / `sdk` / `extension` / `store`）
- 正文说清「为什么」，不重复「改了什么」——后者看 diff 就行

## 代码风格

- 纯 CommonJS，不引第三方依赖（`zlib` / `child_process` / `fetch` 这类内置模块可以）
- 中文注释，写清**为什么这么做**，尤其是反直觉之处（例如 PDF 的 `lastIndex = end + 9`）
- 前端不引入框架与构建步骤，`public/app.js` 直接跑
- 错误信息面向使用者：说清「为什么没成」和「下一步能怎么办」

## 绝对不要提交的东西

| 路径 | 原因 |
|---|---|
| `data/` | 真实运行态，`creds.json` 里是 AK/SK **明文** |
| `data/materials/`、`data/sdk/` | 从你的 SDK 里抽出来的符号与源码片段 |
| `node_modules/` | 本项目零依赖，出现即异常 |

`.gitignore` 已覆盖，提交前请再 `git status` 看一眼。

## 提 PR

1. 从 `main` 切分支：`feat/xxx` 或 `fix/xxx`
2. 保证 `npm test` 全绿，PR 描述里贴结果
3. 有界面改动的话附截图（放 `screenshots/`，命名 `模块-画面.png`）
4. 一个 PR 只做一件事；顺手重构请拆开

## 报问题

用仓库的 [Issue 模板](.github/ISSUE_TEMPLATE/) 提，附上 Node 版本、复现步骤、期望与实际。**贴日志前先把 AK/SK、内网地址、token 打码。**
