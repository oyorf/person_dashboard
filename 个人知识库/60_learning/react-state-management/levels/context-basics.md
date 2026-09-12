---
type: learning-level
project: react-state-management
title: 用 Context 分层共享状态
status: mastered
mastery: 100
verified_by: self-assessed
pass_score: null
depends_on: [react-rerender]
updated: 2026-09-08T08:01:03.781Z
---

## 知识点笔记

合成演示笔记：Context 适合低频变更的跨层数据；Provider 嵌套顺序影响订阅范围。

## 挑战

合成演示挑战：实现一个主题 + 用户会话的双 Provider 应用，故意制造一次「context 值变化导致全树重渲染」的问题，再用拆分 Provider 的方式修复，提交问题复现与修复后的代码。

## 评分细则

- [40分] 双 Provider 结构正确且职责分离
- [30分] 问题复现可运行、现象描述准确
- [30分] 修复方案解释了订阅范围变化
