// db.js - Fixed version with proper model instance handling
import { ORM, Model as BaseModel } from './MiniORM.js';

// Global ORM instance
const __orm = new ORM();
const __connections = new Map();
let __defaultConnection = null;

// Store for model classes
const modelRegistry = new Map();

/**
 * Main DB class for managing connections and models
 */
class DB {
    /**
     * Connect to a database
     * @param {string} databaseName - Name of the database
     * @param {Object} options - Connection options
     * @returns {Promise<boolean>}
     */
    static async Connect(databaseName, options = {}) {
        const config = {
            driver: options.driver || 'sqlite',
            filename: options.filename || `./${databaseName}.sqlite`,
            host: options.host,
            port: options.port,
            user: options.user,
            password: options.password,
            database: options.database || databaseName
        };

        __orm.addConnection(databaseName, config);
        await __orm.connect(databaseName);
        
        __connections.set(databaseName, __orm.connection(databaseName));
        
        if (!__defaultConnection) {
            __defaultConnection = databaseName;
        }
        
        console.log(`✅ Connected to ${databaseName}`);
        return true;
    }

    /**
     * Create or retrieve a model
     * @param {string} modelName - Name of the model/table
     * @param {Object} schemaDefinition - Schema definition
     * @returns {Model} Model class
     */
    static Model(modelName, schemaDefinition = null) {
        if (modelRegistry.has(modelName)) {
            return modelRegistry.get(modelName);
        }

        const ModelClass = createModelClass(modelName, schemaDefinition);
        
        if (__defaultConnection && __connections.has(__defaultConnection)) {
            ModelClass.init(__connections.get(__defaultConnection));
        }
        
        modelRegistry.set(modelName, ModelClass);
        
        return ModelClass;
    }

    /**
     * Set default connection
     * @param {string} databaseName 
     */
    static set defaultConnection(databaseName) {
        if (__connections.has(databaseName)) {
            __defaultConnection = databaseName;
            
            // Re-initialize all models with new connection
            for (const [name, modelClass] of modelRegistry) {
                modelClass.init(__connections.get(databaseName));
            }
            console.log(`✅ Switched default connection to ${databaseName}`);
        } else {
            throw new Error(`Connection ${databaseName} not found`);
        }
    }

    /**
     * Get current connection name
     * @returns {string|null}
     */
    static get defaultConnection() {
        return __defaultConnection;
    }

    /**
     * Get connection by name
     * @param {string} databaseName 
     * @returns {Object|null}
     */
    static getConnection(databaseName) {
        return __connections.get(databaseName) || null;
    }

    /**
     * List all connections
     * @returns {string[]}
     */
    static listConnections() {
        return Array.from(__connections.keys());
    }

    /**
     * Disconnect from a database
     * @param {string} databaseName 
     * @returns {Promise<boolean>}
     */
    static async Disconnect(databaseName) {
        if (!__connections.has(databaseName)) return false;
        
        await __orm.disconnect(databaseName);
        __connections.delete(databaseName);
        
        if (__defaultConnection === databaseName) {
            __defaultConnection = __connections.size > 0 
                ? Array.from(__connections.keys())[0] 
                : null;
        }
        
        console.log(`✅ Disconnected from ${databaseName}`);
        return true;
    }

    /**
     * Disconnect from all databases
     */
    static async DisconnectAll() {
        for (const dbName of __connections.keys()) {
            await __orm.disconnect(dbName);
        }
        __connections.clear();
        __defaultConnection = null;
        console.log('✅ Disconnected from all databases');
    }

    /**
     * Execute a raw query on the default connection
     * @param {string} sql 
     * @param {Array} params 
     * @returns {Promise<any>}
     */
    static async query(sql, params = []) {
        if (!__defaultConnection) {
            throw new Error('No database connection established');
        }
        const connection = __connections.get(__defaultConnection);
        return connection.adapter.query(sql, params);
    }

    /**
     * Execute a raw query on a specific connection
     * @param {string} databaseName 
     * @param {string} sql 
     * @param {Array} params 
     * @returns {Promise<any>}
     */
    static async queryOn(databaseName, sql, params = []) {
        if (!__connections.has(databaseName)) {
            throw new Error(`Connection ${databaseName} not found`);
        }
        const connection = __connections.get(databaseName);
        return connection.adapter.query(sql, params);
    }
}

/**
 * Create a model class with static methods
 * @param {string} modelName 
 * @param {Object} schemaDefinition 
 * @returns {Class}
 */
