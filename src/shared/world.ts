import type {
  Balance,
  BuildingDef,
  BuildingKind,
  Command,
  CommandResult,
  Cost,
  Entity,
  GameMap,
  NodeKind,
  Order,
  PlayerState,
  PlayerView,
  ResourceNode,
  Role,
  SimEvent,
  Snapshot,
  Stats,
  Team,
  UnitDef,
  UnitKind,
  Vec2,
} from "./types.js";
import {
  ATTACKER_HALL,
  ATTACKER_OUTPOST,
  DEFENDER_HALL,
  DEFENDER_TOWERS,
  TROPHY_SITES,
  createNavGrid,
  generateMap,
  spawnPoint,
} from "./map.js";
import type { NavGrid } from "./pathfinding.js";
import { clamp, distance, encodeBase64 } from "./rng.js";

const HOSTILE = new Set(["0-1", "0-2", "1-0", "1-2", "2-0", "2-1"]);

function hostile(a: Team, b: Team): boolean {
  return a !== b;
}

export class World {
  readonly balance: Balance;
  readonly map: GameMap;
  readonly grid: NavGrid;
  readonly players: [PlayerState, PlayerState];
  readonly stats: [Stats, Stats];
  readonly entities = new Map<number, Entity>();
  readonly nodes: ResourceNode[];
  time = 0;
  tickCount = 0;
  phase: "playing" | "ended" = "playing";
  winner: Team | null = null;
  endReason = "";
  events: SimEvent[] = [];

  private nextId = 1;
  private heroIds: [number | null, number | null] = [null, null];
  private heroRespawnAt: [number, number] = [0, 0];
  private guardPosts = new Map<number, Vec2>();
  private fogCell = 2;
  private fogW: number;
  private fogH: number;
  private fogVisible: [Uint8Array, Uint8Array];
  private fogExplored: [Uint8Array, Uint8Array];

  constructor(options: { balance: Balance; seed: number; names?: [string, string] }) {
    this.balance = options.balance;
    this.map = generateMap(options.seed);
    this.grid = createNavGrid(this.map);
    this.nodes = this.map.nodes.map((n) => ({ ...n }));
    this.fogW = Math.ceil(this.map.width / this.fogCell);
    this.fogH = Math.ceil(this.map.height / this.fogCell);
    this.fogVisible = [new Uint8Array(this.fogW * this.fogH), new Uint8Array(this.fogW * this.fogH)];
    this.fogExplored = [new Uint8Array(this.fogW * this.fogH), new Uint8Array(this.fogW * this.fogH)];
    this.stats = [emptyStats(), emptyStats()];

    const m = this.balance.match;
    this.players = [
      makePlayer(0, "defender", options.names?.[0] ?? "Защитник", m),
      makePlayer(1, "attacker", options.names?.[1] ?? "Атакующий", m),
    ];

    this.setupBases();
    this.setupTrophies();
    this.recomputeSupply();
  }

  // ---------------------------------------------------------------- setup

  private setupBases(): void {
    const dHall = this.createBuilding(0, "hall", DEFENDER_HALL.x, DEFENDER_HALL.y, true);
    this.createBuilding(0, "tower", DEFENDER_TOWERS[0].x, DEFENDER_TOWERS[0].y, true);
    this.createBuilding(0, "tower", DEFENDER_TOWERS[1].x, DEFENDER_TOWERS[1].y, true);
    const aHall = this.createBuilding(1, "hall", ATTACKER_HALL.x, ATTACKER_HALL.y, true);
    this.createBuilding(1, "outpost", ATTACKER_OUTPOST.x, ATTACKER_OUTPOST.y, true);

    const defenderOffsets = [
      [-6, -6], [-7, 5], [-9, -1], [-5, 9], [-5, -9],
    ];
    const attackerOffsets = [
      [6, -6], [7, 5], [9, -1], [5, 9], [5, -9],
    ];
    for (const team of [0, 1] as const) {
      const base = team === 0 ? dHall : aHall;
      const offsets = team === 0 ? defenderOffsets : attackerOffsets;
      for (let i = 0; i < 4; i++) {
        const off = offsets[i]!;
        this.createUnit(team, "worker", base.x + off[0], base.y + off[1]);
      }
      this.createUnit(team, "soldier", base.x + (team === 0 ? -11 : 11), base.y - 4);
      this.createUnit(team, "soldier", base.x + (team === 0 ? -11 : 11), base.y + 4);
      const hero = this.createUnit(team, "hero", base.x + (team === 0 ? -8 : 8), base.y, false);
      this.heroIds[team] = hero.id;
      this.heroRespawnAt[team] = 0;
    }
  }

  private setupTrophies(): void {
    for (const site of TROPHY_SITES) {
      this.createBuilding(2, "trophy", site.x, site.y, true);
      for (let i = 0; i < 2; i++) {
        const angle = (i / 2) * Math.PI * 2 + 0.6;
        const guard = this.createUnit(
          2,
          "soldier",
          site.x + Math.cos(angle) * 4.4,
          site.y + Math.sin(angle) * 4.4,
          false,
          0.75,
        );
        this.guardPosts.set(guard.id, { x: guard.x, y: guard.y });
      }
    }
  }

  // ------------------------------------------------------------ factories

  private createUnit(
    team: Team,
    type: UnitKind,
    x: number,
    y: number,
    findSpot = true,
    hpScale = 1,
  ): Entity {
    const def = this.balance.units[type];
    const pos = findSpot ? this.freeSpotNear(x, y) : { x, y };
    const baseHp = def.hp * hpScale;
    const level = type === "hero" && team !== 2 ? this.players[team]!.heroLevel : 1;
    const maxHp = type === "hero"
      ? baseHp + (level - 1) * this.balance.hero.hpPerLevel
      : baseHp;
    const entity: Entity = {
      id: this.nextId++,
      kind: "unit",
      type,
      team,
      x: pos.x,
      y: pos.y,
      hp: maxHp,
      maxHp,
      radius: def.radius,
      facing: 0,
      done: true,
      progress: 1,
      order: { type: "idle" },
      path: null,
      pathIndex: 0,
      repathAt: 0,
      cooldown: 0,
      carry: 0,
      carryKind: null,
      queue: [],
      rally: null,
      level,
      xp: 0,
      attackAnim: 0,
      aggro: null,
      buffUntil: 0,
      buffSpeed: 0,
      buffDamage: 0,
      respawnAt: 0,
    };
    this.entities.set(entity.id, entity);
    return entity;
  }

  private createBuilding(
    team: Team,
    type: BuildingKind,
    x: number,
    y: number,
    done: boolean,
  ): Entity {
    const def = this.balance.buildings[type];
    const maxHp = def.hp;
    const entity: Entity = {
      id: this.nextId++,
      kind: "building",
      type,
      team,
      x,
      y,
      hp: done ? maxHp : Math.max(1, maxHp * 0.1),
      maxHp,
      radius: def.size / 2,
      facing: team === 0 ? Math.PI : 0,
      done,
      progress: done ? 1 : 0,
      order: { type: "idle" },
      path: null,
      pathIndex: 0,
      repathAt: 0,
      cooldown: 0,
      carry: 0,
      carryKind: null,
      queue: [],
      rally: null,
      level: 1,
      xp: 0,
      attackAnim: 0,
      aggro: null,
      buffUntil: 0,
      buffSpeed: 0,
      buffDamage: 0,
      respawnAt: 0,
    };
    this.entities.set(entity.id, entity);
    this.grid.addBuilding(x, y, def.size / 2 + 0.2);
    return entity;
  }

