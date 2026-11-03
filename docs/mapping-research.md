# 节点间「传递数据」的编写方式调研与改造建议

> 目标：把现在「手写 `{{nodes.X.output.a.b}}` + 手填目标字段」的方式，换成**选字段就能连**的低摩擦映射，同时保留复杂场景的表达力。
> 调研时间：2026-11-03 ｜ 适用版本：APIFlow 0.3.0

---

## 一、现状：APIFlow 现在怎么传数据

### 1.1 机制

| 位置 | 现在的做法 | 代码 |
|---|---|---|
| 边（连线） | 默认**整包传递**上游输出；可选「自定义映射」，逐行填 `目标字段 ← 来源表达式` | `edge.map = { 目标字段: '{{nodes.X.output...}}' }`，`public/app.js` 的 `openEdgeMap` |
| 节点配置 | URL / Query / Body 里直接写模板 `{{input.x}}`、`{{nodes.id.output.y}}` | `lib/engine.js` 的 `renderStr` / `renderDeep` |
| 字段发现 | 映射弹窗底部展示**最近一次运行**的上游输出**顶层**字段 chips（最多 12 个） | `loadEdgeChips`，`Object.keys(output)` |

### 1.2 表达式能力边界（`lib/engine.js:19-46`）

```js
renderStr: {{path}} 插值 → 值转字符串，取不到则替换为空串
renderDeep: 整个值就是一个 {{path}} 时保留原始类型（对象/数组/数字）
兼容: {param} 单花括号，回退到 input.param
```

**没有**：函数、默认值、条件、数组遍历/取值、类型转换、格式化、路径不存在提示。

### 1.3 六个具体摩擦点

1. **要背节点 ID 和路径**：`{{nodes.list_product_v2.output.entity.0.productName}}` —— 节点 id 是英文，数组用数字下标，嵌套层级靠记忆。
2. **只能靠记忆或试跑发现字段**：chips 只给顶层 key（`entity`、`code`），拿不到 `entity.0.productName`；新流程没跑过就完全空白，只能盲写。
3. **目标字段要手打**：Body 里明明已有 `productName` 这个 key，还得重新敲一遍（容易拼错，拼错也不报错）。
4. **写错静默失败**：路径不存在 → `renderStr` 返回空串，下游收到空值，只在运行时才发现，且没有告警。
5. **取值结果不可见**：改完映射不知道对不对，必须整条流程 Dry-run/运行一次才看得到值。
6. **目标结构是扁平的**：`map` 只有一层 `key → 表达式`，没法直接构造嵌套对象，也没法把数组「映射成数组」。

---

## 二、业界七种做法

### ① 拖拽「数据胶囊」（n8n / Make / Power Automate）

- **n8n**：节点输出面板里的字段可**直接拖进任意参数框**，落进去自动生成表达式；表达式编辑器有上下文感知补全（变量、函数、方法）、语法高亮、**实时求值预览**；2025 版重写了编辑器，补全理解当前节点上下文。
- **Make**：点任意字段弹出 mapping panel，第一个 tab 是上游模块的输出项（可展开嵌套集合），其余 tab 是函数库（文本/日期/数组/数学）；**点一下或拖一下**即插入；同一字段里可以混排「静态文字 + 多个映射值」。
- **Power Automate**：输入框旁「闪电」图标 / 输入 `/` 打开 Dynamic content 面板，选中即插入，底层是 `outputs('X')?['body/ID']` 这类表达式，界面上显示为蓝色 token chip；需要变换时切到 Expression tab（`concat`/`formatDateTime`/`coalesce`），**chip 与表达式共用同一套引用语法**。

> **值得抄的三点**：字段可搜可展开（含嵌套）、插入即 chip（不用看原始表达式）、chip 和手写表达式可混用。

### ② 字段映射表 + 自动匹配（MuleSoft / Boomi / Airbyte）

- **MuleSoft DataSense**：从连接器实时抓取 payload 元数据（字段名、类型、层级），自动**预填** Transform Message 的输入/输出结构；带 `Ctrl+Space` 自动补全；DataSense Explorer 能在设计期预览「某个节点进出时的数据结构」。
- 企业 ETL/iPaaS 普遍有 **auto-map**：按字段名归一化（大小写/下划线/驼峰）+ 类型 + 同义词词典，生成候选映射，人工确认或调整。

> **值得抄的两点**：schema 驱动（不是靠一次运行猜）、自动匹配预填 + 人工确认。

