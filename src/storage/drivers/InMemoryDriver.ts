/**
 * @file     InMemoryDriver.ts
 * @module   storage/drivers
 *
 * Native expo-sqlite modülü yüklenemediğinde devreye giren
 * in-memory fallback driver. Veri kalıcı değil — uygulama
 * kapanınca sıfırlanır. Dev/test ortamı için tasarlanmıştır.
 */

import type {
  ExecuteResult,
  IDatabaseDriver,
  ITransaction,
  QueryResult,
} from '../Database';

// ─── Basit in-memory tablo deposu ────────────────────────────────────────────

type Row = Record<string, unknown>;
type Table = Row[];
type Store = Record<string, Table>;

const globalStore: Store = {};

function getTable(store: Store, name: string): Table {
  if (!store[name]) store[name] = [];
  return store[name];
}

// ─── InMemoryTransaction ─────────────────────────────────────────────────────

class InMemoryTransaction implements ITransaction {
  constructor(private readonly store: Store) {}

  async query<T>(sql: string, _params: readonly unknown[]): Promise<QueryResult<T>> {
    return { rows: [], rowsAffected: 0, lastInsertId: null };
  }

  async queryOne<T>(sql: string, _params: readonly unknown[]): Promise<T | null> {
    return null;
  }

  async execute(sql: string, _params: readonly unknown[] = []): Promise<ExecuteResult> {
    return { rowsAffected: 0, lastInsertId: null };
  }
}

// ─── InMemoryDriver ──────────────────────────────────────────────────────────

export class InMemoryDriver implements IDatabaseDriver {
  private readonly store: Store = globalStore;
  private _connected = false;

  async query<T>(sql: string, _params: readonly unknown[]): Promise<QueryResult<T>> {
    return { rows: [], rowsAffected: 0, lastInsertId: null };
  }

  async queryOne<T>(sql: string, _params: readonly unknown[]): Promise<T | null> {
    return null;
  }

  async execute(sql: string, _params: readonly unknown[] = []): Promise<ExecuteResult> {
    // DDL'leri sessizce kabul et (CREATE TABLE vs.)
    return { rowsAffected: 0, lastInsertId: null };
  }

  async transaction<T>(fn: (tx: ITransaction) => Promise<T>): Promise<T> {
    const tx = new InMemoryTransaction(this.store);
    return fn(tx);
  }

  isConnected(): boolean {
    return this._connected;
  }

  async close(): Promise<void> {
    this._connected = false;
  }

  async connect(): Promise<void> {
    this._connected = true;
  }
}