  // ------------------------------------------------------------- accessors

  get hallDefender(): Entity | undefined {
    return this.findHall(0);
  }

  get hallAttacker(): Entity | undefined {
    return this.findHall(1);
  }

  findHall(team: Team): Entity | undefined {
    for (const e of this.entities.values()) {
      if (e.kind === "building" && e.type === "hall" && e.team === team) return e;
    }
    return undefined;
  }

  unitsOf(team: Team): Entity[] {
    return [...this.entities.values()].filter((e) => e.kind === "unit" && e.team === team);
  }

  buildingsOf(team: Team): Entity[] {
    return [...this.entities.values()].filter((e) => e.kind === "building" && e.team === team);
  }

  getEntity(id: number): Entity | undefined {
    return this.entities.get(id);
  }

  heroXpNext(level: number): number {
    if (level >= this.balance.hero.maxLevel) return 0;
    return this.balance.hero.levelXpBase + this.balance.hero.levelXpStep * (level - 1);
  }

  // --------------------------------------------------------------- ticking

  tick(dt: number): void {
    if (this.phase !== "playing") return;
    this.time += dt;
    this.tickCount += 1;

    for (const p of this.players) {
      if (p.role === "defender" && !p.surrendered) {
        p.gold += this.balance.match.defenderPassiveGoldPerSecond * dt;
      }
      for (const skill of Object.keys(p.heroCooldowns)) {
        const left = p.heroCooldowns[skill] ?? 0;
        if (left > 0) p.heroCooldowns[skill] = Math.max(0, left - dt);
      }
    }

    this.updateHeroRespawns();

    const list = [...this.entities.values()];
    for (const entity of list) {
      if (!this.entities.has(entity.id)) continue;
      if (entity.kind === "building") this.updateBuilding(entity, dt);
      else this.updateUnit(entity, dt);
    }
    this.separateUnits();
    this.recomputeSupply();
    this.checkVictory();
  }

  private updateHeroRespawns(): void {
    for (const team of [0, 1] as const) {
      const id = this.heroIds[team];
      if (id !== null && this.entities.has(id)) continue;
      if (this.time < this.heroRespawnAt[team]) continue;
      const hall = this.findHall(team);
      if (!hall) continue;
      const spot = this.freeSpotNear(hall.x + (team === 0 ? -8 : 8), hall.y);
      const hero = this.createUnit(team, "hero", spot.x, spot.y, false);
      hero.level = this.players[team]!.heroLevel;
      hero.maxHp = this.balance.units.hero.hp
        + (hero.level - 1) * this.balance.hero.hpPerLevel;
      hero.hp = hero.maxHp;
      this.heroIds[team] = hero.id;
      this.pushEvent({ type: "notice", team, text: "Герой вернулся в бой" });
    }
  }

  private updateBuilding(building: Entity, dt: number): void {
    const def = this.buildingDef(building);
    if (building.cooldown > 0) building.cooldown = Math.max(0, building.cooldown - dt);

    if (def.attack && building.done) {
      const target = this.nearestEnemy(
        building,
        def.attack.range,
        (enemy) => distance(building.x, building.y, enemy.x, enemy.y) - enemy.radius <= def.attack!.range,
      );
      if (target) {
        if (building.cooldown <= 0) {
          building.cooldown = def.attack.cooldown;
          building.facing = Math.atan2(target.y - building.y, target.x - building.x);
          this.pushEvent({
            type: "attack",
            fromX: building.x,
            fromY: building.y,
            toX: target.x,
            toY: target.y,
            team: building.team,
            ranged: true,
          });
          this.dealDamage(building, target, def.attack.damage + this.techValue(this.playerOf(building.team), "damage"));
        }
      }
    }

    if (!building.done || building.queue.length === 0) return;
    const item = building.queue[0]!;
    const unitDef = this.balance.units[item.kind];
    item.progress += dt;
    if (item.progress < unitDef.buildTime) return;

    if (!this.hasSupplyRoom(building.team, 0)) {
      item.progress = unitDef.buildTime;
      return;
    }

    building.queue.shift();
    const spawn = this.spawnNearBuilding(building, unitDef.radius);
    const unit = this.createUnit(building.team, item.kind, spawn.x, spawn.y, false);
    unit.hp = unit.maxHp;
    if (building.rally) {
      unit.order = { type: "move", x: building.rally.x, y: building.rally.y, attackMove: true };
    }
    const stats = this.stats[building.team as 0 | 1];
    if (stats) stats.unitsTrained += 1;
  }

  private updateUnit(unit: Entity, dt: number): void {
    if (unit.cooldown > 0) unit.cooldown = Math.max(0, unit.cooldown - dt);
    if (unit.attackAnim > 0) unit.attackAnim = Math.max(0, unit.attackAnim - dt);
    if (unit.buffUntil > 0 && unit.buffUntil <= this.time) {
      unit.buffUntil = 0;
      unit.buffSpeed = 0;
      unit.buffDamage = 0;
    }

    const order = unit.order;
    switch (order.type) {
      case "idle":
        this.updateIdle(unit);
        break;
      case "move":
        this.updateMove(unit, order, dt);
        break;
      case "attack":
        this.updateAttackOrder(unit, order, dt);
        break;
      case "gather":
        this.updateGather(unit, order, dt);
        break;
      case "build":
        this.updateConstruction(unit, order.target, dt);
        break;
      case "repair":
        this.updateRepair(unit, order.target, dt);
        break;
    }
  }

  private updateIdle(unit: Entity): void {
    if (unit.team === 2) {
      const post = this.guardPosts.get(unit.id);
      if (post && distance(unit.x, unit.y, post.x, post.y) > 11) {
        this.moveTowards(unit, post.x, post.y, 0.05);
        return;
      }
    }
    if (unit.type === "worker") return;
    const def = this.unitDef(unit);
    const radius = Math.max(6, def.range + 2);
    const target = this.nearestEnemy(unit, radius);
    if (target) {
      unit.order = { type: "attack", target: target.id };
    }
  }

  private updateMove(
    unit: Entity,
    order: Extract<Order, { type: "move" }>,
    dt: number,
  ): void {
    if (order.attackMove) {
      const target = this.nearestEnemy(unit, Math.max(8, this.unitDef(unit).vision));
      if (target) {
        unit.order = { type: "attack", target: target.id, rx: order.x, ry: order.y };
        return;
      }
    }
    const arrived = this.moveTowards(unit, order.x, order.y, dt, 0.7);
    if (arrived) unit.order = { type: "idle" };
  }

