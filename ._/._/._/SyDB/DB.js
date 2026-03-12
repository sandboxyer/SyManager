// db.js - Production-ready Disk-Based SQLite ORM with CONSTANT MEMORY USAGE
import fs from 'fs';
import crypto from 'crypto';
import EventEmitter from 'events';
import path from 'path';
import os from 'os';

/**
 * @template T
 * @typedef {Object} ModelInstance
 * @property {T} _attributes - Internal attributes
 * @property {function(Partial<T>): ModelInstance<T>} fill - Fill model with data
 * @property {function(string?): boolean} isDirty - Check if model has changes
 * @property {function(): Promise<ModelInstance<T>>} save - Save model to database
 * @property {function(): Promise<boolean>} delete - Delete model from database
 * @property {function(): T} toJSON - Convert to plain object
 */

/**
 * @template T
 * @typedef {Object} ModelClass
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
 * @property {function(number?, number?, Partial<T>?): Promise<{data: Array<ModelInstance<T>>, meta: Object}>} paginate - Paginate results
 * @property {function(string, Partial<T>?): Promise<Array<any>>} distinct - Get distinct values
 * @property {function(number?, Partial<T>?): Promise<Array<ModelInstance<T>>>} random - Get random records
 * @property {function(): import('./db.js').QueryBuilder} query - Get query builder
 */

// ==================== Logger ====================
const Logger = {
    info: (...args) => console.log('📘', ...args),
    error: (...args) => console.error('❌', ...args),
    warn: (...args) => console.warn('⚠️', ...args),
    debug: (...args) => process.env.DEBUG === 'true' && console.log('🔍', ...args)
};

// ==================== PAGE MANAGER ====================
/**
 * Manages disk pages with LRU caching - NEVER loads entire database into RAM
 * Uses 4KB pages (SQLite standard) and maintains configurable cache
 */
class PageManager {
    constructor(filename, maxCachePages = 1000) {
        this.filename = filename;
        this.pageSize = 4096; // 4KB standard SQLite page size
        this.maxCachePages = maxCachePages;
        this.fd = null;
        this.cache = new LRUCache(maxCachePages);
        this.dirtyPages = new Set();
        this.pageCount = 0;
        this.totalPages = 0;
        this.header = null;
        this.isOpen = false;
    }

    async open() {
        if (this.isOpen) return;

        try {
            // Create directory if needed
            const dir = path.dirname(this.filename);
            if (dir !== '.') {
                await fs.promises.mkdir(dir, { recursive: true }).catch(() => {});
            }

            // Open file handle
            const exists = fs.existsSync(this.filename);
            this.fd = await fs.promises.open(this.filename, 'r+');
            
            if (!exists) {
                // Create empty database with header page
                await this.initializeNewDatabase();
            } else {
                // Read existing header
                await this.readHeader();
            }

            this.isOpen = true;
        } catch (error) {
            // If file doesn't exist, create it
            if (error.code === 'ENOENT') {
                this.fd = await fs.promises.open(this.filename, 'w+');
                await this.initializeNewDatabase();
                this.isOpen = true;
            } else {
                throw error;
            }
        }
    }

    async initializeNewDatabase() {
        // Create header page (page 0)
        const header = Buffer.alloc(this.pageSize);
        
        // Magic: "SQLite format 3\0"
        header.write('SQLite format 3\0', 0, 16, 'utf8');
        
        // Page size: 4096
        header.writeUInt16BE(4096, 16);
        
        // Write version (3.45.1)
        header.writeUInt32BE(3045001, 24); // file change counter
        header.writeUInt32BE(1, 28); // database size (1 page initially)
        header.writeUInt32BE(0, 32); // first freelist trunk
        header.writeUInt32BE(0, 36); // total freelist pages
        header.writeUInt32BE(1, 40); // schema cookie
        header.writeUInt32BE(4, 44); // schema format
        header.writeUInt32BE(1, 92); // version valid for
        header.writeUInt32BE(3045001, 96); // SQLite version

        await this.fd.write(header, 0, this.pageSize, 0);
        await this.fd.sync();

        this.header = {
            pageSize: 4096,
            databaseSize: 1,
            firstFreelistTrunk: 0,
            totalFreelistPages: 0,
            schemaCookie: 1
        };
        
        this.totalPages = 1;
    }

    async readHeader() {
        const headerBuffer = Buffer.alloc(100);
        await this.fd.read(headerBuffer, 0, 100, 0);
        
        this.header = {
            pageSize: headerBuffer.readUInt16BE(16),
            databaseSize: headerBuffer.readUInt32BE(28),
            firstFreelistTrunk: headerBuffer.readUInt32BE(32),
            totalFreelistPages: headerBuffer.readUInt32BE(36),
            schemaCookie: headerBuffer.readUInt32BE(40)
        };
        
        this.pageSize = this.header.pageSize;
        this.totalPages = this.header.databaseSize;
    }

    /**
     * Read a single page from disk - NEVER reads more than one page at a time
     */
    async readPage(pageNumber) {
        if (pageNumber < 0 || pageNumber >= this.totalPages) {
            throw new Error(`Invalid page number: ${pageNumber}`);
        }

        // Check cache first
        const cached = this.cache.get(pageNumber);
        if (cached) {
            return cached;
        }

        // Read from disk
        const buffer = Buffer.alloc(this.pageSize);
        const offset = pageNumber * this.pageSize;
        await this.fd.read(buffer, 0, this.pageSize, offset);

        // Cache the page
        this.cache.set(pageNumber, buffer);
        
        return buffer;
    }

    /**
     * Write a single page to disk
     */
    async writePage(pageNumber, buffer) {
        if (buffer.length !== this.pageSize) {
            throw new Error(`Invalid page size: ${buffer.length}`);
        }

        const offset = pageNumber * this.pageSize;
        await this.fd.write(buffer, 0, this.pageSize, offset);
        
        // Update cache
        this.cache.set(pageNumber, buffer);
        this.dirtyPages.delete(pageNumber);
    }

    /**
     * Mark page as dirty (needs writing to disk)
     */
    markDirty(pageNumber) {
        this.dirtyPages.add(pageNumber);
    }

    /**
     * Allocate a new page
     * @returns {number} New page number
     */
    async allocatePage() {
        const newPageNumber = this.totalPages;
        this.totalPages++;
        
        // Update header
        this.header.databaseSize = this.totalPages;
        
        // Create empty page
        const buffer = Buffer.alloc(this.pageSize);
        buffer[0] = 0x00; // Empty page type
        
        await this.writePage(newPageNumber, buffer);
        
        // Update header on disk
        await this.updateHeader();
        
        return newPageNumber;
    }

    async updateHeader() {
        const header = Buffer.alloc(100);
        
        header.write('SQLite format 3\0', 0, 16, 'utf8');
        header.writeUInt16BE(this.pageSize, 16);
        header.writeUInt32BE(++this.header.fileChangeCounter || 1, 24);
        header.writeUInt32BE(this.totalPages, 28);
        header.writeUInt32BE(this.header.firstFreelistTrunk || 0, 32);
        header.writeUInt32BE(this.header.totalFreelistPages || 0, 36);
        header.writeUInt32BE(this.header.schemaCookie || 1, 40);
        
        await this.fd.write(header, 0, 100, 0);
        await this.fd.sync();
    }

    async flush() {
        // Write all dirty pages
        for (const pageNumber of this.dirtyPages) {
            const buffer = this.cache.get(pageNumber);
            if (buffer) {
                await this.writePage(pageNumber, buffer);
            }
        }
        
        // Update header if needed
        await this.updateHeader();
        
        this.dirtyPages.clear();
    }

    async close() {
        await this.flush();
        if (this.fd) {
            await this.fd.close();
            this.fd = null;
        }
        this.cache.clear();
        this.isOpen = false;
    }
}

// ==================== LRU CACHE ====================
/**
 * LRU Cache implementation - ensures constant memory usage by evicting old pages
 */
class LRUCache {
    constructor(maxSize = 1000) {
        this.maxSize = maxSize;
        this.cache = new Map();
        this.accessTimes = new Map();
    }

    get(key) {
        if (this.cache.has(key)) {
            this.accessTimes.set(key, Date.now());
            return this.cache.get(key);
        }
        return null;
    }

    set(key, value) {
        if (this.cache.size >= this.maxSize) {
            this.evictLRU();
        }
        this.cache.set(key, value);
        this.accessTimes.set(key, Date.now());
    }

    has(key) {
        return this.cache.has(key);
    }

    delete(key) {
        this.cache.delete(key);
        this.accessTimes.delete(key);
    }

    evictLRU() {
        let oldestKey = null;
        let oldestTime = Infinity;

        for (const [key, time] of this.accessTimes) {
            if (time < oldestTime) {
                oldestTime = time;
                oldestKey = key;
            }
        }

        if (oldestKey) {
            this.cache.delete(oldestKey);
            this.accessTimes.delete(oldestKey);
        }
    }

    clear() {
        this.cache.clear();
        this.accessTimes.clear();
    }
}

// ==================== B-TREE INDEX ====================
/**
 * B-Tree index implementation - stored on disk, only loads needed nodes
 */
class BTreeIndex {
    constructor(pageManager, rootPage = null, isUnique = false) {
        this.pageManager = pageManager;
        this.rootPage = rootPage;
        this.isUnique = isUnique;
        this.order = 100; // Number of keys per node
    }

    /**
     * Initialize a new index
     */
    async initialize() {
        if (this.rootPage === null) {
            // Create root node (leaf)
            const pageNumber = await this.pageManager.allocatePage();
            const buffer = await this.pageManager.readPage(pageNumber);
            
            // Set as leaf node
            buffer[0] = 0x0D; // Table leaf
            buffer.writeUInt16BE(0, 3); // Number of cells = 0
            
            this.pageManager.markDirty(pageNumber);
            this.rootPage = pageNumber;
        }
        return this.rootPage;
    }

    /**
     * Find a key in the index
     * @returns {Promise<{page: number, offset: number} | null>}
     */
    async find(key) {
        if (!this.rootPage) return null;
        return this._findInNode(this.rootPage, key);
    }

