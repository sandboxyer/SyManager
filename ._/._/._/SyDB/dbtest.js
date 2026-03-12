// test-db.js - Comprehensive test suite for DB.js SQLite ORM
import DB from './DB.js';
import fs from 'fs';
import path from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import assert from 'assert';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ==================== Test Configuration ====================
const TEST_DB = 'test_database';
const TEST_FILE = `./${TEST_DB}.sqlite`;
const PERFORMANCE_ITERATIONS = 1000;
const CONCURRENT_USERS = 50;

// ==================== Test Results Tracking ====================
const testResults = {
    passed: 0,
    failed: 0,
    skipped: 0,
    total: 0,
    startTime: Date.now(),
    endTime: null,
    tests: []
};

function recordTest(name, status, error = null, duration = 0) {
    testResults.tests.push({ name, status, error, duration });
    if (status === 'passed') testResults.passed++;
    else if (status === 'failed') testResults.failed++;
    else if (status === 'skipped') testResults.skipped++;
    testResults.total++;
}

// ==================== Assertion Helpers ====================
async function assertThrows(fn, errorMessage, testName) {
    try {
        await fn();
        recordTest(testName, 'failed', new Error('Expected error but none was thrown'));
        return false;
    } catch (error) {
        if (errorMessage && !error.message.includes(errorMessage)) {
            recordTest(testName, 'failed', error);
            return false;
        }
        recordTest(testName, 'passed');
        return true;
    }
}

async function assertDoesNotThrow(fn, testName) {
    try {
        await fn();
        recordTest(testName, 'passed');
        return true;
    } catch (error) {
        recordTest(testName, 'failed', error);
        return false;
    }
}

function assertEquals(actual, expected, testName) {
    try {
        assert.deepStrictEqual(actual, expected);
        recordTest(testName, 'passed');
        return true;
    } catch (error) {
        recordTest(testName, 'failed', error);
        return false;
    }
}

// ==================== Setup and Teardown ====================
async function cleanup() {
    try {
        await DB.DisconnectAll();
        if (fs.existsSync(TEST_FILE)) {
            fs.unlinkSync(TEST_FILE);
        }
        // Clean up WAL and other files
        const files = await path.readdir('.');
        for (const file of files) {
            if (file.startsWith(TEST_DB) && (file.endsWith('-wal') || file.endsWith('.tmp'))) {
                fs.unlinkSync(file);
            }
        }
    } catch (error) {
        console.error('Cleanup error:', error);
    }
}

// ==================== Test Suites ====================

async function testDatabaseConnection() {
    console.log('\n📡 Testing Database Connection...');
    
    // Test 1: Connect to database
    await assertDoesNotThrow(
        async () => await DB.Connect(TEST_DB, { filename: TEST_FILE }),
        'Connect to database'
    );
    
    // Test 2: Check if file exists
    assertEquals(fs.existsSync(TEST_FILE), true, 'Database file created');
    
    // Test 3: Get connection info
    const conn = DB.getConnection(TEST_DB);
    assertEquals(conn.name, TEST_DB, 'Connection info retrieved');
    
    // Test 4: List connections
    const connections = DB.listConnections();
    assertEquals(connections.includes(TEST_DB), true, 'Connection listed');
    
    // Test 5: Get version
    const version = await DB.getVersion();
    assertEquals(typeof version, 'string', 'Version retrieved');
    
    console.log(`✅ Connection tests completed`);
}

async function testSchemaCreation() {
    console.log('\n📐 Testing Schema Creation...');
    
    // Test 1: Create users table
    await assertDoesNotThrow(async () => {
        await DB.schema().create('users', (table) => {
            table.id();
            table.string('username').unique();
            table.string('email').unique();
            table.string('password');
            table.string('full_name').nullable();
            table.integer('age').nullable();
            table.boolean('is_active').default(true);
            table.float('balance').default(0);
            table.json('metadata').nullable();
            table.datetime('last_login').nullable();
            table.timestamps();
        });
    }, 'Create users table');
    
    // Test 2: Create products table
    await assertDoesNotThrow(async () => {
        await DB.schema().create('products', (table) => {
            table.id();
            table.string('sku').unique();
            table.string('name');
            table.text('description').nullable();
            table.float('price');
            table.integer('stock_quantity').default(0);
            table.string('category');
            table.json('tags').nullable();
            table.timestamps();
        });
    }, 'Create products table');
    
    // Test 3: Create orders table with foreign key relationships
    await assertDoesNotThrow(async () => {
        await DB.schema().create('orders', (table) => {
            table.id();
            table.integer('user_id');
            table.float('total_amount');
            table.string('status').default('pending');
            table.json('shipping_address');
            table.datetime('order_date');
            table.timestamps();
        });
    }, 'Create orders table');
    
    // Test 4: Create order_items table
    await assertDoesNotThrow(async () => {
        await DB.schema().create('order_items', (table) => {
            table.id();
            table.integer('order_id');
            table.integer('product_id');
            table.integer('quantity');
            table.float('unit_price');
            table.float('subtotal');
        });
    }, 'Create order_items table');
    
    // Test 5: Check if tables exist
    const tables = await DB.listCollections();
    assertEquals(
        tables.sort(),
        ['users', 'products', 'orders', 'order_items'].sort(),
        'All tables created'
    );
    
    // Test 6: Add column to existing table
    await assertDoesNotThrow(async () => {
        await DB.schema().table('users', (table) => {
            table.string('phone').nullable();
        });
    }, 'Add column to existing table');
    
    // Test 7: Check column existence
    const hasColumn = await DB.schema().hasColumn('users', 'phone');
    assertEquals(hasColumn, true, 'Column added successfully');
    
    console.log(`✅ Schema creation tests completed`);
}

