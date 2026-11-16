import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import balanceJson from "../public/data/balance.json";
import type { Balance, Role, Snapshot, Team } from "../src/shared/types.js";
import type { ClientMessage, ServerMessage } from "../src/shared/protocol.js";
import { createGameServer, type GameServer } from "../src/server/app.js";

const balance = balanceJson as Balance;

type Message<T extends ServerMessage["t"]> = Extract<ServerMessage, { t: T }>;

class TestClient {
  readonly messages: ServerMessage[] = [];
  lastSnapshot: Snapshot | null = null;
  private waiters: Array<{
    predicate: (message: ServerMessage) => boolean;
    resolve: (message: ServerMessage) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];
  private readonly closed: Promise<void>;

  private constructor(readonly ws: WebSocket) {
    this.closed = new Promise<void>((resolve) => {
      ws.once("close", () => resolve());
    });
    ws.on("message", (data) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(data.toString()) as ServerMessage;
      } catch {
        return;
      }
      if (message.t === "snapshot") this.lastSnapshot = message.snap;
      const index = this.waiters.findIndex((waiter) => waiter.predicate(message));
      if (index >= 0) {
        const [waiter] = this.waiters.splice(index, 1);
        clearTimeout(waiter!.timer);
        waiter!.resolve(message);
        return;
      }
      if (message.t !== "snapshot") this.messages.push(message);
    });
  }

  static connect(url: string): Promise<TestClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const client = new TestClient(ws);
      ws.once("open", () => resolve(client));
      ws.once("error", (error) => reject(error));
    });
  }

  send(message: ClientMessage): void {
    this.ws.send(JSON.stringify(message));
  }

  waitFor<T extends ServerMessage["t"]>(
    type: T,
    options: { timeout?: number; predicate?: (message: Message<T>) => boolean } = {},
  ): Promise<Message<T>> {
    const timeout = options.timeout ?? 12_000;
    const predicate = (message: ServerMessage): boolean =>
      message.t === type && (options.predicate ? options.predicate(message as Message<T>) : true);

    const index = this.messages.findIndex(predicate);
    if (index >= 0) {
      const [message] = this.messages.splice(index, 1);
      return Promise.resolve(message as Message<T>);
    }

    return new Promise<Message<T>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((waiter) => waiter.timer !== timer);
        reject(new Error(`Не дождались сообщения «${type}» за ${timeout} мс`));
      }, timeout);
      this.waiters.push({
        predicate,
        resolve: (message) => resolve(message as Message<T>),
        reject,
        timer,
      });
    });
  }

  waitForSnapshot(
    predicate: (snapshot: Snapshot) => boolean,
    timeout = 12_000,
  ): Promise<Snapshot> {
    if (this.lastSnapshot && predicate(this.lastSnapshot)) return Promise.resolve(this.lastSnapshot);
    return new Promise<Snapshot>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((waiter) => waiter.timer !== timer);
        reject(new Error(`Не дождались подходящего снапшота за ${timeout} мс`));
      }, timeout);
      this.waiters.push({
        predicate: (message) => message.t === "snapshot" && predicate(message.snap),
        resolve: (message) => resolve((message as Message<"snapshot">).snap),
        reject,
        timer,
      });
    });
  }

  async close(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.close();
    }
    await this.closed;
  }
}

let gameServer: GameServer;
let httpUrl = "";
let wsUrl = "";
const clients: TestClient[] = [];

async function connect(): Promise<TestClient> {
  const client = await TestClient.connect(wsUrl);
  clients.push(client);
  await client.waitFor("welcome");
  return client;
}

interface Match {
  code: string;
  tokenA: string;
  tokenB: string;
  teamA: Team;
  teamB: Team;
  roleA: Role;
  roleB: Role;
  a: TestClient;
  b: TestClient;
  startA: Message<"start">;
  startB: Message<"start">;
}