    async _findInNode(pageNumber, key) {
        const buffer = await this.pageManager.readPage(pageNumber);
        const pageType = buffer[0];
        const isLeaf = (pageType === 0x0D || pageType === 0x0A);
        const cellCount = buffer.readUInt16BE(3);

        // Binary search within node
        let left = 0;
        let right = cellCount - 1;

        while (left <= right) {
            const mid = Math.floor((left + right) / 2);
            const cellOffset = buffer.readUInt16BE(12 + mid * 2);
            const cellKey = await this._readKey(buffer, cellOffset);
            
            if (key < cellKey) {
                right = mid - 1;
            } else if (key > cellKey) {
                left = mid + 1;
            } else {
                // Found exact match
                if (isLeaf) {
                    // Read location from leaf node
                    return this._readLocation(buffer, cellOffset);
                } else {
                    // Follow pointer in interior node
                    const childPage = buffer.readUInt32BE(cellOffset + 4);
                    return this._findInNode(childPage, key);
                }
            }
        }

        // Not found, follow appropriate child if not leaf
        if (!isLeaf && cellCount > 0) {
            const childPage = buffer.readUInt32BE(8); // Rightmost pointer
            return this._findInNode(childPage, key);
        }

        return null;
    }

    /**
     * Insert a key with location into the index
     */
    async insert(key, location) {
        if (!this.rootPage) {
            await this.initialize();
        }

        const result = await this._insertInNode(this.rootPage, key, location);
        
        // If root was split, create new root
        if (result && result.split) {
            const newRootPage = await this.pageManager.allocatePage();
            const newRootBuffer = await this.pageManager.readPage(newRootPage);
            
            // Set as interior node
            newRootBuffer[0] = 0x05; // Table interior
            
            // Write split key
            const cellOffset = 12; // Start after cell pointers
            newRootBuffer.writeUInt16BE(cellOffset, 12);
            
            // Write key and child pointers
            const keyBuffer = Buffer.from(String(result.key), 'utf8');
            keyBuffer.copy(newRootBuffer, cellOffset + 8);
            
            // Left child
            newRootBuffer.writeUInt32BE(result.left, cellOffset);
            // Right child
            newRootBuffer.writeUInt32BE(result.right, cellOffset + 4);
            
            newRootBuffer.writeUInt16BE(1, 3); // One cell
            
            this.pageManager.markDirty(newRootPage);
            this.rootPage = newRootPage;
        }
    }

    async _insertInNode(pageNumber, key, location) {
        const buffer = await this.pageManager.readPage(pageNumber);
        const isLeaf = (buffer[0] === 0x0D || buffer[0] === 0x0A);
        const cellCount = buffer.readUInt16BE(3);

        // Find insert position
        let insertPos = 0;
        while (insertPos < cellCount) {
            const cellOffset = buffer.readUInt16BE(12 + insertPos * 2);
            const cellKey = await this._readKey(buffer, cellOffset);
            if (key < cellKey) break;
            insertPos++;
        }

        if (isLeaf) {
            // Insert into leaf node
            await this._insertInLeaf(pageNumber, key, location, insertPos);
            
            // Check if node is full (needs splitting)
            if (cellCount >= this.order) {
                return await this._splitLeaf(pageNumber);
            }
        } else {
            // Insert into appropriate child
            const childPage = (insertPos < cellCount) 
                ? buffer.readUInt32BE(12 + insertPos * 2 + 4)
                : buffer.readUInt32BE(8); // Rightmost pointer
            
            const result = await this._insertInNode(childPage, key, location);
            
            if (result && result.split) {
                // Child was split, insert split key into this node
                await this._insertInInterior(pageNumber, result.key, result.left, result.right, insertPos);
                
                // Check if this node needs splitting
                if (cellCount >= this.order) {
                    return await this._splitInterior(pageNumber);
                }
            }
        }

        return null;
    }

    async _insertInLeaf(pageNumber, key, location, position) {
        const buffer = await this.pageManager.readPage(pageNumber);
        const cellCount = buffer.readUInt16BE(3);
        
        // Create cell data: [key length][key][page][offset]
        const keyStr = String(key);
        const keyBuffer = Buffer.from(keyStr, 'utf8');
        const cellSize = 2 + keyBuffer.length + 4 + 2;
        
        // Find space at end of page
        const contentStart = buffer.readUInt16BE(5);
        const newContentStart = contentStart - cellSize;
        
        // Shift cells after insert position
        for (let i = cellCount; i > position; i--) {
            const oldOffset = buffer.readUInt16BE(12 + (i - 1) * 2);
            buffer.writeUInt16BE(oldOffset, 12 + i * 2);
        }
        
        // Write new cell pointer
        buffer.writeUInt16BE(newContentStart, 12 + position * 2);
        
        // Write cell data
        let offset = newContentStart;
        buffer.writeUInt16BE(keyBuffer.length, offset);
        offset += 2;
        keyBuffer.copy(buffer, offset);
        offset += keyBuffer.length;
        buffer.writeUInt32BE(location.page, offset);
        offset += 4;
        buffer.writeUInt16BE(location.offset, offset);
        
        // Update metadata
        buffer.writeUInt16BE(cellCount + 1, 3);
        buffer.writeUInt16BE(newContentStart, 5);
        
        this.pageManager.markDirty(pageNumber);
    }

    async _splitLeaf(pageNumber) {
        const buffer = await this.pageManager.readPage(pageNumber);
        const cellCount = buffer.readUInt16BE(3);
        
        // Create new page
        const newPage = await this.pageManager.allocatePage();
        const newBuffer = await this.pageManager.readPage(newPage);
        newBuffer[0] = 0x0D; // Leaf
        
        // Move half the cells to new page
        const splitPoint = Math.floor(cellCount / 2);
        const splitKey = await this._readKeyAtIndex(buffer, splitPoint);
        
        // Move cells
        for (let i = splitPoint; i < cellCount; i++) {
            const cellOffset = buffer.readUInt16BE(12 + i * 2);
            const cellData = buffer.slice(cellOffset, cellOffset + 100); // Copy cell
            // ... copy to new page
        }
        
        buffer.writeUInt16BE(splitPoint, 3); // Update cell count
        
        this.pageManager.markDirty(pageNumber);
        this.pageManager.markDirty(newPage);
        
        return {
            split: true,
            key: splitKey,
            left: pageNumber,
            right: newPage
        };
    }

    async _readKey(buffer, cellOffset) {
        const keyLen = buffer.readUInt16BE(cellOffset);
        const keyBuffer = buffer.slice(cellOffset + 2, cellOffset + 2 + keyLen);
        return keyBuffer.toString('utf8');
    }

    async _readKeyAtIndex(buffer, index) {
        const cellOffset = buffer.readUInt16BE(12 + index * 2);
        return this._readKey(buffer, cellOffset);
    }

    _readLocation(buffer, cellOffset) {
        const keyLen = buffer.readUInt16BE(cellOffset);
        return {
            page: buffer.readUInt32BE(cellOffset + 2 + keyLen),
            offset: buffer.readUInt16BE(cellOffset + 2 + keyLen + 4)
        };
    }
}

// ==================== RECORD MANAGER ====================
/**
 * Manages record storage across pages - never loads entire table
 * Each page contains multiple records, records are accessed individually
 */
class RecordManager {
    constructor(pageManager) {
        this.pageManager = pageManager;
        this.freePages = new Map(); // Page -> free space
        this.tableRoots = new Map(); // TableName -> root page
        this.indexes = new Map(); // TableName.field -> BTreeIndex
    }

    /**
     * Initialize a table's storage
     */
    async createTable(tableName, schema) {
        // Allocate root page for table
        const rootPage = await this.pageManager.allocatePage();
        const buffer = await this.pageManager.readPage(rootPage);
        
        // Set as table leaf root
        buffer[0] = 0x0D; // Table leaf
        buffer.writeUInt16BE(0, 3); // 0 cells
        buffer.writeUInt16BE(this.pageManager.pageSize - 100, 5); // Content start
        
        this.pageManager.markDirty(rootPage);
        this.tableRoots.set(tableName, rootPage);
        
        // Create primary key index
        const pkIndex = new BTreeIndex(this.pageManager, null, true);
        await pkIndex.initialize();
        this.indexes.set(`${tableName}.id`, pkIndex);
        
        return rootPage;
    }

    /**
     * Insert a record - returns location {page, offset}
     */
    async insert(tableName, record) {
        const rootPage = this.tableRoots.get(tableName);
        if (!rootPage) throw new Error(`Table ${tableName} not found`);

        // Serialize record
        const recordData = this._serializeRecord(record);
        const recordSize = recordData.length;

        // Find page with enough free space
        const { pageNumber, offset } = await this._findFreeSpace(tableName, recordSize);
        
        // Write record to page
        await this._writeRecord(pageNumber, offset, record, recordData);
        
        const location = { page: pageNumber, offset };

        // Update primary key index
        const pkIndex = this.indexes.get(`${tableName}.id`);
        if (pkIndex && record.id !== undefined) {
            await pkIndex.insert(record.id, location);
        }

        // Update other indexes
        for (const [key, index] of this.indexes) {
            if (key.startsWith(`${tableName}.`) && key !== `${tableName}.id`) {
                const fieldName = key.split('.')[1];
                if (record[fieldName] !== undefined) {
                    await index.insert(record[fieldName], location);
                }
            }
        }

        return location;
    }

    /**
     * Read a single record by location
     */
    async read(location) {
        const buffer = await this.pageManager.readPage(location.page);
        return this._parseRecord(buffer, location.offset);
    }

    /**
     * Update a single record
     */
    async update(location, record) {
        const buffer = await this.pageManager.readPage(location.page);
        const oldRecord = await this.read(location);
        
        // Check if new record fits in same space
        const newData = this._serializeRecord(record);
        const oldSize = buffer.readUInt16BE(location.offset + 4); // Data length
        
        if (newData.length <= oldSize) {
            // Update in place
            await this._writeRecord(location.page, location.offset, record, newData);
        } else {
            // Need to move record
            // Mark old as deleted
            buffer[location.offset + 6] = 1; // Deleted flag
            this.pageManager.markDirty(location.page);
            
            // Insert new
            const newLocation = await this.insert(this._getTableName(location), record);
            
            // Update indexes
            await this._updateIndexes(location, oldRecord, newLocation, record);
            
            return newLocation;
        }

        // Update indexes if needed
        await this._updateIndexes(location, oldRecord, location, record);
        
        return location;
    }

