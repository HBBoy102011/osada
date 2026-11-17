import type { Balance, GameMap, Role, Team } from "../shared/types.js";
import type { ClientMessage, LobbyPlayer, ServerMessage } from "../shared/protocol.js";
import { Game } from "./game.js";
import { NetClient, OfflineSession, OnlineSession, wsUrl } from "./session.js";

type RequestedRole = Role | "random";

const STORAGE_NAME = "osada.name";
const STORAGE_SESSION = "osada.session";

const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

let balance: Balance | null = null;
let balanceTask: Promise<Balance> | null = null;
let game: Game | null = null;
let net: NetClient | null = null;
let netGen = 0;
let retryTimer: number | null = null;
let reconnectUntil = 0;
let lastJoin: ClientMessage | null = null;
let selectedRole: RequestedRole = "random";
let lastOfflineRole: Role | null = null;
let showingMenu = true;

const online = {
  code: "",
  token: null as string | null,
  name: "",
  team: 0 as Team,
  players: [] as LobbyPlayer[],
  inMatch: false,
};

/* ------------------------------------------------------------------ boot */

void boot();

async function boot(): Promise<void> {
  wireMenu();
  restoreName();
  restoreSession();
  readRoomFromUrl();

  try {
    balance = await balanceReady();
  } catch {
    setConnection("Не удалось загрузить баланс. Обновите страницу.", "error");
  }
}

/** Один и тот же запрос баланса переиспользуется всеми кнопками меню. */
function balanceReady(): Promise<Balance> {
  if (balance) return Promise.resolve(balance);
  balanceTask ??= loadBalance().then((data) => {
    balance = data;
    return data;
  });
  return balanceTask;
}

/**
 * Кнопки меню можно нажать раньше, чем догрузится баланс (бесплатный инстанс
 * просыпается не мгновенно). Тогда честно ждём загрузку вместо ошибки.
 */
async function requireBalance(): Promise<Balance | null> {
  setConnection("Загружаем баланс…", "warn");
  try {
    return await balanceReady();
  } catch {
    setConnection("Не удалось загрузить баланс. Обновите страницу.", "error");
    return null;
  } finally {
    if ($("connection-text").textContent.startsWith("Загружаем баланс")) {
      $("connection").classList.add("hidden");
    }
  }
}

/**
 * Бесплатные инстансы засыпают, поэтому первый запрос может не дойти.
 * Делаем несколько попыток с нарастающей паузой, прежде чем сдаться.
 */
async function loadBalance(): Promise<Balance> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const response = await fetch("/data/balance.json", { cache: "no-cache" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return (await response.json()) as Balance;
    } catch (error) {
      lastError = error;
      if (attempt < 4) {
        setConnection("Загружаем баланс…", "warn");
        await new Promise((resolve) => setTimeout(resolve, attempt * 700));
      }
    }
  }
  throw lastError ?? new Error("баланс недоступен");
}

/** Выполняет действие, как только баланс доступен (или сразу, если уже загружен). */
function withBalance(action: () => void): void {
  if (balance) {
    action();
    return;
  }
  void requireBalance().then((data) => {
    if (data) action();
  });
}

