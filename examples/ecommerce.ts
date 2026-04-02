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
  connectionString: "./data/ecommerce.db",
};

const orm = new Stabilize(
  dbConfig,
  { enabled: false, ttl: 60 },
  { level: LogLevel.Info },
);

// ─── MODELS ──────────────────────────────────────────────────────────

const Product = defineModel({
  tableName: "products",
  timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" },
  columns: {
    id: { type: DataTypes.STRING, required: true, unique: true },
    name: { type: DataTypes.STRING, length: 200, required: true },
    slug: { type: DataTypes.STRING, length: 200, required: true, unique: true },
    price: { type: DataTypes.DECIMAL, required: true },
    stock: { type: DataTypes.INTEGER, required: true, defaultValue: 0 },
    categoryId: { type: DataTypes.STRING, required: true },
    isActive: { type: DataTypes.BOOLEAN, defaultValue: true },
    deletedAt: { type: DataTypes.DATETIME, softDelete: true },
    version: { type: DataTypes.INTEGER, optimisticLock: true },
  },
  relations: [
    {
      type: RelationType.ManyToOne,
      target: () => Category,
      property: "category",
      foreignKey: "categoryId",
    },
    {
      type: RelationType.OneToMany,
      target: () => OrderItem,
      property: "orderItems",
      foreignKey: "productId",
    },
  ],
  scopes: {
    inStock: (qb) => qb.where("stock > ?", 0),
    active: (qb) => qb.where("isActive = ?", true),
    cheap: (qb, maxPrice: number) => qb.where("price <= ?", maxPrice),
  },
});

const Category = defineModel({
  tableName: "categories",
  timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" },
  columns: {
    id: { type: DataTypes.STRING, required: true, unique: true },
    name: { type: DataTypes.STRING, length: 100, required: true, unique: true },
    slug: { type: DataTypes.STRING, length: 100, required: true, unique: true },
  },
  relations: [
    {
      type: RelationType.OneToMany,
      target: () => Product,
      property: "products",
      foreignKey: "categoryId",
    },
  ],
});

const Customer = defineModel({
  tableName: "customers",
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
    phone: { type: DataTypes.STRING, length: 20 },
    deletedAt: { type: DataTypes.DATETIME, softDelete: true },
  },
  relations: [
    {
      type: RelationType.OneToMany,
      target: () => Order,
      property: "orders",
      foreignKey: "customerId",
    },
  ],
});

const Order = defineModel({
  tableName: "orders",
  timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" },
  columns: {
    id: { type: DataTypes.STRING, required: true, unique: true },
    customerId: { type: DataTypes.STRING, required: true },
    status: {
      type: DataTypes.STRING,
      length: 20,
      required: true,
      defaultValue: "pending",
    },
    totalAmount: { type: DataTypes.DECIMAL, required: true, defaultValue: 0 },
    version: { type: DataTypes.INTEGER, optimisticLock: true },
  },
  relations: [
    {
      type: RelationType.ManyToOne,
      target: () => Customer,
      property: "customer",
      foreignKey: "customerId",
    },
    {
      type: RelationType.OneToMany,
      target: () => OrderItem,
      property: "items",
      foreignKey: "orderId",
    },
  ],
  scopes: {
    pending: (qb) => qb.where("status = ?", "pending"),
    completed: (qb) => qb.where("status = ?", "completed"),
  },
});

const OrderItem = defineModel({
  tableName: "order_items",
  timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" },
  columns: {
    id: { type: DataTypes.STRING, required: true, unique: true },
    orderId: { type: DataTypes.STRING, required: true },
    productId: { type: DataTypes.STRING, required: true },
    quantity: { type: DataTypes.INTEGER, required: true },
    unitPrice: { type: DataTypes.DECIMAL, required: true },
  },
  relations: [
    {
      type: RelationType.ManyToOne,
      target: () => Order,
      property: "order",
      foreignKey: "orderId",
    },
    {
      type: RelationType.ManyToOne,
      target: () => Product,
      property: "product",
      foreignKey: "productId",
    },
  ],
});

