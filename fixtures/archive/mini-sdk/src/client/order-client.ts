/**
 * 订单客户端 —— 压缩包导入测试用
 */
export class OrderClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
  }
  async request(method, path, body) {
    const res = await fetch(this.baseUrl + path, { method, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}`);
    return res.json();
  }
  /** 查询订单详情 */
  async getOrder(orderNo: string) {
    return this.request('GET', `/orders/${orderNo}`);
  }
  /** 创建订单 */
  async createOrder(input: { sku: string; qty: number }) {
    return this.request('POST', '/orders', input);
  }
  /** 取消订单 */
  async cancelOrder(orderNo: string) {
    return this.request('DELETE', `/orders/${orderNo}`);
  }
}
