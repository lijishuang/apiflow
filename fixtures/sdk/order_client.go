package order

import "net/http"

// Client 订单中心 Go SDK
type Client struct{ baseURL string }

// GetOrder 查询订单详情
func (c *Client) GetOrder(orderNo string) (*Order, error) {
	req, err := http.NewRequest("GET", "/orders/"+orderNo, nil)
	if err != nil {
		return nil, err
	}
	return c.send(req)
}

// ListOrders 按日期查询订单列表
func (c *Client) ListOrders(date string) ([]Order, error) {
	req, err := http.NewRequest("GET", "/orders?date="+date, nil)
	if err != nil {
		return nil, err
	}
	return c.sendAll(req)
}

// SyncStock 同步库存到仓储
func (c *Client) SyncStock(sku string, qty int) (*Result, error) {
	req, err := http.NewRequest("POST", fmt.Sprintf("/stock/%s/sync", sku), nil)
	if err != nil {
		return nil, err
	}
	return c.send(req)
}