function createModelClass(modelName, schemaDefinition) {
    const parsedSchema = parseSchema(schemaDefinition || {});
    
    class DynamicModel extends BaseModel {
        static tableName = modelName;
        static schema = parsedSchema.ormSchema;
        
        constructor(data = {}) {
            super(data);
        }

        // Convert to plain object
        toJSON() {
            return { ...this._attributes };
        }
    }

    // Helper to get model instance by id
    DynamicModel._getInstance = async function(id) {
        const query = this.query().where({ [this.primaryKey]: id });
        const results = await query.get();
        return results.length > 0 ? results[0] : null;
    };

    // Helper to validate required fields
    DynamicModel._validate = function(data) {
        for (const [field, config] of Object.entries(parsedSchema.validationSchema)) {
            if (config.required && (data[field] === undefined || data[field] === null)) {
                throw new Error(`Field "${field}" is required`);
            }
        }
    };

    // CREATE
    DynamicModel.create = async function(data) {
        this._validate(data);
        
        const model = new this(data);
        await model.save();
        return model.toJSON();
    };

    // CREATE MANY
    DynamicModel.createMany = async function(itemsArray) {
        const results = [];
        for (const item of itemsArray) {
            results.push(await this.create(item));
        }
        return results;
    };

    // FIND ALL
    DynamicModel.find = async function(filter = {}) {
        const query = this.query();
        
        if (Object.keys(filter).length > 0) {
            Object.entries(filter).forEach(([key, value]) => {
                if (value !== undefined && value !== null) {
                    query.where({ [key]: value });
                }
            });
        }
        
        const results = await query.get();
        return results.map(r => r.toJSON());
    };

    // FIND ONE
    DynamicModel.findOne = async function(filter) {
        if (!filter || Object.keys(filter).length === 0) {
            throw new Error('Filter is required for findOne');
        }
        
        const query = this.query();
        
        Object.entries(filter).forEach(([key, value]) => {
            if (value !== undefined && value !== null) {
                query.where({ [key]: value });
            }
        });
        
        const results = await query.limit(1).get();
        return results.length > 0 ? results[0].toJSON() : null;
    };

    // FIND BY ID
    DynamicModel.findById = async function(id) {
        if (!id) return null;
        
        const instance = await this._getInstance(id);
        return instance ? instance.toJSON() : null;
    };

    // FIND BY IDS
    DynamicModel.findByIds = async function(ids) {
        if (!ids || !Array.isArray(ids) || ids.length === 0) return [];
        
        const results = [];
        for (const id of ids) {
            const item = await this.findById(id);
            if (item) results.push(item);
        }
        return results;
    };

    // UPDATE
    DynamicModel.update = async function(id, data) {
        if (!id) throw new Error('ID is required for update');
        
        const instance = await this._getInstance(id);
        if (!instance) {
            throw new Error(`Document with id ${id} not found`);
        }
        
        instance.fill(data);
        await instance.save();
        
        return instance.toJSON();
    };

    // UPDATE MANY
    DynamicModel.updateMany = async function(filter, data) {
        const query = this.query();
        
        Object.entries(filter).forEach(([key, value]) => {
            if (value !== undefined && value !== null) {
                query.where({ [key]: value });
            }
        });
        
        const instances = await query.get();
        const results = [];
        
        for (const instance of instances) {
            instance.fill(data);
            await instance.save();
            results.push(instance.toJSON());
        }
        
        return results;
    };

    // UPDATE OR CREATE
    DynamicModel.updateOrCreate = async function(filter, data) {
        const existing = await this.findOne(filter);
        
        if (existing) {
            return await this.update(existing.id, { ...existing, ...data });
        } else {
            return await this.create({ ...filter, ...data });
        }
    };

    // DELETE
    DynamicModel.delete = async function(id) {
        if (!id) return false;
        
        const instance = await this._getInstance(id);
        if (!instance) return false;
        
        await instance.delete();
        return true;
    };

    // DELETE MANY
    DynamicModel.deleteMany = async function(filter = {}) {
        const query = this.query();
        
        Object.entries(filter).forEach(([key, value]) => {
            if (value !== undefined && value !== null) {
                query.where({ [key]: value });
            }
        });
        
        const instances = await query.get();
        let deleted = 0;
        
        for (const instance of instances) {
            await instance.delete();
            deleted++;
        }
        
        return deleted;
    };

    // DELETE ALL
    DynamicModel.deleteAll = async function() {
        const instances = await this.query().get();
        let deleted = 0;
        
        for (const instance of instances) {
            await instance.delete();
            deleted++;
        }
        
        return deleted;
    };

    // COUNT
    DynamicModel.count = async function(filter = {}) {
        const query = this.query();
        
        if (Object.keys(filter).length > 0) {
            Object.entries(filter).forEach(([key, value]) => {
                if (value !== undefined && value !== null) {
                    query.where({ [key]: value });
                }
            });
        }
        
        return query.count();
    };

    // EXISTS
    DynamicModel.exists = async function(filter) {
        if (!filter || Object.keys(filter).length === 0) {
            throw new Error('Filter is required for exists check');
        }
        
        const count = await this.count(filter);
        return count > 0;
    };

    // ALL
    DynamicModel.all = async function() {
        return this.find();
    };

    // FIRST
    DynamicModel.first = async function(filter = {}) {
        const query = this.query();
        
        if (Object.keys(filter).length > 0) {
            Object.entries(filter).forEach(([key, value]) => {
                if (value !== undefined && value !== null) {
                    query.where({ [key]: value });
                }
            });
        }
        
        const results = await query.limit(1).get();
        return results.length > 0 ? results[0].toJSON() : null;
    };

    // LAST
    DynamicModel.last = async function(filter = {}) {
        const query = this.query()
            .orderBy(this.primaryKey, 'DESC');
        
        if (Object.keys(filter).length > 0) {
            Object.entries(filter).forEach(([key, value]) => {
                if (value !== undefined && value !== null) {
                    query.where({ [key]: value });
                }
            });
        }
        
        const results = await query.limit(1).get();
        return results.length > 0 ? results[0].toJSON() : null;
    };

    // PLUCK
    DynamicModel.pluck = async function(field) {
        const items = await this.find();
        return items.map(item => item[field]);
    };

    // PLUCK WITH KEY
    DynamicModel.pluckWithKey = async function(keyField, valueField) {
        const items = await this.find();
        const result = {};
        items.forEach(item => {
            result[item[keyField]] = item[valueField];
        });
        return result;
    };

    // MAX
    DynamicModel.max = async function(field) {
        const items = await this.find();
        if (items.length === 0) return null;
        
        return Math.max(...items.map(item => Number(item[field]) || 0));
    };

    // MIN
    DynamicModel.min = async function(field) {
        const items = await this.find();
        if (items.length === 0) return null;
        
        return Math.min(...items.map(item => Number(item[field]) || 0));
    };

    // SUM
    DynamicModel.sum = async function(field, filter = {}) {
        const items = await this.find(filter);
        return items.reduce((acc, item) => acc + (Number(item[field]) || 0), 0);
    };

    // AVG
    DynamicModel.avg = async function(field, filter = {}) {
        const items = await this.find(filter);
        if (items.length === 0) return 0;
        
        const sum = items.reduce((acc, item) => acc + (Number(item[field]) || 0), 0);
        return sum / items.length;
    };

    // TRUNCATE
    DynamicModel.truncate = async function() {
        const connection = __connections.get(__defaultConnection);
        await connection.adapter.query(`DELETE FROM ${modelName}`);
        
        // Reset auto-increment for SQLite
        if (connection.driver === 'sqlite') {
            await connection.adapter.query(`DELETE FROM sqlite_sequence WHERE name='${modelName}'`);
        }
        
        return true;
    };

    // CHUNK
    DynamicModel.chunk = async function(size, callback) {
        const items = await this.find();
        const chunks = [];
        
        for (let i = 0; i < items.length; i += size) {
            chunks.push(items.slice(i, i + size));
        }
        
        for (let i = 0; i < chunks.length; i++) {
            await callback(chunks[i], i + 1);
        }
        
        return chunks.length;
    };

    // EACH
    DynamicModel.each = async function(callback) {
        const items = await this.find();
        
        for (let i = 0; i < items.length; i++) {
            await callback(items[i], i);
        }
        
        return items.length;
    };

    // TOGGLE
    DynamicModel.toggle = async function(id, field) {
        const instance = await this._getInstance(id);
        if (!instance) throw new Error(`Item with id ${id} not found`);
        
        instance._attributes[field] = !instance._attributes[field];
        await instance.save();
        
        return instance.toJSON();
    };

    // INCREMENT
    DynamicModel.increment = async function(id, field, amount = 1) {
        const instance = await this._getInstance(id);
        if (!instance) throw new Error(`Item with id ${id} not found`);
        
        instance._attributes[field] = (Number(instance._attributes[field]) || 0) + amount;
        await instance.save();
        
        return instance.toJSON();
    };

    // DECREMENT
    DynamicModel.decrement = async function(id, field, amount = 1) {
        return this.increment(id, field, -amount);
    };

    return DynamicModel;
}