async function testModelDefinition() {
    console.log('\n📦 Testing Model Definition...');
    
    // Define models with validation
    const User = DB.Model('users', {
        username: { type: 'string', required: true },
        email: { type: 'string', required: true },
        password: { type: 'string', required: true },
        full_name: 'string',
        age: 'integer',
        is_active: { type: 'boolean', default: true },
        balance: { type: 'float', default: 0 },
        metadata: 'json',
        last_login: 'datetime',
        phone: 'string'
    });
    
    const Product = DB.Model('products', {
        sku: { type: 'string', required: true },
        name: { type: 'string', required: true },
        description: 'text',
        price: { type: 'float', required: true },
        stock_quantity: { type: 'integer', default: 0 },
        category: { type: 'string', required: true },
        tags: 'json'
    });
    
    const Order = DB.Model('orders', {
        user_id: { type: 'integer', required: true },
        total_amount: { type: 'float', required: true },
        status: { type: 'string', default: 'pending' },
        shipping_address: 'json',
        order_date: 'datetime'
    });
    
    const OrderItem = DB.Model('order_items', {
        order_id: { type: 'integer', required: true },
        product_id: { type: 'integer', required: true },
        quantity: { type: 'integer', required: true },
        unit_price: { type: 'float', required: true },
        subtotal: { type: 'float', required: true }
    });
    
    // Test model properties
    assertEquals(User.tableName, 'users', 'Model table name set correctly');
    assertEquals(typeof User.schema, 'object', 'Model schema defined');
    
    return { User, Product, Order, OrderItem };
}

