---
type: learning-level
project: netty
title: NIO 群聊系统与零拷贝
status: locked
mastery: 0
verified_by: none
pass_score: 80
depends_on: [nio-core]
source: 60_learning/netty-handbook/_content/chapter03.md
chapter: 第 3 章 Java NIO 编程
updated: 2026-09-08T23:00:00+08:00
---

## 知识点笔记

零拷贝是从操作系统角度看的优化：CPU 不执行数据从一个存储区到另一个存储区的拷贝。传统 IO 读写有 4 次数据拷贝、4 次用户态/内核态上下文切换；mmap 通过内存映射让内核缓冲与用户空间共享，减少一次拷贝；sendFile 让数据在内核间直接传输（Linux 2.4 后配合 gather 只需 2 次拷贝、2 次切换），不经过用户态。NIO 的 transferTo 底层就是 sendFile，这就是 Netty 大数据传输场景高效的原因之一。NIO 群聊系统则用 Selector 实现消息的接收与转发（章节 3.13-3.14）。

## 挑战

完成 NIO 群聊系统：服务端接收客户端消息并转发给其它在线客户端，客户端读写分离（主线程发送、独立线程接收）。另写一份零拷贝笔记：用表格对比传统 IO、mmap、sendFile 三种方案的拷贝次数与上下文切换次数，并说明各自适用场景。

## 评分细则

- [40分] 群聊系统可运行：多客户端互发消息、上下线有提示
- [30分] 零拷贝对比表准确（拷贝次数、切换次数、mmap 与 sendFile 的差异）
- [30分] 能说明 transferTo 与零拷贝的关系，以及它在大文件传输中的意义
