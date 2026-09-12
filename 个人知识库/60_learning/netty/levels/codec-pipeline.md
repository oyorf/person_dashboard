---
type: learning-level
project: netty
title: 编解码器与 Handler 链调用机制
status: locked
mastery: 0
verified_by: none
pass_score: 80
depends_on: [core-components]
source: 60_learning/netty-handbook/_content/chapter08.md
chapter: 第 8 章 Netty 编解码器和 Handler 调用机制
updated: 2026-09-08T23:00:00+08:00
---

## 知识点笔记

编解码器本质也是 handler：解码器继承 ChannelInboundHandler，编码器继承 ChannelOutboundHandler。ByteToMessageDecoder 处理入站字节流，decode 方法在数据到达时可能被多次调用，解码结果放入 List 才会传给下一个 handler；ReplayingDecoder 继承它，内部处理了缓冲区可读性检查，代码更简洁但有限制。MessageToByteEncoder 负责出站编码。handler 链调用机制：入站事件从链头向链尾传播，出站事件反向，可以通过 ChannelHandlerContext 精确控制传播位置（章节 8.1-8.6）。

## 挑战

实现自定义编解码：客户端连续发送 long 数据，自定义 MyByteToLongDecoder 解码、服务端打印；再实现出站方向 MessageToByteEncoder<Long> 编码发送。提交代码，并画一张顺序图：数据从 Socket 到业务 handler 经过了哪些 handler、入站与出站各是什么方向。

## 评分细则

- [30分] 自定义编解码器可运行，数据收发无丢失
- [40分] 顺序图正确区分入站/出站方向，且 handler 顺序与实际 pipeline 一致
- [30分] 能解释 ByteToMessageDecoder 的 decode 为什么可能被调用多次（数据可能分次到达）
