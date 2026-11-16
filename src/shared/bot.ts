import type { BuildingKind, Team, UnitKind, Vec2 } from "./types.js";
import type { World } from "./world.js";
import { Rng } from "./rng.js";

/**
 * Простой, но живой бот: пользуется теми же командами, что и человек,
 * поэтому в оффлайн-режиме нет отдельной «читерской» логики.
 * Случайность бота идёт через собственный ГПСЧ с seed карты, чтобы
 * матч можно было воспроизвести в тестах.
 */
export class Bot {
  private thinkAt = 0;
  private lastAttackAt = -999;
  private lastDefendAt = -999;
  private lastBuild = new Map<string, number>();
  private readonly rng: Rng;

  constructor(
    readonly world: World,
    readonly team: Team,
  ) {
    this.rng = new Rng(world.map.seed ^ (team === 0 ? 0x51ed270b : 0x1d2f6c4d));
  }

  update(dt: number): void {
    if (this.world.phase !== "playing") return;
    this.thinkAt -= dt;
    if (this.thinkAt > 0) return;
    this.thinkAt = 0.9;
    this.think();
  }

  private think(): void {
    const world = this.world;
    const team = this.team;
    const player = world.players[team as 0 | 1];
    if (!player || player.surrendered) return;

    this.useHeroAbilities();
    this.spendSkillPoints();
    this.assignWorkers();
    this.resumeConstruction();
    this.manageBuildings();
    this.trainArmy();
    this.research();
    this.manageArmy();
  }

  private cmd(command: Parameters<World["applyCommand"]>[1]): void {
    this.world.applyCommand(this.team, command);
  }

  // -------------------------------------------------------------- economy

  private assignWorkers(): void {
    const world = this.world;
    const workers = world.unitsOf(this.team).filter((u) => u.type === "worker");
    if (!workers.length) return;

    let woodWorkers = 0;
    let goldWorkers = 0;
    for (const worker of workers) {
      if (worker.order.type !== "gather") continue;
      const order = worker.order;
      const node = world.nodes.find((n) => n.id === order.node);
      if (!node) continue;
      if (node.kind === "wood") woodWorkers++;
      else goldWorkers++;
    }

    for (const worker of workers) {
      if (worker.order.type !== "idle") continue;
      const wantWood = woodWorkers < 3;
      const node = this.pickNode(wantWood ? "wood" : "gold", worker.x, worker.y);
      if (!node) {
        const fallback = this.pickNode(wantWood ? "gold" : "wood", worker.x, worker.y);
        if (!fallback) continue;
        this.cmd({ t: "gather", ids: [worker.id], node: fallback.id });
        if (fallback.kind === "wood") woodWorkers++;
        else goldWorkers++;
        continue;
      }
      this.cmd({ t: "gather", ids: [worker.id], node: node.id });
      if (node.kind === "wood") woodWorkers++;
      else goldWorkers++;
    }
  }

  private pickNode(kind: "gold" | "wood", x: number, y: number) {
    let best = null as (typeof this.world.nodes)[number] | null;
    let bestScore = Infinity;
    for (const node of this.world.nodes) {
      if (node.kind !== kind || node.amount <= 0) continue;
      const enemySide = this.team === 0 ? node.x < 55 : node.x > 65;
      const score = Math.hypot(node.x - x, node.y - y) + (enemySide ? 26 : 0);
      if (score < bestScore) {
        bestScore = score;
        best = node;
      }
    }
    return best;
  }

  private workerCount(): number {
    return this.world.unitsOf(this.team).filter((u) => u.type === "worker").length;
  }

  private buildingsOfType(type: BuildingKind) {
    return this.world.buildingsOf(this.team).filter((b) => b.type === type);
  }

  private queueSupply(): number {
    let queued = 0;
    for (const building of this.world.buildingsOf(this.team)) {
      for (const item of building.queue) {
        queued += this.world.balance.units[item.kind].supply;
      }
    }
    return queued;
  }

