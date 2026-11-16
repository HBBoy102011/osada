import type { Vec2 } from "./types.js";

/**
 * Сетка проходимости + A*. Используется и сервером, и оффлайн-симуляцией.
 * Статические препятствия (деревья, камни, месторождения) и динамические
 * (здания) хранятся отдельно.
 */
export class NavGrid {
  readonly cols: number;
  readonly rows: number;
  readonly cell: number;
  readonly width: number;
  readonly height: number;
  private readonly staticBlocked: Uint8Array;
  private readonly dynamicBlocked: Uint8Array;

  constructor(width: number, height: number, cell: number) {
    this.width = width;
    this.height = height;
    this.cell = cell;
    this.cols = Math.ceil(width / cell);
    this.rows = Math.ceil(height / cell);
    this.staticBlocked = new Uint8Array(this.cols * this.rows);
    this.dynamicBlocked = new Uint8Array(this.cols * this.rows);
  }

  inBounds(cx: number, cy: number): boolean {
    return cx >= 0 && cy >= 0 && cx < this.cols && cy < this.rows;
  }

  cellIndex(cx: number, cy: number): number {
    return cy * this.cols + cx;
  }

  toCell(x: number, y: number): { cx: number; cy: number } {
    return {
      cx: Math.min(this.cols - 1, Math.max(0, Math.floor(x / this.cell))),
      cy: Math.min(this.rows - 1, Math.max(0, Math.floor(y / this.cell))),
    };
  }

  center(cx: number, cy: number): Vec2 {
    return { x: (cx + 0.5) * this.cell, y: (cy + 0.5) * this.cell };
  }

  isBlockedCell(cx: number, cy: number): boolean {
    if (!this.inBounds(cx, cy)) return true;
    const i = this.cellIndex(cx, cy);
    return this.staticBlocked[i] === 1 || this.dynamicBlocked[i] === 1;
  }

  isBlockedWorld(x: number, y: number): boolean {
    const { cx, cy } = this.toCell(x, y);
    return this.isBlockedCell(cx, cy);
  }

  blockStaticCircle(x: number, y: number, radius: number): void {
    this.forEachCircle(x, y, radius, (i) => {
      this.staticBlocked[i] = 1;
    });
  }

  blockStaticRect(x: number, y: number, halfSize: number): void {
    const min = this.toCell(x - halfSize, y - halfSize);
    const max = this.toCell(x + halfSize, y + halfSize);
    for (let cy = min.cy; cy <= max.cy; cy++) {
      for (let cx = min.cx; cx <= max.cx; cx++) {
        if (this.inBounds(cx, cy)) this.staticBlocked[this.cellIndex(cx, cy)] = 1;
      }
    }
  }

  addBuilding(x: number, y: number, halfSize: number): void {
    const min = this.toCell(x - halfSize, y - halfSize);
    const max = this.toCell(x + halfSize, y + halfSize);
    for (let cy = min.cy; cy <= max.cy; cy++) {
      for (let cx = min.cx; cx <= max.cx; cx++) {
        if (this.inBounds(cx, cy)) this.dynamicBlocked[this.cellIndex(cx, cy)] = 1;
      }
    }
  }

  removeBuilding(x: number, y: number, halfSize: number): void {
    const min = this.toCell(x - halfSize, y - halfSize);
    const max = this.toCell(x + halfSize, y + halfSize);
    for (let cy = min.cy; cy <= max.cy; cy++) {
      for (let cx = min.cx; cx <= max.cx; cx++) {
        if (this.inBounds(cx, cy)) this.dynamicBlocked[this.cellIndex(cx, cy)] = 0;
      }
    }
  }

  buildingAreaFree(x: number, y: number, halfSize: number): boolean {
    const min = this.toCell(x - halfSize, y - halfSize);
    const max = this.toCell(x + halfSize, y + halfSize);
    for (let cy = min.cy; cy <= max.cy; cy++) {
      for (let cx = min.cx; cx <= max.cx; cx++) {
        if (this.isBlockedCell(cx, cy)) return false;
      }
    }
    return true;
  }

