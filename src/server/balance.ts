import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Balance } from "../shared/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));

const CANDIDATES = [
  path.resolve(process.cwd(), "public/data/balance.json"),
  path.resolve(process.cwd(), "dist/public/data/balance.json"),
  path.resolve(here, "../../public/data/balance.json"),
  path.resolve(here, "../../../public/data/balance.json"),
];

export function loadBalance(): Balance {
  for (const candidate of CANDIDATES) {
    if (!fs.existsSync(candidate)) continue;
    const raw = fs.readFileSync(candidate, "utf8");
    const parsed = JSON.parse(raw) as Balance;
    if (!parsed.units || !parsed.buildings || !parsed.match) {
      throw new Error(`Некорректный файл баланса: ${candidate}`);
    }
    return parsed;
  }
  throw new Error(`Не найден balance.json. Искали: ${CANDIDATES.join(", ")}`);
}

export function findPublicDir(): string {
  const candidates = [
    path.resolve(process.cwd(), "dist/public"),
    path.resolve(here, "../../dist/public"),
    path.resolve(here, "../../public"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "index.html"))) return candidate;
  }
  return candidates[0]!;
}
