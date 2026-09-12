---
type: learning-level
project: netty
title: 线程模型演进与 Reactor 三种形态
status: locked
mastery: 0
verified_by: none
pass_score: 80
depends_on: [io-models]
source: 60_learning/netty-handbook/_content/chapter05.md
chapter: 第 5 章 Netty 高性能架构设计
updated: 2026-09-08T23:00:00+08:00
---

## 知识点笔记

原生 NIO 的痛点：类库 API 繁杂、要自行处理断连重连/半包粘包、epoll 空轮询 bug 等（第 4 章）。线程模型从传统阻塞 IO 演进到 Reactor 模式：I/O 复用结合线程池，核心角色是 Reactor（监听分发事件）、Acceptor（处理连接）、Handler（处理业务）。三种形态：单 Reactor 单线程（实现简单，无法发挥多核，Handler 阻塞会拖垮全局）；单 Reactor 多线程（业务交给线程池，但 Reactor 单线程处理所有 I/O 仍是瓶颈）；主从 Reactor 多线程（Boss 只管 accept，Worker 池处理读写，Netty 模型的基础）。

## 挑战

不写代码，做一次结构化梳理：用三张自绘图或一张对比表说明三种 Reactor 形态的线程分工（谁 accept、谁 read/write、谁处理业务）、各自的瓶颈与适用场景，最后解释为什么 Netty 选择主从 Reactor 多线程作为基础模型。提交 Markdown 笔记。

## 评分细则

- [30分] 三种形态的角色分工（Acceptor/Reactor/Handler/Worker 线程池）描述准确
- [40分] 能指出单 Reactor 多线程的瓶颈是 Reactor 单线程处理所有连接的 I/O
- [30分] 能从 Netty 视角说明主从模式把 accept 与 read/write 拆到两组线程的意义
