import { createGameServer } from "./app.js";
import { findPublicDir, loadBalance } from "./balance.js";

const balance = loadBalance();
const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? "0.0.0.0";
const publicDir = findPublicDir();
const game = createGameServer(balance, publicDir);

game.server.listen(port, host, () => {
  console.log(`Осада: сервер слушает http://${host}:${port}`);
  console.log(`Статика: ${publicDir}`);
  console.log(`Health: http://${host}:${port}/api/health`);
});

game.server.on("error", (error) => {
  console.error("Ошибка HTTP-сервера:", error);
  process.exitCode = 1;
});

const shutdown = async (signal: string): Promise<void> => {
  console.log(`Получен ${signal}, останавливаем сервер`);
  try {
    await game.close();
  } finally {
    process.exit(0);
  }
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
