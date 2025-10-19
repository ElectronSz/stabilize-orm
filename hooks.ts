/**
 * @file hooks.ts
 * @description Provides lifecycle hooks for Stabilize ORM models, integrated with the programmatic API.
 * @author ElectronSz
 */

import { MetadataStorage } from "./model";

export type HookType =
  | "beforeCreate"
  | "afterCreate"
  | "beforeUpdate"
  | "afterUpdate"
  | "beforeSave"
  | "afterSave"
  | "beforeDelete"
  | "afterDelete";

export type HookCallback = (entity: any) => Promise<void> | void;

export interface Hook {
  type: HookType;
  callback: HookCallback;
}

// Extend ModelConfig to include hooks
declare module "./model" {
  interface ModelConfig {
    hooks?:  Partial<Record<HookType, HookCallback | HookCallback[]>>;
  }
}

/**
 * Registers hooks for a model in the MetadataStorage.
 * @param model The model class.
 * @param hooks A record of hook types to their callbacks.
 */
export function registerHooks(model: Function, hooks: Record<HookType, HookCallback | HookCallback[]>) {
  const config = MetadataStorage.getModelMetadata(model) || { tableName: "", columns: {} };
  config.hooks = { ...config.hooks, ...hooks };
  MetadataStorage.setModelMetadata(model, config);
}

/**
 * Retrieves hooks for a given entity and hook type.
 * Combines hooks from MetadataStorage and class methods.
 * @param entity The entity instance.
 * @param type The hook type (e.g., 'beforeCreate').
 * @returns An array of Hook objects to execute.
 */
export function getHooks(entity: any, type: HookType): Hook[] {
  const hooks: Hook[] = [];
  const model = Object.getPrototypeOf(entity).constructor;

  // Get hooks from MetadataStorage
  const config = MetadataStorage.getModelMetadata(model);
  if (config?.hooks?.[type]) {
    const callbacks = Array.isArray(config.hooks[type])
      ? config.hooks[type]
      : [config.hooks[type]];
    hooks.push(...callbacks.map(callback => ({
      type,
      callback: () => callback(entity),
    })));
  }

  // Get hooks from class methods
  if (typeof entity[type] === "function") {
    hooks.push({
      type,
      callback: () => entity[type](),
    });
  }

  return hooks;
}