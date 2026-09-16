/**
 * @file model.ts
 * @description Provides a programmatic API for defining models and a metadata storage system.
 * @author ElectronSz
 */

import type { QueryBuilder } from "./query-builder";
import { DataTypes, RelationType, type DefaultExpression } from "./types";

// Interface for column configuration
export interface ColumnConfig {
  name?: string;
  type: DataTypes;
  length?: number;
  precision?: number;
  scale?: number;
  required?: boolean;
  unique?: boolean;
  defaultValue?: any;
  defaultExpression?: DefaultExpression;
  index?: string;
  softDelete?: boolean;
  minLength?: number;
  maxLength?: number;
  pattern?: RegExp;
  customValidator?: (val: any) => boolean | string;
  encrypted?: boolean;
  optimisticLock?: boolean;
}

// Interface for relationship configuration
export interface RelationConfig {
  type: RelationType;
  target: () => any; // Reference to another model
  property: string; // Property name in the model
  foreignKey?: string;
  inverseKey?: string;
  joinTable?: string;
}

export interface TimestampsConfig {
  createdAt?: string;
  updatedAt?: string;
}

// Interface for model configuration
export interface ModelConfig {
  tableName: string;
  versioned?: boolean;
  softDelete?: boolean;
  columns: Record<string, ColumnConfig>;
  relations?: RelationConfig[];
  scopes?: Record<
    string,
    (qb: QueryBuilder<any>, ...args: any[]) => QueryBuilder<any>
  >; // Custom query scopes
  timestamps?: TimestampsConfig; // Auto-managed timestamp columns
}

/**
 * Key under which the model registry is stored on `globalThis`.
 *
 * The registry is process-wide rather than module-local so that every copy of
 * this module shares it. If the ORM is bundled more than once (duplicate
 * dependency, mixed CJS/ESM resolution, a CLI plus an app), each copy would
 * otherwise get its own Map and metadata written by one copy would be
 * invisible to the other — models would look as though they were never
 * defined.
 */
const MODEL_REGISTRY_KEY = Symbol.for("stabilize-orm.model-registry");

function getModelRegistry(): Map<Function, ModelConfig> {
  const root = globalThis as any;
  if (!root[MODEL_REGISTRY_KEY]) {
    root[MODEL_REGISTRY_KEY] = new Map<Function, ModelConfig>();
  }
  return root[MODEL_REGISTRY_KEY];
}

/**
 * Rebuilds a model configuration from the static properties mirrored onto the
 * class by {@link MetadataStorage.setModelMetadata}.
 *
 * @param model - The class constructor for the model.
 * @returns The reconstructed configuration, or undefined if the class carries
 * no table name and therefore was never registered.
 */
function getStaticMetadata(model: Function): ModelConfig | undefined {
  const candidate = model as any;
  if (!candidate || !candidate.tableName) return undefined;
  return {
    tableName: candidate.tableName,
    versioned: candidate.versioned || false,
    softDelete: candidate.softDelete || false,
    columns: candidate.columns || {},
    relations: Array.isArray(candidate.relations) ? candidate.relations : [],
    scopes: candidate.scopes || {},
    timestamps: candidate.timestamps || {},
    hooks: candidate.hooks,
  };
}

/**
 * Metadata storage for models.
 * Stores and retrieves model configuration such as columns, relations, scopes, etc.
 */
export class MetadataStorage {
  /**
   * Associates model metadata with a class constructor.
   *
   * The configuration is stored both in the shared registry and as static
   * properties on the class itself, so it survives being read from a different
   * copy of the ORM.
   *
   * @param model - The class constructor for the model.
   * @param config - The model configuration object.
   */
  static setModelMetadata(model: Function, config: ModelConfig) {
    getModelRegistry().set(model, config);

    // The mirror is best effort: the registry above is authoritative. A frozen
    // class, or one whose static `columns` is a getter without a setter, would
    // otherwise make registration throw.
    const target = model as any;
    if (typeof target !== "function") return;
    try {
      target.tableName = config.tableName;
      target.versioned = config.versioned || false;
      target.softDelete = config.softDelete || false;
      target.columns = config.columns;
      target.relations = config.relations || [];
      target.scopes = config.scopes || {};
      target.timestamps = config.timestamps || {};
      if (config.hooks) target.hooks = config.hooks;
    } catch {
      // Ignore: metadata is still available through the registry.
    }
  }

