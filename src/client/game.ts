import * as THREE from "three";
import type {
  Balance,
  BuildingKind,
  Command,
  EntitySnapshot,
  GameMap,
  Role,
  Snapshot,
  Team,
} from "../shared/types.js";
import { Hud } from "./hud.js";
import { SceneView } from "./scene.js";
import type { GameSession } from "./session.js";
import { createNavGrid } from "../shared/map.js";
import type { NavGrid } from "../shared/pathfinding.js";

export interface GameOptions {
  canvas: HTMLCanvasElement;
  balance: Balance;
  map: GameMap;
  team: Team;
  role: Role;
  mode: "offline" | "online";
  playerName: string;
  players: Array<{ name: string; team: Team; role: Role }>;
  session: GameSession;
  onExit(): void;
  onRestart(): void;
}

export class Game {
  private readonly scene: SceneView;
  private readonly hud: Hud;
  private readonly options: GameOptions;
  private readonly session: GameSession;
  private readonly grid: NavGrid;
  private readonly keys = new Set<string>();
  private snap: Snapshot | null = null;
  private selected: number[] = [];
  private raf = 0;
  private lastFrame = performance.now();
  private lastMinimapDraw = 0;
  private dragStart: { x: number; y: number } | null = null;
  private dragging = false;
  private dragBox: HTMLDivElement;
  private panStart: { x: number; y: number } | null = null;
  private pointer = { x: 0, y: 0 };
  private overCanvas = false;
  private placement: { kind: BuildingKind; ghost: THREE.Group; valid: boolean } | null = null;
  private attackMode = false;
  private lastClick = { id: -1, at: 0 };
  private controlGroups = new Map<string, number[]>();
  private pointerConsumed = false;
  private disposed = false;

  constructor(options: GameOptions) {
    this.options = options;
    this.session = options.session;
    this.grid = createNavGrid(options.map);
    this.scene = new SceneView(options.canvas, options.map, options.balance);

    const own = options.players.find((p) => p.team === options.team);
    this.hud = new Hud({
      team: options.team,
      role: options.role,
      balance: options.balance,
      mode: options.mode,
      players: options.players,
      callbacks: {
        onCommand: (cmd) => this.send(cmd),
        onBuild: (kind) => this.startBuild(kind),
        onAttackMove: () => this.enterAttackMode(),
        onChat: (text) => this.session.sendChat(text),
        onExit: () => this.options.onExit(),
        onRestart: () => this.options.onRestart(),
        onFocus: (id) => this.focusEntity(id),
      },
    });
    this.hud.setCharacter(own?.name ?? options.playerName, options.role, options.mode);
    this.hud.log("Осада началась. Защитите базу или разрушьте главный зал противника.", "notice");

    this.dragBox = document.createElement("div");
    this.dragBox.className = "drag-box hidden";
    document.getElementById("game-layer")!.appendChild(this.dragBox);

    const base = options.map.bases.find((b) => b.team === options.team);
    this.scene.focusOn(base?.x ?? (options.team === 0 ? 100 : 20), base?.y ?? 39, true);
    this.scene.setSelection([]);

    this.bindInput();
    this.raf = requestAnimationFrame(this.loop);
  }

  applySnapshot(snap: Snapshot): void {
    this.snap = snap;
    const alive = new Set(snap.entities.map((e) => e.id));
    this.selected = this.selected.filter((id) => alive.has(id));
    this.hud.setSelection(this.selectedSnapshots());
    this.hud.update(snap);
    this.hud.handleEvents(snap.events);
    this.scene.applySnapshot(snap, this.options.team);
    this.scene.setSelection(this.selected);
    if (snap.phase === "ended") {
      this.hud.showEnd(snap);
    }
  }

  toast(message: string, kind: "ok" | "warn" | "error" | "" = ""): void {
    this.hud.toast(message, kind);
  }

  addChat(from: string, text: string, team: Team): void {
    this.hud.addChat(from, text, team);
  }

  setOpponentStatus(connected: boolean, graceSeconds: number): void {
    this.hud.setOpponentStatus(connected, graceSeconds);
  }

  setPing(ms: number): void {
    this.hud.setPing(ms);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("mousemove", this.onWindowMouseMove);
    window.removeEventListener("blur", this.onBlur);
    this.hud.destroy();
    this.scene.dispose();
    this.dragBox.remove();
    this.session.dispose();
  }

