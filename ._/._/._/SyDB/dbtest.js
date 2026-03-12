// test.js - Comprehensive test suite for SQLite ORM
import DB from './DB.js';
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Test configuration
const TEST_DB = 'test_database';
const TEST_FILE = path.join(__dirname, `${TEST_DB}.sqlite`);

// Colors for console output
const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    dim: '\x1b[2m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m'
};

// Test statistics
const stats = {
    total: 0,
    passed: 0,
    failed: 0,
    skipped: 0
};

// Test timer
let testStartTime = Date.now();

// Helper function to log test results
function logTest(name, result, error = null) {
    stats.total++;
    const status = result ? 'PASS' : 'FAIL';
    const color = result ? colors.green : colors.red;
    const icon = result ? '✅' : '❌';
    
    console.log(`${color}${icon} ${name}${colors.reset}`);
    if (error) {
        console.log(`${colors.red}   └─ Error: ${error.message}${colors.reset}`);
        if (error.stack) {
            console.log(`${colors.dim}${error.stack.split('\n').slice(1).join('\n')}${colors.reset}`);
        }
    }
    
    if (result) {
        stats.passed++;
    } else {
        stats.failed++;
    }
}

function logSkip(name, reason) {
    stats.total++;
    stats.skipped++;
    console.log(`${colors.yellow}⏭️  ${name} (Skipped: ${reason})${colors.reset}`);
}

function logSection(title) {
    console.log(`\n${colors.bright}${colors.cyan}═══════════════════════════════════════════════════════════════${colors.reset}`);
    console.log(`${colors.bright}${colors.cyan}   ${title}${colors.reset}`);
    console.log(`${colors.bright}${colors.cyan}═══════════════════════════════════════════════════════════════${colors.reset}\n`);
}

function logSubSection(title) {
    console.log(`\n${colors.bright}${colors.blue}─── ${title} ───${colors.reset}\n`);
}

// Clean up before and after tests
async function cleanup() {
    if (fs.existsSync(TEST_FILE)) {
        fs.unlinkSync(TEST_FILE);
    }
    const walFile = `${TEST_FILE}-wal`;
    if (fs.existsSync(walFile)) {
        fs.unlinkSync(walFile);
    }
}