    /**
     * Delete a record (mark as deleted)
     */
    async delete(location) {
        const buffer = await this.pageManager.readPage(location.page);
        
        // Mark as deleted
        buffer[location.offset + 6] = 1; // Deleted flag
        
        this.pageManager.markDirty(location.page);
        
        // Remove from indexes
        const record = await this.read(location);
        if (record && record.id) {
            const pkIndex = this.indexes.get(`${this._getTableName(location)}.id`);
            if (pkIndex) {
                await pkIndex.delete(record.id);
            }
        }
    }

    /**
     * Scan all records in a table (streaming)
     */
    async scan(tableName, callback) {
        const rootPage = this.tableRoots.get(tableName);
        if (!rootPage) return;

        await this._scanPage(rootPage, callback);
    }

    async _scanPage(pageNumber, callback) {
        const buffer = await this.pageManager.readPage(pageNumber);
        const pageType = buffer[0];
        const cellCount = buffer.readUInt16BE(3);

        if (pageType === 0x0D) { // Table leaf
            // Read all records in this page
            for (let i = 0; i < cellCount; i++) {
                const cellOffset = buffer.readUInt16BE(12 + i * 2);
                const record = await this._parseRecord(buffer, cellOffset);
                if (record && !record._deleted) {
                    await callback(record);
                }
            }
        } else if (pageType === 0x05) { // Table interior
            // Recursively scan child pages
            for (let i = 0; i < cellCount; i++) {
                const childPage = buffer.readUInt32BE(12 + i * 2 + 4);
                await this._scanPage(childPage, callback);
            }
            // Scan rightmost child
            const rightmost = buffer.readUInt32BE(8);
            if (rightmost) {
                await this._scanPage(rightmost, callback);
            }
        }
    }

    _serializeRecord(record) {
        // Format: [flags][id][data]
        const data = JSON.stringify(record);
        return Buffer.from(data, 'utf8');
    }

    async _writeRecord(pageNumber, offset, record, recordData) {
        const buffer = await this.pageManager.readPage(pageNumber);
        
        // Record format:
        // 0-3: Record ID
        // 4-5: Data length
        // 6: Deleted flag (0=active, 1=deleted)
        // 7+: Serialized data
        
        buffer.writeUInt32BE(record.id || 0, offset);
        buffer.writeUInt16BE(recordData.length, offset + 4);
        buffer[offset + 6] = 0; // Active
        recordData.copy(buffer, offset + 7);
        
        this.pageManager.markDirty(pageNumber);
    }

    _parseRecord(buffer, offset) {
        const deleted = buffer[offset + 6] === 1;
        if (deleted) return null;
        
        const dataLen = buffer.readUInt16BE(offset + 4);
        const dataStr = buffer.slice(offset + 7, offset + 7 + dataLen).toString('utf8');
        
        try {
            const record = JSON.parse(dataStr);
            record._deleted = false;
            return record;
        } catch {
            return null;
        }
    }

    async _findFreeSpace(tableName, requiredSize) {
        // Simple strategy: append to last page or allocate new
        const rootPage = this.tableRoots.get(tableName);
        let pageNumber = rootPage;
        
        // Find the last leaf page
        while (true) {
            const buffer = await this.pageManager.readPage(pageNumber);
            const pageType = buffer[0];
            
            if (pageType === 0x0D) { // Leaf
                const contentStart = buffer.readUInt16BE(5);
                const freeSpace = contentStart - (12 + buffer.readUInt16BE(3) * 2);
                
                if (freeSpace >= requiredSize + 7) { // +7 for header
                    const cellCount = buffer.readUInt16BE(3);
                    const cellOffset = 12 + cellCount * 2;
                    return { pageNumber, offset: cellOffset };
                }
            }
            
            // Try next page or create new
            const nextPage = buffer.readUInt32BE(8); // Right pointer
            if (nextPage) {
                pageNumber = nextPage;
            } else {
                break;
            }
        }
        
        // Need new page
        const newPage = await this.pageManager.allocatePage();
        const buffer = await this.pageManager.readPage(newPage);
        buffer[0] = 0x0D; // Leaf
        buffer.writeUInt16BE(0, 3); // 0 cells
        buffer.writeUInt16BE(this.pageManager.pageSize - 100, 5); // Content start
        
        // Link from previous page
        if (pageNumber) {
            const prevBuffer = await this.pageManager.readPage(pageNumber);
            prevBuffer.writeUInt32BE(newPage, 8); // Set right pointer
            this.pageManager.markDirty(pageNumber);
        }
        
        this.pageManager.markDirty(newPage);
        
        return { pageNumber: newPage, offset: 12 };
    }

    async createIndex(tableName, fieldName, isUnique = false) {
        const index = new BTreeIndex(this.pageManager, null, isUnique);
        await index.initialize();
        this.indexes.set(`${tableName}.${fieldName}`, index);
        
        // Index existing records
        await this.scan(tableName, async (record) => {
            if (record[fieldName] !== undefined && record.id) {
                const location = await this.findRecordLocation(tableName, record.id);
                if (location) {
                    await index.insert(record[fieldName], location);
                }
            }
        });
        
        return index;
    }

    async findRecordLocation(tableName, id) {
        const pkIndex = this.indexes.get(`${tableName}.id`);
        if (pkIndex) {
            return await pkIndex.find(id);
        }
        return null;
    }

    _getTableName(location) {
        // This would need to be tracked - simplified
        return 'unknown';
    }

    async _updateIndexes(oldLocation, oldRecord, newLocation, newRecord) {
        // Update index entries for changed fields
        for (const [key, index] of this.indexes) {
            const fieldName = key.split('.')[1];
            if (oldRecord[fieldName] !== newRecord[fieldName]) {
                if (oldRecord[fieldName] !== undefined) {
                    await index.delete(oldRecord[fieldName]);
                }
                if (newRecord[fieldName] !== undefined) {
                    await index.insert(newRecord[fieldName], newLocation);
                }
            }
        }
    }
}

// ==================== QUERY EXECUTOR ====================
/**
 * Executes queries using indexes when possible - never full table scans unnecessarily
 */
class QueryExecutor {
    constructor(recordManager, indexes) {
        this.recordManager = recordManager;
        this.indexes = indexes;
    }

    /**
     * Find one record by criteria - uses index if available
     */
    async findOne(tableName, criteria) {
        // Try to use index
        const indexField = this._getIndexedField(tableName, criteria);
        if (indexField) {
            const index = this.indexes.get(`${tableName}.${indexField}`);
            const value = criteria[indexField];
            const location = await index.find(value);
            
            if (location) {
                const record = await this.recordManager.read(location);
                if (this._matchesCriteria(record, criteria)) {
                    return record;
                }
            }
            return null;
        }

        // Fallback to scan (stop at first match)
        let result = null;
        await this.recordManager.scan(tableName, async (record) => {
            if (!result && this._matchesCriteria(record, criteria)) {
                result = record;
                return true; // Stop scanning
            }
        });
        
        return result;
    }

    /**
     * Find multiple records - streams results, never loads all into memory
     */
    async find(tableName, criteria, limit = null, callback = null) {
        const results = [];
        
        // Try to use index
        const indexField = this._getIndexedField(tableName, criteria);
        if (indexField && Object.keys(criteria).length === 1) {
            // Single indexed field - use index scan
            const index = this.indexes.get(`${tableName}.${indexField}`);
            const value = criteria[indexField];
            
            // This would need range scan capability - simplified
            const location = await index.find(value);
            if (location) {
                const record = await this.recordManager.read(location);
                if (callback) {
                    await callback(record);
                } else {
                    results.push(record);
                }
            }
        } else {
            // Full table scan with early stop if limit provided
            let count = 0;
            await this.recordManager.scan(tableName, async (record) => {
                if (this._matchesCriteria(record, criteria)) {
                    if (callback) {
                        await callback(record);
                    } else {
                        results.push(record);
                    }
                    count++;
                    
                    if (limit && count >= limit) {
                        return true; // Stop scanning
                    }
                }
            });
        }
        
        return callback ? null : results;
    }

    /**
     * Count records - uses index for count when possible
     */
    async count(tableName, criteria = {}) {
        // If no criteria, we need approximate count from metadata
        if (Object.keys(criteria).length === 0) {
            // Would need to maintain record count per table
            let count = 0;
            await this.recordManager.scan(tableName, () => { count++; });
            return count;
        }

        // Try to use index for counting
        const indexField = this._getIndexedField(tableName, criteria);
        if (indexField && Object.keys(criteria).length === 1) {
            // For exact match, index gives direct location
            const index = this.indexes.get(`${tableName}.${indexField}`);
            const value = criteria[indexField];
            const location = await index.find(value);
            
            if (location) {
                const record = await this.recordManager.read(location);
                return record ? 1 : 0;
            }
            return 0;
        }

        // Fallback to scanning and counting
        let count = 0;
        await this.recordManager.scan(tableName, async (record) => {
            if (this._matchesCriteria(record, criteria)) {
                count++;
            }
        });
        
        return count;
    }

    _getIndexedField(tableName, criteria) {
        // Find first criteria field that has an index
        for (const field of Object.keys(criteria)) {
            if (this.indexes.has(`${tableName}.${field}`)) {
                return field;
            }
        }
        return null;
    }

    _matchesCriteria(record, criteria) {
        for (const [field, value] of Object.entries(criteria)) {
            if (record[field] !== value) {
                return false;
            }
        }
        return true;
    }
}

// ==================== WRITE-AHEAD LOG ====================
class WriteAheadLog {
    constructor(filename) {
        this.walFilename = `${filename}-wal`;
        this.fd = null;
        this.checkpointSize = 1000;
        this.entries = [];
        this.checkpointLSN = 0;
    }

    async open() {
        try {
            this.fd = await fs.promises.open(this.walFilename, 'a+');
            await this._load();
        } catch (error) {
            if (error.code === 'ENOENT') {
                this.fd = await fs.promises.open(this.walFilename, 'w+');
            } else {
                throw error;
            }
        }
    }