  nearestFree(cx: number, cy: number, maxRadius = 24): { cx: number; cy: number } | null {
    if (!this.isBlockedCell(cx, cy)) return { cx, cy };
    for (let r = 1; r <= maxRadius; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const nx = cx + dx;
          const ny = cy + dy;
          if (!this.isBlockedCell(nx, ny)) return { cx: nx, cy: ny };
        }
      }
    }
    return null;
  }

  /** A* по 8 направлениям, без срезания углов. */
  findPath(start: Vec2, goal: Vec2): Vec2[] | null {
    const from = this.toCell(start.x, start.y);
    const toRaw = this.toCell(goal.x, goal.y);
    const to = this.nearestFree(toRaw.cx, toRaw.cy, 30) ?? toRaw;
    if (from.cx === to.cx && from.cy === to.cy) return [];
    const startId = this.cellIndex(from.cx, from.cy);
    const goalId = this.cellIndex(to.cx, to.cy);
    if (startId === goalId) return [];

    const total = this.cols * this.rows;
    const gScore = new Float32Array(total);
    gScore.fill(Infinity);
    const came = new Int32Array(total);
    came.fill(-1);
    const closed = new Uint8Array(total);
    const open = new MinHeap();

    const h = (cx: number, cy: number): number => {
      const dx = Math.abs(cx - to.cx);
      const dy = Math.abs(cy - to.cy);
      return (dx + dy) + (Math.SQRT2 - 2) * Math.min(dx, dy);
    };

    gScore[startId] = 0;
    open.push(startId, h(from.cx, from.cy));
    const dirs = [
      [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
      [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
    ] as const;

    let guard = 0;
    while (!open.empty && guard++ < total * 4) {
      const current = open.pop();
      if (current === goalId) break;
      if (closed[current] === 1) continue;
      closed[current] = 1;
      const cx = current % this.cols;
      const cy = (current - cx) / this.cols;
      for (const [dx, dy, cost] of dirs) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (this.isBlockedCell(nx, ny)) continue;
        if (dx !== 0 && dy !== 0) {
          if (this.isBlockedCell(cx + dx, cy) || this.isBlockedCell(cx, cy + dy)) continue;
        }
        const nextId = this.cellIndex(nx, ny);
        if (closed[nextId] === 1) continue;
        const tentative = gScore[current]! + cost;
        if (tentative < gScore[nextId]!) {
          gScore[nextId] = tentative;
          came[nextId] = current;
          open.push(nextId, tentative + h(nx, ny));
        }
      }
    }

    if (came[goalId] === -1 && goalId !== startId) return null;
    const cells: Vec2[] = [];
    let cursor = goalId;
    while (cursor !== -1) {
      const cx = cursor % this.cols;
      const cy = (cursor - cx) / this.cols;
      cells.push(this.center(cx, cy));
      if (cursor === startId) break;
      cursor = came[cursor]!;
    }
    cells.reverse();
    if (cells.length > 0) cells[0] = { x: start.x, y: start.y };
    return this.smooth(cells);
  }

  /** Убираем лишние точки, если между ними прямая видимость. */
  private smooth(points: Vec2[]): Vec2[] {
    if (points.length <= 2) return points.slice(1);
    const out: Vec2[] = [];
    let anchor = 0;
    while (anchor < points.length - 1) {
      let next = points.length - 1;
      while (next > anchor + 1 && !this.lineOfSight(points[anchor]!, points[next]!)) next--;
      out.push(points[next]!);
      anchor = next;
    }
    return out;
  }

  lineOfSight(a: Vec2, b: Vec2): boolean {
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.ceil(dist / (this.cell * 0.5));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const x = a.x + (b.x - a.x) * t;
      const y = a.y + (b.y - a.y) * t;
      if (this.isBlockedWorld(x, y)) return false;
    }
    return true;
  }

  private forEachCircle(
    x: number,
    y: number,
    radius: number,
    fn: (index: number) => void,
  ): void {
    const min = this.toCell(x - radius, y - radius);
    const max = this.toCell(x + radius, y + radius);
    for (let cy = min.cy; cy <= max.cy; cy++) {
      for (let cx = min.cx; cx <= max.cx; cx++) {
        if (!this.inBounds(cx, cy)) continue;
        const c = this.center(cx, cy);
        if (Math.hypot(c.x - x, c.y - y) <= radius + this.cell * 0.35) {
          fn(this.cellIndex(cx, cy));
        }
      }
    }
  }
}

/** Минимальная бинарная куча для открытого списка A*. */
class MinHeap {
  private readonly ids: number[] = [];
  private readonly keys: number[] = [];

  get empty(): boolean {
    return this.ids.length === 0;
  }

  push(id: number, key: number): void {
    this.ids.push(id);
    this.keys.push(key);
    let i = this.ids.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.keys[parent]! <= this.keys[i]!) break;
      this.swap(parent, i);
      i = parent;
    }
  }

  pop(): number {
    const top = this.ids[0]!;
    const lastId = this.ids.pop()!;
    const lastKey = this.keys.pop()!;
    if (this.ids.length > 0) {
      this.ids[0] = lastId;
      this.keys[0] = lastKey;
      let i = 0;
      for (;;) {
        const left = i * 2 + 1;
        const right = left + 1;
        let smallest = i;
        if (left < this.ids.length && this.keys[left]! < this.keys[smallest]!) smallest = left;
        if (right < this.ids.length && this.keys[right]! < this.keys[smallest]!) smallest = right;
        if (smallest === i) break;
        this.swap(i, smallest);
        i = smallest;
      }
    }
    return top;
  }

  private swap(a: number, b: number): void {
    [this.ids[a], this.ids[b]] = [this.ids[b]!, this.ids[a]!];
    [this.keys[a], this.keys[b]] = [this.keys[b]!, this.keys[a]!];
  }
}