function wireMenu(): void {
  for (const tab of document.querySelectorAll<HTMLButtonElement>(".tab")) {
    tab.addEventListener("click", () => selectTab(tab.dataset.tab === "online" ? "online" : "offline"));
  }

  for (const card of document.querySelectorAll<HTMLButtonElement>(".role-card")) {
    card.addEventListener("click", () => {
      selectedRole = (card.dataset.role as RequestedRole) ?? "random";
      for (const other of document.querySelectorAll(".role-card")) {
        other.classList.toggle("is-selected", other === card);
      }
    });
  }

  const offlineName = $<HTMLInputElement>("offline-name");
  const onlineName = $<HTMLInputElement>("online-name");
  for (const input of [offlineName, onlineName]) {
    input.addEventListener("input", () => {
      const value = input.value.slice(0, 18);
      offlineName.value = value;
      onlineName.value = value;
      localStorage.setItem(STORAGE_NAME, value);
    });
  }

  $("btn-play-offline").addEventListener("click", () => {
    withBalance(() => {
      const role: Role = selectedRole === "random"
        ? Math.random() < 0.5 ? "defender" : "attacker"
        : selectedRole;
      startOffline(role, playerName(offlineName));
    });
  });

  $("btn-create").addEventListener("click", () => {
    withBalance(() => {
      const name = playerName(onlineName);
      online.code = "";
      online.token = null;
      selectTab("online");
      connect({ t: "join", name, role: selectedRole });
    });
  });

  const joinCode = $<HTMLInputElement>("join-code");
  const joinRoom = (): void => {
    const code = joinCode.value.trim().toUpperCase().slice(0, 4);
    if (code.length !== 4) {
      setConnection("Введите 4-символьный код комнаты", "error");
      return;
    }
    withBalance(() => {
      connect({ t: "join", room: code, name: playerName(onlineName) });
    });
  };
  $("btn-join").addEventListener("click", joinRoom);
  joinCode.addEventListener("keydown", (event) => {
    if (event.key === "Enter") joinRoom();
  });
  joinCode.addEventListener("input", () => {
    joinCode.value = joinCode.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  });

  $("btn-copy").addEventListener("click", () => {
    const url = `${location.origin}/?room=${online.code}`;
    const copied = navigator.clipboard?.writeText(url);
    if (copied) {
      void copied.then(
        () => setLobbyStatus("Ссылка скопирована"),
        () => setLobbyStatus(`Ссылка: ${url}`),
      );
    } else {
      setLobbyStatus(`Ссылка: ${url}`);
    }
  });

  $("btn-leave").addEventListener("click", () => {
    leaveOnline();
    setConnection("Вы вышли из комнаты", "ok");
  });

  $("btn-resume").addEventListener("click", () => {
    if (!online.code || !online.token) return;
    selectTab("online");
    connect({
      t: "join",
      room: online.code,
      token: online.token,
      name: playerName(onlineName),
    });
  });

  $("btn-retry").addEventListener("click", () => {
    if (!lastJoin) return;
    connect(lastJoin);
  });

  const howto = $("howto");
  const openHowto = (): void => howto.classList.remove("hidden");
  const closeHowto = (): void => howto.classList.add("hidden");
  $("btn-howto").addEventListener("click", openHowto);
  $("btn-howto-close").addEventListener("click", closeHowto);
  $("btn-howto-ok").addEventListener("click", closeHowto);
  howto.addEventListener("click", (event) => {
    if (event.target === howto) closeHowto();
  });

  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      howto.classList.add("hidden");
      $("confirm").classList.add("hidden");
    }
  });
}

function selectTab(tab: "offline" | "online"): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>(".tab")) {
    button.classList.toggle("is-active", button.dataset.tab === tab);
  }
  $("panel-offline").classList.toggle("hidden", tab !== "offline");
  $("panel-online").classList.toggle("hidden", tab !== "online");
}

function restoreName(): void {
  const saved = localStorage.getItem(STORAGE_NAME) ?? "";
  $<HTMLInputElement>("offline-name").value = saved;
  $<HTMLInputElement>("online-name").value = saved;
}

function playerName(input: HTMLInputElement): string {
  const name = input.value.trim().slice(0, 18) || "Полководец";
  localStorage.setItem(STORAGE_NAME, name);
  return name;
}

function restoreSession(): void {
  const raw = sessionStorage.getItem(STORAGE_SESSION);
  if (!raw) return;
  try {
    const saved = JSON.parse(raw) as { code?: string; token?: string; name?: string };
    if (!saved.code || !saved.token) return;
    online.code = saved.code;
    online.token = saved.token;
    $("btn-resume").classList.remove("hidden");
    $("btn-resume").textContent = `Вернуться в комнату ${saved.code}`;
  } catch {
    sessionStorage.removeItem(STORAGE_SESSION);
  }
}

function saveSession(): void {
  if (!online.code || !online.token) return;
  sessionStorage.setItem(
    STORAGE_SESSION,
    JSON.stringify({ code: online.code, token: online.token, name: online.name }),
  );
  $("btn-resume").classList.remove("hidden");
  $("btn-resume").textContent = `Вернуться в комнату ${online.code}`;
}

function clearSession(): void {
  online.token = null;
  sessionStorage.removeItem(STORAGE_SESSION);
  $("btn-resume").classList.add("hidden");
}

function readRoomFromUrl(): void {
  const room = new URLSearchParams(location.search).get("room");
  if (!room) return;
  const code = room.trim().toUpperCase().slice(0, 4);
  if (code.length !== 4) return;
  selectTab("online");
  $<HTMLInputElement>("join-code").value = code;
  setConnection(`Комната ${code}: введите имя и нажмите «Войти»`, "ok");
}

