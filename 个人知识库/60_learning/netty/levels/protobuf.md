---
type: learning-level
project: netty
title: 编解码与 Protobuf
status: locked
mastery: 0
verified_by: none
pass_score: 80
depends_on: [netty-model-async]
source: 60_learning/netty-handbook/_content/chapter07.md
chapter: 第 7 章 Google Protobuf
updated: 2026-09-08T23:00:00+08:00
---

## 知识点笔记

网络传输的是字节，对象收发必须做编解码（序列化）。Java 自带 Serializable 的缺点：无法跨语言、序列化后体积大、性能差。Protobuf 是 Google 的跨语言高效序列化方案：用 .proto 文件定义消息结构，protoc 生成各语言代码，二进制编码紧凑高效。Netty 集成方式是 pipeline 挂 ProtobufDecoder（需指定目标类型）与 ProtobufEncoder；传输多种类型消息时通常加一层枚举/类型字段做分发（章节 7.1-7.5）。

## 挑战

完成两个 Protobuf 实例：(1) 单类型消息收发——定义 Student POJO 的 .proto，客户端编码发送、服务端解码打印；(2) 复合消息收发——用 MessageType 枚举区分 Student/Worker 两种消息，服务端按类型分发处理。提交 .proto 文件、收发代码与运行日志。

## 评分细则

- [30分] .proto 定义正确，能生成并调用 Java 代码
- [40分] 复合消息实例可运行，服务端能按类型正确解码分发
- [30分] 能解释 Protobuf 相对 Java 自带序列化的三个优势
