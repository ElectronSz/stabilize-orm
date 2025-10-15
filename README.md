# Stabilize ORM

_A Modern, Type-Safe, and Expressive ORM for Bun, Node.js, and Deno_

---

**Stabilize** is a lightweight, feature-rich ORM designed for performance and developer experience. It provides a unified, database-agnostic API for **PostgreSQL**, **MySQL**, and **SQLite**, powered by a robust query builder, an elegant decorator-based model system, and a full-featured command-line interface.

---

## 🚀 Features

-   **Unified API**: Write once, run against PostgreSQL, MySQL, or SQLite.
-   **Type-Safe Decorators**: Define models and columns with the powerful `DataTypes` enum for true database-agnostic schemas.
-   **Full-Featured CLI**: Generate models, manage migrations, seed data, and reset your database from the command line.
-   **Automatic Migrations**: Generate database-specific SQL schemas directly from your model definitions.
-   **Retry Logic**: Automatic exponential backoff for database queries to handle transient connection issues.
-   **Connection Pooling**: Efficient connection management for PostgreSQL and MySQL out of the box.
-   **Transactional Integrity**: Built-in support for atomic transactions with automatic rollback on failure.
-   **Advanced Query Builder**: A fluent, chainable API for building complex queries with joins, where clauses, ordering, and pagination.
-   **Model Relationships**: Define `OneToOne`, `ManyToOne`, `OneToMany`, and `ManyToMany` relationships with simple decorators.
-   **Pluggable Logging**: Includes a robust `ConsoleLogger` with support for file-based, rotating logs.
-   **Custom Errors**: `StabilizeError` provides clear, consistent error handling.
-   **Caching Layer**: Optional Redis-backed caching with `cache-aside` and `write-through` strategies.

---

## 📦 Installation

Stabilize ORM requires a modern JavaScript runtime (Bun v1.0+, Node.js v18+, Deno v1.28+).

```bash
# Using Bun
bun add stabilize-orm reflect-metadata

# Using npm
npm install stabilize-orm reflect-metadata
```

---

## 📃 Documentation & Community

-   [Changelog](./CHANGELOG.md)
-   [License](./LICENSE.md)
-   [Code of Conduct](./CODE_OF_CONDUCT.md)
-   [Contributing Guide](./CONTRIBUTING.md)
-   [Security Policy](./SECURITY.md)
-   [Support](./SUPPORT.md)
-   [Funding](./FUNDING.md)

---

## ⚙️ Configuration

First, create a database configuration file.

```typescript
// config/database.ts
import { DBType, type DBConfig } from "stabilize-orm";

const dbConfig: DBConfig = {
  // Choose your database type
  type: DBType.Postgres, 
  
  // Connection string for your database
  connectionString: process.env.DATABASE_URL || "postgres://user:password@localhost:5432/mydb",

  // Optional: Connection retry settings
  retryAttempts: 3,
  retryDelay: 1000,
};

export default dbConfig;
```

Next, create a central ORM instance that your application can use. Remember to import `reflect-metadata` once at your application's entry point.

```typescript
// db.ts
import 'reflect-metadata'; // declared first
import { Stabilize, type CacheConfig, type LoggerConfig, LogLevel } from "stabilize-orm";
import dbConfig from "./database";

const cacheConfig: CacheConfig = {
  enabled: process.env.CACHE_ENABLED === "true",
  redisUrl: process.env.REDIS_URL,
  ttl: 60, // Default TTL in seconds
};

const loggerConfig: LoggerConfig = {
    level: LogLevel.Info,
    // Optional: Configure file logging
    filePath: 'logs/stabilize.log',
    maxFileSize: 5 * 1024 * 1024, // 5MB
    maxFiles: 3,
}

// Create and export the ORM instance
export const orm = new Stabilize(dbConfig, cacheConfig, loggerConfig);
```

---

## 🏗️ Models & Relationships

Define your database tables as classes using decorators. The new `@Column` decorator uses the `DataTypes` enum for a truly database-agnostic schema definition.

### Example: Users and Roles (Many-to-Many)

Here's how to model a many-to-many relationship between `User` and `Role` through a `UserRole` join table.

```typescript
// models/User.ts
import 'reflect-metadata';
import { Model, Column, DataTypes, Required, Unique, OneToMany } from 'stabilize-orm';
import { UserRole } from './UserRole';

@Model('users')
export class User {
  @Column({ type: DataTypes.INTEGER, name: 'id' })
  id!: number;

  @Column({ type: DataTypes.STRING, length: 100 })
  @Required() @Unique()
  email!: string;
  
  // This side of the relationship is for querying convenience
  @OneToMany(() => UserRole, 'user')
  roles?: UserRole[];
}
```

```typescript
// models/Role.ts
import 'reflect-metadata';
import { Model, Column, DataTypes, Required, Unique } from 'stabilize-orm';

@Model('roles')
export class Role {
  @Column({ type: DataTypes.INTEGER, name: 'id' })
  id!: number;

  @Column({ type: DataTypes.STRING, length: 50 })
  @Required() @Unique()
  name!: string;
}
```

