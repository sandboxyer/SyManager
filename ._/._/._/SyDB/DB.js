// db.js - Production-ready SQLite ORM with full JSDoc support
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

// ==================== Logger ====================
const Logger = {
    info: (...args) => console.log('📘', ...args),
    error: (...args) => console.error('❌', ...args),
    warn: (...args) => console.warn('⚠️', ...args),
    debug: (...args) => process.env.DEBUG === 'true' && console.log('🔍', ...args)
};

// ==================== SQLite Protocol ====================
class SQLiteProtocol extends EventEmitter {
    constructor(config) {
        super();
        this.config = config;
        this.filename = config.filename || ':memory:';
        this.fd = null;
        this.database = {
            tables: new Map(),      // Schema definitions
            data: new Map(),        // Table data
            sequences: new Map(),   // Auto-increment counters
            rowId: 1,
            savepoint: null,
            transactionDepth: 0
        };
        this.initialized = false;
        this.transactionStack = [];
        this.savepointCounter = 0;
        this.wal = []; // Write-ahead log for transaction rollback
    }

    async connect() {
        if (this.filename === ':memory:') {
            this.initialized = true;
            return Promise.resolve();
        }

        // Ensure directory exists
        const dir = path.dirname(this.filename);
        if (dir !== '.') {
            await fs.promises.mkdir(dir, { recursive: true }).catch(() => {});
        }

        return new Promise((resolve, reject) => {
            // Always create a fresh file for testing, but try to load if exists
            try {
                this.loadDatabase();
                this.initialized = true;
                resolve();
            } catch (e) {
                // If file doesn't exist or is invalid, create a new one
                this.saveDatabase(); // Create the file
                this.initialized = true;
                resolve();
            }
        });
    }

    loadDatabase() {
        try {
            if (fs.existsSync(this.filename)) {
                const data = fs.readFileSync(this.filename, 'utf8');
                if (data && data.trim()) {
                    const parsed = JSON.parse(data);
                    this.database.tables = new Map(Object.entries(parsed.tables || {}));
                    
                    // Convert data back to Maps
                    const dataMap = new Map();
                    Object.entries(parsed.data || {}).forEach(([key, value]) => {
                        dataMap.set(key, value || []);
                    });
                    this.database.data = dataMap;
                    
                    this.database.sequences = new Map(Object.entries(parsed.sequences || {}));
                    this.database.rowId = parsed.rowId || 1;
                } else {
                    this.initializeEmptyDatabase();
                }
            } else {
                this.initializeEmptyDatabase();
            }
        } catch (e) {
            Logger.warn('Error loading database, starting fresh:', e.message);
            this.initializeEmptyDatabase();
        }
    }

    initializeEmptyDatabase() {
        this.database = {
            tables: new Map(),
            data: new Map(),
            sequences: new Map(),
            rowId: 1,
            savepoint: null,
            transactionDepth: 0
        };
        this.saveDatabase();
    }

    saveDatabase() {
        if (this.filename === ':memory:' || !this.initialized) return;

        // Convert Maps to objects for JSON serialization
        const data = {
            tables: Object.fromEntries(this.database.tables),
            data: Object.fromEntries(this.database.data),
            sequences: Object.fromEntries(this.database.sequences),
            rowId: this.database.rowId
        };

        try {
            // Write to temp file first, then rename for atomicity
            const tempFile = `${this.filename}.tmp`;
            fs.writeFileSync(tempFile, JSON.stringify(data, null, 2));
            fs.renameSync(tempFile, this.filename);
        } catch (e) {
            Logger.error('Error saving database:', e);
        }
    }

    async query(sql, params = []) {
        sql = sql.replace(/\s+/g, ' ').trim();
        Logger.debug('SQL:', sql, 'Params:', params);
        
        try {
            // Record current state before modification if in transaction
            if (this.transactionStack.length > 0) {
                this.recordStateForRollback(sql);
            }
            
            const results = this.executeSQL(sql, params || []);
            
            // Only save if not in transaction
            if (this.transactionStack.length === 0) {
                this.saveDatabase();
            }
            
            return results;
        } catch (error) {
            Logger.error('SQL Error:', error.message);
            throw error;
        }
    }