// Main test function
async function runTests() {
    console.log(`${colors.bright}${colors.magenta}`);
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║         SQLite ORM Comprehensive Test Suite                  ║');
    console.log('╚══════════════════════════════════════════════════════════════╝');
    console.log(`${colors.reset}\n`);

    testStartTime = Date.now();

    try {
        await cleanup();
        
        // ==================== CONNECTION TESTS ====================
        logSection('CONNECTION TESTS');
        
        // Test 1: Connect to database
        try {
            const connected = await DB.Connect(TEST_DB, { filename: TEST_FILE });
            assert.strictEqual(connected, true, 'Should return true on successful connection');
            assert.ok(DB.hasConnection(TEST_DB), 'Connection should be registered');
            assert.strictEqual(DB.defaultConnection, TEST_DB, 'Default connection should be set');
            logTest('Connect to database', true);
        } catch (error) {
            logTest('Connect to database', false, error);
        }

        // Test 2: Get connection info
        try {
            const conn = DB.getConnection(TEST_DB);
            assert.ok(conn, 'Connection info should exist');
            assert.strictEqual(conn.name, TEST_DB, 'Connection name should match');
            assert.strictEqual(conn.driver, 'sqlite', 'Driver should be sqlite');
            logTest('Get connection info', true);
        } catch (error) {
            logTest('Get connection info', false, error);
        }

        // Test 3: List connections
        try {
            const connections = DB.listConnections();
            assert.ok(Array.isArray(connections), 'Should return an array');
            assert.ok(connections.includes(TEST_DB), 'Should include test database');
            logTest('List connections', true);
        } catch (error) {
            logTest('List connections', false, error);
        }

        // Test 4: Get database version
        try {
            const version = await DB.getVersion();
            assert.ok(version.includes('SQLite'), 'Version should mention SQLite');
            logTest('Get database version', true);
        } catch (error) {
            logTest('Get database version', false, error);
        }

        // ==================== SCHEMA DEFINITION TESTS ====================
        logSection('SCHEMA DEFINITION TESTS');

        // Define User model with comprehensive schema
        const User = DB.Model('users', {
            id: { type: 'integer', required: true },
            username: { type: 'string', required: true },
            email: { type: 'string', required: true },
            age: { type: 'integer' },
            salary: { type: 'float' },
            is_active: { type: 'boolean', default: true },
            metadata: { type: 'json' },
            created_at: { type: 'datetime' },
            updated_at: { type: 'datetime' }
        });

        // Test 5: Model registration
        try {
            assert.ok(User, 'Model should be created');
            assert.strictEqual(User.tableName, 'users', 'Table name should be set');
            assert.ok(User.schema, 'Schema should be defined');
            assert.ok(User.schema.id, 'ID field should exist');
            logTest('Model registration', true);
        } catch (error) {
            logTest('Model registration', false, error);
        }

        // Test 6: List models
        try {
            const models = DB.listModels();
            assert.ok(models.users, 'Should include users model');
            assert.strictEqual(models.users.tableName, 'users', 'Model should have correct table name');
            logTest('List models', true);
        } catch (error) {
            logTest('List models', false, error);
        }

        // Test 7: Create table using schema builder
        try {
            await DB.schema().create('posts', (table) => {
                table.id();
                table.string('title').nullable(false);
                table.text('content');
                table.integer('user_id');
                table.boolean('published').default(false);
                table.timestamps();
                table.unique('title');
            });

            const tables = await DB.listCollections();
            assert.ok(tables.includes('posts'), 'Posts table should exist');
            logTest('Create table with schema builder', true);
        } catch (error) {
            logTest('Create table with schema builder', false, error);
        }

        // Test 8: Check if table exists
        try {
            const hasTable = await DB.schema().hasTable('posts');
            assert.strictEqual(hasTable, true, 'Posts table should exist');
            logTest('Check table existence', true);
        } catch (error) {
            logTest('Check table existence', false, error);
        }

        // Test 9: Check if column exists
        try {
            const hasColumn = await DB.schema().hasColumn('posts', 'title');
            assert.strictEqual(hasColumn, true, 'Title column should exist');
            logTest('Check column existence', true);
        } catch (error) {
            logTest('Check column existence', false, error);
        }

        // ==================== CRUD OPERATIONS TESTS ====================
        logSection('CRUD OPERATIONS TESTS');

        // Test 10: Create single record
        try {
            const user = await User.create({
                username: 'john_doe',
                email: 'john@example.com',
                age: 30,
                salary: 50000.50,
                metadata: { theme: 'dark', notifications: true }
            });

            assert.ok(user.id, 'Should have an ID');
            assert.strictEqual(user.username, 'john_doe', 'Username should match');
            assert.strictEqual(user.email, 'john@example.com', 'Email should match');
            assert.strictEqual(user.age, 30, 'Age should match');
            assert.strictEqual(user.salary, 50000.50, 'Salary should match');
            assert.strictEqual(user.is_active, true, 'Default value should be applied');
            assert.deepStrictEqual(user.metadata, { theme: 'dark', notifications: true }, 'JSON should be parsed');
            assert.ok(user.created_at, 'Created_at should be set');
            assert.ok(user.updated_at, 'Updated_at should be set');

            logTest('Create single record', true);
        } catch (error) {
            logTest('Create single record', false, error);
        }

        // Test 11: Create multiple records
        try {
            const users = await User.createMany([
                { username: 'jane_doe', email: 'jane@example.com', age: 28, salary: 60000 },
                { username: 'bob_smith', email: 'bob@example.com', age: 35, salary: 75000 },
                { username: 'alice_wonder', email: 'alice@example.com', age: 25, salary: 45000 }
            ]);

            assert.strictEqual(users.length, 3, 'Should create 3 users');
            users.forEach((user, index) => {
                assert.ok(user.id, 'Each user should have an ID');
            });

            logTest('Create multiple records', true);
        } catch (error) {
            logTest('Create multiple records', false, error);
        }

        // Test 12: Find by ID
        try {
            const firstUser = await User.first();
            const found = await User.findById(firstUser.id);
            
            assert.ok(found, 'Should find user');
            assert.strictEqual(found.id, firstUser.id, 'IDs should match');
            assert.strictEqual(found.username, firstUser.username, 'Username should match');

            logTest('Find by ID', true);
        } catch (error) {
            logTest('Find by ID', false, error);
        }

        // Test 13: Find by multiple IDs
        try {
            const allUsers = await User.all();
            const ids = allUsers.slice(0, 2).map(u => u.id);
            const users = await User.findByIds(ids);
            
            assert.strictEqual(users.length, 2, 'Should find 2 users');
            assert.ok(users.every(u => ids.includes(u.id)), 'Should find correct users');

            logTest('Find by multiple IDs', true);
        } catch (error) {
            logTest('Find by multiple IDs', false, error);
        }

        // Test 14: Find with filter
        try {
            const users = await User.find({ age: 30 });
            
            assert.ok(users.length >= 1, 'Should find at least one user');
            users.forEach(user => {
                assert.strictEqual(user.age, 30, 'Age should match filter');
            });

            logTest('Find with filter', true);
        } catch (error) {
            logTest('Find with filter', false, error);
        }

        // Test 15: Find one with filter
        try {
            const user = await User.findOne({ username: 'jane_doe' });
            
            assert.ok(user, 'Should find user');
            assert.strictEqual(user.username, 'jane_doe', 'Username should match');

            logTest('Find one with filter', true);
        } catch (error) {
            logTest('Find one with filter', false, error);
        }

        // Test 16: Find with non-existent filter
        try {
            const user = await User.findOne({ username: 'nonexistent' });
            
            assert.strictEqual(user, null, 'Should return null for non-existent');

            logTest('Find non-existent record', true);
        } catch (error) {
            logTest('Find non-existent record', false, error);
        }

        // Test 17: Update record
        try {
            const user = await User.first();
            const updated = await User.update(user.id, { 
                age: 31, 
                salary: 55000,
                metadata: { theme: 'light' }
            });
            
            assert.strictEqual(updated.age, 31, 'Age should be updated');
            assert.strictEqual(updated.salary, 55000, 'Salary should be updated');
            assert.deepStrictEqual(updated.metadata, { theme: 'light' }, 'Metadata should be updated');
            assert.ok(new Date(updated.updated_at) > new Date(user.updated_at), 'Updated_at should be newer');

            logTest('Update record', true);
        } catch (error) {
            logTest('Update record', false, error);
        }

        // Test 18: Update multiple records
        try {
            const updated = await User.updateMany({ age: 30 }, { is_active: false });
            
            assert.ok(updated.length >= 1, 'Should update at least one record');
            updated.forEach(user => {
                assert.strictEqual(user.is_active, false, 'is_active should be false');
            });

            logTest('Update multiple records', true);
        } catch (error) {
            logTest('Update multiple records', false, error);
        }

        // Test 19: Update or create (existing)
        try {
            const existing = await User.first();
            const result = await User.updateOrCreate(
                { username: existing.username },
                { email: 'updated@example.com' }
            );
            
            assert.strictEqual(result.email, 'updated@example.com', 'Email should be updated');
            assert.strictEqual(result.id, existing.id, 'ID should remain the same');

            logTest('Update or create (existing)', true);
        } catch (error) {
            logTest('Update or create (existing)', false, error);
        }

        // Test 20: Update or create (new)
        try {
            const result = await User.updateOrCreate(
                { username: 'new_user' },
                { email: 'new@example.com', age: 40 }
            );
            
            assert.ok(result.id, 'Should create new user');
            assert.strictEqual(result.username, 'new_user', 'Username should match');
            assert.strictEqual(result.email, 'new@example.com', 'Email should match');

            logTest('Update or create (new)', true);
        } catch (error) {
            logTest('Update or create (new)', false, error);
        }

        // ==================== QUERY BUILDER TESTS ====================
        logSection('QUERY BUILDER TESTS');

        // Test 21: Query builder - simple where
        try {
            const query = User.query().where({ age: 28 });
            const users = await query.get();
            
            assert.ok(users.length >= 1, 'Should find users');
            users.forEach(user => {
                assert.strictEqual(user.age, 28, 'Age should match');
            });

            logTest('Query builder - simple where', true);
        } catch (error) {
            logTest('Query builder - simple where', false, error);
        }

        // Test 22: Query builder - whereIn
        try {
            const users = await User.query()
                .whereIn('age', [25, 28, 30])
                .get();
            
            assert.ok(users.length >= 1, 'Should find users');
            users.forEach(user => {
                assert.ok([25, 28, 30].includes(user.age), 'Age should be in range');
            });

            logTest('Query builder - whereIn', true);
        } catch (error) {
            logTest('Query builder - whereIn', false, error);
        }

        // Test 23: Query builder - whereBetween
        try {
            const users = await User.query()
                .whereBetween('age', [25, 30])
                .get();
            
            assert.ok(users.length >= 1, 'Should find users');
            users.forEach(user => {
                assert.ok(user.age >= 25 && user.age <= 30, 'Age should be between 25 and 30');
            });

            logTest('Query builder - whereBetween', true);
        } catch (error) {
            logTest('Query builder - whereBetween', false, error);
        }

        // Test 24: Query builder - whereNull
        try {
            // Create a user with null age
            await User.create({
                username: 'null_age',
                email: 'null@example.com',
                age: null
            });
            
            const users = await User.query()
                .whereNull('age')
                .get();
            
            assert.ok(users.length >= 1, 'Should find users with null age');
            users.forEach(user => {
                assert.strictEqual(user.age, null, 'Age should be null');
            });

            logTest('Query builder - whereNull', true);
        } catch (error) {
            logTest('Query builder - whereNull', false, error);
        }

        // Test 25: Query builder - orderBy
        try {
            const users = await User.query()
                .orderBy('age', 'DESC')
                .limit(3)
                .get();
            
            assert.strictEqual(users.length, 3, 'Should return 3 users');
            // Check if ages are in descending order
            for (let i = 0; i < users.length - 1; i++) {
                assert.ok(users[i].age >= users[i + 1].age, 'Ages should be in descending order');
            }

            logTest('Query builder - orderBy', true);
        } catch (error) {
            logTest('Query builder - orderBy', false, error);
        }

        // Test 26: Query builder - limit and offset
        try {
            const firstPage = await User.query()
                .limit(2)
                .offset(0)
                .get();
            
            const secondPage = await User.query()
                .limit(2)
                .offset(2)
                .get();
            
            assert.strictEqual(firstPage.length, 2, 'First page should have 2 users');
            assert.strictEqual(secondPage.length, 2, 'Second page should have 2 users');
            
            // Check if they're different users
            if (firstPage.length > 0 && secondPage.length > 0) {
                assert.notStrictEqual(firstPage[0].id, secondPage[0].id, 'Pages should have different users');
            }

            logTest('Query builder - limit and offset', true);
        } catch (error) {
            logTest('Query builder - limit and offset', false, error);
        }

        // Test 27: Query builder - first
        try {
            const firstUser = await User.query()
                .where({ is_active: true })
                .first();
            
            assert.ok(firstUser, 'Should return first user');
            assert.strictEqual(firstUser.is_active, true, 'User should be active');

            logTest('Query builder - first', true);
        } catch (error) {
            logTest('Query builder - first', false, error);
        }

        // ==================== AGGREGATION TESTS ====================
        logSection('AGGREGATION TESTS');

        // Test 28: Count records
        try {
            const total = await User.count();
            const activeCount = await User.count({ is_active: true });
            
            assert.ok(total > 0, 'Total count should be > 0');
            assert.ok(activeCount > 0, 'Active count should be > 0');
            assert.ok(activeCount <= total, 'Active count should be <= total');

            logTest('Count records', true);
        } catch (error) {
            logTest('Count records', false, error);
        }

        // Test 29: Check if exists
        try {
            const exists = await User.exists({ username: 'john_doe' });
            const notExists = await User.exists({ username: 'fake_user' });
            
            assert.strictEqual(exists, true, 'User should exist');
            assert.strictEqual(notExists, false, 'Fake user should not exist');

            logTest('Check existence', true);
        } catch (error) {
            logTest('Check existence', false, error);
        }

        // Test 30: Get all records
        try {
            const all = await User.all();
            
            assert.ok(Array.isArray(all), 'Should return array');
            assert.ok(all.length > 0, 'Should have records');

            logTest('Get all records', true);
        } catch (error) {
            logTest('Get all records', false, error);
        }

        // Test 31: Get first record
        try {
            const first = await User.first();
            const firstActive = await User.first({ is_active: true });
            
            assert.ok(first, 'Should return first record');
            assert.ok(firstActive, 'Should return first active record');
            assert.strictEqual(firstActive.is_active, true, 'Record should be active');

            logTest('Get first record', true);
        } catch (error) {
            logTest('Get first record', false, error);
        }

        // Test 32: Get last record
        try {
            const last = await User.last();
            const lastInactive = await User.last({ is_active: false });
            
            assert.ok(last, 'Should return last record');
            if (lastInactive) {
                assert.strictEqual(lastInactive.is_active, false, 'Record should be inactive');
            }

            logTest('Get last record', true);
        } catch (error) {
            logTest('Get last record', false, error);
        }

        // Test 33: Pluck single field
        try {
            const usernames = await User.pluck('username');
            
            assert.ok(Array.isArray(usernames), 'Should return array');
            assert.ok(usernames.length > 0, 'Should have values');
            assert.ok(usernames.every(u => typeof u === 'string'), 'All should be strings');

            logTest('Pluck single field', true);
        } catch (error) {
            logTest('Pluck single field', false, error);
        }

        // Test 34: Pluck with key
        try {
            const userMap = await User.pluckWithKey('id', 'username');
            
            assert.ok(typeof userMap === 'object', 'Should return object');
            const keys = Object.keys(userMap);
            assert.ok(keys.length > 0, 'Should have entries');
            assert.ok(keys.every(k => !isNaN(k)), 'Keys should be IDs');

            logTest('Pluck with key', true);
        } catch (error) {
            logTest('Pluck with key', false, error);
        }

        // Test 35: Max value
        try {
            const maxAge = await User.max('age');
            const maxAgeActive = await User.max('age', { is_active: true });
            
            assert.ok(maxAge > 0, 'Max age should be positive');
            assert.ok(maxAgeActive <= maxAge, 'Active max age should be <= overall max');

            logTest('Max value', true);
        } catch (error) {
            logTest('Max value', false, error);
        }

        // Test 36: Min value
        try {
            const minAge = await User.min('age');
            const minAgeActive = await User.min('age', { is_active: true });
            
            assert.ok(minAge >= 0, 'Min age should be non-negative');
            assert.ok(minAgeActive >= minAge, 'Active min age should be >= overall min');

            logTest('Min value', true);
        } catch (error) {
            logTest('Min value', false, error);
        }

        // Test 37: Sum
        try {
            const totalSalary = await User.sum('salary');
            const totalSalaryActive = await User.sum('salary', { is_active: true });
            
            assert.ok(totalSalary > 0, 'Total salary should be positive');
            assert.ok(totalSalaryActive <= totalSalary, 'Active salary sum should be <= total');

            logTest('Sum values', true);
        } catch (error) {
            logTest('Sum values', false, error);
        }

        // Test 38: Average
        try {
            const avgAge = await User.avg('age');
            const avgAgeActive = await User.avg('age', { is_active: true });
            
            assert.ok(avgAge > 0, 'Average age should be positive');
            assert.ok(avgAgeActive > 0, 'Active average age should be positive');

            logTest('Average values', true);
        } catch (error) {
            logTest('Average values', false, error);
        }

        // Test 39: Distinct values
        try {
            const distinctAges = await User.distinct('age');
            
            assert.ok(Array.isArray(distinctAges), 'Should return array');
            const unique = new Set(distinctAges);
            assert.strictEqual(unique.size, distinctAges.length, 'All values should be unique');

            logTest('Distinct values', true);
        } catch (error) {
            logTest('Distinct values', false, error);
        }

        // ==================== UTILITY METHOD TESTS ====================
        logSection('UTILITY METHOD TESTS');

        // Test 40: Toggle boolean field
        try {
            const user = await User.first();
            const originalState = user.is_active;
            
            const toggled = await User.toggle(user.id, 'is_active');
            
            assert.strictEqual(toggled.is_active, !originalState, 'Field should be toggled');

            logTest('Toggle boolean field', true);
        } catch (error) {
            logTest('Toggle boolean field', false, error);
        }

        // Test 41: Increment field
        try {
            const user = await User.first();
            const originalAge = user.age;
            
            const incremented = await User.increment(user.id, 'age', 5);
            
            assert.strictEqual(incremented.age, originalAge + 5, 'Age should be incremented');

            logTest('Increment field', true);
        } catch (error) {
            logTest('Increment field', false, error);
        }

        // Test 42: Decrement field
        try {
            const user = await User.first();
            const originalAge = user.age;
            
            const decremented = await User.decrement(user.id, 'age', 3);
            
            assert.strictEqual(decremented.age, originalAge - 3, 'Age should be decremented');

            logTest('Decrement field', true);
        } catch (error) {
            logTest('Decrement field', false, error);
        }

        // Test 43: Pagination
        try {
            const page1 = await User.paginate(1, 2);
            const page2 = await User.paginate(2, 2);
            
            // Check page 1
            assert.ok(Array.isArray(page1.data), 'Data should be array');
            assert.ok(page1.data.length <= 2, 'Should have max 2 items');
            assert.strictEqual(page1.meta.current_page, 1, 'Current page should be 1');
            assert.strictEqual(page1.meta.per_page, 2, 'Per page should be 2');
            assert.ok(page1.meta.total > 0, 'Total should be > 0');
            assert.ok(page1.meta.last_page >= 1, 'Last page should be >= 1');
            
            // Check page 2
            assert.ok(page2.data.length <= 2, 'Should have max 2 items');
            assert.strictEqual(page2.meta.current_page, 2, 'Current page should be 2');
            
            // Check that pages are different
            if (page1.data.length > 0 && page2.data.length > 0) {
                const ids1 = new Set(page1.data.map(u => u.id));
                const ids2 = new Set(page2.data.map(u => u.id));
                
                // Check for overlap
                const overlap = [...ids1].filter(id => ids2.has(id));
                assert.strictEqual(overlap.length, 0, 'Pages should not overlap');
            }

            logTest('Pagination', true);
        } catch (error) {
            logTest('Pagination', false, error);
        }

        // Test 44: Pagination with filter
        try {
            const result = await User.paginate(1, 3, { is_active: true });
            
            assert.ok(result.data.length <= 3, 'Should have max 3 items');
            result.data.forEach(user => {
                assert.strictEqual(user.is_active, true, 'All users should be active');
            });

            logTest('Pagination with filter', true);
        } catch (error) {
            logTest('Pagination with filter', false, error);
        }

        // Test 45: Random records
        try {
            const randomUsers = await User.random(2);
            
            assert.strictEqual(randomUsers.length, 2, 'Should return 2 random users');
            
            // Get random with filter
            const randomActive = await User.random(2, { is_active: true });
            assert.strictEqual(randomActive.length, 2, 'Should return 2 random active users');
            randomActive.forEach(user => {
                assert.strictEqual(user.is_active, true, 'All should be active');
            });

            logTest('Random records', true);
        } catch (error) {
            logTest('Random records', false, error);
        }

        // ==================== CHUNKING AND BATCH PROCESSING ====================
        logSection('CHUNKING AND BATCH PROCESSING');

        // Test 46: Process in chunks
        try {
            let chunkCount = 0;
            let processedItems = 0;
            
            const chunks = await User.chunk(2, async (chunk, page) => {
                chunkCount++;
                processedItems += chunk.length;
                assert.ok(chunk.length <= 2, 'Chunk size should be <= 2');
                assert.ok(page >= 1, 'Page number should be >= 1');
            });
            
            assert.ok(chunkCount > 0, 'Should have at least one chunk');
            assert.ok(processedItems > 0, 'Should process items');

            logTest('Process in chunks', true);
        } catch (error) {
            logTest('Process in chunks', false, error);
        }

        // Test 47: Process each record
        try {
            let count = 0;
            
            const total = await User.each(async (user, index) => {
                count++;
                assert.ok(user.id, 'User should have ID');
                assert.ok(index >= 0, 'Index should be valid');
            });
            
            assert.strictEqual(count, total, 'Should process all records');

            logTest('Process each record', true);
        } catch (error) {
            logTest('Process each record', false, error);
        }

        // ==================== TRANSACTION TESTS ====================
        logSection('TRANSACTION TESTS');

        // Test 48: Successful transaction
        try {
            const beforeCount = await User.count();
            
            const result = await DB.transaction(async (trx) => {
                // Create a user in transaction
                await User.create({
                    username: 'transaction_user',
                    email: 'transaction@example.com',
                    age: 50
                });
                
                // Update a user
                const firstUser = await User.first();
                await User.update(firstUser.id, { age: 99 });
                
                return 'success';
            });
            
            const afterCount = await User.count();
            const updatedUser = await User.first();
            
            assert.strictEqual(result, 'success', 'Transaction should return value');
            assert.strictEqual(afterCount, beforeCount + 1, 'User count should increase');
            assert.strictEqual(updatedUser.age, 99, 'User should be updated');

            logTest('Successful transaction', true);
        } catch (error) {
            logTest('Successful transaction', false, error);
        }

        // Test 49: Failed transaction with rollback
        try {
            const beforeCount = await User.count();
            const firstUser = await User.first();
            const originalAge = firstUser.age;
            
            try {
                await DB.transaction(async (trx) => {
                    await User.create({
                        username: 'rollback_user',
                        email: 'rollback@example.com',
                        age: 75
                    });
                    
                    await User.update(firstUser.id, { age: 999 });
                    
                    // Force an error
                    throw new Error('Forced rollback');
                });
                
                assert.fail('Transaction should have thrown');
            } catch (error) {
                // Transaction should have rolled back
                const afterCount = await User.count();
                const currentUser = await User.findById(firstUser.id);
                
                assert.strictEqual(afterCount, beforeCount, 'Count should not change');
                assert.strictEqual(currentUser.age, originalAge, 'Age should not change');
            }

            logTest('Failed transaction with rollback', true);
        } catch (error) {
            logTest('Failed transaction with rollback', false, error);
        }

        // Test 50: Nested transactions with savepoints
        try {
            const beforeCount = await User.count();
            const firstUser = await User.first();
            
            const result = await DB.transaction(async (trx) => {
                // Outer transaction
                await User.create({
                    username: 'outer_user',
                    email: 'outer@example.com',
                    age: 100
                });
                
                // Inner transaction (savepoint)
                await DB.transaction(async (innerTrx) => {
                    await User.create({
                        username: 'inner_user',
                        email: 'inner@example.com',
                        age: 200
                    });
                    
                    await User.update(firstUser.id, { age: 300 });
                });
                
                return 'nested success';
            });
            
            const afterCount = await User.count();
            const updatedUser = await User.findById(firstUser.id);
            
            assert.strictEqual(result, 'nested success', 'Transaction should succeed');
            assert.strictEqual(afterCount, beforeCount + 2, 'Both users should be created');
            assert.strictEqual(updatedUser.age, 300, 'User should be updated');

            logTest('Nested transactions with savepoints', true);
        } catch (error) {
            logTest('Nested transactions with savepoints', false, error);
        }

        // ==================== DELETION TESTS ====================
        logSection('DELETION TESTS');

        // Test 51: Delete single record
        try {
            const beforeCount = await User.count();
            const user = await User.first();
            
            const deleted = await User.delete(user.id);
            const afterCount = await User.count();
            const checkUser = await User.findById(user.id);
            
            assert.strictEqual(deleted, true, 'Delete should return true');
            assert.strictEqual(afterCount, beforeCount - 1, 'Count should decrease by 1');
            assert.strictEqual(checkUser, null, 'User should not exist');

            logTest('Delete single record', true);
        } catch (error) {
            logTest('Delete single record', false, error);
        }

        // Test 52: Delete multiple records
        try {
            // Create test users
            await User.createMany([
                { username: 'delete1', email: 'delete1@test.com', age: 1 },
                { username: 'delete2', email: 'delete2@test.com', age: 1 },
                { username: 'delete3', email: 'delete3@test.com', age: 2 }
            ]);
            
            const beforeCount = await User.count();
            
            const deleted = await User.deleteMany({ age: 1 });
            const afterCount = await User.count();
            const remaining = await User.find({ age: 1 });
            
            assert.strictEqual(deleted, 2, 'Should delete 2 records');
            assert.strictEqual(afterCount, beforeCount - 2, 'Count should decrease by 2');
            assert.strictEqual(remaining.length, 0, 'No users with age 1 should remain');

            logTest('Delete multiple records', true);
        } catch (error) {
            logTest('Delete multiple records', false, error);
        }

        // Test 53: Delete all records
        try {
            // Create some records first
            await User.createMany([
                { username: 'temp1', email: 'temp1@test.com' },
                { username: 'temp2', email: 'temp2@test.com' }
            ]);
            
            const beforeCount = await User.count();
            assert.ok(beforeCount > 0, 'Should have records before delete');
            
            const deleted = await User.deleteAll();
            const afterCount = await User.count();
            
            assert.ok(deleted > 0, 'Should return number of deleted records');
            assert.strictEqual(afterCount, 0, 'All records should be deleted');

            logTest('Delete all records', true);
        } catch (error) {
            logTest('Delete all records', false, error);
        }

        // Test 54: Truncate table
        try {
            // Recreate users
            await User.create({
                username: 'truncate_test',
                email: 'truncate@test.com'
            });
            
            const beforeCount = await User.count();
            assert.ok(beforeCount > 0, 'Should have records before truncate');
            
            const truncated = await User.truncate();
            const afterCount = await User.count();
            
            assert.strictEqual(truncated, true, 'Truncate should return true');
            assert.strictEqual(afterCount, 0, 'Table should be empty');

            logTest('Truncate table', true);
        } catch (error) {
            logTest('Truncate table', false, error);
        }

        // ==================== MODEL INSTANCE TESTS ====================
        logSection('MODEL INSTANCE TESTS');

        // Test 55: Create model instance
        try {
            const userData = {
                username: 'instance_test',
                email: 'instance@test.com',
                age: 42
            };
            
            const user = new User(userData);
            
            assert.strictEqual(user.username, 'instance_test', 'Property should be set');
            assert.strictEqual(user.email, 'instance@test.com', 'Property should be set');
            assert.strictEqual(user.age, 42, 'Property should be set');

            logTest('Create model instance', true);
        } catch (error) {
            logTest('Create model instance', false, error);
        }

        // Test 56: Fill model instance
        try {
            const user = new User();
            user.fill({
                username: 'fill_test',
                email: 'fill@test.com',
                age: 33
            });
            
            assert.strictEqual(user.username, 'fill_test', 'Should be filled');
            assert.strictEqual(user.email, 'fill@test.com', 'Should be filled');
            assert.strictEqual(user.age, 33, 'Should be filled');

            logTest('Fill model instance', true);
        } catch (error) {
            logTest('Fill model instance', false, error);
        }

        // Test 57: Check dirty attributes
        try {
            const user = new User({ username: 'dirty_test', age: 25 });
            
            assert.ok(user.isDirty(), 'Should be dirty initially');
            assert.ok(user.isDirty('username'), 'Username should be dirty');
            assert.ok(user.isDirty('age'), 'Age should be dirty');
            assert.ok(!user.isDirty('email'), 'Email should not be dirty');

            logTest('Check dirty attributes', true);
        } catch (error) {
            logTest('Check dirty attributes', false, error);
        }

        // Test 58: Get original values
        try {
            const user = new User({ username: 'original_test', age: 30 });
            const originalAge = user.age;
            
            user.age = 35;
            
            assert.strictEqual(user.getOriginal('age'), originalAge, 'Original should be preserved');
            assert.strictEqual(user.age, 35, 'Current should be updated');

            logTest('Get original values', true);
        } catch (error) {
            logTest('Get original values', false, error);
        }

        // Test 59: To JSON
        try {
            const user = new User({
                username: 'json_test',
                email: 'json@test.com',
                age: 28
            });
            
            const json = user.toJSON();
            
            assert.ok(typeof json === 'object', 'Should return object');
            assert.strictEqual(json.username, 'json_test', 'Property should exist');
            assert.strictEqual(json.email, 'json@test.com', 'Property should exist');

            logTest('To JSON', true);
        } catch (error) {
            logTest('To JSON', false, error);
        }

        // Test 60: Model events
        try {
            const user = new User({ username: 'event_test' });
            let savedEmitted = false;
            let updatedEmitted = false;
            let deletedEmitted = false;
            
            user.on('saved', () => { savedEmitted = true; });
            user.on('updated', () => { updatedEmitted = true; });
            user.on('deleted', () => { deletedEmitted = true; });
            
            await user.save();
            assert.ok(savedEmitted, 'Saved event should emit');
            
            user.age = 100;
            await user.save();
            assert.ok(updatedEmitted, 'Updated event should emit');
            
            await user.delete();
            assert.ok(deletedEmitted, 'Deleted event should emit');

            logTest('Model events', true);
        } catch (error) {
            logTest('Model events', false, error);
        }

        // ==================== SCHEMA BUILDER TESTS ====================
        logSection('SCHEMA BUILDER TESTS');

        // Test 61: Create table with all column types
        try {
            await DB.schema().create('all_types', (table) => {
                table.id();
                table.string('string_col', 100);
                table.text('text_col');
                table.integer('int_col');
                table.float('float_col');
                table.boolean('bool_col');
                table.datetime('datetime_col');
                table.json('json_col');
                table.timestamps();
            });
            
            const hasTable = await DB.schema().hasTable('all_types');
            assert.strictEqual(hasTable, true, 'Table should exist');

            logTest('Create table with all column types', true);
        } catch (error) {
            logTest('Create table with all column types', false, error);
        }

        // Test 62: Alter table add column
        try {
            await DB.schema().table('all_types', (table) => {
                table.string('new_col').nullable().default('default');
            });
            
            const hasColumn = await DB.schema().hasColumn('all_types', 'new_col');
            assert.strictEqual(hasColumn, true, 'New column should exist');

            logTest('Alter table add column', true);
        } catch (error) {
            logTest('Alter table add column', false, error);
        }

        // Test 63: Drop table
        try {
            await DB.schema().create('temp_table', (table) => {
                table.id();
                table.string('name');
            });
            
            let hasTable = await DB.schema().hasTable('temp_table');
            assert.strictEqual(hasTable, true, 'Table should exist');
            
            await DB.schema().drop('temp_table');
            
            hasTable = await DB.schema().hasTable('temp_table');
            assert.strictEqual(hasTable, false, 'Table should not exist');

            logTest('Drop table', true);
        } catch (error) {
            logTest('Drop table', false, error);
        }

        // Test 64: Drop table if exists
        try {
            await DB.schema().dropIfExists('nonexistent_table');
            // Should not throw
            assert.ok(true, 'Drop if exists should not throw');

            logTest('Drop table if exists', true);
        } catch (error) {
            logTest('Drop table if exists', false, error);
        }

        // ==================== DATABASE STATISTICS ====================
        logSection('DATABASE STATISTICS');

        // Test 65: Get database stats
        try {
            const stats = await DB.getStats();
            
            assert.strictEqual(stats.driver, 'sqlite', 'Driver should be sqlite');
            assert.ok(stats.collections >= 0, 'Should have collections count');
            assert.ok(typeof stats.records === 'object', 'Records should be object');
            assert.ok(stats.totalRecords >= 0, 'Total records should be >= 0');

            logTest('Get database stats', true);
        } catch (error) {
            logTest('Get database stats', false, error);
        }

        // Test 66: List collections/tables
        try {
            const collections = await DB.listCollections();
            
            assert.ok(Array.isArray(collections), 'Should return array');
            assert.ok(collections.includes('users'), 'Should include users table');
            assert.ok(collections.includes('posts'), 'Should include posts table');

            logTest('List collections', true);
        } catch (error) {
            logTest('List collections', false, error);
        }

        // ==================== EDGE CASES AND ERROR HANDLING ====================
        logSection('EDGE CASES AND ERROR HANDLING');

        // Test 67: Create with invalid data
        try {
            await User.create({
                // Missing required username
                email: 'test@test.com'
            });
            
            assert.fail('Should have thrown validation error');
        } catch (error) {
            assert.ok(error.message.includes('required'), 'Should complain about required field');
            logTest('Create with invalid data', true);
        }

        // Test 68: Find with empty filter
        try {
            const users = await User.find({});
            assert.ok(Array.isArray(users), 'Should return array');

            logTest('Find with empty filter', true);
        } catch (error) {
            logTest('Find with empty filter', false, error);
        }

        // Test 69: Find with non-existent field
        try {
            const users = await User.find({ nonexistent: 'value' });
            assert.strictEqual(users.length, 0, 'Should return empty array');

            logTest('Find with non-existent field', true);
        } catch (error) {
            logTest('Find with non-existent field', false, error);
        }

        // Test 70: Update non-existent record
        try {
            await User.update(999999, { age: 50 });
            assert.fail('Should have thrown error');
        } catch (error) {
            assert.ok(error.message.includes('not found'), 'Should say not found');
            logTest('Update non-existent record', true);
        }

        // Test 71: Delete non-existent record
        try {
            const deleted = await User.delete(999999);
            assert.strictEqual(deleted, false, 'Should return false');

            logTest('Delete non-existent record', true);
        } catch (error) {
            logTest('Delete non-existent record', false, error);
        }

        // Test 72: JSON data handling
        try {
            const complexJson = {
                nested: {
                    array: [1, 2, 3],
                    object: { key: 'value' }
                },
                date: new Date().toISOString(),
                number: 42
            };
            
            const user = await User.create({
                username: 'json_complex',
                email: 'json@complex.com',
                metadata: complexJson
            });
            
            const found = await User.findById(user.id);
            assert.deepStrictEqual(found.metadata, complexJson, 'JSON should be preserved');

            logTest('JSON data handling', true);
        } catch (error) {
            logTest('JSON data handling', false, error);
        }

        // Test 73: Boolean handling
        try {
            const user = await User.create({
                username: 'bool_test',
                email: 'bool@test.com',
                is_active: 1  // Should be converted to boolean
            });
            
            assert.strictEqual(user.is_active, true, 'Should convert to boolean');

            logTest('Boolean handling', true);
        } catch (error) {
            logTest('Boolean handling', false, error);
        }

        // Test 74: Date handling
        try {
            const dateStr = '2024-01-15T10:30:00.000Z';
            const user = await User.create({
                username: 'date_test',
                email: 'date@test.com',
                created_at: dateStr
            });
            
            assert.strictEqual(user.created_at, dateStr, 'Date should be preserved');

            logTest('Date handling', true);
        } catch (error) {
            logTest('Date handling', false, error);
        }

        // ==================== MULTIPLE CONNECTIONS ====================
        logSection('MULTIPLE CONNECTIONS');

        // Test 75: Connect to second database
        try {
            const TEST_DB2 = 'test_database_2';
            const TEST_FILE2 = path.join(__dirname, `${TEST_DB2}.sqlite`);
            
            const connected = await DB.Connect(TEST_DB2, { filename: TEST_FILE2 });
            
            assert.strictEqual(connected, true, 'Should connect to second DB');
            assert.ok(DB.hasConnection(TEST_DB2), 'Second connection should be registered');
            
            // Clean up
            if (fs.existsSync(TEST_FILE2)) {
                fs.unlinkSync(TEST_FILE2);
            }

            logTest('Connect to second database', true);
        } catch (error) {
            logTest('Connect to second database', false, error);
        }

        // Test 76: Switch default connection
        try {
            const originalDefault = DB.defaultConnection;
            
            // Create a second connection
            const TEST_DB2 = 'test_database_2';
            const TEST_FILE2 = path.join(__dirname, `${TEST_DB2}.sqlite`);
            await DB.Connect(TEST_DB2, { filename: TEST_FILE2 });
            
            // Switch default
            DB.defaultConnection = TEST_DB2;
            
            assert.strictEqual(DB.defaultConnection, TEST_DB2, 'Default should be switched');
            
            // Switch back
            DB.defaultConnection = originalDefault;
            
            // Clean up
            if (fs.existsSync(TEST_FILE2)) {
                fs.unlinkSync(TEST_FILE2);
            }

            logTest('Switch default connection', true);
        } catch (error) {
            logTest('Switch default connection', false, error);
        }

        // Test 77: Disconnect specific database
        try {
            // Create a temporary connection
            const TEMP_DB = 'temp_database';
            const TEMP_FILE = path.join(__dirname, `${TEMP_DB}.sqlite`);
            await DB.Connect(TEMP_DB, { filename: TEMP_FILE });
            
            assert.ok(DB.hasConnection(TEMP_DB), 'Temp connection should exist');
            
            const disconnected = await DB.Disconnect(TEMP_DB);
            
            assert.strictEqual(disconnected, true, 'Should disconnect');
            assert.ok(!DB.hasConnection(TEMP_DB), 'Connection should be removed');
            
            // Clean up
            if (fs.existsSync(TEMP_FILE)) {
                fs.unlinkSync(TEMP_FILE);
            }

            logTest('Disconnect specific database', true);
        } catch (error) {
            logTest('Disconnect specific database', false, error);
        }

        // Test 78: Disconnect all databases
        try {
            // Create temporary connections
            const TEMP_DB1 = 'temp_db1';
            const TEMP_DB2 = 'temp_db2';
            const TEMP_FILE1 = path.join(__dirname, `${TEMP_DB1}.sqlite`);
            const TEMP_FILE2 = path.join(__dirname, `${TEMP_DB2}.sqlite`);
            
            await DB.Connect(TEMP_DB1, { filename: TEMP_FILE1 });
            await DB.Connect(TEMP_DB2, { filename: TEMP_FILE2 });
            
            assert.ok(DB.hasConnection(TEMP_DB1), 'Temp1 should exist');
            assert.ok(DB.hasConnection(TEMP_DB2), 'Temp2 should exist');
            
            await DB.DisconnectAll();
            
            assert.strictEqual(DB.listConnections().length, 0, 'No connections should remain');
            assert.strictEqual(DB.defaultConnection, null, 'Default connection should be null');
            
            // Clean up
            if (fs.existsSync(TEMP_FILE1)) fs.unlinkSync(TEMP_FILE1);
            if (fs.existsSync(TEMP_FILE2)) fs.unlinkSync(TEMP_FILE2);

            logTest('Disconnect all databases', true);
        } catch (error) {
            logTest('Disconnect all databases', false, error);
        }

        // ==================== CLEANUP ====================
        logSection('CLEANUP');

        // Final cleanup
        await DB.DisconnectAll();
        await cleanup();

        // ==================== TEST SUMMARY ====================
        const testDuration = ((Date.now() - testStartTime) / 1000).toFixed(2);
        
        console.log(`\n${colors.bright}${colors.cyan}═══════════════════════════════════════════════════════════════${colors.reset}`);
        console.log(`${colors.bright}${colors.cyan}   TEST SUMMARY${colors.reset}`);
        console.log(`${colors.bright}${colors.cyan}═══════════════════════════════════════════════════════════════${colors.reset}\n`);
        
        console.log(`${colors.bright}Total Tests:${colors.reset} ${stats.total}`);
        console.log(`${colors.green}Passed:${colors.reset} ${stats.passed}`);
        if (stats.failed > 0) {
            console.log(`${colors.red}Failed:${colors.reset} ${stats.failed}`);
        }
        if (stats.skipped > 0) {
            console.log(`${colors.yellow}Skipped:${colors.reset} ${stats.skipped}`);
        }
        console.log(`${colors.bright}Duration:${colors.reset} ${testDuration}s`);
        
        const passRate = ((stats.passed / (stats.total - stats.skipped)) * 100).toFixed(1);
        console.log(`${colors.bright}Pass Rate:${colors.reset} ${passRate}%`);
        
        if (stats.failed === 0) {
            console.log(`\n${colors.green}${colors.bright}✅ ALL TESTS PASSED!${colors.reset}\n`);
        } else {
            console.log(`\n${colors.red}${colors.bright}❌ ${stats.failed} TEST(S) FAILED${colors.reset}\n`);
            process.exit(1);
        }

    } catch (error) {
        console.error(`${colors.red}Fatal error during tests:${colors.reset}`, error);
        process.exit(1);
    }
}

// Run the tests
runTests();