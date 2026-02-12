import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import net from 'net';

class ConfigManager {
    static configPath = path.join(process.cwd(), 'config.json');

    static loadConfig() {
        // Check if the config file exists
        if (!fs.existsSync(this.configPath)) {
            return {};
        } else {
            // If it exists, load and return the config object
            return JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
        }
    }

    static getConfig() {
        return this.loadConfig();
    }

    static updateConfig(newConfig) {
        // Read the existing config, merge with newConfig, and write back
        const config = this.loadConfig();
        const updatedConfig = { ...config, ...newConfig };
        fs.writeFileSync(this.configPath, JSON.stringify(updatedConfig, null, 2));  // Pretty print JSON
        return updatedConfig;
    }

    static setKey(key, value) {
        // Set a specific key-value pair in the config
        const config = this.loadConfig();
        config[key] = value;
        fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2));  // Pretty print JSON
    }

    static getKey(key) {
        // Get a specific value by key from the config
        const config = this.loadConfig();
        return config[key];
    }

    static deleteKey(key) {
        // Delete a specific key-value pair from the config
        const config = this.loadConfig();
        delete config[key];
        fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2));  // Pretty print JSON
    }

    static getAllKeys() {
        // Return an array of all keys in the config
        const config = this.loadConfig();
        return Object.keys(config);
    }
}

class LogMaster {
    static logFilePath = path.join(process.cwd(), 'log.json');
    static tempLogFilePath = path.join(process.cwd(), 'templog.json');
    static hudSocketPath = process.platform === 'win32' ? '\\\\.\\pipe\\logmaster' : '/tmp/logmaster.sock';
    static eventEmitter = new EventEmitter();
    static isWatching = false;
    static activeTypeFilter = null;
    static socket = null;

    static ensureLogFileExists() {
        if (!fs.existsSync(this.logFilePath)) {
            fs.writeFileSync(this.logFilePath, '[]', 'utf-8');
        }
    }

    /**
     * Creates a log entry with optional status mode for refreshing instances
     * @param {string} type - The type/category of the log
     * @param {*} eventContent - The content of the log event
     * @param {Object} [config] - Configuration options for logging
     * @param {boolean} [config.statusMode=false] - If true, refreshes existing log of same type instead of creating new instance
     * @example
     * // Regular log entry
     * LogMaster.Log('error', 'User not found');
     * 
     * // Status mode log that refreshes/updates existing entry
     * LogMaster.Log('system_status', { cpu: 45, memory: 80 }, { statusMode: true });
     * LogMaster.Log('system_status', { cpu: 50, memory: 75 }, { statusMode: true }); // Updates previous entry
     */
    static Log(type, eventContent, config = {}) {
        const timestamp = Date.now();
        const date = new Date(timestamp).toLocaleString('pt-BR', {
            timeZone: 'UTC',
            hour12: false,
        });
    
        const logEntry = {
            TimeStamp: timestamp,
            Date: date,
            Type: type,
            EventContent: eventContent,
        };
    
        const writeToSocket = new Promise((resolve) => {
            const client = net.createConnection(this.hudSocketPath, () => {
                client.write(JSON.stringify(logEntry));
                client.end();
                resolve(true);
            });
    
            client.on('error', () => {
                resolve(false);
            });
        });
    
        const writeToFile = () => {
            const shouldLog = ConfigManager.getKey('log');
            if (!shouldLog) return;
    
            this.ensureLogFileExists();
    
            let logs = [];
            if (fs.existsSync(this.logFilePath)) {
                logs = JSON.parse(fs.readFileSync(this.logFilePath, 'utf-8'));
            }
    
            // Handle status mode - update existing log of same type instead of adding new
            if (config.statusMode) {
                const existingIndex = logs.findIndex(log => log.Type === type);
                
                if (existingIndex !== -1) {
                    // Replace existing log entry
                    logs[existingIndex] = logEntry;
                } else {
                    // Add new log entry if no existing one found
                    logs.push(logEntry);
                }
            } else {
                // Regular mode - always add new log entry
                logs.push(logEntry);
            }
    
            fs.writeFileSync(this.logFilePath, JSON.stringify(logs, null, 4), 'utf-8');
        };
    
        writeToSocket.finally(() => {
            writeToFile();
        });
    }

