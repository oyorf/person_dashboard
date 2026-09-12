---
type: learning-level
project: react-state-management
title: 理解 React 重渲染机制
status: mastered
mastery: 90
verified_by: ai-verified
pass_score: 80
depends_on: []
updated: 2026-09-01T20:00:00+08:00
---

## 知识点笔记

合成演示笔记：状态变更、父组件重渲染、context 值变化都会触发重渲染；memo 可以阻断 props 未变的子树。

## 挑战

合成演示挑战：写一个包含父子组件的计数器 demo，用 React DevTools Profiler 记录一次点击引发的重渲染范围，然后用 memo 优化并对比两份火焰图，提交优化前后的截图说明与关键代码。

## 评分细则

- [30分] 能准确说明触发重渲染的三个条件
- [30分] 提交的代码真实演示了 memo 的阻断效果
- [40分] 对 Profiler 火焰图的对比解释合理
