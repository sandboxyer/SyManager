// test-db-comprehensive.js - Complete test suite with detailed results
import DB from './DB.js';
import fs from 'fs';

// ==================== Test Utilities with Progress Tracking ====================
class TestRunner {
    constructor() {
        this.tests = [];
        this.currentCategory = '';
        this.passed = 0;
        this.failed = 0;
        this.total = 0;
        this.startTime = Date.now();
    }

    category(name) {
        this.currentCategory = name;
        console.log(`\n📁 ${name}`);
        console.log('-'.repeat(50));
    }

    async test(name, fn) {
        this.total++;
        const testId = this.total;
        
        try {
            await fn();
            this.passed++;
            console.log(`  ✅ ${testId}. ${name}`);
        } catch (error) {
            this.failed++;
            console.log(`  ❌ ${testId}. ${name}`);
            console.log(`     Error: ${error.message}`);
            if (error.expected !== undefined) {
                console.log(`     Expected: ${JSON.stringify(error.expected)}`);
                console.log(`     Got: ${JSON.stringify(error.actual)}`);
            }
        }
    }

    assert(condition, message, expected, actual) {
        if (!condition) {
            const error = new Error(message);
            error.expected = expected;
            error.actual = actual;
            throw error;
        }
    }

    equals(actual, expected, message) {
        const condition = actual === expected;
        if (!condition) {
            const error = new Error(message);
            error.expected = expected;
            error.actual = actual;
            throw error;
        }
        return true;
    }

    deepEquals(actual, expected, message) {
        const actualStr = JSON.stringify(actual);
        const expectedStr = JSON.stringify(expected);
        const condition = actualStr === expectedStr;
        if (!condition) {
            const error = new Error(message);
            error.expected = expectedStr;
            error.actual = actualStr;
            throw error;
        }
        return true;
    }

    notEquals(actual, expected, message) {
        const condition = actual !== expected;
        if (!condition) {
            const error = new Error(message);
            error.expected = `not ${expected}`;
            error.actual = actual;
            throw error;
        }
        return true;
    }

    isTrue(actual, message) {
        return this.equals(actual, true, message);
    }

    isFalse(actual, message) {
        return this.equals(actual, false, message);
    }

    async throws(fn, message) {
        try {
            await fn();
            const error = new Error(message);
            error.expected = 'Error thrown';
            error.actual = 'No error thrown';
            throw error;
        } catch (e) {
            if (e.expected) throw e;
            // Expected error occurred
            return true;
        }
    }

    async notThrows(fn, message) {
        try {
            await fn();
            return true;
        } catch (e) {
            const error = new Error(message);
            error.expected = 'No error';
            error.actual = e.message;
            throw error;
        }
    }

    summary() {
        const duration = ((Date.now() - this.startTime) / 1000).toFixed(2);
        const percentage = ((this.passed / this.total) * 100).toFixed(2);
        
        console.log('\n' + '='.repeat(60));
        console.log('📊 TEST SUMMARY');
        console.log('='.repeat(60));
        console.log(`Total Tests:    ${this.total}`);
        console.log(`Passed:         ${this.passed} (${percentage}%)`);
        console.log(`Failed:         ${this.failed}`);
        console.log(`Duration:       ${duration}s`);
        console.log('='.repeat(60));
        
        if (this.failed === 0) {
            console.log('\n🎉 ALL TESTS PASSED! 🎉\n');
        } else {
            console.log(`\n❌ ${this.failed} TEST(S) FAILED\n`);
        }
        
        return this.failed === 0;
    }
}

// ==================== Test Suite ====================
const test = new TestRunner();
const TEST_FILE = './test-comprehensive.sqlite';

// Clean up before starting
if (fs.existsSync(TEST_FILE)) {
    fs.unlinkSync(TEST_FILE);
}

