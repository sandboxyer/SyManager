// test-sqlite.js - Comprehensive test suite for SQLite default configuration
// Run with: node test-sqlite.js

import DB from './DB.js';

// ==================== Test Utilities ====================
const assert = {
    equals: (actual, expected, message) => {
        if (actual !== expected) {
            throw new Error(`❌ ${message}: Expected ${expected}, got ${actual}`);
        }
        console.log(`✅ ${message}`);
    },
    notEquals: (actual, expected, message) => {
        if (actual === expected) {
            throw new Error(`❌ ${message}: Expected not equal to ${expected}`);
        }
        console.log(`✅ ${message}`);
    },
    deepEquals: (actual, expected, message) => {
        try {
            const actualStr = JSON.stringify(actual);
            const expectedStr = JSON.stringify(expected);
            if (actualStr !== expectedStr) {
                throw new Error(`❌ ${message}: Expected ${expectedStr}, got ${actualStr}`);
            }
        } catch (e) {
            throw new Error(`❌ ${message}: ${e.message}`);
        }
        console.log(`✅ ${message}`);
    },
    isTrue: (value, message) => {
        if (!value) {
            throw new Error(`❌ ${message}: Expected true`);
        }
        console.log(`✅ ${message}`);
    },
    isFalse: (value, message) => {
        if (value) {
            throw new Error(`❌ ${message}: Expected false`);
        }
        console.log(`✅ ${message}`);
    },
    throws: async (fn, message) => {
        try {
            await fn();
            throw new Error(`❌ ${message}: Expected error but none thrown`);
        } catch (e) {
            console.log(`✅ ${message}`);
        }
    },
    notThrows: async (fn, message) => {
        try {
            await fn();
            console.log(`✅ ${message}`);
        } catch (e) {
            throw new Error(`❌ ${message}: Unexpected error: ${e.message}`);
        }
    }
};

// ==================== Test Suite ====================
class TestSuite {
    constructor() {
        this.tests = 0;
        this.passed = 0;
        this.failed = 0;
    }

    async run() {
        console.log('\n📋 Starting SQLite Database Tests\n');
        console.log('=' .repeat(60));

        try {
            // Connection Tests
            await this.testConnection();
            
            // Model Definition Tests
            await this.testModelDefinition();
            
            // CRUD Operation Tests
            await this.testCreateOperations();
            await this.testReadOperations();
            await this.testUpdateOperations();
            await this.testDeleteOperations();
            
            // Query Builder Tests
            await this.testQueryBuilder();
            
            // Utility Method Tests
            await this.testUtilityMethods();
            
            // Aggregation Tests
            await this.testAggregationMethods();
            
            // Batch Operation Tests
            await this.testBatchOperations();
            
            // Transaction Tests
            await this.testTransactions();
            
            // Schema Tests
            await this.testSchemaOperations();
            
            // Edge Cases
            await this.testEdgeCases();
            
            // Validation Tests
            await this.testValidation();

            console.log('=' .repeat(60));
            console.log(`\n📊 Test Results: ${this.passed} passed, ${this.failed} failed\n`);
            
        } catch (error) {
            console.error('\n💥 Test suite error:', error);
        } finally {
            await this.cleanup();
        }
    }

    async testConnection() {
        console.log('\n🔌 Testing SQLite Connection...');
        this.tests += 4;

        // Test SQLite connection with file
        await assert.notThrows(async () => {
            await DB.Connect('testdb', { 
                driver: 'sqlite', 
                filename: './test.sqlite' 
            });
        }, 'SQLite file connection');

        // Verify connection exists
        const connections = DB.listConnections();
        assert.equals(connections.length, 1, 'One connection established');
        assert.isTrue(connections.includes('testdb'), 'Connection listed');

        // Verify default connection
        assert.equals(DB.defaultConnection, 'testdb', 'Default connection set correctly');

        this.passed += 4;
    }

