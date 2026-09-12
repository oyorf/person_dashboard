---
type: learning-level
project: react-state-management
title: 用 Zustand 搭建可测试的全局 store
status: locked
mastery: 0
verified_by: none
pass_score: null
depends_on: [context-basics]
updated: 2026-09-01T20:00:00+08:00
---

## 知识点笔记

合成演示笔记：Zustand 的 selector 订阅与 shallow 比较是性能关键；store 可以在 React 外单测。

## 挑战

合成演示挑战：为一个待办应用实现 Zustand store（含派生 selector 与异步 action），并为异步 action 编写不依赖 React 的单元测试，提交 store 代码与测试运行输出。

## 评分细则

- [30分] store 结构清晰，action 命名语义化
- [30分] selector 使用 shallow 避免无效重渲染
- [40分] 异步 action 的单元测试真实可运行