    /**
     * Retrieves logs with various filtering and pagination options
     * @param {Object} options - Configuration options for log retrieval
     * @param {string} [options.type] - Filter logs by specific type
     * @param {string} [options.search] - Search term to filter logs
     * @param {number} [options.limit] - Number of logs to return
     * @param {boolean} [options.reverse=false] - If true, returns logs from newest to oldest
     * @param {number} [options.offset=0] - Number of logs to skip (for pagination)
     * @param {Date} [options.startDate] - Start date for date range filtering
     * @param {Date} [options.endDate] - End date for date range filtering
     * @param {boolean} [options.includeStatusLogs=true] - Include status mode logs in results
     * @returns {Array} Array of log entries matching the criteria
     * @example
     * // Get last 10 logs of type "error"
     * const logs = LogMaster.getLogs({ type: "error", limit: 10, reverse: true });
     * 
     * // Get first 5 logs containing "user" with pagination
     * const logs = LogMaster.getLogs({ search: "user", limit: 5, offset: 0 });
     * 
     * // Get logs from specific date range
     * const startDate = new Date('2024-01-01');
     * const endDate = new Date('2024-01-31');
     * const logs = LogMaster.getLogs({ startDate, endDate });
     */
    static getLogs(options = {}) {
        this.ensureLogFileExists();
        
        let logs = [];
        try {
            if (fs.existsSync(this.logFilePath)) {
                const fileContent = fs.readFileSync(this.logFilePath, 'utf-8').trim();
                
                // Handle empty file
                if (!fileContent) {
                    logs = [];
                } else {
                    logs = JSON.parse(fileContent);
                }
                
                // Ensure logs is always an array
                if (!Array.isArray(logs)) {
                    console.warn('Log file contained non-array data, resetting to empty array');
                    logs = [];
                    // Optionally fix the file
                    fs.writeFileSync(this.logFilePath, '[]', 'utf-8');
                }
            }
        } catch (error) {
            console.error('Error reading log file:', error.message);
            console.log('Resetting log file to empty array');
            logs = [];
            // Reset the file to avoid future errors
            fs.writeFileSync(this.logFilePath, '[]', 'utf-8');
        }
    
        // Rest of your existing filtering code...
        let filteredLogs = logs;
    
        if (options.type) {
            filteredLogs = filteredLogs.filter(log => log.Type === options.type);
        }
    
        if (options.search) {
            const searchTerm = options.search.toLowerCase();
            filteredLogs = filteredLogs.filter(log => 
                JSON.stringify(log).toLowerCase().includes(searchTerm)
            );
        }
    
        if (options.startDate || options.endDate) {
            filteredLogs = filteredLogs.filter(log => {
                const logDate = new Date(log.TimeStamp);
                let valid = true;
                
                if (options.startDate) {
                    valid = valid && logDate >= options.startDate;
                }
                
                if (options.endDate) {
                    valid = valid && logDate <= options.endDate;
                }
                
                return valid;
            });
        }
    
        if (options.reverse) {
            filteredLogs = filteredLogs.reverse();
        }
    
        const offset = options.offset || 0;
        const limit = options.limit || filteredLogs.length;
        
        return filteredLogs.slice(offset, offset + limit);
    }

    /**
     * Gets the latest status log for a specific type
     * @param {string} type - The log type to retrieve status for
     * @returns {Object|null} The latest status log entry or null if not found
     * @example
     * const systemStatus = LogMaster.getStatusLog('system_status');
     * console.log(systemStatus?.EventContent); // { cpu: 50, memory: 75 }
     */
    static getStatusLog(type) {
        const logs = this.getLogs({ type, reverse: true, limit: 1 });
        return logs.length > 0 ? logs[0] : null;
    }