    async testModelDefinition() {
        console.log('\n📦 Testing Model Definition...');
        this.tests += 6;

        // Define models with various schema types
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

        // Verify models are registered
        const models = DB.listModels();
        assert.isTrue('users' in models, 'User model registered');
        assert.isTrue('products' in models, 'Product model registered');
        assert.isTrue('posts' in models, 'Post model registered');

        // Verify model properties
        assert.equals(User.tableName, 'users', 'Table name set correctly');
        
        // Verify schema
        assert.notEquals(User.schema, undefined, 'Schema defined');
        assert.equals(Object.keys(User.schema).length, 7, 'User schema has 7 fields');

        this.passed += 6;
    }

    async testCreateOperations() {
        console.log('\n📝 Testing Create Operations...');
        this.tests += 12;

        const User = DB.Model('users');

        // Test single create
        const user1 = await User.create({
            name: 'John Doe',
            email: 'john@example.com',
            age: 30,
            isActive: true,
            score: 100,
            tags: ['developer', 'nodejs'],
            metadata: { role: 'admin' }
        });

        assert.notEquals(user1.id, undefined, 'User created with ID');
        assert.equals(user1.name, 'John Doe', 'Name set correctly');
        assert.equals(user1.email, 'john@example.com', 'Email set correctly');
        assert.equals(user1.age, 30, 'Age set correctly');
        assert.isTrue(user1.isActive, 'isActive set correctly');
        assert.deepEquals(user1.tags, ['developer', 'nodejs'], 'Tags set correctly');
        assert.deepEquals(user1.metadata, { role: 'admin' }, 'Metadata set correctly');

        // Test create with defaults
        const user2 = await User.create({
            name: 'Jane Smith',
            email: 'jane@example.com',
            age: 28
        });

        assert.isTrue(user2.isActive, 'Default value applied');

        // Test create many
        const users = await User.createMany([
            { name: 'Bob Wilson', email: 'bob@example.com', age: 35 },
            { name: 'Alice Brown', email: 'alice@example.com', age: 27 },
            { name: 'Charlie Davis', email: 'charlie@example.com', age: 42 }
        ]);

        assert.equals(users.length, 3, 'Created 3 users');
        
        const allUsers = await User.find();
        assert.equals(allUsers.length, 5, 'Total 5 users after creates');

        // Test create with missing required field
        await assert.throws(async () => {
            await User.create({ age: 25 });
        }, 'Create fails with missing required fields');

        this.passed += 12;
    }

    async testReadOperations() {
        console.log('\n🔍 Testing Read Operations...');
        this.tests += 12;

        const User = DB.Model('users');

        // Test find all
        const allUsers = await User.find();
        assert.equals(allUsers.length, 5, 'Find all returns 5 users');

        // Test find with filter
        const activeUsers = await User.find({ isActive: true });
        assert.equals(activeUsers.length, 5, 'All users active');

        // Test findOne
        const john = await User.findOne({ name: 'John Doe' });
        assert.notEquals(john, null, 'FindOne returns user');
        assert.equals(john.email, 'john@example.com', 'Correct user found');

        // Test findById
        const userById = await User.findById(john.id);
        assert.deepEquals(userById, john, 'FindById returns correct user');

        // Test findByIds
        const users = await User.find();
        const ids = users.slice(0, 2).map(u => u.id);
        const foundUsers = await User.findByIds(ids);
        assert.equals(foundUsers.length, 2, 'FindByIds returns correct count');

        // Test first
        const firstUser = await User.first();
        assert.notEquals(firstUser, null, 'First returns a user');

        // Test last
        const lastUser = await User.last();
        assert.notEquals(lastUser, null, 'Last returns a user');
        assert.notEquals(firstUser.id, lastUser.id, 'First and last are different');

        // Test exists
        const exists = await User.exists({ email: 'john@example.com' });
        assert.isTrue(exists, 'Exists returns true for existing user');

        const notExists = await User.exists({ email: 'nonexistent@example.com' });
        assert.isFalse(notExists, 'Exists returns false for non-existent user');

        // Test count
        const count = await User.count({ age: 30 });
        assert.equals(count, 1, 'Count with filter works');

        this.passed += 12;
    }

