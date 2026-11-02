/**
 * 计费客户端
 */
export class BillingClient {
  constructor(private baseUrl: string) {}
  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(this.baseUrl + path, { method: 'POST', body: JSON.stringify(body) });
    return res.json() as Promise<T>;
  }
  /** 创建支付单 */
  async createPayment(orderNo: string, amount: number) {
    return this.post('/payments', { orderNo, amount });
  }
  /** 查询支付结果 */
  async getPayment(paymentId: string) {
    const res = await fetch(`${this.baseUrl}/payments/${paymentId}`, { method: 'GET' });
    return res.json();
  }
  /** 发起退款 */
  async refundPayment(paymentId: string) {
    return this.post(`/payments/${paymentId}/refund`, {});
  }
}