async function startMatch(): Promise<Match> {
  const a = await connect();
  a.send({ t: "join", name: "Атакующий", role: "attacker" });
  const joinedA = await a.waitFor("joined");
  expect(joinedA.team).toBe(1);
  expect(joinedA.role).toBe("attacker");

  const b = await connect();
  b.send({ t: "join", room: joinedA.code, name: "Защитник" });
  const joinedB = await b.waitFor("joined");
  expect(joinedB.team).toBe(0);
  expect(joinedB.role).toBe("defender");
  expect(joinedB.code).toBe(joinedA.code);

  await b.waitFor("countdown");
  const [startA, startB] = await Promise.all([a.waitFor("start"), b.waitFor("start")]);
  expect(startA.code).toBe(joinedA.code);
  expect(startB.team).toBe(0);
  expect(startA.players).toHaveLength(2);
  expect(startA.balance.match.durationSeconds).toBe(balance.match.durationSeconds);
  expect(startA.map.bases).toHaveLength(2);

  return {
    code: joinedA.code,
    tokenA: joinedA.token,
    tokenB: joinedB.token,
    teamA: joinedA.team,
    teamB: joinedB.team,
    roleA: joinedA.role,
    roleB: joinedB.role,
    a,
    b,
    startA,
    startB,
  };
}

beforeAll(async () => {
  gameServer = createGameServer(balance, path.resolve("src/client"));
  await new Promise<void>((resolve) => gameServer.server.listen(0, "127.0.0.1", () => resolve()));
  const address = gameServer.server.address() as AddressInfo;
  httpUrl = `http://127.0.0.1:${address.port}`;
  wsUrl = `ws://127.0.0.1:${address.port}/ws`;
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => undefined)));
});

afterAll(async () => {
  await gameServer.close();
});

describe("HTTP", () => {
  it("отдаёт здоровье и баланс", async () => {
    const health = await fetch(`${httpUrl}/api/health`);
    expect(health.status).toBe(200);
    const body = (await health.json()) as Record<string, unknown>;
    expect(body.status).toBe("ok");
    expect(body.protocol).toBe(1);
    expect(body.tickHz).toBe(balance.match.tickHz);
    expect(body.snapshotHz).toBe(balance.match.snapshotHz);

    const balanceResponse = await fetch(`${httpUrl}/api/balance`);
    expect(balanceResponse.status).toBe(200);
    const remote = (await balanceResponse.json()) as Balance;
    expect(remote.match.durationSeconds).toBe(balance.match.durationSeconds);
    expect(Object.keys(remote.units).length).toBe(Object.keys(balance.units).length);
  });

  it("отдаёт клиент и 404 для неизвестного API", async () => {
    const index = await fetch(`${httpUrl}/`);
    expect(index.status).toBe(200);
    expect(index.headers.get("content-type")).toContain("text/html");
    expect(await index.text()).toContain("ОСАДА");

    const missing = await fetch(`${httpUrl}/api/unknown`);
    expect(missing.status).toBe(404);
  });
});

