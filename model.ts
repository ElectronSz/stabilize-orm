
/**
 * @file model.ts
 * @description Provides a programmatic API for defining models and a metadata storage system.
 * @author ElectronSz
 */

import { DataTypes, RelationType, DBType } from './types';

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
    index?: string; // Optional index name
    softDelete?: boolean; // Marks column as soft delete field
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

// Interface for model configuration
export interface ModelConfig {
    tableName: string;
    versioned?: boolean;
    softDelete?: boolean;
    columns: Record<string, ColumnConfig>;
    relations?: RelationConfig[];
}

// Metadata storage for models
export class MetadataStorage {
    private static models: Map<Function, ModelConfig> = new Map();

    static setModelMetadata(model: Function, config: ModelConfig) {
        this.models.set(model, config);
    }

    static getModelMetadata(model: Function): ModelConfig | undefined {
        return this.models.get(model);
    }

    static getTableName(model: Function): string {
        return this.getModelMetadata(model)?.tableName || '';
    }

    static getColumns(model: Function): Record<string, ColumnConfig> {
        return this.getModelMetadata(model)?.columns || {};
    }

    static getValidators(model: Function): Record<string, string[]> {
        const columns = this.getModelMetadata(model)?.columns || {};
        const validators: Record<string, string[]> = {};
        for (const [key, col] of Object.entries(columns)) {
            const rules: string[] = [];
            if (col.required) rules.push('required');
            if (col.unique) rules.push('unique');
            validators[key] = rules;
        }
        return validators;
    }

    static getRelations(model: Function): Record<string, RelationConfig> {
        const relations = this.getModelMetadata(model)?.relations || [];
        const result: Record<string, RelationConfig> = {};
        for (const rel of relations) {
            result[rel.property] = rel;
        }
        return result;
    }

    static getSoftDeleteField(model: Function): string | null {
        const columns = this.getModelMetadata(model)?.columns || {};
        for (const [key, col] of Object.entries(columns)) {
            if (col.softDelete) return key;
        }
        return null;
    }

    static isVersioned(model: Function): boolean {
        return !!this.getModelMetadata(model)?.versioned;
    }
}

// Programmatic model definition
export function defineModel(config: ModelConfig) {
    class Model {
        constructor(data: any) {
            Object.assign(this, data);
        }
    }

    // Store metadata
    MetadataStorage.setModelMetadata(Model, {
        tableName: config.tableName,
        versioned: config.versioned || false,
        softDelete: config.softDelete || false,
        columns: config.columns,
        relations: config.relations || [],
    });

    return Model;
}
