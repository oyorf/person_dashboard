import { useEffect, useMemo, useRef, useState } from "react";
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
} from "d3-force";

const NODE_RADIUS = 22;
const PAD_X = 90;
const PAD_TOP = 48;
const PAD_BOTTOM = 64;
const LABEL_FONT_SIZE = 11;

function nodeClass(level) {
  if (level.effectiveStatus === "mastered" && level.verifiedBy === "self-assessed") return "quest-node quest-node--self";
  return `quest-node quest-node--${level.effectiveStatus}`;
}

// 估算标题宽度（CJK 约等于字号，ASCII 约 0.6 倍字号），碰撞半径要覆盖标签而不仅是圆点
function labelHalfWidth(title) {
  let width = 0;
  for (const char of String(title)) {
    width += char.charCodeAt(0) < 128 ? LABEL_FONT_SIZE * 0.6 : LABEL_FONT_SIZE;
  }
  return width / 2;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

// 依赖 DAG 的最长路径深度，用于把关卡按"学习阶段"分层摆放
function computeDepths(levels) {
  const bySlug = new Map(levels.map((level) => [level.slug, level]));
  const memo = new Map();
  const depth = (slug, trail) => {
    if (memo.has(slug)) return memo.get(slug);
    if (trail.has(slug)) return 0; // 环保护：schema 层已做环检测，这里兜底
    trail.add(slug);
    const deps = bySlug.get(slug)?.dependsOn ?? [];
    const value = deps.length ? 1 + Math.max(...deps.map((dep) => depth(dep, new Set(trail)))) : 0;
    memo.set(slug, value);
    return value;
  };
  for (const level of levels) depth(level.slug, new Set());
  return memo;
}

export function QuestMap({ levels, onSelect }) {
  const containerRef = useRef(null);
  const svgRef = useRef(null);
  const simulationRef = useRef(null);
  const dragRef = useRef(null); // { id, moved }
  const suppressClickRef = useRef(false);
  const [size, setSize] = useState({ width: 900, height: 560 });
  const [positions, setPositions] = useState([]);

  const depthBySlug = useMemo(() => computeDepths(levels), [levels]);
  const maxDepth = useMemo(
    () => Math.max(0, ...depthBySlug.values()),
    [depthBySlug],
  );
  // 层数多时加高容器，避免纵向挤压
  const desiredHeight = Math.max(560, (maxDepth + 1) * 108 + PAD_BOTTOM);

  const nodes = useMemo(
    () => levels.map((level) => ({ id: level.slug, level, labelHalf: labelHalfWidth(level.title) })),
    [levels],
  );
  const links = useMemo(
    () => levels.flatMap((level) => level.dependsOn.map((source) => ({ source, target: level.slug }))),
    [levels],
  );

  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => {
      setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const layerGap = maxDepth === 0 ? 0 : (size.height - PAD_TOP - PAD_BOTTOM) / maxDepth;
    const simulation = forceSimulation(nodes)
      .force("link", forceLink(links).id((node) => node.id).distance(110))
      .force("charge", forceManyBody().strength(-120))
      .force("collide", forceCollide((node) => Math.max(NODE_RADIUS + 10, node.labelHalf + 8)))
      .force("y", forceY((node) => PAD_TOP + (depthBySlug.get(node.id) ?? 0) * layerGap).strength(0.95))
      .force("x", forceX(size.width / 2).strength(0.05));
    simulationRef.current = simulation;
    simulation.on("tick", () => {
      setPositions(nodes.map((node) => ({
        id: node.id,
        x: Math.min(Math.max(node.x, PAD_X), size.width - PAD_X),
        y: Math.min(Math.max(node.y, PAD_TOP), size.height - PAD_BOTTOM),
        level: node.level,
      })));
    });
    return () => {
      simulation.stop();
      simulationRef.current = null;
    };
  }, [nodes, links, size, depthBySlug, maxDepth]);

  const positionById = new Map(positions.map((entry) => [entry.id, entry]));

  const localPoint = (event) => {
    const rect = svgRef.current.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const startDrag = (event, id) => {
    const node = nodes.find((entry) => entry.id === id);
    if (!node || !svgRef.current) return;
    event.preventDefault();
    dragRef.current = { id, moved: false };
    node.fx = node.x;
    node.fy = node.y;
    simulationRef.current?.alphaTarget(0.2).restart();
    svgRef.current.setPointerCapture(event.pointerId);
  };

  const moveDrag = (event) => {
    const drag = dragRef.current;
    if (!drag) return;
    const node = nodes.find((entry) => entry.id === drag.id);
    if (!node) return;
    const point = localPoint(event);
    node.fx = clamp(point.x, PAD_X, size.width - PAD_X);
    node.fy = clamp(point.y, PAD_TOP, size.height - PAD_BOTTOM);
    drag.moved = true;
  };

  const endDrag = () => {
    const drag = dragRef.current;
    if (!drag) return;
    if (drag.moved) suppressClickRef.current = true;
    dragRef.current = null;
    // 保留 fx/fy：节点停在拖到的位置，避免标签再次叠回去
    simulationRef.current?.alphaTarget(0);
  };

  return (
    <div ref={containerRef} className="quest-map" role="img" aria-label="闯关地图" style={{ height: desiredHeight }}>
      <svg
        ref={svgRef}
        width={size.width}
        height={size.height}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        {links.map((link, index) => {
          const source = positionById.get(typeof link.source === "object" ? link.source.id : link.source);
          const target = positionById.get(typeof link.target === "object" ? link.target.id : link.target);
          if (!source || !target) return null;
          const open = source.level.effectiveStatus === "mastered";
          return (
            <line
              key={index}
              className={open ? "quest-edge quest-edge--open" : "quest-edge"}
              x1={source.x} y1={source.y} x2={target.x} y2={target.y}
            />
          );
        })}
        {positions.map((entry) => (
          <g
            key={entry.id}
            className={nodeClass(entry.level)}
            transform={`translate(${entry.x},${entry.y})`}
            onPointerDown={(event) => startDrag(event, entry.id)}
            onClick={() => {
              // 拖拽结束后 click 会紧跟触发，拖动过就不当点击处理
              if (suppressClickRef.current) {
                suppressClickRef.current = false;
                return;
              }
              onSelect(entry.level);
            }}
          >
            <circle r={NODE_RADIUS} />
            <title>{`${entry.level.title} · ${entry.level.effectiveStatus} · 掌握度 ${entry.level.mastery}`}</title>
            <text y={NODE_RADIUS + 14} textAnchor="middle">{entry.level.title}</text>
            {entry.level.effectiveStatus === "mastered" ? (
              <text y={4} textAnchor="middle" fill="#fff">{entry.level.mastery}</text>
            ) : null}
          </g>
        ))}
      </svg>
    </div>
  );
}
