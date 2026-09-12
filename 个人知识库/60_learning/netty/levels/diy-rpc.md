---
type: learning-level
project: netty
title: 手写 RPC：用 Netty 实现 Dubbo
status: locked
mastery: 0
verified_by: none
pass_score: 80
depends_on: [tcp-sticky, protobuf, source-pipeline-eventloop]
source: 60_learning/netty-handbook/_content/chapter11.md
chapter: 第 11 章 用 Netty 自己实现 Dubbo RPC
updated: 2026-09-08T23:00:00+08:00
---

## 知识点笔记

RPC 的核心是让远程调用像本地调用一样透明（11.1-11.3）：客户端不直接发网络请求，而是通过动态代理把接口方法调用封装成调用信息（类名、方法名、参数类型、参数值），经自定义协议编码后由 Netty 发送到服务端；服务端解码后通过反射调用本地实现类，把结果回写客户端，代理把返回值交还调用方。这一章是前面所有内容的综合运用：线程模型、编解码、自定义协议、Netty 网络通信（11.4）。

## 挑战

实现最小可用 RPC：公共模块定义 HelloService 接口与 Invocation 协议类（类名、方法名、参数类型、参数值）；服务端用 Netty 接收 Invocation、反射调用本地实现、回写结果；消费端用动态代理把接口调用转成 Invocation 发送，并阻塞/异步等待返回值，最终像调用本地方法一样拿到 "hello netty" 结果。提交全部代码与一次完整调用的日志。

## 评分细则

- [30分] Invocation 协议设计完整（方法签名与参数足以支撑服务端反射调用）
- [40分] 客户端动态代理与服务端反射调用链路完整可运行
- [30分] 能指出该实现距离生产级 RPC 框架还差什么（超时、重试、注册中心、连接管理等至少三点）
