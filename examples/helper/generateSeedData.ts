import { MetadataStorage, DBType, DataTypes } from "../../";
import { mapDataTypeToSql } from "../../"; 
import type { ColumnConfig } from "../../model";

function getDefaultValueForColumn(colConfig: ColumnConfig, dbType: DBType, idx: number) {
  // Use the original model type, not just the SQL type!
  const origType = typeof colConfig.type === "string" ? colConfig.type : DataTypes[colConfig.type]?.toLowerCase();
  
  if (origType === "boolean") {
    return idx % 2 === 0 ? false : true;
  }
  if (origType === "integer" || origType === "bigint") {
    return idx + 1;
  }
  if (origType === "string" || origType === "text") {
    return colConfig.unique ? `data_${idx}` : "data";
  }
  if (origType === "datetime" || origType === "date") {
    return new Date().toISOString();
  }
  // Fallback to SQL type if needed
  const sqlType = mapDataTypeToSql(colConfig.type, dbType);
  switch (sqlType) {
    case "TINYINT(1)":
      return idx % 2 === 0 ? false : true;
    case "BOOLEAN":
      return idx % 2 === 0 ? false : true;
    case "TEXT":
    case "VARCHAR(255)":
      return colConfig.unique ? `data_${idx}` : "data";
    case "INT":
    case "INTEGER":
    case "BIGINT":
      return idx + 1;
    case "DATETIME":
    case "TIMESTAMP":
      return new Date().toISOString();
    default:
      return null;
  }
}

/**
 * Generates fake seed data based on model columns and types.
 * @param modelClass The model class (from defineModel).
 * @param dbType Target DB type (DBType.Postgres | DBType.MySQL | DBType.SQLite).
 * @param count Number of rows to generate.
 */
export function generateSeedData(modelClass: any, dbType: DBType, count = 2) {
  const columns = MetadataStorage.getColumns(modelClass);
  return Array.from({ length: count }, (_, idx) => {
    const row: Record<string, any> = {};
    for (const [key, colConfig] of Object.entries(columns)) {
      if (colConfig.softDelete) continue;
      row[key] = getDefaultValueForColumn(colConfig, dbType, idx);
    }
    return row;
  });
}