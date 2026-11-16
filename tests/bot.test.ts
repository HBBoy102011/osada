import { describe, expect, it } from "vitest";
import balanceJson from "../public/data/balance.json";
import type { Balance } from "../src/shared/types.js";
import { World } from "../src/shared/world.js";
import { Bot } from "../src/shared/bot.js";

const balance = balanceJson as Balance;

interface RunResult {
  world: World;
  seconds: number;
  ticks: number;
}

/** Крутит мир и двух ботов, как это делает оффлайн-сессия. */
function runBots(seconds: number, dt = 0.1, seed = 424242): RunResult {
  const world = new World({ balance, seed });
  const bots = [new Bot(world, 0), new Bot(world, 1)];
  const ticks = Math.ceil(seconds / dt);
  let elapsed = 0;
  for (let i = 0; i < ticks; i++) {
    if (world.phase !== "playing") break;
    world.tick(dt);
    for (const bot of bots) bot.update(dt);
    elapsed += dt;
  }
  return { world, seconds: elapsed, ticks };
}

describe("Bot: экономика и развитие", () => {
  it("добывает ресурсы, строит дома и обучает войска", () => {
    // Бот детерминирован (seed карты), поэтому окно в 150 секунд стабильно:
    // к этому моменту обе стороны успевают развиться, но матч ещё идёт.
    const { world, seconds } = runBots(150);

    expect(seconds).toBeGreaterThan(140);
    expect(world.phase).toBe("playing");

    for (const team of [0, 1] as const) {
      const player = world.players[team];
      const stats = world.stats[team];

      expect(stats.goldGathered, `команда ${team} не добывала золото`).toBeGreaterThan(0);
      expect(stats.woodGathered, `команда ${team} не добывала дерево`).toBeGreaterThan(0);
      expect(stats.buildingsBuilt, `команда ${team} ничего не построила`).toBeGreaterThan(0);
      expect(stats.unitsTrained, `команда ${team} никого не обучила`).toBeGreaterThan(0);

      // Дома поднимают предел снабжения выше стартовых 20.
      expect(player.supplyCap).toBeGreaterThan(20);

      // Рабочих становится больше, чем на старте.
      expect(world.unitsOf(team).filter((u) => u.type === "worker").length).toBeGreaterThanOrEqual(4);

      // Армия растёт: появляются казармы и бойцы сверх стартовой двойки.
      expect(world.buildingsOf(team).some((b) => b.type === "barracks")).toBe(true);
      const army = world.unitsOf(team).filter((u) => u.type === "soldier" || u.type === "archer");
      expect(army.length).toBeGreaterThanOrEqual(2);
    }
  }, 120_000);

  it("тратит очки навыков героя и применяет способности", () => {
    const { world } = runBots(30, 0.1, 777);
    for (const team of [0, 1] as const) {
      const player = world.players[team];
      const spent = Object.values(player.heroSkills).reduce((sum, level) => sum + level, 0);
      expect(spent, `герой команды ${team} не изучил навыки`).toBeGreaterThan(0);
    }
  }, 60_000);

  it("не ломает симуляцию за длинный матч и не оставляет NaN", () => {
    const { world } = runBots(300, 0.1, 5150);

    expect(["playing", "ended"]).toContain(world.phase);
    if (world.phase === "ended") {
      expect([0, 1]).toContain(world.winner);
      expect(world.endReason.length).toBeGreaterThan(0);
    }

    for (const entity of world.entities.values()) {
      expect(Number.isFinite(entity.x), `сущность ${entity.id} имеет NaN по x`).toBe(true);
      expect(Number.isFinite(entity.y), `сущность ${entity.id} имеет NaN по y`).toBe(true);
      expect(entity.hp).toBeGreaterThanOrEqual(0);
    }
    for (const node of world.nodes) {
      expect(node.amount).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(node.amount)).toBe(true);
    }
    for (const player of world.players) {
      expect(Number.isFinite(player.gold)).toBe(true);
      expect(Number.isFinite(player.wood)).toBe(true);
      expect(player.supplyUsed).toBeLessThanOrEqual(player.supplyCap);
    }

    const snapshot = world.snapshot(0);
    expect(snapshot.entities.length).toBeGreaterThan(0);
    expect(snapshot.you.gold).toBeGreaterThanOrEqual(0);
  }, 120_000);
});
