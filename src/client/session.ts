import type {
  Balance,
  Command,
  Role,
  Snapshot,
  Team,
} from "../shared/types.js";
import type { ClientMessage, ServerMessage } from "../shared/protocol.js";
import { Bot } from "../shared/bot.js";
import { World } from "../shared/world.js";

export interface GameSession {
  mode: "offline" | "online";
  team: Team;
  role: Role;
  sendCommand(cmd: Command): void;
  sendChat(text: string): void;
  dispose(): void;
}

export interface OfflineSessionOptions {
  balance: Balance;
  role: Role;
  playerName: string;
  onSnapshot(snapshot: Snapshot): void;
  onError(message: string): void;
  onEnd?: (winner: Team | null, reason: string) => void;
}

/** Оффлайн-матч: тот же World и тот же бот, что и на сервере, но в браузере. */
export class OfflineSession implements GameSession {
  readonly mode = "offline" as const;
  readonly team: Team;
  readonly role: Role;
  readonly world: World;
  private readonly bot: Bot;
  private timer: number | null = null;
  private accumulator = 0;
  private snapshotAccum = 0;
  private last = performance.now();
  private ended = false;
  private readonly options: OfflineSessionOptions;

  constructor(options: OfflineSessionOptions) {
    this.options = options;
    this.role = options.role;
    this.team = options.role === "defender" ? 0 : 1;
    const botTeam: Team = this.team === 0 ? 1 : 0;
    const names: [string, string] =
      this.team === 0 ? [options.playerName, "Бот"] : ["Бот", options.playerName];
    this.world = new World({
      balance: options.balance,
      seed: Math.floor(Math.random() * 2 ** 31),
      names,
    });
    this.bot = new Bot(this.world, botTeam);
  }

  /** Запускает цикл симуляции. Вызывается после создания Game. */
  start(): void {
    this.last = performance.now();
    this.options.onSnapshot(this.world.snapshot(this.team, true));
    this.world.clearEvents();
    this.timer = window.setInterval(() => this.update(), 50);
  }

  get players(): Array<{ name: string; team: Team; role: Role }> {
    return [
      { name: this.world.players[0].name, team: 0, role: "defender" },
      { name: this.world.players[1].name, team: 1, role: "attacker" },
    ];
  }

  sendCommand(cmd: Command): void {
    const result = this.world.applyCommand(this.team, cmd);
    if (!result.ok && result.error) this.options.onError(result.error);
  }

  sendChat(): void {
    /* в оффлайне собеседника нет */
  }

  dispose(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
  }

  private update(): void {
    const now = performance.now();
    const dt = Math.min(0.25, Math.max(0.001, (now - this.last) / 1000));
    this.last = now;
    if (this.world.phase === "playing") {
      this.accumulator += dt;
      let guard = 0;
      while (this.accumulator >= 0.05 && guard++ < 8) {
        this.world.tick(0.05);
        this.bot.update(0.05);
        this.accumulator -= 0.05;
      }
      this.snapshotAccum += dt;
      if (this.snapshotAccum >= 0.1) {
        this.snapshotAccum = 0;
        this.options.onSnapshot(this.world.snapshot(this.team, true));
        this.world.clearEvents();
      }
    } else if (!this.ended) {
      this.ended = true;
      this.options.onSnapshot(this.world.snapshot(this.team, true));
      this.world.clearEvents();
      this.options.onEnd?.(this.world.winner, this.world.endReason);
    }
  }
}

export class NetClient {
  private ws: WebSocket | null = null;
  private readonly queue: ClientMessage[] = [];
  private pingTimer: number | null = null;
  private closedByUser = false;

  constructor(
    private readonly url: string,
    private readonly handlers: {
      onMessage(message: ServerMessage): void;
      onOpen(): void;
      onClose(): void;
      onPing?(ms: number): void;
    },
  ) {}

  connect(): void {
    this.closedByUser = false;
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.handlers.onOpen();
      for (const message of this.queue.splice(0)) ws.send(JSON.stringify(message));
      if (this.pingTimer !== null) window.clearInterval(this.pingTimer);
      this.pingTimer = window.setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({ t: "ping", at: performance.now() }));
      }, 4000);
    };
    ws.onmessage = (event) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }
      if (message.t === "pong") {
        this.handlers.onPing?.(performance.now() - message.at);
        return;
      }
      this.handlers.onMessage(message);
    };
    ws.onclose = () => {
      if (this.pingTimer !== null) {
        window.clearInterval(this.pingTimer);
        this.pingTimer = null;
      }
      if (!this.closedByUser) this.handlers.onClose();
    };
    ws.onerror = () => {
      /* onclose обработает состояние */
    };
  }

  send(message: ClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else {
      this.queue.push(message);
    }
  }

  close(): void {
    this.closedByUser = true;
    if (this.pingTimer !== null) window.clearInterval(this.pingTimer);
    this.pingTimer = null;
    try {
      this.ws?.close();
    } catch {
      /* уже закрыт */
    }
    this.ws = null;
  }
}

export class OnlineSession implements GameSession {
  readonly mode = "online" as const;

  constructor(
    readonly team: Team,
    readonly role: Role,
    private readonly net: NetClient,
  ) {}

  sendCommand(cmd: Command): void {
    this.net.send({ t: "cmd", cmd });
  }

  sendChat(text: string): void {
    this.net.send({ t: "chat", text });
  }

  dispose(): void {
    /* соединение закрывает main.ts при выходе */
  }
}

export function wsUrl(): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/ws`;
}