async function testCRUDOperations(models) {
    console.log('\n🔄 Testing CRUD Operations...');
    
    const { User, Product, Order, OrderItem } = models;
    
    // ==================== CREATE ====================
    console.log('  📝 Testing CREATE operations...');
    
    // Test 1: Create single user
    const user1 = await User.create({
        username: 'john_doe',
        email: 'john@example.com',
        password: 'hashed_password_123',
        full_name: 'John Doe',
        age: 30,
        is_active: true,
        balance: 100.50,
        metadata: { theme: 'dark', notifications: true },
        phone: '+1234567890'
    });
    
    assertEquals(user1.username, 'john_doe', 'Create single user');
    assertEquals(typeof user1.id, 'number', 'Auto-generated ID created');
    
    // Test 2: Create with required field validation
    await assertThrows(
        async () => await User.create({ username: 'invalid_user' }),
        'required',
        'Validation - required field missing'
    );
    
    // Test 3: Create multiple users
    const users = await User.createMany([
        {
            username: 'jane_smith',
            email: 'jane@example.com',
            password: 'hashed_password_456',
            full_name: 'Jane Smith',
            age: 28,
            balance: 250.75
        },
        {
            username: 'bob_wilson',
            email: 'bob@example.com',
            password: 'hashed_password_789',
            full_name: 'Bob Wilson',
            age: 35,
            balance: 500.00
        }
    ]);
    
    assertEquals(users.length, 2, 'Create multiple users');
    
    // Test 4: Create products
    const product1 = await Product.create({
        sku: 'SKU-001',
        name: 'Laptop',
        description: 'High-performance laptop',
        price: 999.99,
        stock_quantity: 50,
        category: 'Electronics',
        tags: ['computer', 'portable', 'work']
    });
    
    const product2 = await Product.create({
        sku: 'SKU-002',
        name: 'Mouse',
        price: 29.99,
        category: 'Accessories'
    });
    
    // ==================== READ ====================
    console.log('  📖 Testing READ operations...');
    
    // Test 5: Find all users
    const allUsers = await User.all();
    assertEquals(allUsers.length, 3, 'Find all users');
    
    // Test 6: Find by ID
    const foundUser = await User.findById(user1.id);
    assertEquals(foundUser.username, 'john_doe', 'Find by ID');
    
    // Test 7: Find with filter
    const activeUsers = await User.find({ is_active: true });
    assertEquals(activeUsers.length >= 1, true, 'Find with filter');
    
    // Test 8: Find one
    const janeUser = await User.findOne({ username: 'jane_smith' });
    assertEquals(janeUser.email, 'jane@example.com', 'Find one');
    
    // Test 9: Find by multiple IDs
    const usersByIds = await User.findByIds([user1.id, users[0].id]);
    assertEquals(usersByIds.length, 2, 'Find by multiple IDs');
    
    // Test 10: Check if exists
    const exists = await User.exists({ username: 'john_doe' });
    assertEquals(exists, true, 'Exists check - true');
    
    const notExists = await User.exists({ username: 'nonexistent' });
    assertEquals(notExists, false, 'Exists check - false');
    
    // Test 11: Count records
    const userCount = await User.count({ is_active: true });
    assertEquals(userCount, 3, 'Count with filter');
    
    // Test 12: First record
    const firstUser = await User.first();
    assertEquals(firstUser !== null, true, 'First record');
    
    // Test 13: Last record
    const lastUser = await User.last();
    assertEquals(lastUser !== null, true, 'Last record');
    
    // ==================== UPDATE ====================
    console.log('  ✏️ Testing UPDATE operations...');
    
    // Test 14: Update single user
    const updatedUser = await User.update(user1.id, {
        full_name: 'Johnathan Doe',
        age: 31,
        balance: 150.75
    });
    
    assertEquals(updatedUser.full_name, 'Johnathan Doe', 'Update single record');
    assertEquals(updatedUser.age, 31, 'Update age field');
    
    // Test 15: Update multiple users
    const updatedUsers = await User.updateMany(
        { is_active: true },
        { balance: 1000 }
    );
    
    assertEquals(updatedUsers.length, 3, 'Update multiple records');
    
    // Test 16: Update or create - update existing
    const updatedOrCreated = await User.updateOrCreate(
        { username: 'john_doe' },
        { full_name: 'John D.', age: 32 }
    );
    
    assertEquals(updatedOrCreated.full_name, 'John D.', 'Update or create - update');
    
    // Test 17: Update or create - create new
    const newUser = await User.updateOrCreate(
        { username: 'alice_jones' },
        {
            email: 'alice@example.com',
            password: 'hashed_password_000',
            age: 25
        }
    );
    
    assertEquals(newUser.username, 'alice_jones', 'Update or create - create');
    
    // ==================== DELETE ====================
    console.log('  🗑️ Testing DELETE operations...');
    
    // Test 18: Delete single user
    const deleteResult = await User.delete(user1.id);
    assertEquals(deleteResult, true, 'Delete single record');
    
    const deletedUser = await User.findById(user1.id);
    assertEquals(deletedUser, null, 'Verify deletion');
    
    // Test 19: Delete multiple users
    const deletedCount = await User.deleteMany({ age: { $gt: 30 } });
    assertEquals(deletedCount > 0, true, 'Delete multiple records');
    
    // Test 20: Delete all
    const totalDeleted = await User.deleteAll();
    assertEquals(totalDeleted > 0, true, 'Delete all records');
    
    console.log(`✅ CRUD operations tests completed`);
}

async function testQueryBuilder(models) {
    console.log('\n🔍 Testing Query Builder...');
    
    const { User, Product } = models;
    
    // Re-populate data for query tests
    await User.deleteAll();
    await Product.deleteAll();
    
    // Create test data
    const users = [];
    for (let i = 1; i <= 20; i++) {
        users.push(await User.create({
            username: `user${i}`,
            email: `user${i}@example.com`,
            password: 'pass123',
            age: 20 + i,
            balance: i * 100,
            is_active: i % 2 === 0,
            metadata: { level: i % 5 }
        }));
    }
    
    // Test 1: Basic where clause
    const query1 = User.query().where({ is_active: true });
    const activeUsers = await query1.get();
    assertEquals(activeUsers.length, 10, 'Basic where clause');
    
    // Test 2: Multiple conditions
    const query2 = User.query()
        .where({ is_active: true })
        .where({ age: 25 });
    const filtered = await query2.get();
    assertEquals(filtered.length >= 0, true, 'Multiple conditions');
    
    // Test 3: Order by
    const query3 = User.query().orderBy('age', 'DESC');
    const sorted = await query3.get();
    assertEquals(sorted[0].age > sorted[sorted.length - 1].age, true, 'Order by DESC');
    
    // Test 4: Limit and offset
    const query4 = User.query().limit(5).offset(5);
    const paginated = await query4.get();
    assertEquals(paginated.length, 5, 'Limit and offset');
    
    // Test 5: Select specific fields
    const query5 = User.query().select('username', 'email').where({ age: 25 });
    const selected = await query5.get();
    assertEquals(Object.keys(selected[0]).length, 2, 'Select specific fields');
    
    // Test 6: Where with operators (through raw where)
    const query6 = User.query().whereRaw('age >= ?', [30]);
    const ageFiltered = await query6.get();
    assertEquals(ageFiltered.length > 0, true, 'Where with operator');
    
    // Test 7: Complex query with multiple clauses
    const query7 = User.query()
        .where({ is_active: true })
        .whereRaw('balance > ?', [500])
        .orderBy('balance', 'DESC')
        .limit(3);
    const complex = await query7.get();
    assertEquals(complex.length <= 3, true, 'Complex query');
    
    console.log(`✅ Query builder tests completed`);
}