// ─── SEED ────────────────────────────────────────────────────────────

// ─── MAIN ────────────────────────────────────────────────────────────

async function main() {
  await orm.client.migrationQuery(`CREATE TABLE IF NOT EXISTS categories (
    id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, slug TEXT NOT NULL UNIQUE,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')), updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  await orm.client.migrationQuery(`CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
    price REAL NOT NULL, stock INTEGER NOT NULL DEFAULT 0,
    categoryId TEXT NOT NULL, isActive INTEGER DEFAULT 1, deletedAt TEXT, version INTEGER DEFAULT 1,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')), updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  await orm.client.migrationQuery(`CREATE TABLE IF NOT EXISTS customers (
    id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
    phone TEXT, deletedAt TEXT,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')), updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  await orm.client.migrationQuery(`CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY, customerId TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', totalAmount REAL NOT NULL DEFAULT 0,
    version INTEGER DEFAULT 1,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')), updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  await orm.client.migrationQuery(`CREATE TABLE IF NOT EXISTS order_items (
    id TEXT PRIMARY KEY, orderId TEXT NOT NULL, productId TEXT NOT NULL,
    quantity INTEGER NOT NULL, unitPrice REAL NOT NULL,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')), updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  console.log("Tables created.");

  const catRepo = orm.getRepository(Category);
  const productRepo = orm.getRepository(Product);
  const customerRepo = orm.getRepository(Customer);
  const orderRepo = orm.getRepository(Order);
  const orderItemRepo = orm.getRepository(OrderItem);

  // Seed categories
  const existingCats = await catRepo.find().execute(orm.client);
  let electronicsId: string;
  if (existingCats.length === 0) {
    const electronics = await catRepo.create({
      id: generateUUID(),
      name: "Electronics",
      slug: "electronics",
    });
    const books = await catRepo.create({
      id: generateUUID(),
      name: "Books",
      slug: "books",
    });
    electronicsId = electronics.id;
    console.log("Seeded categories.");
  } else {
    electronicsId = existingCats[0]!.id;
  }

  // Create products
  const laptop = await productRepo.create({
    id: generateUUID(),
    name: "MacBook Pro 16",
    slug: "macbook-pro-16",
    price: 2499.99,
    stock: 50,
    categoryId: electronicsId,
  });

  const phone = await productRepo.create({
    id: generateUUID(),
    name: "iPhone 16 Pro",
    slug: "iphone-16-pro",
    price: 1199.99,
    stock: 200,
    categoryId: electronicsId,
  });

  console.log("Created products:", laptop.name, phone.name);

  // Search with LIKE
  const searchResults = await productRepo
    .find()
    .where('"name" LIKE ?', "%Mac%")
    .execute(orm.client);
  console.log(
    "Search results:",
    searchResults.map((p: any) => p.name),
  );

  // Scope: in stock
  const inStock = await productRepo
    .scope("inStock")
    .scope("active")
    .orderBy("price", "DESC")
    .execute(orm.client);
  console.log("In stock products:", inStock.length);

  // Scope: cheap products
  const cheap = await productRepo.scope("cheap", 1500).execute(orm.client);
  console.log(
    "Cheap products:",
    cheap.map((p: any) => p.name),
  );

  // Aggregate
  const productStats = await productRepo.aggregate({
    count: "*",
    avg: ["price"],
    min: ["price"],
    max: ["price"],
    sum: ["stock"],
  });
  console.log("Product stats:", productStats);

  // Pluck
  const productNames = await productRepo.pluck("name");
  console.log("Product names:", productNames);

  // Decrement stock
  await productRepo.decrement(laptop.id, "stock", 5);
  console.log("Decremented laptop stock by 5");

  // Toggle active
  await productRepo.toggle(phone.id, "isActive");
  console.log("Toggled phone active status");

  // Create customer
  const customer = await customerRepo.create({
    id: generateUUID(),
    email: "lwazicd@icloud.com",
    name: "Lwazi Dlamini",
    phone: "+268 1234 5678",
  });

  // ─── ORDER CREATION (transaction) ────────────────────────────────

  const orderResult = await orm.transaction(async (txClient) => {
    const order = await orderRepo.create(
      {
        id: generateUUID(),
        customerId: customer.id,
        status: "pending",
        totalAmount: 0,
      },
      {},
    );

    const item1 = await orderItemRepo.create(
      {
        id: generateUUID(),
        orderId: order.id,
        productId: laptop.id,
        quantity: 1,
        unitPrice: laptop.price,
      },
      {},
    );

    const item2 = await orderItemRepo.create(
      {
        id: generateUUID(),
        orderId: order.id,
        productId: phone.id,
        quantity: 2,
        unitPrice: phone.price,
      },
      {},
    );

    const total = Number(laptop.price) * 1 + Number(phone.price) * 2;
    const updatedOrder = await orderRepo.update(order.id, {
      totalAmount: total,
    });

    return { order: updatedOrder, items: [item1, item2] };
  });

  console.log(
    "Order created:",
    orderResult.order.id,
    "Total:",
    orderResult.order.totalAmount,
  );

  // Read order with relations
  const fullOrder = await orderRepo.findOne(orderResult.order.id);
  const orderCustomer = fullOrder
    ? await customerRepo.findOne((fullOrder as any).customerId)
    : null;
  console.log("Order customer:", orderCustomer?.name);

  // ─── BULK OPERATIONS ─────────────────────────────────────────────

  // Bulk upsert
  const bulkProducts = await productRepo.bulkUpsert(
    [
      {
        id: generateUUID(),
        name: "iPad Air",
        slug: "ipad-air",
        price: 599.99,
        stock: 100,
        categoryId: electronicsId,
      },
      {
        id: generateUUID(),
        name: "AirPods Pro",
        slug: "airpods-pro",
        price: 249.99,
        stock: 500,
        categoryId: electronicsId,
      },
    ],
    ["slug"],
  );
  console.log("Bulk upserted:", bulkProducts.length, "products");

  // ─── ADVANCED QUERIES ────────────────────────────────────────────

  // Complex query builder
  const expensiveInStock = await productRepo
    .find()
    .where("price > ?", 1000)
    .where("stock > ?", 0)
    .whereNotNull("categoryId")
    .orderBy("price", "DESC")
    .limit(5)
    .execute(orm.client);
  console.log(
    "Expensive in stock:",
    expensiveInStock.map((p: any) => `${p.name} $${p.price}`),
  );

  // Count distinct
  const distinctCats = await productRepo.countDistinct("categoryId");
  console.log("Distinct categories with products:", distinctCats);

  // ─── PAGINATION ──────────────────────────────────────────────────

  const page1 = await productRepo.paginate(1, 2);
  console.log(`Page 1: ${page1.data.length} of ${page1.total} products`);

  // Cursor pagination
  const cursorResults = await productRepo.findMany({
    take: 2,
    orderBy: { field: "price", direction: "ASC" },
  });
  console.log(
    "Cursor results:",
    cursorResults.map((p: any) => `${p.name} $${p.price}`),
  );

  if (cursorResults.length > 0) {
    const nextCursor = await productRepo.findMany({
      cursor: {
        field: "price",
        value: (cursorResults[cursorResults.length - 1] as any).price,
        direction: "forward",
      },
      take: 2,
      orderBy: { field: "price", direction: "ASC" },
    });
    console.log(
      "Next cursor:",
      nextCursor.map((p: any) => `${p.name} $${p.price}`),
    );
  }

  // ─── HEALTH ──────────────────────────────────────────────────────

  const health = await orm.healthCheck();
  console.log("Health:", health);

  const poolStats = await orm.poolStats();
  console.log("Pool stats:", poolStats);

  // ─── CLEANUP ─────────────────────────────────────────────────────

  await orm.close();
  console.log("Done.");
}

main().catch(console.error);