### ③ 表达式/变换语言（DataWeave / JSONata / JMESPath / jq）

| 语言 | 表达力 | 上手成本 | 嵌入成本 | 备注 |
|---|---|---|---|---|
| **JSONata** | 高（过滤、映射、聚合、构造对象、自定义函数） | 中 | 小（~24KB gzip，纯 JS） | Node-RED 内置；语法接近 XPath |
| **JMESPath** | 中（只选择 + 有限函数，不能构造复杂结构） | 低 | 小 | AWS CLI 事实标准；表达力天花板明显 |
| **jq** | 最高（管道、select、group_by、对象构造） | 高 | 大（jq-wasm ~1MB） | 终端用户熟悉，业务用户不友好 |
| **DataWeave** | 高（MuleSoft 专用，含类型系统） | 高 | 不可嵌入 | 绑定生态 |

> **结论**：APIFlow 面向「业务同学 + 智能体」，**不建议**直接暴露 jq/JSONata 全套语法；应从「路径 + 少量函数」起步，复杂变换交给已有的 `transform` 节点。

### ④ 代码节点（Retool Transformers / Windmill / n8n Code）

写 JS，能力最强，但对本产品的目标用户（运营/业务）门槛过高；可作为高级逃生口，不作为主入口。

### ⑤ 表单化映射（按目标 schema 生成表单）

若接口有请求体 schema，直接按 schema 渲染一组输入框，每框配一个「来源选择器」。**认知负担最低**，前提是有 schema —— 目录里只有 `params`（`id/name/method/path/params/...`），**没有 response schema**（`/api/catalog` 实测），需要补。

### ⑥ AI 语义映射（Adeptia / Informatica / Nexadata）

- **Adeptia Automate「AI Mapping Copilot」**：选中源/目标 → 立即给候选映射，可对话改规则（"把 SKU 里的颜色码抽出来映射到 variant"），每条规则给**自然语言说明 + 输入输出样例**；官方口径映射耗时降 75%。
- **Informatica CLAIRE**：基于数百万历史集成模式训练，自动映射把「一周的映射工作压到 5 分钟内」；自然语言直接生成管道。
- **Nexadata**：自然语言写条件映射（if/then/otherwise），执行前生成 **Plan 让人审阅**，可迭代修改。

> **对 APIFlow 特别合适**：本产品已有「接口目录 + 帮助手册 + 运行数据」三重上下文，LLM 生成映射的准确率会比通用工具更高；而且天然可以给每条映射附**中文解释**。

### ⑦ 强契约（typed input/output）

节点声明输入输出类型，编辑器据此校验。最严谨，但要求每个接口都有 schema，落地成本最高，可作为长期方向。

---

## 三、结论：三层组合，主入口是「映射表」

```
┌─ 第 1 层  字段映射表（覆盖 ~80% 场景，默认入口）
│  左：上游输出字段树（可搜、可展开、含数组首元素）   右：目标字段（从 Body schema / 下游 input 契约来）
│  中：点选或拖拽连线；同名/近义字段自动匹配预填；每行右侧显示「上次运行实际取值」
│
├─ 第 2 层  表达式增强（覆盖 ~20% 复杂场景）
│  chip 化插入 + 路径补全 + 小函数库（default/join/map/upper/date/if/number）+ 实时预览 + 死路径告警
│
└─ 第 3 层  自然语言映射（差异化，兜住剩下 5%）
   「把 entity 里的 productName 拼成标题，id 转字符串给 productId」→ 生成映射草稿 + 中文解释 + diff，逐条接受
```

### 3.1 界面草图（映射弹窗改造后）

```
传递数据 · 查询产品类型信息 → 推送通知                     [整包传递] [自定义映射]
┌───────────────────────────────┬──────────────────────────────────────────────┐
│ 上游输出（list_product_v2）    │ 目标字段（notify · body）                     │
│ 🔍 搜索字段                    │ ┌──────────────────────────────────────────┐ │
│ ▾ code            000000      │ │ title      ← {{nodes.list_product_v2…}}  │ │
│ ▾ entity  [3]                 │ │            = "AI企哒"            ⚡ 自动    │ │
│   ▾ 0                         │ │ productId  ← ⚠ 未映射（必填）             │ │
│      productName  AI企哒       │ │ ─────────────────────────────            │ │
│      productId    8812        │ │ + 添加字段                                 │ │
│      price        120         │ └──────────────────────────────────────────┘ │
└───────────────────────────────┴──────────────────────────────────────────────┘
                          [⚡ 按同名自动匹配]  [保存]
```

