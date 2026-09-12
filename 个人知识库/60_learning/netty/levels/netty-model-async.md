---
type: learning-level
project: netty
title: Netty 线程模型与异步机制
status: locked
mastery: 0
verified_by: none
pass_score: 80
depends_on: [nio-core, reactor-model]
source: 60_learning/netty-handbook/_content/chapter05.md
chapter: 第 5 章 Netty 高性能架构设计
updated: 2026-09-08T23:00:00+08:00
---

## 知识点笔记

Netty 基于主从 Reactor 多线程模型做了改进：BossGroup 专门接收客户端连接，WorkerGroup 专门负责网络读写，两者都是 NioEventLoopGroup，内部含多个 NioEventLoop；每个 NioEventLoop 有独立 Selector，循环做三件事：轮询 I/O 事件、处理 I/O 事件、runAllTasks 处理任务队列。业务处理走 pipeline。异步模型基于 Future-Listener：I/O 操作立即返回 ChannelFuture，通过监听器异步拿到结果。TaskQueue 有三种典型场景：用户自定义普通任务、定时任务、其它线程提交的任务（章节 5.8-5.10）。

## 挑战

完成 Netty 快速入门 TCP 实例：服务端监听 6668，客户端发送 "hello,服务器~"，服务端回复 "hello,客户端~"；再改造成 HTTP 服务（浏览器访问返回文本）。提交代码，并在代码注释或笔记中标注 Boss/Worker EventLoop 的三步循环分别对应程序里的哪些环节。

## 评分细则

- [30分] TCP 实例可运行，客户端与服务端双向收发正确
- [20分] HTTP 服务可被浏览器正常访问
- [30分] 能把 BossGroup/WorkerGroup 的职责与 EventLoop 三步循环映射到自己的代码
- [20分] 能解释 channelRead 是异步事件回调，而不是线程阻塞等待数据
