---
type: learning-level
project: netty
title: Netty 实例：群聊、心跳与 WebSocket
status: locked
mastery: 0
verified_by: none
pass_score: 80
depends_on: [core-components]
source: 60_learning/netty-handbook/_content/chapter06.md
chapter: 第 6 章 Netty 核心模块组件
updated: 2026-09-08T23:00:00+08:00
---

## 知识点笔记

三个综合实例（章节 6.11-6.13）。群聊系统：服务端管理客户端 Channel 集合（如 ChannelGroup），收到消息后转发给其它客户端，并处理上下线广播；心跳检测：IdleStateHandler 在 readerIdleTime/writerIdleTime/allIdleTime 超时时触发 IdleStateEvent，服务端据此踢掉空闲连接或发送心跳包；WebSocket：pipeline 挂 HttpServerCodec 做 HTTP 编解码、ChunkedWriteHandler 支持大数据块、HttpObjectAggregator 聚合分段、WebSocketServerProtocolHandler 完成协议升级，业务 handler 收发 TextWebSocketFrame。

## 挑战

实现 Netty 群聊系统：支持多客户端互发消息、上线/离线广播；在此基础上加入 IdleStateHandler，服务端读空闲 5 秒触发一次处理（打印日志即可）。提交代码与运行说明，并说明每个 handler 加入 pipeline 的顺序为什么重要。

## 评分细则

- [40分] 群聊可运行：多客户端互发、上下线广播均正确
- [30分] 心跳处理器能捕获读空闲事件并执行处理逻辑
- [30分] 能解释 handler 在 pipeline 中的顺序为何影响编解码与事件传播