/* ---------------------------------------------------------------- оффлайн */

function startOffline(role: Role, name: string): void {
  if (!balance) return;
  lastOfflineRole = role;
  const session = new OfflineSession({
    balance,
    role,
    playerName: name,
    onSnapshot: (snap) => game?.applySnapshot(snap),
    onError: (message) => game?.toast(message, "warn"),
  });
  createGame({
    balance,
    map: session.world.map,
    team: session.team,
    role,
    mode: "offline",
    name,
    players: session.players,
    session,
  });
  session.start();
}

function restartOffline(): void {
  exitToMenu(false);
  if (!lastOfflineRole) return;
  const name = $<HTMLInputElement>("offline-name").value.trim() || "Полководец";
  startOffline(lastOfflineRole, name);
}

/* ------------------------------------------------------------------ онлайн */

function connect(join: ClientMessage): void {
  disconnectNet();
  lastJoin = join;
  const gen = ++netGen;
  showConnection("Подключение к серверу…", "warn");
  $("btn-retry").classList.add("hidden");

  const client = new NetClient(wsUrl(), {
    onOpen: () => {
      if (gen !== netGen) return;
      client.send(join);
      showConnection("Соединение установлено", "ok");
    },
    onMessage: (message) => {
      if (gen !== netGen) return;
      handleServer(message);
    },
    onClose: () => {
      if (gen !== netGen) return;
      handleNetClose();
    },
    onPing: (ms) => game?.setPing(ms),
  });
  net = client;
  client.connect();
}

function disconnectNet(): void {
  netGen++;
  if (retryTimer !== null) {
    window.clearTimeout(retryTimer);
    retryTimer = null;
  }
  net?.close();
  net = null;
}

function leaveOnline(): void {
  online.inMatch = false;
  disconnectNet();
  $("lobby").classList.add("hidden");
  $("btn-resume").classList.toggle("hidden", !online.token);
  clearSession();
}

function handleNetClose(): void {
  if (showingMenu) {
    showConnection("Соединение с сервером потеряно", "error");
    $("btn-retry").classList.remove("hidden");
    return;
  }
  if (!online.inMatch || !online.token) {
    showConnection("Соединение закрыто", "error");
    $("btn-retry").classList.remove("hidden");
    return;
  }
  if (reconnectUntil === 0) reconnectUntil = Date.now() + 55_000;
  if (Date.now() > reconnectUntil) {
    reconnectUntil = 0;
    showConnection("Не удалось переподключиться. Матч завершён.", "error");
    online.inMatch = false;
    game?.toast("Связь потеряна, вернуться не удалось", "error");
    return;
  }
  game?.toast("Связь потеряна, переподключаемся…", "warn");
  showConnection("Переподключение…", "warn");
  if (retryTimer !== null) window.clearTimeout(retryTimer);
  retryTimer = window.setTimeout(() => {
    retryTimer = null;
    if (!online.token) return;
    connect({
      t: "join",
      room: online.code,
      token: online.token,
      name: online.name,
    });
  }, 2200);
}

function handleServer(message: ServerMessage): void {
  switch (message.t) {
    case "welcome":
      break;
    case "joined": {
      online.code = message.code;
      online.token = message.token;
      online.team = message.team;
      online.name = message.name;
      online.players = message.players;
      reconnectUntil = 0;
      saveSession();
      $("lobby").classList.remove("hidden");
      $("btn-resume").classList.add("hidden");
      $("btn-retry").classList.add("hidden");
      renderLobby();
      setConnection("В комнате", "ok");
      selectTab("online");
      break;
    }
    case "lobby": {
      online.code = message.code;
      online.players = message.players;
      renderLobby();
      if (message.countdown !== null) {
        setLobbyStatus(`Матч начнётся через ${message.countdown}…`, true);
      } else {
        setLobbyStatus(
          message.players.length < 2
            ? "Ожидание соперника… Поделитесь кодом комнаты."
            : "Соперник на месте",
        );
      }
      break;
    }
    case "countdown": {
      if (message.seconds > 0) {
        setLobbyStatus(`Матч начнётся через ${message.seconds}…`, true);
      } else {
        setLobbyStatus("Матч начинается…");
      }
      break;
    }
    case "start": {
      online.inMatch = true;
      online.team = message.team;
      startOnline(message);
      break;
    }
    case "snapshot": {
      game?.applySnapshot(message.snap);
      break;
    }
    case "chat": {
      game?.addChat(message.from, message.text, message.team);
      break;
    }
    case "opponentStatus": {
      game?.setOpponentStatus(message.connected, message.graceSeconds);
      break;
    }
    case "end": {
      online.inMatch = false;
      clearSession();
      break;
    }
    case "notice": {
      game?.toast(message.text, "warn");
      break;
    }
    case "error": {
      if (/не найдена|не найден|закрыта/i.test(message.message)) {
        clearSession();
      }
      if (game) game.toast(message.message, "error");
      else showConnection(message.message, "error");
      break;
    }
    default:
      break;
  }
}

