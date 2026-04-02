import {
  Stabilize,
  defineModel,
  DataTypes,
  RelationType,
  DBType,
  LogLevel,
  type DBConfig,
  generateUUID,
} from "../index";

// ─── CONFIG ──────────────────────────────────────────────────────────

const dbConfig: DBConfig = {
  type: DBType.SQLite,
  connectionString: "./data/analytics.db",
};

const orm = new Stabilize(
  dbConfig,
  { enabled: false, ttl: 60 },
  { level: LogLevel.Info },
);

// ─── MODELS ──────────────────────────────────────────────────────────

const Event = defineModel({
  tableName: "events",
  timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" },
  columns: {
    id: { type: DataTypes.STRING, required: true, unique: true },
    name: { type: DataTypes.STRING, length: 100, required: true },
    category: { type: DataTypes.STRING, length: 50, required: true },
    userId: { type: DataTypes.STRING },
    sessionId: { type: DataTypes.STRING, length: 100 },
    metadata: { type: DataTypes.JSON },
    value: { type: DataTypes.FLOAT, defaultValue: 0 },
    timestamp: { type: DataTypes.DATETIME, required: true },
  },
  relations: [],
  scopes: {
    byName: (qb, name: string) => qb.where("name = ?", name),
    byCategory: (qb, category: string) => qb.where("category = ?", category),
    today: (qb) =>
      qb.where("timestamp >= ?", new Date().toISOString().split("T")[0]),
    thisWeek: (qb) => {
      const weekAgo = new Date(
        Date.now() - 7 * 24 * 60 * 60 * 1000,
      ).toISOString();
      return qb.where("timestamp >= ?", weekAgo);
    },
  },
});

const Metric = defineModel({
  tableName: "metrics",
  timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" },
  columns: {
    id: { type: DataTypes.STRING, required: true, unique: true },
    name: { type: DataTypes.STRING, length: 100, required: true },
    value: { type: DataTypes.FLOAT, required: true },
    dimensions: { type: DataTypes.JSON },
    recordedAt: { type: DataTypes.DATETIME, required: true },
  },
  scopes: {
    latest: (qb) => qb.orderBy("recordedAt", "DESC").limit(1),
    byName: (qb, name: string) => qb.where("name = ?", name),
  },
});

// ─── MAIN ────────────────────────────────────────────────────────────

async function main() {
  await orm.client.migrationQuery(`CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL,
    userId TEXT, sessionId TEXT, metadata TEXT, value REAL DEFAULT 0,
    timestamp TEXT NOT NULL,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')), updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  await orm.client.migrationQuery(`CREATE TABLE IF NOT EXISTS metrics (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, value REAL NOT NULL,
    dimensions TEXT, recordedAt TEXT NOT NULL,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')), updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  console.log("Tables created.");

  const eventRepo = orm.getRepository(Event);
  const metricRepo = orm.getRepository(Metric);

  // ─── SEED EVENTS ──────────────────────────────────────────────

  const now = new Date();
  const events = [
    { name: "page_view", category: "engagement", value: 1 },
    { name: "page_view", category: "engagement", value: 1 },
    { name: "button_click", category: "engagement", value: 1 },
    { name: "purchase", category: "conversion", value: 49.99 },
    { name: "purchase", category: "conversion", value: 99.99 },
    { name: "signup", category: "acquisition", value: 1 },
    { name: "page_view", category: "engagement", value: 1 },
    { name: "purchase", category: "conversion", value: 29.99 },
    { name: "button_click", category: "engagement", value: 1 },
    { name: "signup", category: "acquisition", value: 1 },
  ];

  for (const evt of events) {
    await eventRepo.create({
      id: generateUUID(),
      ...evt,
      sessionId: `session_${Math.random().toString(36).slice(2, 10)}`,
      metadata: JSON.stringify({ source: "seed", version: 1 }),
      timestamp: new Date(
        now.getTime() - Math.random() * 7 * 24 * 60 * 60 * 1000,
      ).toISOString(),
    });
  }
  console.log(`Seeded ${events.length} events`);

  // ─── AGGREGATION QUERIES ──────────────────────────────────────

  // Total events
  const totalEvents = await eventRepo.count();
  console.log("Total events:", totalEvents);

  // Events by category
  const categoryCounts = await eventRepo
    .find()
    .select("category", "COUNT(*) as count", "SUM(value) as totalValue")
    .groupBy("category")
    .execute(orm.client);
  console.log("Events by category:");
  for (const row of categoryCounts) {
    console.log(
      `  ${(row as any).category}: ${(row as any).count} events, $${(row as any).totalValue}`,
    );
  }

  // Revenue stats
  const revenueStats = await eventRepo.aggregate({
    count: "*",
    sum: ["value"],
    avg: ["value"],
    min: ["value"],
    max: ["value"],
  });
  console.log("Revenue stats:", revenueStats);

  // Unique event names
  const uniqueNames = await eventRepo.countDistinct("name");
  console.log("Unique event types:", uniqueNames);

  // Event names list
  const eventNames = await eventRepo.pluck("name");
  console.log("All event names:", [...new Set(eventNames)]);

  // ─── FILTERED QUERIES ─────────────────────────────────────────

  // Purchase events only
  const purchases = await eventRepo
    .scope("byCategory", "conversion")
    .orderBy("timestamp", "DESC")
    .execute(orm.client);
  console.log("Purchases:", purchases.length);

  // Page views
  const pageViews = await eventRepo
    .scope("byName", "page_view")
    .execute(orm.client);
  console.log("Page views:", pageViews.length);

  // ─── RECORD METRICS ───────────────────────────────────────────

  for (const row of categoryCounts) {
    await metricRepo.create({
      id: generateUUID(),
      name: `${(row as any).category}_count`,
      value: (row as any).count,
      dimensions: JSON.stringify({ category: (row as any).category }),
      recordedAt: new Date().toISOString(),
    });
  }
  console.log("Recorded metrics");

  // Latest metrics
  const latestMetrics = await metricRepo
    .find()
    .orderBy("recordedAt", "DESC")
    .limit(5)
    .execute(orm.client);
  console.log("Latest metrics:", latestMetrics.length);

  // ─── HEALTH CHECK ─────────────────────────────────────────────

  const health = await orm.healthCheck();
  console.log("Health:", health);

  // ─── CLEANUP ──────────────────────────────────────────────────

  await orm.close();
  console.log("Done.");
}

main().catch(console.error);
