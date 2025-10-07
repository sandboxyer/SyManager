import ProcessManager from './ProcessManager.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * @typedef {Object} QueryOptions
 * @property {number} [limit] - Maximum number of documents to return
 * @property {number} [skip] - Number of documents to skip
 * @property {Object} [sort] - Sort order (e.g., { field: 1 } for ascending, { field: -1 } for descending)
 * @property {Object} [projection] - Field projection (e.g., { field: 1 } to include, { field: 0 } to exclude)
 */

/**
 * @typedef {Object} UpdateOptions
 * @property {boolean} [upsert=false] - Create document if it doesn't exist
 * @property {boolean} [multi=false] - Update multiple documents
 */

/**
 * @typedef {Object} Transaction
 * @property {string} id - Transaction ID
 * @property {string} collection - Collection name
 * @property {string} operation - Operation type (insert, update, delete)
 * @property {Object} data - Document data
 * @property {Date} timestamp - Transaction timestamp
 * @property {string} status - Transaction status (pending, committed, rolledback)
 */

/**
 * @typedef {Object} IndexDefinition
 * @property {Object} fields - Field definitions for index
 * @property {boolean} [unique=false] - Whether index should be unique
 * @property {string} [name] - Index name (auto-generated if not provided)
 */

/**
 * SystemStorage - A MongoDB-like database system with ACID support
 * @class
 */
class SystemStorage {
    /** @private */
    static _initialized = false;
    
    /** @private */
    static _basePath = path.resolve('./system_storage');
    
    /** @private */
    static _collections = new Map();
    
    /** @private */
    static _indexes = new Map();
    
    /** @private */
    static _transactions = new Map();
    
    /** @private */
    static _currentTransaction = null;
    
    /** @private */
    static _processManager = null;

    /**
     * Initialize the SystemStorage database
     * @param {Object} [options] - Configuration options
     * @param {string} [options.storagePath] - Custom storage path
     * @param {boolean} [options.autoRecover=true] - Enable automatic recovery on startup
     * @returns {Promise<boolean>} Success status
     * @throws {Error} If initialization fails
     * @example
     * await SystemStorage.init({ storagePath: './my-data' });
     */
    static async init(options = {}) {
        if (this._initialized) {
            console.warn('SystemStorage is already initialized');
            return true;
        }

        try {
            this._basePath = options.storagePath || this._basePath;
            
            // Ensure storage directory exists
            if (!fs.existsSync(this._basePath)) {
                fs.mkdirSync(this._basePath, { recursive: true });
            }

            // Ensure collections directory exists
            const collectionsPath = path.join(this._basePath, 'collections');
            if (!fs.existsSync(collectionsPath)) {
                fs.mkdirSync(collectionsPath, { recursive: true });
            }

            // Ensure indexes directory exists
            const indexesPath = path.join(this._basePath, 'indexes');
            if (!fs.existsSync(indexesPath)) {
                fs.mkdirSync(indexesPath, { recursive: true });
            }

            // Ensure transactions directory exists
            const transactionsPath = path.join(this._basePath, 'transactions');
            if (!fs.existsSync(transactionsPath)) {
                fs.mkdirSync(transactionsPath, { recursive: true });
            }

            // Load existing collections
            await this._loadExistingCollections();

            // Initialize process manager for cross-process communication
            this._processManager = ProcessManager;

            // Auto-recover if enabled
            if (options.autoRecover !== false) {
                await this._recoverTransactions();
            }

            this._initialized = true;
            console.log(`SystemStorage initialized at: ${this._basePath}`);
            return true;

        } catch (error) {
            console.error('SystemStorage initialization failed:', error);
            throw error;
        }
    }