    recordStateForRollback(sql) {
        // For INSERT, UPDATE, DELETE operations, record affected tables
        const upperSql = sql.toUpperCase();
        if (upperSql.startsWith('INSERT') || upperSql.startsWith('UPDATE') || upperSql.startsWith('DELETE')) {
            const tableMatch = sql.match(/(?:INTO|FROM|UPDATE)\s+(\w+)/i);
            if (tableMatch) {
                const tableName = tableMatch[1];
                const currentState = this.getTableSnapshot(tableName);
                this.wal.push({
                    type: 'modification',
                    sql,
                    table: tableName,
                    before: currentState
                });
            }
        }
    }

    getTableSnapshot(tableName) {
        const data = this.database.data.get(tableName) || [];
        return JSON.parse(JSON.stringify(data));
    }

    executeSQL(sql, params) {
        const normalizedSql = sql.trim().toUpperCase();
        
        if (normalizedSql.startsWith('SELECT')) {
            return this.executeSelect(sql, params);
        } else if (normalizedSql.startsWith('INSERT')) {
            return this.executeInsert(sql, params);
        } else if (normalizedSql.startsWith('UPDATE')) {
            return this.executeUpdate(sql, params);
        } else if (normalizedSql.startsWith('DELETE')) {
            return this.executeDelete(sql, params);
        } else if (normalizedSql.startsWith('CREATE TABLE')) {
            return this.executeCreateTable(sql);
        } else if (normalizedSql.startsWith('DROP TABLE')) {
            return this.executeDropTable(sql);
        } else if (normalizedSql.startsWith('PRAGMA')) {
            return this.executePragma(sql);
        } else if (normalizedSql.startsWith('BEGIN')) {
            this.transactionStack.push({ type: 'BEGIN', depth: this.transactionStack.length });
            return [];
        } else if (normalizedSql.startsWith('COMMIT')) {
            this.transactionStack.pop();
            if (this.transactionStack.length === 0) {
                this.wal = []; // Clear WAL on commit
                this.saveDatabase();
            }
            return [];
        } else if (normalizedSql.startsWith('ROLLBACK')) {
            if (sql.toUpperCase().includes('TO')) {
                // Rollback to savepoint
                const rbMatch = sql.match(/ROLLBACK\s+TO\s+(\w+)/i);
                if (rbMatch) {
                    const savepoint = rbMatch[1];
                    this.rollbackToSavepoint(savepoint);
                }
            } else {
                // Full rollback
                this.transactionStack = [];
                this.wal = [];
                this.loadDatabase(); // Reload from disk
            }
            return [];
        } else if (normalizedSql.startsWith('SAVEPOINT')) {
            const spMatch = sql.match(/SAVEPOINT\s+(\w+)/i);
            if (spMatch) {
                const savepoint = spMatch[1];
                this.transactionStack.push({ type: 'SAVEPOINT', name: savepoint, depth: this.transactionStack.length });
                // Record current state for this savepoint
                this.wal.push({ type: 'savepoint', name: savepoint, snapshot: this.getDatabaseSnapshot() });
            }
            return [];
        } else if (normalizedSql.startsWith('RELEASE')) {
            const relMatch = sql.match(/RELEASE\s+(\w+)/i);
            if (relMatch) {
                const savepoint = relMatch[1];
                // Remove all entries up to this savepoint
                while (this.transactionStack.length > 0) {
                    const last = this.transactionStack.pop();
                    if (last.type === 'SAVEPOINT' && last.name === savepoint) {
                        break;
                    }
                }
                // Remove WAL entries after this savepoint
                this.wal = this.wal.filter(entry => 
                    !(entry.type === 'savepoint' && entry.name === savepoint)
                );
            }
            return [];
        }
        
        return [];
    }

    getDatabaseSnapshot() {
        return {
            tables: new Map(this.database.tables),
            data: new Map(Array.from(this.database.data.entries()).map(([k, v]) => [k, [...v]])),
            sequences: new Map(this.database.sequences),
            rowId: this.database.rowId
        };
    }