  private updateAttackOrder(
    unit: Entity,
    order: Extract<Order, { type: "attack" }>,
    dt: number,
  ): void {
    let target = this.entities.get(order.target);

    if (!target || !hostile(unit.team, target.team)) {
      if (order.rx !== undefined && order.ry !== undefined) {
        unit.order = { type: "move", x: order.rx, y: order.ry, attackMove: true };
      } else {
        unit.order = { type: "idle" };
      }
      return;
    }

    if (unit.team === 2) {
      const post = this.guardPosts.get(unit.id);
      if (post && distance(unit.x, unit.y, post.x, post.y) > 18) {
        unit.order = { type: "idle" };
        return;
      }
    }

    const def = this.unitDef(unit);
    const dx = target.x - unit.x;
    const dy = target.y - unit.y;
    const edge = Math.hypot(dx, dy) - target.radius - unit.radius;
    if (edge <= def.range) {
      unit.facing = Math.atan2(dy, dx);
      unit.path = null;
      if (unit.cooldown <= 0) {
        unit.cooldown = def.cooldown;
        unit.attackAnim = 0.2;
        this.pushEvent({
          type: "attack",
          fromX: unit.x,
          fromY: unit.y,
          toX: target.x,
          toY: target.y,
          team: unit.team,
          ranged: def.projectile,
        });
        const raw = this.unitDamage(unit);
        this.dealDamage(unit, target, raw.damage);
        this.applyCleave(unit, target, raw.damage);
      }
      return;
    }

    const goal = this.approachPoint(unit, target);
    const arrived = this.moveTowards(unit, goal.x, goal.y, dt, 0.35);
    if (arrived) {
      // Дошли, но цель могла сдвинуться — следующий тик атакует.
      unit.path = null;
    }
  }

  private updateGather(
    unit: Entity,
    order: Extract<Order, { type: "gather" }>,
    dt: number,
  ): void {
    if (unit.type !== "worker") {
      unit.order = { type: "idle" };
      return;
    }
    const node = this.nodes.find((n) => n.id === order.node);
    if (!node || node.amount <= 0) {
      unit.order = { type: "idle" };
      return;
    }
    const def = this.unitDef(unit);
    const carryCap = def.carry ?? 12;
    const gatherRate = (def.gatherRate ?? 6) * (1 + this.techValue(this.playerOf(unit.team), "gather"));

    if (order.stage === "toNode" || order.stage === "gathering") {
      if (order.stage === "toNode") {
        const angle = (unit.id % 12) * 0.52;
        const gx = node.x + Math.cos(angle) * (node.radius + 0.9);
        const gy = node.y + Math.sin(angle) * (node.radius + 0.9);
        const arrived = this.moveTowards(unit, gx, gy, dt, 0.9);
        if (!arrived) return;
        order.stage = "gathering";
        order.progress = 0;
      }
      if (unit.carryKind && unit.carryKind !== node.kind) {
        unit.carry = 0;
      }
      unit.carryKind = node.kind;
      const take = Math.min(gatherRate * dt, node.amount, carryCap - unit.carry);
      if (take <= 0) {
        if (unit.carry >= carryCap - 0.001) order.stage = "toDrop";
        return;
      }
      node.amount -= take;
      unit.carry += take;
      if (unit.carry >= carryCap - 0.001 || node.amount <= 0) {
        order.stage = "toDrop";
      }
      return;
    }

    if (order.stage === "toDrop") {
      const drop = this.nearestDropOff(unit.team, unit.x, unit.y);
      if (!drop) {
        order.stage = "toNode";
        return;
      }
      const goal = this.approachPoint(unit, drop);
      const arrived = this.moveTowards(unit, goal.x, goal.y, dt, 0.9);
      if (!arrived) return;
      order.stage = "depositing";
    }

    if (order.stage === "depositing") {
      const player = this.playerOf(unit.team);
      const amount = Math.floor(unit.carry);
      if (player && amount > 0) {
        if (unit.carryKind === "gold") {
          player.gold += amount;
          const stats = this.stats[unit.team as 0 | 1];
          if (stats) stats.goldGathered += amount;
        } else {
          player.wood += amount;
          const stats = this.stats[unit.team as 0 | 1];
          if (stats) stats.woodGathered += amount;
        }
      }
      unit.carry = 0;
      unit.carryKind = null;
      order.stage = "toNode";
      order.progress = 0;
      if (node.amount <= 0) unit.order = { type: "idle" };
    }
  }

  private updateConstruction(unit: Entity, targetId: number, dt: number): void {
    if (unit.type !== "worker") {
      unit.order = { type: "idle" };
      return;
    }
    const target = this.entities.get(targetId);
    if (!target || target.kind !== "building" || target.team !== unit.team) {
      unit.order = { type: "idle" };
      return;
    }
    if (target.done) {
      unit.order = { type: "idle" };
      return;
    }
    const goal = this.approachPoint(unit, target);
    const arrived = this.moveTowards(unit, goal.x, goal.y, dt, 0.8);
    if (!arrived) return;

    const def = this.unitDef(unit);
    const buildingDef = this.buildingDef(target);
    target.progress = Math.min(
      1,
      target.progress + (dt * (def.buildPower ?? 1)) / Math.max(1, buildingDef.buildTime),
    );
    target.hp = Math.max(1, target.maxHp * (0.1 + 0.9 * target.progress));
    if (target.progress >= 1) {
      target.done = true;
      target.hp = target.maxHp;
      const stats = this.stats[unit.team as 0 | 1];
      if (stats) stats.buildingsBuilt += 1;
      this.pushEvent({
        type: "notice",
        team: unit.team,
        text: `Построено: ${buildingDef.name}`,
      });
      for (const other of this.entities.values()) {
        if (
          other.kind === "unit" &&
          other.team === unit.team &&
          other.order.type === "build" &&
          other.order.target === target.id
        ) {
          other.order = { type: "idle" };
        }
      }
      unit.order = { type: "idle" };
    }
  }

  private updateRepair(unit: Entity, targetId: number, dt: number): void {
    if (unit.type !== "worker") {
      unit.order = { type: "idle" };
      return;
    }
    const target = this.entities.get(targetId);
    if (!target || target.kind !== "building" || target.team !== unit.team) {
      unit.order = { type: "idle" };
      return;
    }
    // Ремонт умеет и достраивать: рабочий продолжает чужую недостроенную площадку.
    const unfinished = !target.done;
    if (!unfinished && target.hp >= target.maxHp) {
      unit.order = { type: "idle" };
      return;
    }
    const goal = this.approachPoint(unit, target);
    const arrived = this.moveTowards(unit, goal.x, goal.y, dt, 0.8);
    if (!arrived) return;

    const def = this.unitDef(unit);
    const buildingDef = this.buildingDef(target);
    if (unfinished) {
      target.progress = Math.min(
        1,
        target.progress + (dt * (def.buildPower ?? 1)) / Math.max(1, buildingDef.buildTime),
      );
      target.hp = Math.max(1, target.maxHp * (0.1 + 0.9 * target.progress));
      if (target.progress >= 1) {
        target.done = true;
        target.hp = target.maxHp;
        const stats = this.stats[unit.team as 0 | 1];
        if (stats) stats.buildingsBuilt += 1;
        this.pushEvent({
          type: "notice",
          team: unit.team,
          text: `Построено: ${buildingDef.name}`,
        });
        for (const other of this.entities.values()) {
          if (
            other.kind === "unit" &&
            other.team === unit.team &&
            (other.order.type === "build" || other.order.type === "repair") &&
            other.order.target === target.id
          ) {
            other.order = { type: "idle" };
          }
        }
        unit.order = { type: "idle" };
      }
      return;
    }

    const heal = (target.maxHp / Math.max(1, buildingDef.buildTime)) * dt * (def.buildPower ?? 1) * 1.4;
    target.hp = Math.min(target.maxHp, target.hp + heal);
    if (target.hp >= target.maxHp) unit.order = { type: "idle" };
  }

  // --------------------------------------------------------------- movement