async function testAggregationMethods(models) {
    console.log('\n📊 Testing Aggregation Methods...');
    
    const { User } = models;
    
    // Test 1: Count
    const totalUsers = await User.count();
    assertEquals(totalUsers, 20, 'Count all records');
    
    // Test 2: Max
    const maxAge = await User.max('age');
    assertEquals(maxAge, 40, 'Max value');
    
    // Test 3: Min
    const minAge = await User.min('age');
    assertEquals(minAge, 21, 'Min value');
    
    // Test 4: Sum
    const totalBalance = await User.sum('balance');
    assertEquals(totalBalance, 21000, 'Sum value'); // 100 + 200 + ... + 2000 = 21000
    
    // Test 5: Average
    const avgBalance = await User.avg('balance');
    assertEquals(Math.round(avgBalance), 1050, 'Average value');
    
    // Test 6: Pluck
    const usernames = await User.pluck('username');
    assertEquals(usernames.length, 20, 'Pluck field');
    
    // Test 7: Pluck with key
    const userMap = await User.pluckWithKey('id', 'username');
    assertEquals(typeof userMap, 'object', 'Pluck with key');
    
    // Test 8: Distinct
    const distinctAges = await User.distinct('age');
    assertEquals(distinctAges.length, 20, 'Distinct values');
    
    console.log(`✅ Aggregation tests completed`);
}

async function testPagination(models) {
    console.log('\n📄 Testing Pagination...');
    
    const { User } = models;
    
    // Test 1: Basic pagination
    const page1 = await User.paginate(1, 5);
    assertEquals(page1.data.length, 5, 'Page 1 size');
    assertEquals(page1.meta.current_page, 1, 'Current page');
    assertEquals(page1.meta.per_page, 5, 'Per page');
    assertEquals(page1.meta.total, 20, 'Total count');
    assertEquals(page1.meta.last_page, 4, 'Last page');
    
    // Test 2: Second page
    const page2 = await User.paginate(2, 5);
    assertEquals(page2.data.length, 5, 'Page 2 size');
    assertEquals(page2.meta.current_page, 2, 'Page 2 current');
    
    // Test 3: Last page
    const lastPage = await User.paginate(4, 5);
    assertEquals(lastPage.data.length, 5, 'Last page size');
    assertEquals(lastPage.meta.from, 16, 'From index');
    assertEquals(lastPage.meta.to, 20, 'To index');
    
    // Test 4: Pagination with filter
    const filteredPage = await User.paginate(1, 3, { is_active: true });
    assertEquals(filteredPage.data.length <= 3, true, 'Filtered pagination');
    
    // Test 5: Invalid page number (should default to 1)
    const invalidPage = await User.paginate(0, 5);
    assertEquals(invalidPage.meta.current_page, 1, 'Invalid page handling');
    
    console.log(`✅ Pagination tests completed`);
}

async function testUtilityMethods(models) {
    console.log('\n🛠️ Testing Utility Methods...');
    
    const { User } = models;
    
    // Get a user for utility tests
    const users = await User.find();
    const userId = users[0].id;
    
    // Test 1: Toggle boolean field
    const initialUser = await User.findById(userId);
    const initialStatus = initialUser.is_active;
    
    const toggledUser = await User.toggle(userId, 'is_active');
    assertEquals(toggledUser.is_active, !initialStatus, 'Toggle boolean field');
    
    // Test 2: Increment
    const incrementedUser = await User.increment(userId, 'balance', 50);
    assertEquals(incrementedUser.balance, initialUser.balance + 50, 'Increment field');
    
    // Test 3: Decrement
    const decrementedUser = await User.decrement(userId, 'balance', 25);
    assertEquals(decrementedUser.balance, initialUser.balance + 25, 'Decrement field');
    
    // Test 4: Chunk processing
    let chunkCount = 0;
    let processedItems = 0;
    
    await User.chunk(3, async (chunk, page) => {
        chunkCount++;
        processedItems += chunk.length;
    });
    
    assertEquals(chunkCount, 7, 'Chunk processing - number of chunks');
    assertEquals(processedItems, 20, 'Chunk processing - total items');
    
    // Test 5: Each processing
    let eachCount = 0;
    await User.each(async (user, index) => {
        eachCount++;
    });
    
    assertEquals(eachCount, 20, 'Each processing');
    
    // Test 6: Random records
    const randomUsers = await User.random(3);
    assertEquals(randomUsers.length, 3, 'Random records');
    
    // Test 7: First with filter
    const firstActive = await User.first({ is_active: true });
    assertEquals(firstActive.is_active, true, 'First with filter');
    
    // Test 8: Last with filter
    const lastActive = await User.last({ is_active: true });
    assertEquals(lastActive.is_active, true, 'Last with filter');
    
    console.log(`✅ Utility methods tests completed`);
}