describe("WebSocket: комната и матч", () => {
  it("создаёт комнату, подбирает роли и запускает матч", async () => {
    const match = await startMatch();
    expect(match.code).toMatch(/^[A-Z0-9]{4}$/);

    const snapshot = await match.a.waitForSnapshot((snap) => snap.entities.length > 0);
    expect(snapshot.you.role).toBe("attacker");
    expect(snapshot.entities.every((entity) => entity.team === 1)).toBe(true);
    expect(snapshot.you.gold).toBeGreaterThan(0);

    const defenderSnapshot = await match.b.waitForSnapshot((snap) => snap.entities.length > 0);
    expect(defenderSnapshot.you.role).toBe("defender");
    expect(defenderSnapshot.entities.every((entity) => entity.team === 0)).toBe(true);
  }, 30_000);

  it("пересылает чат и отвечает на пинг", async () => {
    const match = await startMatch();

    match.a.send({ t: "ping", at: 12345 });
    const pong = await match.a.waitFor("pong");
    expect(pong.at).toBe(12345);

    match.a.send({ t: "chat", text: "  Привет, защитник!  " });
    const [chatA, chatB] = await Promise.all([match.a.waitFor("chat"), match.b.waitFor("chat")]);
    expect(chatA.text).toBe("Привет, защитник!");
    expect(chatA.from).toBe("Атакующий");
    expect(chatA.team).toBe(1);
    expect(chatB.text).toBe(chatA.text);
    expect(chatB.team).toBe(1);
  }, 30_000);

  it("применяет команды на авторитетном сервере", async () => {
    const match = await startMatch();
    const initial = await match.a.waitForSnapshot((snap) =>
      snap.entities.some((entity) => entity.t === "hall"),
    );
    const hall = initial.entities.find((entity) => entity.t === "hall")!;
    expect(hall).toBeTruthy();
    const goldBefore = initial.you.gold;

    match.a.send({ t: "cmd", cmd: { t: "train", building: hall.id, unit: "worker" } });
    const queued = await match.a.waitForSnapshot(
      (snap) => {
        const building = snap.entities.find((entity) => entity.id === hall.id);
        return Boolean(building && (building.queue > 0 || snap.you.gold < goldBefore));
      },
    );
    const hallAfter = queued.entities.find((entity) => entity.id === hall.id)!;
    expect(hallAfter.qk.length + hallAfter.queue).toBeGreaterThan(0);
    expect(queued.you.gold).toBeLessThan(goldBefore);

    match.a.send({ t: "cmd", cmd: { t: "move", ids: [999_999], x: 50, y: 39 } });
    const error = await match.a.waitFor("error");
    expect(error.message.length).toBeGreaterThan(0);
  }, 30_000);

  it("завершает матч по сдаче защитника", async () => {
    const match = await startMatch();
    match.b.send({ t: "cmd", cmd: { t: "surrender" } });

    const [endA, endB] = await Promise.all([match.a.waitFor("end"), match.b.waitFor("end")]);
    expect(endA.winner).toBe(1);
    expect(endB.winner).toBe(1);
    expect(endA.reason).toMatch(/Защитник/i);

    const snap = await match.a.waitForSnapshot((snapshot) => snapshot.phase === "ended");
    expect(snap.phase).toBe("ended");
    expect(snap.winner).toBe(1);
  }, 30_000);

  it("возвращает в матч по токену после обрыва связи", async () => {
    const match = await startMatch();
    await match.a.waitForSnapshot(() => true);

    await match.a.close();
    clients.splice(clients.indexOf(match.a), 1);

    const status = await match.b.waitFor("opponentStatus");
    expect(status.connected).toBe(false);
    expect(status.graceSeconds).toBeGreaterThan(0);

    const back = await connect();
    back.send({ t: "join", room: match.code, token: match.tokenA, name: "Атакующий" });
    const joined = await back.waitFor("joined");
    expect(joined.team).toBe(match.teamA);

    const resumed = await back.waitFor("start");
    expect(resumed.reconnect).toBe(true);
    expect(resumed.team).toBe(match.teamA);
    expect(resumed.role).toBe("attacker");

    const snapshot = await back.waitForSnapshot((snap) => snap.entities.length > 0);
    expect(snapshot.you.role).toBe("attacker");

    const online = await match.b.waitFor("opponentStatus");
    expect(online.connected).toBe(true);
  }, 30_000);

  it("отклоняет неверный код и неизвестную сессию", async () => {
    const client = await connect();
    client.send({ t: "join", room: "ZZZZ", name: "Гость" });
    const missing = await client.waitFor("error");
    expect(missing.message).toMatch(/не найдена/i);

    client.send({ t: "join", room: "ABCD", token: "00000000-0000-0000-0000-000000000000" });
    const session = await client.waitFor("error");
    expect(session.message).toMatch(/не найдена|закрыта/i);

    client.send({ t: "cmd", cmd: { t: "surrender" } });
    const noRoom = await client.waitFor("error");
    expect(noRoom.message).toMatch(/комнат|войдите/i);
  }, 30_000);
});