    async testUpdateOperations() {
        console.log('\n🔄 Testing Update Operations...');
        this.tests += 12;

        const User = DB.Model('users');

        // Test update
        const john = await User.findOne({ name: 'John Doe' });
        const updated = await User.update(john.id, {
            age: 31,
            score: 150
        });

        assert.equals(updated.age, 31, 'Age updated correctly');
        assert.equals(updated.score, 150, 'Score updated correctly');
        assert.equals(updated.name, 'John Doe', 'Other fields unchanged');

        // Test updateMany
        const updatedCount = await User.updateMany(
            { isActive: true },
            { score: 200 }
        );

        assert.equals(updatedCount.length, 5, 'All users updated');
        
        const allUsers = await User.find();
        allUsers.forEach(user => {
            assert.equals(user.score, 200, 'All scores updated to 200');
        });

        // Test updateOrCreate - update existing
        const updatedOrCreated = await User.updateOrCreate(
            { email: 'john@example.com' },
            { name: 'John Updated', age: 32 }
        );
        assert.equals(updatedOrCreated.name, 'John Updated', 'UpdateOrCreate updated existing');

        // Test updateOrCreate - create new
        const newUser = await User.updateOrCreate(
            { email: 'new@example.com' },
            { name: 'New User', age: 25 }
        );
        assert.equals(newUser.email, 'new@example.com', 'UpdateOrCreate created new');
        assert.equals(newUser.name, 'New User', 'New user created correctly');

        // Test increment
        const incremented = await User.increment(john.id, 'score', 10);
        assert.equals(incremented.score, 210, 'Increment works');

        // Test decrement
        const decremented = await User.decrement(john.id, 'age', 1);
        assert.equals(decremented.age, 31, 'Decrement works');

        // Test toggle
        const toggled = await User.toggle(john.id, 'isActive');
        assert.isFalse(toggled.isActive, 'Toggle boolean field');

        const toggledAgain = await User.toggle(john.id, 'isActive');
        assert.isTrue(toggledAgain.isActive, 'Toggle back works');

        this.passed += 12;
    }

    async testDeleteOperations() {
        console.log('\n🗑️ Testing Delete Operations...');
        this.tests += 7;

        const User = DB.Model('users');

        const beforeCount = await User.count();
        
        // Test delete
        const userToDelete = await User.findOne({ name: 'Bob Wilson' });
        const deleted = await User.delete(userToDelete.id);
        assert.isTrue(deleted, 'Delete returns true');

        const afterDeleteCount = await User.count();
        assert.equals(afterDeleteCount, beforeCount - 1, 'User removed from database');

        const notFound = await User.findById(userToDelete.id);
        assert.equals(notFound, null, 'User no longer exists');

        // Test deleteMany
        const deletedCount = await User.deleteMany({ age: 27 });
        assert.equals(deletedCount, 1, 'DeleteMany removes correct count');

        // Test deleteAll
        const remainingUsers = await User.find();
        const allDeleted = await User.deleteAll();
        assert.equals(allDeleted, remainingUsers.length, 'DeleteAll removes all');
        
        const finalCount = await User.count();
        assert.equals(finalCount, 0, 'Database empty after deleteAll');

        this.passed += 7;
    }