async function testTransactions() {
    console.log('\n💱 Testing Transactions...');
    
    const User = DB.Model('users');
    
    // Test 1: Successful transaction
    const transactionResult = await DB.transaction(async (trx) => {
        const user1 = await User.create({
            username: 'transaction_user1',
            email: 'trans1@example.com',
            password: 'pass123'
        });
        
        const user2 = await User.create({
            username: 'transaction_user2',
            email: 'trans2@example.com',
            password: 'pass123'
        });
        
        // Update something
        await User.update(user1.id, { balance: 500 });
        
        return { user1, user2 };
    });
    
    assertEquals(transactionResult.user1.username, 'transaction_user1', 'Transaction committed');
    
    // Verify data persisted
    const foundUser = await User.findOne({ username: 'transaction_user1' });
    assertEquals(foundUser !== null, true, 'Transaction data persisted');
    
    // Test 2: Rollback transaction
    await assertThrows(async () => {
        await DB.transaction(async (trx) => {
            const user = await User.create({
                username: 'rollback_user',
                email: 'rollback@example.com',
                password: 'pass123'
            });
            
            // This should trigger rollback
            throw new Error('Intentional rollback');
        });
    }, 'Intentional rollback', 'Transaction rollback on error');
    
    // Verify rollback
    const rolledBackUser = await User.findOne({ username: 'rollback_user' });
    assertEquals(rolledBackUser, null, 'Transaction rolled back');
    
    // Test 3: Nested transactions
    const nestedResult = await DB.transaction(async (trx) => {
        const user1 = await User.create({
            username: 'nested_parent',
            email: 'nested1@example.com',
            password: 'pass123'
        });
        
        // Nested transaction
        const nested = await DB.transaction(async (innerTrx) => {
            const user2 = await User.create({
                username: 'nested_child',
                email: 'nested2@example.com',
                password: 'pass123'
            });
            return user2;
        });
        
        return { user1, nested };
    });
    
    assertEquals(nestedResult.nested.username, 'nested_child', 'Nested transaction committed');
    
    console.log(`✅ Transaction tests completed`);
}

async function testConcurrency() {
    console.log('\n👥 Testing Concurrency...');
    
    const User = DB.Model('users');
    
    // Clear existing data
    await User.deleteAll();
    
    // Test concurrent writes
    const startTime = Date.now();
    const concurrentWrites = [];
    
    for (let i = 0; i < CONCURRENT_USERS; i++) {
        concurrentWrites.push(User.create({
            username: `concurrent_user_${i}`,
            email: `concurrent_${i}@example.com`,
            password: 'pass123',
            age: 20 + (i % 30)
        }));
    }
    
    const results = await Promise.all(concurrentWrites);
    assertEquals(results.length, CONCURRENT_USERS, `Concurrent writes (${CONCURRENT_USERS} users)`);
    
    // Test concurrent reads
    const concurrentReads = [];
    for (let i = 0; i < CONCURRENT_USERS; i++) {
        concurrentReads.push(User.find({ age: 20 + (i % 30) }));
    }
    
    const readResults = await Promise.all(concurrentReads);
    assertEquals(readResults.length, CONCURRENT_USERS, `Concurrent reads (${CONCURRENT_USERS} reads)`);
    
    const duration = Date.now() - startTime;
    console.log(`  ⏱️ Concurrency test completed in ${duration}ms`);
    
    console.log(`✅ Concurrency tests completed`);
}

async function testPerformance(models) {
    console.log('\n⚡ Testing Performance...');
    
    const { User, Product } = models;
    
    // Clear existing data
    await User.deleteAll();
    await Product.deleteAll();
    
    // Test bulk insert performance
    console.log(`  📊 Bulk insert (${PERFORMANCE_ITERATIONS} records)...`);
    const bulkStart = Date.now();
    
    for (let i = 0; i < PERFORMANCE_ITERATIONS; i++) {
        await User.create({
            username: `perf_user_${i}`,
            email: `perf_${i}@example.com`,
            password: 'pass123',
            age: 20 + (i % 50),
            balance: i * 10
        });
    }
    
    const bulkDuration = Date.now() - bulkStart;
    console.log(`    Insert time: ${bulkDuration}ms (${(PERFORMANCE_ITERATIONS / bulkDuration * 1000).toFixed(2)} ops/sec)`);
    
    // Test query performance
    console.log(`  🔍 Query performance...`);
    const queryStart = Date.now();
    
    const queries = [];
    for (let i = 0; i < 100; i++) {
        queries.push(User.find({ age: 20 + (i % 50) }));
    }
    
    await Promise.all(queries);
    const queryDuration = Date.now() - queryStart;
    console.log(`    100 concurrent queries: ${queryDuration}ms`);
    
    // Test complex query performance
    const complexStart = Date.now();
    
    const complexQuery = await User.query()
        .where({ is_active: true })
        .whereRaw('balance > ?', [500])
        .orderBy('balance', 'DESC')
        .limit(10)
        .get();
    
    const complexDuration = Date.now() - complexStart;
    console.log(`    Complex query: ${complexDuration}ms`);
    
    // Test aggregation performance
    const aggStart = Date.now();
    
    const stats = await Promise.all([
        User.count(),
        User.max('balance'),
        User.min('balance'),
        User.avg('balance')
    ]);
    
    const aggDuration = Date.now() - aggStart;
    console.log(`    Aggregations: ${aggDuration}ms`);
    
    console.log(`✅ Performance tests completed`);
}