    rollbackToSavepoint(savepoint) {
        // Find the savepoint in WAL
        for (let i = this.wal.length - 1; i >= 0; i--) {
            const entry = this.wal[i];
            if (entry.type === 'savepoint' && entry.name === savepoint) {
                // Restore snapshot
                this.database = entry.snapshot;
                this.wal = this.wal.slice(0, i);
                break;
            }
        }
        
        // Pop transaction stack until savepoint
        while (this.transactionStack.length > 0) {
            const last = this.transactionStack.pop();
            if (last.type === 'SAVEPOINT' && last.name === savepoint) {
                this.transactionStack.push(last);
                break;
            }
        }
    }

    executeSelect(sql, params) {
        const results = [];
        const fromMatch = sql.match(/FROM\s+(\w+)/i);
        const whereMatch = sql.match(/WHERE\s+(.+?)(?:\s+ORDER\s+BY|\s+GROUP\s+BY|\s+LIMIT|$)/i);
        const orderMatch = sql.match(/ORDER\s+BY\s+(.+?)(?:\s+LIMIT|$)/i);
        const groupMatch = sql.match(/GROUP\s+BY\s+(.+?)(?:\s+HAVING|\s+ORDER\s+BY|\s+LIMIT|$)/i);
        const limitMatch = sql.match(/LIMIT\s+(\d+)(?:\s+OFFSET\s+(\d+))?/i);
        const selectMatch = sql.match(/SELECT\s+(.+?)\s+FROM/i);

        if (!fromMatch || !selectMatch) return [];

        const tableName = fromMatch[1];
        
        // Check if table exists
        if (!this.database.data.has(tableName)) {
            return [];
        }
        
        const tableData = this.database.data.get(tableName) || [];
        const fields = selectMatch[1].split(',').map(f => f.trim());

        // Handle COUNT(*)
        if (fields.length === 1 && fields[0].toUpperCase() === 'COUNT(*)') {
            return [{ 'COUNT(*)': tableData.length }];
        }

        let filteredData = [...tableData];

        // Apply WHERE
        if (whereMatch) {
            const condition = whereMatch[1];
            filteredData = filteredData.filter(row => {
                return this.evaluateCondition(row, condition, [...params]);
            });
        }

        // Apply ORDER BY
        if (orderMatch && !groupMatch) {
            const orderClause = orderMatch[1];
            const orders = orderClause.split(',').map(o => o.trim());
            
            filteredData.sort((a, b) => {
                for (const order of orders) {
                    const [field, direction] = order.split(/\s+/);
                    const desc = direction && direction.toUpperCase() === 'DESC';
                    
                    // Handle potential undefined values
                    const aVal = a[field] !== undefined ? a[field] : null;
                    const bVal = b[field] !== undefined ? b[field] : null;
                    
                    if (aVal === null && bVal === null) continue;
                    if (aVal === null) return desc ? -1 : 1;
                    if (bVal === null) return desc ? 1 : -1;
                    
                    if (aVal < bVal) return desc ? 1 : -1;
                    if (aVal > bVal) return desc ? -1 : 1;
                }
                return 0;
            });
        }

        // Apply LIMIT/OFFSET
        if (limitMatch) {
            const limit = parseInt(limitMatch[1], 10);
            const offset = limitMatch[2] ? parseInt(limitMatch[2], 10) : 0;
            filteredData = filteredData.slice(offset, offset + limit);
        }

        // Format results
        filteredData.forEach(row => {
            if (fields[0] === '*') {
                results.push({ ...row });
            } else {
                const resultRow = {};
                fields.forEach(field => {
                    field = field.trim();
                    if (field.includes(' as ') || field.includes(' AS ')) {
                        const [expr, alias] = field.split(/\s+as\s+/i);
                        resultRow[alias.trim()] = row[expr.trim()];
                    } else {
                        resultRow[field] = row[field];
                    }
                });
                results.push(resultRow);
            }
        });

        return results;
    }

    executeInsert(sql, params) {
        const tableMatch = sql.match(/INTO\s+(\w+)/i);
        const valuesMatch = sql.match(/VALUES\s*\((.+?)\)/i);

        if (!tableMatch || !valuesMatch) return [];

        const tableName = tableMatch[1];
        
        // Parse columns if provided
        const columnsMatch = sql.match(/\(([^)]+)\)\s*VALUES/i);
        let columns = [];

