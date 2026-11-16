import { describe, expect, it } from "vitest";
import balanceJson from "../public/data/balance.json";
import type { Balance, Entity } from "../src/shared/types.js";
import { World } from "../src/shared/world.js";
import { decodeBase64 } from "../src/shared/rng.js";

const balance = balanceJson as Balance;

function makeWorld(seed = 12345): World {
  return new World({ balance, seed });
}

function tickFor(world: World, seconds: number, dt = 0.05): void {
  const steps = Math.ceil(seconds / dt);
  for (let i = 0; i < steps; i++) world.tick(dt);
}

function firstUnit(world: World, team: 0 | 1, type: string): Entity {
  const unit = world.unitsOf(team).find((entity) => entity.type === type);
  if (!unit) throw new Error(`Нет юнита ${type} у команды ${team}`);
  return unit;
}

describe("World: стартовая расстановка", () => {
  it("создаёт базы, войска, героев, трофеи и охрану", () => {
    const world = makeWorld();
    const defenderBuildings = world.buildingsOf(0);
    const attackerBuildings = world.buildingsOf(1);

    expect(defenderBuildings.filter((b) => b.type === "hall")).toHaveLength(1);
    expect(defenderBuildings.filter((b) => b.type === "tower")).toHaveLength(2);
    expect(attackerBuildings.filter((b) => b.type === "hall")).toHaveLength(1);
    expect(attackerBuildings.filter((b) => b.type === "outpost")).toHaveLength(1);
    expect(world.buildingsOf(2).filter((b) => b.type === "trophy")).toHaveLength(3);

    for (const team of [0, 1] as const) {
      expect(world.unitsOf(team).filter((u) => u.type === "worker")).toHaveLength(4);
      expect(world.unitsOf(team).filter((u) => u.type === "soldier")).toHaveLength(2);
      expect(world.unitsOf(team).filter((u) => u.type === "hero")).toHaveLength(1);
    }
    expect(world.unitsOf(2)).toHaveLength(6);

    expect(world.players[0].gold).toBe(balance.match.startingGold);
    expect(world.players[0].wood).toBe(balance.match.startingWood);
    expect(world.players[1].gold).toBe(balance.match.startingGold);
    expect(world.players[0].supplyCap).toBe(20);
    expect(world.players[0].supplyUsed).toBe(6);
    expect(world.players[0].tier).toBe(1);
    expect(world.players[0].heroSkillPoints).toBe(1);
    expect(world.phase).toBe("playing");
  });

  it("карта содержит ресурсы и проходимость", () => {
    const world = makeWorld(7);
    expect(world.nodes.length).toBeGreaterThanOrEqual(12);
    expect(world.map.width).toBe(120);
    expect(world.map.height).toBe(78);
    expect(world.map.trees.length).toBeGreaterThan(100);
    expect(world.map.bases).toHaveLength(2);
  });
});

