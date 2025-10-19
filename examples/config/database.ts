// config/database.ts
import { DBType, type DBConfig } from "../../";

const dbConfig: DBConfig = {
  type: DBType.MySQL, // Or DBType.MariaDB
  // Use the MySQL/MariaDB URI format
  connectionString: process.env.DATABASE_URL || "mysql://root:P@ssw0rd@localhost:3306/db",
  retryAttempts: 3,
  retryDelay: 1000,
};

export default dbConfig;