        if (columnsMatch) {
            columns = columnsMatch[1].split(',').map(c => c.trim());
        }

        // Parse values
        const valuesStr = valuesMatch[1];
        const valueMatches = this.parseValueList(valuesStr);

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

        // Get table schema
        const table = this.database.tables.get(tableName) || [];
        
        // Get or initialize table data
        if (!this.database.data.has(tableName)) {
            this.database.data.set(tableName, []);
        }
        const tableData = this.database.data.get(tableName);
        
        // Get next sequence value
        const sequence = this.database.sequences.get(tableName) || 1;
        
        // Create new row
        const newRow = {};
        
        // Add id from sequence
        newRow.id = sequence;
        
        // Map values to columns
        if (columns.length > 0) {
            columns.forEach((col, index) => {
                if (index < values.length) {
                    newRow[col] = values[index];
                }
            });
        } else {
            // Handle DEFAULT VALUES
            // Just use id
        }

        // Apply defaults from schema for any missing fields
        table.forEach(col => {
            if (newRow[col.name] === undefined) {
                if (col.default !== undefined) {
                    newRow[col.name] = typeof col.default === 'function' ? col.default() : col.default;
                } else if (col.nullable) {
                    newRow[col.name] = null;
                }
            }
        });

        // Add timestamps if they exist in schema
        const now = new Date().toISOString();
        if (table.some(col => col.name === 'created_at')) {
            if (!newRow.created_at) newRow.created_at = now;
        }
        if (table.some(col => col.name === 'updated_at')) {
            newRow.updated_at = now;
        }

        tableData.push(newRow);
        this.database.data.set(tableName, tableData);
        this.database.sequences.set(tableName, sequence + 1);
        this.database.rowId = Math.max(this.database.rowId, sequence + 1);

