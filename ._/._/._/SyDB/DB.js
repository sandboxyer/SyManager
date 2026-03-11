// db.js - Complete DB interface with robust JSDoc for VSCode IntelliSense

import { ORM, Model as BaseModel } from './MiniORM.js';

// ==================== Global State ====================
const __orm = new ORM();
const __connections = new Map();
let __defaultConnection = null;
const modelRegistry = new Map();

// ==================== Type Definitions ====================

/**
 * @template T
 * @typedef {Object} ModelInstance
 * @property {T} _attributes - Internal attributes
 * @property {T} _original - Original attributes
 * @property {boolean} _exists - Whether the model exists in database
 * @property {function(Partial<T>): ModelInstance<T>} fill - Fill model with data
 * @property {function(string?): boolean} isDirty - Check if model has changes
 * @property {function(string?): any} getOriginal - Get original values
 * @property {function(): Promise<ModelInstance<T>>} save - Save model to database
 * @property {function(): Promise<boolean>} delete - Delete model from database
 * @property {function(): Promise<boolean>} restore - Restore soft-deleted model
 * @property {function(): T} toJSON - Convert to plain object
 */

/**
 * @template T
 * @typedef {Object} ModelClass
 * @property {string} tableName - Table/collection name
 * @property {string} primaryKey - Primary key field name
 * @property {boolean} timestamps - Whether to use timestamps
 * @property {boolean} softDeletes - Whether to use soft deletes
 * @property {Object} schema - Model schema
 * @property {function(new: ModelInstance<T>, Partial<T>?)} new - Constructor
 * @property {function(Partial<T>): Promise<ModelInstance<T>>} create - Create new record
 * @property {function(Array<Partial<T>>): Promise<Array<ModelInstance<T>>>} createMany - Create multiple records
 * @property {function(Partial<T>?): Promise<Array<ModelInstance<T>>>} find - Find records
 * @property {function(Partial<T>): Promise<ModelInstance<T> | null>} findOne - Find one record
 * @property {function(string|number): Promise<ModelInstance<T> | null>} findById - Find by ID
 * @property {function(Array<string|number>): Promise<Array<ModelInstance<T>>>} findByIds - Find by multiple IDs
 * @property {function(string|number, Partial<T>): Promise<ModelInstance<T>>} update - Update record
 * @property {function(Partial<T>, Partial<T>): Promise<Array<ModelInstance<T>>>} updateMany - Update multiple records
 * @property {function(Partial<T>, Partial<T>): Promise<ModelInstance<T>>} updateOrCreate - Update or create
 * @property {function(string|number): Promise<boolean>} delete - Delete record
 * @property {function(Partial<T>?): Promise<number>} deleteMany - Delete multiple records
 * @property {function(): Promise<number>} deleteAll - Delete all records
 * @property {function(Partial<T>?): Promise<number>} count - Count records
 * @property {function(Partial<T>): Promise<boolean>} exists - Check if records exist
 * @property {function(): Promise<Array<ModelInstance<T>>>} all - Get all records
 * @property {function(Partial<T>?): Promise<ModelInstance<T> | null>} first - Get first record
 * @property {function(Partial<T>?): Promise<ModelInstance<T> | null>} last - Get last record
 * @property {function(string): Promise<Array<any>>} pluck - Pluck a field
 * @property {function(string, string): Promise<Object.<string, any>>} pluckWithKey - Pluck with key
 * @property {function(string): Promise<number | null>} max - Get maximum value
 * @property {function(string): Promise<number | null>} min - Get minimum value
 * @property {function(string, Partial<T>?): Promise<number>} sum - Get sum
 * @property {function(string, Partial<T>?): Promise<number>} avg - Get average
 * @property {function(): Promise<boolean>} truncate - Truncate table
 * @property {function(number, function(Array<ModelInstance<T>>, number): Promise<any>): Promise<number>} chunk - Process in chunks
 * @property {function(function(ModelInstance<T>, number): Promise<any>): Promise<number>} each - Process each record
 * @property {function(string|number, string): Promise<ModelInstance<T>>} toggle - Toggle boolean field
 * @property {function(string|number, string, number?): Promise<ModelInstance<T>>} increment - Increment field
 * @property {function(string|number, string, number?): Promise<ModelInstance<T>>} decrement - Decrement field
 * @property {function(): import('./MiniORM.js').QueryBuilder} query - Get query builder
 */

