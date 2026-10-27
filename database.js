import { AsyncLocalStorage } from "node:async_hooks";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createClient } from "@libsql/client/web";

// Per-transaction context keeps each libSQL statement on the same remote session.
// The local mutex prevents overlapping requests from sharing a SQLite transaction.
export function openDatabase({
  dbPath,
  url,
  authToken,
  client: suppliedClient,
} = {}) {
  let local,
    client = suppliedClient;
  if (url && !client) {
    const parsed = new URL(url);
    if (
      !["https:", "libsql:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.port ||
      parsed.search ||
      parsed.hash ||
      !["", "/"].includes(parsed.pathname)
    )
      throw new Error(
        "Use a secure Turso database URL without credentials or URL parameters.",
      );
    if (!authToken)
      throw new Error("TURSO_AUTH_TOKEN is required with TURSO_DATABASE_URL.");
    // Use HTTPS for serverless requests instead of a persistent WebSocket.
    client = createClient({
      url: `https://${parsed.hostname}`,
      authToken,
      intMode: "number",
    });
  }
  if (!client) {
    if (dbPath !== ":memory:")
      mkdirSync(dirname(resolve(dbPath)), { recursive: true });
    local = new DatabaseSync(dbPath);
    local.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;");
  }
  const context = new AsyncLocalStorage();
  let queue = Promise.resolve();
  const exclusive = async (fn) => {
    const previous = queue;
    let release;
    queue = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  };
  const operation = (fn) =>
    context.getStore() || client ? fn() : exclusive(fn);
  return {
    async exec(sql) {
      return operation(() =>
        local
          ? local.exec(sql)
          : (context.getStore() || client).executeMultiple(sql),
      );
    },
    prepare(sql) {
      const execute = async (mode, args) =>
        operation(async () => {
          if (local) return local.prepare(sql)[mode](...args);
          const result = await (context.getStore() || client).execute({
            sql,
            args,
          });
          if (mode === "all") return result.rows;
          if (mode === "get") return result.rows[0];
          return {
            lastInsertRowid: result.lastInsertRowid,
            changes: result.rowsAffected,
          };
        });
      return {
        all: (...args) => execute("all", args),
        get: (...args) => execute("get", args),
        run: (...args) => execute("run", args),
      };
    },
    async batch(statements) {
      if (client) return client.batch(statements, "write");
      return this.transaction(async () =>
        statements.map(({ sql, args = [] }) => {
          const result = local.prepare(sql).run(...args);
          return { rowsAffected: result.changes };
        }),
      );
    },
    async transaction(fn) {
      if (context.getStore()) return fn();
      return exclusive(async () => {
        if (local) {
          local.exec("BEGIN IMMEDIATE");
          try {
            const result = await context.run(true, fn);
            local.exec("COMMIT");
            return result;
          } catch (error) {
            local.exec("ROLLBACK");
            throw error;
          }
        }
        const tx = await client.transaction("write");
        try {
          const result = await context.run(tx, fn);
          await tx.commit();
          return result;
        } catch (error) {
          try {
            await tx.rollback();
          } catch {}
          throw error;
        } finally {
          tx.close();
        }
      });
    },
    close() {
      if (local) local.close();
      else client.close();
    },
  };
}