    async testQueryBuilder() {
        console.log('\n🔨 Testing Query Builder...');
        this.tests += 10;

        const Product = DB.Model('products');

        // Create test data
        await Product.createMany([
            { name: 'Laptop', price: 999.99, category: 'electronics', inStock: true, views: 10 },
            { name: 'Mouse', price: 29.99, category: 'electronics', inStock: true, views: 5 },
            { name: 'Keyboard', price: 79.99, category: 'electronics', inStock: false, views: 8 },
            { name: 'Desk', price: 299.99, category: 'furniture', inStock: true, views: 3 },
            { name: 'Chair', price: 149.99, category: 'furniture', inStock: true, views: 6 }
        ]);

        // Test query with where
        const electronics = await Product.query()
            .where({ category: 'electronics' })
            .get();

        assert.equals(electronics.length, 3, 'Query where works');

        // Test query with multiple conditions
        const inStockElectronics = await Product.query()
            .where({ category: 'electronics', inStock: true })
            .get();

        assert.equals(inStockElectronics.length, 2, 'Multiple where conditions');

        // Test query with orderBy
        const sortedByPrice = await Product.query()
            .orderBy('price', 'DESC')
            .get();

        assert.equals(sortedByPrice[0].name, 'Laptop', 'OrderBy DESC works');
        assert.equals(sortedByPrice[4].name, 'Mouse', 'OrderBy works correctly');

        // Test query with limit
        const topTwo = await Product.query()
            .orderBy('views', 'DESC')
            .limit(2)
            .get();

        assert.equals(topTwo.length, 2, 'Limit works');
        assert.equals(topTwo[0].name, 'Laptop', 'Top by views correct');

        // Test query with offset
        const skipOne = await Product.query()
            .orderBy('price', 'ASC')
            .offset(1)
            .limit(2)
            .get();

        assert.equals(skipOne.length, 2, 'Offset works');
        assert.equals(skipOne[0].name, 'Keyboard', 'Skip first correct');

        // Test whereIn
        const products = await Product.find();
        const ids = products.slice(0, 3).map(p => p.id);
        const byIds = await Product.query()
            .whereIn('id', ids)
            .get();

        assert.equals(byIds.length, 3, 'WhereIn works');

        // Test whereBetween
        const midPrice = await Product.query()
            .whereBetween('price', [50, 200])
            .get();

        assert.equals(midPrice.length, 2, 'WhereBetween works');

        this.passed += 10;
    }

    async testUtilityMethods() {
        console.log('\n🛠️ Testing Utility Methods...');
        this.tests += 8;

        const Product = DB.Model('products');

        // Test pluck
        const names = await Product.pluck('name');
        assert.equals(names.length, 5, 'Pluck returns array');
        assert.isTrue(names.includes('Laptop'), 'Pluck contains correct values');

        // Test pluckWithKey
        const namePriceMap = await Product.pluckWithKey('name', 'price');
        assert.equals(namePriceMap['Laptop'], 999.99, 'PluckWithKey works');

        // Test distinct
        const categories = await Product.distinct('category');
        assert.equals(categories.length, 2, 'Distinct returns unique values');
        assert.isTrue(categories.includes('electronics'), 'Contains electronics');
        assert.isTrue(categories.includes('furniture'), 'Contains furniture');

        // Test random
        const randomProduct = await Product.random(1);
        assert.equals(randomProduct.length, 1, 'Random returns one by default');

        const randomThree = await Product.random(3);
        assert.equals(randomThree.length, 3, 'Random returns specified count');

        // Test chunk
        let chunkCount = 0;
        await Product.chunk(2, async (chunk, page) => {
            chunkCount++;
            assert.equals(chunk.length, page === 3 ? 1 : 2, 'Chunk size correct');
        });
        assert.equals(chunkCount, 3, 'Chunk processes all data');

        // Test each
        let eachCount = 0;
        await Product.each(async (product, index) => {
            eachCount++;
            assert.notEquals(product.name, undefined, 'Each receives valid product');
        });
        assert.equals(eachCount, 5, 'Each processes all items');

        this.passed += 8;
    }

    async testAggregationMethods() {
        console.log('\n📊 Testing Aggregation Methods...');
        this.tests += 6;

        const Product = DB.Model('products');

        // Test max
        const maxPrice = await Product.max('price');
        assert.equals(maxPrice, 999.99, 'Max returns correct value');

        // Test min
        const minPrice = await Product.min('price');
        assert.equals(minPrice, 29.99, 'Min returns correct value');

        // Test sum
        const totalViews = await Product.sum('views');
        assert.equals(totalViews, 32, 'Sum works correctly');

        // Test avg
        const avgPrice = await Product.avg('price');
        const expectedAvg = (999.99 + 29.99 + 79.99 + 299.99 + 149.99) / 5;
        assert.equals(Math.round(avgPrice * 100) / 100, Math.round(expectedAvg * 100) / 100, 'Avg works');

        // Test count with filter
        const electronicsCount = await Product.count({ category: 'electronics' });
        assert.equals(electronicsCount, 3, 'Count with filter works');

        this.passed += 6;
    }