  private unitSpeed(unit: Entity): number {
    const def = this.unitDef(unit);
    let speed = def.speed;
    if (unit.carry > 0) speed *= 0.92;
    if (unit.buffUntil > this.time) speed *= 1 + unit.buffSpeed;
    return speed;
  }

  /** Возвращает true, когда точка достигнута. */
  moveTowards(unit: Entity, tx: number, ty: number, dt: number, stopDist = 0.6): boolean {
    const direct = Math.hypot(tx - unit.x, ty - unit.y);
    if (direct <= stopDist) {
      unit.path = null;
      return true;
    }
    if (!unit.path || this.time >= unit.repathAt) {
      if (this.grid.lineOfSight({ x: unit.x, y: unit.y }, { x: tx, y: ty })) {
        unit.path = [{ x: tx, y: ty }];
      } else {
        const path = this.grid.findPath({ x: unit.x, y: unit.y }, { x: tx, y: ty });
        if (!path) {
          unit.path = null;
          unit.repathAt = this.time + 0.6;
          return false;
        }
        unit.path = path;
      }
      unit.pathIndex = 0;
      unit.repathAt = this.time + 1.6;
    }

    let waypoint = unit.path[unit.pathIndex];
    while (waypoint && Math.hypot(waypoint.x - unit.x, waypoint.y - unit.y) < 1.0) {
      unit.pathIndex += 1;
      waypoint = unit.path[unit.pathIndex];
    }
    if (!waypoint) {
      unit.path = null;
      return true;
    }

    const dx = waypoint.x - unit.x;
    const dy = waypoint.y - unit.y;
    const len = Math.hypot(dx, dy) || 1;
    const speed = this.unitSpeed(unit);
    let nx = unit.x + (dx / len) * speed * dt;
    let ny = unit.y + (dy / len) * speed * dt;

    if (this.grid.isBlockedWorld(nx, ny)) {
      if (!this.grid.isBlockedWorld(nx, unit.y)) {
        ny = unit.y;
      } else if (!this.grid.isBlockedWorld(unit.x, ny)) {
        nx = unit.x;
      } else {
        unit.path = null;
        unit.repathAt = this.time + 0.35;
        return false;
      }
    }
    unit.x = clamp(nx, 1.5, this.map.width - 1.5);
    unit.y = clamp(ny, 1.5, this.map.height - 1.5);
    unit.facing = Math.atan2(dy, dx);
    return false;
  }

  private approachPoint(unit: Entity, target: Entity): Vec2 {
    const dx = unit.x - target.x;
    const dy = unit.y - target.y;
    const len = Math.hypot(dx, dy) || 1;
    const want = target.radius + unit.radius + 0.35;
    if (len <= want) return { x: unit.x, y: unit.y };
    return { x: target.x + (dx / len) * want, y: target.y + (dy / len) * want };
  }

  private separateUnits(): void {
    const units = [...this.entities.values()].filter((e) => e.kind === "unit");
    for (let i = 0; i < units.length; i++) {
      const a = units[i]!;
      for (let j = i + 1; j < units.length; j++) {
        const b = units[j]!;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const minDist = (a.radius + b.radius) * 1.02;
        const d2 = dx * dx + dy * dy;
        if (d2 >= minDist * minDist || d2 < 1e-6) continue;
        const d = Math.sqrt(d2);
        const overlap = (minDist - d) / 2;
        const nx = dx / d;
        const ny = dy / d;
        const ax = a.x - nx * overlap;
        const ay = a.y - ny * overlap;
        const bx = b.x + nx * overlap;
        const by = b.y + ny * overlap;
        if (!this.grid.isBlockedWorld(ax, ay)) {
          a.x = clamp(ax, 1.5, this.map.width - 1.5);
          a.y = clamp(ay, 1.5, this.map.height - 1.5);
        }
        if (!this.grid.isBlockedWorld(bx, by)) {
          b.x = clamp(bx, 1.5, this.map.width - 1.5);
          b.y = clamp(by, 1.5, this.map.height - 1.5);
        }
      }
    }
  }

  // ----------------------------------------------------------------- combat

  private unitDamage(unit: Entity): { damage: number; projectile: boolean } {
    const def = this.unitDef(unit);
    let damage = def.damage;
    if (unit.type === "hero") {
      damage += (unit.level - 1) * this.balance.hero.damagePerLevel;
    }
    damage += this.techValue(this.playerOf(unit.team), "damage");
    if (unit.buffUntil > this.time) damage *= 1 + unit.buffDamage;
    const aura = this.heroAura(unit);
    if (aura > 0) damage *= 1 + aura;
    return { damage, projectile: def.projectile };
  }

  private heroAura(unit: Entity): number {
    if (unit.team === 2) return 0;
    const heroId = this.heroIds[unit.team];
    if (heroId === null) return 0;
    const hero = this.entities.get(heroId);
    if (!hero || hero.type !== "hero") return 0;
    const level = this.players[unit.team]!.heroSkills["rally"] ?? 0;
    if (level <= 0) return 0;
    const skill = this.balance.hero.skills.find((s) => s.id === "rally");
    const data = skill?.levels[level - 1];
    if (!data) return 0;
    const radius = Number(data["radius"] ?? 0);
    if (distance(unit.x, unit.y, hero.x, hero.y) > radius) return 0;
    return Number(data["bonus"] ?? 0);
  }

  private armorOf(target: Entity): number {
    const base = target.kind === "building"
      ? this.buildingDef(target).armor
      : this.unitDef(target).armor;
    const heroArmor = target.type === "hero"
      ? (target.level - 1) * this.balance.hero.armorPerLevel
      : 0;
    return base + heroArmor + this.techValue(this.playerOf(target.team), "armor");
  }

  private dealDamage(source: Entity, target: Entity, rawDamage: number): void {
    if (!this.entities.has(target.id)) return;
    let raw = rawDamage;
    if (source.type === "catapult" && target.kind === "building") {
      raw *= this.unitDef(source).buildingBonus ?? 1;
    }
    const amount = Math.max(1, Math.round(raw - this.armorOf(target)));
    target.hp -= amount;
    this.pushEvent({ type: "hit", x: target.x, y: target.y, amount });
    if (source.type === "hero") {
      this.addHeroXp(source.team, amount * 0.55);
    }
    if (source.kind === "unit") {
      const stats = this.stats[source.team as 0 | 1];
      if (stats) stats.damageDealt += amount;
    }
    if (target.hp <= 0) this.kill(target, source);
  }

  private applyCleave(unit: Entity, target: Entity, baseDamage: number): void {
    if (unit.type !== "hero") return;
    const level = this.players[unit.team as 0 | 1]!.heroSkills["cleave"] ?? 0;
    if (level <= 0) return;
    const skill = this.balance.hero.skills.find((s) => s.id === "cleave");
    const data = skill?.levels[level - 1];
    if (!data) return;
    const splash = Number(data["splash"] ?? 0);
    for (const enemy of [...this.entities.values()]) {
      if (enemy.id === target.id || !hostile(unit.team, enemy.team)) continue;
      if (distance(enemy.x, enemy.y, target.x, target.y) > 3.2) continue;
      this.dealDamage(unit, enemy, baseDamage * splash);
    }
  }