    /**
     * Create a new collection
     * @param {string} collectionName - Name of the collection to create
     * @param {Object} [options] - Collection options
     * @param {IndexDefinition[]} [options.indexes] - Array of index definitions
     * @returns {Promise<boolean>} Success status
     * @throws {Error} If collection creation fails
     * @example
     * await SystemStorage.createCollection('users', {
     *   indexes: [
     *     { fields: { email: 1 }, unique: true },
     *     { fields: { createdAt: -1 } }
     *   ]
     * });
     */
    static async createCollection(collectionName, options = {}) {
        this._checkInitialized();

        if (this._collections.has(collectionName)) {
            throw new Error(`Collection '${collectionName}' already exists`);
        }

        try {
            const collectionPath = this._getCollectionPath(collectionName);
            const indexPath = this._getIndexPath(collectionName);

            // Create collection file
            fs.writeFileSync(collectionPath, JSON.stringify([]));

            // Initialize indexes
            this._indexes.set(collectionName, new Map());
            fs.writeFileSync(indexPath, JSON.stringify([]));

            // Register collection FIRST
            this._collections.set(collectionName, {
                name: collectionName,
                path: collectionPath,
                createdAt: new Date(),
                documentCount: 0
            });

            // Create specified indexes AFTER collection is registered
            if (options.indexes && Array.isArray(options.indexes)) {
                for (const indexDef of options.indexes) {
                    await this.createIndex(collectionName, indexDef);
                }
            }

            return true;

        } catch (error) {
            // Clean up if creation fails
            if (this._collections.has(collectionName)) {
                this._collections.delete(collectionName);
            }
            if (this._indexes.has(collectionName)) {
                this._indexes.delete(collectionName);
            }
            
            console.error(`Failed to create collection '${collectionName}':`, error);
            throw error;
        }
    }

    /**
     * Drop a collection and all its data
     * @param {string} collectionName - Name of the collection to drop
     * @returns {Promise<boolean>} Success status
     * @throws {Error} If collection drop fails
     * @example
     * await SystemStorage.dropCollection('users');
     */
    static async dropCollection(collectionName) {
        this._checkInitialized();

        if (!this._collections.has(collectionName)) {
            throw new Error(`Collection '${collectionName}' does not exist`);
        }

        try {
            const collectionPath = this._getCollectionPath(collectionName);
            const indexPath = this._getIndexPath(collectionName);

            // Remove files
            if (fs.existsSync(collectionPath)) {
                fs.unlinkSync(collectionPath);
            }
            if (fs.existsSync(indexPath)) {
                fs.unlinkSync(indexPath);
            }

            // Remove from memory
            this._collections.delete(collectionName);
            this._indexes.delete(collectionName);

            return true;

        } catch (error) {
            console.error(`Failed to drop collection '${collectionName}':`, error);
            throw error;
        }
    }

    /**
     * List all collections
     * @returns {string[]} Array of collection names
     * @example
     * const collections = SystemStorage.listCollections();
     * console.log(collections); // ['users', 'products']
     */
    static listCollections() {
        this._checkInitialized();
        return Array.from(this._collections.keys());
    }

    /**
     * Create an index on a collection
     * @param {string} collectionName - Collection name
     * @param {IndexDefinition} indexDef - Index definition
     * @returns {Promise<boolean>} Success status
     * @throws {Error} If index creation fails
     * @example
     * await SystemStorage.createIndex('users', {
     *   fields: { email: 1 },
     *   unique: true,
     *   name: 'email_unique_index'
     * });
     */
    static async createIndex(collectionName, indexDef) {
        this._checkInitialized();

        if (!this._collections.has(collectionName)) {
            throw new Error(`Collection '${collectionName}' does not exist`);
        }

        try {
            const indexName = indexDef.name || this._generateIndexName(indexDef.fields);
            const collectionIndexes = this._indexes.get(collectionName);
            
            if (collectionIndexes.has(indexName)) {
                throw new Error(`Index '${indexName}' already exists on collection '${collectionName}'`);
            }

            // Build index
            const documents = await this._loadCollection(collectionName);
            const index = new Map();

            for (const doc of documents) {
                const key = this._generateIndexKey(doc, indexDef.fields);
                
                if (indexDef.unique && index.has(key)) {
                    throw new Error(`Duplicate key error for unique index '${indexName}'`);
                }
                
                if (!index.has(key)) {
                    index.set(key, []);
                }
                index.get(key).push(doc._id);
            }

            // Save index
            collectionIndexes.set(indexName, {
                name: indexName,
                fields: indexDef.fields,
                unique: indexDef.unique || false,
                data: index
            });

            await this._saveIndexes(collectionName);
            return true;

        } catch (error) {
            console.error(`Failed to create index on '${collectionName}':`, error);
            throw error;
        }
    }

    /**
     * Start a new transaction
     * @returns {string} Transaction ID
     * @throws {Error} If transaction cannot be started
     * @example
     * const txId = SystemStorage.startTransaction();
     */
    static startTransaction() {
        this._checkInitialized();

        if (this._currentTransaction) {
            throw new Error('Transaction already in progress');
        }

        const transactionId = crypto.randomBytes(16).toString('hex');
        this._currentTransaction = {
            id: transactionId,
            operations: [],
            startedAt: new Date(),
            status: 'active'
        };

        this._transactions.set(transactionId, this._currentTransaction);
        return transactionId;
    }