    /**
     * Clears all status logs of a specific type
     * @param {string} type - The log type to clear
     * @returns {boolean} True if logs were cleared, false otherwise
     * @example
     * LogMaster.clearStatusLogs('system_status');
     */
    static clearStatusLogs(type) {
        this.ensureLogFileExists();
        
        let logs = [];
        if (fs.existsSync(this.logFilePath)) {
            logs = JSON.parse(fs.readFileSync(this.logFilePath, 'utf-8'));
        }

        const initialLength = logs.length;
        logs = logs.filter(log => log.Type !== type);
        
        if (logs.length !== initialLength) {
            fs.writeFileSync(this.logFilePath, JSON.stringify(logs, null, 4), 'utf-8');
            return true;
        }
        
        return false;
    }

    static startHUD() {
        if (fs.existsSync(this.hudSocketPath)) {
            fs.unlinkSync(this.hudSocketPath);
        }

        const server = net.createServer((socket) => {
            this.socket = socket;
            socket.on('data', (data) => {
                const logEntry = JSON.parse(data.toString());
                if (this.isWatching) {
                    if (!this.activeTypeFilter || logEntry.Type === this.activeTypeFilter) {
                        this.displayLog(logEntry);
                    }
                }
            });
        });

        server.listen(this.hudSocketPath, () => {
            console.log('HUD watcher started. Listening for logs...');
            this.displayHUDMenu();
        });

        server.on('error', (err) => {
            console.error('Failed to start HUD watcher:', err);
        });

        process.on('exit', () => {
            if (fs.existsSync(this.hudSocketPath)) {
                fs.unlinkSync(this.hudSocketPath);
            }
        });

        process.on('SIGINT', () => process.exit());
        process.on('SIGTERM', () => process.exit());
    }

    static enterWatchMode() {
        console.clear();
        console.log('Entering Watch Mode. Press "q" to return to the main menu.');

        this.isWatching = true;
        const handleKeyPress = (chunk) => {
            if (chunk.trim() === 'q') {
                process.stdin.removeListener('data', handleKeyPress);
                this.isWatching = false;
                if (this.socket) {
                    this.socket.removeAllListeners('data');
                }
                this.displayHUDMenu();
            }
        };

        process.stdin.on('data', handleKeyPress);
    }

    static displayHUDMenu() {
        console.clear();
        console.log('LogMaster HUD Menu');
        console.log('1. View all log types');
        console.log('2. Search logs by term');
        console.log('3. Set real-time filter by type');
        console.log('4. Clear real-time filter');
        console.log('5. Enter Watch Mode');
        console.log('6. View logs with filters');
        console.log('7. View status logs');
        console.log('8. Exit HUD');

        process.stdin.resume();
        process.stdin.setEncoding('utf8');

        const handleMenuChoice = (input) => {
            const choice = input.trim();

            switch (choice) {
                case '1':
                    this.displayLogTypes();
                    break;
                case '2':
                    this.promptSearchTerm();
                    break;
                case '3':
                    this.promptSetFilter();
                    break;
                case '4':
                    this.clearFilter();
                    break;
                case '5':
                    this.enterWatchMode();
                    break;
                case '6':
                    this.promptAdvancedFilters();
                    break;
                case '7':
                    this.displayStatusLogs();
                    break;
                case '8':
                    process.exit();
                    break;
                default:
                    console.log('Invalid choice. Please select a valid option.');
                    this.displayHUDMenu();
            }
        };

        process.stdin.once('data', handleMenuChoice);
    }

