import C from "./C.js"
import SyPM from "./SyPM.js"

/**
 * SYDB Database Management System
 * High-performance database system with HTTP API interface
 * @class SyDB
 */
class SyDB {
    static #serverStarted = false
    static #serverStarting = false
    static #baseUrl = 'http://localhost:8080'
    static #startTimeout = 2000 // 2 seconds

    /**
     * Start the SYDB HTTP server
     * @static
     * @async
     * @returns {Promise<boolean>} True if server started successfully
     */
    static async Start() {
        if (this.#serverStarted) return true
        if (this.#serverStarting) {
            // Wait for server to finish starting
            await new Promise(resolve => setTimeout(resolve, 1000))
            return this.#serverStarted
        }

        this.#serverStarting = true
        
        try {
            await SyPM.run(`import C from "./core/C.js"

                console.log("Starting SYDB HTTP Server...")
                
             console.log(await C.run('./core/interfaces/SyDB/SyDB.c',{args : ['--server']}))
                `,{workingDir : process.cwd()})
            
            this.#serverStarted = true
            this.#serverStarting = false
            console.log('SYDB Server started successfully')
            return true
        } catch (error) {
            this.#serverStarting = false
            console.error('Failed to start SYDB Server:', error.message)
            return false
        }
    }

    /**
     * Make HTTP request to SYDB server with automatic server start on connection error
     * @static
     * @async
     * @param {string} method - HTTP method
     * @param {string} endpoint - API endpoint
     * @param {Object} [data] - Request data
     * @param {boolean} [retryOnServerDown=true] - Retry if server is down
     * @returns {Promise<Object>} Response data
     */
    static async #makeRequest(method, endpoint, data = null, retryOnServerDown = true) {
        const url = `${this.#baseUrl}${endpoint}`
        const options = {
            method,
            headers: {
                'Content-Type': 'application/json',
            }
        }

        if (data && (method === 'POST' || method === 'PUT')) {
            options.body = JSON.stringify(data)
        }

        try {
            const response = await fetch(url, options)
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`)
            }
            
            return await response.json()
        } catch (error) {
            // Special handling for server not started error
            if (retryOnServerDown && (error.code === 'ECONNREFUSED' || error.message.includes('fetch failed'))) {
                console.log('SYDB Server not running, attempting to start...')
                
                const started = await this.Start()
                if (started) {
                    console.log('Waiting for server to be ready...')
                    await new Promise(resolve => setTimeout(resolve, this.#startTimeout))
                    
                    // Retry the request once
                    return await this.#makeRequest(method, endpoint, data, false)
                }
            }
            
            // If we get here, either retry is disabled or server failed to start
            return {
                success: false,
                error: `Request failed: ${error.message}`,
                serverStatus: this.#serverStarted ? 'running' : 'stopped'
            }
        }
    }

    /**
     * List all databases
     * @static
     * @async
     * @returns {Promise<Object>} List of databases
     */
    static async listDatabases() {
        return await this.#makeRequest('GET', '/api/databases')
    }

    /**
     * Create a new database
     * @static
     * @async
     * @param {string} name - Database name
     * @returns {Promise<Object>} Operation result
     */
    static async createDatabase(name) {
        if (!name || typeof name !== 'string') {
            return {
                success: false,
                error: 'Database name is required and must be a string'
            }
        }
        return await this.#makeRequest('POST', '/api/databases', { name })
    }

    /**
     * Delete a database
     * @static
     * @async
     * @param {string} name - Database name
     * @returns {Promise<Object>} Operation result
     */
    static async deleteDatabase(name) {
        if (!name || typeof name !== 'string') {
            return {
                success: false,
                error: 'Database name is required and must be a string'
            }
        }
        return await this.#makeRequest('DELETE', `/api/databases/${name}`)
    }

    /**
     * List all collections in a database
     * @static
     * @async
     * @param {string} databaseName - Database name
     * @returns {Promise<Object>} List of collections
     */
    static async listCollections(databaseName) {
        if (!databaseName || typeof databaseName !== 'string') {
            return {
                success: false,
                error: 'Database name is required and must be a string'
            }
        }
        return await this.#makeRequest('GET', `/api/databases/${databaseName}/collections`)
    }

    /**
     * Create a new collection with schema
     * @static
     * @async
     * @param {string} databaseName - Database name
     * @param {string} collectionName - Collection name
     * @param {Array} schema - Collection schema
     * @returns {Promise<Object>} Operation result
     */
    static async createCollection(databaseName, collectionName, schema) {
        if (!databaseName || typeof databaseName !== 'string') {
            return {
                success: false,
                error: 'Database name is required and must be a string'
            }
        }
        if (!collectionName || typeof collectionName !== 'string') {
            return {
                success: false,
                error: 'Collection name is required and must be a string'
            }
        }
        if (!Array.isArray(schema)) {
            return {
                success: false,
                error: 'Schema must be an array'
            }
        }

        return await this.#makeRequest('POST', `/api/databases/${databaseName}/collections`, {
            name: collectionName,
            schema: schema
        })
    }

    /**
     * Delete a collection
     * @static
     * @async
     * @param {string} databaseName - Database name
     * @param {string} collectionName - Collection name
     * @returns {Promise<Object>} Operation result
     */
    static async deleteCollection(databaseName, collectionName) {
        if (!databaseName || typeof databaseName !== 'string') {
            return {
                success: false,
                error: 'Database name is required and must be a string'
            }
        }
        if (!collectionName || typeof collectionName !== 'string') {
            return {
                success: false,
                error: 'Collection name is required and must be a string'
            }
        }
        return await this.#makeRequest('DELETE', `/api/databases/${databaseName}/collections/${collectionName}`)
    }

    /**
     * Get collection schema
     * @static
     * @async
     * @param {string} databaseName - Database name
     * @param {string} collectionName - Collection name
     * @returns {Promise<Object>} Collection schema
     */
    static async getCollectionSchema(databaseName, collectionName) {
        if (!databaseName || typeof databaseName !== 'string') {
            return {
                success: false,
                error: 'Database name is required and must be a string'
            }
        }
        if (!collectionName || typeof collectionName !== 'string') {
            return {
                success: false,
                error: 'Collection name is required and must be a string'
            }
        }
        return await this.#makeRequest('GET', `/api/databases/${databaseName}/collections/${collectionName}/schema`)
    }

    /**
     * List instances in a collection with optional query
     * @static
     * @async
     * @param {string} databaseName - Database name
     * @param {string} collectionName - Collection name
     * @param {string} [query] - Optional query string
     * @returns {Promise<Object>} List of instances
     */
    static async listInstances(databaseName, collectionName, query = '') {
        if (!databaseName || typeof databaseName !== 'string') {
            return {
                success: false,
                error: 'Database name is required and must be a string'
            }
        }
        if (!collectionName || typeof collectionName !== 'string') {
            return {
                success: false,
                error: 'Collection name is required and must be a string'
            }
        }

        const endpoint = query 
            ? `/api/databases/${databaseName}/collections/${collectionName}/instances?query=${encodeURIComponent(query)}`
            : `/api/databases/${databaseName}/collections/${collectionName}/instances`

        return await this.#makeRequest('GET', endpoint)
    }

    /**
     * Insert a new instance into a collection
     * @static
     * @async
     * @param {string} databaseName - Database name
     * @param {string} collectionName - Collection name
     * @param {Object} instanceData - Instance data
     * @returns {Promise<Object>} Operation result with instance ID
     */
    static async insertInstance(databaseName, collectionName, instanceData) {
        if (!databaseName || typeof databaseName !== 'string') {
            return {
                success: false,
                error: 'Database name is required and must be a string'
            }
        }
        if (!collectionName || typeof collectionName !== 'string') {
            return {
                success: false,
                error: 'Collection name is required and must be a string'
            }
        }
        if (!instanceData || typeof instanceData !== 'object') {
            return {
                success: false,
                error: 'Instance data is required and must be an object'
            }
        }

        return await this.#makeRequest('POST', 
            `/api/databases/${databaseName}/collections/${collectionName}/instances`, 
            instanceData
        )
    }

    /**
     * Update an existing instance
     * @static
     * @async
     * @param {string} databaseName - Database name
     * @param {string} collectionName - Collection name
     * @param {string} instanceId - Instance ID
     * @param {Object} updateData - Update data
     * @returns {Promise<Object>} Operation result
     */
    static async updateInstance(databaseName, collectionName, instanceId, updateData) {
        if (!databaseName || typeof databaseName !== 'string') {
            return {
                success: false,
                error: 'Database name is required and must be a string'
            }
        }
        if (!collectionName || typeof collectionName !== 'string') {
            return {
                success: false,
                error: 'Collection name is required and must be a string'
            }
        }
        if (!instanceId || typeof instanceId !== 'string') {
            return {
                success: false,
                error: 'Instance ID is required and must be a string'
            }
        }
        if (!updateData || typeof updateData !== 'object') {
            return {
                success: false,
                error: 'Update data is required and must be an object'
            }
        }

        return await this.#makeRequest('PUT', 
            `/api/databases/${databaseName}/collections/${collectionName}/instances/${instanceId}`,
            updateData
        )
    }

    /**
     * Delete an instance
     * @static
     * @async
     * @param {string} databaseName - Database name
     * @param {string} collectionName - Collection name
     * @param {string} instanceId - Instance ID
     * @returns {Promise<Object>} Operation result
     */
    static async deleteInstance(databaseName, collectionName, instanceId) {
        if (!databaseName || typeof databaseName !== 'string') {
            return {
                success: false,
                error: 'Database name is required and must be a string'
            }
        }
        if (!collectionName || typeof collectionName !== 'string') {
            return {
                success: false,
                error: 'Collection name is required and must be a string'
            }
        }
        if (!instanceId || typeof instanceId !== 'string') {
            return {
                success: false,
                error: 'Instance ID is required and must be a string'
            }
        }

        return await this.#makeRequest('DELETE', 
            `/api/databases/${databaseName}/collections/${collectionName}/instances/${instanceId}`
        )
    }

    /**
     * Execute SYDB commands
     * @static
     * @async
     * @param {string} command - SYDB command
     * @param {Array} [arguments] - Command arguments
     * @returns {Promise<Object>} Command result
     */
    static async executeCommand(command, args = []) {
        if (!command || typeof command !== 'string') {
            return {
                success: false,
                error: 'Command is required and must be a string'
            }
        }

        return await this.#makeRequest('POST', '/api/execute', {
            command: command,
            arguments: args
        })
    }

    /**
     * Display available HTTP routes and schemas
     * @static
     * @async
     * @returns {Promise<Object>} Routes information
     */
    static async showRoutes() {
        // This would execute the C binary with --routes flag
        try {
            const result = await C.run('./core/interfaces/SyDB/SyDB.c', { args: ['--routes'] })
            return {
                success: true,
                routes: result
            }
        } catch (error) {
            return {
                success: false,
                error: `Failed to show routes: ${error.message}`
            }
        }
    }

    /**
     * Check if server is running
     * @static
     * @returns {boolean} Server status
     */
    static isServerRunning() {
        return this.#serverStarted
    }
}

/**
 * Command Line Interface for SYDB
 */
class SyDBCLI {
    /**
     * Print usage information
     * @static
     */
    static printUsage() {
        console.log(`
SYDB Database Management System - JavaScript Client
Usage:
  node SyDB.js create <database_name>
  node SyDB.js create <database_name> <collection_name> --schema <schema_json>
  node SyDB.js create <database_name> <collection_name> --insert-one <instance_json>
  node SyDB.js update <database_name> <collection_name> <instance_id> <update_json>
  node SyDB.js delete <database_name> <collection_name> <instance_id>
  node SyDB.js find <database_name> <collection_name> [query]
  node SyDB.js schema <database_name> <collection_name>
  node SyDB.js list
  node SyDB.js list <database_name>
  node SyDB.js list <database_name> <collection_name>
  node SyDB.js --server [port]          # Start HTTP server (background)
  node SyDB.js --routes                 # Show all HTTP API routes and schemas
  node SyDB.js --status                 # Check server status

Examples:
  node SyDB.js create mydb
  node SyDB.js create mydb users --schema '[{"name":"username","type":"string","required":true}]'
  node SyDB.js create mydb users --insert-one '{"username":"john","age":30}'
  node SyDB.js find mydb users "age:30"
  node SyDB.js list mydb
        `)
    }

    /**
     * Parse JSON from command line argument
     * @static
     * @param {string} jsonString - JSON string
     * @returns {Object} Parsed JSON object
     */
    static parseJSONArgument(jsonString) {
        try {
            return JSON.parse(jsonString)
        } catch (error) {
            console.error('Error: Invalid JSON format')
            process.exit(1)
        }
    }

    /**
     * Execute CLI command
     * @static
     * @async
     * @param {Array} args - Command line arguments
     */
    static async executeCommand(args) {
        if (args.length < 2) {
            this.printUsage()
            process.exit(1)
        }

        const command = args[2]

        try {
            switch (command) {
                case 'create':
                    await this.handleCreate(args)
                    break
                case 'update':
                    await this.handleUpdate(args)
                    break
                case 'delete':
                    await this.handleDelete(args)
                    break
                case 'find':
                    await this.handleFind(args)
                    break
                case 'schema':
                    await this.handleSchema(args)
                    break
                case 'list':
                    await this.handleList(args)
                    break
                case '--server':
                    await this.handleServer(args)
                    break
                case '--routes':
                    await this.handleRoutes()
                    break
                case '--status':
                    await this.handleStatus()
                    break
                default:
                    console.error(`Error: Unknown command '${command}'`)
                    this.printUsage()
                    process.exit(1)
            }
        } catch (error) {
            console.error('Error:', error.message)
            process.exit(1)
        }
    }

    /**
     * Handle create command
     * @static
     * @async
     * @param {Array} args - Command arguments
     */
    static async handleCreate(args) {
        if (args.length < 4) {
            console.error('Error: Missing database name')
            this.printUsage()
            process.exit(1)
        }

        const databaseName = args[3]

        if (args.length === 4) {
            // Create database only
            const result = await SyDB.createDatabase(databaseName)
            console.log(JSON.stringify(result, null, 2))
        } else if (args.length >= 5) {
            const collectionName = args[4]
            
            if (args.length >= 6 && args[5] === '--schema') {
                // Create collection with schema
                if (args.length < 7) {
                    console.error('Error: Missing schema JSON')
                    this.printUsage()
                    process.exit(1)
                }
                const schema = this.parseJSONArgument(args[6])
                const result = await SyDB.createCollection(databaseName, collectionName, schema)
                console.log(JSON.stringify(result, null, 2))
            } else if (args.length >= 6 && args[5] === '--insert-one') {
                // Insert instance
                if (args.length < 7) {
                    console.error('Error: Missing instance JSON')
                    this.printUsage()
                    process.exit(1)
                }
                const instanceData = this.parseJSONArgument(args[6])
                const result = await SyDB.insertInstance(databaseName, collectionName, instanceData)
                console.log(JSON.stringify(result, null, 2))
            } else {
                console.error('Error: Invalid create operation')
                this.printUsage()
                process.exit(1)
            }
        }
    }

    /**
     * Handle update command
     * @static
     * @async
     * @param {Array} args - Command arguments
     */
    static async handleUpdate(args) {
        if (args.length < 7) {
            console.error('Error: Missing arguments for update')
            this.printUsage()
            process.exit(1)
        }

        const databaseName = args[3]
        const collectionName = args[4]
        const instanceId = args[5]
        const updateData = this.parseJSONArgument(args[6])

        const result = await SyDB.updateInstance(databaseName, collectionName, instanceId, updateData)
        console.log(JSON.stringify(result, null, 2))
    }

    /**
     * Handle delete command
     * @static
     * @async
     * @param {Array} args - Command arguments
     */
    static async handleDelete(args) {
        if (args.length < 6) {
            console.error('Error: Missing arguments for delete')
            this.printUsage()
            process.exit(1)
        }

        const databaseName = args[3]
        const collectionName = args[4]
        const instanceId = args[5]

        const result = await SyDB.deleteInstance(databaseName, collectionName, instanceId)
        console.log(JSON.stringify(result, null, 2))
    }

    /**
     * Handle find command
     * @static
     * @async
     * @param {Array} args - Command arguments
     */
    static async handleFind(args) {
        if (args.length < 5) {
            console.error('Error: Missing database or collection name')
            this.printUsage()
            process.exit(1)
        }

        const databaseName = args[3]
        const collectionName = args[4]
        const query = args[5] || ''

        const result = await SyDB.listInstances(databaseName, collectionName, query)
        console.log(JSON.stringify(result, null, 2))
    }

    /**
     * Handle schema command
     * @static
     * @async
     * @param {Array} args - Command arguments
     */
    static async handleSchema(args) {
        if (args.length < 5) {
            console.error('Error: Missing database or collection name')
            this.printUsage()
            process.exit(1)
        }

        const databaseName = args[3]
        const collectionName = args[4]

        const result = await SyDB.getCollectionSchema(databaseName, collectionName)
        console.log(JSON.stringify(result, null, 2))
    }

    /**
     * Handle list command
     * @static
     * @async
     * @param {Array} args - Command arguments
     */
    static async handleList(args) {
        if (args.length === 3) {
            // List databases
            const result = await SyDB.listDatabases()
            console.log(JSON.stringify(result, null, 2))
        } else if (args.length === 4) {
            // List collections in database
            const databaseName = args[3]
            const result = await SyDB.listCollections(databaseName)
            console.log(JSON.stringify(result, null, 2))
        } else if (args.length === 5) {
            // List instances in collection
            const databaseName = args[3]
            const collectionName = args[4]
            const result = await SyDB.listInstances(databaseName, collectionName)
            console.log(JSON.stringify(result, null, 2))
        } else {
            console.error('Error: Invalid list operation')
            this.printUsage()
            process.exit(1)
        }
    }

    /**
     * Handle server command - Start server in background using SyPM
     * @static
     * @async
     * @param {Array} args - Command arguments
     */
    static async handleServer(args) {
        console.log('Starting SYDB HTTP Server in background...')
        const port = args[3] || '8080'
        
        try {
            // Use SyPM to run the server in background (non-blocking)
            await SyPM.run(`import C from "./core/C.js"
                console.log("Starting SYDB HTTP Server on port ${port}...")
                console.log(await C.run('./core/interfaces/SyDB/SyDB.c',{args : ['--server', '${port}']}))
            `, { workingDir: process.cwd() })
            
            console.log('SYDB Server started successfully in background')
            console.log('Server is running independently - Node.js process will now exit')
            console.log('Use "node SyDB.js --status" to check server status')
            
        } catch (error) {
            console.error('Failed to start SYDB Server:', error.message)
            process.exit(1)
        }
    }

    /**
     * Handle routes command
     * @static
     * @async
     */
    static async handleRoutes() {
        const result = await SyDB.showRoutes()
        console.log(JSON.stringify(result, null, 2))
    }

    /**
     * Handle status command
     * @static
     * @async
     */
    static async handleStatus() {
        // Try to make a simple request to check if server is responsive
        try {
            const response = await fetch('http://localhost:8080/api/databases', {
                method: 'GET',
                timeout: 3000
            })
            const data = await response.json()
            console.log(JSON.stringify({
                server: 'running',
                responsive: true,
                timestamp: new Date().toISOString()
            }, null, 2))
        } catch (error) {
            console.log(JSON.stringify({
                server: 'stopped',
                responsive: false,
                error: error.message,
                timestamp: new Date().toISOString()
            }, null, 2))
        }
    }
}

// Command Line Interface execution
if (import.meta.url === `file://${process.argv[1]}`) {
    // This file was executed directly
    SyDBCLI.executeCommand(process.argv)
}

export default SyDB