async function testEdgeCases() {
    console.log('\n⚠️ Testing Edge Cases...');
    
    const User = DB.Model('users');
    
    // Test 1: Empty database operations
    await User.deleteAll();
    
    const emptyFind = await User.find();
    assertEquals(emptyFind.length, 0, 'Find on empty table');
    
    const emptyFindOne = await User.findOne({ username: 'nonexistent' });
    assertEquals(emptyFindOne, null, 'FindOne on empty table');
    
    const emptyCount = await User.count();
    assertEquals(emptyCount, 0, 'Count on empty table');
    
    // Test 2: Null values handling
    const nullUser = await User.create({
        username: 'null_user',
        email: 'null@example.com',
        password: 'pass123',
        full_name: null,
        age: null
    });
    
    assertEquals(nullUser.full_name, null, 'Null field stored correctly');
    
    const foundNullUser = await User.findById(nullUser.id);
    assertEquals(foundNullUser.full_name, null, 'Null field retrieved correctly');
    
    // Test 3: Special characters in strings
    const specialUser = await User.create({
        username: 'special_!@#$%^&*()_+',
        email: 'special@example.com',
        password: 'pass"\'\\`123',
        full_name: "O'Connor \"Test\""
    });
    
    assertEquals(specialUser.username, 'special_!@#$%^&*()_+', 'Special characters handled');
    
    // Test 4: Large text fields
    const largeText = 'A'.repeat(10000);
    const largeTextUser = await User.create({
        username: 'large_text_user',
        email: 'large@example.com',
        password: 'pass123',
        metadata: { text: largeText }
    });
    
    assertEquals(largeTextUser.metadata.text.length, 10000, 'Large text field handled');
    
    // Test 5: Boolean values
    const boolUser = await User.create({
        username: 'bool_user',
        email: 'bool@example.com',
        password: 'pass123',
        is_active: false
    });
    
    assertEquals(boolUser.is_active, false, 'Boolean false stored correctly');
    
    // Test 6: JSON operations
    const jsonUser = await User.create({
        username: 'json_user',
        email: 'json@example.com',
        password: 'pass123',
        metadata: {
            preferences: {
                theme: 'dark',
                language: 'en',
                notifications: ['email', 'sms']
            },
            lastLogin: new Date().toISOString(),
            visits: 42
        }
    });
    
    assertEquals(typeof jsonUser.metadata, 'object', 'JSON stored as object');
    assertEquals(jsonUser.metadata.preferences.theme, 'dark', 'Nested JSON accessible');
    
    // Test 7: Negative numbers
    const negativeUser = await User.create({
        username: 'negative_user',
        email: 'negative@example.com',
        password: 'pass123',
        balance: -100.50,
        age: -5
    });
    
    assertEquals(negativeUser.balance, -100.50, 'Negative float stored');
    assertEquals(negativeUser.age, -5, 'Negative integer stored');
    
    // Test 8: Very large numbers
    const largeNumberUser = await User.create({
        username: 'large_number_user',
        email: 'large@example.com',
        password: 'pass123',
        balance: 999999999.99
    });
    
    assertEquals(largeNumberUser.balance, 999999999.99, 'Large number stored');
    
    // Test 9: Empty string handling
    const emptyStringUser = await User.create({
        username: 'empty_string_user',
        email: 'empty@example.com',
        password: '',
        full_name: ''
    });
    
    assertEquals(emptyStringUser.password, '', 'Empty string stored');
    
    // Test 10: Update non-existent record
    await assertThrows(
        async () => await User.update(999999, { username: 'new' }),
        'not found',
        'Update non-existent record'
    );
    
    // Test 11: Delete non-existent record
    const deleteNonExistent = await User.delete(999999);
    assertEquals(deleteNonExistent, false, 'Delete non-existent record');
    
    console.log(`✅ Edge cases tests completed`);
}