    /**
     * Commit the current transaction
     * @param {string} transactionId - Transaction ID to commit
     * @returns {Promise<boolean>} Success status
     * @throws {Error} If commit fails
     * @example
     * await SystemStorage.commitTransaction(txId);
     */
    static async commitTransaction(transactionId) {
        this._checkInitialized();

        const transaction = this._transactions.get(transactionId);
        if (!transaction) {
            throw new Error(`Transaction '${transactionId}' not found`);
        }

        if (transaction.status !== 'active') {
            throw new Error(`Transaction '${transactionId}' is not active`);
        }

        try {
            // Apply all operations
            for (const operation of transaction.operations) {
                await this._applyOperation(operation);
            }

            transaction.status = 'committed';
            transaction.committedAt = new Date();
            this._currentTransaction = null;

            // Clean up transaction file
            const txPath = this._getTransactionPath(transactionId);
            if (fs.existsSync(txPath)) {
                fs.unlinkSync(txPath);
            }

            return true;

        } catch (error) {
            // Rollback on error
            await this.rollbackTransaction(transactionId);
            throw error;
        }
    }

    /**
     * Rollback the current transaction
     * @param {string} transactionId - Transaction ID to rollback
     * @returns {Promise<boolean>} Success status
     * @throws {Error} If rollback fails
     * @example
     * await SystemStorage.rollbackTransaction(txId);
     */
    static async rollbackTransaction(transactionId) {
        this._checkInitialized();

        const transaction = this._transactions.get(transactionId);
        if (!transaction) {
            throw new Error(`Transaction '${transactionId}' not found`);
        }

        transaction.status = 'rolledback';
        transaction.rolledbackAt = new Date();
        this._currentTransaction = null;

        // Clean up transaction file
        const txPath = this._getTransactionPath(transactionId);
        if (fs.existsSync(txPath)) {
            fs.unlinkSync(txPath);
        }

        return true;
    }

    /**
     * Insert a document into a collection
     * @param {string} collectionName - Collection name
     * @param {Object} document - Document to insert
     * @param {Object} [options] - Insert options
     * @param {string} [options.transactionId] - Transaction ID for ACID operation
     * @returns {Promise<Object>} Inserted document with _id
     * @throws {Error} If insert fails
     * @example
     * const user = await SystemStorage.insertOne('users', {
     *   name: 'John Doe',
     *   email: 'john@example.com',
     *   age: 30
     * });
     */
    static async insertOne(collectionName, document, options = {}) {
        this._checkInitialized();

        if (!this._collections.has(collectionName)) {
            throw new Error(`Collection '${collectionName}' does not exist`);
        }

        try {
            const documents = await this._loadCollection(collectionName);
            const docWithId = {
                _id: crypto.randomBytes(16).toString('hex'),
                ...document,
                _createdAt: new Date(),
                _updatedAt: new Date()
            };

            if (options.transactionId) {
                // Add to transaction
                const transaction = this._transactions.get(options.transactionId);
                if (transaction) {
                    transaction.operations.push({
                        type: 'insert',
                        collection: collectionName,
                        document: docWithId
                    });
                }
            } else {
                // Immediate insert
                documents.push(docWithId);
                await this._saveCollection(collectionName, documents);
                await this._updateIndexes(collectionName, 'insert', docWithId);
            }

            return docWithId;

        } catch (error) {
            console.error(`Failed to insert document into '${collectionName}':`, error);
            throw error;
        }
    }

    /**
     * Insert multiple documents into a collection
     * @param {string} collectionName - Collection name
     * @param {Object[]} documents - Array of documents to insert
     * @param {Object} [options] - Insert options
     * @param {string} [options.transactionId] - Transaction ID for ACID operation
     * @returns {Promise<Object[]>} Array of inserted documents with _ids
     * @throws {Error} If insert fails
     * @example
     * const users = await SystemStorage.insertMany('users', [
     *   { name: 'John', email: 'john@example.com' },
     *   { name: 'Jane', email: 'jane@example.com' }
     * ]);
     */
    static async insertMany(collectionName, documents, options = {}) {
        this._checkInitialized();

        if (!this._collections.has(collectionName)) {
            throw new Error(`Collection '${collectionName}' does not exist`);
        }

        try {
            const collectionDocs = await this._loadCollection(collectionName);
            const docsWithIds = documents.map(doc => ({
                _id: crypto.randomBytes(16).toString('hex'),
                ...doc,
                _createdAt: new Date(),
                _updatedAt: new Date()
            }));

            if (options.transactionId) {
                // Add to transaction
                const transaction = this._transactions.get(options.transactionId);
                if (transaction) {
                    transaction.operations.push({
                        type: 'insertMany',
                        collection: collectionName,
                        documents: docsWithIds
                    });
                }
            } else {
                // Immediate insert
                collectionDocs.push(...docsWithIds);
                await this._saveCollection(collectionName, collectionDocs);
                
                // Update indexes
                for (const doc of docsWithIds) {
                    await this._updateIndexes(collectionName, 'insert', doc);
                }
            }

            return docsWithIds;

        } catch (error) {
            console.error(`Failed to insert documents into '${collectionName}':`, error);
            throw error;
        }
    }