try {
    // ==================== CONNECTION TESTS ====================
    test.category('CONNECTION TESTS (5 tests)');

    await test.test('Connect to SQLite database', async () => {
        await DB.Connect('testdb', { filename: TEST_FILE });
        test.isTrue(DB.hasConnection('testdb'), 'Connection should exist');
    });

    await test.test('List connections', async () => {
        const connections = DB.listConnections();
        test.equals(connections.length, 1, 'Should have 1 connection');
        test.isTrue(connections.includes('testdb'), 'Should include testdb');
    });

    await test.test('Default connection', async () => {
        test.equals(DB.defaultConnection, 'testdb', 'Default connection should be testdb');
    });

    await test.test('Get connection info', async () => {
        const conn = DB.getConnection('testdb');
        test.notEquals(conn, null, 'Connection info should exist');
        test.equals(conn.driver, 'sqlite', 'Driver should be sqlite');
    });

    await test.test('Database file created', async () => {
        test.isTrue(fs.existsSync(TEST_FILE), 'Database file should exist');
    });

    // ==================== MODEL DEFINITION TESTS ====================
    test.category('MODEL DEFINITION TESTS (8 tests)');

    const User = DB.Model('users', {
        name: { type: 'string', required: true },
        email: { type: 'string', required: true },
        age: 'number',
        isActive: { type: 'boolean', default: true },
        score: 'number',
        tags: 'json',
        metadata: { type: 'json', default: {} }
    });

    const Product = DB.Model('products', {
        name: { type: 'string', required: true },
        price: { type: 'number', required: true },
        inStock: { type: 'boolean', default: true },
        category: 'string',
        views: { type: 'number', default: 0 }
    });

    const Post = DB.Model('posts', {
        title: { type: 'string', required: true },
        content: 'text',
        userId: 'number',
        published: { type: 'boolean', default: false }
    });

    await test.test('Models registered', async () => {
        const models = DB.listModels();
        test.isTrue('users' in models, 'User model registered');
        test.isTrue('products' in models, 'Product model registered');
        test.isTrue('posts' in models, 'Post model registered');
    });

    await test.test('Table names set correctly', async () => {
        test.equals(User.tableName, 'users', 'User table name');
        test.equals(Product.tableName, 'products', 'Product table name');
        test.equals(Post.tableName, 'posts', 'Post table name');
    });

    await test.test('Schema defined', async () => {
        test.notEquals(User.schema, undefined, 'User schema exists');
        test.equals(Object.keys(User.schema).length, 7, 'User has 7 fields');
    });

    await test.test('Schema types mapped correctly', async () => {
        test.equals(User.schema.name.type, 'string', 'name is string');
        test.equals(User.schema.age.type, 'float', 'age is float');
        test.equals(User.schema.isActive.type, 'boolean', 'isActive is boolean');
        test.equals(User.schema.tags.type, 'json', 'tags is json');
    });

    // ==================== SCHEMA CREATION TESTS ====================
    test.category('SCHEMA CREATION TESTS (8 tests)');

    const schema = DB.schema();

    await test.test('Create users table', async () => {
        await schema.create('users', table => {
            table.id();
            table.string('name').nullable(false);
            table.string('email').unique();
            table.integer('age');
            table.boolean('isActive').default(true);
            table.float('score').default(0);
            table.json('tags');
            table.json('metadata');
            table.timestamps();
        });
        
        const hasTable = await schema.hasTable('users');
        test.isTrue(hasTable, 'Users table should exist');
    });

    await test.test('Create products table', async () => {
        await schema.create('products', table => {
            table.id();
            table.string('name');
            table.float('price');
            table.boolean('inStock').default(true);
            table.string('category');
            table.integer('views').default(0);
            table.timestamps();
        });
        
        const hasTable = await schema.hasTable('products');
        test.isTrue(hasTable, 'Products table should exist');
    });

    await test.test('Create posts table', async () => {
        await schema.create('posts', table => {
            table.id();
            table.string('title');
            table.text('content');
            table.integer('userId');
            table.boolean('published').default(false);
            table.timestamps();
        });
        
        const hasTable = await schema.hasTable('posts');
        test.isTrue(hasTable, 'Posts table should exist');
    });

    await test.test('List all tables', async () => {
        const tables = await DB.listCollections();
        test.equals(tables.length, 3, 'Should have 3 tables');
        test.isTrue(tables.includes('users'), 'Includes users');
        test.isTrue(tables.includes('products'), 'Includes products');
        test.isTrue(tables.includes('posts'), 'Includes posts');
    });

    await test.test('Check columns exist', async () => {
        const hasName = await schema.hasColumn('users', 'name');
        const hasEmail = await schema.hasColumn('users', 'email');
        const hasAge = await schema.hasColumn('users', 'age');
        
        test.isTrue(hasName, 'name column exists');
        test.isTrue(hasEmail, 'email column exists');
        test.isTrue(hasAge, 'age column exists');
    });

    // ==================== CREATE OPERATIONS TESTS ====================
    test.category('CREATE OPERATIONS TESTS (12 tests)');

    await test.test('Create single user', async () => {
        const user = await User.create({
            name: 'John Doe',
            email: 'john@example.com',
            age: 30,
            isActive: true,
            score: 100,
            tags: ['developer', 'nodejs'],
            metadata: { role: 'admin' }
        });

        test.notEquals(user.id, undefined, 'User should have ID');
        test.equals(user.name, 'John Doe', 'Name correct');
        test.equals(user.email, 'john@example.com', 'Email correct');
        test.equals(user.age, 30, 'Age correct');
        test.isTrue(user.isActive, 'isActive correct');
        test.deepEquals(user.tags, ['developer', 'nodejs'], 'Tags correct');
        test.deepEquals(user.metadata, { role: 'admin' }, 'Metadata correct');
    });

    await test.test('Create user with defaults', async () => {
        const user = await User.create({
            name: 'Jane Smith',
            email: 'jane@example.com',
            age: 28
        });

        test.isTrue(user.isActive, 'Default isActive applied');
        test.equals(user.score, 100, 'Default score applied');
        test.deepEquals(user.metadata, {}, 'Default metadata applied');
    });

    await test.test('Create multiple users', async () => {
        const users = await User.createMany([
            { name: 'Bob Wilson', email: 'bob@example.com', age: 35 },
            { name: 'Alice Brown', email: 'alice@example.com', age: 27 },
            { name: 'Charlie Davis', email: 'charlie@example.com', age: 42 }
        ]);

        test.equals(users.length, 3, 'Created 3 users');
        
        const allUsers = await User.find();
        test.equals(allUsers.length, 5, 'Total 5 users');
    });

    await test.test('Create product', async () => {
        const product = await Product.create({
            name: 'Laptop',
            price: 999.99,
            category: 'electronics',
            views: 10
        });

        test.equals(product.name, 'Laptop', 'Product name correct');
        test.equals(product.price, 999.99, 'Price correct');
        test.isTrue(product.inStock, 'Default inStock applied');
        test.equals(product.views, 10, 'Views correct');
    });

    await test.test('Create post', async () => {
        const post = await Post.create({
            title: 'Test Post',
            content: 'This is a test post',
            userId: 1,
            published: true
        });

        test.equals(post.title, 'Test Post', 'Post title correct');
        test.equals(post.content, 'This is a test post', 'Content correct');
        test.equals(post.userId, 1, 'UserId correct');
        test.isTrue(post.published, 'Published correct');
    });

    await test.test('Create with missing required field fails', async () => {
        await test.throws(async () => {
            await User.create({ age: 25 });
        }, 'Should throw error for missing required field');
    });

    // ==================== READ OPERATIONS TESTS ====================
    test.category('READ OPERATIONS TESTS (14 tests)');

    await test.test('Find all users', async () => {
        const users = await User.find();
        test.equals(users.length, 5, 'Should find 5 users');
    });

    await test.test('Find with filter', async () => {
        const activeUsers = await User.find({ isActive: true });
        test.equals(activeUsers.length, 5, 'All users active');
    });

    await test.test('Find one user', async () => {
        const john = await User.findOne({ name: 'John Doe' });
        test.notEquals(john, null, 'Should find user');
        test.equals(john.email, 'john@example.com', 'Correct user found');
    });

    await test.test('Find by ID', async () => {
        const john = await User.findOne({ name: 'John Doe' });
        const found = await User.findById(john.id);
        test.deepEquals(found, john, 'FindById returns correct user');
    });

    await test.test('Find by IDs', async () => {
        const users = await User.find();
        const ids = users.slice(0, 2).map(u => u.id);
        const found = await User.findByIds(ids);
        test.equals(found.length, 2, 'Found 2 users');
    });

    await test.test('First record', async () => {
        const first = await User.first();
        test.notEquals(first, null, 'First returns a user');
        test.equals(first.name, 'John Doe', 'First is John Doe');
    });

    await test.test('Last record', async () => {
        const last = await User.last();
        test.notEquals(last, null, 'Last returns a user');
    });

    await test.test('Exists check', async () => {
        const exists = await User.exists({ email: 'john@example.com' });
        test.isTrue(exists, 'Exists returns true');
        
        const notExists = await User.exists({ email: 'nonexistent@example.com' });
        test.isFalse(notExists, 'Exists returns false');
    });

    await test.test('Count records', async () => {
        const count = await User.count({ age: 30 });
        test.equals(count, 1, 'Count with filter works');
        
        const total = await User.count();
        test.equals(total, 5, 'Total count works');
    });

    // ==================== UPDATE OPERATIONS TESTS ====================
    test.category('UPDATE OPERATIONS TESTS (10 tests)');

    await test.test('Update user', async () => {
        const john = await User.findOne({ name: 'John Doe' });
        const updated = await User.update(john.id, {
            age: 31,
            score: 150
        });

        test.equals(updated.age, 31, 'Age updated');
        test.equals(updated.score, 150, 'Score updated');
        test.equals(updated.name, 'John Doe', 'Name unchanged');
    });

    await test.test('Update many users', async () => {
        const updated = await User.updateMany(
            { isActive: true },
            { score: 200 }
        );

        test.equals(updated.length, 5, 'All users updated');
        
        const users = await User.find();
        users.forEach(user => {
            test.equals(user.score, 200, 'Score updated to 200');
        });
    });

    await test.test('Update or create - update existing', async () => {
        const result = await User.updateOrCreate(
            { email: 'john@example.com' },
            { name: 'John Updated', age: 32 }
        );

        test.equals(result.name, 'John Updated', 'Name updated');
        test.equals(result.age, 32, 'Age updated');
    });

    await test.test('Update or create - create new', async () => {
        const result = await User.updateOrCreate(
            { email: 'new@example.com' },
            { name: 'New User', age: 25 }
        );

        test.equals(result.email, 'new@example.com', 'New user created');
        test.equals(result.name, 'New User', 'Name correct');
    });

    await test.test('Increment field', async () => {
        const john = await User.findOne({ name: 'John Updated' });
        const incremented = await User.increment(john.id, 'score', 10);
        test.equals(incremented.score, 210, 'Increment works');
    });

    await test.test('Decrement field', async () => {
        const john = await User.findOne({ name: 'John Updated' });
        const decremented = await User.decrement(john.id, 'age', 1);
        test.equals(decremented.age, 31, 'Decrement works');
    });

    await test.test('Toggle boolean field', async () => {
        const john = await User.findOne({ name: 'John Updated' });
        const toggled = await User.toggle(john.id, 'isActive');
        test.isFalse(toggled.isActive, 'Toggle to false');
        
        const toggledAgain = await User.toggle(john.id, 'isActive');
        test.isTrue(toggledAgain.isActive, 'Toggle back to true');
    });

    // ==================== DELETE OPERATIONS TESTS ====================
    test.category('DELETE OPERATIONS TESTS (8 tests)');

    let deleteTestId;

    await test.test('Delete single user', async () => {
        const bob = await User.findOne({ name: 'Bob Wilson' });
        deleteTestId = bob.id;
        
        const deleted = await User.delete(bob.id);
        test.isTrue(deleted, 'Delete returns true');
        
        const notFound = await User.findById(bob.id);
        test.equals(notFound, null, 'User no longer exists');
    });

    await test.test('Delete many users', async () => {
        const beforeCount = await User.count();
        const deleted = await User.deleteMany({ age: 27 });
        
        test.equals(deleted, 1, 'Deleted 1 user');
        
        const afterCount = await User.count();
        test.equals(afterCount, beforeCount - 1, 'Count decreased');
    });

    await test.test('Delete non-existent returns false', async () => {
        const deleted = await User.delete(999999);
        test.isFalse(deleted, 'Delete returns false');
    });

    await test.test('Delete all users', async () => {
        const remaining = await User.count();
        const deleted = await User.deleteAll();
        
        test.equals(deleted, remaining, 'Deleted all remaining');
        
        const final = await User.count();
        test.equals(final, 0, 'Database empty');
    });

    // ==================== QUERY BUILDER TESTS ====================
    test.category('QUERY BUILDER TESTS (14 tests)');

    // Recreate products for query tests
    await Product.deleteAll();
    await Product.createMany([
        { name: 'Laptop', price: 999.99, category: 'electronics', inStock: true, views: 10 },
        { name: 'Mouse', price: 29.99, category: 'electronics', inStock: true, views: 5 },
        { name: 'Keyboard', price: 79.99, category: 'electronics', inStock: false, views: 8 },
        { name: 'Desk', price: 299.99, category: 'furniture', inStock: true, views: 3 },
        { name: 'Chair', price: 149.99, category: 'furniture', inStock: true, views: 6 },
        { name: 'Monitor', price: 249.99, category: 'electronics', inStock: true, views: 12 }
    ]);

    await test.test('Query with where', async () => {
        const results = await Product.query()
            .where({ category: 'electronics' })
            .get();
        
        test.equals(results.length, 4, 'Found 4 electronics');
    });

    await test.test('Query with multiple conditions', async () => {
        const results = await Product.query()
            .where({ category: 'electronics', inStock: true })
            .get();
        
        test.equals(results.length, 3, 'Found 3 in-stock electronics');
    });

    await test.test('Query with orderBy', async () => {
        const results = await Product.query()
            .orderBy('price', 'DESC')
            .get();
        
        test.equals(results[0].name, 'Laptop', 'Most expensive first');
        test.equals(results[5].name, 'Mouse', 'Cheapest last');
    });

    await test.test('Query with limit', async () => {
        const results = await Product.query()
            .orderBy('views', 'DESC')
            .limit(3)
            .get();
        
        test.equals(results.length, 3, 'Limited to 3');
        test.equals(results[0].name, 'Monitor', 'Top by views');
    });

    await test.test('Query with offset', async () => {
        const results = await Product.query()
            .orderBy('price', 'ASC')
            .offset(2)
            .limit(2)
            .get();
        
        test.equals(results.length, 2, 'Offset 2, limit 2');
        test.equals(results[0].name, 'Keyboard', 'Third cheapest');
    });

    await test.test('WhereIn', async () => {
        const products = await Product.find();
        const ids = products.slice(0, 3).map(p => p.id);
        
        const results = await Product.query()
            .whereIn('id', ids)
            .get();
        
        test.equals(results.length, 3, 'Found 3 by IDs');
    });

    await test.test('WhereBetween', async () => {
        const results = await Product.query()
            .whereBetween('price', [50, 200])
            .get();
        
        test.equals(results.length, 3, 'Found 3 in price range');
    });

    await test.test('Query builder count', async () => {
        const count = await Product.query()
            .where({ category: 'electronics' })
            .count();
        
        test.equals(count, 4, 'Count works');
    });

    await test.test('Query builder first', async () => {
        const first = await Product.query()
            .orderBy('price', 'ASC')
            .first();
        
        test.equals(first.name, 'Mouse', 'First returns cheapest');
    });

    // ==================== UTILITY METHODS TESTS ====================
    test.category('UTILITY METHODS TESTS (12 tests)');

    await test.test('Pluck single field', async () => {
        const names = await Product.pluck('name');
        test.equals(names.length, 6, 'Pluck returns array');
        test.isTrue(names.includes('Laptop'), 'Contains laptop');
    });

    await test.test('Pluck with key', async () => {
        const map = await Product.pluckWithKey('name', 'price');
        test.equals(map['Laptop'], 999.99, 'Correct price mapping');
    });

    await test.test('Distinct values', async () => {
        const categories = await Product.distinct('category');
        test.equals(categories.length, 2, 'Two distinct categories');
        test.isTrue(categories.includes('electronics'), 'Has electronics');
        test.isTrue(categories.includes('furniture'), 'Has furniture');
    });

    await test.test('Random records', async () => {
        const random = await Product.random(3);
        test.equals(random.length, 3, 'Random returns 3');
        
        // Random should be different most of the time
        const random2 = await Product.random(3);
        test.notEquals(JSON.stringify(random), JSON.stringify(random2), 'Different random sets');
    });

    await test.test('Chunk processing', async () => {
        let chunks = 0;
        let items = 0;
        
        await Product.chunk(2, async (chunk, page) => {
            chunks++;
            items += chunk.length;
            test.isTrue(chunk.length <= 2, `Chunk ${page} size correct`);
        });
        
        test.equals(chunks, 3, 'Processed 3 chunks');
        test.equals(items, 6, 'Processed all 6 items');
    });

    await test.test('Each processing', async () => {
        let count = 0;
        await Product.each(async (product, index) => {
            count++;
            test.notEquals(product.name, undefined, 'Product has name');
        });
        test.equals(count, 6, 'Processed all items');
    });

    // ==================== AGGREGATION TESTS ====================
    test.category('AGGREGATION TESTS (8 tests)');

    await test.test('Max value', async () => {
        const max = await Product.max('price');
        test.equals(max, 999.99, 'Max price correct');
    });

    await test.test('Min value', async () => {
        const min = await Product.min('price');
        test.equals(min, 29.99, 'Min price correct');
    });

    await test.test('Sum', async () => {
        const sum = await Product.sum('views');
        test.equals(sum, 44, 'Sum of views correct');
    });

    await test.test('Average', async () => {
        const avg = await Product.avg('price');
        const expected = (999.99 + 29.99 + 79.99 + 299.99 + 149.99 + 249.99) / 6;
        test.equals(Math.round(avg * 100) / 100, Math.round(expected * 100) / 100, 'Average correct');
    });

    await test.test('Sum with filter', async () => {
        const sum = await Product.sum('views', { category: 'electronics' });
        test.equals(sum, 35, 'Sum of electronics views correct');
    });

    await test.test('Average with filter', async () => {
        const avg = await Product.avg('price', { category: 'furniture' });
        test.equals(avg, 224.99, 'Average furniture price correct');
    });

    // ==================== PAGINATION TESTS ====================
    test.category('PAGINATION TESTS (8 tests)');

    await test.test('Page 1 with 3 per page', async () => {
        const result = await Product.paginate(1, 3);
        test.equals(result.data.length, 3, 'Page 1 has 3 items');
        test.equals(result.meta.current_page, 1, 'Current page correct');
        test.equals(result.meta.per_page, 3, 'Per page correct');
        test.equals(result.meta.total, 6, 'Total correct');
    });

    await test.test('Page 2 with 3 per page', async () => {
        const result = await Product.paginate(2, 3);
        test.equals(result.data.length, 3, 'Page 2 has 3 items');
        test.equals(result.meta.current_page, 2, 'Current page correct');
        test.equals(result.meta.from, 4, 'From index correct');
    });

    await test.test('Last page', async () => {
        const result = await Product.paginate(2, 4);
        test.equals(result.data.length, 2, 'Last page has 2 items');
        test.equals(result.meta.last_page, 2, 'Last page correct');
    });

    await test.test('Pagination with filter', async () => {
        const result = await Product.paginate(1, 2, { category: 'electronics' });
        test.equals(result.data.length, 2, 'Filtered page has 2');
        test.equals(result.meta.total, 4, 'Filtered total correct');
    });

    await test.test('Pagination with empty results', async () => {
        const result = await Product.paginate(1, 10, { category: 'nonexistent' });
        test.equals(result.data.length, 0, 'Empty results');
        test.equals(result.meta.total, 0, 'Total is 0');
    });

    // ==================== TRANSACTION TESTS ====================
    test.category('TRANSACTION TESTS (6 tests)');

    await test.test('Successful transaction', async () => {
        const beforeCount = await Product.count();
        
        const result = await DB.transaction(async (trx) => {
            await trx.query('INSERT INTO products (name, price, category) VALUES (?, ?, ?)', 
                ['Transaction Test', 199.99, 'test']);
            
            await trx.query('UPDATE products SET price = ? WHERE name = ?', 
                [299.99, 'Laptop']);
            
            return { success: true };
        });

        test.isTrue(result.success, 'Transaction committed');
        
        const afterCount = await Product.count();
        test.equals(afterCount, beforeCount + 1, 'Insert committed');
        
        const laptop = await Product.findOne({ name: 'Laptop' });
        test.equals(laptop.price, 299.99, 'Update committed');
    });

    await test.test('Failed transaction rolls back', async () => {
        const beforeCount = await Product.count();
        
        try {
            await DB.transaction(async (trx) => {
                await trx.query('INSERT INTO products (name, price, category) VALUES (?, ?, ?)', 
                    ['Rollback Test', 49.99, 'test']);
                
                // This should fail
                await trx.query('INVALID SQL');
            });
        } catch (e) {
            // Expected
        }

        const afterCount = await Product.count();
        test.equals(afterCount, beforeCount, 'Rollback prevented insert');
        
        const rollbackTest = await Product.findOne({ name: 'Rollback Test' });
        test.equals(rollbackTest, null, 'Insert rolled back');
    });

    // ==================== SCHEMA OPERATIONS TESTS ====================
    test.category('SCHEMA OPERATIONS TESTS (6 tests)');

    await test.test('Create new table', async () => {
        await schema.create('categories', table => {
            table.id();
            table.string('name').unique();
            table.text('description').nullable();
            table.boolean('active').default(true);
            table.timestamps();
        });
        
        const hasTable = await schema.hasTable('categories');
        test.isTrue(hasTable, 'Categories table created');
    });

    await test.test('Alter table', async () => {
        await schema.table('categories', table => {
            table.integer('sort_order').default(0);
        });
        
        const hasColumn = await schema.hasColumn('categories', 'sort_order');
        test.isTrue(hasColumn, 'New column added');
    });

    await test.test('Drop table', async () => {
        await schema.drop('categories');
        const hasTable = await schema.hasTable('categories');
        test.isFalse(hasTable, 'Table dropped');
    });

    // ==================== EDGE CASES TESTS ====================
    test.category('EDGE CASES TESTS (8 tests)');

    await test.test('Empty results return empty array', async () => {
        const results = await User.find({ name: 'NonExistent' });
        test.deepEquals(results, [], 'Empty array returned');
    });

    await test.test('Null values handled', async () => {
        const user = await User.create({
            name: 'Null User',
            email: 'null@test.com',
            age: null,
            tags: null
        });
        
        test.equals(user.age, null, 'Null age accepted');
        test.equals(user.tags, null, 'Null tags accepted');
    });

    await test.test('Empty string handled', async () => {
        const user = await User.create({
            name: '',
            email: 'empty@test.com',
            age: 25
        });
        
        test.equals(user.name, '', 'Empty string accepted');
    });

    await test.test('Very large numbers handled', async () => {
        const user = await User.create({
            name: 'Large Numbers',
            email: 'large@test.com',
            age: 999999999,
            score: 999999999.99
        });
        
        test.equals(user.age, 999999999, 'Large integer accepted');
        test.equals(user.score, 999999999.99, 'Large float accepted');
    });

    await test.test('Special characters handled', async () => {
        const user = await User.create({
            name: 'Special !@#$%^&*()',
            email: 'special@test.com',
            age: 25
        });
        
        test.equals(user.name, 'Special !@#$%^&*()', 'Special chars accepted');
    });

    await test.test('Boolean false handled', async () => {
        const user = await User.create({
            name: 'False User',
            email: 'false@test.com',
            isActive: false
        });
        
        test.isFalse(user.isActive, 'Boolean false accepted');
    });

    // ==================== VALIDATION TESTS ====================
    test.category('VALIDATION TESTS (6 tests)');

    const ValidatedUser = DB.Model('validated_users', {
        username: { type: 'string', required: true },
        email: { type: 'string', required: true },
        age: { type: 'number', required: true },
        isActive: { type: 'boolean', default: true }
    });

    await schema.create('validated_users', table => {
        table.id();
        table.string('username');
        table.string('email');
        table.integer('age');
        table.boolean('isActive');
        table.timestamps();
    });

    await test.test('Valid data passes', async () => {
        await test.notThrows(async () => {
            await ValidatedUser.create({
                username: 'validuser',
                email: 'valid@test.com',
                age: 25
            });
        }, 'Valid data should pass');
    });

    await test.test('Missing required field fails', async () => {
        await test.throws(async () => {
            await ValidatedUser.create({
                username: 'test',
                email: 'test@test.com'
            });
        }, 'Missing required field should fail');
    });

    await test.test('Null for required field fails', async () => {
        await test.throws(async () => {
            await ValidatedUser.create({
                username: null,
                email: 'test@test.com',
                age: 25
            });
        }, 'Null for required field should fail');
    });

    // ==================== STATISTICS TESTS ====================
    test.category('STATISTICS TESTS (4 tests)');

    await test.test('Get database stats', async () => {
        const stats = await DB.getStats();
        test.equals(stats.driver, 'sqlite', 'Driver is sqlite');
        test.isTrue(stats.collections >= 3, 'Has at least 3 tables');
        test.isTrue(stats.totalRecords > 0, 'Has records');
    });

    await test.test('Get database version', async () => {
        const version = await DB.getVersion();
        test.notEquals(version, 'Unknown', 'Version retrieved');
    });

    // ==================== DISCONNECT TESTS ====================
    test.category('DISCONNECT TESTS (3 tests)');

    await test.test('Disconnect from database', async () => {
        await DB.Disconnect('testdb');
        test.isFalse(DB.hasConnection('testdb'), 'Connection removed');
    });

    await test.test('List connections after disconnect', async () => {
        const connections = DB.listConnections();
        test.equals(connections.length, 0, 'No connections');
    });

    await test.test('Disconnect all (already disconnected)', async () => {
        await DB.DisconnectAll();
        test.equals(DB.listConnections().length, 0, 'Still no connections');
    });

} catch (error) {
    console.error('\n💥 Unexpected error:', error);
} finally {
    // Print summary
    const passed = test.summary();
    
    // Clean up
    try {
        if (fs.existsSync(TEST_FILE)) {
            fs.unlinkSync(TEST_FILE);
        }
    } catch (e) {
        // Ignore cleanup errors
    }
    
    process.exit(passed ? 0 : 1);
}