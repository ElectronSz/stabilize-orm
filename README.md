# Stabilize ORM

_Stable, Fast, and Expressive ORM for Bun_

---

**Stabilize** is a lightweight, retry-aware ORM built on Bun’s native SQL API. It provides a unified interface for SQLite, MySQL, and PostgreSQL with connection pooling, automatic retries, transactions, savepoints, and robust logging. Designed for simplicity, performance, and reliability in Bun applications.

---

## 🚀 Features

- **Unified API**: Supports SQLite, MySQL, and PostgreSQL
- **Retry Logic**: Automatic exponential backoff for queries & transactions
- **Connection Management**: Pooling, connection switching, live metrics
- **Transactions & Savepoints**: Built-in support with retry handling
- **Prepared Statements**: Cached for SQLite to maximize performance
- **Pluggable Logging**: Default ConsoleLogger, extensible for files or services
- **Custom Errors**: `StabilizeError` with clear, database-specific codes
- **CLI Tool**: Migrate, seed, and query from the command line
- **Model & Repository Pattern**: Clean, scalable code with decorators
- **Relationships & Joins**: Model relationships and flexible SQL joins

---

## 📦 Installation

Stabilize requires Bun (v1.0+).

```bash
bun add stabilize-orm
```

---

## 📃 Documentation & Community

- [Changelog](./CHANGELOG.md)
- [License](./LICENSE.md)
- [Code of Conduct](./CODE_OF_CONDUCT.md)
- [Contributing Guide](./CONTRIBUTING.md)
- [Security Policy](./SECURITY.md)
- [Support](./SUPPORT.md)
- [Funding](./FUNDING.md)

---

## ⚙️ ORM Configuration

```typescript
// config/database.ts
import { DBType, Stabilize, type CacheConfig, type DBConfig } from "stabilize-orm";

export const dbConfig: DBConfig = {
  type: DBType.Postgres, // or DBType.SQLite, DBType.MySQL
  connectionString: process.env.DB_CONNECTION_STRING || "postgres://admin:P@ssw0rd@localhost:5432/db",
  poolSize: Number(process.env.DB_POOL_SIZE) || 10,
  retryAttempts: Number(process.env.DB_RETRY_ATTEMPTS) || 3,
  retryDelay: Number(process.env.DB_RETRY_DELAY) || 1000,
  maxJitter: Number(process.env.DB_MAX_JITTER) || 100,
};

export const cacheConfig: CacheConfig = {
  enabled: process.env.CACHE_ENABLED === "true",
  ttl: Number(process.env.CACHE_TTL) || 60,
  redisUrl: process.env.REDIS_URL || "redis://localhost:6379",
};

export const orm = new Stabilize(dbConfig, cacheConfig);
```

---

## 🏗️ Models, Relationships & Repositories

Define models with decorators, express relationships, and interact using repositories:

```typescript
// models/User.ts
import "reflect-metadata";
import { Model, Column, Required } from "stabilize-orm";

@Model("users")
export class User {
  @Column("id", "TEXT") @Required()
  id: string = crypto.randomUUID();

  @Column("name", "TEXT") @Required()
  name?: string;

  @Column("email", "TEXT") @Required()
  email?: string;

  @Column("active", "BOOLEAN") @Required()
  active?: boolean;
}
```

```typescript
// models/Role.ts
import "reflect-metadata";
import { Model, Column, Required } from "stabilize-orm";

@Model("roles")
export class Role {
  @Column("id", "TEXT") @Required()
  id: string = crypto.randomUUID();

  @Column("name", "TEXT") @Required()
  name?: string;
}
```

```typescript
// models/UserRole.ts
import "reflect-metadata";
import { Model, Column, Required, ManyToOne } from "stabilize-orm";
import { User } from "./User";
import { Role } from "./Role";

@Model("userroles")
export class UserRole {
  @Column("id", "TEXT") @Required()
  id: string = crypto.randomUUID();

  @Column("user_id", "TEXT") @Required()
  user_id!: string;

  @Column("role_id", "TEXT") @Required()
  role_id!: string;

  // Relationships
  @ManyToOne(() => User, "user_id")
  user?: User;

  @ManyToOne(() => Role, "role_id")
  role?: Role;
}
```

```typescript
// repository/userRepository.ts
import { orm } from "../config/database";
import { User } from "../models/User";
export const userRepository = orm.getRepository(User);
```

---

## 🔀 Table Joins & Relationships

Stabilize ORM supports relationships and flexible SQL joins to help you write advanced queries.

**Relationship Decorators Example:**

```typescript
@Model("user_roles")
export class UserRole {
  // ...columns...
  @ManyToOne(() => User, "user_id")
  user?: User;
  @ManyToOne(() => Role, "role_id")
  role?: Role;
}
```

**Join Example:**

```typescript
const adminUsers = await orm.getRepository(UserRole)
  .find()
  .join("users", "user_roles.user_id = users.id")
  .join("roles", "use_rroles.role_id = roles.id")
  .select("users.id", "users.name", "roles.name AS role")
  .where("roles.name = ?", "Admin")
  .orderBy("users.name ASC")
  .execute(orm["client"]);
```
- Use `.join(table, condition)` to add joins, then combine with `.select`, `.where`, `.orderBy`, etc.

---

## 🧑‍💻 Query Builder

The repository `.find()` method returns a chainable query builder:

```typescript
const qb = userRepository.find()
  .where("active = ?", true)
  .orderBy("created_at DESC")
  .limit(10)
  .offset(20)
  .select("id", "name", "email");

const { query, params } = qb.build();
console.log(query, params);

const users = await qb.execute(orm["client"]);
```

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

---

## 📚 More Usage Examples

```typescript
// Get all users
export const getAll = async () => userRepository.find().execute(orm["client"]);

// Get active users, ordered by name
export const getActiveUsers = async () =>
  userRepository.find().where("active = ?", true).orderBy("name ASC").execute(orm["client"]);

// Paginated query
export const getPaginatedUsers = async (limit: number, offset: number) =>
  userRepository.find().orderBy("created_at DESC").limit(limit).offset(offset).execute(orm["client"]);
```

---

## 🌐 ExpressJS Integration

```typescript
import express from "express";
import { userRepository } from "./repository/userRepository";
import { orm } from "./config/database";

const app = express();
app.use(express.json());

app.get("/users", async (req, res) => {
  try {
    const users = await userRepository.find().execute(orm["client"]);
    res.json(users);
  } catch {
    res.status(500).json({ error: "Failed to fetch users." });
  }
});

app.get("/users/active", async (req, res) => {
  try {
    const users = await userRepository.find()
      .where("active = ?", true)
      .orderBy("name ASC")
      .execute(orm["client"]);
    res.json(users);
  } catch {
    res.status(500).json({ error: "Failed to fetch active users." });
  }
});

app.post("/users", async (req, res) => {
  try {
    const user = await userRepository.create(req.body);
    res.status(201).json(user);
  } catch {
    res.status(500).json({ error: "User creation failed." });
  }
});

app.listen(3000, () => {
  console.log("Express server listening on port 3000");
});
```

---


## 📑 License

See [LICENSE.md](./LICENSE.md)

---

<div align="center">

Created with ❤️ in Eswatini by ElectronSz

</div>