    /**
     * Find a single document by query
     * @param {string} collectionName - Collection name
     * @param {Object} query - Query object
     * @param {Object} [options] - Find options
     * @param {Object} [options.projection] - Field projection
     * @returns {Promise<Object|null>} Found document or null
     * @throws {Error} If find fails
     * @example
     * const user = await SystemStorage.findOne('users', { email: 'john@example.com' });
     * const userWithProjection = await SystemStorage.findOne('users', 
     *   { email: 'john@example.com' }, 
     *   { projection: { name: 1, email: 1 } }
     * );
     */
    static async findOne(collectionName, query, options = {}) {
        this._checkInitialized();

        if (!this._collections.has(collectionName)) {
            throw new Error(`Collection '${collectionName}' does not exist`);
        }

        try {
            const documents = await this._loadCollection(collectionName);
            const result = documents.find(doc => this._matchesQuery(doc, query));

            if (!result) return null;

            return options.projection ? 
                this._applyProjection(result, options.projection) : 
                result;

        } catch (error) {
            console.error(`Failed to find document in '${collectionName}':`, error);
            throw error;
        }
    }

    /**
     * Find multiple documents by query
     * @param {string} collectionName - Collection name
     * @param {Object} query - Query object
     * @param {QueryOptions} [options] - Find options
     * @returns {Promise<Object[]>} Array of found documents
     * @throws {Error} If find fails
     * @example
     * const users = await SystemStorage.find('users', { age: { $gte: 18 } });
     * const paginatedUsers = await SystemStorage.find('users', 
     *   {}, 
     *   { limit: 10, skip: 20, sort: { createdAt: -1 } }
     * );
     */
    static async find(collectionName, query = {}, options = {}) {
        this._checkInitialized();

        if (!this._collections.has(collectionName)) {
            throw new Error(`Collection '${collectionName}' does not exist`);
        }

        try {
            let documents = await this._loadCollection(collectionName);
            
            // Apply query filter
            documents = documents.filter(doc => this._matchesQuery(doc, query));

            // Apply sorting
            if (options.sort) {
                documents.sort(this._createSortFunction(options.sort));
            }

            // Apply skip and limit
            if (options.skip) {
                documents = documents.slice(options.skip);
            }
            if (options.limit) {
                documents = documents.slice(0, options.limit);
            }

            // Apply projection
            if (options.projection) {
                documents = documents.map(doc => this._applyProjection(doc, options.projection));
            }

            return documents;

        } catch (error) {
            console.error(`Failed to find documents in '${collectionName}':`, error);
            throw error;
        }
    }

    /**
     * Update a single document
     * @param {string} collectionName - Collection name
     * @param {Object} query - Query object to find document
     * @param {Object} update - Update operations
     * @param {UpdateOptions} [options] - Update options
     * @param {string} [options.transactionId] - Transaction ID for ACID operation
     * @returns {Promise<Object|null>} Update result
     * @throws {Error} If update fails
     * @example
     * const result = await SystemStorage.updateOne(
     *   'users',
     *   { email: 'john@example.com' },
     *   { $set: { age: 31, lastLogin: new Date() } }
     * );
     */
    static async updateOne(collectionName, query, update, options = {}) {
        this._checkInitialized();

        if (!this._collections.has(collectionName)) {
            throw new Error(`Collection '${collectionName}' does not exist`);
        }

        try {
            const documents = await this._loadCollection(collectionName);
            const index = documents.findIndex(doc => this._matchesQuery(doc, query));

            if (index === -1) {
                if (options.upsert) {
                    // Insert new document
                    const newDoc = { ...query, ...this._extractSetOperations(update) };
                    return await this.insertOne(collectionName, newDoc, options);
                }
                return { matchedCount: 0, modifiedCount: 0, upsertedId: null };
            }

            const oldDoc = documents[index];
            const updatedDoc = this._applyUpdate(oldDoc, update);

            if (options.transactionId) {
                // Add to transaction
                const transaction = this._transactions.get(options.transactionId);
                if (transaction) {
                    transaction.operations.push({
                        type: 'update',
                        collection: collectionName,
                        query: query,
                        update: update,
                        oldDocument: oldDoc,
                        newDocument: updatedDoc
                    });
                }
            } else {
                // Immediate update
                documents[index] = updatedDoc;
                await this._saveCollection(collectionName, documents);
                await this._updateIndexes(collectionName, 'update', updatedDoc, oldDoc);
            }

            return {
                matchedCount: 1,
                modifiedCount: 1,
                upsertedId: null
            };

        } catch (error) {
            console.error(`Failed to update document in '${collectionName}':`, error);
            throw error;
        }
    }

