# Stabilize ORM

Stabilize is a lightweight, retry-aware ORM built on Bun's native SQL API. It provides a unified interface for SQLite, MySQL, and PostgreSQL with features like connection pooling, automatic retries, transactions, savepoints, and logging. It's designed for simplicity, performance, and stability in Bun applications.

## Features

- **Unified API**: Works seamlessly with SQLite, MySQL, and PostgreSQL via Bun SQL.
- **Retry Logic**: Automatic exponential backoff retries for queries and transactions.
- **Connection Management**: Pooling, switching connections, and metrics.
- **Transactions & Savepoints**: Built-in support with retry handling.
- **Prepared Statements**: Cached for SQLite to improve performance.
- **Logging**: Pluggable logger (default: ConsoleLogger).
- **Error Handling**: Custom `StabilizeError` with database-specific codes.
- **CLI**: Simple command-line tool for database operations (e.g., migrations, queries).

## Installation

Stabilize requires Bun (v1.0+).

```bash
# Install via bun 
bun add stabilize-orm
```
## Usage

```bash 
# Imports
import { DBClient } from 'stabilize-orm/src/client';
import { DBConfig } from 'stabilize-orm/src/types';

const config: DBConfig = {
  type: 'sqlite', // or 'mysql', 'postgres'
  connectionString: 'myapp.db',
  poolSize: 10,
  retryAttempts: 3,
};

const db = new DBClient(config);

async function run() {
  const users = await db.query<{ id: number; name: string }>('SELECT * FROM users');
  console.log(users);

  await db.transaction(async () => {
    await db.query('INSERT INTO users (name) VALUES (?)', ['Alice']);
  });

  await db.close();
}

run();
```