  private kill(target: Entity, source: Entity): void {
    if (!this.entities.has(target.id)) return;
    this.entities.delete(target.id);
    const stats = this.stats[target.team as 0 | 1];
    if (stats) {
      if (target.kind === "unit") stats.unitsLost += 1;
    }
    if (target.kind === "building") {
      const def = this.buildingDef(target);
      this.grid.removeBuilding(target.x, target.y, def.size / 2 + 0.2);
    }
    if (target.type === "hero") {
      this.heroIds[target.team as 0 | 1] = null;
      this.heroRespawnAt[target.team as 0 | 1] = this.time + this.balance.match.heroRespawnSeconds;
      this.pushEvent({
        type: "notice",
        team: target.team,
        text: `Герой пал. Возрождение через ${this.balance.match.heroRespawnSeconds} с`,
      });
    }
    if (target.type === "trophy") {
      if (source.team === 1) {
        this.players[1].gold += this.balance.match.attackerTrophyGold;
        this.stats[1].trophies += 1;
        this.pushEvent({
          type: "notice",
          team: 1,
          text: `Трофей захвачен: +${this.balance.match.attackerTrophyGold} золота`,
        });
        this.pushEvent({
          type: "notice",
          team: 0,
          text: "Атакующий захватил трофей",
        });
      } else if (source.team === 0) {
        this.players[0].wood += 60;
        this.stats[0].trophies += 1;
        this.pushEvent({ type: "notice", team: 0, text: "Трофей уничтожен: +60 дерева" });
      }
    }
    this.pushEvent({
      type: "death",
      x: target.x,
      y: target.y,
      team: target.team,
      kind: String(target.type),
    });

    if (source.type === "hero" && target.type !== "hero") {
      const xp = target.kind === "unit" ? this.unitDef(target).xp : 60;
      this.addHeroXp(source.team, xp);
    } else if (source.team !== 2) {
      const heroId = this.heroIds[source.team as 0 | 1];
      const hero = heroId !== null ? this.entities.get(heroId) : undefined;
      if (hero && distance(hero.x, hero.y, target.x, target.y) < 16) {
        const xp = target.kind === "unit" ? this.unitDef(target).xp : 40;
        this.addHeroXp(source.team, xp * 0.6);
      }
    }
  }

  private addHeroXp(team: Team, amount: number): void {
    if (team === 2) return;
    const player = this.players[team];
    if (!player || player.heroLevel >= this.balance.hero.maxLevel) return;
    player.heroXp += amount;
    let guard = 0;
    while (guard++ < 20 && player.heroLevel < this.balance.hero.maxLevel) {
      const need = this.heroXpNext(player.heroLevel);
      if (need === 0 || player.heroXp < need) break;
      player.heroXp -= need;
      player.heroLevel += 1;
      player.heroSkillPoints += 1;
      const heroId = this.heroIds[team as 0 | 1];
      const hero = heroId !== null ? this.entities.get(heroId) : undefined;
      if (hero) {
        hero.level = player.heroLevel;
        const newMax = this.balance.units.hero.hp
          + (player.heroLevel - 1) * this.balance.hero.hpPerLevel;
        hero.hp += newMax - hero.maxHp;
        hero.maxHp = newMax;
        this.pushEvent({
          type: "levelup",
          x: hero.x,
          y: hero.y,
          level: player.heroLevel,
          team,
        });
      }
    }
  }

  // ----------------------------------------------------------------- orders

  private nearestEnemy(
    origin: Entity,
    radius: number,
    filter?: (enemy: Entity) => boolean,
  ): Entity | undefined {
    let best: Entity | undefined;
    let bestDist = Infinity;
    for (const candidate of this.entities.values()) {
      if (!hostile(origin.team, candidate.team)) continue;
      if (filter && !filter(candidate)) continue;
      const d = distance(origin.x, origin.y, candidate.x, candidate.y) - candidate.radius;
      if (d > radius) continue;
      if (d < bestDist) {
        bestDist = d;
        best = candidate;
      }
    }
    return best;
  }

  private nearestDropOff(team: Team, x: number, y: number): Entity | undefined {
    let best: Entity | undefined;
    let bestDist = Infinity;
    for (const entity of this.entities.values()) {
      if (entity.kind !== "building" || entity.team !== team || !entity.done) continue;
      if (!this.buildingDef(entity).dropOff) continue;
      const d = distance(x, y, entity.x, entity.y);
      if (d < bestDist) {
        bestDist = d;
        best = entity;
      }
    }
    return best;
  }

  // ------------------------------------------------------------------ fog

  private computeFog(team: Team): void {
    const visible = this.fogVisible[team as 0 | 1];
    const explored = this.fogExplored[team as 0 | 1];
    visible.fill(0);
    for (const entity of this.entities.values()) {
      if (entity.team !== team) continue;
      const def = entity.kind === "building" ? this.buildingDef(entity) : this.unitDef(entity);
      const vision = def.vision;
      const minX = Math.max(0, Math.floor((entity.x - vision) / this.fogCell));
      const maxX = Math.min(this.fogW - 1, Math.floor((entity.x + vision) / this.fogCell));
      const minY = Math.max(0, Math.floor((entity.y - vision) / this.fogCell));
      const maxY = Math.min(this.fogH - 1, Math.floor((entity.y + vision) / this.fogCell));
      for (let cy = minY; cy <= maxY; cy++) {
        for (let cx = minX; cx <= maxX; cx++) {
          const wx = (cx + 0.5) * this.fogCell;
          const wy = (cy + 0.5) * this.fogCell;
          if (distance(entity.x, entity.y, wx, wy) <= vision) {
            const i = cy * this.fogW + cx;
            visible[i] = 1;
            explored[i] = 1;
          }
        }
      }
    }
  }

  private visibleAt(team: Team, x: number, y: number): boolean {
    const cx = Math.floor(x / this.fogCell);
    const cy = Math.floor(y / this.fogCell);
    if (cx < 0 || cy < 0 || cx >= this.fogW || cy >= this.fogH) return false;
    return this.fogVisible[team as 0 | 1][cy * this.fogW + cx] === 1;
  }

  // -------------------------------------------------------------- snapshot

  snapshot(team: Team, withFog = true): Snapshot {
    this.computeFog(team);
    const player = this.players[team as 0 | 1];
    const enemyTeam = (team === 0 ? 1 : 0) as Team;
    const enemy = this.players[enemyTeam as 0 | 1];

    const entities: Snapshot["entities"] = [];
    for (const entity of this.entities.values()) {
      if (entity.team !== team && !this.visibleAt(team, entity.x, entity.y)) continue;
      entities.push({
        id: entity.id,
        k: entity.kind === "unit" ? "u" : "b",
        t: entity.type,
        team: entity.team,
        x: round2(entity.x),
        y: round2(entity.y),
        hp: Math.max(0, Math.round(entity.hp)),
        mhp: Math.round(entity.maxHp),
        done: entity.done,
        pr: round2(entity.progress),
        carry: Math.floor(entity.carry),
        carryKind: entity.carryKind,
        level: entity.level,
        queue: entity.queue.length,
        qp: entity.queue.length
          ? Math.min(1, entity.queue[0]!.progress / Math.max(0.001, this.balance.units[entity.queue[0]!.kind].buildTime))
          : 0,
        qk: entity.queue.map((item) => item.kind),
        rallyX: entity.rally ? round2(entity.rally.x) : null,
        rallyY: entity.rally ? round2(entity.rally.y) : null,
        buff: round2(Math.max(0, entity.buffUntil - this.time)),
      });
    }

    let fog: string | null = null;
    if (withFog) {
      const visible = this.fogVisible[team as 0 | 1];
      const explored = this.fogExplored[team as 0 | 1];
      const bytes = new Uint8Array(visible.length);
      for (let i = 0; i < visible.length; i++) {
        bytes[i] = visible[i] === 1 ? 2 : explored[i] === 1 ? 1 : 0;
      }
      fog = encodeBase64(bytes);
    }

    const events = this.events.filter((event) => {
      if (event.type === "notice") return event.team === null || event.team === team;
      if ("team" in event && event.team === team) return true;
      if (event.type === "levelup") return event.team === team;
      if (event.type === "attack") {
        return event.team === team || this.visibleAt(team, event.fromX, event.fromY);
      }
      if (event.type === "death" || event.type === "hit") {
        return this.visibleAt(team, event.x, event.y);
      }
      return false;
    });

    return {
      tick: this.tickCount,
      time: round2(this.time),
      phase: this.phase,
      winner: this.winner,
      reason: this.endReason,
      you: this.playerView(player, false),
      enemy: this.playerView(enemy, true),
      entities,
      nodes: this.nodes.map((n) => ({
        id: n.id,
        kind: n.kind,
        x: n.x,
        y: n.y,
        amount: Math.max(0, Math.round(n.amount)),
        max: n.maxAmount,
      })),
      events,
      fog,
      fogW: this.fogW,
      fogH: this.fogH,
      fogCell: this.fogCell,
      stats: this.stats[team as 0 | 1] ?? emptyStats(),
    };
  }