describe("World: экономика", () => {
  it("начисляет защитнику пассивное золото", () => {
    const world = makeWorld();
    const before = world.players[0].gold;
    tickFor(world, 10);
    expect(world.players[0].gold).toBeGreaterThan(before + 10);
    expect(world.players[1].gold).toBe(balance.match.startingGold);
  });

  it("рабочий добывает золото и возвращает его на базу", () => {
    const world = makeWorld();
    const worker = firstUnit(world, 1, "worker");
    const node = world.nodes
      .filter((n) => n.kind === "gold")
      .sort(
        (a, b) =>
          Math.hypot(a.x - worker.x, a.y - worker.y) -
          Math.hypot(b.x - worker.x, b.y - worker.y),
      )[0]!;
    const amountBefore = node.amount;
    const goldBefore = world.players[1].gold;

    const result = world.applyCommand(1, { t: "gather", ids: [worker.id], node: node.id });
    expect(result.ok).toBe(true);
    // Добыча идёт через заказы, а не мгновенно.
    expect(worker.order.type).toBe("gather");

    tickFor(world, 40);
    expect(node.amount).toBeLessThan(amountBefore);
    expect(world.players[1].gold).toBeGreaterThan(goldBefore);
    expect(world.players[1].gold).toBeGreaterThan(balance.match.startingGold);
  });

  it("дом повышает предел снабжения после достройки", () => {
    const world = makeWorld();
    const worker = firstUnit(world, 0, "worker");
    const spot = world.findBuildSpot(0, "house");
    expect(spot).toBeTruthy();
    const woodBefore = world.players[0].wood;

    const result = world.applyCommand(0, {
      t: "build",
      ids: [worker.id],
      building: "house",
      x: spot!.x,
      y: spot!.y,
    });
    expect(result.ok).toBe(true);
    expect(world.players[0].wood).toBe(woodBefore - balance.buildings.house.cost.wood);

    tickFor(world, 60);
    const house = world.buildingsOf(0).find((b) => b.type === "house");
    expect(house).toBeTruthy();
    expect(house!.done).toBe(true);
    expect(world.players[0].supplyCap).toBe(30);
    expect(world.stats[0].buildingsBuilt).toBe(1);
  });

  it("казарма обучает пехотинца и тратит снабжение", () => {
    const world = makeWorld();
    world.players[0].gold = 2000;
    world.players[0].wood = 2000;
    const worker = firstUnit(world, 0, "worker");
    const spot = world.findBuildSpot(0, "barracks");
    expect(world.applyCommand(0, {
      t: "build",
      ids: [worker.id],
      building: "barracks",
      x: spot!.x,
      y: spot!.y,
    }).ok).toBe(true);

    let barracks: Entity | undefined;
    for (let i = 0; i < 60 && !barracks; i++) {
      tickFor(world, 2);
      barracks = world.buildingsOf(0).find((b) => b.type === "barracks" && b.done);
    }
    expect(barracks).toBeTruthy();

    const supplyBefore = world.players[0].supplyUsed;
    const result = world.applyCommand(0, {
      t: "train",
      building: barracks!.id,
      unit: "soldier",
    });
    expect(result.ok).toBe(true);
    expect(barracks!.queue).toHaveLength(1);

    const soldiersBefore = world.unitsOf(0).filter((u) => u.type === "soldier").length;
    tickFor(world, balance.units.soldier.buildTime + 4);
    const soldiersAfter = world.unitsOf(0).filter((u) => u.type === "soldier").length;
    expect(soldiersAfter).toBe(soldiersBefore + 1);
    expect(world.players[0].supplyUsed).toBe(supplyBefore + 1);
    expect(world.stats[0].unitsTrained).toBe(1);
  });

  it("нельзя обучить катапульту без мастерской", () => {
    const world = makeWorld();
    const hall = world.findHall(0)!;
    const result = world.applyCommand(0, { t: "train", building: hall.id, unit: "catapult" });
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

describe("World: строительство и развитие", () => {
  it("запрещает строить вне зоны базы", () => {
    const world = makeWorld();
    const worker = firstUnit(world, 1, "worker");
    const result = world.applyCommand(1, {
      t: "build",
      ids: [worker.id],
      building: "house",
      x: 105,
      y: 10,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/нельзя/i);
  });

  it("запрещает строить форпост защитнику", () => {
    const world = makeWorld();
    world.players[0].gold = 1000;
    world.players[0].wood = 1000;
    const worker = firstUnit(world, 0, "worker");
    const spot = world.findBuildSpot(0, "outpost") ?? { x: 94, y: 44 };
    const result = world.applyCommand(0, {
      t: "build",
      ids: [worker.id],
      building: "outpost",
      x: spot.x,
      y: spot.y,
    });
    expect(result.ok).toBe(false);
  });

  it("исследует технологии и ограничивает максимальный уровень", () => {
    const world = makeWorld();
    world.players[0].gold = 5000;
    world.players[0].wood = 5000;

    expect(world.applyCommand(0, { t: "research", tech: "damage" }).ok).toBe(true);
    expect(world.players[0].techs.damage).toBe(1);
    expect(world.applyCommand(0, { t: "research", tech: "damage" }).ok).toBe(true);
    expect(world.applyCommand(0, { t: "research", tech: "damage" }).ok).toBe(true);
    expect(world.players[0].techs.damage).toBe(3);
    const maxed = world.applyCommand(0, { t: "research", tech: "damage" });
    expect(maxed.ok).toBe(false);
    expect(world.applyCommand(0, { t: "research", tech: "unknown" }).ok).toBe(false);
  });

  it("улучшает базу до 2 и 3 уровня", () => {
    const world = makeWorld();
    world.players[0].gold = 2000;
    world.players[0].wood = 2000;
    expect(world.applyCommand(0, { t: "tier" }).ok).toBe(true);
    expect(world.players[0].tier).toBe(2);
    expect(world.applyCommand(0, { t: "tier" }).ok).toBe(true);
    expect(world.players[0].tier).toBe(3);
    expect(world.applyCommand(0, { t: "tier" }).ok).toBe(false);
  });

  it("изучает навыки героя и применяет способность", () => {
    const world = makeWorld();
    expect(world.applyCommand(0, { t: "heroSkill", skill: "mend" }).ok).toBe(true);
    expect(world.players[0].heroSkills.mend).toBe(1);
    expect(world.players[0].heroSkillPoints).toBe(0);
    expect(world.applyCommand(0, { t: "heroSkill", skill: "mend" }).ok).toBe(false);

    const hero = firstUnit(world, 0, "hero");
    hero.hp = 100;
    const result = world.applyCommand(0, { t: "heroAbility", skill: "mend" });
    expect(result.ok).toBe(true);
    expect(hero.hp).toBeGreaterThan(100);
    expect(world.players[0].heroCooldowns.mend).toBeGreaterThan(0);
    expect(world.applyCommand(0, { t: "heroAbility", skill: "mend" }).ok).toBe(false);
  });
});

describe("World: бой и победа", () => {
  it("герой получает опыт за бой", () => {
    const world = makeWorld();
    const hero = firstUnit(world, 0, "hero");
    const enemy = firstUnit(world, 1, "soldier");
    // Ставим врага рядом и заставляем героя атаковать.
    enemy.x = hero.x + 1.4;
    enemy.y = hero.y;
    world.applyCommand(0, { t: "attack", ids: [hero.id], target: enemy.id });
    tickFor(world, 30);
    const player = world.players[0];
    expect(player.heroXp > 0 || player.heroLevel > 1).toBe(true);
  });

  it("сдача атакующего приносит победу защитнику", () => {
    const world = makeWorld();
    expect(world.applyCommand(1, { t: "surrender" }).ok).toBe(true);
    expect(world.phase).toBe("ended");
    expect(world.winner).toBe(0);
    expect(world.endReason).toMatch(/Атакующий/i);
    expect(world.players[1].surrendered).toBe(true);
  });

  it("по истечении времени побеждает защитник", () => {
    const world = makeWorld();
    world.time = balance.match.durationSeconds - 0.01;
    world.tick(0.05);
    expect(world.phase).toBe("ended");
    expect(world.winner).toBe(0);
    expect(world.endReason).toMatch(/Время/i);
  });

  it("уничтожение главного зала завершает матч", () => {
    const world = makeWorld();
    const hall = world.findHall(1)!;
    world.entities.delete(hall.id);
    world.tick(0.05);
    expect(world.phase).toBe("ended");
    expect(world.winner).toBe(0);
  });

  it("трофей даёт атакующему золото", () => {
    const world = makeWorld();
    const trophy = world.buildingsOf(2).find((b) => b.type === "trophy")!;
    const goldBefore = world.players[1].gold;
    trophy.hp = 1;
    const attacker = firstUnit(world, 1, "soldier");
    attacker.x = trophy.x + 1.5;
    attacker.y = trophy.y;
    world.applyCommand(1, { t: "attack", ids: [attacker.id], target: trophy.id });
    tickFor(world, 20);
    expect(world.players[1].gold).toBeGreaterThanOrEqual(goldBefore + balance.match.attackerTrophyGold);
    expect(world.stats[1].trophies).toBe(1);
  });
});

describe("World: туман войны и снапшоты", () => {
  it("скрывает войска противника вне обзора", () => {
    const world = makeWorld();
    const snapshot = world.snapshot(0);
    const enemy = snapshot.entities.filter((e) => e.team === 1);
    const neutral = snapshot.entities.filter((e) => e.team === 2);
    expect(enemy).toHaveLength(0);
    expect(neutral).toHaveLength(0);
    expect(snapshot.you.role).toBe("defender");
    expect(snapshot.enemy.gold).toBe(0);
    expect(snapshot.enemy.techs).toEqual({});
    expect(snapshot.fog).toBeTruthy();
    expect(decodeBase64(snapshot.fog!).length).toBe(snapshot.fogW * snapshot.fogH);
    expect(snapshot.nodes.length).toBe(world.nodes.length);
    expect(snapshot.you.gold).toBeGreaterThan(0);
  });

  it("показывает свои войска всегда", () => {
    const world = makeWorld();
    const snapshot = world.snapshot(1);
    const own = snapshot.entities.filter((e) => e.team === 1);
    expect(own.length).toBe(world.unitsOf(1).length + world.buildingsOf(1).length);
    expect(snapshot.you.role).toBe("attacker");
  });

  it("передаёт события только своей команде", () => {
    const world = makeWorld();
    world.applyCommand(1, { t: "surrender" });
    const snap = world.snapshot(0);
    const notices = snap.events.filter((e) => e.type === "notice");
    expect(notices.length).toBeGreaterThan(0);
    expect(notices.every((e) => e.type !== "notice" || e.team === null || e.team === 0)).toBe(true);
  });
});

describe("World: валидация команд", () => {
  it("не даёт управлять чужими юнитами", () => {
    const world = makeWorld();
    const enemy = firstUnit(world, 1, "worker");
    const result = world.applyCommand(0, { t: "move", ids: [enemy.id], x: 50, y: 40 });
    expect(result.ok).toBe(false);
  });

  it("не даёт строить главный зал", () => {
    const world = makeWorld();
    const worker = firstUnit(world, 0, "worker");
    const result = world.applyCommand(0, {
      t: "build",
      ids: [worker.id],
      building: "hall",
      x: 96,
      y: 40,
    });
    expect(result.ok).toBe(false);
  });

  it("после конца матча команды отклоняются", () => {
    const world = makeWorld();
    world.forfeit(1);
    const worker = firstUnit(world, 0, "worker");
    const result = world.applyCommand(0, { t: "move", ids: [worker.id], x: 50, y: 40 });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/завершён/i);
  });
});
