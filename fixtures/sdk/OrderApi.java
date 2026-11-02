package com.demo.order;

import retrofit2.Call;
import retrofit2.http.*;

/** 订单中心 Java SDK（Retrofit 风格） */
public interface OrderApi {
    /** 查询订单详情 */
    @GET("orders/{orderNo}")
    Call<Order> getOrder(@Path("orderNo") String orderNo);

    /** 按日期查询订单 */
    @GET("orders")
    Call<List<Order>> listOrders(@Query("date") String date);

    /** 创建订单 */
    @POST("orders")
    Call<Order> createOrder(@Body CreateOrderReq req);

    /** 取消订单 */
    @PATCH("orders/{orderNo}/cancel")
    Call<Order> cancelOrder(@Path("orderNo") String orderNo);
}