  private playerView(p: PlayerState, hidden: boolean): PlayerView {
    const respawn = this.heroIds[p.team as 0 | 1] === null
      ? Math.max(0, this.heroRespawnAt[p.team as 0 | 1] - this.time)
      : 0;
    if (hidden) {
      return {
        team: p.team,
        role: p.role,
        name: p.name,
        gold: 0,
        wood: 0,
        supplyUsed: p.supplyUsed,
        supplyCap: p.supplyCap,
        tier: p.tier,
        techs: {},
        heroLevel: p.heroLevel,
        heroXp: 0,
        heroXpNext: 0,
        heroSkillPoints: 0,
        heroSkills: {},
        heroCooldowns: {},
        heroRespawnIn: Math.round(respawn),
        surrendered: p.surrendered,
        connected: p.connected,
      };
    }
    return {
      team: p.team,
      role: p.role,
      name: p.name,
      gold: Math.floor(p.gold),
      wood: Math.floor(p.wood),
      supplyUsed: p.supplyUsed,
      supplyCap: p.supplyCap,
      tier: p.tier,
      techs: { ...p.techs },
      heroLevel: p.heroLevel,
      heroXp: Math.floor(p.heroXp),
      heroXpNext: this.heroXpNext(p.heroLevel),
      heroSkillPoints: p.heroSkillPoints,
      heroSkills: { ...p.heroSkills },
      heroCooldowns: { ...p.heroCooldowns },
      heroRespawnIn: Math.round(respawn),
      surrendered: p.surrendered,
      connected: p.connected,
    };
  }

  // --------------------------------------------------------------- economy

  private recomputeSupply(): void {
    for (const team of [0, 1] as const) {
      const player = this.players[team];
      let used = 0;
      for (const entity of this.entities.values()) {
        if (entity.kind !== "unit" || entity.team !== team) continue;
        used += this.unitDef(entity).supply;
      }
      let cap = this.balance.match.baseSupply;
      for (const entity of this.entities.values()) {
        if (entity.kind !== "building" || entity.team !== team || !entity.done) continue;
        cap += this.buildingDef(entity).supply;
      }
      player.supplyUsed = used;
      player.supplyCap = Math.min(this.balance.match.supplyCap, cap);
    }
  }

  private queuedSupply(team: Team): number {
    let queued = 0;
    for (const entity of this.entities.values()) {
      if (entity.kind !== "building" || entity.team !== team) continue;
      for (const item of entity.queue) queued += this.balance.units[item.kind].supply;
    }
    return queued;
  }

  private hasSupplyRoom(team: Team, extra: number): boolean {
    const player = this.players[team as 0 | 1];
    if (!player) return false;
    return player.supplyUsed + this.queuedSupply(team) + extra <= player.supplyCap;
  }

  private canAfford(player: PlayerState, cost: Cost): boolean {
    return player.gold >= cost.gold && player.wood >= cost.wood;
  }

  private pay(player: PlayerState, cost: Cost): void {
    player.gold -= cost.gold;
    player.wood -= cost.wood;
  }

  private refund(player: PlayerState, cost: Cost): void {
    player.gold += cost.gold;
    player.wood += cost.wood;
  }

  private techValue(player: PlayerState | null, tech: string): number {
    if (!player) return 0;
    const level = player.techs[tech] ?? 0;
    if (level <= 0) return 0;
    const def = this.balance.techs[tech];
    if (!def) return 0;
    return def.levels[level - 1]?.bonus ?? 0;
  }

  private playerOf(team: Team): PlayerState | null {
    if (team === 0) return this.players[0];
    if (team === 1) return this.players[1];
    return null;
  }

  // -------------------------------------------------------------- commands

