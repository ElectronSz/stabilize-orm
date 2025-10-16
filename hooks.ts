import 'reflect-metadata';

export type HookType =
  | 'beforeCreate' | 'afterCreate'
  | 'beforeUpdate' | 'afterUpdate'
  | 'beforeDelete' | 'afterDelete'
  | 'beforeSave' | 'afterSave';

const HOOK_METADATA_KEY = Symbol('stabilize:hooks');

/**
 * Decorator to mark a method as a lifecycle hook.
 * Usage: @Hook('beforeCreate')
 */
export function Hook(type: HookType) {
  return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    const hooks: Record<HookType, string[]> =
      Reflect.getMetadata(HOOK_METADATA_KEY, target) || {};
    hooks[type] = hooks[type] || [];
    hooks[type].push(propertyKey);
    Reflect.defineMetadata(HOOK_METADATA_KEY, hooks, target);
  };
}

/**
 * Get hooks of a specific type for a model instance.
 */
export function getHooks(instance: any, type: HookType): Array<() => Promise<void> | void> {
  const proto = Object.getPrototypeOf(instance);
  const hooks: Record<HookType, string[]> =
    Reflect.getMetadata(HOOK_METADATA_KEY, proto) || {};
  return (hooks[type] || []).map((methodName) => instance[methodName].bind(instance));
}