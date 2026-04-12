import path from "node:path";
import fs from "node:fs";
import sqlite3 from "sqlite3";
import { open, type Database } from "sqlite";

import { env } from "../config/env";

export type AppDatabase = Database<sqlite3.Database, sqlite3.Statement>;

export async function createDatabaseConnection(): Promise<AppDatabase> {
  const resolvedPath = path.resolve(env.DATABASE_PATH);
  const parentDir = path.dirname(resolvedPath);

  if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true });
  }

  const db = await open({
    filename: resolvedPath,
    driver: sqlite3.Database
  });

  await db.exec("PRAGMA journal_mode = WAL;");
  await db.exec("PRAGMA foreign_keys = ON;");
  await db.exec("PRAGMA busy_timeout = 5000;");

  return db;
}