    /**
     * Delete a single document
     * @param {string} collectionName - Collection name
     * @param {Object} query - Query object to find document
     * @param {Object} [options] - Delete options
     * @param {string} [options.transactionId] - Transaction ID for ACID operation
     * @returns {Promise<Object>} Delete result
     * @throws {Error} If delete fails
     * @example
     * const result = await SystemStorage.deleteOne('users', { email: 'john@example.com' });
     */
    static async deleteOne(collectionName, query, options = {}) {
        this._checkInitialized();

        if (!this._collections.has(collectionName)) {
            throw new Error(`Collection '${collectionName}' does not exist`);
        }

        try {
            const documents = await this._loadCollection(collectionName);
            const index = documents.findIndex(doc => this._matchesQuery(doc, query));

            if (index === -1) {
                return { deletedCount: 0 };
            }

            const deletedDoc = documents[index];

            if (options.transactionId) {
                // Add to transaction
                const transaction = this._transactions.get(options.transactionId);
                if (transaction) {
                    transaction.operations.push({
                        type: 'delete',
                        collection: collectionName,
                        query: query,
                        document: deletedDoc
                    });
                }
            } else {
                // Immediate delete
                documents.splice(index, 1);
                await this._saveCollection(collectionName, documents);
                await this._updateIndexes(collectionName, 'delete', deletedDoc);
            }

            return { deletedCount: 1 };

        } catch (error) {
            console.error(`Failed to delete document from '${collectionName}':`, error);
            throw error;
        }
    }

    /**
     * Count documents matching query
     * @param {string} collectionName - Collection name
     * @param {Object} [query] - Query object
     * @returns {Promise<number>} Document count
     * @throws {Error} If count fails
     * @example
     * const count = await SystemStorage.count('users', { age: { $gte: 18 } });
     */
    static async count(collectionName, query = {}) {
        this._checkInitialized();

        if (!this._collections.has(collectionName)) {
            throw new Error(`Collection '${collectionName}' does not exist`);
        }

        try {
            const documents = await this._loadCollection(collectionName);
            return documents.filter(doc => this._matchesQuery(doc, query)).length;

        } catch (error) {
            console.error(`Failed to count documents in '${collectionName}':`, error);
            throw error;
        }
    }

    /**
     * Get database statistics
     * @returns {Promise<Object>} Database statistics
     * @example
     * const stats = await SystemStorage.stats();
     * console.log(stats);
     */
    static async stats() {
        this._checkInitialized();

        const stats = {
            collections: {},
            totalCollections: this._collections.size,
            totalIndexes: 0,
            totalTransactions: this._transactions.size,
            storagePath: this._basePath,
            initializedAt: new Date()
        };

        for (const [collectionName, collection] of this._collections) {
            const documents = await this._loadCollection(collectionName);
            const indexes = this._indexes.get(collectionName);

            stats.collections[collectionName] = {
                documentCount: documents.length,
                indexCount: indexes ? indexes.size : 0,
                storageSize: this._getCollectionSize(collectionName),
                indexes: indexes ? Array.from(indexes.keys()) : []
            };

            stats.totalIndexes += indexes ? indexes.size : 0;
        }

        return stats;
    }

    /** @private */
    static _checkInitialized() {
        if (!this._initialized) {
            throw new Error('SystemStorage not initialized. Call SystemStorage.init() first.');
        }
    }

    /** @private */
    static _getCollectionPath(collectionName) {
        return path.join(this._basePath, 'collections', `${collectionName}.json`);
    }