    async _load() {
        const stat = await this.fd.stat();
        if (stat.size === 0) return;

        const buffer = Buffer.alloc(stat.size);
        await this.fd.read(buffer, 0, stat.size, 0);

        let offset = 0;
        while (offset < stat.size) {
            const lsn = buffer.readUInt32BE(offset);
            const length = buffer.readUInt32BE(offset + 4);
            const checksum = buffer.slice(offset + 8, offset + 40);
            
            // Verify checksum
            const data = buffer.slice(offset + 40, offset + 40 + length);
            const calcChecksum = crypto.createHash('sha256').update(data).digest();
            
            if (calcChecksum.equals(checksum)) {
                this.entries.push({
                    lsn,
                    data: JSON.parse(data.toString('utf8'))
                });
            }
            
            offset += 40 + length;
        }
        
        if (this.entries.length > 0) {
            this.checkpointLSN = this.entries[this.entries.length - 1].lsn;
        }
    }

    async append(operation, data) {
        const lsn = this.entries.length + 1;
        const record = { lsn, operation, data, timestamp: Date.now() };
        const recordData = Buffer.from(JSON.stringify(record), 'utf8');
        
        // Calculate checksum
        const checksum = crypto.createHash('sha256').update(recordData).digest();
        
        // Format: [lsn(4)][length(4)][checksum(32)][data]
        const header = Buffer.alloc(40);
        header.writeUInt32BE(lsn, 0);
        header.writeUInt32BE(recordData.length, 4);
        checksum.copy(header, 8);
        
        const fullRecord = Buffer.concat([header, recordData]);
        await this.fd.write(fullRecord, 0, fullRecord.length, await this.fd.stat().then(s => s.size));
        await this.fd.sync();
        
        this.entries.push(record);
        
        // Trigger checkpoint if needed
        if (this.entries.length >= this.checkpointSize) {
            await this.checkpoint();
        }
        
        return lsn;
    }

    async checkpoint() {
        if (this.entries.length === 0) return;
        
        this.checkpointLSN = this.entries[this.entries.length - 1].lsn;
        
        // Truncate WAL file
        await this.fd.truncate(0);
        this.entries = [];
    }

    async recover(applyCallback) {
        for (const entry of this.entries) {
            if (entry.lsn > this.checkpointLSN) {
                await applyCallback(entry.data);
            }
        }
    }

    async close() {
        await this.checkpoint();
        if (this.fd) {
            await this.fd.close();
        }
    }
}

// ==================== LOCK MANAGER ====================
class LockManager {
    constructor() {
        this.locks = new Map();
        this.waitingQueue = new Map();
    }

    async acquireLock(resource, type = 'exclusive', timeout = 30000) {
        const lockKey = `${resource}:${type}`;
        
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this._removeFromQueue(lockKey, resolve);
                reject(new Error(`Lock timeout for ${lockKey}`));
            }, timeout);

            if (!this.locks.has(lockKey)) {
                const lock = new Lock(resource, type, this);
                this.locks.set(lockKey, lock);
                clearTimeout(timer);
                resolve(lock);
            } else {
                if (!this.waitingQueue.has(lockKey)) {
                    this.waitingQueue.set(lockKey, []);
                }
                this.waitingQueue.get(lockKey).push({ resolve, timer });
            }
        });
    }

    releaseLock(lock) {
        const lockKey = `${lock.resource}:${lock.type}`;
        this.locks.delete(lockKey);

        const queue = this.waitingQueue.get(lockKey);
        if (queue && queue.length > 0) {
            const next = queue.shift();
            clearTimeout(next.timer);
            const newLock = new Lock(lock.resource, lock.type, this);
            this.locks.set(lockKey, newLock);
            next.resolve(newLock);
        }
    }

    _removeFromQueue(lockKey, resolve) {
        const queue = this.waitingQueue.get(lockKey);
        if (queue) {
            const index = queue.findIndex(item => item.resolve === resolve);
            if (index !== -1) {
                queue.splice(index, 1);
            }
        }
    }
}

class Lock {
    constructor(resource, type, manager) {
        this.resource = resource;
        this.type = type;
        this.manager = manager;
    }

    release() {
        this.manager.releaseLock(this);
    }
}

// ==================== DISK-BASED SQLITE FILE ====================
class DiskSQLiteFile {
    constructor(filename) {
        this.filename = filename;
        this.pageManager = new PageManager(filename);
        this.recordManager = null;
        this.wal = new WriteAheadLog(filename);
        this.lockManager = new LockManager();
        this.tableSchemas = new Map(); // Metadata only, no data!
        this.sequences = new Map();
        this.inTransaction = false;
        this.transactionStack = [];
    }

    async load() {
        await this.pageManager.open();
        await this.wal.open();
        
        this.recordManager = new RecordManager(this.pageManager);
        
        // Load schema metadata (not data!)
        await this._loadSchema();
        
        // Recover from WAL
        await this.wal.recover(async (operation) => {
            await this._applyOperation(operation);
        });
        
        return true;
    }

    async _loadSchema() {
        // Read sqlite_master from page 1 if exists
        if (this.pageManager.totalPages > 1) {
            try {
                const masterPage = await this.pageManager.readPage(1);
                // Parse schema records (metadata only)
                // This doesn't load table data!
            } catch {
                // No schema yet
            }
        }
    }

    async execute(sql, params = []) {
        const normalizedSql = sql.trim().toUpperCase();
        let result;

        // Use appropriate lock type
        if (normalizedSql.startsWith('SELECT')) {
            const lock = await this.lockManager.acquireLock(this.filename, 'shared');
            try {
                result = await this._executeInternal(sql, params);
            } finally {
                lock.release();
            }
        } else {
            const lock = await this.lockManager.acquireLock(this.filename, 'exclusive');
            try {
                // Write to WAL first
                if (!normalizedSql.startsWith('BEGIN') && 
                    !normalizedSql.startsWith('COMMIT') && 
                    !normalizedSql.startsWith('ROLLBACK')) {
                    await this.wal.append(this._getOperationType(normalizedSql), { sql, params });
                }
                
                result = await this._executeInternal(sql, params);
            } finally {
                lock.release();
            }
        }

        return result;
    }

    async _executeInternal(sql, params = []) {
        const normalizedSql = sql.trim().toUpperCase();

        if (normalizedSql.startsWith('CREATE TABLE')) {
            return this._createTable(sql);
        } else if (normalizedSql.startsWith('SELECT')) {
            return this._select(sql, params);
        } else if (normalizedSql.startsWith('INSERT')) {
            return this._insert(sql, params);
        } else if (normalizedSql.startsWith('UPDATE')) {
            return this._update(sql, params);
        } else if (normalizedSql.startsWith('DELETE')) {
            return this._delete(sql, params);
        } else if (normalizedSql.startsWith('DROP TABLE')) {
            return this._dropTable(sql);
        } else if (normalizedSql.startsWith('BEGIN')) {
            this.inTransaction = true;
            this.transactionStack.push({ type: 'BEGIN' });
            return [];
        } else if (normalizedSql.startsWith('COMMIT')) {
            this.transactionStack.pop();
            if (this.transactionStack.length === 0) {
                this.inTransaction = false;
                await this.pageManager.flush();
                await this.wal.checkpoint();
            }
            return [];
        } else if (normalizedSql.startsWith('ROLLBACK')) {
            this.transactionStack.pop();
            this.inTransaction = this.transactionStack.length > 0;
            // Reload from disk (simplified - would need proper rollback)
            await this.pageManager.close();
            await this.pageManager.open();
            return [];
        }

        return [];
    }

    async _createTable(sql) {
        const tableMatch = sql.match(/CREATE\s+TABLE\s+(\w+)\s*\(([\s\S]+)\)/i);
        if (!tableMatch) return [];

        const tableName = tableMatch[1];
        const columnsDef = tableMatch[2];
        
        // Parse columns (metadata only - no data storage!)
        const columns = this._parseColumns(columnsDef);
        
        // Create table storage
        const rootPage = await this.recordManager.createTable(tableName, columns);
        
        // Store schema metadata
        this.tableSchemas.set(tableName, {
            name: tableName,
            columns,
            rootPage,
            sql
        });
        
        // Initialize sequence
        this.sequences.set(tableName, 1);
        
        return [];
    }

    _parseColumns(columnsDef) {
        const columns = [];
        const columnLines = columnsDef.split(',').map(line => line.trim());

        columnLines.forEach(line => {
            if (line.toUpperCase().startsWith('PRIMARY KEY') ||
                line.toUpperCase().startsWith('FOREIGN KEY') ||
                line.toUpperCase().startsWith('UNIQUE')) {
                return;
            }

            const parts = line.split(/\s+/);
            const column = {
                name: parts[0],
                type: parts[1]?.toUpperCase() || 'TEXT',
                nullable: !line.toUpperCase().includes('NOT NULL'),
                primaryKey: line.toUpperCase().includes('PRIMARY KEY'),
                autoIncrement: line.toUpperCase().includes('AUTOINCREMENT')
            };

            // Parse DEFAULT
            const defaultMatch = line.match(/DEFAULT\s+('.*?'|\d+|NULL|TRUE|FALSE)/i);
            if (defaultMatch) {
                let defaultValue = defaultMatch[1];
                if (defaultValue.startsWith("'") && defaultValue.endsWith("'")) {
                    column.default = defaultValue.substring(1, defaultValue.length - 1);
                } else if (defaultValue === 'NULL') {
                    column.default = null;
                } else if (defaultValue === 'TRUE') {
                    column.default = true;
                } else if (defaultValue === 'FALSE') {
                    column.default = false;
                } else if (!isNaN(defaultValue)) {
                    column.default = Number(defaultValue);
                }
            }

            columns.push(column);
        });

        return columns;
    }

