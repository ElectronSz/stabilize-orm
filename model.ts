/**
 * @file model.ts
 * @description Provides a programmatic API for defining models and a metadata storage system.
 * @author ElectronSz
 */

import type { QueryBuilder } from './query-builder';
import { DataTypes, RelationType } from './types';

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
    scopes?: Record<string, (qb: QueryBuilder<any>, ...args: any[]) => QueryBuilder<any>>; // Custom query scopes
    timestamps?: TimestampsConfig; // Auto-managed timestamp columns
}


/**
 * Metadata storage for models.
 * Stores and retrieves model configuration such as columns, relations, scopes, etc.
 */
export class MetadataStorage {
    private static models: Map<Function, ModelConfig> = new Map();

    /**
     * Associates model metadata with a class constructor.
     * @param model - The class constructor for the model.
     * @param config - The model configuration object.
     */
    static setModelMetadata(model: Function, config: ModelConfig) {
        this.models.set(model, config);
    }

    /**
     * Retrieves the model configuration for a given model class.
     * @param model - The class constructor for the model.
     * @returns The model configuration or undefined if not found.
     */
    static getModelMetadata(model: Function): ModelConfig | undefined {
        return this.models.get(model);
    }

    /**
     * Gets the table name for a given model class.
     * @param model - The class constructor for the model.
     * @returns The table name or an empty string if not found.
     */
    static getTableName(model: Function): string {
        return this.getModelMetadata(model)?.tableName || '';
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
            if (col.required) rules.push('required');
            if (col.unique) rules.push('unique');
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
    static getScopes(model: Function): Record<string, (qb: QueryBuilder<any>, ...args: any[]) => QueryBuilder<any>> {
        return this.getModelMetadata(model)?.scopes || {};
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

    // Store metadata
    MetadataStorage.setModelMetadata(Model, {
        tableName: config.tableName,
        versioned: config.versioned || false,
        softDelete: config.softDelete || false,
        columns: config.columns,
        relations: config.relations || [],
        scopes: config.scopes || {},
        timestamps: config.timestamps || {},
    });

    return Model;
}