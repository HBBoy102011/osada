/**
 * Общие типы клиента и сервера: баланс, сущности, команды, снапшоты.
 * Никаких зависимостей от DOM/Three.js — модуль используется и в Node.
 */

export type Team = 0 | 1 | 2; // 0 — защитник, 1 — атакующий, 2 — нейтралы
export type Role = "defender" | "attacker";
export type UnitKind = "worker" | "soldier" | "archer" | "catapult" | "hero";
export type BuildingKind =
  | "hall"
  | "barracks"
  | "workshop"
  | "tower"
  | "house"
  | "outpost"
  | "wall"
  | "trophy";
export type NodeKind = "gold" | "wood";
export type Phase = "playing" | "ended";

export interface Cost {
  gold: number;
  wood: number;
}

export interface UnitDef {
  name: string;
  cost: Cost;
  supply: number;
  buildTime: number;
  hp: number;
  armor: number;
  speed: number;
  radius: number;
  damage: number;
  range: number;
  minRange?: number;
  cooldown: number;
  vision: number;
  gatherRate?: number;
  carry?: number;
  buildPower?: number;
  buildingBonus?: number;
  xp: number;
  projectile: boolean;
}

export interface BuildingAttack {
  damage: number;
  range: number;
  cooldown: number;
}

export interface BuildingDef {
  name: string;
  cost: Cost;
  hp: number;
  armor: number;
  size: number;
  buildTime: number;
  supply: number;
  vision: number;
  dropOff?: boolean;
  train?: UnitKind[];
  requiresTier?: number;
  attackerOnly?: boolean;
  neutralOnly?: boolean;
  attack?: BuildingAttack;
}

export interface TierDef {
  cost: Cost;
  buildTime: number;
}

export interface TechLevel {
  cost: Cost;
  bonus: number;
}

export interface TechDef {
  name: string;
  levels: TechLevel[];
}

export interface HeroSkillLevel {
  [key: string]: number;
}

export interface HeroSkillDef {
  id: string;
  name: string;
  type: "passive" | "active";
  description: string;
  cooldown?: number;
  duration?: number;
  levels: HeroSkillLevel[];
}

export interface HeroDef {
  levelXpBase: number;
  levelXpStep: number;
  maxLevel: number;
  hpPerLevel: number;
  damagePerLevel: number;
  armorPerLevel: number;
  skills: HeroSkillDef[];
}

export interface MatchDef {
  durationSeconds: number;
  startingGold: number;
  startingWood: number;
  baseSupply: number;
  supplyCap: number;
  defenderPassiveGoldPerSecond: number;
  attackerTrophyGold: number;
  heroRespawnSeconds: number;
  baseRadius: number;
  snapshotHz: number;
  tickHz: number;
}

export interface Balance {
  version: number;
  match: MatchDef;
  units: Record<UnitKind, UnitDef>;
  buildings: Record<BuildingKind, BuildingDef>;
  tiers: Record<string, TierDef>;
  techs: Record<string, TechDef>;
  hero: HeroDef;
}

export interface Vec2 {
  x: number;
  y: number;
}

export interface ResourceNode {
  id: number;
  kind: NodeKind;
  x: number;
  y: number;
  amount: number;
  maxAmount: number;
  radius: number;
}

export interface DecorTree {
  x: number;
  y: number;
  s: number;
  v: number; // вариант модели
}

export interface BaseZone {
  team: Team;
  x: number;
  y: number;
  radius: number;
}

export interface GameMap {
  version: number;
  width: number;
  height: number;
  seed: number;
  trees: DecorTree[];
  rocks: DecorTree[];
  bases: BaseZone[];
  nodes: ResourceNode[];
}

export type GatherStage = "toNode" | "gathering" | "toDrop" | "depositing";

export type Order =
  | { type: "idle" }
  | { type: "move"; x: number; y: number; attackMove: boolean }
  | { type: "gather"; node: number; stage: GatherStage; progress: number }
  | { type: "build"; target: number }
  | { type: "repair"; target: number }
  | { type: "attack"; target: number; rx?: number; ry?: number };

export interface QueueItem {
  kind: UnitKind;
  progress: number;
}

