import type { BaseZone, DecorTree, GameMap, ResourceNode } from "./types.js";
import { Rng } from "./rng.js";
import { NavGrid } from "./pathfinding.js";

export const MAP_WIDTH = 120;
export const MAP_HEIGHT = 78;
export const GRID_CELL = 1.5;

export const DEFENDER_HALL = { x: 100, y: 39 };
export const ATTACKER_HALL = { x: 20, y: 39 };
export const DEFENDER_TOWERS = [
  { x: 94, y: 29 },
  { x: 94, y: 49 },
];
export const ATTACKER_OUTPOST = { x: 30, y: 39 };

export const TROPHY_SITES = [
  { x: 60, y: 39 },
  { x: 47, y: 18 },
  { x: 73, y: 60 },
];

interface Exclusion {
  x: number;
  y: number;
  r: number;
}

/** Генерация карты: базы, месторождения, декорации и проходимость. */
export function generateMap(seed: number): GameMap {
  const rng = new Rng(seed);
  const bases: BaseZone[] = [
    { team: 0, x: DEFENDER_HALL.x, y: DEFENDER_HALL.y, radius: 32 },
    { team: 1, x: ATTACKER_HALL.x, y: ATTACKER_HALL.y, radius: 30 },
  ];

  const nodes: ResourceNode[] = [];
  let nodeId = 1;
  const addNode = (kind: "gold" | "wood", x: number, y: number): void => {
    const radius = kind === "gold" ? 2.6 : 3.2;
    const amount = kind === "gold" ? 2600 : 1800;
    nodes.push({ id: nodeId++, kind, x, y, amount, maxAmount: amount, radius });
  };

  addNode("gold", 82, 18);
  addNode("gold", 82, 60);
  addNode("gold", 38, 18);
  addNode("gold", 38, 60);
  addNode("gold", 60, 10);
  addNode("gold", 60, 68);

  addNode("wood", 78, 30);
  addNode("wood", 78, 48);
  addNode("wood", 42, 30);
  addNode("wood", 42, 48);
  addNode("wood", 70, 8);
  addNode("wood", 50, 8);
  addNode("wood", 70, 70);
  addNode("wood", 50, 70);

  const exclusions: Exclusion[] = [
    { ...DEFENDER_HALL, r: 14 },
    { ...ATTACKER_HALL, r: 14 },
    ...DEFENDER_TOWERS.map((t) => ({ ...t, r: 5 })),
    { ...ATTACKER_OUTPOST, r: 6 },
    ...TROPHY_SITES.map((t) => ({ ...t, r: 7 })),
    ...nodes.map((n) => ({ x: n.x, y: n.y, r: n.radius + 4 })),
  ];

  const near = (x: number, y: number, pad = 0): boolean =>
    exclusions.some((e) => Math.hypot(e.x - x, e.y - y) < e.r + pad);

  const inBase = (x: number, y: number): boolean =>
    bases.some((b) => Math.hypot(b.x - x, b.y - y) < b.radius);

  const onRoad = (x: number, y: number): boolean => {
    if (Math.abs(y - 39) < 4.5 && x > 12 && x < 108) return true;
    const lanes: Array<[number, number, number, number]> = [
      [100, 39, 82, 18],
      [100, 39, 82, 60],
      [20, 39, 38, 18],
      [20, 39, 38, 60],
      [100, 39, 78, 30],
      [100, 39, 78, 48],
      [20, 39, 42, 30],
      [20, 39, 42, 48],
      [20, 39, 60, 39],
      [100, 39, 60, 39],
      [38, 18, 60, 10],
      [38, 60, 60, 68],
      [82, 18, 60, 10],
      [82, 60, 60, 68],
    ];
    for (const [ax, ay, bx, by] of lanes) {
      if (distToSegment(x, y, ax, ay, bx, by) < 3.2) return true;
    }
    return false;
  };

  const canPlace = (x: number, y: number, minGap: number): boolean => {
    if (x < 3 || y < 3 || x > MAP_WIDTH - 3 || y > MAP_HEIGHT - 3) return false;
    if (near(x, y)) return false;
    if (inBase(x, y) && !onRoad(x, y)) return false;
    if (onRoad(x, y)) return false;
    return true;
  };

  const trees: DecorTree[] = [];
  const tryTree = (x: number, y: number, minGap: number): boolean => {
    if (x < 2 || y < 2 || x > MAP_WIDTH - 2 || y > MAP_HEIGHT - 2) return false;
    if (near(x, y, 0.5)) return false;
    if (onRoad(x, y)) return false;
    if (inBase(x, y)) return false;
    for (const t of trees) {
      if (Math.hypot(t.x - x, t.y - y) < minGap) return false;
    }
    trees.push({
      x: Math.round(x * 100) / 100,
      y: Math.round(y * 100) / 100,
      s: Math.round(rng.range(0.8, 1.55) * 100) / 100,
      v: rng.int(0, 2),
    });
    return true;
  };

  // Лесные кластеры по краям карты и у лесопилок.
  const clusters: Array<{ x: number; y: number; r: number; count: number }> = [
    { x: 12, y: 10, r: 9, count: 22 },
    { x: 12, y: 68, r: 9, count: 22 },
    { x: 108, y: 10, r: 9, count: 22 },
    { x: 108, y: 68, r: 9, count: 22 },
    { x: 60, y: 4, r: 8, count: 14 },
    { x: 60, y: 74, r: 8, count: 14 },
    { x: 30, y: 6, r: 7, count: 12 },
    { x: 90, y: 6, r: 7, count: 12 },
    { x: 30, y: 72, r: 7, count: 12 },
    { x: 90, y: 72, r: 7, count: 12 },
    { x: 70, y: 8, r: 6, count: 10 },
    { x: 50, y: 8, r: 6, count: 10 },
    { x: 70, y: 70, r: 6, count: 10 },
    { x: 50, y: 70, r: 6, count: 10 },
    { x: 78, y: 30, r: 5, count: 9 },
    { x: 78, y: 48, r: 5, count: 9 },
    { x: 42, y: 30, r: 5, count: 9 },
    { x: 42, y: 48, r: 5, count: 9 },
  ];

  for (const cluster of clusters) {
    for (let i = 0; i < cluster.count; i++) {
      for (let attempt = 0; attempt < 12; attempt++) {
        const angle = rng.range(0, Math.PI * 2);
        const dist = Math.sqrt(rng.next()) * cluster.r;
        const x = cluster.x + Math.cos(angle) * dist;
        const y = cluster.y + Math.sin(angle) * dist;
        if (canPlace(x, y, 1.6) && tryTree(x, y, 1.35)) break;
      }
    }
  }

  // Редкие одиночные деревья ближе к центру.
  for (let i = 0; i < 70; i++) {
    const x = rng.range(6, MAP_WIDTH - 6);
    const y = rng.range(6, MAP_HEIGHT - 6);
    if (canPlace(x, y, 2) && !onRoad(x, y)) tryTree(x, y, 2.2);
  }

  const rocks: DecorTree[] = [];
  for (let i = 0; i < 46; i++) {
    const x = rng.range(4, MAP_WIDTH - 4);
    const y = rng.range(4, MAP_HEIGHT - 4);
    if (!canPlace(x, y, 2.5) || onRoad(x, y)) continue;
    if (rocks.some((r) => Math.hypot(r.x - x, r.y - y) < 3)) continue;
    if (trees.some((t) => Math.hypot(t.x - x, t.y - y) < 2.4)) continue;
    rocks.push({
      x: Math.round(x * 100) / 100,
      y: Math.round(y * 100) / 100,
      s: Math.round(rng.range(0.7, 1.5) * 100) / 100,
      v: rng.int(0, 2),
    });
  }

  return {
    version: 1,
    width: MAP_WIDTH,
    height: MAP_HEIGHT,
    seed,
    trees,
    rocks,
    bases,
    nodes,
  };
}