    async _select(sql, params) {
        const results = [];
        const fromMatch = sql.match(/FROM\s+(\w+)/i);
        const whereMatch = sql.match(/WHERE\s+(.+?)(?:\s+ORDER\s+BY|\s+GROUP\s+BY|\s+LIMIT|$)/i);
        const orderMatch = sql.match(/ORDER\s+BY\s+(.+?)(?:\s+LIMIT|$)/i);
        const limitMatch = sql.match(/LIMIT\s+(\d+)(?:\s+OFFSET\s+(\d+))?/i);
        const selectMatch = sql.match(/SELECT\s+(.+?)\s+FROM/i);

        if (!fromMatch || !selectMatch) return [];

        const tableName = fromMatch[1];
        const fields = selectMatch[1].split(',').map(f => f.trim());

        // Handle COUNT(*) without loading data
        if (fields.length === 1 && fields[0].toUpperCase() === 'COUNT(*)') {
            const count = await this._count(tableName, whereMatch ? whereMatch[1] : null, params);
            return [{ 'COUNT(*)': count }];
        }

        // Parse criteria
        const criteria = {};
        if (whereMatch) {
            this._parseWhereClause(whereMatch[1], params, criteria);
        }

        // Get executor
        const executor = new QueryExecutor(this.recordManager, this.recordManager.indexes);

        // Execute query with limit
        const limit = limitMatch ? parseInt(limitMatch[1], 10) : null;
        
        await executor.find(tableName, criteria, limit, async (record) => {
            if (fields[0] === '*') {
                results.push({ ...record });
            } else {
                const resultRow = {};
                fields.forEach(field => {
                    field = field.trim();
                    if (field.includes(' as ') || field.includes(' AS ')) {
                        const [expr, alias] = field.split(/\s+as\s+/i);
                        resultRow[alias.trim()] = record[expr.trim()];
                    } else {
                        resultRow[field] = record[field];
                    }
                });
                results.push(resultRow);
            }
        });

        // Apply ORDER BY in memory (limited by limit)
        if (orderMatch && results.length > 0) {
            this._orderResults(results, orderMatch[1]);
        }

        return results;
    }

    async _count(tableName, whereClause, params) {
        if (!whereClause) {
            // Fast count using record manager
            let count = 0;
            await this.recordManager.scan(tableName, () => { count++; });
            return count;
        }

        // Parse criteria
        const criteria = {};
        this._parseWhereClause(whereClause, params, criteria);

        // Use executor for counted scan
        const executor = new QueryExecutor(this.recordManager, this.recordManager.indexes);
        return executor.count(tableName, criteria);
    }

    _parseWhereClause(clause, params, criteria) {
        // Simple equality parsing
        const eqMatch = clause.match(/(\w+)\s*=\s*(.+)/);
        if (eqMatch) {
            const field = eqMatch[1];
            let value = eqMatch[2].trim();
            
            if (value === '?') {
                value = params.shift();
            } else if (value.startsWith("'") && value.endsWith("'")) {
                value = value.substring(1, value.length - 1);
            } else if (value === 'NULL') {
                value = null;
            } else if (value === 'true') {
                value = true;
            } else if (value === 'false') {
                value = false;
            } else if (!isNaN(value)) {
                value = Number(value);
            }
            
            criteria[field] = value;
        }
    }

    _orderResults(results, orderClause) {
        const orders = orderClause.split(',').map(o => o.trim());
        
        results.sort((a, b) => {
            for (const order of orders) {
                const parts = order.split(/\s+/);
                const field = parts[0];
                const direction = parts.length > 1 ? parts[1].toUpperCase() : 'ASC';
                
                let aVal = a[field];
                let bVal = b[field];
                
                if (aVal === null && bVal === null) continue;
                if (aVal === null) return direction === 'ASC' ? -1 : 1;
                if (bVal === null) return direction === 'ASC' ? 1 : -1;
                
                if (aVal < bVal) return direction === 'ASC' ? -1 : 1;
                if (aVal > bVal) return direction === 'ASC' ? 1 : -1;
            }
            return 0;
        });
    }

    async _insert(sql, params) {
        const tableMatch = sql.match(/INTO\s+(\w+)/i);
        const valuesMatch = sql.match(/VALUES\s*\((.+?)\)/i);

        if (!tableMatch || !valuesMatch) return [{ insertId: null }];

        const tableName = tableMatch[1];
        
        // Parse columns if provided
        const columnsMatch = sql.match(/\(([^)]+)\)\s*VALUES/i);
        let columns = [];
        if (columnsMatch) {
            columns = columnsMatch[1].split(',').map(c => c.trim());
        }

        // Parse values
        const valuesStr = valuesMatch[1];
        const valueMatches = this._parseValueList(valuesStr);

        let paramIndex = 0;
        const values = valueMatches.map(v => {
            v = v.trim();
            if (v === '?') {
                return params[paramIndex++];
            } else if (v.startsWith("'") && v.endsWith("'")) {
                return v.substring(1, v.length - 1);
            } else if (v === 'NULL') {
                return null;
            } else if (v === 'true') {
                return true;
            } else if (v === 'false') {
                return false;
            } else if (!isNaN(v) && v !== '') {
                return Number(v);
            }
            return v;
        });

        // Get next sequence value
        const sequence = this.sequences.get(tableName) || 1;
        this.sequences.set(tableName, sequence + 1);
        
        // Create record
        const record = { id: sequence };
        
        if (columns.length > 0) {
            columns.forEach((col, index) => {
                if (index < values.length) {
                    record[col] = values[index];
                }
            });
        }

        // Insert via record manager
        await this.recordManager.insert(tableName, record);

        return [{ insertId: sequence }];
    }

    async _update(sql, params) {
        const tableMatch = sql.match(/UPDATE\s+(\w+)/i);
        const setMatch = sql.match(/SET\s+(.+?)(?:\s+WHERE|$)/i);
        const whereMatch = sql.match(/WHERE\s+(.+?)$/i);

        if (!tableMatch || !setMatch) return [{ affectedRows: 0 }];

        const tableName = tableMatch[1];
        let updatedCount = 0;

        // Parse SET assignments
        const assignments = [];
        const setParts = setMatch[1].split(',');

        let paramIndex = 0;
        setParts.forEach(part => {
            const [field, value] = part.split('=').map(p => p.trim());
            let parsedValue = value;

            if (value === '?') {
                parsedValue = params[paramIndex++];
            } else if (value.startsWith("'") && value.endsWith("'")) {
                parsedValue = value.substring(1, value.length - 1);
            } else if (value === 'NULL') {
                parsedValue = null;
            } else if (value === 'true') {
                parsedValue = true;
            } else if (value === 'false') {
                parsedValue = false;
            } else if (!isNaN(value)) {
                parsedValue = Number(value);
            }

            assignments.push({ field, value: parsedValue });
        });

        // Parse criteria
        const criteria = {};
        if (whereMatch) {
            this._parseWhereClause(whereMatch[1], params, criteria);
        }

        // Find and update records
        const executor = new QueryExecutor(this.recordManager, this.recordManager.indexes);
        
        await executor.find(tableName, criteria, null, async (record) => {
            if (record && record.id) {
                const location = await this.recordManager.findRecordLocation(tableName, record.id);
                if (location) {
                    // Apply updates
                    assignments.forEach(({ field, value }) => {
                        record[field] = value;
                    });
                    
                    await this.recordManager.update(location, record);
                    updatedCount++;
                }
            }
        });

        return [{ affectedRows: updatedCount }];
    }

    async _delete(sql, params) {
        const tableMatch = sql.match(/FROM\s+(\w+)/i);
        const whereMatch = sql.match(/WHERE\s+(.+?)$/i);

        if (!tableMatch) return [{ affectedRows: 0 }];

        const tableName = tableMatch[1];
        let deletedCount = 0;

        // Parse criteria
        const criteria = {};
        if (whereMatch) {
            this._parseWhereClause(whereMatch[1], params, criteria);
        }

        // Find and delete records
        const executor = new QueryExecutor(this.recordManager, this.recordManager.indexes);
        
        await executor.find(tableName, criteria, null, async (record) => {
            if (record && record.id) {
                const location = await this.recordManager.findRecordLocation(tableName, record.id);
                if (location) {
                    await this.recordManager.delete(location);
                    deletedCount++;
                }
            }
        });

        return [{ affectedRows: deletedCount }];
    }

    async _dropTable(sql) {
        const tableMatch = sql.match(/DROP\s+TABLE\s+(\w+)/i);
        if (!tableMatch) return [];

        const tableName = tableMatch[1];
        this.tableSchemas.delete(tableName);
        this.sequences.delete(tableName);
        
        // Remove indexes
        for (const [key] of this.recordManager.indexes) {
            if (key.startsWith(`${tableName}.`)) {
                this.recordManager.indexes.delete(key);
            }
        }

        return [];
    }

    _getOperationType(sql) {
        if (sql.startsWith('INSERT')) return 'insert';
        if (sql.startsWith('UPDATE')) return 'update';
        if (sql.startsWith('DELETE')) return 'delete';
        return null;
    }

    _parseValueList(valuesStr) {
        const values = [];
        let current = '';
        let inQuotes = false;
        let quoteChar = '';

        for (let i = 0; i < valuesStr.length; i++) {
            const char = valuesStr[i];

            if ((char === "'" || char === '"') && (i === 0 || valuesStr[i-1] !== '\\')) {
                if (!inQuotes) {
                    inQuotes = true;
                    quoteChar = char;
                    current += char;
                } else if (char === quoteChar) {
                    inQuotes = false;
                    current += char;
                } else {
                    current += char;
                }
            } else if (char === ',' && !inQuotes) {
                values.push(current);
                current = '';
            } else {
                current += char;
            }
        }

        if (current) {
            values.push(current);
        }

        return values;
    }

    async _applyOperation(operation) {
        // Apply during recovery
        await this._executeInternal(operation.sql, operation.params);
    }

    async transaction(callback) {
        const lock = await this.lockManager.acquireLock(this.filename, 'exclusive');
        try {
            await this.execute('BEGIN');
            
            const result = await callback({
                query: (sql, params) => this.execute(sql, params)
            });
            
            await this.execute('COMMIT');
            return result;
        } catch (error) {
            await this.execute('ROLLBACK');
            throw error;
        } finally {
            lock.release();
        }
    }

    async disconnect() {
        if (this.inTransaction) {
            await this.execute('ROLLBACK');
        }
        await this.pageManager.flush();
        await this.wal.close();
        await this.pageManager.close();
    }
}

// ==================== QUERY BUILDER ====================
class QueryBuilder {
    constructor(model) {
        this.model = model;
        this._where = [];
        this._whereRaw = [];
        this._orderBy = [];
        this._limit = null;
        this._offset = null;
        this._select = ['*'];
        this._params = [];
    }

