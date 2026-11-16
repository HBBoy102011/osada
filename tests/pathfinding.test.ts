import { describe, expect, it } from "vitest";
import { generateMap, createNavGrid } from "../src/shared/map.js";
import { NavGrid } from "../src/shared/pathfinding.js";

function samplePath(grid: NavGrid, path: Array<{ x: number; y: number }>): void {
  let previous = path[0]!;
  for (const point of path.slice(1)) {
    const steps = Math.ceil(Math.hypot(point.x - previous.x, point.y - previous.y) / (grid.cell * 0.5));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const x = previous.x + (point.x - previous.x) * t;
      const y = previous.y + (point.y - previous.y) * t;
      expect(grid.isBlockedWorld(x, y), `точка (${x.toFixed(1)}, ${y.toFixed(1)}) внутри препятствия`).toBe(false);
    }
    previous = point;
  }
}

describe("NavGrid: базовая геометрия", () => {
  it("переводит мировые координаты в клетки и обратно", () => {
    const grid = new NavGrid(40, 30, 2);
    expect(grid.cols).toBe(20);
    expect(grid.rows).toBe(15);
    expect(grid.toCell(-5, 100)).toEqual({ cx: 0, cy: 14 });
    expect(grid.toCell(21, 10)).toEqual({ cx: 10, cy: 5 });
    expect(grid.center(0, 0)).toEqual({ x: 1, y: 1 });
    expect(grid.inBounds(19, 14)).toBe(true);
    expect(grid.inBounds(20, 14)).toBe(false);
  });

  it("блокирует и разблокирует динамические здания", () => {
    const grid = new NavGrid(40, 40, 2);
    expect(grid.buildingAreaFree(20, 20, 2)).toBe(true);
    grid.addBuilding(20, 20, 2);
    expect(grid.isBlockedWorld(20, 20)).toBe(true);
    expect(grid.buildingAreaFree(20, 20, 2)).toBe(false);
    grid.removeBuilding(20, 20, 2);
    expect(grid.isBlockedWorld(20, 20)).toBe(false);
    expect(grid.buildingAreaFree(20, 20, 2)).toBe(true);
  });

  it("ищет ближайшую свободную клетку и возвращает null в глухой стене", () => {
    const grid = new NavGrid(12, 12, 2);
    grid.blockStaticRect(6, 6, 1);
    const free = grid.nearestFree(3, 3);
    expect(free).not.toBeNull();
    expect(grid.isBlockedCell(free!.cx, free!.cy)).toBe(false);

    const sealed = new NavGrid(6, 6, 2);
    for (let cy = 0; cy < sealed.rows; cy++) {
      for (let cx = 0; cx < sealed.cols; cx++) {
        if (cx === 1 && cy === 1) continue;
        sealed.blockStaticCircle((cx + 0.5) * sealed.cell, (cy + 0.5) * sealed.cell, 4);
      }
    }
    expect(sealed.nearestFree(1, 1, 2)).toBeNull();
  });

  it("проверяет прямую видимость", () => {
    const grid = new NavGrid(40, 40, 2);
    expect(grid.lineOfSight({ x: 2, y: 2 }, { x: 38, y: 2 })).toBe(true);
    grid.blockStaticRect(20, 20, 3);
    expect(grid.lineOfSight({ x: 2, y: 20 }, { x: 38, y: 20 })).toBe(false);
  });
});

describe("NavGrid: поиск пути", () => {
  it("обходит стену и не срезает углы", () => {
    const grid = new NavGrid(40, 40, 2);
    // Стена по x≈20 от y=0 до y=30, снизу остаётся проход.
    grid.blockStaticRect(20, 15, 1.6);
    for (let y = 0; y <= 30; y += 2) grid.blockStaticRect(20, y, 1.6);

    const path = grid.findPath({ x: 4, y: 20 }, { x: 36, y: 20 });
    expect(path).not.toBeNull();
    expect(path!.length).toBeGreaterThan(0);
    const last = path![path!.length - 1]!;
    expect(Math.hypot(last.x - 36, last.y - 20)).toBeLessThan(4);
    samplePath(grid, [{ x: 4, y: 20 }, ...path!]);
  });

  it("возвращает пустой путь для той же клетки", () => {
    const grid = new NavGrid(40, 40, 2);
    expect(grid.findPath({ x: 10, y: 10 }, { x: 10.2, y: 10.2 })).toEqual([]);
  });

  it("не находит путь через полностью закрытую область", () => {
    const grid = new NavGrid(40, 40, 2);
    // Горизонтальная стена через всю карту.
    for (let x = 0; x <= 40; x += 1.5) grid.blockStaticRect(x, 20, 1.7);
    // Старт и финиш в разных половинах.
    expect(grid.findPath({ x: 20, y: 6 }, { x: 20, y: 34 })).toBeNull();
  });

  it("идёт к ближайшей свободной клетке, если цель в препятствии", () => {
    const grid = new NavGrid(40, 40, 2);
    grid.blockStaticRect(30, 30, 2.5);
    const path = grid.findPath({ x: 6, y: 6 }, { x: 30, y: 30 });
    expect(path).not.toBeNull();
    const last = path![path!.length - 1]!;
    expect(grid.isBlockedWorld(last.x, last.y)).toBe(false);
    samplePath(grid, [{ x: 6, y: 6 }, ...path!]);
  });

  it("строит путь между базами на сгенерированной карте", () => {
    const map = generateMap(20260101);
    const grid = createNavGrid(map);
    const path = grid.findPath({ x: 20, y: 39 }, { x: 100, y: 39 });
    expect(path).not.toBeNull();
    expect(path!.length).toBeGreaterThan(0);
    const last = path![path!.length - 1]!;
    expect(Math.hypot(last.x - 100, last.y - 39)).toBeLessThan(6);
    samplePath(grid, [{ x: 20, y: 39 }, ...path!]);
  });
});