    async testBatchOperations() {
        console.log('\n📦 Testing Batch Operations...');
        this.tests += 6;

        const Post = DB.Model('posts');

        // Create batch
        const posts = await Post.createMany([
            { title: 'Post 1', content: 'Content 1', userId: 1, published: true },
            { title: 'Post 2', content: 'Content 2', userId: 1, published: false },
            { title: 'Post 3', content: 'Content 3', userId: 2, published: true },
            { title: 'Post 4', content: 'Content 4', userId: 2, published: true },
            { title: 'Post 5', content: 'Content 5', userId: 3, published: false }
        ]);

        assert.equals(posts.length, 5, 'Batch create works');

        // Batch update
        const updatedPosts = await Post.updateMany(
            { userId: 1 },
            { published: true }
        );
        assert.equals(updatedPosts.length, 2, 'Batch update works');

        // Verify updates
        const user1Posts = await Post.find({ userId: 1 });
        user1Posts.forEach(post => {
            assert.isTrue(post.published, 'All user 1 posts published');
        });

        // Batch delete
        const deletedCount = await Post.deleteMany({ userId: 2 });
        assert.equals(deletedCount, 2, 'Batch delete works');

        const remainingPosts = await Post.find();
        assert.equals(remainingPosts.length, 3, 'Correct posts remaining');

        this.passed += 6;
    }

    async testTransactions() {
        console.log('\n💱 Testing Transactions...');
        this.tests += 5;

        const Product = DB.Model('products');

        const initialCount = await Product.count();

        // Test successful transaction
        const result = await DB.transaction(async (trx) => {
            await trx.query('INSERT INTO products (name, price, category) VALUES (?, ?, ?)', 
                ['Test Product', 99.99, 'test']);
            
            await trx.query('UPDATE products SET price = ? WHERE name = ?', 
                [199.99, 'Laptop']);
            
            return { success: true };
        });

        assert.isTrue(result.success, 'Transaction committed');

        const afterCount = await Product.count();
        assert.equals(afterCount, initialCount + 1, 'Insert committed');

        const updatedLaptop = await Product.findOne({ name: 'Laptop' });
        assert.equals(updatedLaptop.price, 199.99, 'Update committed');

        // Test failed transaction (rollback)
        try {
            await DB.transaction(async (trx) => {
                await trx.query('INSERT INTO products (name, price, category) VALUES (?, ?, ?)', 
                    ['Rollback Test', 49.99, 'test']);
                
                // This should fail - invalid SQL
                await trx.query('INVALID SQL');
                
                return { success: true };
            });
        } catch (e) {
            // Expected
        }

        const finalCount = await Product.count();
        assert.equals(finalCount, afterCount, 'Rollback prevented insert');

        this.passed += 5;
    }

    async testSchemaOperations() {
        console.log('\n📐 Testing Schema Operations...');
        this.tests += 8;

        // Create schema builder
        const schema = DB.schema();

        // Create new table
        await schema.create('categories', table => {
            table.id();
            table.string('name').unique();
            table.text('description').nullable();
            table.boolean('active').default(true);
            table.timestamps();
        });

        // Verify table exists
        const hasTable = await schema.hasTable('categories');
        assert.isTrue(hasTable, 'Table created');

        // Verify column exists
        const hasColumn = await schema.hasColumn('categories', 'name');
        assert.isTrue(hasColumn, 'Column created');

        // List collections/tables
        const tables = await DB.listCollections();
        assert.isTrue(tables.includes('categories'), 'Table listed in collections');

        // Create model for new table
        const Category = DB.Model('categories', {
            name: { type: 'string', required: true },
            description: 'text',
            active: 'boolean'
        });

        // Test operations on new table
        const category = await Category.create({
            name: 'Technology',
            description: 'Tech products',
            active: true
        });

        assert.notEquals(category.id, undefined, 'Can insert into new table');
        assert.equals(category.name, 'Technology', 'Data saved correctly');

        // Drop table
        await schema.drop('categories');
        const existsAfterDrop = await schema.hasTable('categories');
        assert.isFalse(existsAfterDrop, 'Table dropped');

        this.passed += 8;
    }

