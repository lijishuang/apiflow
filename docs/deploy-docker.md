# Docker 部署指南

APIFlow 是零 npm 依赖的纯 Node 服务，镜像基于 `node:22-alpine`：没有 `npm install` 步骤，构建产物只有源码与文档，体积小、构建快。

## 前置要求

- Docker 20+（含 Compose v2，即 `docker compose` 子命令可用）；
- 如需 LLM 搭建：容器要能访问你的 OpenAI 兼容网关（见下方「内网网关连通性」）。

## 快速开始

### 方式一：docker compose（推荐）

```bash
docker compose up -d --build
```

打开 `http://<宿主机IP>:3300` 即可。日志：`docker compose logs -f`；停止：`docker compose down`。

### 方式二：原生 docker 命令

```bash
docker build -t apiflow:0.5.0 .
docker run -d --name apiflow \
  -p 3300:3300 \
  -v "$PWD/data:/app/data" \
  -e TZ=Asia/Shanghai \
  --restart unless-stopped \
  apiflow:0.5.0
```

## 数据持久化（重要）

一切业务数据都在容器的 `/app/data`（对应宿主机 `./data` 卷）：

| 文件 | 内容 |
|---|---|
| `flows.json` | 流程定义 + 版本历史 |
| `runs.json` | 运行记录（节点输入输出，可重放/审计） |
| `ops.json` / `sources.json` | 接口目录与接入源 |
| `settings.json` | **LLM 设置（含 API Key，掩码回显）** |
| `docs/`、`materials/`、`sdk/` | 手册、资料、SDK 缓存 |

- **升级镜像不丢数据**：换镜像版本后用同一个 `-v` 挂载即可；
- `settings.json` 里是明文 Key，请像保护密钥一样保护这个卷（宿主机目录权限、备份策略）；
- 首次启动（克隆后直接跑）data 目录不存在时，服务会自动创建，无需初始化步骤。

## 内网 LLM 网关连通性

设置页配置的内网网关（如 `http://llm-gateway.example.com/v1`）由**容器内**发起请求：

- compose 默认 bridge 网络在大多数内网环境可直接可达；若不通，优先检查宿主机防火墙与网关白名单；
- 需要与宿主完全同网络栈时，在 `docker-compose.yml` 加 `network_mode: host`（此时 `ports` 映射失效，服务直接监听宿主 3300）；
- 暂时不用 LLM：设置页停用即可，或加环境变量 `APIFLOW_LLM=off` 强制关闭（回归测试同款开关）。

## 端口与环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `3300` | 服务监听端口（容器内）；改它记得同步 `-p` 映射 |
| `TZ` | `Asia/Shanghai` | 时区（运行记录时间戳展示用） |
| `APIFLOW_LLM` | — | 设为 `off` 强制关闭 LLM 搭建，始终走内置规则引擎 |

## 健康检查与运维

- 镜像内置 `HEALTHCHECK`（每 30s 请求一次首页，5s 超时，3 次失败标记 unhealthy）：`docker ps` 的 STATUS 列可直接看；
- 升级：`git pull && docker compose up -d --build`（数据在卷里，不受影响）；
- 回滚：`docker run` 上一个版本 tag、挂同一个 data 卷即可；
- 备份：停写后整目录拷走 `./data`（或 `tar czf apiflow-data-$(date +%F).tgz data/`）。

## 常见问题

- **端口被占用**：`-p 8080:3300` 用宿主 8080 映射，容器内端口不必改；
- **启动即退出**：`docker logs apiflow` 看日志；最常见是宿主 data 卷权限（容器内以 node 用户写不进去）→ `chown -R 1000:1000 data`；
- **更新记录页显示读不到 CHANGELOG**：CHANGELOG.md 已打进镜像，自构建镜像不应出现此问题；若自行裁剪镜像请保留根目录的 `CHANGELOG.md`。