  // ------------------------------------------------------------------ input

  private bindInput(): void {
    const canvas = this.options.canvas;
    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointerleave", this.onPointerLeave);
    canvas.addEventListener("wheel", this.onWheel, { passive: false });
    canvas.addEventListener("contextmenu", (event) => event.preventDefault());
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("mousemove", this.onWindowMouseMove);
    window.addEventListener("blur", this.onBlur);
    this.hud.minimapCanvas.addEventListener("mousedown", this.onMinimapDown);
    this.hud.minimapCanvas.addEventListener("contextmenu", (event) => event.preventDefault());
  }

  private onPointerDown = (event: PointerEvent): void => {
    this.pointerConsumed = false;
    if (!this.snap || this.snap.phase !== "playing") return;
    if (event.button === 1) {
      this.panStart = { x: event.clientX, y: event.clientY };
      this.pointerConsumed = true;
      event.preventDefault();
      return;
    }
    if (event.button === 2) {
      if (this.placement || this.attackMode) {
        this.cancelModes();
        return;
      }
      this.issueContextCommand(event.clientX, event.clientY);
      return;
    }
    if (event.button !== 0) return;
    if (this.placement) {
      this.pointerConsumed = true;
      this.tryPlace(event.clientX, event.clientY, event.shiftKey);
      return;
    }
    if (this.attackMode) {
      this.pointerConsumed = true;
      const point = this.scene.screenToGround(event.clientX, event.clientY);
      const ids = this.selectedOwnUnitIds();
      if (point && ids.length) {
        this.send({ t: "attackMove", ids, x: round1(point.x), y: round1(point.y) });
        this.toast("Атака по площади", "ok");
      }
      this.attackMode = false;
      this.updateCursor();
      return;
    }
    this.dragStart = { x: event.clientX, y: event.clientY };
    this.pointer = { x: event.clientX, y: event.clientY };
  };

  private onPointerMove = (event: PointerEvent): void => {
    this.pointer = { x: event.clientX, y: event.clientY };
    this.overCanvas = true;
    if (this.panStart) {
      const dx = event.clientX - this.panStart.x;
      const dy = event.clientY - this.panStart.y;
      this.scene.pan(-dx * 0.09, -dy * 0.12);
      this.panStart = { x: event.clientX, y: event.clientY };
      return;
    }
    if (this.dragStart && event.buttons === 1) {
      const dx = event.clientX - this.dragStart.x;
      const dy = event.clientY - this.dragStart.y;
      if (!this.dragging && Math.hypot(dx, dy) > 7) this.dragging = true;
      if (this.dragging) {
        this.dragBox.classList.remove("hidden");
        const left = Math.min(this.dragStart.x, event.clientX);
        const top = Math.min(this.dragStart.y, event.clientY);
        this.dragBox.style.left = `${left}px`;
        this.dragBox.style.top = `${top}px`;
        this.dragBox.style.width = `${Math.abs(dx)}px`;
        this.dragBox.style.height = `${Math.abs(dy)}px`;
      }
    }
    if (this.placement) {
      const point = this.scene.screenToGround(event.clientX, event.clientY);
      if (point) {
        const valid = this.canPlace(this.placement.kind, point.x, point.y);
        this.placement.valid = valid;
        this.scene.setGhostPosition(this.placement.ghost, point.x, point.y, valid);
        this.hud.showPlacement(
          this.placement.kind,
          valid,
          this.options.balance.buildings[this.placement.kind].cost,
        );
      }
    } else if (this.attackMode) {
      this.updateCursor();
    }
  };

  private onPointerUp = (event: PointerEvent): void => {
    if (event.button === 1) {
      this.panStart = null;
      return;
    }
    if (event.button !== 0) return;
    if (this.pointerConsumed) {
      this.dragStart = null;
      this.dragBox.classList.add("hidden");
      this.dragging = false;
      return;
    }
    if (this.dragging && this.dragStart) {
      const ids = this.scene.entitiesInRect(
        this.dragStart.x,
        this.dragStart.y,
        event.clientX,
        event.clientY,
        this.options.team,
      );
      this.setSelection(event.shiftKey ? unique([...this.selected, ...ids]) : ids);
      this.dragging = false;
      this.dragStart = null;
      this.dragBox.classList.add("hidden");
      return;
    }
    this.dragStart = null;
    if (this.placement || this.attackMode) return;
    this.handleClick(event);
  };