/**
 * Parse simplified schema to ORM schema
 * @param {Object} schemaDefinition 
 * @returns {Object}
 */
function parseSchema(schemaDefinition) {
    const ormSchema = {};
    const validationSchema = {};
    
    for (const [fieldName, fieldConfig] of Object.entries(schemaDefinition)) {
        let type = 'string';
        let required = false;
        
        if (typeof fieldConfig === 'string') {
            type = fieldConfig;
        } else if (typeof fieldConfig === 'object') {
            type = fieldConfig.type || 'string';
            required = fieldConfig.required || false;
        }
        
        const mappedType = mapType(type);
        
        ormSchema[fieldName] = {
            type: mappedType
        };
        
        validationSchema[fieldName] = {
            type: mappedType,
            required
        };
    }
    
    return { ormSchema, validationSchema };
}

/**
 * Map simplified types to ORM types
 * @param {string} type 
 * @returns {string}
 */
function mapType(type) {
    const typeMap = {
        'string': 'string',
        'number': 'float',
        'int': 'integer',
        'integer': 'integer',
        'float': 'float',
        'boolean': 'boolean',
        'bool': 'boolean',
        'date': 'date',
        'datetime': 'datetime',
        'text': 'text',
        'json': 'json'
    };
    return typeMap[type.toLowerCase()] || 'string';
}

export default DB;