  /**
   * Retrieves the model configuration for a given model class.
   * @param model - The class constructor for the model.
   * @returns The model configuration, falling back to the class statics when
   * the class was registered by a different copy of the ORM.
   */
  static getModelMetadata(model: Function): ModelConfig | undefined {
    return getModelRegistry().get(model) ?? getStaticMetadata(model);
  }

  /**
   * Gets the table name for a given model class.
   * @param model - The class constructor for the model.
   * @returns The table name or an empty string if not found.
   */
  static getTableName(model: Function): string {
    return this.getModelMetadata(model)?.tableName || "";
  }

  /**
   * Gets the column configuration for a given model class.
   * @param model - The class constructor for the model.
   * @returns Record of column names to their configuration.
   */
  static getColumns(model: Function): Record<string, ColumnConfig> {
    return this.getModelMetadata(model)?.columns || {};
  }

  /**
   * Collects validation rules for each column of a given model.
   * @param model - The class constructor for the model.
   * @returns An object mapping column names to an array of validation rule names.
   */
  static getValidators(model: Function): Record<string, string[]> {
    const columns = this.getModelMetadata(model)?.columns || {};
    const validators: Record<string, string[]> = {};
    for (const [key, col] of Object.entries(columns)) {
      const rules: string[] = [];
      if (col.required) rules.push("required");
      if (col.unique) rules.push("unique");
      validators[key] = rules;
    }
    return validators;
  }

  /**
   * Gets the relationship configuration for a given model class.
   * @param model - The class constructor for the model.
   * @returns Record of property names to their relation configuration.
   */
  static getRelations(model: Function): Record<string, RelationConfig> {
    const relations = this.getModelMetadata(model)?.relations || [];
    const result: Record<string, RelationConfig> = {};
    for (const rel of relations) {
      result[rel.property] = rel;
    }
    return result;
  }

  /**
   * Finds the soft delete field, if any, for a given model class.
   * @param model - The class constructor for the model.
   * @returns The key of the soft delete field, or null if not found.
   */
  static getSoftDeleteField(model: Function): string | null {
    const columns = this.getModelMetadata(model)?.columns || {};
    for (const [key, col] of Object.entries(columns)) {
      if (col.softDelete) return key;
    }
    return null;
  }

  /**
   * Checks if the model is versioned.
   * @param model - The class constructor for the model.
   * @returns True if versioned, false otherwise.
   */
  static isVersioned(model: Function): boolean {
    return !!this.getModelMetadata(model)?.versioned;
  }

  /**
   * Gets custom query scopes for a given model class.
   * @param model - The class constructor for the model.
   * @returns Record of scope names to scope functions.
   */
  static getScopes(
    model: Function,
  ): Record<
    string,
    (qb: QueryBuilder<any>, ...args: any[]) => QueryBuilder<any>
  > {
    return this.getModelMetadata(model)?.scopes || {};
  }

  /**
   * Finds the model constructor by table name.
   * @param tableName - The table name to search for.
   * @returns The model constructor or undefined if not found.
   */
  static getModelByTableName(tableName: string): Function | undefined {
    for (const [model, config] of getModelRegistry()) {
      if (config.tableName === tableName) {
        return model;
      }
    }
    return undefined;
  }

  static getTimestamps(model: Function): TimestampsConfig {
    return this.getModelMetadata(model)?.timestamps || {};
  }
}

/**
 * Programmatically defines a model and stores its metadata.
 * @param config - The model configuration object.
 * @returns The dynamically created model class.
 */
export function defineModel(config: ModelConfig) {
  class Model {
    /**
     * Constructs a model instance from plain data.
     * @param data - The plain object to assign properties from.
     */
    constructor(data: any) {
      Object.assign(this, data);
    }
  }

  // Stored in the shared registry and mirrored onto the class as statics so
  // that metadata stays readable across bundle boundaries.
  MetadataStorage.setModelMetadata(Model, {
    tableName: config.tableName,
    versioned: config.versioned || false,
    softDelete: config.softDelete || false,
    columns: config.columns,
    relations: config.relations || [],
    scopes: config.scopes || {},
    timestamps: config.timestamps || {},
    hooks: config.hooks,
  });

  return Model;
}