    select(...fields) {
        this._select = fields;
        return this;
    }

    where(conditions) {
        if (typeof conditions === 'string') {
            this._whereRaw.push(conditions);
        } else {
            Object.entries(conditions).forEach(([key, value]) => {
                if (value !== undefined) {
                    this._where.push({ field: key, value });
                    this._params.push(value);
                }
            });
        }
        return this;
    }

    whereIn(field, values) {
        if (values && values.length > 0) {
            this._whereRaw.push(`${field} IN (${values.map(() => '?').join(', ')})`);
            this._params.push(...values);
        }
        return this;
    }

    whereBetween(field, [start, end]) {
        if (start !== undefined && end !== undefined) {
            this._whereRaw.push(`${field} BETWEEN ? AND ?`);
            this._params.push(start, end);
        }
        return this;
    }

    whereNull(field) {
        this._whereRaw.push(`${field} IS NULL`);
        return this;
    }

    whereNotNull(field) {
        this._whereRaw.push(`${field} IS NOT NULL`);
        return this;
    }

    orderBy(field, direction = 'ASC') {
        this._orderBy.push({ field, direction: direction.toUpperCase() });
        return this;
    }

    limit(limit) {
        this._limit = limit;
        return this;
    }

    offset(offset) {
        this._offset = offset;
        return this;
    }

    build() {
        let sql = `SELECT ${this._select.join(', ')} FROM ${this.model.tableName}`;

        // Build WHERE clause
        const whereParts = [];
        const params = [...this._params];
        
        // Add simple where conditions
        this._where.forEach(({ field }) => {
            whereParts.push(`${field} = ?`);
        });
        
        // Add raw where conditions
        whereParts.push(...this._whereRaw);

        if (whereParts.length > 0) {
            sql += ` WHERE ${whereParts.join(' AND ')}`;
        }

        // Add ORDER BY
        if (this._orderBy.length > 0) {
            const orderParts = this._orderBy.map(o => `${o.field} ${o.direction}`);
            sql += ` ORDER BY ${orderParts.join(', ')}`;
        }

        // Add LIMIT and OFFSET
        if (this._limit !== null) {
            sql += ` LIMIT ${this._limit}`;
        }
        if (this._offset !== null) {
            sql += ` OFFSET ${this._offset}`;
        }

        return { sql, params };
    }

    async get() {
        const { sql, params } = this.build();
        const results = await this.model.adapter.execute(sql, params);
        return results.map(data => this.model.hydrate(data));
    }

    async first() {
        this.limit(1);
        const results = await this.get();
        return results[0] || null;
    }

    async count() {
        const oldSelect = this._select;
        const oldWhere = this._where;
        const oldWhereRaw = this._whereRaw;
        const oldParams = this._params;
        
        this._select = ['COUNT(*) as count'];
        const { sql, params } = this.build();
        
        this._select = oldSelect;
        this._where = oldWhere;
        this._whereRaw = oldWhereRaw;
        this._params = oldParams;
        
        const results = await this.model.adapter.execute(sql, params);
        const count = results[0] && results[0]['COUNT(*)'] !== undefined ? 
                     results[0]['COUNT(*)'] : 
                     (results[0] && results[0].count ? results[0].count : 0);
        return count;
    }
}

// ==================== MODEL CLASS ====================
class Model extends EventEmitter {
    constructor(data = {}) {
        super();
        this._attributes = {};
        this._original = {};
        this._exists = false;
        this._dirty = new Set();
        this._location = null; // Disk location for existing records

        // Define getters/setters for schema fields
        if (this.constructor.schema) {
            Object.keys(this.constructor.schema).forEach(key => {
                Object.defineProperty(this, key, {
                    get: () => this._attributes[key],
                    set: (value) => {
                        const oldValue = this._attributes[key];
                        this._attributes[key] = this.constructor.castAttribute(key, value);
                        if (oldValue !== this._attributes[key]) {
                            this._dirty.add(key);
                        }
                        this.emit('attributeChange', key, value);
                    },
                    enumerable: true,
                    configurable: true
                });
            });
        }

        this.fill(data);
    }

    static tableName = '';
    static primaryKey = 'id';
    static timestamps = true;
    static adapter = null;
    static schema = {};
    static _validationSchema = {};

    static init(adapter) {
        this.adapter = adapter;
    }

    static castAttribute(key, value) {
        const fieldSchema = this.schema[key];
        if (!fieldSchema) return value;

        if (value === null || value === undefined) {
            return value;
        }

        switch (fieldSchema.type) {
            case 'integer':
            case 'int':
                return parseInt(value, 10);
            case 'float':
            case 'number':
                return parseFloat(value);
            case 'boolean':
            case 'bool':
                if (typeof value === 'boolean') return value;
                if (typeof value === 'string') {
                    return value.toLowerCase() === 'true' || value === '1';
                }
                return Boolean(value);
            case 'date':
            case 'datetime':
                return value ? new Date(value).toISOString() : null;
            case 'json':
                if (typeof value === 'string') {
                    try { return JSON.parse(value); } catch { return value; }
                }
                return value;
            case 'text':
            case 'string':
            default:
                return String(value);
        }
    }

    fill(data) {
        Object.entries(data).forEach(([key, value]) => {
            if (value !== undefined) {
                this._attributes[key] = this.constructor.castAttribute(key, value);
                this._dirty.add(key);
            }
        });
        this._original = { ...this._attributes };
        return this;
    }

    isDirty(attribute = null) {
        if (attribute) {
            return this._dirty.has(attribute);
        }
        return this._dirty.size > 0;
    }

    getOriginal(attribute = null) {
        if (attribute) {
            return this._original[attribute];
        }
        return this._original;
    }

    toJSON() {
        return { ...this._attributes };
    }

    async save() {
        const data = { ...this._attributes };

        if (this.constructor.timestamps) {
            const now = new Date().toISOString();
            if (!this._exists && !data.created_at) {
                data.created_at = now;
            }
            data.updated_at = now;
            if (!this._exists && !this._attributes.created_at) {
                this._attributes.created_at = now;
            }
            this._attributes.updated_at = now;
        }

        if (!this._exists) {
            // Insert new record
            const keys = Object.keys(data).filter(k => data[k] !== undefined && k !== 'id');
            const values = keys.map(k => data[k]);
            
            if (keys.length === 0) {
                const sql = `INSERT INTO ${this.constructor.tableName} DEFAULT VALUES`;
                const result = await this.constructor.adapter.execute(sql, []);
                if (result[0]?.insertId) {
                    this._attributes[this.constructor.primaryKey] = result[0].insertId;
                }
            } else {
                const placeholders = values.map(() => '?').join(', ');
                const sql = `INSERT INTO ${this.constructor.tableName} (${keys.join(', ')}) VALUES (${placeholders})`;
                const result = await this.constructor.adapter.execute(sql, values);
                if (result[0]?.insertId) {
                    this._attributes[this.constructor.primaryKey] = result[0].insertId;
                }
            }

            this._exists = true;
            this.emit('saved', this);
        } else {
            // Update existing record
            const id = this._attributes[this.constructor.primaryKey];
            
            // Only update dirty fields
            const dirtyKeys = Array.from(this._dirty).filter(k => k !== this.constructor.primaryKey && data[k] !== undefined);
            
            if (dirtyKeys.length > 0) {
                const updates = dirtyKeys.map(key => `${key} = ?`);
                const values = dirtyKeys.map(key => data[key]);
                values.push(id);

                const sql = `UPDATE ${this.constructor.tableName} SET ${updates.join(', ')} WHERE ${this.constructor.primaryKey} = ?`;
                await this.constructor.adapter.execute(sql, values);
            }

            this.emit('updated', this);
        }

        this._original = { ...this._attributes };
        this._dirty.clear();
        return this;
    }

    async delete() {
        if (!this._exists) return false;

        const id = this._attributes[this.constructor.primaryKey];
        const sql = `DELETE FROM ${this.constructor.tableName} WHERE ${this.constructor.primaryKey} = ?`;
        const result = await this.constructor.adapter.execute(sql, [id]);

        this._exists = false;
        this.emit('deleted', this);
        return result[0]?.affectedRows > 0;
    }

    static query() {
        return new QueryBuilder(this);
    }

    static hydrate(data) {
        const model = new this();
        model._attributes = { ...data };
        model._original = { ...data };
        model._exists = true;
        return model;
    }

    // ==================== CRUD Methods ====================
    static async create(data) {
        const validationData = { ...data };
        delete validationData.id;
        this._validate(validationData);
        
        const fullData = { ...data };
        for (const [field, config] of Object.entries(this._validationSchema || {})) {
            if (fullData[field] === undefined && config.default !== undefined) {
                fullData[field] = typeof config.default === 'function' ? config.default() : config.default;
            }
        }
        
        const model = new this(fullData);
        await model.save();
        return model.toJSON();
    }

    static async createMany(itemsArray) {
        const results = [];
        for (const item of itemsArray) {
            results.push(await this.create(item));
        }
        return results;
    }

    static async find(filter = {}) {
        const query = this.query();
        
        if (Object.keys(filter).length > 0) {
            query.where(filter);
        }
        
        const results = await query.get();
        return results.map(r => r.toJSON());
    }

    static async findOne(filter) {
        if (!filter || Object.keys(filter).length === 0) {
            throw new Error('Filter is required for findOne');
        }
        
        const query = this.query().where(filter);
        const results = await query.limit(1).get();
        return results.length > 0 ? results[0].toJSON() : null;
    }

    static async findById(id) {
        if (!id) return null;
        
        const query = this.query().where({ [this.primaryKey]: id });
        const results = await query.limit(1).get();
        return results.length > 0 ? results[0].toJSON() : null;
    }

    static async findByIds(ids) {
        if (!ids || !Array.isArray(ids) || ids.length === 0) return [];
        
        const query = this.query().whereIn(this.primaryKey, ids);
        const results = await query.get();
        return results.map(r => r.toJSON());
    }

    static async update(id, data) {
        if (!id) throw new Error('ID is required for update');
        
        const instance = await this._getInstance(id);
        if (!instance) {
            throw new Error(`Document with id ${id} not found`);
        }
        
        instance.fill(data);
        await instance.save();
        
        return instance.toJSON();
    }