function startOnline(message: Extract<ServerMessage, { t: "start" }>): void {
  if (!net) return;
  const session = new OnlineSession(message.team, message.role, net);
  createGame({
    balance: message.balance,
    map: message.map,
    team: message.team,
    role: message.role,
    mode: "online",
    name: online.name,
    players: message.players,
    session,
  });
  if (message.reconnect) game?.toast("Вы вернулись в матч", "ok");
}

function renderLobby(): void {
  $("lobby-code").textContent = online.code || "····";
  const list = $("lobby-players");
  if (!online.players.length) {
    list.innerHTML = `<li class="is-off"><span class="dot"></span><span>Пока никого…</span></li>`;
    return;
  }
  list.innerHTML = online.players
    .map(
      (player) => `
        <li class="team-${player.team} ${player.connected ? "" : "is-off"}">
          <span class="dot"></span>
          <span>${escape(player.name)}${player.team === online.team ? " (вы)" : ""}</span>
          <span class="tag">${player.role === "defender" ? "Защитник" : "Атакующий"}</span>
        </li>`,
    )
    .join("");
}

function setLobbyStatus(text: string, counting = false): void {
  const status = $("lobby-status");
  status.textContent = text;
  status.classList.toggle("counting", counting);
}

function showConnection(text: string, kind: "ok" | "warn" | "error"): void {
  const box = $("connection");
  box.classList.remove("hidden");
  box.classList.remove("is-ok", "is-error");
  if (kind === "ok") box.classList.add("is-ok");
  if (kind === "error") box.classList.add("is-error");
  $("connection-text").textContent = text;
}

function setConnection(text: string, kind: "ok" | "warn" | "error"): void {
  showConnection(text, kind);
}

/* ------------------------------------------------------------------- игра */

interface CreateGameOptions {
  balance: Balance;
  map: GameMap;
  team: Team;
  role: Role;
  mode: "offline" | "online";
  name: string;
  players: Array<{ name: string; team: Team; role: Role }>;
  session: OfflineSession | OnlineSession;
}

function createGame(options: CreateGameOptions): void {
  if (game) {
    game.dispose();
    game = null;
  }
  showingMenu = false;
  $("menu").classList.add("hidden");
  $("game").classList.remove("hidden");
  $("confirm").classList.add("hidden");
  $("end-screen").classList.add("hidden");
  $("end-screen").classList.remove("visible");
  const loading = $("game-loading");
  loading.classList.remove("is-done", "hidden");

  const canvas = $<HTMLCanvasElement>("game-canvas");
  game = new Game({
    canvas,
    balance: options.balance,
    map: options.map,
    team: options.team,
    role: options.role,
    mode: options.mode,
    playerName: options.name,
    players: options.players,
    session: options.session,
    onExit: () => exitToMenu(true),
    onRestart: restartOffline,
  });

  requestAnimationFrame(() => {
    setTimeout(() => loading.classList.add("is-done"), 120);
  });

  if (new URLSearchParams(location.search).has("debug")) {
    (window as unknown as { __osada?: Game | null }).__osada = game;
  }

  game.toast(options.mode === "online" ? "Матч начался" : "Против бота", "ok");
}

function exitToMenu(closeConnection: boolean): void {
  if (game) {
    game.dispose();
    game = null;
    (window as unknown as { __osada?: Game | null }).__osada = null;
  }
  if (closeConnection && online.inMatch) {
    online.inMatch = false;
    disconnectNet();
    $("lobby").classList.add("hidden");
    $("btn-resume").classList.toggle("hidden", !online.token);
  }
  showingMenu = true;
  $("game").classList.add("hidden");
  $("menu").classList.remove("hidden");
  $("end-screen").classList.add("hidden");
  $("end-screen").classList.remove("visible");
}

/* --------------------------------------------------------------- утилиты */

function escape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