    static displayLogTypes() {
        this.ensureLogFileExists();
        const logs = JSON.parse(fs.readFileSync(this.logFilePath, 'utf-8'));
        const types = [...new Set(logs.map(log => log.Type))];

        console.log('Available Log Types:');
        types.forEach((type, index) => {
            console.log(`${index + 1}. ${type}`);
        });

        console.log('Select a type by number to view logs or press Enter to return to menu.');

        const handleTypeSelection = (input) => {
            const choice = parseInt(input.trim(), 10);

            if (choice >= 1 && choice <= types.length) {
                const selectedType = types[choice - 1];
                const filteredLogs = this.getLogs({ type: selectedType });
                console.log(`Logs of type "${selectedType}":`, filteredLogs);
            } else {
                console.log('Invalid choice. Returning to menu.');
                this.displayHUDMenu();
                return;
            }

            console.log('Press any key to return to the main menu.');
            process.stdin.once('data', () => this.displayHUDMenu());
        };

        process.stdin.once('data', handleTypeSelection);
    }

    static promptSearchTerm() {
        console.log('Enter a search term:');

        const handleSearchTerm = (input) => {
            const searchTerm = input.trim();
            const filteredLogs = this.getLogs({ search: searchTerm });

            console.log(`Logs containing "${searchTerm}":`, filteredLogs);

            console.log('Press any key to return to the main menu.');
            process.stdin.once('data', () => this.displayHUDMenu());
        };

        process.stdin.once('data', handleSearchTerm);
    }

    static promptAdvancedFilters() {
        console.log('Advanced Log Filtering');
        console.log('Enter filter options as JSON (or press Enter for all logs):');
        console.log('Example: {"type": "error", "limit": 10, "reverse": true}');

        const handleFilterInput = (input) => {
            try {
                const options = input.trim() ? JSON.parse(input.trim()) : {};
                const filteredLogs = this.getLogs(options);
                
                console.log(`Found ${filteredLogs.length} logs:`);
                console.log(filteredLogs);

                console.log('Press any key to return to the main menu.');
                process.stdin.once('data', () => this.displayHUDMenu());
            } catch (error) {
                console.log('Invalid JSON format. Please try again.');
                this.promptAdvancedFilters();
            }
        };

        process.stdin.once('data', handleFilterInput);
    }

    static displayStatusLogs() {
        console.log('Current Status Logs:');
        
        this.ensureLogFileExists();
        const logs = JSON.parse(fs.readFileSync(this.logFilePath, 'utf-8'));
        
        // Find types that have status logs (latest entry for each type)
        const statusLogs = {};
        logs.forEach(log => {
            statusLogs[log.Type] = log; // This will keep only the latest due to iteration order
        });

        const statusEntries = Object.values(statusLogs);
        
        if (statusEntries.length === 0) {
            console.log('No status logs found.');
        } else {
            statusEntries.forEach(log => {
                this.displayLog(log);
                console.log(''); // Add spacing between logs
            });
        }

        console.log('Press any key to return to the main menu.');
        process.stdin.once('data', () => this.displayHUDMenu());
    }

    static promptSetFilter() {
        console.log('Enter the type to filter by in real-time:');

        const handleSetFilter = (input) => {
            this.activeTypeFilter = input.trim();
            console.log(`Real-time filter set to type "${this.activeTypeFilter}".`);
            this.displayHUDMenu();
        };

        process.stdin.once('data', handleSetFilter);
    }

    static clearFilter() {
        this.activeTypeFilter = null;
        console.log('Real-time filter cleared. Displaying all logs.');
        this.displayHUDMenu();
    }

    static displayLog(logEntry) {
        const boxLines = [
            '┌────────────────────────────────────────────────────────┐',
            `│ Date: ${logEntry.Date.padEnd(47)} │`,
            `│ Type: ${logEntry.Type.padEnd(47)} │`,
            '├────────────────────────────────────────────────────────┤',
        ];

        const simplifiedContent = this.simplifyContent(logEntry.EventContent);
        Object.entries(simplifiedContent).forEach(([key, value]) => {
            const line = `│ ${key}: ${String(value).slice(0, 40).padEnd(40)} │`;
            boxLines.push(line);
        });

        boxLines.push('└────────────────────────────────────────────────────────┘');
        console.log(boxLines.join('\n'));
    }