  private onPointerLeave = (): void => {
    this.overCanvas = false;
  };

  private onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    this.scene.zoomBy(event.deltaY > 0 ? 4 : -4);
  };

  private handleClick(event: PointerEvent): void {
    if (!this.snap) return;
    const hit = this.scene.entityAt(event.clientX, event.clientY);
    if (!hit) {
      if (!event.shiftKey) this.setSelection([]);
      return;
    }
    const entity = this.snap.entities.find((e) => e.id === hit.id);
    if (!entity) return;
    const now = performance.now();
    if (this.lastClick.id === hit.id && now - this.lastClick.at < 380) {
      if (entity.k === "u" && entity.team === this.options.team) {
        const same = this.snap.entities
          .filter((e) => e.team === this.options.team && e.k === "u" && e.t === entity.t)
          .map((e) => e.id);
        this.setSelection(same);
      }
      this.lastClick = { id: -1, at: 0 };
      return;
    }
    this.lastClick = { id: hit.id, at: now };
    if (event.shiftKey) {
      this.setSelection(
        this.selected.includes(hit.id)
          ? this.selected.filter((id) => id !== hit.id)
          : [...this.selected, hit.id],
      );
    } else {
      this.setSelection([hit.id]);
    }
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    const active = document.activeElement;
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;
    const key = event.key.toLowerCase();
    if (["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright", " "].includes(key)) {
      this.keys.add(key);
      if (key === " ") event.preventDefault();
    }
    if (event.ctrlKey && /^[1-9]$/.test(key)) {
      this.controlGroups.set(key, this.selectedOwnUnitIds());
      this.toast(`Группа ${key} назначена`, "ok");
      event.preventDefault();
      return;
    }
    if (/^[1-9]$/.test(key) && !event.ctrlKey) {
      const stored = this.controlGroups.get(key);
      if (stored) {
        const alive = new Set(this.snap?.entities.map((e) => e.id) ?? []);
        this.setSelection(stored.filter((id) => alive.has(id)));
        this.focusSelected();
      }
      return;
    }
    if (key === "a" && !event.ctrlKey) {
      this.enterAttackMode();
    } else if (key === "s" && !event.ctrlKey) {
      const ids = this.selectedOwnUnitIds();
      if (ids.length) this.send({ t: "stop", ids });
    } else if (key === "f") {
      this.focusHero();
    } else if (key === " ") {
      const hall = this.ownBuilding("hall");
      if (hall) {
        this.scene.focusOn(hall.x, hall.y);
        this.setSelection([hall.id]);
      }
    } else if (key === "escape") {
      if (this.placement || this.attackMode) this.cancelModes();
      else this.setSelection([]);
    } else if (key === "q" || key === "w") {
      if (!this.snap) return;
      const skill = key === "q" ? "mend" : "charge";
      if ((this.snap.you.heroSkills[skill] ?? 0) > 0) {
        this.send({ t: "heroAbility", skill });
      }
    }
  };

  private onKeyUp = (event: KeyboardEvent): void => {
    this.keys.delete(event.key.toLowerCase());
  };

  private onWindowMouseMove = (event: MouseEvent): void => {
    this.overCanvas = event.target === this.options.canvas;
  };

  private onBlur = (): void => {
    this.keys.clear();
    this.overCanvas = false;
  };

  private onMinimapDown = (event: MouseEvent): void => {
    event.preventDefault();
    if (!this.snap) return;
    const point = this.scene.minimapToWorld(this.hud.minimapCanvas, event.clientX, event.clientY);
    if (event.button === 0) {
      this.scene.focusOn(point.x, point.y);
    } else if (event.button === 2) {
      const ids = this.selectedOwnUnitIds();
      if (ids.length) this.send({ t: "move", ids, x: round1(point.x), y: round1(point.y) });
    }
  };

  // -------------------------------------------------------------- commands

  private send(cmd: Command): void {
    if (!this.snap || this.snap.phase !== "playing") return;
    this.session.sendCommand(cmd);
  }

  private selectedOwnUnitIds(): number[] {
    if (!this.snap) return [];
    const team = this.options.team;
    return this.selected.filter((id) => {
      const entity = this.snap!.entities.find((e) => e.id === id);
      return entity && entity.team === team && entity.k === "u";
    });
  }

  private selectedSnapshots(): EntitySnapshot[] {
    if (!this.snap) return [];
    return this.selected
      .map((id) => this.snap!.entities.find((e) => e.id === id))
      .filter((e): e is EntitySnapshot => Boolean(e));
  }

  private setSelection(ids: number[]): void {
    this.selected = unique(ids);
    this.scene.setSelection(this.selected);
    this.hud.setSelection(this.selectedSnapshots());
    if (this.selected.length === 1) {
      const entity = this.selectedSnapshots()[0];
      if (entity?.k === "b" && entity.team === this.options.team) {
        this.hud.log("ПКМ по земле — точка сбора для здания.", "hint");
      }
    }
  }

  private focusEntity(id: number): void {
    if (!this.snap) return;
    const entity = this.snap.entities.find((e) => e.id === id);
    if (entity) this.scene.focusOn(entity.x, entity.y);
  }

  private focusSelected(): void {
    const entities = this.selectedSnapshots();
    if (!entities.length) return;
    const x = entities.reduce((sum, e) => sum + e.x, 0) / entities.length;
    const y = entities.reduce((sum, e) => sum + e.y, 0) / entities.length;
    this.scene.focusOn(x, y);
  }

  private focusHero(): void {
    if (!this.snap) return;
    const hero = this.snap.entities.find(
      (e) => e.team === this.options.team && e.k === "u" && e.t === "hero",
    );
    if (hero) {
      this.scene.focusOn(hero.x, hero.y);
      this.setSelection([hero.id]);
    }
  }

  private ownBuilding(type: BuildingKind): EntitySnapshot | undefined {
    return this.snap?.entities.find(
      (e) => e.team === this.options.team && e.k === "b" && e.t === type && e.done,
    );
  }

  private issueContextCommand(clientX: number, clientY: number): void {
    if (!this.snap) return;
    const point = this.scene.screenToGround(clientX, clientY);
    if (!point) return;
    const target = this.scene.entityAt(clientX, clientY);
    const node = this.scene.nodeAt(clientX, clientY);
    const ownUnits = this.selectedOwnUnitIds();
    const workers = this.selectedSnapshots().filter(
      (e) => e.team === this.options.team && e.k === "u" && e.t === "worker",
    );

    if (node && workers.length) {
      this.send({ t: "gather", ids: workers.map((w) => w.id), node: node.id });
      return;
    }
    if (target) {
      const entity = this.snap.entities.find((e) => e.id === target.id);
      if (entity && entity.team !== this.options.team && ownUnits.length) {
        this.send({ t: "attack", ids: ownUnits, target: entity.id });
        return;
      }
      if (entity && entity.team === this.options.team && entity.k === "b" && entity.hp < entity.mhp && workers.length) {
        this.send({ t: "repair", ids: workers.map((w) => w.id), target: entity.id });
        return;
      }
    }

    const buildings = this.selectedSnapshots().filter(
      (e) => e.team === this.options.team && e.k === "b",
    );
    if (!ownUnits.length && buildings.length) {
      for (const building of buildings) {
        this.send({
          t: "rally",
          building: building.id,
          x: round1(point.x),
          y: round1(point.y),
        });
      }
      this.toast("Точка сбора установлена", "ok");
      return;
    }
    if (ownUnits.length) {
      this.send({ t: "move", ids: ownUnits, x: round1(point.x), y: round1(point.y) });
    } else if (buildings.length === 0) {
      this.toast("Сначала выберите юнитов", "warn");
    }
  }

  private enterAttackMode(): void {
    if (!this.selectedOwnUnitIds().length) {
      this.toast("Выберите юнитов для атаки", "warn");
      return;
    }
    this.cancelModes();
    this.attackMode = true;
    this.updateCursor();
    this.toast("Атака по площади: выберите точку", "ok");
  }

  // ------------------------------------------------------------------ build

  private startBuild(kind: BuildingKind): void {
    if (!this.snap) return;
    const workers = this.selectedSnapshots().filter(
      (e) => e.team === this.options.team && e.k === "u" && e.t === "worker",
    );
    if (!workers.length) {
      this.toast("Выберите рабочего", "warn");
      return;
    }
    this.cancelModes();
    const ghost = this.scene.createGhost(kind);
    this.placement = { kind, ghost, valid: false };
    this.hud.showPlacement(kind, true, this.options.balance.buildings[kind].cost);
    this.updateCursor();
  }

  private tryPlace(clientX: number, clientY: number, keepMode: boolean): void {
    if (!this.placement || !this.snap) return;
    const point = this.scene.screenToGround(clientX, clientY);
    if (!point) return;
    if (!this.canPlace(this.placement.kind, point.x, point.y)) {
      this.toast("Здесь нельзя строить", "warn");
      return;
    }
    const workers = this.selectedSnapshots().filter(
      (e) => e.team === this.options.team && e.k === "u" && e.t === "worker",
    );
    if (!workers.length) {
      this.toast("Нужен рабочий", "warn");
      this.cancelModes();
      return;
    }
    this.send({
      t: "build",
      ids: workers.map((w) => w.id),
      building: this.placement.kind,
      x: round1(point.x),
      y: round1(point.y),
    });
    if (!keepMode) this.cancelModes();
  }

  private canPlace(kind: BuildingKind, x: number, y: number): boolean {
    if (!this.snap) return false;
    const def = this.options.balance.buildings[kind];
    const half = def.size / 2;
    if (x < 4 || y < 4 || x > this.options.map.width - 4 || y > this.options.map.height - 4) {
      return false;
    }
    const zones = this.snap.entities.filter(
      (e) =>
        e.team === this.options.team &&
        e.k === "b" &&
        e.done &&
        (e.t === "hall" || e.t === "outpost"),
    );
    let inZone = false;
    for (const zone of zones) {
      const radius = zone.t === "hall" ? this.options.balance.match.baseRadius : 18;
      if (Math.hypot(x - zone.x, y - zone.y) <= radius) {
        inZone = true;
        break;
      }
    }
    if (!inZone) return false;
    if (!this.grid.buildingAreaFree(x, y, half + 0.2)) return false;
    for (const entity of this.snap.entities) {
      if (entity.k === "b") {
        const otherHalf = (this.options.balance.buildings[entity.t as BuildingKind]?.size ?? 3) / 2;
        if (
          Math.abs(entity.x - x) < half + otherHalf + 0.4 &&
          Math.abs(entity.y - y) < half + otherHalf + 0.4
        ) {
          return false;
        }
      } else if (
        Math.abs(entity.x - x) < half + 0.7 &&
        Math.abs(entity.y - y) < half + 0.7
      ) {
        return false;
      }
    }
    for (const node of this.snap.nodes) {
      if (node.amount <= 0) continue;
      if (Math.hypot(x - node.x, y - node.y) < half + (node.kind === "gold" ? 2.6 : 3.2) + 0.4) {
        return false;
      }
    }
    return true;
  }

  private cancelModes(): void {
    if (this.placement) {
      this.scene.removeGhost(this.placement.ghost);
      this.placement = null;
    }
    this.attackMode = false;
    this.hud.showPlacement(null);
    this.updateCursor();
  }

  private updateCursor(): void {
    this.options.canvas.classList.toggle("cursor-crosshair", Boolean(this.placement) || this.attackMode);
  }

  // ------------------------------------------------------------------- loop

  private loop = (now: number): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min(0.05, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    this.updateCamera(dt);
    this.scene.update(dt, now / 1000);
    this.scene.render();
    if (this.snap && now - this.lastMinimapDraw > 90) {
      this.lastMinimapDraw = now;
      this.hud.minimapCanvas.width = 224;
      this.hud.minimapCanvas.height = 146;
      this.scene.drawMinimap(
        this.hud.minimapCanvas,
        this.snap,
        this.options.team,
        this.selected,
      );
    }
  };

  private updateCamera(dt: number): void {
    const speed = this.scene.zoom * 0.55 * dt;
    let dx = 0;
    let dy = 0;
    if (this.keys.has("a") || this.keys.has("arrowleft")) dx -= speed;
    if (this.keys.has("d") || this.keys.has("arrowright")) dx += speed;
    if (this.keys.has("w") || this.keys.has("arrowup")) dy -= speed;
    if (this.keys.has("s") || this.keys.has("arrowdown")) dy += speed;

    if (this.overCanvas) {
      const margin = 14;
      const width = window.innerWidth;
      const height = window.innerHeight;
      if (this.pointer.x < margin) dx -= speed;
      if (this.pointer.x > width - margin) dx += speed;
      if (this.pointer.y < margin) dy -= speed;
      if (this.pointer.y > height - margin) dy += speed;
    }
    if (dx !== 0 || dy !== 0) this.scene.pan(dx, dy);
  }
}

function unique(ids: number[]): number[] {
  return [...new Set(ids)];
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
