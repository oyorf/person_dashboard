---
type: learning-level
project: netty
title: Netty 核心组件 API
status: locked
mastery: 0
verified_by: none
pass_score: 80
depends_on: [netty-model-async]
source: 60_learning/netty-handbook/_content/chapter06.md
chapter: 第 6 章 Netty 核心模块组件
updated: 2026-09-08T23:00:00+08:00
---

## 知识点笔记

核心组件速览（章节 6.1-6.10）：Bootstrap/ServerBootstrap 是引导类，串联线程组、channel 类型、handler 与选项配置；ChannelFuture 关联异步操作结果，可加监听器；Channel 封装连接与 I/O 操作；Selector 即 NIO 选择器，Netty 基于它做事件驱动；ChannelHandler 分入站/出站，处理业务逻辑；ChannelPipeline 是 handler 双向链，请求按链传播；ChannelHandlerContext 携带上下文，用于在链中传递事件或跳过其余 handler 直接写出；ChannelOption 配置 TCP 参数；NioEventLoopGroup/NioEventLoop 是线程模型落地；Unpooled 是操作 ByteBuf 的工具类。

## 挑战

写一份「组件速查表」笔记：覆盖 Bootstrap、ChannelFuture、Channel、ChannelHandler、Pipeline、ChannelHandlerContext、EventLoopGroup、Unpooled，每个组件一句话职责加上你在入门实例中对应的代码位置；再用 Unpooled.copiedBuffer 写一个 ByteBuf 读写演示（含中文），记录 readerIndex/writerIndex 的变化。

## 评分细则

- [30分] 速查表覆盖全部八个组件且职责描述准确
- [40分] 每个组件都能映射到自己代码中的具体位置，不是背概念
- [30分] ByteBuf 演示可运行，readerIndex/writerIndex 变化说明正确