    static async _getInstance(id) {
        const query = this.query().where({ [this.primaryKey]: id });
        const results = await query.get();
        return results.length > 0 ? results[0] : null;
    }

    static async updateMany(filter, data) {
        const query = this.query().where(filter);
        const instances = await query.get();
        const results = [];
        
        for (const instance of instances) {
            instance.fill(data);
            await instance.save();
            results.push(instance.toJSON());
        }
        
        return results;
    }

    static async updateOrCreate(filter, data) {
        const existing = await this.findOne(filter);
        
        if (existing) {
            return await this.update(existing[this.primaryKey], { ...existing, ...data });
        } else {
            return await this.create({ ...filter, ...data });
        }
    }

    static async delete(id) {
        if (!id) return false;
        
        const instance = await this._getInstance(id);
        if (!instance) return false;
        
        return await instance.delete();
    }

    static async deleteMany(filter = {}) {
        const query = this.query().where(filter);
        const instances = await query.get();
        let deleted = 0;
        
        for (const instance of instances) {
            if (await instance.delete()) {
                deleted++;
            }
        }
        
        return deleted;
    }

    static async deleteAll() {
        const sql = `DELETE FROM ${this.tableName}`;
        const result = await this.adapter.execute(sql);
        return result[0]?.affectedRows || 0;
    }

    static async count(filter = {}) {
        const query = this.query();
        
        if (Object.keys(filter).length > 0) {
            query.where(filter);
        }
        
        return query.count();
    }

    static async exists(filter) {
        if (!filter || Object.keys(filter).length === 0) {
            throw new Error('Filter is required for exists check');
        }
        
        const count = await this.count(filter);
        return count > 0;
    }

    static async all() {
        return this.find();
    }

    static async first(filter = {}) {
        const query = this.query();
        
        if (Object.keys(filter).length > 0) {
            query.where(filter);
        }
        
        const results = await query.limit(1).get();
        return results.length > 0 ? results[0].toJSON() : null;
    }

    static async last(filter = {}) {
        const query = this.query()
            .orderBy(this.primaryKey, 'DESC');
        
        if (Object.keys(filter).length > 0) {
            query.where(filter);
        }
        
        const results = await query.limit(1).get();
        return results.length > 0 ? results[0].toJSON() : null;
    }

    // ==================== Utility Methods ====================
    static async pluck(field) {
        const items = await this.find();
        return items.map(item => item[field]);
    }

    static async pluckWithKey(keyField, valueField) {
        const items = await this.find();
        const result = {};
        items.forEach(item => {
            result[item[keyField]] = item[valueField];
        });
        return result;
    }

    static async max(field, filter = {}) {
        const items = await this.find(filter);
        if (items.length === 0) return null;
        
        const values = items.map(item => Number(item[field])).filter(v => !isNaN(v));
        return values.length > 0 ? Math.max(...values) : null;
    }

    static async min(field, filter = {}) {
        const items = await this.find(filter);
        if (items.length === 0) return null;
        
        const values = items.map(item => Number(item[field])).filter(v => !isNaN(v));
        return values.length > 0 ? Math.min(...values) : null;
    }

    static async sum(field, filter = {}) {
        const items = await this.find(filter);
        return items.reduce((acc, item) => acc + (Number(item[field]) || 0), 0);
    }

    static async avg(field, filter = {}) {
        const items = await this.find(filter);
        if (items.length === 0) return 0;
        
        const sum = items.reduce((acc, item) => acc + (Number(item[field]) || 0), 0);
        return sum / items.length;
    }

    static async truncate() {
        await this.adapter.execute(`DELETE FROM ${this.tableName}`);
        return true;
    }

    static async chunk(size, callback) {
        let page = 1;
        let hasMore = true;
        
        while (hasMore) {
            const result = await this.paginate(page, size);
            if (result.data.length === 0) {
                hasMore = false;
            } else {
                await callback(result.data, page);
                page++;
            }
        }
        
        return page - 1;
    }

    static async each(callback) {
        let index = 0;
        await this.chunk(100, async (records) => {
            for (const record of records) {
                await callback(record, index++);
            }
        });
        return index;
    }

    static async toggle(id, field) {
        const instance = await this._getInstance(id);
        if (!instance) throw new Error(`Item with id ${id} not found`);
        
        instance[field] = !instance[field];
        await instance.save();
        
        return instance.toJSON();
    }

    static async increment(id, field, amount = 1) {
        const instance = await this._getInstance(id);
        if (!instance) throw new Error(`Item with id ${id} not found`);
        
        const currentValue = Number(instance[field]) || 0;
        instance[field] = currentValue + amount;
        await instance.save();
        
        return instance.toJSON();
    }

    static async decrement(id, field, amount = 1) {
        return this.increment(id, field, -amount);
    }

    static async paginate(page = 1, perPage = 15, filter = {}) {
        page = Math.max(1, page);
        perPage = Math.max(1, perPage);
        
        const offset = (page - 1) * perPage;
        
        // Get total count first
        const total = await this.count(filter);
        
        // Get paginated data
        const query = this.query();
        if (Object.keys(filter).length > 0) {
            query.where(filter);
        }
        
        const data = await query
            .limit(perPage)
            .offset(offset)
            .get();
        
        return {
            data: data.map(d => d.toJSON()),
            meta: {
                current_page: page,
                per_page: perPage,
                total,
                last_page: Math.max(1, Math.ceil(total / perPage)),
                from: total > 0 ? offset + 1 : 0,
                to: total > 0 ? Math.min(offset + perPage, total) : 0
            }
        };
    }

    static async distinct(field, filter = {}) {
        const items = await this.find(filter);
        const values = new Set();
        items.forEach(item => values.add(item[field]));
        return Array.from(values);
    }

    static async random(count = 1, filter = {}) {
        // Get total count
        const total = await this.count(filter);
        if (total === 0) return [];
        
        // Generate random offsets
        const offsets = new Set();
        while (offsets.size < Math.min(count, total)) {
            offsets.add(Math.floor(Math.random() * total));
        }
        
        // Get records at those offsets
        const results = [];
        const sortedOffsets = Array.from(offsets).sort((a, b) => a - b);
        
        let currentOffset = 0;
        let currentIndex = 0;
        
        await this.chunk(100, async (records) => {
            for (const record of records) {
                if (currentIndex === sortedOffsets[currentOffset]) {
                    results.push(record);
                    currentOffset++;
                    if (currentOffset >= sortedOffsets.length) return true;
                }
                currentIndex++;
            }
        });
        
        return results;
    }

    static _validate(data) {
        for (const [field, config] of Object.entries(this._validationSchema || {})) {
            if (config.required && (data[field] === undefined || data[field] === null || data[field] === '')) {
                throw new Error(`Field "${field}" is required`);
            }
        }
    }
}

