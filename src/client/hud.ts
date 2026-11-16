import type {
  Balance,
  BuildingKind,
  Command,
  Cost,
  EntitySnapshot,
  PlayerView,
  Role,
  SimEvent,
  Snapshot,
  Team,
  UnitKind,
} from "../shared/types.js";

const ICONS: Record<string, string> = {
  gold: '<circle cx="12" cy="12" r="7.5"/><path d="M9.5 12h5M12 9.5v5"/>',
  wood: '<path d="M5 17l9-9 5 5-9 9z"/><path d="M8.5 13.5l3 3M11.5 10.5l3 3"/>',
  supply: '<path d="M4 20V9l8-5 8 5v11"/><path d="M9 20v-6h6v6"/>',
  worker: '<path d="M4 20l8-8"/><path d="M9 5c4-2 8 0 10 3-3-1-5 0-6 2-1-3-2-4-4-5z"/>',
  soldier: '<path d="M14 3l7 7-3 3-7-7z"/><path d="M11 8L4 15v5h5l7-7"/><path d="M4 20l4-4"/>',
  archer: '<path d="M5 4c9 2 13 8 15 16"/><path d="M5 4L4 20"/><path d="M4 20L18 6"/>',
  catapult: '<circle cx="7" cy="17" r="3"/><circle cx="17" cy="17" r="2"/><path d="M4 13l9-8 6 3"/><path d="M10 10l6 5"/>',
  hero: '<path d="M4 18h16l-1-9-4 4-3-6-3 6-4-4z"/>',
  hall: '<path d="M4 20V9l8-5 8 5v11"/><path d="M9 20v-6h6v6"/><path d="M9 9l3-2 3 2"/>',
  house: '<path d="M4 11l8-7 8 7"/><path d="M6 10v10h12V10"/><path d="M10 20v-5h4v5"/>',
  barracks: '<path d="M3 20V8l9-4 9 4v12"/><path d="M7 20v-7h10v7"/><path d="M12 4v4"/>',
  tower: '<path d="M7 20V8h10v12"/><path d="M5 8V4h4v2h2V4h2v2h2V4h4v4"/><path d="M10 20v-5h4v5"/>',
  workshop: '<path d="M14 3l7 7-4 4-7-7z"/><path d="M10 10l-6 6v4h4l6-6"/>',
  wall: '<path d="M3 20V9h5v3h3V9h3v3h3V9h4v11z"/><path d="M3 14h18"/>',
  outpost: '<path d="M6 21V4"/><path d="M6 5h11l-3 4 3 4H6"/>',
  trophy: '<path d="M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M7 6H4v2a4 4 0 0 0 4 4M17 6h3v2a4 4 0 0 1-4 4"/><path d="M12 14v4M8 21h8"/>',
  tech: '<path d="M12 3v11"/><path d="M7 8l5-5 5 5"/><circle cx="12" cy="18" r="3"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1"/>',
  cleave: '<path d="M3 21l8-8"/><path d="M14 3l7 7-4 4-7-7z"/><path d="M4 14a8 8 0 0 0 6 6"/>',
  rally: '<path d="M6 21V4"/><path d="M6 5h11l-3 4 3 4H6"/>',
  mend: '<path d="M9 4h6v5h5v6h-5v5H9v-5H4V9h5z"/>',
  charge: '<path d="M13 2L5 14h5l-1 8 8-12h-5z"/>',
  shield: '<path d="M12 3l8 3v6c0 5-4 8-8 9-4-1-8-4-8-9V6z"/>',
  upgrade: '<path d="M12 20V5"/><path d="M6 11l6-6 6 6"/>',
  chat: '<path d="M4 5h16v11H9l-5 4z"/>',
};

