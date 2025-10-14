import { describe, it, expect, vi } from 'vitest';
import { generateMigration, runMigrations } from '../migrations';
import { DBType } from '../types';
// We must mock the imports that provide the metadata keys and the client implementation
import { ModelKey, ColumnKey, ValidatorKey, SoftDeleteKey } from '../decorators';
import { DBClient } from '../client'; 

// --- MOCKING SETUP ---

// Mocking Reflect.getMetadata behavior to simulate data set by the @Model, @Column, etc. decorators
const mockMetadata = new Map();

// Helper to set mock data for tests
const setMockMetadata = (tableName: string, columns: any, validators: any, softDeleteField?: string) => {
  mockMetadata.set(ModelKey, tableName);
  mockMetadata.set(ColumnKey, columns);
  mockMetadata.set(ValidatorKey, validators);
  if (softDeleteField) {
    mockMetadata.set(SoftDeleteKey, softDeleteField);
  } else {
    mockMetadata.delete(SoftDeleteKey);
  }
};

// Spy on the global Reflect.getMetadata used by the functions to return our mock data
const getMetadataSpy = vi.spyOn(Reflect, 'getMetadata');
getMetadataSpy.mockImplementation((key, target) => mockMetadata.get(key));


// Mock Model Placeholder
class MockModel {} 

// Mock DBClient for runMigrations test: this prevents hitting a real database
vi.mock('./client', () => {
    const mockQuery = vi.fn(async (query: string) => {
        // Simulate no existing migration found when selecting from 'migrations'
        if (query.includes('SELECT id FROM migrations')) {
            return [];
        }
        return [];
    });
    return {
        DBClient: vi.fn(() => ({
            query: mockQuery,
            close: vi.fn(async () => {}),
            // Provide a mock config for runMigrations to safely access DBType
            config: {
                type: DBType.SQLite 
            }
        }))
    };
});

// --- TESTS START HERE ---

describe('generateMigration', () => {
  const commonColumns = {
    id: { name: 'id', type: 'INTEGER' },
    username: { name: 'user_name', type: 'TEXT' },
    createdAt: { name: 'created_at', type: 'TEXT' }
  };
  const commonValidators = {
    username: ['required', 'unique']
  };

  it('should generate SQLite-specific primary key (AUTOINCREMENT)', async () => {
    setMockMetadata('users', commonColumns, commonValidators);

    const migration = await generateMigration(MockModel, DBType.SQLite);

    expect(migration.up[0]).toBe(
      'CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, user_name TEXT NOT NULL UNIQUE, created_at TEXT)'
    );
  });

  it('should generate PostgreSQL-specific primary key (SERIAL)', async () => {
    setMockMetadata('products', commonColumns, commonValidators);

    const migration = await generateMigration(MockModel, DBType.Postgres);

    expect(migration.up[0]).toBe(
      'CREATE TABLE IF NOT EXISTS products (id SERIAL PRIMARY KEY, user_name TEXT NOT NULL UNIQUE, created_at TEXT)'
    );
  });

  it('should generate MySQL-specific primary key (AUTO_INCREMENT)', async () => {
    setMockMetadata('posts', commonColumns, commonValidators);

    const migration = await generateMigration(MockModel, DBType.MySQL);

    expect(migration.up[0]).toBe(
      'CREATE TABLE IF NOT EXISTS posts (id INTEGER PRIMARY KEY AUTO_INCREMENT, user_name TEXT NOT NULL UNIQUE, created_at TEXT)'
    );
  });

  it('should include soft delete field if present on the model', async () => {
    const softDeleteColumns = {
      ...commonColumns,
      deletedAt: { name: 'deleted_at', type: 'TEXT' }
    };
    setMockMetadata('orders', softDeleteColumns, commonValidators, 'deletedAt');

    const migration = await generateMigration(MockModel, DBType.SQLite);

    expect(migration.up[0]).toContain(', deleted_at TEXT)');
  });

  it('should throw an error if the model is missing the @Model decorator', async () => {
    mockMetadata.delete(ModelKey);
    await expect(generateMigration(MockModel, DBType.SQLite)).rejects.toThrow('Model not decorated with @Model');
  });
});

describe('runMigrations', () => {
    it('should create the migrations table and run the UP script for new migrations', async () => {
        const mockMigrations = [
            { up: ['CREATE TABLE test_table (id INT)'], down: ['DROP TABLE test_table'] }
        ];

        // Run migrations using the mocked DBClient (defaulted to SQLite type)
        await runMigrations({ type: DBType.SQLite,connectionString:"" }, mockMigrations);

        // Access the mock instance
        const mockClient = (DBClient as any).mock.results[0].value;
        
        // 1. Verify CREATE TABLE IF NOT EXISTS migrations was called
        expect(mockClient.query).toHaveBeenCalledWith(expect.stringContaining('CREATE TABLE IF NOT EXISTS migrations ('));
        
        // 2. Verify the actual UP query was executed
        expect(mockClient.query).toHaveBeenCalledWith('CREATE TABLE test_table (id INT)', []);

        // 3. Verify the migration log record was inserted
        expect(mockClient.query).toHaveBeenCalledWith(
            expect.stringContaining('INSERT INTO migrations (name, applied_at) VALUES (?, ?)'),
            expect.arrayContaining([expect.stringContaining('migration_0_'), expect.any(String)])
        );

        // 4. Verify the client was closed in the finally block
        expect(mockClient.close).toHaveBeenCalled();
    });
});