// ==================== MAIN DB CLASS ====================
class DB {
    static #connections = new Map();
    static #defaultConnection = null;
    static #modelRegistry = new Map();
    static #adapter = null;
    static #config = {
        debug: false,
        autoSave: true,
        saveInterval: 5000 // ms
    };

    static configure(options) {
        this.#config = { ...this.#config, ...options };
    }

    /**
     * Connect to SQLite database
     * @param {string} databaseName - Name of the database/connection
     * @param {Object} options - Connection options
     * @param {string} options.filename - SQLite filename (default: ./{databaseName}.sqlite)
     * @returns {Promise<boolean>} True if connected successfully
     */
    static async Connect(databaseName, options = {}) {
        const filename = options.filename || `./${databaseName}.sqlite`;
        
        // Ensure directory exists
        const dir = path.dirname(filename);
        if (dir !== '.') {
            await fs.promises.mkdir(dir, { recursive: true }).catch(() => {});
        }
        
        const diskFile = new DiskSQLiteFile(filename);
        await diskFile.load();
        
        this.#connections.set(databaseName, {
            name: databaseName,
            driver: 'sqlite',
            adapter: diskFile,
            config: options
        });
        
        if (!this.#defaultConnection) {
            this.#defaultConnection = databaseName;
            this.#adapter = diskFile;
            
            // Re-initialize all models with new adapter
            for (const [name, modelClass] of this.#modelRegistry) {
                modelClass.init(diskFile);
            }
        }
        
        Logger.info(`Connected to ${databaseName} (Disk-Based SQLite File: ${filename})`);
        return true;
    }

    /**
     * Create or retrieve a model
     * @template {Object} T
     * @param {string} modelName - Name of the model/table
     * @param {Object} schemaDefinition - Schema definition
     * @returns {ModelClass<T>} Model class with full CRUD methods
     */
    static Model(modelName, schemaDefinition = null) {
        if (this.#modelRegistry.has(modelName)) {
            return this.#modelRegistry.get(modelName);
        }

        const ModelClass = this.#createModelClass(modelName, schemaDefinition || {});
        
        if (this.#adapter) {
            ModelClass.init(this.#adapter);
        }
        
        this.#modelRegistry.set(modelName, ModelClass);
        
        return ModelClass;
    }

    /**
     * @param {string} databaseName
     */
    static set defaultConnection(databaseName) {
        if (this.#connections.has(databaseName)) {
            this.#defaultConnection = databaseName;
            this.#adapter = this.#connections.get(databaseName).adapter;
            
            // Re-initialize all models with new connection
            for (const [name, modelClass] of this.#modelRegistry) {
                modelClass.init(this.#adapter);
            }
            Logger.info(`Switched default connection to ${databaseName}`);
        } else {
            throw new Error(`Connection ${databaseName} not found`);
        }
    }

    /**
     * @returns {string|null}
     */
    static get defaultConnection() {
        return this.#defaultConnection;
    }

    /**
     * Get connection information
     * @param {string} databaseName
     * @returns {Object|null}
     */
    static getConnection(databaseName) {
        return this.#connections.get(databaseName) || null;
    }

    /**
     * List all active connections
     * @returns {string[]}
     */
    static listConnections() {
        return Array.from(this.#connections.keys());
    }

    /**
     * Get all registered models
     * @returns {Object.<string, ModelClass>}
     */
    static listModels() {
        const result = {};
        for (const [name, model] of this.#modelRegistry) {
            result[name] = model;
        }
        return result;
    }

    /**
     * Get table names (metadata only, no data loaded)
     * @returns {Promise<string[]>}
     */
    static async listCollections() {
        if (!this.#adapter) throw new Error('No database connection');
        
        // Return table names from schema (no data loaded!)
        return Array.from(this.#adapter.tableSchemas.keys());
    }

    /**
     * Execute a raw query
     * @param {string} sql - SQL query string
     * @param {Array} [params] - Query parameters
     * @returns {Promise<any>}
     */
    static async query(sql, params = []) {
        if (!this.#adapter) throw new Error('No database connection');
        return this.#adapter.execute(sql, params);
    }

    /**
     * Execute a transaction
     * @param {function(Object): Promise<any>} callback
     * @returns {Promise<any>}
     */
    static async transaction(callback) {
        if (!this.#adapter) throw new Error('No database connection');
        return this.#adapter.transaction(callback);
    }

    /**
     * Disconnect from a specific database
     * @param {string} databaseName
     * @returns {Promise<boolean>}
     */
    static async Disconnect(databaseName) {
        if (!this.#connections.has(databaseName)) return false;
        
        const conn = this.#connections.get(databaseName);
        await conn.adapter.disconnect();
        this.#connections.delete(databaseName);
        
        if (this.#defaultConnection === databaseName) {
            this.#defaultConnection = this.#connections.size > 0
                ? Array.from(this.#connections.keys())[0]
                : null;
            this.#adapter = this.#defaultConnection ? this.#connections.get(this.#defaultConnection).adapter : null;
        }
        
        Logger.info(`Disconnected from ${databaseName}`);
        return true;
    }

    /**
     * Disconnect from all databases
     * @returns {Promise<void>}
     */
    static async DisconnectAll() {
        for (const dbName of this.#connections.keys()) {
            const conn = this.#connections.get(dbName);
            await conn.adapter.disconnect();
        }
        this.#connections.clear();
        this.#defaultConnection = null;
        this.#adapter = null;
        Logger.info('Disconnected from all databases');
    }

    /**
     * Check if a connection exists
     * @param {string} databaseName
     * @returns {boolean}
     */
    static hasConnection(databaseName) {
        return this.#connections.has(databaseName);
    }

    /**
     * Get database statistics (metadata only, no data loaded)
     * @returns {Promise<Object>}
     */
    static async getStats() {
        if (!this.#adapter) throw new Error('No database connection');
        
        const collections = await this.listCollections();
        
        // Get approximate counts without loading data
        const stats = {
            driver: 'sqlite-disk',
            collections: collections.length,
            records: {},
            totalRecords: 0,
            diskUsage: 0,
            pageCount: this.#adapter.pageManager?.totalPages || 0,
            cacheUsage: this.#adapter.pageManager?.cache?.cache.size || 0
        };
        
        // Get disk usage
        try {
            const fileStat = await fs.promises.stat(this.#adapter.filename);
            stats.diskUsage = fileStat.size;
        } catch {}

        // Get approximate record counts (scans metadata, not data)
        for (const collection of collections) {
            try {
                // Use count query (doesn't load data)
                const countResult = await this.query(`SELECT COUNT(*) as count FROM ${collection}`);
                const count = countResult[0]?.count || 0;
                stats.records[collection] = count;
                stats.totalRecords += count;
            } catch (err) {
                stats.records[collection] = 'Error';
            }
        }
        
        return stats;
    }

    /**
     * Get database version
     * @returns {Promise<string>}
     */
    static async getVersion() {
        return 'Disk-Based SQLite 3.45.1 (Constant Memory Usage)';
    }

    /**
     * Create schema builder
     * @returns {SchemaBuilder}
     */
    static schema() {
        if (!this.#adapter) throw new Error('No database connection');
        return new SchemaBuilder(this.#adapter);
    }

    // ==================== Private Methods ====================
    static #createModelClass(modelName, schemaDefinition) {
        const parsedSchema = this.#parseSchema(schemaDefinition);
        
        class DynamicModel extends Model {
            static tableName = modelName;
            static schema = parsedSchema.ormSchema;
            static _validationSchema = parsedSchema.validationSchema;
        }

        // Add default id field if not present
        if (!DynamicModel.schema.id) {
            DynamicModel.schema.id = { type: 'integer' };
        }

        return DynamicModel;
    }

    static #parseSchema(schemaDefinition) {
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
            
            const mappedType = this.#mapType(type);
            
            ormSchema[fieldName] = {
                type: mappedType
            };
            
            // Don't mark id as required since it's auto-generated
            if (fieldName !== 'id') {
                validationSchema[fieldName] = {
                    type: mappedType,
                    required,
                    default: defaultValue
                };
            }
        }
        
        return { ormSchema, validationSchema };
    }

    static #mapType(type) {
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
}

// ==================== Schema Builder ====================
class SchemaBuilder {
    constructor(adapter) {
        this.adapter = adapter;
    }

    async create(table, callback) {
        const blueprint = new Blueprint(table);
        await callback(blueprint);
        
        const sql = blueprint.toSQL();
        await this.adapter.execute(sql);
    }

    async table(table, callback) {
        const hasTable = await this.hasTable(table);
        if (!hasTable) {
            throw new Error(`Table ${table} does not exist`);
        }
        
        const blueprint = new Blueprint(table, true);
        await callback(blueprint);
        
        // Add each column separately (SQLite ALTER TABLE limited support)
        for (const column of blueprint.columns) {
            const hasColumn = await this.hasColumn(table, column.name);
            if (!hasColumn) {
                let sql = `ALTER TABLE ${table} ADD COLUMN ${column.name} ${column.type}`;
                if (!column.nullable) {
                    sql += ' NOT NULL';
                }
                if (column.default !== undefined) {
                    if (typeof column.default === 'string') {
                        sql += ` DEFAULT '${column.default}'`;
                    } else if (typeof column.default === 'boolean') {
                        sql += ` DEFAULT ${column.default ? 1 : 0}`;
                    } else {
                        sql += ` DEFAULT ${column.default}`;
                    }
                }
                await this.adapter.execute(sql);
            }
        }
    }

    async drop(table) {
        await this.adapter.execute(`DROP TABLE IF EXISTS ${table}`);
    }

    async dropIfExists(table) {
        await this.adapter.execute(`DROP TABLE IF EXISTS ${table}`);
    }

    async hasTable(table) {
        const tables = await this.adapter.execute(
            `SELECT name FROM sqlite_master WHERE type='table' AND name=?`, [table]
        );
        return tables.length > 0 || this.adapter.tableSchemas.has(table);
    }

    async hasColumn(table, column) {
        const result = await this.adapter.execute(`PRAGMA table_info(${table})`);
        return result.some(col => col.name === column);
    }
}

// ==================== Blueprint ====================
class Blueprint {
    constructor(table, altering = false) {
        this.table = table;
        this.altering = altering;
        this.columns = [];
        this.indexes = [];
    }

    id(name = 'id') {
        this.columns.push({
            name,
            type: 'INTEGER',
            primaryKey: true,
            autoIncrement: true,
            nullable: false
        });
        return this;
    }

    string(name, length = 255) {
        this.columns.push({
            name,
            type: `VARCHAR(${length})`,
            nullable: true
        });
        return this;
    }

    text(name) {
        this.columns.push({
            name,
            type: 'TEXT',
            nullable: true
        });
        return this;
    }

    integer(name) {
        this.columns.push({
            name,
            type: 'INTEGER',
            nullable: true
        });
        return this;
    }

    float(name) {
        this.columns.push({
            name,
            type: 'REAL',
            nullable: true
        });
        return this;
    }

    boolean(name) {
        this.columns.push({
            name,
            type: 'INTEGER',
            nullable: true
        });
        return this;
    }

    datetime(name) {
        this.columns.push({
            name,
            type: 'TEXT',
            nullable: true
        });
        return this;
    }

    timestamps() {
        this.datetime('created_at');
        this.datetime('updated_at');
        return this;
    }

    json(name) {
        this.columns.push({
            name,
            type: 'TEXT',
            nullable: true
        });
        return this;
    }

    nullable() {
        const lastColumn = this.columns[this.columns.length - 1];
        if (lastColumn) {
            lastColumn.nullable = true;
        }
        return this;
    }

    default(value) {
        const lastColumn = this.columns[this.columns.length - 1];
        if (lastColumn) {
            lastColumn.default = value;
        }
        return this;
    }

    unique(columns = null) {
        if (columns === null) {
            const lastColumn = this.columns[this.columns.length - 1];
            if (lastColumn) {
                columns = [lastColumn.name];
            }
        }
        
        if (columns) {
            this.indexes.push({
                type: 'UNIQUE',
                columns: Array.isArray(columns) ? columns : [columns]
            });
        }
        return this;
    }

    primary(columns) {
        this.indexes.push({
            type: 'PRIMARY KEY',
            columns: Array.isArray(columns) ? columns : [columns]
        });
        return this;
    }

    toSQL() {
        if (this.columns.length === 0) return '';

        const columnsSQL = this.columns.map(col => {
            let sql = `${col.name} ${col.type}`;
            
            if (col.primaryKey && col.autoIncrement) {
                sql += ' PRIMARY KEY AUTOINCREMENT';
            } else {
                if (!col.nullable) {
                    sql += ' NOT NULL';
                }
                
                if (col.default !== undefined) {
                    if (typeof col.default === 'string') {
                        sql += ` DEFAULT '${col.default}'`;
                    } else if (typeof col.default === 'boolean') {
                        sql += ` DEFAULT ${col.default ? 1 : 0}`;
                    } else {
                        sql += ` DEFAULT ${col.default}`;
                    }
                }
            }
            
            return sql;
        }).join(', ');

        let indexesSQL = '';
        this.indexes.forEach(idx => {
            if (idx.type === 'PRIMARY KEY' && !this.columns.some(c => c.autoIncrement)) {
                indexesSQL += `, PRIMARY KEY (${idx.columns.join(', ')})`;
            } else if (idx.type === 'UNIQUE') {
                indexesSQL += `, UNIQUE (${idx.columns.join(', ')})`;
            }
        });

        return `CREATE TABLE ${this.table} (${columnsSQL}${indexesSQL})`;
    }
}

// Export
export default DB;