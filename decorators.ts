/**
 * @file decorators.ts
 * @description Contains all the decorators used by the Stabilize ORM.
 * @author ElectronSz
 */

import "reflect-metadata";
import { RelationType, DataTypes } from "./types";

export const ModelKey = Symbol("model");
export const ColumnKey = Symbol("column");
export const ValidatorKey = Symbol("validator");
export const RelationKey = Symbol("relation");
export const SoftDeleteKey = Symbol("softDelete");
export const DefaultKey = Symbol("default");
export const IndexKey = Symbol("index");
export const VersionedKey = Symbol("versioned");

export interface ColumnOptions {
  name?: string;
  type: DataTypes;
  length?: number;
  precision?: number;
  scale?: number;
}

/**
 * Decorator to mark a class as a database model.
 * @param tableName The name of the table in the database.
 */
export function Model(tableName: string) {
  return function (constructor: Function) {
    Reflect.defineMetadata(ModelKey, tableName, constructor);
  };
}

/**
 * Decorator to mark a property as a database column.
 * @param options The configuration for the column, including name, type, and length.
 */
export function Column(options: ColumnOptions | DataTypes) {
  return function (target: any, propertyKey: string) {
    const columns = Reflect.getMetadata(ColumnKey, target) || {};
    const columnOptions: ColumnOptions = typeof options === 'object' ? options : { type: options };
    columns[propertyKey] = {
      name: columnOptions.name || propertyKey,
      ...columnOptions,
    };
    Reflect.defineMetadata(ColumnKey, columns, target);
  };
}

/**
 * Decorator to enforce a NOT NULL constraint on a column.
 */
export function Required() {
  return function (target: any, propertyKey: string) {
    const validators = Reflect.getMetadata(ValidatorKey, target) || {};
    validators[propertyKey] = [...(validators[propertyKey] || []), "required"];
    Reflect.defineMetadata(ValidatorKey, validators, target);
  };
}

/**
 * Decorator to enforce a UNIQUE constraint on a column.
 */
export function Unique() {
  return function (target: any, propertyKey: string) {
    const validators = Reflect.getMetadata(ValidatorKey, target) || {};
    validators[propertyKey] = [...(validators[propertyKey] || []), "unique"];
    Reflect.defineMetadata(ValidatorKey, validators, target);
  };
}

/**
 * Decorator to set a default value for a column.
 * @param value The default value.
 */
export function Default(value: any) {
  return function (target: any, propertyKey: string) {
    Reflect.defineMetadata(DefaultKey, value, target, propertyKey);
  };
}

/**
 * Decorator to create a non-unique index on a column for performance.
 * @param indexName Optional: A custom name for the index.
 */
export function Index(indexName?: string) {
  return function (target: any, propertyKey: string) {
    const indexes = Reflect.getMetadata(IndexKey, target) || {};
    indexes[propertyKey] = indexName || `idx_${propertyKey}`;
    Reflect.defineMetadata(IndexKey, indexes, target);
  };
}

/**
 * Decorator to enable soft-delete functionality on a model.
 * The decorated property will store the deletion timestamp.
 */
export function SoftDelete() {
  return function (target: any, propertyKey: string) {
    Reflect.defineMetadata(SoftDeleteKey, propertyKey, target);
  };
}

/**
 * Decorator to enable versioning (history, snapshot & time-travel) on a model.
 */
export function Versioned() {
  return function (target: any) {
    Reflect.defineMetadata(VersionedKey, true, target);
  };
}


export function OneToOne(model: () => any, foreignKey: string) {
  return function (target: any, propertyKey: string) {
    const relations = Reflect.getMetadata(RelationKey, target) || {};
    relations[propertyKey] = {
      type: RelationType.OneToOne,
      targetModel: model,
      foreignKey,
    };
    Reflect.defineMetadata(RelationKey, relations, target);
  };
}

export function ManyToOne(model: () => any, foreignKey: string) {
  return function (target: any, propertyKey: string) {
    const relations = Reflect.getMetadata(RelationKey, target) || {};
    relations[propertyKey] = {
      type: RelationType.ManyToOne,
      targetModel: model,
      foreignKey,
    };
    Reflect.defineMetadata(RelationKey, relations, target);
  };
}

export function OneToMany(model: () => any, inverseKey: string) {
  return function (target: any, propertyKey: string) {
    const relations = Reflect.getMetadata(RelationKey, target) || {};
    relations[propertyKey] = {
      type: RelationType.OneToMany,
      targetModel: model,
      inverseKey,
    };
    Reflect.defineMetadata(RelationKey, relations, target);
  };
}

export function ManyToMany(
  model: () => any,
  joinTable: string,
  foreignKey: string,
  inverseKey: string,
) {
  return function (target: any, propertyKey: string) {
    const relations = Reflect.getMetadata(RelationKey, target) || {};
    relations[propertyKey] = {
      type: RelationType.ManyToMany,
      targetModel: model,
      joinTable,
      foreignKey,
      inverseKey,
    };
    Reflect.defineMetadata(RelationKey, relations, target);
  };
}