    /** @private */
    static _getIndexPath(collectionName) {
        return path.join(this._basePath, 'indexes', `${collectionName}.json`);
    }

    /** @private */
    static _getTransactionPath(transactionId) {
        return path.join(this._basePath, 'transactions', `${transactionId}.json`);
    }

    /** @private */
    static async _loadCollection(collectionName) {
        const collectionPath = this._getCollectionPath(collectionName);
        
        if (!fs.existsSync(collectionPath)) {
            return [];
        }

        try {
            const data = fs.readFileSync(collectionPath, 'utf8');
            return JSON.parse(data);
        } catch (error) {
            console.error(`Failed to load collection '${collectionName}':`, error);
            return [];
        }
    }

    /** @private */
    static async _saveCollection(collectionName, documents) {
        const collectionPath = this._getCollectionPath(collectionName);
        
        try {
            const data = JSON.stringify(documents, null, 2);
            fs.writeFileSync(collectionPath, data, 'utf8');
        } catch (error) {
            console.error(`Failed to save collection '${collectionName}':`, error);
            throw error;
        }
    }

    /** @private */
    static async _saveIndexes(collectionName) {
        const indexes = this._indexes.get(collectionName);
        if (!indexes) return;

        const indexPath = this._getIndexPath(collectionName);
        const indexData = Array.from(indexes.values()).map(index => ({
            name: index.name,
            fields: index.fields,
            unique: index.unique
        }));

        try {
            fs.writeFileSync(indexPath, JSON.stringify(indexData, null, 2), 'utf8');
        } catch (error) {
            console.error(`Failed to save indexes for '${collectionName}':`, error);
            throw error;
        }
    }

    /** @private */
    static _generateIndexName(fields) {
        return Object.keys(fields)
            .map(field => `${field}_${fields[field]}`)
            .join('_') + '_index';
    }

    /** @private */
    static _generateIndexKey(document, fields) {
        return Object.keys(fields)
            .map(field => {
                const value = this._getNestedValue(document, field);
                return value !== undefined ? JSON.stringify(value) : 'null';
            })
            .join('|');
    }

    /** @private */
    static _getNestedValue(obj, path) {
        return path.split('.').reduce((current, key) => {
            return current && current[key] !== undefined ? current[key] : undefined;
        }, obj);
    }

    /** @private */
    static _matchesQuery(document, query) {
        for (const [key, value] of Object.entries(query)) {
            if (key.startsWith('$')) {
                // Handle operators
                if (!this._matchesOperator(document, key, value)) {
                    return false;
                }
            } else {
                // Simple field match
                const docValue = this._getNestedValue(document, key);
                if (docValue !== value) {
                    return false;
                }
            }
        }
        return true;
    }

    /** @private */
    static _matchesOperator(document, operator, value) {
        switch (operator) {
            case '$gte':
                return Object.keys(value).every(field => {
                    const docValue = this._getNestedValue(document, field);
                    return docValue >= value[field];
                });
            case '$lte':
                return Object.keys(value).every(field => {
                    const docValue = this._getNestedValue(document, field);
                    return docValue <= value[field];
                });
            case '$gt':
                return Object.keys(value).every(field => {
                    const docValue = this._getNestedValue(document, field);
                    return docValue > value[field];
                });
            case '$lt':
                return Object.keys(value).every(field => {
                    const docValue = this._getNestedValue(document, field);
                    return docValue < value[field];
                });
            case '$in':
                return Object.keys(value).every(field => {
                    const docValue = this._getNestedValue(document, field);
                    return Array.isArray(value[field]) && value[field].includes(docValue);
                });
            case '$ne':
                return Object.keys(value).every(field => {
                    const docValue = this._getNestedValue(document, field);
                    return docValue !== value[field];
                });
            default:
                return false;
        }
    }

    /** @private */
    static _applyProjection(document, projection) {
        const result = {};
        
        for (const [field, include] of Object.entries(projection)) {
            if (include) {
                const value = this._getNestedValue(document, field);
                if (value !== undefined) {
                    this._setNestedValue(result, field, value);
                }
            }
        }
        
        // Always include _id unless explicitly excluded
        if (projection._id !== 0) {
            result._id = document._id;
        }
        
        return result;
    }

    /** @private */
    static _setNestedValue(obj, path, value) {
        const keys = path.split('.');
        const lastKey = keys.pop();
        const target = keys.reduce((current, key) => {
            if (!current[key]) current[key] = {};
            return current[key];
        }, obj);
        
        target[lastKey] = value;
    }

