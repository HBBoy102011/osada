import { randomInt, randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import type { Balance, Command, Role, Team } from "../shared/types.js";
import { World } from "../shared/world.js";
import type { ClientMessage, LobbyPlayer, ServerMessage } from "../shared/protocol.js";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const DISCONNECT_GRACE_SECONDS = 60;
const MAX_NAME = 18;

export interface Connection {
  socket: WebSocket;
  room: Room | null;
  slot: Slot | null;
  send(message: ServerMessage): void;
  close(): void;
}

interface Slot {
  token: string;
  name: string;
  role: Role;
  team: Team;
  socket: Connection | null;
  connected: boolean;
  disconnectTimer: NodeJS.Timeout | null;
}

export class RoomManager {
  readonly rooms = new Map<string, Room>();

  constructor(readonly balance: Balance) {}

  join(connection: Connection, message: Extract<ClientMessage, { t: "join" }>): void {
    let code = (message.room ?? "").trim().toUpperCase();
    const token = message.token?.trim();

    if (token) {
      let room: Room | undefined;
      if (code) {
        room = this.rooms.get(code);
      } else {
        room = [...this.rooms.values()].find((r) => r.hasToken(token));
      }
      if (!room) {
        connection.send({ t: "error", message: "Комната не найдена — возможно, она уже закрыта" });
        return;
      }
      room.connect(connection, message.name, message.role, token);
      return;
    }

    if (code) {
      if (!/^[A-Z0-9]{4}$/.test(code)) {
        connection.send({ t: "error", message: "Код комнаты — 4 символа" });
        return;
      }
      const room = this.rooms.get(code);
      if (!room) {
        connection.send({ t: "error", message: "Комната не найдена" });
        return;
      }
      room.connect(connection, message.name, message.role, undefined);
      return;
    }

    do {
      code = Array.from({ length: 4 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
    } while (this.rooms.has(code));

    const room = new Room(code, this.balance, this);
    this.rooms.set(code, room);
    room.connect(connection, message.name, message.role, undefined);
  }

  remove(room: Room): void {
    this.rooms.delete(room.code);
  }

  stats(): { rooms: number; players: number; matches: number } {
    let players = 0;
    let matches = 0;
    for (const room of this.rooms.values()) {
      players += room.connectedCount();
      if (room.inMatch()) matches += 1;
    }
    return { rooms: this.rooms.size, players, matches };
  }
}

export class Room {
  readonly createdAt = Date.now();
  private slots: Slot[] = [];
  private world: World | null = null;
  private loop: NodeJS.Timeout | null = null;
  private destroyTimer: NodeJS.Timeout | null = null;
  private countdown: number | null = null;
  private lastCountdownSecond = 0;
  private lastTick = Date.now();
  private snapshotAccum = 0;
  private snapshotIndex = 0;
  private startedOnce = false;
  private endedSent = false;

  constructor(
    readonly code: string,
    private readonly balance: Balance,
    private readonly manager: RoomManager,
  ) {
    this.loop = setInterval(() => this.update(), 50);
    this.loop.unref?.();
  }

  inMatch(): boolean {
    return this.world !== null && this.world.phase === "playing";
  }

  connectedCount(): number {
    return this.slots.filter((s) => s.connected).length;
  }

  hasToken(token: string): boolean {
    return this.slots.some((s) => s.token === token);
  }

  connect(
    connection: Connection,
    rawName: string | undefined,
    requested: Role | "random" | undefined,
    token: string | undefined,
  ): void {
    if (token) {
      const slot = this.slots.find((s) => s.token === token);
      if (!slot) {
        connection.send({ t: "error", message: "Сессия не найдена" });
        return;
      }
      this.attach(connection, slot);
      return;
    }

    if (this.world) {
      connection.send({ t: "error", message: "Матч уже начался. Введите код и токен для переподключения" });
      return;
    }
    if (this.slots.length >= 2) {
      connection.send({ t: "error", message: "Комната заполнена" });
      return;
    }

    const name = sanitizeName(rawName);
    let role: Role;
    if (this.slots.length === 0) {
      role = requested === "attacker" || requested === "defender"
        ? requested
        : randomInt(2) === 0
          ? "defender"
          : "attacker";
    } else {
      role = this.slots[0]!.role === "defender" ? "attacker" : "defender";
    }
    const slot: Slot = {
      token: randomUUID(),
      name: name || (role === "defender" ? "Защитник" : "Атакующий"),
      role,
      team: role === "defender" ? 0 : 1,
      socket: null,
      connected: false,
      disconnectTimer: null,
    };
    this.slots.push(slot);
    this.attach(connection, slot);
  }

  private attach(connection: Connection, slot: Slot): void {
    if (slot.socket && slot.socket !== connection) {
      const old = slot.socket;
      old.slot = null;
      old.room = null;
      try {
        old.close();
      } catch {
        /* старый сокет уже закрыт */
      }
    }
    if (slot.disconnectTimer) {
      clearTimeout(slot.disconnectTimer);
      slot.disconnectTimer = null;
    }
    slot.socket = connection;
    slot.connected = true;
    connection.room = this;
    connection.slot = slot;
    if (this.destroyTimer) {
      clearTimeout(this.destroyTimer);
      this.destroyTimer = null;
    }
    if (this.world) {
      this.world.players[slot.team as 0 | 1].connected = true;
    }

    connection.send({
      t: "joined",
      code: this.code,
      team: slot.team,
      role: slot.role,
      token: slot.token,
      name: slot.name,
      players: this.lobbyPlayers(),
    });

    if (this.world) {
      this.sendStart(slot);
      this.sendSnapshot(slot, true);
      if (this.world.phase === "ended") {
        connection.send({
          t: "end",
          winner: this.world.winner,
          reason: this.world.endReason,
        });
      }
      const other = this.otherSlot(slot);
      other?.socket?.send({ t: "opponentStatus", connected: true, graceSeconds: 0 });
    } else {
      this.broadcastLobby();
      this.maybeCountdown();
      if (this.slots.length === 1) {
        this.broadcast();
      }
    }
  }

  private maybeCountdown(): void {
    if (this.world || this.countdown !== null) return;
    if (this.slots.length === 2 && this.slots.every((s) => s.connected)) {
      this.countdown = 3;
      this.lastCountdownSecond = 3;
      this.broadcastCountdown(3);
      this.broadcastLobby();
    }
  }

  private broadcastCountdown(seconds: number): void {
    for (const slot of this.slots) {
      slot.socket?.send({ t: "countdown", seconds });
    }
  }

  private broadcastLobby(): void {
    if (this.world) return;
    const players = this.lobbyPlayers();
    for (const slot of this.slots) {
      slot.socket?.send({
        t: "lobby",
        code: this.code,
        players,
        countdown: this.countdown === null ? null : Math.ceil(this.countdown),
      });
    }
  }

  private broadcast(): void {
    this.broadcastLobby();
  }

  lobbyPlayers(): LobbyPlayer[] {
    return this.slots.map((slot) => ({
      name: slot.name,
      role: slot.role,
      team: slot.team,
      connected: slot.connected,
    }));
  }

  private startMatch(): void {
    const connectedSlots = this.slots.filter((s) => s.connected && s.socket);
    if (connectedSlots.length < 2 || this.world) return;
    this.world = new World({
      balance: this.balance,
      seed: randomInt(1, 2 ** 31 - 1),
      names: [this.slots.find((s) => s.team === 0)?.name ?? "Защитник", this.slots.find((s) => s.team === 1)?.name ?? "Атакующий"],
    });
    for (const slot of this.slots) {
      this.world.players[slot.team as 0 | 1].connected = slot.connected;
    }
    this.startedOnce = true;
    this.countdown = null;
    for (const slot of this.slots) {
      if (slot.connected) this.sendStart(slot);
    }
    this.broadcastSnapshots(true);
    this.world.clearEvents();
  }

  private sendStart(slot: Slot): void {
    if (!this.world) return;
    slot.socket?.send({
      t: "start",
      code: this.code,
      team: slot.team,
      role: slot.role,
      balance: this.balance,
      map: this.world.map,
      players: this.slots.map((s) => ({ name: s.name, team: s.team, role: s.role })),
      reconnect: this.startedOnce,
    });
  }

  handleCommand(connection: Connection, cmd: Command): void {
    if (!this.world || !connection.slot) {
      connection.send({ t: "error", message: "Матч ещё не начался" });
      return;
    }
    if (connection.slot.team !== 0 && connection.slot.team !== 1) {
      connection.send({ t: "error", message: "Неизвестная команда" });
      return;
    }
    const result = this.world.applyCommand(connection.slot.team, cmd);
    if (!result.ok) {
      connection.send({ t: "error", message: result.error ?? "Команда отклонена" });
    }
  }

  handleChat(connection: Connection, text: string): void {
    if (!connection.slot) return;
    const clean = text.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 160);
    if (!clean) return;
    for (const slot of this.slots) {
      slot.socket?.send({
        t: "chat",
        from: connection.slot.name,
        team: connection.slot.team,
        text: clean,
      });
    }
  }

  handleClose(connection: Connection): void {
    const slot = connection.slot;
    if (!slot) return;
    connection.slot = null;
    connection.room = null;
    slot.socket = null;
    slot.connected = false;
    if (this.world) {
      this.world.players[slot.team as 0 | 1].connected = false;
    }

    if (!this.world) {
      this.slots = this.slots.filter((s) => s !== slot);
      this.countdown = null;
      this.broadcastLobby();
      if (this.slots.length === 0) {
        this.scheduleDestroy(30_000);
      } else {
        this.maybeCountdown();
      }
      return;
    }

    if (this.world.phase === "playing") {
      const other = this.otherSlot(slot);
      other?.socket?.send({
        t: "opponentStatus",
        connected: false,
        graceSeconds: DISCONNECT_GRACE_SECONDS,
      });
      other?.socket?.send({
        t: "notice",
        text: `Соперник отключился. Даём ${DISCONNECT_GRACE_SECONDS} секунд на возвращение`,
      });
      if (slot.disconnectTimer) clearTimeout(slot.disconnectTimer);
      slot.disconnectTimer = setTimeout(() => {
        if (!slot.connected && this.world && this.world.phase === "playing") {
          this.world.forfeit(slot.team);
          this.finishMatch();
        }
      }, DISCONNECT_GRACE_SECONDS * 1000);
      slot.disconnectTimer.unref?.();
    }
  }

  private otherSlot(slot: Slot): Slot | undefined {
    return this.slots.find((s) => s !== slot);
  }

  private update(): void {
    const now = Date.now();
    const dt = Math.min(0.2, Math.max(0.01, (now - this.lastTick) / 1000));
    this.lastTick = now;

    if (!this.world) {
      if (this.countdown !== null) {
        this.countdown -= dt;
        const second = Math.max(0, Math.ceil(this.countdown));
        if (second !== this.lastCountdownSecond) {
          this.lastCountdownSecond = second;
          this.broadcastCountdown(second);
        }
        if (this.countdown <= 0) {
          this.countdown = null;
          this.startMatch();
        }
      }
      return;
    }

    if (this.world.phase === "playing") {
      this.world.tick(dt);
      for (const slot of this.slots) {
        if (slot.socket) this.world.players[slot.team as 0 | 1].connected = slot.connected;
      }
      this.snapshotAccum += dt;
      if (this.snapshotAccum >= 0.125) {
        this.snapshotAccum = 0;
        this.broadcastSnapshots(this.snapshotIndex % 8 === 0);
        this.world.clearEvents();
        this.snapshotIndex += 1;
      }
    }

    if (this.world.phase === "ended") {
      this.finishMatch();
    }
  }

  private broadcastSnapshots(withFog: boolean): void {
    if (!this.world) return;
    for (const slot of this.slots) {
      if (slot.connected && slot.socket) this.sendSnapshot(slot, withFog);
    }
  }

  private sendSnapshot(slot: Slot, withFog: boolean): void {
    if (!this.world || !slot.socket) return;
    slot.socket.send({ t: "snapshot", snap: this.world.snapshot(slot.team, withFog) });
  }

  private finishMatch(): void {
    if (!this.world || this.endedSent) return;
    this.endedSent = true;
    this.broadcastSnapshots(true);
    for (const slot of this.slots) {
      slot.socket?.send({
        t: "end",
        winner: this.world.winner,
        reason: this.world.endReason,
      });
    }
    this.world.clearEvents();
    if (this.loop) {
      clearInterval(this.loop);
      this.loop = null;
    }
    this.scheduleDestroy(10 * 60 * 1000);
  }

  private scheduleDestroy(ms: number): void {
    if (this.destroyTimer) return;
    this.destroyTimer = setTimeout(() => {
      this.destroy();
    }, ms);
    this.destroyTimer.unref?.();
  }

  private destroy(): void {
    if (this.loop) {
      clearInterval(this.loop);
      this.loop = null;
    }
    for (const slot of this.slots) {
      if (slot.disconnectTimer) clearTimeout(slot.disconnectTimer);
      slot.disconnectTimer = null;
      slot.socket?.send({ t: "notice", text: "Комната закрыта" });
      try {
        slot.socket?.close();
      } catch {
        /* сокет уже закрыт */
      }
      slot.socket = null;
      slot.connected = false;
    }
    this.manager.remove(this);
  }
}

export function sanitizeName(raw: string | undefined): string {
  if (!raw) return "";
  return raw
    .replace(/[\u0000-\u001f<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NAME);
}
