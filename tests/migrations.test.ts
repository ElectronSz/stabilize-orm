import { describe, it, expect, vi, beforeEach } from 'vitest';
import { defineModel } from '../model';
import { generateMigration, runMigrations } from '../migrations';
import { DataTypes, DBType } from '../types';
import { DBClient } from '../client';

vi.mock('../client', () => {
  const query = vi.fn(async (sql: string, _params: any[] = []) => {
    if (sql.includes('SELECT id FROM stabilize_migrations')) {
      return [];
    }
    return [];
  });

  const close = vi.fn(async () => {});

  const transaction = vi.fn(async (callback: (txClient: { query: typeof query }) => Promise<void>) => {
    await callback({ query });
  });

  return {
    DBClient: vi.fn(() => ({
      query,
      close,
      transaction,
      config: { type: DBType.SQLite },
    })),
  };
});

describe('generateMigration', () => {
  it('should generate SQLite-specific primary key (AUTOINCREMENT)', async () => {
    const User = defineModel({
      tableName: 'users',
      columns: {
        id: { name: 'id', type: DataTypes.INTEGER },
        username: { name: 'user_name', type: DataTypes.STRING, required: true, unique: true },
      },
    });

    const migration = await generateMigration(User, 'create_users', DBType.SQLite);

    expect(migration.up[0]).toBe(
      'CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, user_name TEXT NOT NULL UNIQUE)'
    );
    expect(migration.name).toBe('create_users');
  });

  it('should generate PostgreSQL-specific primary key (SERIAL)', async () => {
    const Product = defineModel({
      tableName: 'products',
      columns: {
        id: { name: 'id', type: DataTypes.INTEGER },
        title: { name: 'title', type: DataTypes.STRING },
      },
    });

    const migration = await generateMigration(Product, 'create_products', DBType.Postgres);

    expect(migration.up[0]).toBe(
      'CREATE TABLE IF NOT EXISTS products (id SERIAL PRIMARY KEY, title TEXT)'
    );
  });

  it('should include history table for versioned models', async () => {
    const Order = defineModel({
      tableName: 'orders',
      versioned: true,
      columns: {
        id: { name: 'id', type: DataTypes.INTEGER },
        amount: { name: 'amount', type: DataTypes.DECIMAL },
      },
    });

    const migration = await generateMigration(Order, 'create_orders', DBType.SQLite);

    expect(migration.up).toHaveLength(2);
    expect(migration.up[1]).toContain('CREATE TABLE IF NOT EXISTS orders_history');
  });

  it('should throw an error if model tableName is missing', async () => {
    class UndecoratedModel {}

    await expect(generateMigration(UndecoratedModel, 'invalid', DBType.SQLite)).rejects.toThrow(
      'Model not defined with tableName'
    );
  });
});

describe('runMigrations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should create stabilize_migrations table and run UP scripts for new migrations', async () => {
    const migrations = [
      { name: 'create_test_table', up: ['CREATE TABLE test_table (id INT)'], down: ['DROP TABLE test_table'] },
    ];

    await runMigrations({ type: DBType.SQLite, connectionString: '' }, migrations);

    const mockClient = (DBClient as any).mock.results[0].value;

    expect(mockClient.query).toHaveBeenCalledWith(expect.stringContaining('CREATE TABLE IF NOT EXISTS stabilize_migrations'));
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining('SELECT id FROM stabilize_migrations WHERE name = ?'),
      ['create_test_table']
    );
    expect(mockClient.transaction).toHaveBeenCalled();
    expect(mockClient.query).toHaveBeenCalledWith('CREATE TABLE test_table (id INT)');
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO stabilize_migrations (name, applied_at) VALUES (?, ?)'),
      ['create_test_table', expect.any(String)]
    );
    expect(mockClient.close).toHaveBeenCalled();
  });
});
