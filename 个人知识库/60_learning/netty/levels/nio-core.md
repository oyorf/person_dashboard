---
type: learning-level
project: netty
title: NIO 三大组件：Buffer、Channel、Selector
status: locked
mastery: 0
verified_by: none
pass_score: 80
depends_on: [io-models]
source: 60_learning/netty-handbook/_content/chapter03.md
chapter: 第 3 章 Java NIO 编程
updated: 2026-09-08T23:00:00+08:00
---

## 知识点笔记

NIO 面向缓冲区编程，三大核心是 Selector、Channel、Buffer，三者关系是一个线程通过 Selector 管理多个 Channel，每个 Channel 对应一个 Buffer，数据的读写都经由 Buffer。Buffer 本质是内存块，靠 position、limit、capacity 维护状态，写转读要 flip()。Channel 是双向通道（BIO 的流是单向的），FileChannel 可完成本地文件读写与 transferFrom 拷贝。Selector 监听注册在其上的 Channel 事件，使单线程能处理多连接（章节 3.1-3.12）。

## 挑战

完成两组练习：(1) 用 FileChannel + ByteBuffer 分别实现写文件、读文件、用一个 Buffer 完成「读出再写入另一文件」；(2) 用 ServerSocketChannel + Selector 实现非阻塞收发：服务端单线程处理多个客户端消息。提交代码，并记录其中一个练习执行过程中 ByteBuffer 的 position/limit 变化。

## 评分细则

- [30分] 三个 FileChannel 练习均可运行且结果正确
- [30分] 能解释 flip() 前后 position 与 limit 的变化，以及为什么写转读必须调用它
- [40分] Selector 版收发程序可运行，服务端单线程正确处理多个客户端