        return [{ insertId: sequence }];
    }

    executeUpdate(sql, params) {
        const tableMatch = sql.match(/UPDATE\s+(\w+)/i);
        const setMatch = sql.match(/SET\s+(.+?)(?:\s+WHERE|$)/i);
        const whereMatch = sql.match(/WHERE\s+(.+?)$/i);

        if (!tableMatch || !setMatch) return [];

        const tableName = tableMatch[1];
        
        // Check if table exists
        if (!this.database.data.has(tableName)) {
            return [{ affectedRows: 0 }];
        }
        
        const tableData = this.database.data.get(tableName) || [];
        let updatedCount = 0;

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

        // Add updated_at timestamp if column exists
        const table = this.database.tables.get(tableName) || [];
        if (table.some(col => col.name === 'updated_at')) {
            assignments.push({ field: 'updated_at', value: new Date().toISOString() });
        }

        // Create a copy of the rows to update
        const updatedRows = [];
        
        for (let i = 0; i < tableData.length; i++) {
            let shouldUpdate = true;

            if (whereMatch) {
                shouldUpdate = this.evaluateCondition(tableData[i], whereMatch[1], [...params]);
            }

            if (shouldUpdate) {
                // Create a new row object with updates
                const updatedRow = { ...tableData[i] };
                assignments.forEach(({ field, value }) => {
                    updatedRow[field] = value;
                });
                updatedRows.push(updatedRow);
                updatedCount++;
            } else {
                updatedRows.push(tableData[i]);
            }
        }

        this.database.data.set(tableName, updatedRows);
        return [{ affectedRows: updatedCount }];
    }

    executeDelete(sql, params) {
        const tableMatch = sql.match(/FROM\s+(\w+)/i);
        const whereMatch = sql.match(/WHERE\s+(.+?)$/i);

        if (!tableMatch) return [];

        const tableName = tableMatch[1];
        
        // Check if table exists
        if (!this.database.data.has(tableName)) {
            return [{ affectedRows: 0 }];
        }
        
        const tableData = this.database.data.get(tableName) || [];
        const initialLength = tableData.length;

        let filteredData;
        if (whereMatch) {
            filteredData = tableData.filter(row =>
                !this.evaluateCondition(row, whereMatch[1], [...params])
            );
        } else {
            filteredData = [];
        }

        this.database.data.set(tableName, filteredData);

        const deletedCount = initialLength - filteredData.length;
        return [{ affectedRows: deletedCount }];
    }

    executeCreateTable(sql) {
        const tableMatch = sql.match(/CREATE\s+TABLE\s+(\w+)/i);
        const columnsMatch = sql.match(/\((.+)\)/s);

        if (!tableMatch || !columnsMatch) return [];

        const tableName = tableMatch[1];
        const columnsStr = columnsMatch[1];

        const columnDefs = [];
        const columnParts = columnsStr.split(',').map(c => c.trim());

        columnParts.forEach(part => {
            // Skip indexes and constraints for now
            if (part.toUpperCase().startsWith('PRIMARY KEY') || 
                part.toUpperCase().startsWith('UNIQUE') ||
                part.toUpperCase().startsWith('FOREIGN KEY')) {
                return;
            }

            // Parse column definition
            const words = part.split(/\s+/);
            const column = {
                name: words[0],
                type: words[1]?.toUpperCase() || 'TEXT',
                primaryKey: part.toUpperCase().includes('PRIMARY KEY'),
                autoIncrement: part.toUpperCase().includes('AUTOINCREMENT'),
                nullable: part.toUpperCase().includes('NOT NULL') ? false : true,
            };

            // Parse DEFAULT value
            const defaultMatch = part.match(/DEFAULT\s+('.*?'|\d+|NULL|TRUE|FALSE)/i);
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
                } else {
                    column.default = defaultValue;
                }
            }

            columnDefs.push(column);
        });

        this.database.tables.set(tableName, columnDefs);
        this.database.data.set(tableName, []);
        this.database.sequences.set(tableName, 1);
        this.saveDatabase();

        return [];
    }

    executeDropTable(sql) {
        const tableMatch = sql.match(/DROP\s+TABLE\s+(\w+)/i);

        if (!tableMatch) return [];

        const tableName = tableMatch[1];

        this.database.tables.delete(tableName);
        this.database.data.delete(tableName);
        this.database.sequences.delete(tableName);
        this.saveDatabase();

        return [];
    }

    executePragma(sql) {
        const pragmaMatch = sql.match(/PRAGMA\s+(\w+)/i);

        if (!pragmaMatch) return [];

        const pragma = pragmaMatch[1];

        if (pragma === 'table_info') {
            const tableMatch = sql.match(/table_info\((\w+)\)/i);
            if (tableMatch) {
                const tableName = tableMatch[1];
                const table = this.database.tables.get(tableName) || [];
                return table.map((col, index) => ({
                    cid: index,
                    name: col.name,
                    type: col.type,
                    notnull: col.nullable ? 0 : 1,
                    dflt_value: col.default,
                    pk: col.primaryKey ? 1 : 0
                }));
            }
        } else if (pragma === 'database_list') {
            return [{ seq: 0, name: 'main', file: this.filename }];
        } else if (pragma === 'foreign_keys') {
            return [{ foreign_keys: 0 }];
        }

        return [];
    }

    parseValueList(valuesStr) {
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

    evaluateCondition(row, condition, params) {
        // Handle AND
        if (condition.toUpperCase().includes(' AND ')) {
            const parts = condition.split(/\s+AND\s+/i);
            return parts.every(part => this.evaluateSingleCondition(row, part, params));
        }

        // Handle OR
        if (condition.toUpperCase().includes(' OR ')) {
            const parts = condition.split(/\s+OR\s+/i);
            return parts.some(part => this.evaluateSingleCondition(row, part, params));
        }

        return this.evaluateSingleCondition(row, condition, params);
    }

    evaluateSingleCondition(row, condition, params) {
        const operators = ['>=', '<=', '!=', '<>', '=', '<', '>', ' LIKE ', ' IN '];

        for (const op of operators) {
            const opIndex = condition.indexOf(op.trim());
            if (opIndex > 0) {
                const field = condition.substring(0, opIndex).trim();
                let value = condition.substring(opIndex + op.length).trim();

                if (op.trim() === 'IN') {
                    const inList = value.substring(1, value.length - 1).split(',').map(v => {
                        v = v.trim();
                        if (v === '?') return params.shift();
                        if (v.startsWith("'") && v.endsWith("'")) return v.substring(1, v.length - 1);
                        if (v === 'NULL') return null;
                        if (v === 'true') return true;
                        if (v === 'false') return false;
                        if (!isNaN(v)) return Number(v);
                        return v;
                    });
                    return inList.includes(row[field]);
                }

                if (op.trim() === 'LIKE') {
                    if (value === '?') {
                        value = params.shift();
                    } else if (value.startsWith("'") && value.endsWith("'")) {
                        value = value.substring(1, value.length - 1);
                    }
                    const pattern = value.replace(/%/g, '.*');
                    const regex = new RegExp(`^${pattern}$`, 'i');
                    return regex.test(String(row[field] || ''));
                }

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

                const rowValue = row[field];

                switch (op.trim()) {
                    case '=': 
                        if (rowValue === null || value === null) return rowValue === value;
                        if (typeof rowValue === 'boolean' || typeof value === 'boolean') {
                            return Boolean(rowValue) === Boolean(value);
                        }
                        return String(rowValue) == String(value);
                    case '!=': case '<>': 
                        if (rowValue === null || value === null) return rowValue !== value;
                        if (typeof rowValue === 'boolean' || typeof value === 'boolean') {
                            return Boolean(rowValue) !== Boolean(value);
                        }
                        return String(rowValue) != String(value);
                    case '<': return rowValue < value;
                    case '>': return rowValue > value;
                    case '<=': return rowValue <= value;
                    case '>=': return rowValue >= value;
                }
            }
        }

        return true;
    }

    async execute(sql, params = []) {
        const results = await this.query(sql, params);

        let rowsAffected = 0;
        let insertId = null;

        if (results && results.length > 0) {
            if (results[0].affectedRows !== undefined) {
                rowsAffected = results[0].affectedRows;
            } else if (results[0].insertId !== undefined) {
                insertId = results[0].insertId;
                rowsAffected = 1;
            } else {
                rowsAffected = results.length;
            }
        }

        return { rowsAffected, insertId };
    }

    async transaction(callback) {
        const savepoint = `sp_${Date.now()}_${this.savepointCounter++}`;

        try {
            await this.query(`SAVEPOINT ${savepoint}`);

            const result = await callback({
                query: (sql, params) => this.query(sql, params),
                execute: (sql, params) => this.execute(sql, params),
                connection: this
            });

            await this.query(`RELEASE ${savepoint}`);
            return result;
        } catch (error) {
            await this.query(`ROLLBACK TO ${savepoint}`);
            throw error;
        }
    }

    disconnect() {
        this.saveDatabase();
        this.emit('disconnected');
    }
}

