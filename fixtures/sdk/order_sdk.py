"""订单中心 Python SDK"""
BASE_URL = "https://api.demo-shop.com/v1"


class OrderClient:
    def get_order(self, order_no):
        """查询订单详情"""
        return self._request("GET", f"/orders/{order_no}")

    def list_orders(self, date, page=1):
        """按日期查询订单列表"""
        return self._request("GET", f"/orders?date={date}&page={page}")

    def refund_order(self, order_no, amount):
        """订单退款（写操作）"""
        return self._request("POST", f"/orders/{order_no}/refund", json={"amount": amount})