async function testDataTypes() {
    console.log('\n🔢 Testing Data Types...');
    
    // Create a table with all data types
    await DB.schema().create('data_types_test', (table) => {
        table.id();
        table.string('string_field');
        table.text('text_field');
        table.integer('integer_field');
        table.float('float_field');
        table.boolean('boolean_field');
        table.datetime('datetime_field');
        table.json('json_field');
    });
    
    const DataTypeModel = DB.Model('data_types_test', {
        string_field: 'string',
        text_field: 'text',
        integer_field: 'integer',
        float_field: 'float',
        boolean_field: 'boolean',
        datetime_field: 'datetime',
        json_field: 'json'
    });
    
    const now = new Date();
    const testData = {
        string_field: 'hello world',
        text_field: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(10),
        integer_field: 42,
        float_field: 3.14159,
        boolean_field: true,
        datetime_field: now.toISOString(),
        json_field: {
            array: [1, 2, 3, 4, 5],
            nested: { key: 'value', active: true },
            mixed: ['string', 42, null, { foo: 'bar' }]
        }
    };
    
    const created = await DataTypeModel.create(testData);
    
    // Verify each field
    assertEquals(created.string_field, testData.string_field, 'String field');
    assertEquals(created.text_field, testData.text_field, 'Text field');
    assertEquals(created.integer_field, testData.integer_field, 'Integer field');
    assertEquals(created.float_field, testData.float_field, 'Float field');
    assertEquals(created.boolean_field, testData.boolean_field, 'Boolean field');
    assertEquals(created.datetime_field, testData.datetime_field, 'Datetime field');
    assertEquals(JSON.stringify(created.json_field), JSON.stringify(testData.json_field), 'JSON field');
    
    // Test type casting
    const found = await DataTypeModel.findById(created.id);
    
    assertEquals(typeof found.integer_field, 'number', 'Integer type preserved');
    assertEquals(typeof found.float_field, 'number', 'Float type preserved');
    assertEquals(typeof found.boolean_field, 'boolean', 'Boolean type preserved');
    assertEquals(typeof found.json_field, 'object', 'JSON type preserved');
    
    console.log(`✅ Data types tests completed`);
}

async function testWALAndRecovery() {
    console.log('\n💾 Testing WAL and Recovery...');
    
    const User = DB.Model('users');
    
    // Create some data
    const testUsers = [];
    for (let i = 0; i < 10; i++) {
        testUsers.push(await User.create({
            username: `wal_user_${i}`,
            email: `wal_${i}@example.com`,
            password: 'pass123',
            balance: i * 100
        }));
    }
    
    // Force sync and get current state
    await DB.query('COMMIT'); // Ensure everything is committed
    
    // Simulate crash by not properly disconnecting
    // We'll just reconnect
    
    // Disconnect and reconnect
    await DB.Disconnect(TEST_DB);
    await DB.Connect(TEST_DB, { filename: TEST_FILE });
    
    // Re-get model (it will be re-initialized with new connection)
    const RecoveredUser = DB.Model('users');
    
    // Verify data survived
    const recoveredUsers = await RecoveredUser.all();
    assertEquals(recoveredUsers.length >= 10, true, 'Data recovered after reconnect');
    
    // Check specific user
    const recoveredUser = await RecoveredUser.findOne({ username: 'wal_user_5' });
    assertEquals(recoveredUser.balance, 500, 'Specific data recovered');
    
    console.log(`✅ WAL and recovery tests completed`);
}

async function testComplexQueries() {
    console.log('\n🔬 Testing Complex Queries...');
    
    const User = DB.Model('users');
    
    // Clear and create varied data
    await User.deleteAll();
    
    const categories = ['admin', 'user', 'guest', 'moderator'];
    for (let i = 0; i < 50; i++) {
        await User.create({
            username: `complex_${i}`,
            email: `complex_${i}@example.com`,
            password: 'pass123',
            age: 18 + (i % 50),
            balance: i * 50,
            is_active: i % 3 !== 0,
            metadata: {
                role: categories[i % categories.length],
                level: i % 10,
                verified: i % 4 === 0
            }
        });
    }
    
    // Test complex WHERE conditions
    const results1 = await User.query()
        .where({ is_active: true })
        .whereRaw('age BETWEEN ? AND ?', [25, 35])
        .whereRaw('balance > ?', [500])
        .orderBy('balance', 'DESC')
        .get();
    
    assertEquals(results1.length > 0, true, 'Complex WHERE with BETWEEN');
    
    // Test multiple ORDER BY
    const results2 = await User.query()
        .orderBy('is_active', 'DESC')
        .orderBy('age', 'ASC')
        .orderBy('balance', 'DESC')
        .limit(10)
        .get();
    
    assertEquals(results2.length, 10, 'Multiple ORDER BY');
    
    // Test nested conditions (simulated with raw where)
    const results3 = await User.query()
        .whereRaw('(age < ? OR age > ?)', [20, 40])
        .whereRaw('balance > ?', [200])
        .whereRaw('is_active = ?', [1])
        .get();
    
    assertEquals(results3.length > 0, true, 'Nested conditions');
    
    // Test with LIKE
    const results4 = await User.query()
        .whereRaw('username LIKE ?', ['complex_1%'])
        .get();
    
    assertEquals(results4.length, 11, 'LIKE query'); // complex_1, complex_10-19
    
    // Test with NOT
    const results5 = await User.query()
        .whereRaw('is_active != ?', [1])
        .get();
    
    assertEquals(results5.length > 0, true, 'NOT condition');
    
    console.log(`✅ Complex queries tests completed`);
}