// ==================== Query Builder ====================
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
        this._whereRaw.push(`${field} BETWEEN ? AND ?`);
        this._params.push(start, end);
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

        return { sql, params: this._params };
    }

    async get() {
        const { sql, params } = this.build();
        const results = await this.model.adapter.query(sql, params);
        return results.map(data => this.model.hydrate(data));
    }

    async first() {
        this.limit(1);
        const results = await this.get();
        return results[0] || null;
    }

    async count() {
        const oldSelect = this._select;
        this._select = ['COUNT(*) as count'];
        const { sql, params } = this.build();
        this._select = oldSelect;
        
        const results = await this.model.adapter.query(sql, params);
        return results[0]?.count || 0;
    }
}

// ==================== Model Class ====================
class Model extends EventEmitter {
    constructor(data = {}) {
        super();
        this._attributes = {};
        this._original = {};
        this._exists = false;
        this._dirty = new Set();

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
        }

        if (!this._exists) {
            // Filter out undefined values and id
            const keys = Object.keys(data).filter(k => data[k] !== undefined && k !== 'id');
            const values = keys.map(k => data[k]);
            
            if (keys.length === 0) {
                // Insert with only defaults
                const sql = `INSERT INTO ${this.constructor.tableName} DEFAULT VALUES`;
                const result = await this.constructor.adapter.execute(sql, []);
                if (result.insertId) {
                    this._attributes[this.constructor.primaryKey] = result.insertId;
                }
            } else {
                const placeholders = values.map(() => '?').join(', ');
                const sql = `INSERT INTO ${this.constructor.tableName} (${keys.join(', ')}) VALUES (${placeholders})`;
                const result = await this.constructor.adapter.execute(sql, values);
                if (result.insertId) {
                    this._attributes[this.constructor.primaryKey] = result.insertId;
                }
            }

            this._exists = true;
            this.emit('saved', this);
        } else {
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
        return result.rowsAffected > 0;
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
        this._validate(data);
        
        // Apply defaults from validation schema
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
        return result.rowsAffected || 0;
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
        await this.adapter.query(`DELETE FROM ${this.tableName}`);
        return true;
    }