function icon(name: string, size = 20): string {
  const body = ICONS[name] ?? ICONS.tech;
  return `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

const ROLE_NAMES: Record<Role, string> = { defender: "Защитник", attacker: "Атакующий" };
const UNIT_NAMES: Record<string, string> = {
  worker: "Рабочий",
  soldier: "Пехотинец",
  archer: "Лучник",
  catapult: "Катапульта",
  hero: "Герой",
};
const COST_ICON = {
  gold: icon("gold", 12),
  wood: icon("wood", 12),
};

export interface HudCallbacks {
  onCommand(cmd: Command): void;
  onBuild(kind: BuildingKind): void;
  onAttackMove: () => void;
  onChat(text: string): void;
  onExit(): void;
  onRestart(): void;
  onFocus(id: number): void;
}

export class Hud {
  private snap: Snapshot | null = null;
  private selected: EntitySnapshot[] = [];
  private readonly team: Team;
  private readonly role: Role;
  private readonly balance: Balance;
  private readonly mode: "offline" | "online";
  private readonly players: Array<{ name: string; team: Team; role: Role }>;
  private readonly cb: HudCallbacks;
  private commandSig = "";
  private techSig = "";
  private heroSig = "";
  private selectionSig = "";
  private endedShown = false;
  private opponentDown = 0;
  private lastLogTime = 0;
  private toastTimer: number | null = null;

  private readonly $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
    document.getElementById(id) as T;

  constructor(options: {
    team: Team;
    role: Role;
    balance: Balance;
    mode: "offline" | "online";
    players: Array<{ name: string; team: Team; role: Role }>;
    callbacks: HudCallbacks;
  }) {
    this.team = options.team;
    this.role = options.role;
    this.balance = options.balance;
    this.mode = options.mode;
    this.players = options.players;
    this.cb = options.callbacks;

    this.$("command-grid").addEventListener("click", (event) => this.onCommandClick(event));
    this.$("tech-grid").addEventListener("click", (event) => this.onCommandClick(event));
    this.$("hero-skills").addEventListener("click", (event) => this.onCommandClick(event));
    this.$("selection-body").addEventListener("click", (event) => {
      const target = (event.target as HTMLElement).closest<HTMLElement>("[data-eid]");
      if (target) this.cb.onFocus(Number(target.dataset.eid));
    });
    this.$("chat-form").addEventListener("submit", (event) => {
      event.preventDefault();
      const input = this.$<HTMLInputElement>("chat-input");
      const text = input.value.trim();
      input.value = "";
      if (!text) return;
      if (this.mode === "online") {
        this.cb.onChat(text);
      } else {
        this.toast("Чат доступен в онлайн-матче");
      }
      input.blur();
    });
    this.$("btn-surrender").addEventListener("click", () => this.$("confirm").classList.remove("hidden"));
    this.$("confirm-no").addEventListener("click", () => this.$("confirm").classList.add("hidden"));
    this.$("confirm-yes").addEventListener("click", () => {
      this.$("confirm").classList.add("hidden");
      this.cb.onCommand({ t: "surrender" });
    });
    this.$("btn-end-menu").addEventListener("click", () => this.cb.onExit());
    this.$("btn-end-again").addEventListener("click", () => this.cb.onRestart());
    window.addEventListener("keydown", this.onKeyDown);
    this.updateTopNames();
  }

  destroy(): void {
    window.removeEventListener("keydown", this.onKeyDown);
  }

  get minimapCanvas(): HTMLCanvasElement {
    return this.$<HTMLCanvasElement>("minimap");
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Enter") return;
    const active = document.activeElement;
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;
    if (!this.$("end-screen").classList.contains("hidden")) return;
    event.preventDefault();
    this.$<HTMLInputElement>("chat-input").focus();
  };

  private updateTopNames(): void {
    const you = this.players.find((p) => p.team === this.team);
    const enemy = this.players.find((p) => p.team !== this.team);
    const enemyLabel = enemy ? enemy.name : this.mode === "offline" ? "Бот" : "Соперник";
    this.$("players-line").innerHTML = `
      <span class="player-chip you"><i class="dot"></i>${escape(you?.name ?? "Вы")}${
        you ? ` · ${ROLE_NAMES[you.role]}` : ""
      }</span>
      <span class="vs">vs</span>
      <span class="player-chip enemy"><i class="dot"></i>${escape(enemyLabel)}${
        enemy ? ` · ${ROLE_NAMES[enemy.role]}` : ""
      }</span>
    `;
  }

  setOpponentStatus(connected: boolean, graceSeconds: number): void {
    this.opponentDown = connected ? 0 : graceSeconds;
    const el = this.$("players-line").querySelector(".player-chip.enemy");
    if (!el) return;
    el.classList.toggle("is-offline", !connected);
    this.toast(
      connected
        ? "Соперник вернулся в игру"
        : `Соперник отключился. Ожидание: ${graceSeconds} с`,
      connected ? "ok" : "warn",
    );
    if (!connected) {
      this.log(`Соперник отключился. Даём ${graceSeconds} секунд на возвращение.`, "warn");
    }
  }

  setPing(ms: number): void {
    this.$("ping").textContent = `${Math.max(0, Math.round(ms))} мс`;
    this.$("ping").classList.toggle("ping-bad", ms > 180);
  }

  setCharacter(name: string, role: Role, mode: "offline" | "online"): void {
    this.$("you-line").textContent = `${name} · ${ROLE_NAMES[role]} · ${
      mode === "online" ? "онлайн" : "против бота"
    }`;
  }

  setSelection(selected: EntitySnapshot[]): void {
    this.selected = selected;
    this.selectionSig = "";
    if (this.snap) {
      this.renderSelection();
      this.renderCommands();
    }
  }

  update(snap: Snapshot): void {
    this.snap = snap;
    const you = snap.you;
    this.$("res-gold").textContent = String(you.gold);
    this.$("res-wood").textContent = String(you.wood);
    this.$("res-supply").textContent = `${you.supplyUsed}/${you.supplyCap}`;
    const remaining = Math.max(0, this.balance.match.durationSeconds - snap.time);
    this.$("timer").textContent = `${Math.floor(remaining / 60)}:${String(
      Math.floor(remaining % 60),
    ).padStart(2, "0")}`;
    this.$("timer").classList.toggle("timer-low", remaining < 120);
    this.$("res-supply").classList.toggle("supply-cap", you.supplyUsed >= you.supplyCap);
    this.renderHero(you);
    this.renderCommands();
    this.renderTech();
    this.refreshAffordability(you);
    this.renderSelection();
  }

  handleEvents(events: SimEvent[]): void {
    for (const event of events) {
      if (event.type === "notice") {
        if (event.team === null || event.team === this.team) this.log(event.text, "notice");
      }
      if (event.type === "levelup" && event.team === this.team) {
        this.log(`Герой достиг ${event.level} уровня!`, "good");
        this.toast(`Герой: уровень ${event.level}`, "good");
      }
    }
  }

  addChat(from: string, text: string, team: Team): void {
    const left = team === this.team ? "chat-you" : "chat-enemy";
    this.log(`<b>${escape(from)}:</b> ${escape(text)}`, left);
  }

  log(text: string, kind = ""): void {
    const list = this.$("log-list");
    const row = document.createElement("div");
    row.className = `log-row ${kind}`;
    const time = this.snap ? Math.floor(this.snap.time) : this.lastLogTime;
    row.innerHTML = `<span class="log-time">${formatTime(time)}</span><span>${text}</span>`;
    list.appendChild(row);
    while (list.children.length > 45) list.removeChild(list.firstElementChild!);
    list.scrollTop = list.scrollHeight;
  }

  toast(text: string, kind: "ok" | "warn" | "error" | "good" | "" = ""): void {
    const el = this.$("toast");
    el.textContent = text;
    el.className = `toast ${kind}`;
    el.classList.remove("hidden");
    if (this.toastTimer !== null) window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => el.classList.add("hidden"), 3200);
  }

  showPlacement(kind: BuildingKind | null, valid = true, cost?: Cost): void {
    const hint = this.$("place-hint");
    if (!kind) {
      hint.classList.add("hidden");
      return;
    }
    const name = this.balance.buildings[kind].name;
    hint.innerHTML = `${icon("upgrade", 16)} <b>${escape(name)}</b> — ЛКМ поставить, ПКМ отмена${
      cost ? ` · ${cost.gold} золота, ${cost.wood} дерева` : ""
    }`;
    hint.classList.toggle("invalid", !valid);
    hint.classList.remove("hidden");
  }

  showEnd(snap: Snapshot): void {
    if (this.endedShown) return;
    this.endedShown = true;
    const win = snap.winner === this.team;
    const draw = snap.winner === null;
    const screen = this.$("end-screen");
    this.$("end-eyebrow").textContent = "Осада завершена";
    const title = draw ? "Ничья" : win ? "Победа" : "Поражение";
    this.$("end-title").textContent = title;
    this.$("end-title").className = draw ? "draw" : win ? "win" : "lose";
    this.$("end-reason").textContent = snap.reason;
    const stats = snap.stats;
    this.$("end-stats").innerHTML = [
      ["Обучено юнитов", stats.unitsTrained],
      ["Потеряно юнитов", stats.unitsLost],
      ["Построено зданий", stats.buildingsBuilt],
      ["Добыто золота", Math.round(stats.goldGathered)],
      ["Добыто дерева", Math.round(stats.woodGathered)],
      ["Нанесено урона", Math.round(stats.damageDealt)],
      ["Трофеев", stats.trophies],
      ["Уровень героя", snap.you.heroLevel],
    ]
      .map(
        ([label, value]) =>
          `<div class="end-stat"><span>${label}</span><b>${value}</b></div>`,
      )
      .join("");
    this.$("btn-end-again").classList.toggle("hidden", this.mode === "online");
    screen.classList.remove("hidden");
    requestAnimationFrame(() => screen.classList.add("visible"));
  }

  private renderHero(you: PlayerView): void {
    const xpNext = you.heroXpNext || 1;
    const ratio = Math.min(1, you.heroXp / Math.max(1, xpNext));
    this.$("hero-level").textContent = String(you.heroLevel);
    this.$("hero-xp").style.width = `${(ratio * 100).toFixed(1)}%`;
    this.$("hero-xp-label").textContent =
      you.heroLevel >= this.balance.hero.maxLevel
        ? "макс."
        : `${Math.floor(you.heroXp)} / ${xpNext} опыта`;

    const sig = [
      you.heroLevel,
      you.heroSkillPoints,
      JSON.stringify(you.heroSkills),
      JSON.stringify(you.heroCooldowns, (_key, value) => (typeof value === "number" ? Math.ceil(value) : value)),
      you.heroRespawnIn,
    ].join("|");
    if (sig === this.heroSig) return;
    this.heroSig = sig;

    const dead = you.heroRespawnIn > 0;
    const skills = this.balance.hero.skills
      .map((skill) => {
        const level = you.heroSkills[skill.id] ?? 0;
        const cooldown = Math.ceil(you.heroCooldowns[skill.id] ?? 0);
        const canLearn = level < Math.min(3, skill.levels.length) && you.heroSkillPoints > 0;
        const active = skill.type === "active";
        const useable = active && level > 0 && cooldown <= 0 && !dead;
        const key = skill.id === "mend" ? "Q" : skill.id === "charge" ? "W" : "";
        const dots = Array.from({ length: Math.min(3, skill.levels.length) }, (_, index) =>
          `<i class="${index < level ? "on" : ""}"></i>`,
        ).join("");
        return `
          <div class="skill ${level === 0 ? "unlearned" : ""} ${cooldown > 0 ? "cooling" : ""}">
            <button class="skill-main" data-action="${active && level > 0 ? "heroAbility" : "heroSkill"}"
              data-skill="${skill.id}" ${cooldown > 0 || (active && level > 0 && dead) ? "disabled" : ""}
              title="${escape(skill.description)}">
              <span class="skill-icon">${icon(skill.id, 18)}</span>
              <span class="skill-name">${escape(skill.name)}</span>
              <span class="skill-dots">${dots}</span>
              ${key ? `<span class="hotkey">${key}</span>` : ""}
              ${cooldown > 0 ? `<span class="cooldown">${cooldown}</span>` : ""}
            </button>
            ${
              canLearn
                ? `<button class="skill-learn" data-action="heroSkill" data-skill="${skill.id}" title="Изучить">+</button>`
                : ""
            }
          </div>
        `;
      })
      .join("");

    this.$("hero-skills").innerHTML = skills;
    this.$("hero-name").textContent = "Герой";
    this.$("hero-dead").classList.toggle("hidden", !dead);
    if (dead) this.$("hero-dead").textContent = `Возрождение через ${you.heroRespawnIn} с`;
  }

  private renderSelection(): void {
    const sig = this.selected.map((e) => `${e.id}:${e.hp}:${e.mhp}:${e.queue}:${e.t}`).join(",");
    if (sig === this.selectionSig) return;
    this.selectionSig = sig;
    const body = this.$("selection-body");
    const head = this.$("selection-head");
    if (!this.selected.length) {
      head.textContent = "Ничего не выбрано";
      body.innerHTML = `<p class="hint">ЛКМ — выбрать, ПКМ — приказ. <b>A</b> — атака по площади, <b>S</b> — стоп.</p>`;
      return;
    }
    const own = this.selected.filter((e) => e.team === this.team);
    if (this.selected.length === 1) {
      const entity = this.selected[0]!;
      head.textContent = this.entityName(entity);
      const ratio = Math.max(0, Math.min(1, entity.hp / Math.max(1, entity.mhp)));
      const def = entity.k === "u"
        ? this.balance.units[entity.t as UnitKind]
        : this.balance.buildings[entity.t as BuildingKind];
      const stats: string[] = [];
      if (def && "damage" in def) {
        stats.push(`Урон ${def.damage}`);
        stats.push(`Броня ${def.armor}`);
        stats.push(`Дальность ${def.range}`);
      } else if (def && "armor" in def) {
        stats.push(`Броня ${def.armor}`);
      }
      if (entity.k === "u" && entity.carry > 0 && entity.carryKind) {
        stats.push(`Несёт ${entity.carry} ${entity.carryKind === "gold" ? "золота" : "дерева"}`);
      }
      if (entity.k === "u" && entity.t === "hero") stats.push(`Уровень ${entity.level}`);
      let queue = "";
      if (entity.k === "b" && entity.queue > 0) {
        const items = entity.qk
          .map(
            (kind, index) => `
              <div class="queue-item">
                <span>${UNIT_NAMES[kind] ?? kind}</span>
                ${index === 0 ? `<div class="mini-progress"><i style="width:${(entity.qp * 100).toFixed(0)}%"></i></div>` : ""}
                <button data-action="cancelTrain" data-building="${entity.id}" data-index="${index}" title="Отменить">×</button>
              </div>`,
          )
          .join("");
        queue = `<div class="queue-list">${items}</div>`;
      }
      const rally =
        entity.k === "b" && entity.rallyX !== null
          ? `<p class="hint">Точка сбора: ${Math.round(entity.rallyX)}, ${Math.round(entity.rallyY ?? 0)}</p>`
          : "";
      body.innerHTML = `
        <div class="single-unit">
          <div class="portrait team-${entity.team}">${icon(this.iconFor(entity), 34)}</div>
          <div class="single-info">
            <div class="hp-bar"><i style="width:${(ratio * 100).toFixed(1)}%"></i></div>
            <div class="hp-text">${Math.round(entity.hp)} / ${Math.round(entity.mhp)}</div>
            <div class="stat-line">${stats.join(" · ")}</div>
            ${entity.k === "b" && !entity.done ? `<div class="stat-line">Строится: ${Math.round(entity.pr * 100)}%</div>` : ""}
            ${entity.k === "b" && entity.done ? `<div class="stat-line">${entity.queue > 0 ? "Очередь обучения" : "Готово"}</div>` : ""}
          </div>
        </div>
        ${queue}${rally}
      `;
    } else {
      head.textContent = `Выбрано: ${this.selected.length}`;
      const counts = new Map<string, number>();
      for (const entity of this.selected) {
        const name = this.entityName(entity);
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
      const ownHp = own.reduce((sum, e) => sum + e.hp, 0);
      const ownMax = own.reduce((sum, e) => sum + e.mhp, 0);
      body.innerHTML = `
        <div class="multi-list">
          ${this.selected
            .slice(0, 8)
            .map(
              (entity) =>
                `<button class="mini-unit team-${entity.team}" data-eid="${entity.id}" title="${escape(this.entityName(entity))}">${icon(this.iconFor(entity), 22)}</button>`,
            )
            .join("")}
        </div>
        <div class="stat-line">${[...counts.entries()]
          .map(([name, count]) => `${name} ×${count}`)
          .join(" · ")}</div>
        ${
          own.length
            ? `<div class="hp-bar"><i style="width:${((ownHp / Math.max(1, ownMax)) * 100).toFixed(1)}%"></i></div>`
            : ""
        }
      `;
    }
  }

  private entityName(entity: EntitySnapshot): string {
    if (entity.k === "u") return UNIT_NAMES[entity.t] ?? entity.t;
    const roleName = entity.team === this.team ? "" : entity.team === 2 ? " (нейтрал)" : " (враг)";
    const ownDef = this.balance.buildings[entity.t as BuildingKind];
    return `${ownDef?.name ?? entity.t}${roleName}`;
  }

  private iconFor(entity: EntitySnapshot): string {
    if (entity.k === "u") return entity.t;
    return entity.t;
  }

  private renderCommands(): void {
    if (!this.snap) return;
    const you = this.snap.you;
    const own = this.selected.filter((e) => e.team === this.team);
    const workers = own.filter((e) => e.k === "u" && e.t === "worker");
    const buildings = own.filter((e) => e.k === "b");
    const units = own.filter((e) => e.k === "u");
    const sig = [
      own.map((e) => `${e.id}:${e.t}`).join(","),
      you.tier,
      JSON.stringify(you.techs),
      buildings.map((b) => `${b.id}:${b.queue}:${b.done}`).join(","),
      workers.length,
    ].join("|");
    if (sig === this.commandSig) return;
    this.commandSig = sig;

    const buttons: string[] = [];
    if (units.length) {
      buttons.push(
        this.actionButton("stop", "Стоп", "stop", "S", "", {}),
      );
      buttons.push(this.actionButton("attackMove", "Атака", "cleave", "A", "", {}, "attackMove"));
    }
    if (workers.length) {
      const builds: Array<[BuildingKind, string, string]> = [
        ["house", "Дом", "house"],
        ["barracks", "Казармы", "barracks"],
        ["tower", "Башня", "tower"],
        ["workshop", "Мастерская", "workshop"],
        ["wall", "Стена", "wall"],
      ];
      if (you.role === "attacker" || this.role === "attacker") {
        builds.push(["outpost", "Форпост", "outpost"]);
      }
      for (const [kind, label, iconName] of builds) {
        const def = this.balance.buildings[kind];
        const locked = def.requiresTier && you.tier < def.requiresTier
          ? `Нужен ${def.requiresTier}-й уровень базы`
          : def.attackerOnly && this.role !== "attacker"
            ? "Только для атакующего"
            : "";
        buttons.push(
          this.actionButton(
            "build",
            label,
            iconName,
            "",
            costLabel(def.cost),
            { kind },
            "",
            locked,
          ),
        );
      }
    }
    for (const building of buildings) {
      if (!building.done) continue;
      const def = this.balance.buildings[building.t as BuildingKind];
      if (!def?.train) continue;
      for (const unit of def.train) {
        const unitDef = this.balance.units[unit];
        buttons.push(
          this.actionButton(
            "train",
            UNIT_NAMES[unit] ?? unit,
            unit,
            "",
            costLabel(unitDef.cost),
            { building: building.id, unit },
          ),
        );
      }
    }
    this.$("command-grid").innerHTML =
      buttons.join("") || `<p class="hint">Выберите рабочих или здание</p>`;
  }

  private actionButton(
    action: string,
    label: string,
    iconName: string,
    hotkey: string,
    cost: string,
    data: Record<string, string | number>,
    extraAction = "",
    locked = "",
  ): string {
    const attrs = Object.entries(data)
      .map(([key, value]) => `data-${key}="${value}"`)
      .join(" ");
    const costGold = data.unit
      ? this.balance.units[data.unit as UnitKind].cost.gold
      : data.kind
        ? this.balance.buildings[data.kind as BuildingKind].cost.gold
        : 0;
    const costWood = data.unit
      ? this.balance.units[data.unit as UnitKind].cost.wood
      : data.kind
        ? this.balance.buildings[data.kind as BuildingKind].cost.wood
        : 0;
    return `
      <button class="cmd ${locked ? "is-locked" : ""}" data-action="${extraAction || action}" ${attrs}
        data-gold="${costGold}" data-wood="${costWood}"
        ${locked ? `data-locked="${escape(locked)}" title="${escape(locked)}"` : ""}>
        <span class="cmd-icon">${icon(iconName, 24)}</span>
        <span class="cmd-label">${escape(label)}</span>
        ${cost ? `<span class="cmd-cost">${cost}</span>` : ""}
        ${hotkey ? `<span class="hotkey">${hotkey}</span>` : ""}
      </button>
    `;
  }

  private renderTech(): void {
    if (!this.snap) return;
    const you = this.snap.you;
    const sig = `${you.tier}|${JSON.stringify(you.techs)}`;
    if (sig === this.techSig) return;
    this.techSig = sig;
    const buttons: string[] = [];
    const nextTier = you.tier + 1;
    if (nextTier <= 3) {
      const tier = this.balance.tiers[String(nextTier)]!;
      buttons.push(
        this.techButton(
          "tier",
          `База ${nextTier}`,
          "upgrade",
          costLabel(tier.cost),
          {},
        ),
      );
    }
    for (const [id, def] of Object.entries(this.balance.techs)) {
      const level = you.techs[id] ?? 0;
      const max = def.levels.length;
      const next = def.levels[level];
      const label = `${techShort(id)} ${level}/${max}`;
      buttons.push(
        this.techButton(
          "research",
          label,
          id === "armor" ? "shield" : id === "damage" ? "cleave" : "worker",
          next ? costLabel(next.cost) : "макс",
          { tech: id },
          level >= max ? "Максимальный уровень" : "",
        ),
      );
    }
    this.$("tech-grid").innerHTML = buttons.join("");
  }

  private techButton(
    action: string,
    label: string,
    iconName: string,
    cost: string,
    data: Record<string, string | number>,
    locked = "",
  ): string {
    const attrs = Object.entries(data)
      .map(([key, value]) => `data-${key}="${value}"`)
      .join(" ");
    return `
      <button class="tech ${locked ? "is-locked" : ""}" data-action="${action}" ${attrs} title="${escape(locked || label)}">
        <span class="tech-icon">${icon(iconName, 16)}</span>
        <span class="tech-label">${escape(label)}</span>
        <span class="tech-cost">${cost || ""}</span>
      </button>
    `;
  }

  private refreshAffordability(you: PlayerView): void {
    const buttons = document.querySelectorAll<HTMLButtonElement>(
      "#command-grid .cmd, #tech-grid .tech",
    );
    for (const button of buttons) {
      if (button.dataset.locked) {
        button.classList.add("is-locked");
        button.title = button.dataset.locked;
        continue;
      }
      const gold = Number(button.dataset.gold ?? 0);
      const wood = Number(button.dataset.wood ?? 0);
      const affordable = you.gold >= gold && you.wood >= wood;
      button.classList.toggle("is-locked", !affordable);
      button.title = affordable
        ? ""
        : `Не хватает ресурсов: нужно ${gold} золота и ${wood} дерева`;
    }
  }

  private onCommandClick(event: MouseEvent): void {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-action]");
    if (!button) return;
    if (button.classList.contains("is-locked")) {
      this.toast(button.dataset.locked || "Недостаточно ресурсов", "warn");
      return;
    }
    const action = button.dataset.action;
    const building = Number(button.dataset.building ?? 0);
    const index = Number(button.dataset.index ?? 0);
    switch (action) {
      case "build":
        this.cb.onBuild(button.dataset.kind as BuildingKind);
        break;
      case "train":
        this.cb.onCommand({ t: "train", building, unit: button.dataset.unit as UnitKind });
        break;
      case "cancelTrain":
        this.cb.onCommand({ t: "cancelTrain", building, index });
        break;
      case "research":
        this.cb.onCommand({ t: "research", tech: button.dataset.tech! });
        break;
      case "tier":
        this.cb.onCommand({ t: "tier" });
        break;
      case "stop":
        this.cb.onCommand({ t: "stop", ids: this.selectedOwnUnitIds() });
        break;
      case "attackMove":
        this.cb.onAttackMove();
        break;
      case "heroSkill":
        this.cb.onCommand({ t: "heroSkill", skill: button.dataset.skill! });
        break;
      case "heroAbility":
        this.cb.onCommand({ t: "heroAbility", skill: button.dataset.skill! });
        break;
      default:
        break;
    }
  }

  private selectedOwnUnitIds(): number[] {
    return this.selected.filter((e) => e.team === this.team && e.k === "u").map((e) => e.id);
  }
}

function costLabel(cost: Cost): string {
  if (cost.gold === 0 && cost.wood === 0) return "";
  return `${COST_ICON.gold}${cost.gold} ${COST_ICON.wood}${cost.wood}`;
}

function techShort(id: string): string {
  return id === "armor" ? "Броня" : id === "damage" ? "Урон" : "Добыча";
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function escape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