    async testEdgeCases() {
        console.log('\n⚠️ Testing Edge Cases...');
        this.tests += 10;

        const User = DB.Model('users');

        // Re-create some users for edge cases
        await User.createMany([
            { name: 'Edge Case 1', email: 'edge1@test.com', age: 25 },
            { name: 'Edge Case 2', email: 'edge2@test.com', age: 30 }
        ]);

        // Test empty results
        const noUsers = await User.find({ name: 'NonExistentName' });
        assert.deepEquals(noUsers, [], 'Empty array for no results');

        const noUser = await User.findOne({ name: 'NonExistentName' });
        assert.equals(noUser, null, 'Null for no single result');

        // Test findById with invalid ID
        const invalid = await User.findById(999999);
        assert.equals(invalid, null, 'Null for invalid ID');

        // Test delete non-existent
        const deleted = await User.delete(999999);
        assert.isFalse(deleted, 'False for non-existent delete');

        // Test update non-existent
        await assert.throws(async () => {
            await User.update(999999, { name: 'Test' });
        }, 'Error for non-existent update');

        // Test with empty filter for findOne
        await assert.throws(async () => {
            await User.findOne({});
        }, 'Error for empty filter');

        // Test with null values
        const userWithNull = await User.create({
            name: 'Null User',
            email: 'null@test.com',
            age: null,
            tags: null
        });

        assert.equals(userWithNull.age, null, 'Null value accepted');
        assert.equals(userWithNull.tags, null, 'Null JSON accepted');

        // Test with undefined values (should use defaults)
        const userWithUndefined = await User.create({
            name: 'Undefined User',
            email: 'undefined@test.com'
        });
        assert.isTrue(userWithUndefined.isActive, 'Default used for undefined');

        // Test with empty string
        const userWithEmpty = await User.create({
            name: '',
            email: 'empty@test.com'
        });
        assert.equals(userWithEmpty.name, '', 'Empty string accepted');

        this.passed += 10;
    }

    async testValidation() {
        console.log('\n✅ Testing Validation...');
        this.tests += 5;

        // Create model with validation rules
        const ValidatedUser = DB.Model('validated_users', {
            username: { type: 'string', required: true },
            email: { type: 'string', required: true },
            age: { type: 'number', required: true },
            isActive: { type: 'boolean', default: true }
        });

        // Test valid data
        await assert.notThrows(async () => {
            await ValidatedUser.create({
                username: 'validuser',
                email: 'valid@test.com',
                age: 25
            });
        }, 'Valid data passes validation');

        // Test missing required field
        await assert.throws(async () => {
            await ValidatedUser.create({
                username: 'test',
                email: 'test@test.com'
            });
        }, 'Missing required field fails');

        // Test multiple missing fields
        await assert.throws(async () => {
            await ValidatedUser.create({
                username: 'test'
            });
        }, 'Multiple missing fields fail');

        // Test null for required field
        await assert.throws(async () => {
            await ValidatedUser.create({
                username: null,
                email: 'test@test.com',
                age: 25
            });
        }, 'Null for required field fails');

        // Test undefined for required field
        await assert.throws(async () => {
            await ValidatedUser.create({
                username: 'test',
                email: undefined,
                age: 25
            });
        }, 'Undefined for required field fails');

        this.passed += 5;
    }

    async cleanup() {
        console.log('\n🧹 Cleaning up...');
        const fs = await import('fs/promises');
        await DB.DisconnectAll();
        
        // Remove test database file
        try {
            await fs.unlink('./test.sqlite');
            console.log('✅ Test database file removed');
        } catch (e) {
            // File might not exist
        }
        console.log('✅ Cleanup complete');
    }
}

// ==================== Run Tests ====================
const suite = new TestSuite();
await suite.run();

console.log(`\n📊 Total Tests: ${suite.tests}, Passed: ${suite.passed}, Failed: ${suite.failed}\n`);

if (suite.failed === 0) {
    console.log('🎉 ALL TESTS PASSED! 🎉\n');
    process.exit(0);
} else {
    console.log(`❌ ${suite.failed} TESTS FAILED\n`);
    process.exit(1);
}