    static simplifyContent(content) {
        if (typeof content === 'object' && content !== null) {
            if (Array.isArray(content)) {
                return '[ARRAY]';
            } else {
                const simplified = {};
                for (const [key, value] of Object.entries(content)) {
                    if (typeof value === 'object') {
                        simplified[key] = '[OBJECT]';
                    } else {
                        simplified[key] = String(value).slice(0, 30);
                    }
                }
                return simplified;
            }
        } else if (typeof content === 'string') {
            return content.slice(0, 50) + (content.length > 50 ? '...' : '');
        } else {
            return String(content);
        }
    }

    // Command line interface when run directly
    static async runCLI() {
        if (process.argv.length > 2) {
            const command = process.argv[2];
            
            switch (command) {
                case 'view':
                    await this.handleViewCommand();
                    break;
                case 'hud':
                    this.startHUD();
                    break;
                case 'types':
                    this.displayAvailableTypes();
                    break;
                case 'status':
                    await this.handleStatusCommand();
                    break;
                case 'help':
                    this.displayHelp();
                    break;
                default:
                    console.log('Unknown command. Use "help" to see available commands.');
                    process.exit(1);
            }
        } else {
            this.displayHelp();
        }
    }

    static async handleViewCommand() {
        const options = {};
        
        for (let i = 3; i < process.argv.length; i++) {
            const arg = process.argv[i];
            
            if (arg === '--type' && process.argv[i + 1]) {
                options.type = process.argv[++i];
            } else if (arg === '--search' && process.argv[i + 1]) {
                options.search = process.argv[++i];
            } else if (arg === '--limit' && process.argv[i + 1]) {
                options.limit = parseInt(process.argv[++i]);
            } else if (arg === '--reverse') {
                options.reverse = true;
            } else if (arg === '--offset' && process.argv[i + 1]) {
                options.offset = parseInt(process.argv[++i]);
            }
        }
        
        const logs = this.getLogs(options);
        console.log(JSON.stringify(logs, null, 2));
    }

    static async handleStatusCommand() {
        const type = process.argv[3]; // Get type from command line
        
        if (type) {
            // Get specific status log
            const statusLog = this.getStatusLog(type);
            if (statusLog) {
                console.log(JSON.stringify(statusLog, null, 2));
            } else {
                console.log(`No status log found for type: ${type}`);
            }
        } else {
            // Show all status logs
            this.ensureLogFileExists();
            const logs = JSON.parse(fs.readFileSync(this.logFilePath, 'utf-8'));
            
            const statusLogs = {};
            logs.forEach(log => {
                statusLogs[log.Type] = log;
            });

            const statusEntries = Object.values(statusLogs);
            console.log(JSON.stringify(statusEntries, null, 2));
        }
    }

    static displayAvailableTypes() {
        this.ensureLogFileExists();
        const logs = JSON.parse(fs.readFileSync(this.logFilePath, 'utf-8'));
        const types = [...new Set(logs.map(log => log.Type))];
        
        console.log('Available log types:');
        types.forEach(type => console.log(`- ${type}`));
    }

    static displayHelp() {
        console.log(`
LogMaster CLI Usage:

Commands:
  view [options]        - View logs with filters
  hud                   - Start the HUD interface
  types                 - List all available log types
  status [type]         - View status logs (all or specific type)
  help                  - Show this help message

View Options:
  --type <type>         - Filter by log type
  --search <term>       - Search for term in logs
  --limit <number>      - Limit number of results
  --reverse             - Show newest first
  --offset <number>     - Skip number of results

Status Mode Usage (in code):
  LogMaster.Log('type', content, { statusMode: true });

Examples:
  node LogMaster.js view --type error --limit 10
  node LogMaster.js view --search "user" --reverse
  node LogMaster.js status system_status
  node LogMaster.js status
  node LogMaster.js hud
  node LogMaster.js types
        `);
    }
}

// If this file is run directly, execute the CLI
if (import.meta.url === `file://${process.argv[1]}`) {
    LogMaster.runCLI().catch(console.error);
}

export default LogMaster;