/**
 * @typedef {Object} ConnectionInfo
 * @property {string} name - Connection name
 * @property {string} driver - Database driver
 * @property {Object} config - Connection configuration
 * @property {Object} adapter - Database adapter
 */

/**
 * @typedef {Object} PaginatedResult
 * @template T
 * @property {Array<ModelInstance<T>>} data - Paginated data
 * @property {Object} meta - Pagination metadata
 * @property {number} meta.current_page - Current page
 * @property {number} meta.per_page - Items per page
 * @property {number} meta.total - Total items
 * @property {number} meta.last_page - Last page
 * @property {number} meta.from - Starting index
 * @property {number} meta.to - Ending index
 */

/**
 * @typedef {Object} SchemaField
 * @property {string} type - Field type (string, number, boolean, date, json)
 * @property {boolean} [required] - Whether field is required
 * @property {any} [default] - Default value
 */

/**
 * @typedef {Object.<string, string|SchemaField>} SchemaDefinition
 */

// ==================== Main DB Class with JSDoc ====================

/**
 * Main Database interface for managing connections and models.
 * Provides a complete ORM-like interface with full IntelliSense support.
 * 
 * @example
 * ```javascript
 * // Connect to database
 * await DB.Connect('mydb', { driver: 'sqlite' });
 * 
 * // Define a model with schema
 * const User = DB.Model('users', {
 *   name: 'string',
 *   email: { type: 'string', required: true },
 *   age: 'number'
 * });
 * 
 * // CRUD operations with full IntelliSense
 * const user = await User.create({ name: 'John', email: 'john@example.com', age: 30 });
 * console.log(user.name); // IntelliSense shows 'name' property
 * 
 * const users = await User.find({ age: 30 });
 * users.forEach(u => {
 *   console.log(u.name); // IntelliSense knows u has name, email, age
 * });
 * ```
 */