  private manageBuildings(): void {
    const world = this.world;
    const player = world.players[this.team as 0 | 1]!;
    const time = world.time;
    const supplyLeft = player.supplyCap - player.supplyUsed - this.queueSupply();
    const houses = this.buildingsOfType("house");
    const doneHouses = houses.filter((house) => house.done).length;
    const hasBarracks = this.buildingsOfType("barracks").some((barracks) => barracks.done);

    // Дом нужен заранее: под предел снабжения и один «стартовый» дом.
    if (supplyLeft < 10 || (time > 20 && doneHouses === 0 && houses.length === 0)) {
      this.ensureBuilding("house", 8, () => player.wood >= 55, 4);
    }
    this.ensureBuilding("barracks", 1, () => player.wood >= 150, 6);
    if (player.tier >= 2) {
      this.ensureBuilding("workshop", 1, () => player.wood >= 140 && player.gold >= 120, 8);
    }
    // Башни — только когда есть казарма и не съедают дерево у экономики.
    if (this.team === 0 && hasBarracks) {
      this.ensureBuilding("tower", 4, () => player.wood >= 90 && player.gold >= 90, 10);
    } else if (this.team === 1 && time > 240 && hasBarracks) {
      this.ensureBuilding("tower", 2, () => player.wood >= 90 && player.gold >= 90, 12);
    }

    if (player.tier === 1 && time > 200) {
      const cost = world.balance.tiers["2"];
      if (cost && player.gold >= cost.cost.gold && player.wood >= cost.cost.wood) {
        this.cmd({ t: "tier" });
      }
    }
    if (player.tier === 2 && time > 480) {
      const cost = world.balance.tiers["3"];
      if (cost && player.gold >= cost.cost.gold && player.wood >= cost.cost.wood) {
        this.cmd({ t: "tier" });
      }
    }
  }

  /** Достраивает площадки, брошенные погибшими или отозванными рабочими. */
  private resumeConstruction(): void {
    const unfinished = this.world.buildingsOf(this.team).filter((building) => !building.done);
    if (!unfinished.length) return;
    const workers = this.world.unitsOf(this.team).filter((unit) => unit.type === "worker");
    if (!workers.length) return;

    const assigned = new Set<number>();
    for (const worker of workers) {
      const order = worker.order;
      if (order.type === "build" || order.type === "repair") assigned.add(order.target);
    }

    for (const site of unfinished) {
      if (assigned.has(site.id)) continue;
      let best: (typeof workers)[number] | null = null;
      let bestScore = Infinity;
      for (const worker of workers) {
        if (worker.order.type === "build" || worker.order.type === "repair") continue;
        const score = Math.hypot(worker.x - site.x, worker.y - site.y);
        if (score < bestScore) {
          bestScore = score;
          best = worker;
        }
      }
      if (!best) continue;
      this.cmd({ t: "repair", ids: [best.id], target: site.id });
      assigned.add(site.id);
    }
  }

  private ensureBuilding(
    kind: BuildingKind,
    max: number,
    affordable: () => boolean,
    cooldown: number,
  ): void {
    const world = this.world;
    const existing = this.buildingsOfType(kind).length;
    if (existing >= max) return;
    const last = this.lastBuild.get(kind) ?? -999;
    if (world.time - last < cooldown) return;
    if (!affordable()) return;
    const spot = world.findBuildSpot(this.team, kind);
    if (!spot) return;
    const worker = this.pickBuildWorker(spot);
    if (!worker) return;
    this.cmd({ t: "build", ids: [worker.id], building: kind, x: spot.x, y: spot.y });
    this.lastBuild.set(kind, world.time);
  }

  private pickBuildWorker(spot: Vec2) {
    const workers = this.world.unitsOf(this.team).filter((u) => u.type === "worker");
    let best = null as (typeof workers)[number] | null;
    let bestScore = Infinity;
    for (const worker of workers) {
      if (worker.order.type === "build" || worker.order.type === "repair") continue;
      const score = Math.hypot(worker.x - spot.x, worker.y - spot.y);
      if (score < bestScore) {
        bestScore = score;
        best = worker;
      }
    }
    return best;
  }

  // --------------------------------------------------------------- training

  private trainArmy(): void {
    const world = this.world;
    const player = world.players[this.team as 0 | 1]!;
    const supplyLeft = player.supplyCap - player.supplyUsed - this.queueSupply();

    const hall = world.findHall(this.team);
    const workerTarget = this.team === 0 ? 7 : 6;
    if (hall && this.workerCount() < workerTarget && hall.queue.length < 2) {
      if (player.gold >= 50 && supplyLeft >= 1) {
        this.cmd({ t: "train", building: hall.id, unit: "worker" });
      }
    }

    for (const barracks of this.buildingsOfType("barracks")) {
      if (!barracks.done || barracks.queue.length >= 2) continue;
      if (supplyLeft < 2) break;
      const wantRanged = player.tier >= 2 ? this.rng.chance(0.4) : this.rng.chance(0.3);
      const unit: UnitKind = wantRanged ? "archer" : "soldier";
      const def = world.balance.units[unit];
      if (player.gold >= def.cost.gold && player.wood >= def.cost.wood) {
        this.cmd({ t: "train", building: barracks.id, unit });
      }
    }
    for (const workshop of this.buildingsOfType("workshop")) {
      if (!workshop.done || workshop.queue.length >= 1) continue;
      if (supplyLeft < 3) break;
      const def = world.balance.units.catapult;
      if (player.gold >= def.cost.gold && player.wood >= def.cost.wood) {
        this.cmd({ t: "train", building: workshop.id, unit: "catapult" });
      }
    }
  }