    /** @private */
    static _createSortFunction(sort) {
        return (a, b) => {
            for (const [field, direction] of Object.entries(sort)) {
                const aValue = this._getNestedValue(a, field);
                const bValue = this._getNestedValue(b, field);
                
                if (aValue < bValue) return direction === 1 ? -1 : 1;
                if (aValue > bValue) return direction === 1 ? 1 : -1;
            }
            return 0;
        };
    }

    /** @private */
    static _applyUpdate(document, update) {
        const updatedDoc = { ...document, _updatedAt: new Date() };
        
        for (const [operator, operations] of Object.entries(update)) {
            switch (operator) {
                case '$set':
                    for (const [field, value] of Object.entries(operations)) {
                        this._setNestedValue(updatedDoc, field, value);
                    }
                    break;
                case '$unset':
                    for (const field of Object.keys(operations)) {
                        this._unsetNestedValue(updatedDoc, field);
                    }
                    break;
                case '$inc':
                    for (const [field, increment] of Object.entries(operations)) {
                        const currentValue = this._getNestedValue(updatedDoc, field) || 0;
                        this._setNestedValue(updatedDoc, field, currentValue + increment);
                    }
                    break;
                // Add more operators as needed
            }
        }
        
        return updatedDoc;
    }

    /** @private */
    static _unsetNestedValue(obj, path) {
        const keys = path.split('.');
        const lastKey = keys.pop();
        const target = keys.reduce((current, key) => {
            return current && current[key];
        }, obj);
        
        if (target && target[lastKey] !== undefined) {
            delete target[lastKey];
        }
    }

    /** @private */
    static _extractSetOperations(update) {
        return update.$set || {};
    }

    /** @private */
    static async _updateIndexes(collectionName, operation, newDoc, oldDoc = null) {
        const indexes = this._indexes.get(collectionName);
        if (!indexes) return;

        for (const [indexName, index] of indexes) {
            switch (operation) {
                case 'insert':
                    const newKey = this._generateIndexKey(newDoc, index.fields);
                    if (!index.data.has(newKey)) {
                        index.data.set(newKey, []);
                    }
                    index.data.get(newKey).push(newDoc._id);
                    break;
                    
                case 'update':
                    const oldKey = this._generateIndexKey(oldDoc, index.fields);
                    const updatedKey = this._generateIndexKey(newDoc, index.fields);
                    
                    if (oldKey !== updatedKey) {
                        // Remove from old key
                        if (index.data.has(oldKey)) {
                            const ids = index.data.get(oldKey);
                            const newIds = ids.filter(id => id !== oldDoc._id);
                            if (newIds.length === 0) {
                                index.data.delete(oldKey);
                            } else {
                                index.data.set(oldKey, newIds);
                            }
                        }
                        
                        // Add to new key
                        if (!index.data.has(updatedKey)) {
                            index.data.set(updatedKey, []);
                        }
                        index.data.get(updatedKey).push(newDoc._id);
                    }
                    break;
                    
                case 'delete':
                    const deleteKey = this._generateIndexKey(newDoc, index.fields);
                    if (index.data.has(deleteKey)) {
                        const ids = index.data.get(deleteKey);
                        const newIds = ids.filter(id => id !== newDoc._id);
                        if (newIds.length === 0) {
                            index.data.delete(deleteKey);
                        } else {
                            index.data.set(deleteKey, newIds);
                        }
                    }
                    break;
            }
        }
    }

    /** @private */
    static async _applyOperation(operation) {
        switch (operation.type) {
            case 'insert':
                await this.insertOne(operation.collection, operation.document);
                break;
            case 'insertMany':
                await this.insertMany(operation.collection, operation.documents);
                break;
            case 'update':
                await this.updateOne(operation.collection, operation.query, 
                    { $set: this._extractSetOperations(operation.update) });
                break;
            case 'delete':
                await this.deleteOne(operation.collection, operation.query);
                break;
        }
    }

    /** @private */
    static async _recoverTransactions() {
        const transactionsPath = path.join(this._basePath, 'transactions');
        
        if (!fs.existsSync(transactionsPath)) {
            return;
        }

        try {
            const files = fs.readdirSync(transactionsPath);
            
            for (const file of files) {
                if (file.endsWith('.json')) {
                    const txPath = path.join(transactionsPath, file);
                    const txData = JSON.parse(fs.readFileSync(txPath, 'utf8'));
                    
                    if (txData.status === 'active') {
                        // This transaction was interrupted, roll it back
                        console.warn(`Rolling back interrupted transaction: ${txData.id}`);
                        await this.rollbackTransaction(txData.id);
                    }
                }
            }
        } catch (error) {
            console.error('Failed to recover transactions:', error);
        }
    }