export interface Entity {
  id: number;
  kind: "unit" | "building";
  type: UnitKind | BuildingKind;
  team: Team;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  radius: number;
  facing: number;
  done: boolean;
  progress: number;
  order: Order;
  path: Vec2[] | null;
  pathIndex: number;
  repathAt: number;
  cooldown: number;
  carry: number;
  carryKind: NodeKind | null;
  queue: QueueItem[];
  rally: Vec2 | null;
  level: number;
  xp: number;
  attackAnim: number;
  aggro: number | null;
  buffUntil: number;
  buffSpeed: number;
  buffDamage: number;
  respawnAt: number;
}

export type Command =
  | { t: "move"; ids: number[]; x: number; y: number }
  | { t: "attack"; ids: number[]; target: number }
  | { t: "attackMove"; ids: number[]; x: number; y: number }
  | { t: "stop"; ids: number[] }
  | { t: "gather"; ids: number[]; node: number }
  | { t: "build"; ids: number[]; building: BuildingKind; x: number; y: number }
  | { t: "repair"; ids: number[]; target: number }
  | { t: "train"; building: number; unit: UnitKind }
  | { t: "cancelTrain"; building: number; index: number }
  | { t: "research"; tech: string }
  | { t: "tier" }
  | { t: "rally"; building: number; x: number; y: number }
  | { t: "heroSkill"; skill: string }
  | { t: "heroAbility"; skill: string }
  | { t: "surrender" }
  | { t: "chat"; text: string };

export interface PlayerState {
  team: Team;
  role: Role;
  name: string;
  gold: number;
  wood: number;
  supplyUsed: number;
  supplyCap: number;
  tier: number;
  techs: Record<string, number>;
  heroLevel: number;
  heroXp: number;
  heroSkillPoints: number;
  heroSkills: Record<string, number>;
  heroCooldowns: Record<string, number>;
  surrendered: boolean;
  connected: boolean;
}

export interface PlayerView {
  team: Team;
  role: Role;
  name: string;
  gold: number;
  wood: number;
  supplyUsed: number;
  supplyCap: number;
  tier: number;
  techs: Record<string, number>;
  heroLevel: number;
  heroXp: number;
  heroXpNext: number;
  heroSkillPoints: number;
  heroSkills: Record<string, number>;
  heroCooldowns: Record<string, number>;
  heroRespawnIn: number;
  surrendered: boolean;
  connected: boolean;
}

export interface EntitySnapshot {
  id: number;
  k: "u" | "b";
  t: UnitKind | BuildingKind;
  team: Team;
  x: number;
  y: number;
  hp: number;
  mhp: number;
  done: boolean;
  pr: number;
  carry: number;
  carryKind: NodeKind | null;
  level: number;
  queue: number;
  qp: number;
  qk: UnitKind[];
  rallyX: number | null;
  rallyY: number | null;
  buff: number;
}

export interface NodeSnapshot {
  id: number;
  kind: NodeKind;
  x: number;
  y: number;
  amount: number;
  max: number;
}

export type SimEvent =
  | {
      type: "attack";
      fromX: number;
      fromY: number;
      toX: number;
      toY: number;
      team: Team;
      ranged: boolean;
    }
  | { type: "death"; x: number; y: number; team: Team; kind: string }
  | { type: "hit"; x: number; y: number; amount: number }
  | { type: "levelup"; x: number; y: number; level: number; team: Team }
  | { type: "notice"; team: Team | null; text: string };

export interface Snapshot {
  tick: number;
  time: number;
  phase: Phase;
  winner: Team | null;
  reason: string;
  you: PlayerView;
  enemy: PlayerView;
  entities: EntitySnapshot[];
  nodes: NodeSnapshot[];
  events: SimEvent[];
  fog: string | null;
  fogW: number;
  fogH: number;
  fogCell: number;
  stats: Stats;
}

export interface WorldOptions {
  balance: Balance;
  seed: number;
  names?: [string, string];
  teams?: [Team, Team];
}

export interface CommandResult {
  ok: boolean;
  error?: string;
}

export interface Stats {
  unitsTrained: number;
  unitsLost: number;
  buildingsBuilt: number;
  goldGathered: number;
  woodGathered: number;
  damageDealt: number;
  trophies: number;
}
