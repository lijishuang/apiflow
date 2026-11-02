/** 订单中心 TypeScript SDK v1.2.0 */
export const BASE_URL = 'https://api.demo-shop.com/v1';

export class OrderClient {
  /**
   * 查询订单详情
   * 返回金额、状态与收货信息
   */
  async getOrder(orderNo: string): Promise<Order> {
    return this.request('GET', `/orders/${orderNo}`);
  }

  /** 按日期查询订单列表 */
  async listOrders(date: string, page = 1) {
    return this.request('GET', `/orders?date=${date}&page=${page}`);
  }

  /** 创建订单 */
  async createOrder(body: CreateOrderReq) {
    return this.request('POST', '/orders', body);
  }

  /** 取消订单 */
  async cancelOrder(orderNo: string) {
    return this.request('PATCH', `/orders/${orderNo}/cancel`, { reason: 'user' });
  }

  /** 查询物流轨迹 */
  async queryLogistics(orderNo: string) {
    return axios.get(`/orders/${orderNo}/logistics`);
  }
}