```typescript
// models/UserRole.ts
import 'reflect-metadata';
import { Model, Column, DataTypes, Required, ManyToOne, Index } from 'stabilize-orm';
import { User } from './User';
import { Role } from './Role';

@Model('user_roles') // The join table
export class UserRole {
  @Column({ type: DataTypes.INTEGER, name: 'id' })
  id!: number;

  @Column({ type: DataTypes.INTEGER, name: 'user_id' })
  @Required() @Index()
  userId!: number;

  @Column({ type: DataTypes.INTEGER, name: 'role_id' })
  @Required() @Index()
  roleId!: number;

  // Define the "many" sides of the relationship
  @ManyToOne(() => User, 'userId')
  user?: User;

  @ManyToOne(() => Role, 'roleId')
  role?: Role;
}
```

---

## 💻 Command-Line Interface (CLI)

Stabilize includes a powerful CLI for managing your development workflow.

### Generating Files

-   **Generate a model**:
    ```bash
    bun run stabilize-cli generate model Product
    ```

-   **Generate a migration from a model**:
    ```bash
    # Reads models/User.ts and creates a new migration file
    bun run stabilize-cli generate migration User
    ```

-   **Generate a seed file**:
    ```bash
    bun run stabilize-cli generate seed InitialRoles
    ```

### Database & Migration Management

-   **Run all pending migrations**:
    ```bash
    bun run stabilize-cli migrate
    ```

-   **Roll back the last migration**:
    ```bash
    bun run stabilize-cli migrate:rollback
    ```

-   **Run all pending seeds** (in dependency order):
    ```bash
    bun run stabilize-cli seed
    ```

-   **Check the status of all migrations and seeds**:
    ```bash
    bun run stabilize-cli status
    ```

-   **Reset the database (drop, migrate, seed)**:
    ```bash
    bun run stabilize-cli db:reset
    ```

---

## 🧑‍💻 Querying Data

### Basic CRUD with Repositories

Interact with your data using the `Repository` pattern.

```typescript
import { orm } from './db';
import { User } from 'models/User';

const userRepository = orm.getRepository(User);

// Create a new user
const newUser = await userRepository.create({ email: 'lwazicd@icloud.com' });

// Find a user by ID
const foundUser = await userRepository.findOne(newUser.id);

// Update a user
const updatedUser = await userRepository.update(newUser.id, { email: 'admin@offbytesecure.com' });

// Delete a user
await userRepository.delete(newUser.id);
```

### Advanced Queries with the Query Builder

For complex queries, use the fluent `find()` method, which returns a chainable `QueryBuilder`.

```typescript
const activeAdmins = await orm.getRepository(UserRole)
  .find() // Start a query on the user_roles table
  .join("users", "user_roles.user_id = users.id")
  .join("roles", "user_roles.role_id = roles.id")
  .select("users.id", "users.email", "roles.name as role_name")
  .where("roles.name = ?", "Admin")
  .orderBy("users.email ASC")
  .execute();

console.log(activeAdmins);
// [ { id: 1, email: 'lwazicd@icloud.com', role_name: 'Admin' } ]
```

The `execute()` method on a repository query does not require a client to be passed; it uses the repository's default client automatically.

---
**API:**

```typescript
{
  select(...fields: string[]): QueryBuilder<User>;
  where(condition: string, ...params: any[]): QueryBuilder<User>;
  join(table: string, condition: string): QueryBuilder<User>;
  orderBy(clause: string): QueryBuilder<User>;
  limit(limit: number): QueryBuilder<User>;
  offset(offset: number): QueryBuilder<User>;
  build(): { query: string; params: any[] };
  execute(client: DBClient, cache?: Cache, cacheKey?: string): Promise<User[]>;
}
```

## 🌐 Express.js Integration

Stabilize ORM works seamlessly with web frameworks like Express.

```typescript
// src/server.ts
import express from "express";
import { orm } from "./db";
import { User } from "./models/User";

const app = express();
app.use(express.json());

const userRepository = orm.getRepository(User);

// Get all users
app.get("/users", async (req, res) => {
  try {
    const users = await userRepository.find().execute();
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch users." });
  }
});

// Create a new user
app.post("/users", async (req, res) => {
  try {
    const user = await userRepository.create(req.body);
    res.status(201).json(user);
  } catch (err) {
    res.status(500).json({ error: "User creation failed." });
  }
});

app.listen(3000, () => {
  console.log("Server listening on port 3000");
});
```

---

## 📑 License

Licensed under the MIT License. See [LICENSE.md](./LICENSE.md) for details.

---

<div align="center">

Created with ❤️ by **ElectronSz**
<br/>
*File last updated: 2025-10-15 19:32:00 UTC*

</div>