### 3.2 自动匹配规则（预填，不自动保存）

1. 目标 key 与源字段**完全同名** → 置信度高，勾选；
2. 归一化后同名（`product_id` = `productId` = `ProductID`）→ 勾选；
3. 类型兼容且**同义词典**命中（`title`/`name`/`subject`，`id`/`code`/`no`）→ 提示候选；
4. 以上都不中且配置了模型 → LLM 兜底给候选，附一句中文理由。

### 3.3 DSL 与引擎改动（向后兼容）

- `edge.map` 保持 `{目标字段: 字符串表达式}` 不变（老流程不用迁移）；
- 新增可选 `edge.mapPaths`（或允许 key 用点路径 `"user.name"`）支持嵌套目标；
- 表达式在 `renderStr` 之前先过一层 **`lib/expr.js`**：
  - 语法：`{{path}}`（现状）+ `{{fn(arg, ...)}}`，arg 可为路径、字面量、嵌套函数；
  - 函数最小集（12 个）：`default` `join` `map` `first` `last` `len` `upper` `lower` `trim` `number` `string` `if`；
  - 求值失败不抛错：返回空 + 记 `expr_warn` 事件（解决「静默变空串」）。
- 新增 `GET /api/flows/:id/node-schema?nodeId=X`：优先用**导入时保留的 OpenAPI response schema**，否则用最近 N 次 run 输出**递归推断**（数组取首元素结构，合并多次结果的字段并集）。

### 3.4 分阶段落地

| 阶段 | 内容 | 改动面 | 预估 |
|---|---|---|---|
| **P0** | 字段树（递归 + 搜索 + 点击插入）、目标字段从 Body 现有 key 生成下拉、同名自动匹配一键填充、每行显示上次运行取值 | `app.js` 映射弹窗、`server.js` 加 schema 接口、`style.css` | 1~2 天 |
| **P1** | `lib/expr.js` 小函数库 + 补全 + 实时预览（用最近 run 上下文求值）+ 死路径告警 + 嵌套目标 key | `engine.js`、`dsl.js`（校验）、编辑器 UI | 2~3 天 |
| **P2** | 自然语言生成映射（`POST /api/flows/:id/map-suggest`，复用 agent + 手册检索），返回映射 + 中文解释 + diff，逐条接受 | `lib/agent.js` 新意图、前端 diff 面板 | 3~5 天 |

### 3.5 不建议做的事

- ❌ 引入 jq / JSONata 全语法：包体、安全（用户表达式注入）、学习成本三重负担，收益主要是 5% 的复杂场景；
- ❌ 强制每个节点都声明类型：没有 schema 的接口（大量内部 API）根本填不出来；
- ❌ 自动匹配直接写库不让人确认：映射错了比没映射更难排查（本项目已有「误连比不连更难发现」的先例）。

---

## 四、参考

- n8n Expression Editor（拖拽/pill、补全、实时求值）：https://deepwiki.com/ngocdd/n8n/3.4-expression-editor
- n8n 拖拽字段到表达式（社区讨论）：https://community.n8n.io/t/make-input-pills-default-to-full-json-path-and-automatically-update-in-expressions/82911/7
- Make 映射面板与函数：https://www.make.com/en/help/mapping/mapping.html ｜ https://help.make.com/use-functions
- Power Automate Dynamic content / Expression：https://learn.microsoft.com/power-automate/flows-designer
- MuleSoft DataSense（元数据驱动的映射与补全）：https://docs.mulesoft.com/studio/latest/datasense-concept
- JSONata 官网：https://jsonata.org ｜ JSONPath / jq / JMESPath 对比：https://jsonbeam.com/blog/jsonpath-vs-jq-vs-jmespath
- Adeptia AI Mapping Copilot：https://www.adeptia.com/blog/smarter-data-mapping-with-adeptia-automate
- Informatica CLAIRE 自动映射（7 天 → 5 分钟）：https://www.dian8dian.com/informatica-tong-guo-ai-ji-shu-ge-xin-jie-jue-qi-ye-shu-ju
- Nexadata 自然语言条件映射 + Plan 审阅：https://updates.nexadata.com/116316-mid-fall-2025-platform-update-building-business-logic-with-ai