    static async chunk(size, callback) {
        const items = await this.find();
        const chunks = [];
        
        for (let i = 0; i < items.length; i += size) {
            chunks.push(items.slice(i, i + size));
        }
        
        for (let i = 0; i < chunks.length; i++) {
            await callback(chunks[i], i + 1);
        }
        
        return chunks.length;
    }

    static async each(callback) {
        const items = await this.find();
        
        for (let i = 0; i < items.length; i++) {
            await callback(items[i], i);
        }
        
        return items.length;
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
                last_page: Math.ceil(total / perPage) || 1,
                from: offset + 1,
                to: Math.min(offset + perPage, total)
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
        const items = await this.find(filter);
        const shuffled = [...items].sort(() => 0.5 - Math.random());
        return shuffled.slice(0, count);
    }

    static _validate(data) {
        for (const [field, config] of Object.entries(this._validationSchema || {})) {
            if (config.required && (data[field] === undefined || data[field] === null || data[field] === '')) {
                throw new Error(`Field "${field}" is required`);
            }
        }
    }
}

// ==================== Main DB Class ====================
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
        
        // Create empty file if it doesn't exist
        if (!fs.existsSync(filename)) {
            fs.writeFileSync(filename, JSON.stringify({ tables: {}, data: {}, sequences: {}, rowId: 1 }));
        }
        
        const adapter = new SQLiteProtocol({ filename });
        await adapter.connect();
        
        this.#connections.set(databaseName, {
            name: databaseName,
            driver: 'sqlite',
            adapter,
            config: options
        });
        
        if (!this.#defaultConnection) {
            this.#defaultConnection = databaseName;
            this.#adapter = adapter;
            
            // Re-initialize all models with new adapter
            for (const [name, modelClass] of this.#modelRegistry) {
                modelClass.init(adapter);
            }
        }
        
        Logger.info(`Connected to ${databaseName} (SQLite)`);
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
     * Get table names
     * @returns {Promise<string[]>}
     */
    static async listCollections() {
        if (!this.#adapter) throw new Error('No database connection');
        
        return Array.from(this.#adapter.database.tables.keys());
    }

    /**
     * Execute a raw query
     * @param {string} sql - SQL query string
     * @param {Array} [params] - Query parameters
     * @returns {Promise<any>}
     */
    static async query(sql, params = []) {
        if (!this.#adapter) throw new Error('No database connection');
        return this.#adapter.query(sql, params);
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
     * Get database statistics
     * @returns {Promise<Object>}
     */
    static async getStats() {
        if (!this.#adapter) throw new Error('No database connection');
        
        const collections = await this.listCollections();
        const stats = {
            driver: 'sqlite',
            collections: collections.length,
            records: {},
            totalRecords: 0
        };
        
        for (const collection of collections) {
            try {
                const data = this.#adapter.database.data.get(collection) || [];
                const count = data.length;
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
        return '3.45.1 (JSON-based SQLite emulation)';
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
            
            validationSchema[fieldName] = {
                type: mappedType,
                required,
                default: defaultValue
            };
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
        
        // Add each column separately
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
        const tables = await this.adapter.query(
            `SELECT name FROM sqlite_master WHERE type='table' AND name='${table}'`
        );
        return tables.length > 0 || this.adapter.database.tables.has(table);
    }

    async hasColumn(table, column) {
        const result = await this.adapter.query(`PRAGMA table_info(${table})`);
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