    /** @private */
    static _getCollectionSize(collectionName) {
        const collectionPath = this._getCollectionPath(collectionName);
        
        try {
            const stats = fs.statSync(collectionPath);
            return stats.size;
        } catch (error) {
            return 0;
        }
    }

    /** @private */
    static async _loadExistingCollections() {
        const collectionsPath = path.join(this._basePath, 'collections');
        
        if (!fs.existsSync(collectionsPath)) {
            return;
        }

        try {
            const files = fs.readdirSync(collectionsPath);
            
            for (const file of files) {
                if (file.endsWith('.json')) {
                    const collectionName = path.basename(file, '.json');
                    const collectionPath = this._getCollectionPath(collectionName);
                    const indexPath = this._getIndexPath(collectionName);
                    
                    // Register collection
                    this._collections.set(collectionName, {
                        name: collectionName,
                        path: collectionPath,
                        createdAt: new Date(),
                        documentCount: 0
                    });
                    
                    // Load indexes
                    this._indexes.set(collectionName, new Map());
                    
                    if (fs.existsSync(indexPath)) {
                        try {
                            const indexData = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
                            // Note: Index data structure would need to be rebuilt from documents
                            // For now, we just track the index definitions
                        } catch (error) {
                            console.warn(`Failed to load indexes for '${collectionName}':`, error);
                        }
                    }
                }
            }
        } catch (error) {
            console.error('Failed to load existing collections:', error);
        }
    }
}

// CLI Interface for direct execution
if (process.argv[1] === __filename) {
    const args = process.argv.slice(2);
    
    if (args.length === 0 || args.includes('--help')) {
        console.log(`
SystemStorage CLI Usage:
  node SystemStorage.js [command] [options]

Commands:
  --init [path]         Initialize database (optional custom path)
  --create <collection> Create a new collection
  --drop <collection>   Drop a collection
  --list                List all collections
  --stats               Show database statistics
  --insert <collection> <json> Insert document
  --find <collection> [query] Find documents
  --update <collection> <query> <update> Update document
  --delete <collection> <query> Delete document
  --help                Display this help

Examples:
  node SystemStorage.js --init ./my-db
  node SystemStorage.js --create users
  node SystemStorage.js --insert users '{"name":"John","age":30}'
  node SystemStorage.js --find users '{"age":{"$gte":18}}'
        `);
        process.exit(0);
    }

    async function handleCLI() {
        try {
            if (args.includes('--init')) {
                const customPath = args[args.indexOf('--init') + 1];
                await SystemStorage.init({ storagePath: customPath });
                console.log('Database initialized successfully');
            } else {
                await SystemStorage.init();
            }

            if (args.includes('--create')) {
                const collectionName = args[args.indexOf('--create') + 1];
                await SystemStorage.createCollection(collectionName);
                console.log(`Collection '${collectionName}' created`);
            }

            if (args.includes('--drop')) {
                const collectionName = args[args.indexOf('--drop') + 1];
                await SystemStorage.dropCollection(collectionName);
                console.log(`Collection '${collectionName}' dropped`);
            }

            if (args.includes('--list')) {
                const collections = SystemStorage.listCollections();
                console.log('Collections:', collections);
            }

            if (args.includes('--stats')) {
                const stats = await SystemStorage.stats();
                console.log('Database Statistics:', JSON.stringify(stats, null, 2));
            }

            if (args.includes('--insert')) {
                const collectionName = args[args.indexOf('--insert') + 1];
                const document = JSON.parse(args[args.indexOf('--insert') + 2]);
                const result = await SystemStorage.insertOne(collectionName, document);
                console.log('Inserted document:', result);
            }

            if (args.includes('--find')) {
                const collectionName = args[args.indexOf('--find') + 1];
                const query = args[args.indexOf('--find') + 2] ? 
                    JSON.parse(args[args.indexOf('--find') + 2]) : {};
                const results = await SystemStorage.find(collectionName, query);
                console.log('Found documents:', JSON.stringify(results, null, 2));
            }

            process.exit(0);

        } catch (error) {
            console.error('CLI Error:', error.message);
            process.exit(1);
        }
    }

    handleCLI();
}

export default SystemStorage;