/** Сетка с препятствиями карты (здания добавляет World). */
export function createNavGrid(map: GameMap): NavGrid {
  const grid = new NavGrid(map.width, map.height, GRID_CELL);
  for (const tree of map.trees) {
    grid.blockStaticCircle(tree.x, tree.y, 1.15 * tree.s);
  }
  for (const rock of map.rocks) {
    grid.blockStaticCircle(rock.x, rock.y, 1.6 * rock.s);
  }
  for (const node of map.nodes) {
    grid.blockStaticCircle(node.x, node.y, node.radius);
  }
  // Границы карты.
  for (let cy = 0; cy < grid.rows; cy++) {
    for (let cx = 0; cx < grid.cols; cx++) {
      const c = grid.center(cx, cy);
      if (c.x < 2 || c.y < 2 || c.x > map.width - 2 || c.y > map.height - 2) {
        grid.blockStaticCircle(c.x, c.y, 0.1);
      }
    }
  }
  return grid;
}

export function distToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len));
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

export function baseForTeam(map: GameMap, team: number): BaseZone | undefined {
  return map.bases.find((b) => b.team === team);
}

export function spawnPoint(map: GameMap, team: number): { x: number; y: number } {
  const base = baseForTeam(map, team);
  if (!base) return { x: map.width / 2, y: map.height / 2 };
  return { x: base.x + (team === 0 ? -7 : 7), y: base.y };
}
