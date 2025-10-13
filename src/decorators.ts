import 'reflect-metadata';
import { RelationType } from './types';

export const ModelKey = Symbol('model');
export const ColumnKey = Symbol('column');
export const ValidatorKey = Symbol('validator');
export const RelationKey = Symbol('relation');
export const SoftDeleteKey = Symbol('softDelete');

export function Model(tableName: string) {
  return function (constructor: Function) {
    Reflect.defineMetadata(ModelKey, tableName, constructor);
  };
}

export function Column(name: string, type: string) {
  return function (target: any, propertyKey: string) {
    const columns = Reflect.getMetadata(ColumnKey, target) || {};
    columns[propertyKey] = { name, type };
    Reflect.defineMetadata(ColumnKey, columns, target);
  };
}

export function Required() {
  return function (target: any, propertyKey: string) {
    const validators = Reflect.getMetadata(ValidatorKey, target) || {};
    validators[propertyKey] = [...(validators[propertyKey] || []), 'required'];
    Reflect.defineMetadata(ValidatorKey, validators, target);
  };
}

export function Unique() {
  return function (target: any, propertyKey: string) {
    const validators = Reflect.getMetadata(ValidatorKey, target) || {};
    validators[propertyKey] = [...(validators[propertyKey] || []), 'unique'];
    Reflect.defineMetadata(ValidatorKey, validators, target);
  };
}

export function SoftDelete() {
  return function (target: any, propertyKey: string) {
    Reflect.defineMetadata(SoftDeleteKey, propertyKey, target);
  };
}

export function OneToOne(model: () => any, foreignKey: string) {
  return function (target: any, propertyKey: string) {
    const relations = Reflect.getMetadata(RelationKey, target) || {};
    relations[propertyKey] = { type: RelationType.OneToOne, targetModel: model, foreignKey };
    Reflect.defineMetadata(RelationKey, relations, target);
  };
}

export function ManyToOne(model: () => any, foreignKey: string) {
  return function (target: any, propertyKey: string) {
    const relations = Reflect.getMetadata(RelationKey, target) || {};
    relations[propertyKey] = { type: RelationType.ManyToOne, targetModel: model, foreignKey };
    Reflect.defineMetadata(RelationKey, relations, target);
  };
}

export function OneToMany(model: () => any, inverseKey: string) {
  return function (target: any, propertyKey: string) {
    const relations = Reflect.getMetadata(RelationKey, target) || {};
    relations[propertyKey] = { type: RelationType.OneToMany, targetModel: model, inverseKey };
    Reflect.defineMetadata(RelationKey, relations, target);
  };
}

export function ManyToMany(model: () => any, joinTable: string, foreignKey: string, inverseKey: string) {
  return function (target: any, propertyKey: string) {
    const relations = Reflect.getMetadata(RelationKey, target) || {};
    relations[propertyKey] = { type: RelationType.ManyToMany, targetModel: model, joinTable, foreignKey, inverseKey };
    Reflect.defineMetadata(RelationKey, relations, target);
  };
}