---
type: learning-level
project: netty
title: 源码剖析：启动与接受请求
status: locked
mastery: 0
verified_by: none
pass_score: 80
depends_on: [netty-practice]
source: 60_learning/netty-handbook/_content/chapter10.md
chapter: 第 10 章 Netty 核心源码剖析
updated: 2026-09-08T23:00:00+08:00
---

## 知识点笔记

启动主线（10.2）：ServerBootstrap.bind() → initAndRegister（通过反射工厂创建 NioServerSocketChannel、初始化其 pipeline 并加入 ServerBootstrapAcceptor）→ 注册到 BossGroup 的 EventLoop → doBind0 完成端口绑定。接受请求主线（10.3）：BossGroup 的 NioEventLoop 轮询到 OP_ACCEPT 后，NioServerSocketChannel 读取连接创建 NioSocketChannel，事件沿 pipeline 传播到 ServerBootstrapAcceptor.channelRead，由它给 child channel 配置 handler 并注册到 WorkerGroup 的某个 EventLoop 上。

## 挑战

用 IDE 调试器跟踪一次服务端「启动 → 接收到首个客户端连接」的完整过程，记录关键断点调用栈（至少覆盖 initAndRegister、doBind0、ServerBootstrapAcceptor.channelRead），整理成一份时序笔记，说明 NioSocketChannel 从创建到注册进 WorkerGroup 的每一步。

## 评分细则

- [30分] 时序笔记准确覆盖 initAndRegister 与 doBind0 的职责
- [40分] 能说清 NioSocketChannel 如何经由 ServerBootstrapAcceptor 注册到 WorkerGroup
- [30分] 调用栈记录完整、可复现（断点位置与方法名准确）
