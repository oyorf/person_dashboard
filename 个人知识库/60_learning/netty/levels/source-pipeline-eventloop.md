---
type: learning-level
project: netty
title: 源码剖析：Pipeline 调度与 EventLoop
status: locked
mastery: 0
verified_by: none
pass_score: 80
depends_on: [source-startup]
source: 60_learning/netty-handbook/_content/chapter10.md
chapter: 第 10 章 Netty 核心源码剖析
updated: 2026-09-08T23:00:00+08:00
---

## 知识点笔记

Pipeline 源码（10.4-10.5）：ChannelPipeline 内部是以 ChannelHandlerContext 为节点的双向链表，head/tail 是哨兵节点；addLast 会把 handler 包装成 DefaultChannelHandlerContext 挂入链表并触发 handlerAdded 回调；事件传播时入站找下一个 inbound handler，出站反向找 outbound handler。EventLoop 源码（10.7）：每次循环做 select、processSelectedKeys、runAllTasks 三步，ioRatio 控制 I/O 与任务的时间分配。心跳源码（10.6）：IdleStateHandler 注册定时任务周期性检查读写空闲时间。线程池（10.8）：耗时业务应提交到独立线程池（addLast 传 executor 或业务内自行提交），否则阻塞 EventLoop 会拖垮它负责的所有连接。

## 挑战

阅读源码后写笔记回答三个问题：(1) addLast 时 handler 如何被包装并挂入双向链表，handlerAdded 何时触发；(2) EventLoop 一次循环的三步分别是什么，ioRatio 起什么作用；(3) 为什么在 handler 里直接跑耗时操作会影响同一个 EventLoop 上的其它连接，Netty 提供哪两种方式把业务切到别的线程池。笔记中引用具体源码类与方法名。

## 评分细则

- [30分] addLast 挂链与 handlerAdded 触发时机描述准确
- [40分] EventLoop 三步循环与 ioRatio 语义说明正确
- [30分] 能解释 EventLoop 串行处理的因果，并列出两种业务下线方式
