// ── 并行批跑：多个流程同时执行（受限并发池 + 可取消 + 可观测）──
// 单流程内部的分支并发由引擎的边推进（Promise.all）负责；
// 这里解决的是「多个流程之间」的并行：一次提交 N 个流程，按并发度同时跑。
const crypto = require('crypto');

const MAX_CONCURRENCY = 8;    // 单批次最大并发（保护上游与事件循环）
const MAX_FLOWS = 50;         // 单批次最多流程数
const KEEP_BATCHES = 30;      // 内存里保留的批跑记录数

class BatchRunner {
  constructor(engine, store) {
    this.engine = engine;
    this.store = store;
    this.batches = new Map();   // id -> 内部批次对象
    this.order = [];            // 批次 id，最新在前
  }

  // 把内部批次整理成给前端/接口的只读快照
  snapshot(b) {
    const items = b.items.map(i => ({ ...i }));
    const pick = st => items.filter(i => i.status === st).length;
    const ended = items.filter(i => ['success', 'failed', 'cancelled', 'skipped'].includes(i.status)).length;
    const sumMs = items.reduce((a, i) => a + (i.durationMs || 0), 0);
    const wallMs = b.startedAt ? (b.endedAt || Date.now()) - b.startedAt : null;
    return {
      id: b.id,
      status: b.status === 'running' && b.cancelRequested ? 'cancelling' : b.status,   // running | cancelling | done | cancelled
      concurrency: b.concurrency,
      input: b.input || null,
      createdAt: b.createdAt,
      startedAt: b.startedAt,
      endedAt: b.endedAt || null,
      durationMs: wallMs,
      total: items.length,
      done: ended,
      success: pick('success'),
      failed: pick('failed'),
      cancelled: pick('cancelled'),
      skipped: pick('skipped'),
      running: pick('running'),
      queued: pick('queued'),
      peakConcurrency: b.peak,                // 实际达到的最大同时在跑数
      // 串行耗时之和 ÷ 实际墙钟耗时 = 并行加速比
      speedup: wallMs && sumMs ? +(sumMs / wallMs).toFixed(2) : null,
      items,
    };
  }

  list() { return this.order.map(id => this.batches.get(id)).filter(Boolean).map(b => this.snapshot(b)); }
  get(id) { const b = this.batches.get(id); return b ? this.snapshot(b) : null; }

  /**
   * 启动一批并行运行。
   * ids:        流程 id 数组（自动去重）
   * concurrency:同时执行的流程数，1 即退化为串行
   * input:      统一输入覆盖（不传则各自用流程发布时的 input.sample）
   */
  start(ids, opts = {}) {
    const flowIds = [...new Set((ids || []).filter(x => typeof x === 'string' && x))].slice(0, MAX_FLOWS);
    if (!flowIds.length) throw Object.assign(new Error('未指定要运行的流程'), { status: 400 });
    const concurrency = Math.min(MAX_CONCURRENCY, Math.max(1, Math.floor(Number(opts.concurrency) || 3)));
    const input = opts.input && typeof opts.input === 'object' && Object.keys(opts.input).length ? opts.input : null;

    const items = flowIds.map(flowId => {
      const f = this.store.getFlow(flowId);
      return {
        flowId,
        flowName: (f && f.name) || flowId,
        version: f && f.published ? f.published.version : 0,
        status: 'queued',
        runId: null, num: null,
        startedAt: null, endedAt: null, durationMs: null,
        error: null,
      };
    });

    const b = {
      id: 'batch_' + crypto.randomBytes(5).toString('hex'),
      status: 'running',
      concurrency,
      input,
      createdAt: Date.now(),
      startedAt: Date.now(),
      endedAt: null,
      items,
      inflight: 0,
      peak: 0,
      cancelRequested: false,
    };
    this.batches.set(b.id, b);
    this.order.unshift(b.id);
    while (this.order.length > KEEP_BATCHES) this.batches.delete(this.order.pop());

    this._drive(b);   // 不 await：接口立刻返回批次 id，前端轮询进度
    return this.snapshot(b);
  }

  cancel(batchId) {
    const b = this.batches.get(batchId);
    if (!b) return null;
    if (b.status !== 'running') return this.snapshot(b);
    b.cancelRequested = true;
    // 还没开始的直接取消；正在跑的流程不打断（避免写操作半途中断留下脏数据）
    for (const i of b.items) if (i.status === 'queued') { i.status = 'cancelled'; i.endedAt = Date.now(); }
    if (b.inflight === 0) this._settle(b);
    return this.snapshot(b);
  }

  _settle(b) {
    b.status = b.cancelRequested ? 'cancelled' : 'done';
    b.endedAt = Date.now();
  }

  // 并发池：n 个 worker 共享游标，每个 worker 取一个流程跑完再取下一个
  async _drive(b) {
    const queue = b.items.filter(i => i.status === 'queued');
    let cursor = 0;
    const worker = async () => {
      while (cursor < queue.length) {
        if (b.cancelRequested) return;
        const item = queue[cursor++];
        if (!item || item.status !== 'queued') continue;
        await this._runItem(b, item);
      }
    };
    await Promise.all(Array.from({ length: Math.min(b.concurrency, queue.length) }, worker));
    for (const i of b.items) if (i.status === 'queued') i.status = b.cancelRequested ? 'cancelled' : 'skipped';
    this._settle(b);
  }

  async _runItem(b, item) {
    item.status = 'running';
    item.startedAt = Date.now();
    b.inflight++;
    b.peak = Math.max(b.peak, b.inflight);
    try {
      const f = this.store.getFlow(item.flowId);
      if (!f) throw new Error('流程不存在（可能已被删除）');
      if (!f.published) throw new Error('流程未发布');
      const def = { ...f.published.def, version: f.published.version };
      const input = b.input || (def.input && def.input.sample) || {};
      const run = await this.engine.runFlow(def, input, { trigger: 'batch' });
      item.runId = run.id;
      item.num = run.num;
      item.status = run.status === 'success' ? 'success' : 'failed';
      item.error = run.error || null;
    } catch (e) {
      item.status = 'failed';
      item.error = String((e && e.message) || e);
    } finally {
      b.inflight--;
      item.endedAt = Date.now();
      item.durationMs = item.startedAt ? item.endedAt - item.startedAt : null;
    }
  }
}

module.exports = { BatchRunner, MAX_CONCURRENCY, MAX_FLOWS };