  private research(): void {
    const world = this.world;
    const player = world.players[this.team as 0 | 1]!;
    if (world.time < 90) return;
    const order: Array<[string, number]> = [
      ["damage", 2],
      ["armor", 2],
      ["gather", 2],
    ];
    for (const [tech, maxLevel] of order) {
      const level = player.techs[tech] ?? 0;
      if (level >= maxLevel) continue;
      const levels = world.balance.techs[tech]?.levels;
      if (!levels) continue;
      const next = levels[level];
      if (!next) continue;
      if (player.gold < next.cost.gold + 70 || player.wood < next.cost.wood + 40) continue;
      this.cmd({ t: "research", tech });
      return;
    }
  }

  // ------------------------------------------------------------------ hero

  private spendSkillPoints(): void {
    const world = this.world;
    const player = world.players[this.team as 0 | 1]!;
    if (player.heroSkillPoints <= 0) return;
    const priority = ["rally", "cleave", "mend", "charge"];
    for (const id of priority) {
      const level = player.heroSkills[id] ?? 0;
      const skill = world.balance.hero.skills.find((s) => s.id === id);
      if (!skill) continue;
      if (level < Math.min(3, skill.levels.length)) {
        this.cmd({ t: "heroSkill", skill: id });
        return;
      }
    }
  }

  private useHeroAbilities(): void {
    const world = this.world;
    const player = world.players[this.team as 0 | 1]!;
    const hero = world.unitsOf(this.team).find((u) => u.type === "hero");
    if (!hero) return;
    if ((player.heroSkills["mend"] ?? 0) > 0 && (player.heroCooldowns["mend"] ?? 0) <= 0) {
      if (hero.hp / hero.maxHp < 0.62) this.cmd({ t: "heroAbility", skill: "mend" });
    }
    if ((player.heroSkills["charge"] ?? 0) > 0 && (player.heroCooldowns["charge"] ?? 0) <= 0) {
      const enemy = this.nearestEnemyTo(hero.x, hero.y, 9);
      if (enemy) this.cmd({ t: "heroAbility", skill: "charge" });
    }
  }

  // ------------------------------------------------------------------ army

  private nearestEnemyTo(x: number, y: number, radius: number) {
    let best = null as ReturnType<World["unitsOf"]>[number] | null;
    let bestDist = Infinity;
    for (const unit of this.world.entities.values()) {
      if (unit.kind !== "unit" || unit.team === this.team || unit.team === 2) continue;
      const d = Math.hypot(unit.x - x, unit.y - y);
      if (d <= radius && d < bestDist) {
        bestDist = d;
        best = unit;
      }
    }
    return best;
  }

  private manageArmy(): void {
    const world = this.world;
    const team = this.team;
    const army = world.unitsOf(team).filter((u) => u.type !== "worker");
    if (!army.length) return;
    const hall = world.findHall(team);
    if (!hall) return;
    const time = world.time;

    // Оборона: враг рядом с базой.
    let threat: { x: number; y: number } | null = null;
    for (const unit of world.entities.values()) {
      if (unit.kind !== "unit" || unit.team === team || unit.team === 2) continue;
      if (Math.hypot(unit.x - hall.x, unit.y - hall.y) < 30) {
        threat = { x: unit.x, y: unit.y };
        break;
      }
    }
    if (threat && time - this.lastDefendAt > 5) {
      this.lastDefendAt = time;
      this.cmd({ t: "attackMove", ids: army.map((u) => u.id), x: threat.x, y: threat.y });
      return;
    }

    const threshold = (team === 0 ? 8 : 6) - (time > 600 ? 2 : 0);
    if (army.length < threshold) return;
    if (time - this.lastAttackAt < 9) return;

    let target: { x: number; y: number } | null = null;
    if (team === 1) {
      const trophy = [...world.entities.values()].find(
        (e) => e.kind === "building" && e.type === "trophy" && e.team === 2,
      );
      if (trophy && army.length >= 4) target = { x: trophy.x, y: trophy.y };
    }
    if (!target) {
      const enemyHall = world.findHall(team === 0 ? 1 : 0);
      if (enemyHall) target = { x: enemyHall.x, y: enemyHall.y };
    }
    if (!target) return;
    this.lastAttackAt = time;
    this.cmd({ t: "attackMove", ids: army.map((u) => u.id), x: target.x, y: target.y });
  }
}
