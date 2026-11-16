import type { Balance, Command, GameMap, Role, Snapshot, Team } from "./types.js";

export type RequestedRole = Role | "random";

export interface LobbyPlayer {
  name: string;
  role: Role;
  team: Team;
  connected: boolean;
}

export type ClientMessage =
  | {
      t: "join";
      room?: string;
      name?: string;
      role?: RequestedRole;
      token?: string;
    }
  | { t: "cmd"; cmd: Command }
  | { t: "chat"; text: string }
  | { t: "ping"; at: number }
  | { t: "leave" };

export type ServerMessage =
  | { t: "welcome"; version: string }
  | {
      t: "joined";
      code: string;
      team: Team;
      role: Role;
      token: string;
      name: string;
      players: LobbyPlayer[];
    }
  | { t: "lobby"; code: string; players: LobbyPlayer[]; countdown: number | null }
  | { t: "countdown"; seconds: number }
  | {
      t: "start";
      code: string;
      team: Team;
      role: Role;
      balance: Balance;
      map: GameMap;
      players: Array<{ name: string; team: Team; role: Role }>;
      reconnect: boolean;
    }
  | { t: "snapshot"; snap: Snapshot }
  | { t: "chat"; from: string; team: Team; text: string }
  | { t: "pong"; at: number }
  | { t: "opponentStatus"; connected: boolean; graceSeconds: number }
  | { t: "end"; winner: Team | null; reason: string }
  | { t: "error"; message: string }
  | { t: "notice"; text: string };

export const PROTOCOL_VERSION = 1;
