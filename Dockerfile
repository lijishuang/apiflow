# APIFlow —— 零 npm 依赖的纯 Node 服务：镜像里只有源码与文档，拉基础镜像后无安装步骤
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production TZ=Asia/Shanghai

# 源码 + 更新记录（「更新记录」页解析 CHANGELOG.md）+ 文档；data/ 不打进镜像（见下方卷）
COPY package.json server.js CHANGELOG.md README.md ./
COPY lib ./lib
COPY public ./public
COPY docs ./docs

# 流程 / 运行记录 / 接口目录 / LLM 设置全在 /app/data —— 务必挂卷持久化；未挂载时容器内自建空目录
RUN mkdir -p /app/data
VOLUME /app/data

EXPOSE 3300
# 健康检查走首页（毫秒级、无副作用）；PORT 可用 -e 覆盖
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3300)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