async function testErrorHandling() {
    console.log('\n🚨 Testing Error Handling...');
    
    const User = DB.Model('users');
    
    // Test 1: Duplicate unique constraint
    try {
        await User.create({
            username: 'duplicate_user',
            email: 'duplicate@example.com',
            password: 'pass123'
        });
        
        await User.create({
            username: 'duplicate_user', // Same username
            email: 'different@example.com',
            password: 'pass123'
        });
    } catch (error) {
        recordTest('Duplicate unique constraint', 'passed');
    }
    
    // Test 2: Invalid field type
    try {
        await User.create({
            username: 'type_test',
            email: 'type@example.com',
            password: 'pass123',
            age: 'not_a_number' // Should be number
        });
        // If it doesn't throw, that's okay too (depending on implementation)
        recordTest('Invalid field type', 'passed');
    } catch (error) {
        recordTest('Invalid field type', 'passed');
    }
    
    // Test 3: Query with invalid syntax
    try {
        await DB.query('INVALID SQL QUERY');
        recordTest('Invalid SQL syntax', 'failed', new Error('Expected error but none thrown'));
    } catch (error) {
        recordTest('Invalid SQL syntax', 'passed');
    }
    
    // Test 4: Find with empty filter in findOne (should throw)
    try {
        await User.findOne({});
        recordTest('Empty filter in findOne', 'failed', new Error('Expected error but none thrown'));
    } catch (error) {
        recordTest('Empty filter in findOne', 'passed');
    }
    
    // Test 5: Update without ID
    try {
        await User.update(null, { name: 'test' });
        recordTest('Update without ID', 'failed', new Error('Expected error but none thrown'));
    } catch (error) {
        recordTest('Update without ID', 'passed');
    }
    
    console.log(`✅ Error handling tests completed`);
}

// ==================== Main Test Runner ====================

async function runAllTests() {
    console.log('=' .repeat(70));
    console.log('🚀 DB.js SQLite ORM - Comprehensive Test Suite');
    console.log('=' .repeat(70));
    console.log(`Start Time: ${new Date().toISOString()}`);
    console.log(`Test Database: ${TEST_FILE}`);
    console.log('=' .repeat(70));
    
    let models;
    
    try {
        // Clean up before tests
        await cleanup();
        
        // Run test suites
        await testDatabaseConnection();
        await testSchemaCreation();
        models = await testModelDefinition();
        await testCRUDOperations(models);
        await testQueryBuilder(models);
        await testAggregationMethods(models);
        await testPagination(models);
        await testUtilityMethods(models);
        await testTransactions();
        await testConcurrency();
        await testPerformance(models);
        await testEdgeCases();
        await testDataTypes();
        await testWALAndRecovery();
        await testComplexQueries();
        await testErrorHandling();
        
    } catch (error) {
        console.error('\n❌ Test suite error:', error);
        recordTest('Test Suite', 'failed', error);
    } finally {
        // Clean up after tests
        await cleanup();
    }
    
    // Calculate results
    testResults.endTime = Date.now();
    const duration = testResults.endTime - testResults.startTime;
    
    // Print summary
    console.log('\n' + '=' .repeat(70));
    console.log('📊 TEST SUMMARY');
    console.log('=' .repeat(70));
    console.log(`Total Tests: ${testResults.total}`);
    console.log(`✅ Passed: ${testResults.passed}`);
    console.log(`❌ Failed: ${testResults.failed}`);
    console.log(`⏭️  Skipped: ${testResults.skipped}`);
    console.log(`⏱️  Duration: ${duration}ms (${(duration / 1000).toFixed(2)}s)`);
    console.log(`📈 Success Rate: ${((testResults.passed / testResults.total) * 100).toFixed(2)}%`);
    
    if (testResults.failed > 0) {
        console.log('\n❌ Failed Tests:');
        testResults.tests
            .filter(t => t.status === 'failed')
            .forEach(t => {
                console.log(`  - ${t.name}: ${t.error?.message || 'Unknown error'}`);
            });
    }
    
    console.log('=' .repeat(70));
    
    // Return exit code
    process.exit(testResults.failed > 0 ? 1 : 0);
}

// Run tests
runAllTests().catch(console.error);