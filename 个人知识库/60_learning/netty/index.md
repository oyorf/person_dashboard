---
type: learning-project
title: Netty 网络编程闯关
slug: netty
description: 基于第三方开源文档 netty-handbook 的学习闯关地图：从 Java IO 模型与 NIO 三件套，到 Netty 线程模型、编解码、源码剖析与手写 RPC。
created: 2026-09-08T23:00:00+08:00
sources: [60_learning/netty-handbook/_content/chapter01.md, 60_learning/netty-handbook/_content/chapter02.md, 60_learning/netty-handbook/_content/chapter03.md, 60_learning/netty-handbook/_content/chapter04.md, 60_learning/netty-handbook/_content/chapter05.md, 60_learning/netty-handbook/_content/chapter06.md, 60_learning/netty-handbook/_content/chapter07.md, 60_learning/netty-handbook/_content/chapter08.md, 60_learning/netty-handbook/_content/chapter09.md, 60_learning/netty-handbook/_content/chapter10.md, 60_learning/netty-handbook/_content/chapter11.md]
levels: [io-models, nio-core, nio-zero-copy, reactor-model, netty-model-async, core-components, netty-practice, protobuf, codec-pipeline, tcp-sticky, source-startup, source-pipeline-eventloop, diy-rpc]
progress: {"total":13,"mastered":0,"percent":0}
---

# Netty 网络编程闯关

学习资料为第三方开源项目 [dongzl/netty-handbook](https://github.com/dongzl/netty-handbook) 的 docs 目录（Apache-2.0），原文已拷贝至 `60_learning/netty-handbook/`，本项目的关卡笔记与挑战是基于该公开文档整理的学习导引，并非原文复述。

路线：IO 模型 → NIO 三件套与零拷贝 → Reactor 与 Netty 线程模型 → 核心组件与实例 → 编解码与粘包拆包 → 源码剖析 → 手写 RPC 收官。

每个关卡可用应用内 AI 验证，也可以点「Codex 对话校验」把考核提示词粘贴到 Codex 对话中，由 Codex 对照原文逐题考察。
