---
type: learning-level
project: netty
title: TCP 粘包与拆包
status: locked
mastery: 0
verified_by: none
pass_score: 80
depends_on: [codec-pipeline]
source: 60_learning/netty-handbook/_content/chapter09.md
chapter: 第 9 章 TCP 粘包和拆包及解决方案
updated: 2026-09-08T23:00:00+08:00
---

## 知识点笔记

TCP 是流协议，传输的数据像水流，没有消息边界，接收端一次可能读到多条消息（粘包）或半条消息（拆包）。根本原因是 TCP 面向字节流、存在发送缓冲与滑动窗口机制。解决思路都是让接收端能确定报文边界：固定长度（FixedLengthFrameDecoder）、特殊分隔符（DelimiterBasedFrameDecoder）、按行（LineBasedFrameDecoder），最通用的是自定义协议——报文头放长度字段，按长度读取内容（章节 9.1-9.4）。

## 挑战

分两步：(1) 复现粘包——客户端连续快速发送 10 条消息，服务端统计 channelRead 触发次数与内容，观察合并现象；(2) 解决——定义 MessageProtocol 协议类（长度 int + 内容 byte[]），自定义编码器与解码器（基于 ByteToMessageDecoder），验证服务端逐条收到完整消息。提交前后两份代码与服务端输出对比。

## 评分细则

- [30分] 成功复现粘包现象并截图/记录服务端输出
- [40分] 自定义协议解码器正确处理粘包与半包（长度不足时等待后续数据）
- [30分] 能解释为什么「长度字段」方案比定长、分隔符更通用
