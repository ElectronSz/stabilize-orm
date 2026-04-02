import express from "express";
import {
  Stabilize,
  defineModel,
  DataTypes,
  RelationType,
  DBType,
  type DBConfig,
  generateUUID,
} from "../index";

// ─── CONFIG ──────────────────────────────────────────────────────────

const dbConfig: DBConfig = {
  type: DBType.SQLite,
  connectionString: "./data/rest-api.db",
};

const orm = new Stabilize(dbConfig);

// ─── MODELS ──────────────────────────────────────────────────────────

const Task = defineModel({
  tableName: "tasks",
  versioned: true,
  timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" },
  columns: {
    id: { type: DataTypes.STRING, required: true, unique: true },
    title: {
      type: DataTypes.STRING,
      length: 200,
      required: true,
      minLength: 3,
    },
    description: { type: DataTypes.TEXT },
    status: {
      type: DataTypes.STRING,
      length: 20,
      required: true,
      defaultValue: "todo",
    },
    priority: {
      type: DataTypes.STRING,
      length: 10,
      required: true,
      defaultValue: "medium",
    },
    dueDate: { type: DataTypes.DATETIME },
    assigneeId: { type: DataTypes.STRING },
    deletedAt: { type: DataTypes.DATETIME, softDelete: true },
    version: { type: DataTypes.INTEGER, optimisticLock: true },
  },
  relations: [
    {
      type: RelationType.ManyToOne,
      target: () => User,
      property: "assignee",
      foreignKey: "assigneeId",
    },
  ],
  scopes: {
    todo: (qb) => qb.where("status = ?", "todo"),
    inProgress: (qb) => qb.where("status = ?", "in_progress"),
    done: (qb) => qb.where("status = ?", "done"),
    highPriority: (qb) => qb.where("priority = ?", "high"),
    overdue: (qb) => qb.where("dueDate < ?", new Date().toISOString()),
  },
});

const User = defineModel({
  tableName: "users",
  timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" },
  columns: {
    id: { type: DataTypes.STRING, required: true, unique: true },
    email: {
      type: DataTypes.STRING,
      length: 255,
      required: true,
      unique: true,
    },
    name: { type: DataTypes.STRING, length: 100, required: true },
  },
  relations: [
    {
      type: RelationType.OneToMany,
      target: () => Task,
      property: "tasks",
      foreignKey: "assigneeId",
    },
  ],
});

// ─── APP ─────────────────────────────────────────────────────────────

async function startServer() {
  await orm.autoMigrate([User, Task]);
  console.log("Database migrated.");

  const app = express();
  app.use(express.json());

  const taskRepo = orm.getRepository(Task);
  const userRepo = orm.getRepository(User);

  // ─── USERS ENDPOINTS ────────────────────────────────────────────

  app.get("/api/users", async (req, res) => {
    try {
      const { page = "1", pageSize = "10" } = req.query;
      const result = await userRepo.paginate(Number(page), Number(pageSize));
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/users", async (req, res) => {
    try {
      const user = await userRepo.create({ id: generateUUID(), ...req.body });
      res.status(201).json(user);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.get("/api/users/:id", async (req, res) => {
    try {
      const user = await userRepo.findOne(req.params.id, {
        relations: ["tasks"],
      });
      if (!user) return res.status(404).json({ error: "Not found" });
      res.json(user);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/users/:id", async (req, res) => {
    try {
      await userRepo.delete(req.params.id);
      res.status(204).send();
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── TASKS ENDPOINTS ────────────────────────────────────────────

  app.get("/api/tasks", async (req, res) => {
    try {
      const {
        status,
        priority,
        assigneeId,
        page = "1",
        pageSize = "20",
        search,
      } = req.query;
      const qb = taskRepo.find();

      if (status) qb.where("status = ?", status);
      if (priority) qb.where("priority = ?", priority);
      if (assigneeId) qb.where("assigneeId = ?", assigneeId);
      if (search) qb.whereLike("title", `%${search}%`);

      qb.orderBy("createdAt", "DESC");

      const data = await qb
        .paginate(Number(page), Number(pageSize))
        .execute(orm.client);
      const total = await qb.clone().countExec(orm.client);

      res.json({ data, total, page: Number(page), pageSize: Number(pageSize) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/tasks", async (req, res) => {
    try {
      const task = await taskRepo.create({ id: generateUUID(), ...req.body });
      res.status(201).json(task);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.get("/api/tasks/:id", async (req, res) => {
    try {
      const task = await taskRepo.findOne(req.params.id, {
        relations: ["assignee"],
      });
      if (!task) return res.status(404).json({ error: "Not found" });
      res.json(task);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.patch("/api/tasks/:id", async (req, res) => {
    try {
      const task = await taskRepo.findOneBy({ id: req.params.id });
      if (!task) return res.status(404).json({ error: "Not found" });

      // Optimistic locking: pass version from client
      const version = req.body.version;
      if (version !== undefined) {
        const lockField = "version";
        try {
          const updated = await taskRepo.update(req.params.id, {
            ...req.body,
            [lockField]: version,
          });
          res.json(updated);
        } catch (err: any) {
          if (err.code === "CONCURRENT_MODIFICATION") {
            return res
              .status(409)
              .json({ error: "Conflict: record was modified by another user" });
          }
          throw err;
        }
      } else {
        const updated = await taskRepo.update(req.params.id, req.body);
        res.json(updated);
      }
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.delete("/api/tasks/:id", async (req, res) => {
    try {
      await taskRepo.delete(req.params.id);
      res.status(204).send();
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── BULK ENDPOINTS ─────────────────────────────────────────────

  app.post("/api/tasks/bulk", async (req, res) => {
    try {
      const tasks = req.body.map((t: any) => ({ id: generateUUID(), ...t }));
      const created = await taskRepo.bulkCreate(tasks);
      res.status(201).json(created);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post("/api/tasks/bulk-delete", async (req, res) => {
    try {
      const { ids } = req.body;
      await taskRepo.bulkDelete(ids);
      res.status(204).send();
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── STATS ENDPOINTS ────────────────────────────────────────────

  app.get("/api/stats", async (req, res) => {
    try {
      const stats = await taskRepo.aggregate({
        count: "*",
      });
      const byStatus = await taskRepo.rawQuery(
        "SELECT status, COUNT(*) as count FROM tasks WHERE deletedAt IS NULL GROUP BY status",
      );
      res.json({ total: stats.count_, byStatus });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── HEALTH ENDPOINT ────────────────────────────────────────────

  app.get("/api/health", async (req, res) => {
    try {
      const health = await orm.healthCheck();
      res.status(health.status === "healthy" ? 200 : 503).json(health);
    } catch (err: any) {
      res.status(503).json({ status: "unhealthy", error: err.message });
    }
  });

  // ─── START ──────────────────────────────────────────────────────

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/api/health`);
    console.log(`Tasks API: http://localhost:${PORT}/api/tasks`);
  });
}

startServer().catch(console.error);