  applyCommand(team: Team, cmd: Command): CommandResult {
    if (team !== 0 && team !== 1) return { ok: false, error: "Неизвестная команда" };
    const player = this.players[team];
    if (this.phase !== "playing") return { ok: false, error: "Матч уже завершён" };
    if (player.surrendered) return { ok: false, error: "Вы сдались" };

    switch (cmd.t) {
      case "move": {
        const units = this.ownUnits(team, cmd.ids);
        if (!units.length) return { ok: false, error: "Нет выбранных юнитов" };
        const spots = this.formation(cmd.x, cmd.y, units.length);
        units.forEach((unit, index) => {
          const spot = spots[index]!;
          unit.order = { type: "move", x: spot.x, y: spot.y, attackMove: false };
          unit.path = null;
          unit.aggro = null;
        });
        return { ok: true };
      }
      case "attackMove": {
        const units = this.ownUnits(team, cmd.ids);
        if (!units.length) return { ok: false, error: "Нет выбранных юнитов" };
        const spots = this.formation(cmd.x, cmd.y, units.length);
        units.forEach((unit, index) => {
          const spot = spots[index]!;
          unit.order = { type: "move", x: spot.x, y: spot.y, attackMove: true };
          unit.path = null;
        });
        return { ok: true };
      }
      case "attack": {
        const units = this.ownUnits(team, cmd.ids);
        const target = this.entities.get(cmd.target);
        if (!units.length) return { ok: false, error: "Нет выбранных юнитов" };
        if (!target || !hostile(team, target.team)) return { ok: false, error: "Неверная цель" };
        for (const unit of units) {
          unit.order = { type: "attack", target: target.id };
          unit.path = null;
        }
        return { ok: true };
      }
      case "stop": {
        for (const unit of this.ownUnits(team, cmd.ids)) {
          unit.order = { type: "idle" };
          unit.path = null;
        }
        return { ok: true };
      }
      case "gather": {
        const workers = this.ownUnits(team, cmd.ids).filter((u) => u.type === "worker");
        const node = this.nodes.find((n) => n.id === cmd.node && n.amount > 0);
        if (!workers.length) return { ok: false, error: "Нужны рабочие" };
        if (!node) return { ok: false, error: "Месторождение истощено" };
        for (const worker of workers) {
          worker.order = {
            type: "gather",
            node: node.id,
            stage: "toNode",
            progress: 0,
          };
          worker.path = null;
        }
        return { ok: true };
      }
      case "build": {
        const workers = this.ownUnits(team, cmd.ids).filter((u) => u.type === "worker");
        if (!workers.length) return { ok: false, error: "Нужны рабочие" };
        const def = this.balance.buildings[cmd.building];
        if (!def || cmd.building === "hall" || cmd.building === "trophy" || def.neutralOnly) {
          return { ok: false, error: "Это здание нельзя строить" };
        }
        if (def.attackerOnly && player.role !== "attacker") {
          return { ok: false, error: "Форпост доступен только атакующему" };
        }
        if (def.requiresTier && player.tier < def.requiresTier) {
          return { ok: false, error: `Нужен ${def.requiresTier}-й уровень базы` };
        }
        if (!this.canAfford(player, def.cost)) {
          return { ok: false, error: "Не хватает ресурсов" };
        }
        if (!this.canPlaceBuilding(team, cmd.building, cmd.x, cmd.y)) {
          return { ok: false, error: "Здесь нельзя строить" };
        }
        this.pay(player, def.cost);
        const building = this.createBuilding(team, cmd.building, cmd.x, cmd.y, false);
        for (const worker of workers) {
          worker.order = { type: "build", target: building.id };
          worker.path = null;
        }
        return { ok: true };
      }
      case "repair": {
        const workers = this.ownUnits(team, cmd.ids).filter((u) => u.type === "worker");
        const target = this.entities.get(cmd.target);
        if (!workers.length) return { ok: false, error: "Нужны рабочие" };
        if (!target || target.kind !== "building" || target.team !== team) {
          return { ok: false, error: "Неверная цель ремонта" };
        }
        for (const worker of workers) {
          worker.order = { type: "repair", target: target.id };
          worker.path = null;
        }
        return { ok: true };
      }
      case "train": {
        const building = this.entities.get(cmd.building);
        if (!building || building.kind !== "building" || building.team !== team) {
          return { ok: false, error: "Неверное здание" };
        }
        if (!building.done) return { ok: false, error: "Здание ещё строится" };
        const def = this.buildingDef(building);
        if (!def.train?.includes(cmd.unit)) {
          return { ok: false, error: "Этот юнит здесь не обучается" };
        }
        if (building.queue.length >= 5) return { ok: false, error: "Очередь заполнена" };
        const unitDef = this.balance.units[cmd.unit];
        if (!this.canAfford(player, unitDef.cost)) {
          return { ok: false, error: "Не хватает ресурсов" };
        }
        if (!this.hasSupplyRoom(team, unitDef.supply)) {
          return { ok: false, error: "Не хватает снабжения — постройте дома" };
        }
        this.pay(player, unitDef.cost);
        building.queue.push({ kind: cmd.unit, progress: 0 });
        return { ok: true };
      }
      case "cancelTrain": {
        const building = this.entities.get(cmd.building);
        if (!building || building.kind !== "building" || building.team !== team) {
          return { ok: false, error: "Неверное здание" };
        }
        const item = building.queue[cmd.index];
        if (!item) return { ok: false, error: "Нет такой очереди" };
        building.queue.splice(cmd.index, 1);
        this.refund(player, this.balance.units[item.kind].cost);
        return { ok: true };
      }
      case "research": {
        const def = this.balance.techs[cmd.tech];
        if (!def) return { ok: false, error: "Неизвестная технология" };
        const level = player.techs[cmd.tech] ?? 0;
        if (level >= def.levels.length) return { ok: false, error: "Максимальный уровень" };
        const next = def.levels[level]!;
        if (!this.canAfford(player, next.cost)) return { ok: false, error: "Не хватает ресурсов" };
        this.pay(player, next.cost);
        player.techs[cmd.tech] = level + 1;
        this.pushEvent({ type: "notice", team, text: `${def.name}: уровень ${level + 1}` });
        return { ok: true };
      }
      case "tier": {
        const next = player.tier + 1;
        if (next > 3) return { ok: false, error: "Максимальный уровень базы" };
        const def = this.balance.tiers[String(next)];
        if (!def) return { ok: false, error: "Нет такого уровня" };
        if (!this.canAfford(player, def.cost)) return { ok: false, error: "Не хватает ресурсов" };
        this.pay(player, def.cost);
        player.tier = next;
        this.pushEvent({ type: "notice", team, text: `База улучшена до уровня ${next}` });
        return { ok: true };
      }
      case "rally": {
        const building = this.entities.get(cmd.building);
        if (!building || building.kind !== "building" || building.team !== team) {
          return { ok: false, error: "Неверное здание" };
        }
        building.rally = { x: clamp(cmd.x, 2, this.map.width - 2), y: clamp(cmd.y, 2, this.map.height - 2) };
        return { ok: true };
      }
      case "heroSkill": {
        const skill = this.balance.hero.skills.find((s) => s.id === cmd.skill);
        if (!skill) return { ok: false, error: "Неизвестный навык" };
        const level = player.heroSkills[skill.id] ?? 0;
        if (level >= skill.levels.length) return { ok: false, error: "Навык уже максимален" };
        if (player.heroSkillPoints <= 0) return { ok: false, error: "Нет очков навыков" };
        player.heroSkillPoints -= 1;
        player.heroSkills[skill.id] = level + 1;
        this.pushEvent({ type: "notice", team, text: `${skill.name}: уровень ${level + 1}` });
        return { ok: true };
      }
      case "heroAbility": {
        const heroId = this.heroIds[team];
        const hero = heroId !== null ? this.entities.get(heroId) : undefined;
        if (!hero || hero.type !== "hero") return { ok: false, error: "Герой не в бою" };
        const skill = this.balance.hero.skills.find((s) => s.id === cmd.skill);
        if (!skill || skill.type !== "active") return { ok: false, error: "Неизвестная способность" };
        const level = player.heroSkills[skill.id] ?? 0;
        if (level <= 0) return { ok: false, error: "Способность не изучена" };
        if ((player.heroCooldowns[skill.id] ?? 0) > 0) return { ok: false, error: "Способность перезаряжается" };
        const data = skill.levels[level - 1];
        if (!data) return { ok: false, error: "Нет данных способности" };
        if (skill.id === "mend") {
          const radius = Number(data["radius"] ?? 6);
          const heal = Number(data["heal"] ?? 80);
          for (const ally of this.entities.values()) {
            if (ally.kind !== "unit" || ally.team !== team) continue;
            if (distance(ally.x, ally.y, hero.x, hero.y) > radius) continue;
            ally.hp = Math.min(ally.maxHp, ally.hp + heal);
          }
          this.pushEvent({ type: "notice", team, text: "Исцеление применено" });
        } else if (skill.id === "charge") {
          hero.buffUntil = this.time + (skill.duration ?? 4);
          hero.buffSpeed = Number(data["speed"] ?? 0.3);
          hero.buffDamage = Number(data["damage"] ?? 0.2);
          this.pushEvent({ type: "notice", team, text: "Рывок: герой ускоряется" });
        }
        player.heroCooldowns[skill.id] = skill.cooldown ?? 15;
        return { ok: true };
      }
      case "surrender": {
        this.forfeit(team);
        return { ok: true };
      }
      default:
        return { ok: false, error: "Неизвестная команда" };
    }
  }