class DB {
    /**
     * Connect to a database
     * 
     * @param {string} databaseName - Name of the database/connection
     * @param {Object} options - Connection options
     * @param {string} options.driver - Database driver ('postgres', 'mysql', 'sqlite', 'sqlserver', 'mongodb')
     * @param {string} [options.filename] - SQLite filename (required for sqlite)
     * @param {string} [options.host] - Database host
     * @param {number} [options.port] - Database port
     * @param {string} [options.user] - Database user
     * @param {string} [options.password] - Database password
     * @param {string} [options.database] - Database name (defaults to databaseName)
     * @param {Object} [options.ssl] - SSL options
     * @param {boolean} [options.ssl.rejectUnauthorized=true] - Reject unauthorized SSL
     * @returns {Promise<boolean>} True if connected successfully
     * 
     * @example
     * ```javascript
     * // SQLite connection
     * await DB.Connect('mydb', { driver: 'sqlite', filename: './database.sqlite' });
     * 
     * // PostgreSQL connection
     * await DB.Connect('postgres', {
     *   driver: 'postgres',
     *   host: 'localhost',
     *   port: 5432,
     *   user: 'postgres',
     *   password: 'secret',
     *   database: 'mydb'
     * });
     * 
     * // MongoDB simulation (in-memory)
     * await DB.Connect('mongodb', { driver: 'mongodb' });
     * ```
     */
    static async Connect(databaseName, options = {}) {
        const config = {
            driver: options.driver || 'sqlite',
            filename: options.filename || `./${databaseName}.sqlite`,
            host: options.host,
            port: options.port,
            user: options.user,
            password: options.password,
            database: options.database || databaseName,
            ssl: options.ssl
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
     * Create or retrieve a model with full type inference.
     * The returned model class provides all CRUD operations with
     * IntelliSense support for the schema fields.
     * 
     * @template {Object} T - Schema type
     * @param {string} modelName - Name of the model/table
     * @param {SchemaDefinition} [schemaDefinition] - Schema definition
     * @returns {ModelClass<T>} Model class with full CRUD methods
     * 
     * @example
     * ```javascript
     * // Simple string-based schema
     * const User = DB.Model('users', {
     *   name: 'string',
     *   email: 'string',
     *   age: 'number',
     *   isActive: 'boolean'
     * });
     * 
     * // Detailed schema with options
     * const Product = DB.Model('products', {
     *   id: 'number',
     *   name: { type: 'string', required: true },
     *   price: { type: 'number', required: true },
     *   description: { type: 'string', default: '' },
     *   inStock: { type: 'boolean', default: true },
     *   metadata: { type: 'json', default: {} }
     * });
     * 
     * // Full IntelliSense example
     * const users = await User.find({ isActive: true });
     * users.forEach(user => {
     *   console.log(user.name);  // VSCode shows 'name' in autocomplete
     *   console.log(user.email); // VSCode shows 'email' in autocomplete
     *   console.log(user.age);   // VSCode shows 'age' in autocomplete
     * });
     * 
     * const user = await User.create({
     *   name: 'John',    // IntelliSense suggests these fields
     *   email: 'john@example.com',
     *   age: 30,
     *   isActive: true
     * });
     * 
     * // Update with IntelliSense
     * await User.update(user.id, { age: 31 }); // 'age' is suggested
     * ```
     */
    static Model(modelName, schemaDefinition = null) {
        if (modelRegistry.has(modelName)) {
            return modelRegistry.get(modelName);
        }

        const ModelClass = createModelClass(modelName, schemaDefinition || {});
        
        if (__defaultConnection && __connections.has(__defaultConnection)) {
            ModelClass.init(__connections.get(__defaultConnection));
        }
        
        modelRegistry.set(modelName, ModelClass);
        
        return ModelClass;
    }

    /**
     * Set the default connection for all models
     * 
     * @param {string} databaseName - Connection name to set as default
     * @throws {Error} If connection not found
     * 
     * @example
     * ```javascript
     * await DB.Connect('primary', { driver: 'postgres', host: 'localhost' });
     * await DB.Connect('secondary', { driver: 'sqlite', filename: './backup.sqlite' });
     * 
     * DB.defaultConnection = 'secondary'; // Switch to secondary database
     * ```
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
     * Get the current default connection name
     * 
     * @returns {string|null} Current default connection name
     * 
     * @example
     * ```javascript
     * console.log(`Current database: ${DB.defaultConnection}`);
     * ```
     */
    static get defaultConnection() {
        return __defaultConnection;
    }

    /**
     * Get connection information by name
     * 
     * @param {string} databaseName - Connection name
     * @returns {ConnectionInfo|null} Connection information or null if not found
     * 
     * @example
     * ```javascript
     * const conn = DB.getConnection('mydb');
     * console.log(conn.driver); // 'sqlite'
     * console.log(conn.config); // Connection configuration
     * ```
     */
    static getConnection(databaseName) {
        return __connections.get(databaseName) || null;
    }

    /**
     * List all active database connections
     * 
     * @returns {string[]} Array of connection names
     * 
     * @example
     * ```javascript
     * const connections = DB.listConnections();
     * console.log('Active connections:', connections);
     * ```
     */
    static listConnections() {
        return Array.from(__connections.keys());
    }

    /**
     * Get all registered models
     * 
     * @returns {Object.<string, ModelClass>} Map of model names to model classes
     * 
     * @example
     * ```javascript
     * const models = DB.listModels();
     * Object.entries(models).forEach(([name, model]) => {
     *   console.log(`Model: ${name}, Table: ${model.tableName}`);
     * });
     * ```
     */
    static listModels() {
        const result = {};
        for (const [name, model] of modelRegistry) {
            result[name] = model;
        }
        return result;
    }

    /**
     * Get collection/table names from the current database
     * 
     * @param {string} [connectionName] - Connection name (uses default if not specified)
     * @returns {Promise<string[]>} Array of collection/table names
     * 
     * @example
     * ```javascript
     * const tables = await DB.listCollections();
     * console.log('Tables:', tables);
     * ```
     */
    static async listCollections(connectionName = null) {
        const conn = connectionName ? __connections.get(connectionName) : __connections.get(__defaultConnection);
        if (!conn) throw new Error('No database connection');
        
        const driver = conn.driver;
        
        if (driver === 'sqlite') {
            const result = await conn.adapter.query(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
            );
            return result.map(r => r.name);
        } else if (driver === 'postgres') {
            const result = await conn.adapter.query(
                "SELECT table_name FROM information_schema.tables WHERE table_schema='public'"
            );
            return result.map(r => r.table_name);
        } else if (driver === 'mysql') {
            const result = await conn.adapter.query("SHOW TABLES");
            return Object.values(result[0] || {});
        } else if (driver === 'mongodb') {
            // For MongoDB simulation, return collection names from storage
            return Array.from(conn.adapter.storage.collections.keys());
        } else if (driver === 'sqlserver') {
            const result = await conn.adapter.query(
                "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE='BASE TABLE'"
            );
            return result.map(r => r.TABLE_NAME);
        }
        
        return [];
    }

    /**
     * Execute a raw query on the default connection
     * 
     * @param {string} sql - SQL query string
     * @param {Array} [params] - Query parameters
     * @returns {Promise<any>} Query results
     * 
     * @example
     * ```javascript
     * const users = await DB.query('SELECT * FROM users WHERE age > ?', [25]);
     * ```
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
     * 
     * @param {string} databaseName - Connection name
     * @param {string} sql - SQL query string
     * @param {Array} [params] - Query parameters
     * @returns {Promise<any>} Query results
     * 
     * @example
     * ```javascript
     * const users = await DB.queryOn('secondary', 'SELECT * FROM users');
     * ```
     */
    static async queryOn(databaseName, sql, params = []) {
        if (!__connections.has(databaseName)) {
            throw new Error(`Connection ${databaseName} not found`);
        }
        const connection = __connections.get(databaseName);
        return connection.adapter.query(sql, params);
    }

    /**
     * Execute a transaction on the default connection
     * 
     * @param {function(Object): Promise<any>} callback - Transaction callback
     * @returns {Promise<any>} Transaction result
     * 
     * @example
     * ```javascript
     * const result = await DB.transaction(async (trx) => {
     *   await trx.query('INSERT INTO users (name) VALUES (?)', ['John']);
     *   await trx.query('INSERT INTO logs (action) VALUES (?)', ['user_created']);
     *   return { success: true };
     * });
     * ```
     */
    static async transaction(callback) {
        if (!__defaultConnection) {
            throw new Error('No database connection established');
        }
        const connection = __connections.get(__defaultConnection);
        return connection.adapter.transaction(callback);
    }

    /**
     * Execute a transaction on a specific connection
     * 
     * @param {string} databaseName - Connection name
     * @param {function(Object): Promise<any>} callback - Transaction callback
     * @returns {Promise<any>} Transaction result
     */
    static async transactionOn(databaseName, callback) {
        if (!__connections.has(databaseName)) {
            throw new Error(`Connection ${databaseName} not found`);
        }
        const connection = __connections.get(databaseName);
        return connection.adapter.transaction(callback);
    }

    /**
     * Disconnect from a specific database
     * 
     * @param {string} databaseName - Connection name to disconnect
     * @returns {Promise<boolean>} True if disconnected successfully
     * 
     * @example
     * ```javascript
     * await DB.Disconnect('mydb');
     * ```
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
     * 
     * @returns {Promise<void>}
     * 
     * @example
     * ```javascript
     * await DB.DisconnectAll();
     * ```
     */
    static async DisconnectAll() {
        for (const dbName of __connections.keys()) {
            await __orm.disconnect(dbName);
        }
        __connections.clear();
        __defaultConnection = null;
        modelRegistry.clear();
        console.log('✅ Disconnected from all databases');
    }

    /**
     * Create a new schema builder
     * 
     * @param {string} [connectionName] - Connection name (uses default if not specified)
     * @returns {import('./MiniORM.js').Schema} Schema builder
     * 
     * @example
     * ```javascript
     * const schema = DB.schema();
     * await schema.create('users', table => {
     *   table.id();
     *   table.string('name');
     *   table.string('email').unique();
     *   table.timestamps();
     * });
     * ```
     */
    static schema(connectionName = null) {
        const conn = connectionName ? __connections.get(connectionName) : __connections.get(__defaultConnection);
        if (!conn) throw new Error('No database connection');
        return __orm.schema(conn.name);
    }

    /**
     * Check if a connection exists
     * 
     * @param {string} databaseName - Connection name to check
     * @returns {boolean} True if connection exists
     */
    static hasConnection(databaseName) {
        return __connections.has(databaseName);
    }

    /**
     * Get database statistics
     * 
     * @param {string} [connectionName] - Connection name (uses default if not specified)
     * @returns {Promise<Object>} Database statistics
     * 
     * @example
     * ```javascript
     * const stats = await DB.getStats();
     * console.log(stats);
     * ```
     */
    static async getStats(connectionName = null) {
        const conn = connectionName ? __connections.get(connectionName) : __connections.get(__defaultConnection);
        if (!conn) throw new Error('No database connection');
        
        const collections = await this.listCollections(connectionName);
        const stats = {
            driver: conn.driver,
            collections: collections.length,
            records: {},
            totalRecords: 0
        };
        
        for (const collection of collections) {
            try {
                const result = await conn.adapter.query(`SELECT COUNT(*) as count FROM ${collection}`);
                const count = result[0]?.count || 0;
                stats.records[collection] = count;
                stats.totalRecords += count;
            } catch (err) {
                stats.records[collection] = 'Error';
            }
        }
        
        return stats;
    }

    /**
     * Backup the database (SQLite only)
     * 
     * @param {string} backupPath - Path for the backup file
     * @param {string} [connectionName] - Connection name (uses default if not specified)
     * @returns {Promise<boolean>} True if backup successful
     */
    static async backup(backupPath, connectionName = null) {
        const conn = connectionName ? __connections.get(connectionName) : __connections.get(__defaultConnection);
        if (!conn) throw new Error('No database connection');
        
        if (conn.driver === 'sqlite' && conn.config.filename) {
            const fs = await import('fs/promises');
            await fs.copyFile(conn.config.filename, backupPath);
            return true;
        }
        
        throw new Error('Backup only supported for SQLite');
    }

    /**
     * Get database version
     * 
     * @param {string} [connectionName] - Connection name (uses default if not specified)
     * @returns {Promise<string>} Database version
     */
    static async getVersion(connectionName = null) {
        const conn = connectionName ? __connections.get(connectionName) : __connections.get(__defaultConnection);
        if (!conn) throw new Error('No database connection');
        
        const driver = conn.driver;
        
        if (driver === 'sqlite') {
            const result = await conn.adapter.query('SELECT sqlite_version() as version');
            return result[0]?.version || 'Unknown';
        } else if (driver === 'postgres') {
            const result = await conn.adapter.query('SELECT version() as version');
            return result[0]?.version || 'Unknown';
        } else if (driver === 'mysql') {
            const result = await conn.adapter.query('SELECT VERSION() as version');
            return result[0]?.version || 'Unknown';
        } else if (driver === 'sqlserver') {
            const result = await conn.adapter.query('SELECT @@VERSION as version');
            return result[0]?.version || 'Unknown';
        }
        
        return 'Unknown';
    }
}

// ==================== Helper Functions ====================

/**
 * Creates a model class with full type inference
 * 
 * @template {Object} T
 * @param {string} modelName 
 * @param {SchemaDefinition} schemaDefinition 
 * @returns {ModelClass<T>}
 */
function createModelClass(modelName, schemaDefinition) {
    const parsedSchema = parseSchema(schemaDefinition);
    
    /**
     * Dynamic Model Class
     * @template {Object} T
     * @extends {BaseModel}
     */
    class DynamicModel extends BaseModel {
        /** @type {string} */
        static tableName = modelName;
        
        /** @type {Object} */
        static schema = parsedSchema.ormSchema;
        
        /**
         * Create a new model instance
         * @param {Partial<T>} [data] - Initial data
         */
        constructor(data = {}) {
            super(data);
        }

        /**
         * Convert to plain object
         * @returns {T}
         */
        toJSON() {
            return /** @type {T} */ ({ ...this._attributes });
        }

        /**
         * Get query builder instance
         * @returns {import('./MiniORM.js').QueryBuilder}
         */
        static query() {
            return super.query();
        }

        /**
         * Get model instance by ID
         * @private
         * @param {string|number} id
         * @returns {Promise<ModelInstance<T> | null>}
         */
        static async _getInstance(id) {
            const query = this.query().where({ [this.primaryKey]: id });
            const results = await query.get();
            return results.length > 0 ? results[0] : null;
        }

        /**
         * Validate data against schema
         * @private
         * @param {Partial<T>} data
         * @throws {Error} If validation fails
         */
        static _validate(data) {
            for (const [field, config] of Object.entries(parsedSchema.validationSchema)) {
                if (config.required && (data[field] === undefined || data[field] === null)) {
                    throw new Error(`Field "${field}" is required`);
                }
            }
        }
    }

    // ==================== CRUD Operations ====================

    /**
     * Create a new record
     * @param {Partial<T>} data - Record data
     * @returns {Promise<ModelInstance<T>>} Created record
     */
    DynamicModel.create = async function(data) {
        this._validate(data);
        
        const model = new this(data);
        await model.save();
        return model.toJSON();
    };

    /**
     * Create multiple records
     * @param {Array<Partial<T>>} itemsArray - Array of records to create
     * @returns {Promise<Array<ModelInstance<T>>>} Created records
     */
    DynamicModel.createMany = async function(itemsArray) {
        const results = [];
        for (const item of itemsArray) {
            results.push(await this.create(item));
        }
        return results;
    };

    /**
     * Find records matching filter
     * @param {Partial<T>} [filter] - Filter conditions
     * @returns {Promise<Array<ModelInstance<T>>>} Matching records
     */
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

    /**
     * Find a single record matching filter
     * @param {Partial<T>} filter - Filter conditions
     * @returns {Promise<ModelInstance<T> | null>} Matching record or null
     */
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

    /**
     * Find record by ID
     * @param {string|number} id - Record ID
     * @returns {Promise<ModelInstance<T> | null>} Found record or null
     */
    DynamicModel.findById = async function(id) {
        if (!id) return null;
        
        const instance = await this._getInstance(id);
        return instance ? instance.toJSON() : null;
    };

    /**
     * Find records by multiple IDs
     * @param {Array<string|number>} ids - Array of IDs
     * @returns {Promise<Array<ModelInstance<T>>>} Found records
     */
    DynamicModel.findByIds = async function(ids) {
        if (!ids || !Array.isArray(ids) || ids.length === 0) return [];
        
        const results = [];
        for (const id of ids) {
            const item = await this.findById(id);
            if (item) results.push(item);
        }
        return results;
    };

    /**
     * Update a record by ID
     * @param {string|number} id - Record ID
     * @param {Partial<T>} data - Update data
     * @returns {Promise<ModelInstance<T>>} Updated record
     * @throws {Error} If record not found
     */
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

    /**
     * Update multiple records matching filter
     * @param {Partial<T>} filter - Filter conditions
     * @param {Partial<T>} data - Update data
     * @returns {Promise<Array<ModelInstance<T>>>} Updated records
     */
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

    /**
     * Update or create a record
     * @param {Partial<T>} filter - Filter conditions
     * @param {Partial<T>} data - Data to save
     * @returns {Promise<ModelInstance<T>>} Updated or created record
     */
    DynamicModel.updateOrCreate = async function(filter, data) {
        const existing = await this.findOne(filter);
        
        if (existing) {
            return await this.update(existing.id, { ...existing, ...data });
        } else {
            return await this.create({ ...filter, ...data });
        }
    };

    /**
     * Delete a record by ID
     * @param {string|number} id - Record ID
     * @returns {Promise<boolean>} True if deleted
     */
    DynamicModel.delete = async function(id) {
        if (!id) return false;
        
        const instance = await this._getInstance(id);
        if (!instance) return false;
        
        await instance.delete();
        return true;
    };

    /**
     * Delete multiple records matching filter
     * @param {Partial<T>} [filter] - Filter conditions
     * @returns {Promise<number>} Number of deleted records
     */
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

    /**
     * Delete all records
     * @returns {Promise<number>} Number of deleted records
     */
    DynamicModel.deleteAll = async function() {
        const instances = await this.query().get();
        let deleted = 0;
        
        for (const instance of instances) {
            await instance.delete();
            deleted++;
        }
        
        return deleted;
    };

    /**
     * Count records matching filter
     * @param {Partial<T>} [filter] - Filter conditions
     * @returns {Promise<number>} Record count
     */
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

    /**
     * Check if records exist matching filter
     * @param {Partial<T>} filter - Filter conditions
     * @returns {Promise<boolean>} True if records exist
     */
    DynamicModel.exists = async function(filter) {
        if (!filter || Object.keys(filter).length === 0) {
            throw new Error('Filter is required for exists check');
        }
        
        const count = await this.count(filter);
        return count > 0;
    };

    /**
     * Get all records
     * @returns {Promise<Array<ModelInstance<T>>>} All records
     */
    DynamicModel.all = async function() {
        return this.find();
    };

    /**
     * Get first record matching filter
     * @param {Partial<T>} [filter] - Filter conditions
     * @returns {Promise<ModelInstance<T> | null>} First record or null
     */
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

    /**
     * Get last record matching filter
     * @param {Partial<T>} [filter] - Filter conditions
     * @returns {Promise<ModelInstance<T> | null>} Last record or null
     */
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

    // ==================== Utility Operations ====================

    /**
     * Pluck a single field from all records
     * @param {keyof T} field - Field to pluck
     * @returns {Promise<Array<any>>} Array of field values
     */
    DynamicModel.pluck = async function(field) {
        const items = await this.find();
        return items.map(item => item[field]);
    };

    /**
     * Pluck fields as key-value pairs
     * @param {keyof T} keyField - Field to use as key
     * @param {keyof T} valueField - Field to use as value
     * @returns {Promise<Object.<string, any>>} Key-value object
     */
    DynamicModel.pluckWithKey = async function(keyField, valueField) {
        const items = await this.find();
        const result = {};
        items.forEach(item => {
            result[item[keyField]] = item[valueField];
        });
        return result;
    };

    /**
     * Get maximum value of a field
     * @param {keyof T} field - Field name
     * @returns {Promise<number | null>} Maximum value
     */
    DynamicModel.max = async function(field) {
        const items = await this.find();
        if (items.length === 0) return null;
        
        return Math.max(...items.map(item => Number(item[field]) || 0));
    };

    /**
     * Get minimum value of a field
     * @param {keyof T} field - Field name
     * @returns {Promise<number | null>} Minimum value
     */
    DynamicModel.min = async function(field) {
        const items = await this.find();
        if (items.length === 0) return null;
        
        return Math.min(...items.map(item => Number(item[field]) || 0));
    };

    /**
     * Get sum of a field
     * @param {keyof T} field - Field name
     * @param {Partial<T>} [filter] - Filter conditions
     * @returns {Promise<number>} Sum of values
     */
    DynamicModel.sum = async function(field, filter = {}) {
        const items = await this.find(filter);
        return items.reduce((acc, item) => acc + (Number(item[field]) || 0), 0);
    };

    /**
     * Get average of a field
     * @param {keyof T} field - Field name
     * @param {Partial<T>} [filter] - Filter conditions
     * @returns {Promise<number>} Average value
     */
    DynamicModel.avg = async function(field, filter = {}) {
        const items = await this.find(filter);
        if (items.length === 0) return 0;
        
        const sum = items.reduce((acc, item) => acc + (Number(item[field]) || 0), 0);
        return sum / items.length;
    };

    /**
     * Truncate the table
     * @returns {Promise<boolean>} True if successful
     */
    DynamicModel.truncate = async function() {
        const connection = __connections.get(__defaultConnection);
        await connection.adapter.query(`DELETE FROM ${modelName}`);
        
        // Reset auto-increment for SQLite
        if (connection.driver === 'sqlite') {
            await connection.adapter.query(`DELETE FROM sqlite_sequence WHERE name='${modelName}'`);
        }
        
        return true;
    };

    /**
     * Process records in chunks
     * @param {number} size - Chunk size
     * @param {function(Array<ModelInstance<T>>, number): Promise<any>} callback - Chunk callback
     * @returns {Promise<number>} Number of chunks processed
     */
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

    /**
     * Process each record individually
     * @param {function(ModelInstance<T>, number): Promise<any>} callback - Item callback
     * @returns {Promise<number>} Number of records processed
     */
    DynamicModel.each = async function(callback) {
        const items = await this.find();
        
        for (let i = 0; i < items.length; i++) {
            await callback(items[i], i);
        }
        
        return items.length;
    };

    /**
     * Toggle a boolean field
     * @param {string|number} id - Record ID
     * @param {keyof T} field - Field to toggle
     * @returns {Promise<ModelInstance<T>>} Updated record
     * @throws {Error} If record not found
     */
    DynamicModel.toggle = async function(id, field) {
        const instance = await this._getInstance(id);
        if (!instance) throw new Error(`Item with id ${id} not found`);
        
        instance._attributes[field] = !instance._attributes[field];
        await instance.save();
        
        return instance.toJSON();
    };

    /**
     * Increment a numeric field
     * @param {string|number} id - Record ID
     * @param {keyof T} field - Field to increment
     * @param {number} [amount=1] - Increment amount
     * @returns {Promise<ModelInstance<T>>} Updated record
     * @throws {Error} If record not found
     */
    DynamicModel.increment = async function(id, field, amount = 1) {
        const instance = await this._getInstance(id);
        if (!instance) throw new Error(`Item with id ${id} not found`);
        
        instance._attributes[field] = (Number(instance._attributes[field]) || 0) + amount;
        await instance.save();
        
        return instance.toJSON();
    };

    /**
     * Decrement a numeric field
     * @param {string|number} id - Record ID
     * @param {keyof T} field - Field to decrement
     * @param {number} [amount=1] - Decrement amount
     * @returns {Promise<ModelInstance<T>>} Updated record
     */
    DynamicModel.decrement = async function(id, field, amount = 1) {
        return this.increment(id, field, -amount);
    };

    /**
     * Paginate results
     * @param {number} [page=1] - Page number
     * @param {number} [perPage=15] - Items per page
     * @param {Partial<T>} [filter] - Filter conditions
     * @returns {Promise<PaginatedResult<T>>} Paginated results
     */
    DynamicModel.paginate = async function(page = 1, perPage = 15, filter = {}) {
        const offset = (page - 1) * perPage;
        const query = this.query();
        
        if (Object.keys(filter).length > 0) {
            Object.entries(filter).forEach(([key, value]) => {
                if (value !== undefined && value !== null) {
                    query.where({ [key]: value });
                }
            });
        }
        
        const [data, total] = await Promise.all([
            query.limit(perPage).offset(offset).get(),
            this.count(filter)
        ]);
        
        return {
            data: data.map(d => d.toJSON()),
            meta: {
                current_page: page,
                per_page: perPage,
                total,
                last_page: Math.ceil(total / perPage),
                from: offset + 1,
                to: Math.min(offset + perPage, total)
            }
        };
    };

    /**
     * Get distinct values of a field
     * @param {keyof T} field - Field name
     * @param {Partial<T>} [filter] - Filter conditions
     * @returns {Promise<Array<any>>} Distinct values
     */
    DynamicModel.distinct = async function(field, filter = {}) {
        const items = await this.find(filter);
        const values = new Set();
        items.forEach(item => values.add(item[field]));
        return Array.from(values);
    };

    /**
     * Get random records
     * @param {number} [count=1] - Number of random records
     * @param {Partial<T>} [filter] - Filter conditions
     * @returns {Promise<Array<ModelInstance<T>>>} Random records
     */
    DynamicModel.random = async function(count = 1, filter = {}) {
        const items = await this.find(filter);
        const shuffled = [...items].sort(() => 0.5 - Math.random());
        return shuffled.slice(0, count);
    };

    return DynamicModel;
}

/**
 * Parse schema definition to ORM schema
 * @param {SchemaDefinition} schemaDefinition 
 * @returns {Object}
 */
function parseSchema(schemaDefinition) {
    const ormSchema = {};
    const validationSchema = {};
    
    for (const [fieldName, fieldConfig] of Object.entries(schemaDefinition)) {
        let type = 'string';
        let required = false;
        let defaultValue = undefined;
        
        if (typeof fieldConfig === 'string') {
            type = fieldConfig;
        } else if (typeof fieldConfig === 'object') {
            type = fieldConfig.type || 'string';
            required = fieldConfig.required || false;
            defaultValue = fieldConfig.default;
        }
        
        const mappedType = mapType(type);
        
        ormSchema[fieldName] = {
            type: mappedType
        };
        
        validationSchema[fieldName] = {
            type: mappedType,
            required,
            default: defaultValue
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