  private ownUnits(team: Team, ids: number[]): Entity[] {
    const seen = new Set<number>();
    const out: Entity[] = [];
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const entity = this.entities.get(id);
      if (entity && entity.kind === "unit" && entity.team === team) out.push(entity);
    }
    return out;
  }

  private formation(x: number, y: number, count: number): Vec2[] {
    if (count <= 1) return [{ x, y }];
    const out: Vec2[] = [];
    const spacing = 1.5;
    const cols = Math.ceil(Math.sqrt(count));
    const rows = Math.ceil(count / cols);
    for (let i = 0; i < count; i++) {
      const cx = i % cols;
      const cy = Math.floor(i / cols);
      out.push({
        x: clamp(x + (cx - (cols - 1) / 2) * spacing, 2, this.map.width - 2),
        y: clamp(y + (cy - (rows - 1) / 2) * spacing, 2, this.map.height - 2),
      });
    }
    return out;
  }

  // --------------------------------------------------------------- building

  canPlaceBuilding(team: Team, kind: BuildingKind, x: number, y: number): boolean {
    const def = this.balance.buildings[kind];
    if (!def) return false;
    const half = def.size / 2;
    if (x < 4 || y < 4 || x > this.map.width - 4 || y > this.map.height - 4) return false;
    if (!this.inBuildZone(team, x, y)) return false;
    if (!this.grid.buildingAreaFree(x, y, half + 0.2)) return false;
    for (const entity of this.entities.values()) {
      if (entity.kind === "building") {
        const otherHalf = entity.radius;
        if (
          Math.abs(entity.x - x) < half + otherHalf + 0.45 &&
          Math.abs(entity.y - y) < half + otherHalf + 0.45
        ) {
          return false;
        }
      } else if (
        Math.abs(entity.x - x) < half + entity.radius + 0.25 &&
        Math.abs(entity.y - y) < half + entity.radius + 0.25
      ) {
        return false;
      }
    }
    for (const node of this.nodes) {
      if (node.amount <= 0) continue;
      if (distance(x, y, node.x, node.y) < half + node.radius + 0.5) return false;
    }
    return true;
  }

  private inBuildZone(team: Team, x: number, y: number): boolean {
    const radius = this.balance.match.baseRadius;
    for (const entity of this.entities.values()) {
      if (entity.kind !== "building" || entity.team !== team || !entity.done) continue;
      let zone = 0;
      if (entity.type === "hall") zone = radius;
      else if (entity.type === "outpost") zone = 18;
      if (zone > 0 && distance(x, y, entity.x, entity.y) <= zone) return true;
    }
    return false;
  }

  findBuildSpot(team: Team, kind: BuildingKind): Vec2 | null {
    const hall = this.findHall(team);
    if (!hall) return null;
    const def = this.balance.buildings[kind];
    if (!def) return null;
    for (let ring = 8; ring <= 30; ring += 2.4) {
      for (let step = 0; step < 24; step++) {
        const angle = (step / 24) * Math.PI * 2 + ring * 0.15;
        const x = hall.x + Math.cos(angle) * ring;
        const y = hall.y + Math.sin(angle) * ring;
        if (this.canPlaceBuilding(team, kind, x, y)) return { x, y };
      }
    }
    // Пробуем форпосты атакующего.
    for (const outpost of this.buildingsOf(team)) {
      if (outpost.type !== "outpost") continue;
      for (let ring = 6; ring <= 16; ring += 2) {
        for (let step = 0; step < 16; step++) {
          const angle = (step / 16) * Math.PI * 2;
          const x = outpost.x + Math.cos(angle) * ring;
          const y = outpost.y + Math.sin(angle) * ring;
          if (this.canPlaceBuilding(team, kind, x, y)) return { x, y };
        }
      }
    }
    return null;
  }

  private spawnNearBuilding(building: Entity, radius: number): Vec2 {
    for (let step = 0; step < 12; step++) {
      const angle = (step / 12) * Math.PI * 2;
      const x = building.x + Math.cos(angle) * (building.radius + 1.2 + radius);
      const y = building.y + Math.sin(angle) * (building.radius + 1.2 + radius);
      if (!this.grid.isBlockedWorld(x, y)) return { x, y };
    }
    return this.freeSpotNear(building.x + building.radius + 2, building.y + building.radius + 2);
  }

  freeSpotNear(x: number, y: number): Vec2 {
    const cell = this.grid.toCell(x, y);
    const free = this.grid.nearestFree(cell.cx, cell.cy, 20);
    if (free) {
      const center = this.grid.center(free.cx, free.cy);
      return {
        x: clamp(center.x, 2, this.map.width - 2),
        y: clamp(center.y, 2, this.map.height - 2),
      };
    }
    return { x: clamp(x, 2, this.map.width - 2), y: clamp(y, 2, this.map.height - 2) };
  }

  // ---------------------------------------------------------------- helpers

  unitDef(entity: Entity): UnitDef {
    return this.balance.units[entity.type as UnitKind];
  }

  buildingDef(entity: Entity): BuildingDef {
    return this.balance.buildings[entity.type as BuildingKind];
  }

  private pushEvent(event: SimEvent): void {
    if (this.events.length > 300) this.events.shift();
    this.events.push(event);
  }

  clearEvents(): void {
    this.events = [];
  }

  forfeit(team: Team): void {
    if (this.phase === "ended") return;
    const player = this.players[team as 0 | 1];
    if (player) player.surrendered = true;
    this.endMatch((team === 0 ? 1 : 0) as Team, team === 0 ? "Защитник сдался" : "Атакующий сдался");
  }

  endMatch(winner: Team | null, reason: string): void {
    if (this.phase === "ended") return;
    this.phase = "ended";
    this.winner = winner;
    this.endReason = reason;
    this.pushEvent({ type: "notice", team: null, text: reason });
  }

  private checkVictory(): void {
    if (this.phase === "ended") return;
    const hall0 = this.findHall(0);
    const hall1 = this.findHall(1);
    if (!hall0 && !hall1) {
      this.endMatch(null, "Обе базы разрушены — ничья");
      return;
    }
    if (!hall0) {
      this.endMatch(1, "Главный зал защитника разрушен. Победа атакующего!");
      return;
    }
    if (!hall1) {
      this.endMatch(0, "Лагерь атакующего уничтожен. Победа защитника!");
      return;
    }
    if (this.players[0].surrendered) {
      this.endMatch(1, "Защитник сдался");
      return;
    }
    if (this.players[1].surrendered) {
      this.endMatch(0, "Атакующий сдался");
      return;
    }
    if (this.time >= this.balance.match.durationSeconds) {
      this.endMatch(0, "Время вышло: защитник выстоял");
    }
  }
}

function emptyStats(): Stats {
  return {
    unitsTrained: 0,
    unitsLost: 0,
    buildingsBuilt: 0,
    goldGathered: 0,
    woodGathered: 0,
    damageDealt: 0,
    trophies: 0,
  };
}

function makePlayer(
  team: Team,
  role: Role,
  name: string,
  match: Balance["match"],
): PlayerState {
  return {
    team,
    role,
    name,
    gold: match.startingGold,
    wood: match.startingWood,
    supplyUsed: 0,
    supplyCap: match.baseSupply,
    tier: 1,
    techs: {},
    heroLevel: 1,
    heroXp: 0,
    heroSkillPoints: 1,
    heroSkills: {},
    heroCooldowns: {},
    surrendered: false,
    connected: true,
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
