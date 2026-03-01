import readline from 'readline';
import { stdin, stdout } from 'process';
import EventEmitter from 'events';
import { readFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import net from 'net';
import http from 'http'

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


const BuildPagination = (fullarray = [], items_per_page = 5) => {
  let pagination = [{
       page : 1,
       list : []
   }]
   pagination.splice(0,1)
   
   let object_model = {}
   let count = 0
   let type = typeof fullarray[0]
   

   fullarray.forEach((t,index) => {
       if (count == 0) {
           if(index == 0){
               type = typeof t
               if(typeof t == 'object'){
                   object_model = t
               }
           }
           if(typeof t == type){
               if(typeof t == 'object'){
                  let fullinclude = true
                  Object.keys(t).forEach(k => {
                      if(!Object.keys(object_model).includes(k)){
                          fullinclude = false
                      }
                  })
                   if(fullinclude){
                       pagination.push({ page: pagination.length + 1, list: [] })
                   pagination[pagination.length - 1].list.push(t)
                   count += 1
                   }
               } else {
                  pagination.push({ page: pagination.length + 1, list: [] })
                   pagination[pagination.length - 1].list.push(t)
                   count += 1
               }
               
           }
           
       } else {
           if(typeof t == type){
               if(typeof t == 'object'){
                  let fullinclude = true
                  Object.keys(t).forEach(k => {
                      if(!Object.keys(object_model).includes(k)){
                          fullinclude = false
                      }
                  })
                   if(fullinclude){
                   pagination[pagination.length - 1].list.push(t)
                   count += 1
                   }
               } else {
                   pagination[pagination.length - 1].list.push(t)
                   count += 1
               }
           }
       }
       
       if (count == items_per_page) { count = 0 }
   })
return pagination
}

class ColorText {
  // Standard 8/16 colors
  static black(text) {
    return `\x1b[30m${text}\x1b[0m`;
  }

  static red(text) {
    return `\x1b[31m${text}\x1b[0m`;
  }

  static green(text) {
    return `\x1b[32m${text}\x1b[0m`;
  }

  static yellow(text) {
    return `\x1b[33m${text}\x1b[0m`;
  }

  static blue(text) {
    return `\x1b[34m${text}\x1b[0m`;
  }

  static magenta(text) {
    return `\x1b[35m${text}\x1b[0m`;
  }

  static cyan(text) {
    return `\x1b[36m${text}\x1b[0m`;
  }

  static white(text) {
    return `\x1b[37m${text}\x1b[0m`;
  }

  // Bright/Vivid versions (90-97)
  static brightBlack(text) {
    return `\x1b[90m${text}\x1b[0m`;
  }

  static brightRed(text) {
    return `\x1b[91m${text}\x1b[0m`;
  }

  static brightGreen(text) {
    return `\x1b[92m${text}\x1b[0m`;
  }

  static brightYellow(text) {
    return `\x1b[93m${text}\x1b[0m`;
  }

  static brightBlue(text) {
    return `\x1b[94m${text}\x1b[0m`;
  }

  static brightMagenta(text) {
    return `\x1b[95m${text}\x1b[0m`;
  }

  static brightCyan(text) {
    return `\x1b[96m${text}\x1b[0m`;
  }

  static brightWhite(text) {
    return `\x1b[97m${text}\x1b[0m`;
  }

  // 256-color palette - Common colors
  static orange(text) {
    return `\x1b[38;5;208m${text}\x1b[0m`;
  }

  static pink(text) {
    return `\x1b[38;5;205m${text}\x1b[0m`;
  }

  static purple(text) {
    return `\x1b[38;5;129m${text}\x1b[0m`;
  }

  static brown(text) {
    return `\x1b[38;5;130m${text}\x1b[0m`;
  }

  static lime(text) {
    return `\x1b[38;5;154m${text}\x1b[0m`;
  }

  static teal(text) {
    return `\x1b[38;5;30m${text}\x1b[0m`;
  }

  static lavender(text) {
    return `\x1b[38;5;183m${text}\x1b[0m`;
  }

  static salmon(text) {
    return `\x1b[38;5;209m${text}\x1b[0m`;
  }

  static gold(text) {
    return `\x1b[38;5;220m${text}\x1b[0m`;
  }

  static silver(text) {
    return `\x1b[38;5;7m${text}\x1b[0m`;
  }

  // Background colors (standard)
  static bgBlack(text) {
    return `\x1b[40m${text}\x1b[0m`;
  }

  static bgRed(text) {
    return `\x1b[41m${text}\x1b[0m`;
  }

  static bgGreen(text) {
    return `\x1b[42m${text}\x1b[0m`;
  }

  static bgYellow(text) {
    return `\x1b[43m${text}\x1b[0m`;
  }

  static bgBlue(text) {
    return `\x1b[44m${text}\x1b[0m`;
  }

  static bgMagenta(text) {
    return `\x1b[45m${text}\x1b[0m`;
  }

  static bgCyan(text) {
    return `\x1b[46m${text}\x1b[0m`;
  }

  static bgWhite(text) {
    return `\x1b[47m${text}\x1b[0m`;
  }

  // Bright background colors
  static bgBrightBlack(text) {
    return `\x1b[100m${text}\x1b[0m`;
  }

  static bgBrightRed(text) {
    return `\x1b[101m${text}\x1b[0m`;
  }

  static bgBrightGreen(text) {
    return `\x1b[102m${text}\x1b[0m`;
  }

  static bgBrightYellow(text) {
    return `\x1b[103m${text}\x1b[0m`;
  }

  static bgBrightBlue(text) {
    return `\x1b[104m${text}\x1b[0m`;
  }

  static bgBrightMagenta(text) {
    return `\x1b[105m${text}\x1b[0m`;
  }

  static bgBrightCyan(text) {
    return `\x1b[106m${text}\x1b[0m`;
  }

  static bgBrightWhite(text) {
    return `\x1b[107m${text}\x1b[0m`;
  }

  // Text styles
  static bold(text) {
    return `\x1b[1m${text}\x1b[0m`;
  }

  static dim(text) {
    return `\x1b[2m${text}\x1b[0m`;
  }

  static italic(text) {
    return `\x1b[3m${text}\x1b[0m`;
  }

  static underline(text) {
    return `\x1b[4m${text}\x1b[0m`;
  }

  static blink(text) {
    return `\x1b[5m${text}\x1b[0m`;
  }

  static inverse(text) {
    return `\x1b[7m${text}\x1b[0m`;
  }

  static hidden(text) {
    return `\x1b[8m${text}\x1b[0m`;
  }

  static strikethrough(text) {
    return `\x1b[9m${text}\x1b[0m`;
  }

  // Utility methods
  static custom(text, colorCode) {
    if (colorCode >= 0 && colorCode <= 255) {
      return `\x1b[38;5;${colorCode}m${text}\x1b[0m`;
    }
    return text;
  }

  static bgCustom(text, colorCode) {
    if (colorCode >= 0 && colorCode <= 255) {
      return `\x1b[48;5;${colorCode}m${text}\x1b[0m`;
    }
    return text;
  }

  static rgb(text, r, g, b) {
    if (r >= 0 && r <= 255 && g >= 0 && g <= 255 && b >= 0 && b <= 255) {
      return `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`;
    }
    return text;
  }

  static bgRgb(text, r, g, b) {
    if (r >= 0 && r <= 255 && g >= 0 && g <= 255 && b >= 0 && b <= 255) {
      return `\x1b[48;2;${r};${g};${b}m${text}\x1b[0m`;
    }
    return text;
  }

  static combine(text, ...styles) {
    let result = text;
    for (const style of styles) {
      if (typeof style === 'function') {
        result = style(result);
      } else if (typeof style === 'string') {
        // Handle string style names
        const styleMethod = this[style] || this[style.toLowerCase()];
        if (styleMethod) {
          result = styleMethod.call(this, result);
        }
      }
    }
    return result;
  }

  /**
   * Display all available colors with examples
   * @param {string} sampleText - Text to display for each color
   * @param {boolean} showCode - Whether to show the ANSI code
   */
  static showAllColors(sampleText = "Hello World", showCode = true) {
    const colorGroups = {
      "Standard Colors": [
        { name: "black", method: this.black },
        { name: "red", method: this.red },
        { name: "green", method: this.green },
        { name: "yellow", method: this.yellow },
        { name: "blue", method: this.blue },
        { name: "magenta", method: this.magenta },
        { name: "cyan", method: this.cyan },
        { name: "white", method: this.white }
      ],
      "Bright Colors": [
        { name: "brightBlack", method: this.brightBlack },
        { name: "brightRed", method: this.brightRed },
        { name: "brightGreen", method: this.brightGreen },
        { name: "brightYellow", method: this.brightYellow },
        { name: "brightBlue", method: this.brightBlue },
        { name: "brightMagenta", method: this.brightMagenta },
        { name: "brightCyan", method: this.brightCyan },
        { name: "brightWhite", method: this.brightWhite }
      ],
      "256-Color Palette": [
        { name: "orange", method: this.orange },
        { name: "pink", method: this.pink },
        { name: "purple", method: this.purple },
        { name: "brown", method: this.brown },
        { name: "lime", method: this.lime },
        { name: "teal", method: this.teal },
        { name: "lavender", method: this.lavender },
        { name: "salmon", method: this.salmon },
        { name: "gold", method: this.gold },
        { name: "silver", method: this.silver }
      ],
      "Background Colors": [
        { name: "bgBlack", method: this.bgBlack },
        { name: "bgRed", method: this.bgRed },
        { name: "bgGreen", method: this.bgGreen },
        { name: "bgYellow", method: this.bgYellow },
        { name: "bgBlue", method: this.bgBlue },
        { name: "bgMagenta", method: this.bgMagenta },
        { name: "bgCyan", method: this.bgCyan },
        { name: "bgWhite", method: this.bgWhite }
      ],
      "Bright Backgrounds": [
        { name: "bgBrightBlack", method: this.bgBrightBlack },
        { name: "bgBrightRed", method: this.bgBrightRed },
        { name: "bgBrightGreen", method: this.bgBrightGreen },
        { name: "bgBrightYellow", method: this.bgBrightYellow },
        { name: "bgBrightBlue", method: this.bgBrightBlue },
        { name: "bgBrightMagenta", method: this.bgBrightMagenta },
        { name: "bgBrightCyan", method: this.bgBrightCyan },
        { name: "bgBrightWhite", method: this.bgBrightWhite }
      ],
      "Text Styles": [
        { name: "bold", method: this.bold },
        { name: "dim", method: this.dim },
        { name: "italic", method: this.italic },
        { name: "underline", method: this.underline },
        { name: "blink", method: this.blink },
        { name: "inverse", method: this.inverse },
        { name: "hidden", method: this.hidden },
        { name: "strikethrough", method: this.strikethrough }
      ]
    };

    console.log("\n" + this.bold(this.cyan("═".repeat(60))));
    console.log(this.bold(this.cyan("COLOR TEXT DEMONSTRATION")));
    console.log(this.bold(this.cyan("═".repeat(60))) + "\n");

    for (const [groupName, colors] of Object.entries(colorGroups)) {
      console.log(this.bold(this.yellow(`\n${groupName}:`)));
      console.log(this.dim("─".repeat(40)));

      colors.forEach(color => {
        const coloredText = color.method.call(this, sampleText);
        if (showCode) {
          // Extract ANSI code for display
          const match = coloredText.match(/\x1b\[([\d;]+)m/);
          const code = match ? match[1] : 'N/A';
          console.log(`  ${color.name.padEnd(20)} ${coloredText} ${this.dim(`(\\x1b[${code}m)`)}`);
        } else {
          console.log(`  ${color.name.padEnd(20)} ${coloredText}`);
        }
      });
    }

    // Show combination examples
    console.log(this.bold(this.yellow("\nCombination Examples:")));
    console.log(this.dim("─".repeat(40)));
    
    const combos = [
      ["red", "bold"],
      ["green", "underline"],
      ["blue", "italic", "bgYellow"],
      ["magenta", "bold", "underline"],
      ["cyan", "inverse"],
      ["orange", "bold", "bgBlue"]
    ];

    combos.forEach((styles, i) => {
      const result = this.combine(sampleText, ...styles.map(s => this[s]));
      console.log(`  ${styles.join(' + ').padEnd(25)} ${result}`);
    });

    // Show RGB examples
    console.log(this.bold(this.yellow("\nRGB Examples:")));
    console.log(this.dim("─".repeat(40)));
    
    const rgbExamples = [
      { name: "Deep Sky Blue", r: 0, g: 191, b: 255 },
      { name: "Coral", r: 255, g: 127, b: 80 },
      { name: "Spring Green", r: 0, g: 255, b: 127 },
      { name: "Goldenrod", r: 218, g: 165, b: 32 }
    ];

    rgbExamples.forEach(example => {
      const colored = this.rgb(sampleText, example.r, example.g, example.b);
      console.log(`  ${example.name.padEnd(20)} ${colored} ${this.dim(`(${example.r},${example.g},${example.b})`)}`);
    });

    console.log("\n" + this.bold(this.cyan("═".repeat(60))));
    console.log(this.dim("Use ColorText.<method>(text) to apply colors"));
    console.log(this.dim("Example: ColorText.red('Error!')"));
    console.log(this.bold(this.cyan("═".repeat(60))) + "\n");
  }
}

function getMachineID() {
    // Try primary DMI method
    try {
        if (existsSync('/sys/class/dmi/id/product_uuid')) {
            const uuid = readFileSync('/sys/class/dmi/id/product_uuid', 'utf8').trim();
            if (uuid && uuid.length >= 36) {
                return uuid.toUpperCase();
            }
        }
    } catch {}

    // Fallback 1: /etc/machine-id (Linux)
    try {
        if (existsSync('/etc/machine-id')) {
            const id = readFileSync('/etc/machine-id', 'utf8').trim();
            if (id.length >= 32) return `MACHINE-ID-${id}`;
        }
    } catch {}

    // Fallback 2: CPU info serial (Linux ARM)
    try {
        const cpuinfo = readFileSync('/proc/cpuinfo', 'utf8');
        const lines = cpuinfo.split('\n');
        for (const line of lines) {
            if (line.includes('Serial') && line.includes(':')) {
                const serial = line.split(':')[1].trim();
                if (serial.length > 0) return `CPU-${serial}`;
            }
        }
    } catch {}

    // Fallback 3: MAC address (first network interface)
    try {
        const netPath = '/sys/class/net/';
        const interfaces = execSync(`ls ${netPath}`, { stdio: ['pipe', 'pipe', 'ignore'] })
            .toString()
            .split('\n')
            .filter(iface => iface && !iface.startsWith('lo'));
        
        if (interfaces.length > 0) {
            const mac = readFileSync(`${netPath}${interfaces[0]}/address`, 'utf8').trim();
            if (mac) return `MAC-${mac.replace(/:/g, '').toUpperCase()}`;
        }
    } catch {}

    // Fallback 4: Disk UUID (first disk)
    try {
        const disks = execSync('lsblk -o UUID,MOUNTPOINT -n 2>/dev/null || true', { shell: true })
            .toString()
            .split('\n')
            .filter(line => line && !line.includes('MOUNTPOINT'));
        
        if (disks.length > 0) {
            const diskUuid = disks[0].split(' ')[0].trim();
            if (diskUuid) return `DISK-${diskUuid}`;
        }
    } catch {}

    // Final fallback: Generate hash from hostname + timestamp
    const hostname = typeof window === 'undefined' 
        ? require('os').hostname() 
        : 'browser';
    
    const hash = createHash('sha256')
        .update(hostname + Date.now().toString())
        .digest('hex')
        .substring(0, 32);
    
    return `GEN-${hash.toUpperCase()}`;
}


//TerminalHUD interface below

/**
 * TerminalHUD - A framework for creating HUD interfaces in terminal
 * Optional mouse support: click to focus, double-click to select, wheel to navigate.
 * Now extends EventEmitter for event-driven architecture.
 * 
 * @class TerminalHUD
 * @extends {EventEmitter}
 */
class TerminalHUD extends EventEmitter {
  /**
   * Creates an instance of TerminalHUD
   * @constructor
   * @param {object} configuration - Configuration options
   * @param {boolean} [configuration.numberedMenus=false] - Use numbered menus instead of arrow navigation
   * @param {string} [configuration.highlightColor='blue'] - Color for highlighting selected menu option
   * @param {boolean} [configuration.mouseSupport=true] - Enable mouse click/double-click navigation
   * @param {boolean} [configuration.mouseWheel] - Enable mouse wheel navigation (defaults to mouseSupport value)
   * @param {boolean} [configuration.enableEvents=true] - Enable event emission
   */
  constructor(configuration = {}) {
    super(); // Initialize EventEmitter
    
    this.readlineInterface = readline.createInterface({
      input: stdin,
      output: stdout
    });
    this.isLoading = false;
    this.numberedMenus = configuration.numberedMenus || false;
    this.highlightColor = this.getAnsiBackgroundColor(configuration.highlightColor || 'blue');
    this.lastMenuGenerator = null;
    this.lastSelectedIndex = 0;
    
    // Event emission configuration
    this.enableEvents = configuration.enableEvents !== false; // Default to true

    // Optional mouse support
    this.mouseSupport = configuration.mouseSupport || true;
    this.mouseWheel = configuration.mouseWheel !== undefined ? configuration.mouseWheel : this.mouseSupport;
    this.mouseEventBuffer = '';
    this.isMouseEnabled = false;
    this.currentMenuState = null;
    this.lastMouseClick = { time: 0, x: -1, y: -1 };
    this.DOUBLE_CLICK_DELAY = 300;
    this.doubleClickTimeout = null;
    this.isClickInProgress = false;
    
    // Mouse wheel state
    this.wheelAccumulator = 0;
    this.WHEEL_THRESHOLD = 1; // Number of wheel events needed to trigger navigation

    // Track if we're currently in a menu
    this.isInMenu = false;

    // Track if selection is from keyboard
    this.isKeyboardSelection = false;

    // Bind the mouse handler to maintain context
    this.handleMouseData = this.handleMouseData.bind(this);
    
    // Event types documentation
    this.eventTypes = {
      // Menu events
      MENU_DISPLAY: 'menu:display',
      MENU_SELECTION: 'menu:selection',
      MENU_NAVIGATION: 'menu:navigation',
      MENU_CLOSE: 'menu:close',
      
      // Input events
      QUESTION_ASK: 'question:ask',
      QUESTION_ANSWER: 'question:answer',
      
      // Loading events
      LOADING_START: 'loading:start',
      LOADING_STOP: 'loading:stop',
      
      // Mouse events
      MOUSE_CLICK: 'mouse:click',
      MOUSE_DOUBLE_CLICK: 'mouse:doubleclick',
      MOUSE_WHEEL: 'mouse:wheel',
      
      // Key events
      KEY_PRESS: 'key:press',
      
      // General events
      PRESS_WAIT: 'press:wait'
    };
  }

  /**
   * Emits an event with the given name and data
   * @private
   * @param {string} eventName - The name of the event to emit
   * @param {object} [eventData={}] - Additional data to include with the event
   */
  emitEvent(eventName, eventData = {}) {
    if (this.enableEvents && this.listenerCount(eventName) > 0) {
      this.emit(eventName, {
        timestamp: Date.now(),
        ...eventData
      });
    }
    // Also emit wildcard event for all listeners
    if (this.enableEvents && this.listenerCount('*') > 0) {
      this.emit('*', {
        event: eventName,
        timestamp: Date.now(),
        ...eventData
      });
    }
  }

  // Core Helper Methods

  /**
   * Gets ANSI background color code for a given color name
   * @private
   * @param {string} color - Color name (red, green, yellow, blue, magenta, cyan, white)
   * @returns {string} ANSI escape sequence for the background color
   */
  getAnsiBackgroundColor(color) {
    const colors = {
      red: '\x1b[41m',
      green: '\x1b[42m',
      yellow: '\x1b[43m',
      blue: '\x1b[44m',
      magenta: '\x1b[45m',
      cyan: '\x1b[46m',
      white: '\x1b[47m'
    };
    return colors[color] || '';
  }

  /**
   * Resets terminal colors to default
   * @private
   * @returns {string} ANSI reset sequence
   */
  resetColor() {
    return '\x1b[0m';
  }

  /**
   * Starts a loading animation in the terminal
   * @private
   */
  startLoading() {
    this.isLoading = true;
    
    // Emit loading start event
    this.emitEvent(this.eventTypes.LOADING_START);
    
    let loadingCounter = 0;
    this.loadingInterval = setInterval(() => {
      stdout.clearLine();
      stdout.cursorTo(0);
      stdout.write(`⏳ Loading${'.'.repeat(loadingCounter)}`);
      loadingCounter = (loadingCounter + 1) % 4;
    }, 500);
  }

  /**
   * Stops the loading animation
   * @private
   */
  stopLoading() {
    this.isLoading = false;
    clearInterval(this.loadingInterval);
    stdout.clearLine();
    stdout.cursorTo(0);
    
    // Emit loading stop event
    this.emitEvent(this.eventTypes.LOADING_STOP);
  }

  // Public API

  /**
   * Resets terminal modes to default state
   * @private
   */
  resetTerminalModes() {
    // Write all terminal reset commands
    stdout.write('\x1b[?1000l'); // Disable mouse tracking
    stdout.write('\x1b[?1002l'); // Disable mouse drag tracking
    stdout.write('\x1b[?1003l'); // Disable all mouse tracking
    stdout.write('\x1b[?1006l'); // Disable SGR mouse mode
    stdout.write('\x1b[?25h');   // Show cursor
    stdout.write(''); // Force flush
  }

  /**
   * Cleans up mouse support features
   * @private
   */
  cleanupMouseSupport() {
    // Only cleanup if mouse was enabled
    if (this.isMouseEnabled) {
      this.resetTerminalModes();
      stdin.removeListener('data', this.handleMouseData);
      this.isMouseEnabled = false;
      this.mouseEventBuffer = '';
    }
    
    // Reset click state
    this.resetClickState();
    
    // Reset wheel accumulator
    this.wheelAccumulator = 0;
  }

  /**
   * Asks a question to the user
   * @async
   * @param {string} question - The question to ask
   * @param {object} [configuration={}] - Configuration options
   * @param {Array<string|object>} [configuration.options] - Menu options for selection
   * @param {string} [configuration.alert] - Alert message to display
   * @param {string} [configuration.alertEmoji='⚠️'] - Emoji for alert message
   * @param {boolean} [configuration.clearScreen=true] - Whether to clear screen before display
   * @param {number} [configuration.initialSelectedIndex=0] - Initial selected index
   * @param {number} [configuration.selectedIncrement=0] - Increment to apply to selected index
   * @param {any} [configuration.props] - Additional properties to pass to menu generator
   * @returns {Promise<string|any>} The user's answer or selected option
   * 
   * @emits TerminalHUD#question:ask
   * @emits TerminalHUD#question:answer
   * @emits TerminalHUD#menu:display
   * @emits TerminalHUD#menu:selection
   * @emits TerminalHUD#menu:navigation
   */
  async ask(question, configuration = {}) {
    // Emit question ask event
    this.emitEvent(this.eventTypes.QUESTION_ASK, {
      question,
      configuration
    });

    if (configuration.options) {
      return this.numberedMenus
        ? this.displayMenuFromOptions(question, configuration.options, configuration)
        : this.displayMenuWithArrows(question, configuration.options, configuration);
    }

    // If we're in a menu, cleanup mouse support first
    if (this.isInMenu) {
      this.cleanupMouseSupport();
      this.isInMenu = false;
    }

    // Remove keypress listeners if any
    stdin.removeAllListeners('keypress');
    
    // Ensure raw mode is off
    if (stdin.isRaw) {
      stdin.setRawMode(false);
    }

    // Close current readline interface if it exists
    if (this.readlineInterface) {
      this.readlineInterface.close();
    }

    // Create a new clean readline interface
    return new Promise((resolve) => {
      this.readlineInterface = readline.createInterface({
        input: stdin,
        output: stdout,
        terminal: true
      });

      this.readlineInterface.question(`\n${question}`, (answer) => {
        this.readlineInterface.close();
        
        // Emit question answer event
        this.emitEvent(this.eventTypes.QUESTION_ANSWER, {
          question,
          answer,
          configuration
        });
        
        // Restore interface for future use
        this.readlineInterface = readline.createInterface({
          input: stdin,
          output: stdout
        });
        resolve(answer);
      });
    });
  }

/**
 * Counts total options in a menu structure, properly handling groups
 * @private
 * @param {Array<string|object|Array<string|object>>} options - Menu options
 * @returns {number} Total number of options
 */
countMenuOptions(options) {
  if (!Array.isArray(options)) return 0;
  
  let count = 0;
  for (const option of options) {
    if (Array.isArray(option)) {
      count += option.length;
    } else if (option && option.type === 'options') {
      // Count each item in the options group
      count += option.value.length;
    } else {
      count++;
    }
  }
  return count;
}

   /**
 * Displays a menu generated by a menu generator function or from a raw menu object
 * @async
 * @param {Function|object} menuGeneratorOrObject - Function that generates menu content OR raw menu object
 * @param {object} [configuration={}] - Configuration options
 * @param {any} [configuration.props] - Properties to pass to menu generator
 * @param {boolean} [configuration.clearScreen=true] - Whether to clear screen
 * @param {string} [configuration.alert] - Alert message to display
 * @param {string} [configuration.alertEmoji='⚠️'] - Emoji for alert message
 * @param {number} [configuration.initialSelectedIndex=0] - Initial selected index
 * @param {number} [configuration.selectedIncrement=0] - Increment to apply to selected index (deprecated, use jumpToIndex instead)
 * @param {boolean} [configuration.remember=false] - Whether to remember the previous selection index if possible
 * @param {number} [configuration.jumpToIndex=0] - Jump forward/backward this many positions from the base index
 * @param {boolean} [configuration.jumpFromLast=false] - If true, jump from the last index when jumpToIndex is negative
 * @returns {Promise<string|any>} The selected option
 * 
 * @emits TerminalHUD#menu:display
 * @emits TerminalHUD#menu:selection
 * @emits TerminalHUD#menu:navigation
 * @emits TerminalHUD#loading:start
 * @emits TerminalHUD#loading:stop
 */
async displayMenu(menuGeneratorOrObject, configuration = {
  props: {},
  clearScreen: true,
  alert: undefined,
  alertEmoji: '⚠️',
  initialSelectedIndex: 0,
  selectedIncrement: 0,
  remember: false,
  jumpToIndex: 0,
  jumpFromLast: false
}) {
  if (configuration.clearScreen) console.clear();
  
  let menu;
  
  // Determine if first parameter is a function or object
  if (typeof menuGeneratorOrObject === 'function') {
    // Handle menu generator function (existing behavior)
    this.startLoading();
    menu = await menuGeneratorOrObject(configuration.props);
    this.stopLoading();
  } else if (typeof menuGeneratorOrObject === 'object' && menuGeneratorOrObject !== null) {
    // Handle raw menu object (new behavior)
    menu = menuGeneratorOrObject;
  } else {
    throw new Error('displayMenu expects either a menu generator function or a menu object');
  }
  
  // Validate menu structure
  if (!menu || typeof menu !== 'object') {
    throw new Error('Invalid menu structure');
  }
  
  if (configuration.alert) {
    console.log(`${configuration.alertEmoji || '⚠️'}  ${configuration.alert}\n`);
  }
  
  // Handle title - it could be a string or a promise
  const menuTitle = typeof menu.title === 'function' 
    ? await menu.title() 
    : (menu.title && typeof menu.title.then === 'function' 
      ? await menu.title 
      : menu.title || '');
  
  // Get total number of options
  const totalOptions = this.countMenuOptions(menu.options);
  
  // Determine base index
  let baseIndex;
  
  if (configuration.remember && this.lastSelectedIndex !== undefined) {
    // Use remembered index as base if valid
    baseIndex = (this.lastSelectedIndex >= 0 && this.lastSelectedIndex < totalOptions) 
      ? this.lastSelectedIndex 
      : (configuration.initialSelectedIndex || 0);
  } else {
    // Use initialSelectedIndex as base
    baseIndex = configuration.initialSelectedIndex || 0;
  }
  
  // Apply selectedIncrement for backward compatibility
  if (configuration.selectedIncrement) {
    configuration.jumpToIndex = (configuration.jumpToIndex || 0) + configuration.selectedIncrement;
  }
  
  // Calculate final index based on jump configuration
  let finalIndex = baseIndex;
  
  if (configuration.jumpToIndex) {
    if (configuration.jumpToIndex > 0) {
      // Positive jump: always jump forward from base index
      finalIndex = Math.min(baseIndex + configuration.jumpToIndex, totalOptions - 1);
    } else if (configuration.jumpToIndex < 0) {
      if (configuration.jumpFromLast) {
        // Jump backward from the last index
        finalIndex = Math.max(0, totalOptions - 1 + configuration.jumpToIndex);
      } else {
        // Jump backward from base index
        finalIndex = Math.max(0, baseIndex + configuration.jumpToIndex);
      }
    }
  }
  
  // Ensure finalIndex is within bounds
  finalIndex = Math.max(0, Math.min(finalIndex, totalOptions - 1));
  
  // Store reference to menu generator for function case
  if (typeof menuGeneratorOrObject === 'function') {
    this.lastMenuGenerator = menuGeneratorOrObject;
  }
  
  // Emit menu display event with jump information
  this.emitEvent(this.eventTypes.MENU_DISPLAY, {
    question: menuTitle,
    options: this.sanitizeOptionsForEvent(menu.options),
    configuration: {
      ...configuration,
      baseIndex,
      finalIndex,
      totalOptions
    },
    menuType: this.numberedMenus ? 'numbered' : 'arrow'
  });
  
  return this.numberedMenus
    ? this.displayMenuFromOptions(menuTitle, menu.options, { ...configuration, initialSelectedIndex: finalIndex })
    : this.displayMenuWithArrows(menuTitle, menu.options, configuration, finalIndex);
}

  /**
   * Waits for any key press
   * @async
   * @returns {Promise<void>}
   * 
   * @emits TerminalHUD#press:wait
   * @emits TerminalHUD#key:press
   */
  async pressWait() {
    // Emit press wait event
    this.emitEvent(this.eventTypes.PRESS_WAIT);

    // Cleanup mouse support if active
    if (this.isInMenu) {
      this.cleanupMouseSupport();
      this.isInMenu = false;
    }

    // Remove any existing listeners
    stdin.removeAllListeners('keypress');
    stdin.removeAllListeners('data');
    
    // Ensure raw mode is off initially
    if (stdin.isRaw) {
      stdin.setRawMode(false);
    }

    return new Promise(resolve => {
      console.log('\nPress any key to continue...');
      
      const keyHandler = (data) => {
        stdin.setRawMode(false);
        stdin.removeListener('data', keyHandler);
        
        // Emit key press event
        this.emitEvent(this.eventTypes.KEY_PRESS, {
          key: data.toString(),
          isCtrlC: data.toString() === '\x03'
        });
        
        // Handle Ctrl+C
        if (data && data.toString() === '\x03') {
          process.exit(0);
        }
        
        resolve();
      };
      
      stdin.setRawMode(true);
      stdin.once('data', keyHandler);
    });
  }

  /**
   * Closes the TerminalHUD instance and cleans up resources
   * 
   * @emits TerminalHUD#menu:close
   */
  close() {
    // Emit menu close event if in menu
    if (this.isInMenu) {
      this.emitEvent(this.eventTypes.MENU_CLOSE);
    }
    
    this.cleanupAll();
    if (this.readlineInterface) {
      this.readlineInterface.close();
    }
  }

  // Menu Display Logic (Enhanced for Mouse)

  /**
   * Displays a menu with arrow key navigation and optional mouse support
   * @async
   * @private
   * @param {string} question - The menu title/question
   * @param {Array<string|object>} options - Menu options
   * @param {object} [configuration={}] - Configuration options
   * @param {boolean} [configuration.clear=false] - Whether to clear screen
   * @param {number} [initialIndex=0] - Initial selected index
   * @returns {Promise<string|any>} The selected option
   * 
   * @emits TerminalHUD#menu:display
   * @emits TerminalHUD#menu:navigation
   * @emits TerminalHUD#menu:selection
   * @emits TerminalHUD#key:press
   * @emits TerminalHUD#mouse:click
   * @emits TerminalHUD#mouse:doubleclick
   * @emits TerminalHUD#mouse:wheel
   */
  async displayMenuWithArrows(question, options = [], configuration = { clear: false }, initialIndex = 0) {
    // Emit menu display event
    this.emitEvent(this.eventTypes.MENU_DISPLAY, {
      question,
      options: this.sanitizeOptionsForEvent(options),
      configuration,
      initialIndex,
      menuType: 'arrow'
    });

    if (!this.mouseSupport) {
      return this.displayMenuWithArrowsOriginal(question, options, configuration, initialIndex);
    }

    return new Promise((resolve) => {
      const normalizedOptions = this.normalizeOptions(options);
      if (configuration.clear) console.clear();

      let { line, column } = this.getCoordinatesFromLinearIndex(normalizedOptions, initialIndex);

      const renderMenu = () => {
        console.clear();
        if (question) console.log(`${question}\n`);
        normalizedOptions.forEach((lineOptions, lineIndex) => {
          let lineString = lineOptions.map((option, columnIndex) => {
            const text = typeof option === 'string' ? option : option.name || JSON.stringify(option);
            if (lineIndex === line && columnIndex === column) {
              return this.highlightColor
                ? `${this.highlightColor}${text}${this.resetColor()}`
                : `→ ${text}`;
            }
            return text;
          }).join('   ');
          console.log(lineString);
        });
      };

      const setFocus = (newLine, newColumn) => {
        line = newLine;
        column = newColumn;
        
        // Emit menu navigation event
        this.emitEvent(this.eventTypes.MENU_NAVIGATION, {
          line: newLine,
          column: newColumn,
          linearIndex: this.getLinearIndexFromCoordinates(normalizedOptions, newLine, newColumn),
          question
        });
        
        renderMenu();
      };

      const selectOption = async (selectionSource = 'mouse') => {
        // Prevent multiple simultaneous selections
        if (this.isClickInProgress) return;
        
        this.isClickInProgress = true;
        
        // Get selected item before cleanup
        this.lastSelectedIndex = this.getLinearIndexFromCoordinates(normalizedOptions, line, column);
        const selected = normalizedOptions[line][column];
        
        // Emit menu selection event with data
        const selectionEventData = {
          index: this.lastSelectedIndex,
          line,
          column,
          selected: this.getOptionDataForEvent(selected),
          question,
          source: selectionSource
        };
        
        // Add custom data from option if available
        if (selected && typeof selected === 'object') {
          if (selected.eventData) {
            selectionEventData.customData = selected.eventData;
          }
          if (selected.metadata) {
            selectionEventData.metadata = selected.metadata;
          }
        }
        
        this.emitEvent(this.eventTypes.MENU_SELECTION, selectionEventData);
        
        // Clean up menu state immediately
        this.cleanupMenuState();
        
        try {
          if (selected?.action) {
            // Execute the action
            const result = selected.action();
            if (result instanceof Promise) {
              await result;
            }
          }
          
          // Return the selected item for resolution
          resolve(selected?.name || selected);
        } catch (error) {
          console.error('Error in menu action:', error);
          resolve(null);
        } finally {
          this.isClickInProgress = false;
        }
      };

      const handleKeyPress = async (_, key) => {
        if (!this.isInMenu) return;
        
        // Emit key press event for menu
        this.emitEvent(this.eventTypes.KEY_PRESS, {
          key: key.name,
          sequence: key.sequence,
          ctrl: key.ctrl,
          shift: key.shift,
          meta: key.meta,
          inMenu: true
        });
        
        switch (key.name) {
          case 'up':
            if (line > 0) line--;
            if (column >= normalizedOptions[line].length) column = normalizedOptions[line].length - 1;
            setFocus(line, column);
            break;
          case 'down':
            if (line < normalizedOptions.length - 1) line++;
            if (column >= normalizedOptions[line].length) column = normalizedOptions[line].length - 1;
            setFocus(line, column);
            break;
          case 'left':
            if (column > 0) column--;
            setFocus(line, column);
            break;
          case 'right':
            if (column < normalizedOptions[line].length - 1) column++;
            setFocus(line, column);
            break;
          case 'return':
            await selectOption('keyboard');
            return;
          case 'c':
            if (key.ctrl) {
              this.cleanupMenuState();
              process.exit();
            }
            break;
        }
      };

      // Setup for this menu
      this.setupMenuState(handleKeyPress);

      // Store menu state for mouse handling
      this.currentMenuState = {
        normalizedOptions,
        question,
        renderMenu,
        setFocus,
        selectOption,
        currentLine: line,
        currentColumn: column
      };

      renderMenu();
    });
  }

  /**
   * Sets up the menu state and event listeners
   * @private
   * @param {Function} keyPressHandler - Function to handle key press events
   */
  setupMenuState(keyPressHandler) {
    this.isInMenu = true;
    
    // Remove any existing listeners
    stdin.removeAllListeners('keypress');
    
    readline.emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('keypress', keyPressHandler);

    // Enable mouse tracking for this menu
    this.safeEnableMouseTracking();
  }

  /**
   * Cleans up menu state and event listeners
   * @private
   */
  cleanupMenuState() {
    this.isInMenu = false;
    
    // Remove keypress listener
    stdin.removeAllListeners('keypress');
    
    // Disable raw mode
    if (stdin.isRaw) {
      stdin.setRawMode(false);
    }
    
    // Cleanup mouse support
    this.cleanupMouseSupport();
    
    this.currentMenuState = null;
    this.wheelAccumulator = 0;
  }

  /**
   * Displays a menu with arrow key navigation (original implementation without mouse support)
   * @async
   * @private
   * @param {string} question - The menu title/question
   * @param {Array<string|object>} options - Menu options
   * @param {object} [configuration={}] - Configuration options
   * @param {boolean} [configuration.clear=false] - Whether to clear screen
   * @param {number} [initialIndex=0] - Initial selected index
   * @returns {Promise<string|any>} The selected option
   * 
   * @emits TerminalHUD#menu:display
   * @emits TerminalHUD#menu:navigation
   * @emits TerminalHUD#menu:selection
   * @emits TerminalHUD#key:press
   */
  async displayMenuWithArrowsOriginal(question, options = [], configuration = { clear: false }, initialIndex = 0) {
    // Emit menu display event
    this.emitEvent(this.eventTypes.MENU_DISPLAY, {
      question,
      options: this.sanitizeOptionsForEvent(options),
      configuration,
      initialIndex,
      menuType: 'arrow-original'
    });

    return new Promise(resolve => {
      if (configuration.clear) console.clear();
     
      const normalizedOptions = this.normalizeOptions(options);
      let { line, column } = this.getCoordinatesFromLinearIndex(normalizedOptions, initialIndex);

      const renderMenu = () => {
        console.clear();
        if (question) console.log(`${question}\n`);
        normalizedOptions.forEach((lineOptions, lineIndex) => {
          let lineString = lineOptions.map((option, columnIndex) => {
            const text = typeof option === 'string' ? option : option.name || JSON.stringify(option);
            if (lineIndex === line && columnIndex === column) {
              return this.highlightColor
                ? `${this.highlightColor}${text}${this.resetColor()}`
                : `→ ${text}`;
            }
            return text;
          }).join('   ');
          console.log(lineString);
        });
      };

      const handleKeyPress = async (_, key) => {
        // Emit key press event for menu
        this.emitEvent(this.eventTypes.KEY_PRESS, {
          key: key.name,
          sequence: key.sequence,
          ctrl: key.ctrl,
          shift: key.shift,
          meta: key.meta,
          inMenu: true
        });
        
        switch (key.name) {
          case 'up':
            if (line > 0) line--;
            if (column >= normalizedOptions[line].length) column = normalizedOptions[line].length - 1;
            break;
          case 'down':
            if (line < normalizedOptions.length - 1) line++;
            if (column >= normalizedOptions[line].length) column = normalizedOptions[line].length - 1;
            break;
          case 'left':
            if (column > 0) column--;
            break;
          case 'right':
            if (column < normalizedOptions[line].length - 1) column++;
            break;
          case 'return':
            stdin.removeListener('keypress', handleKeyPress);
            stdin.setRawMode(false);
            this.lastSelectedIndex = this.getLinearIndexFromCoordinates(normalizedOptions, line, column);
            const selected = normalizedOptions[line][column];
            
            // Emit menu selection event
            const selectionEventData = {
              index: this.lastSelectedIndex,
              line,
              column,
              selected: this.getOptionDataForEvent(selected),
              question,
              source: 'keyboard'
            };
            
            // Add custom data from option if available
            if (selected && typeof selected === 'object') {
              if (selected.eventData) {
                selectionEventData.customData = selected.eventData;
              }
              if (selected.metadata) {
                selectionEventData.metadata = selected.metadata;
              }
            }
            
            this.emitEvent(this.eventTypes.MENU_SELECTION, selectionEventData);
            
            if (selected?.action) await selected.action();
            resolve(selected?.name || selected);
            return;
        }
        renderMenu();
      };

      readline.emitKeypressEvents(stdin);
      stdin.setRawMode(true);
      stdin.resume();
      stdin.on('keypress', handleKeyPress);
      renderMenu();
    });
  }

  /**
   * Displays a menu with numbered options
   * @async
   * @private
   * @param {string} question - The menu title/question
   * @param {Array<string|object>} options - Menu options
   * @param {object} [configuration={}] - Configuration options
   * @param {boolean} [configuration.clear=true] - Whether to clear screen
   * @returns {Promise<string|any>} The selected option
   * 
   * @emits TerminalHUD#menu:display
   * @emits TerminalHUD#menu:selection
   */
  async displayMenuFromOptions(question, options, configuration = { clear: true }) {
    if (!this.numberedMenus) {
      return this.displayMenuWithArrows(question, options, configuration);
    }

    // Emit menu display event
    this.emitEvent(this.eventTypes.MENU_DISPLAY, {
      question,
      options: this.sanitizeOptionsForEvent(options),
      configuration,
      menuType: 'numbered-from-options'
    });

    console.clear();
    if (question) console.log(`${question}\n`);

    const optionMap = {};
    let index = 1;
    const printOption = (option) => {
      const text = typeof option === 'string' ? option : option.name;
      console.log(`${index}. ${text}`);
      optionMap[index++] = option;
    };

    options.forEach(option => {
      Array.isArray(option)
        ? option.forEach(subOption => printOption(subOption))
        : printOption(option);
    });

    const choice = parseInt(await this.ask('Choose an option: '));
    const selected = optionMap[choice];
   
    if (!selected) {
      console.log('Invalid option, try again.');
      return this.displayMenuFromOptions(question, options, configuration);
    }

    if (typeof selected === 'string') return selected;
    
    // Emit menu selection event
    this.emitEvent(this.eventTypes.MENU_SELECTION, {
      index: choice,
      selected: this.getOptionDataForEvent(selected),
      question,
      source: 'numbered'
    });
    
    if (selected.action) await selected.action();
    return selected.name;
  }

  /**
   * Displays a numbered menu with special option types
   * @async
   * @private
   * @param {string} title - The menu title
   * @param {Array<object>} options - Menu options with type property
   * @returns {Promise<string|any>} The selected option
   * 
   * @emits TerminalHUD#menu:display
   * @emits TerminalHUD#menu:selection
   */
  async displayNumberedMenu(title, options) {
    // Emit menu display event
    this.emitEvent(this.eventTypes.MENU_DISPLAY, {
      question: title,
      options: this.sanitizeOptionsForEvent(options),
      menuType: 'numbered'
    });

    console.clear();
    if (title) console.log(`${title}\n`);

    const optionMap = {};
    let index = 1;
    const printOption = (option) => {
      if (option.type === 'options' && Array.isArray(option.value)) {
        console.log(option.value.map(individualOption => `${index++}. ${individualOption.name}`).join(' '));
        option.value.forEach(individualOption => optionMap[index - option.value.length + individualOption.value] = individualOption);
      }
      else if (option.type === 'text' && option.value) {
        console.log(option.value);
      }
      else if (option.name) {
        console.log(`${index}. ${option.name}`);
        optionMap[index++] = option;
      }
    };

    options.forEach(printOption);
    const choice = parseInt(await this.ask('\nChoose an option: '));
    const selected = optionMap[choice];

    if (!selected) {
      console.log('Invalid option, try again.');
      return this.displayNumberedMenu(title, options);
    }

    // Emit menu selection event
    this.emitEvent(this.eventTypes.MENU_SELECTION, {
      index: choice,
      selected: this.getOptionDataForEvent(selected),
      question: title,
      source: 'numbered'
    });
    
    if (selected.action) await selected.action();
    return selected.name;
  }

  // Menu Utilities
/**
 * Normalizes menu options to a consistent format, handling groups
 * @private
 * @param {Array<string|object|Array<string|object>>} options - Menu options
 * @returns {Array<Array<object>>} Normalized options in 2D array format
 */
normalizeOptions(options) {
  const result = [];
  
  for (const option of options) {
    if (Array.isArray(option)) {
      // Handle array of options (already flattened)
      const line = option.map(item => 
        typeof item === 'string' ? { name: item } : item
      );
      result.push(line);
    } else if (option?.type === 'options') {
      // Handle options group - flatten it into the current line
      const line = option.value.map(item => 
        typeof item === 'string' ? { name: item } : item
      );
      result.push(line);
    } else {
      // Single option
      const item = typeof option === 'string' ? { name: option } : option;
      result.push([item]);
    }
  }
  
  return result;
}

  /**
   * Converts linear index to 2D coordinates
   * @private
   * @param {Array<Array<object>>} lines - 2D array of options
   * @param {number} index - Linear index
   * @returns {{line: number, column: number}} 2D coordinates
   */
  getCoordinatesFromLinearIndex(lines, index) {
    let count = 0;
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      if (index < count + lines[lineIndex].length) {
        return { line: lineIndex, column: index - count };
      }
      count += lines[lineIndex].length;
    }
    return {
      line: lines.length - 1,
      column: lines[lines.length - 1].length - 1
    };
  }

  /**
   * Converts 2D coordinates to linear index
   * @private
   * @param {Array<Array<object>>} lines - 2D array of options
   * @param {number} line - Row index
   * @param {number} column - Column index
   * @returns {number} Linear index
   */
  getLinearIndexFromCoordinates(lines, line, column) {
    return lines.slice(0, line).reduce((sum, currentLine) => sum + currentLine.length, 0) + column;
  }

  /**
   * Sanitizes options for event emission (removes functions)
   * @private
   * @param {Array<string|object|Array<string|object>>} options - Menu options
   * @returns {Array<object|Array<object>>} Sanitized options
   */
  sanitizeOptionsForEvent(options) {
    return options.map(option => {
      if (typeof option === 'string') {
        return { name: option };
      }
      if (Array.isArray(option)) {
        return option.map(item => this.getOptionDataForEvent(item));
      }
      return this.getOptionDataForEvent(option);
    });
  }
  
 /**
 * Gets safe option data for event emission
 * @private
 * @param {string|object} option - Menu option
 * @returns {object|null} Safe option data without functions
 */
getOptionDataForEvent(option) {
  if (!option) return null;
  
  // Handle options group
  if (option.type === 'options') {
    return {
      type: 'options',
      value: option.value.map(item => this.getOptionDataForEvent(item))
    };
  }
  
  if (typeof option === 'string') {
    return { name: option };
  }
  
  // Return a safe object without functions for event emission
  const eventData = {
    name: option.name,
    type: option.type,
    value: option.value
  };
  
  // Include custom data if present
  if (option.eventData) {
    eventData.eventData = option.eventData;
  }
  if (option.metadata) {
    eventData.metadata = option.metadata;
  }
  
  return eventData;
}

  // Mouse Support (Enhanced with Wheel)

  /**
   * Safely enables mouse tracking
   * @private
   */
  safeEnableMouseTracking() {
    if (this.isMouseEnabled || !this.isInMenu) return;
    
    try {
      // Enable mouse tracking with wheel support
      stdout.write('\x1b[?1000h'); // Enable basic mouse tracking
      stdout.write('\x1b[?1002h'); // Enable cell motion tracking
      stdout.write('\x1b[?1003h'); // Enable all motion tracking (includes wheel)
      stdout.write('\x1b[?1006h'); // Enable SGR mouse mode
      this.isMouseEnabled = true;

      // Add the mouse event listener
      stdin.on('data', this.handleMouseData);
    } catch (error) {
      this.isMouseEnabled = false;
    }
  }

  /**
   * Cleans up all resources
   * @private
   */
  cleanupAll() {
    this.isInMenu = false;
    this.cleanupMouseSupport();
    
    if (this.doubleClickTimeout) {
      clearTimeout(this.doubleClickTimeout);
      this.doubleClickTimeout = null;
    }
  }

  /**
   * Resets mouse click state
   * @private
   */
  resetClickState() {
    this.lastMouseClick = { time: 0, x: -1, y: -1 };
    this.isClickInProgress = false;
    
    if (this.doubleClickTimeout) {
      clearTimeout(this.doubleClickTimeout);
      this.doubleClickTimeout = null;
    }
  }

  /**
   * Handles mouse data from terminal
   * @private
   * @param {Buffer|string} data - Raw mouse event data
   */
  handleMouseData(data) {
    if (!this.mouseSupport || !this.isInMenu || !this.currentMenuState) {
      return;
    }

    const stringData = data.toString();
    
    // Check if this is a mouse event
    if (!stringData.includes('\x1b[') || (!stringData.includes('M') && !stringData.includes('m'))) {
      return;
    }

    this.mouseEventBuffer += stringData;

    // Process SGR mouse events (modern terminal mouse protocol)
    const sgrMatch = this.mouseEventBuffer.match(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
    if (sgrMatch) {
      this.mouseEventBuffer = '';
      this.handleSGRMouseEvent(sgrMatch);
      return;
    }

    // Process X10 mouse events (legacy terminal mouse protocol)
    const x10Match = this.mouseEventBuffer.match(/\x1b\[M([\x00-\xFF]{3})/);
    if (x10Match) {
      this.mouseEventBuffer = '';
      this.handleX10MouseEvent(x10Match);
      return;
    }

    // Clear buffer if it gets too long (malformed data)
    if (this.mouseEventBuffer.length > 20) {
      this.mouseEventBuffer = '';
    }
  }

  /**
   * Handles SGR (Standard Generalized Representation) mouse events
   * @private
   * @param {Array<string>} match - Regex match groups
   */
  handleSGRMouseEvent(match) {
    const button = parseInt(match[1]);
    const x = parseInt(match[2]) - 1;
    const y = parseInt(match[3]) - 1;
    const eventType = match[4];

    // Check for mouse wheel events first (button codes 64 and 65 for wheel up/down in SGR mode)
    if (button & 64) {
      // Wheel event in SGR mode
      const isWheelDown = (button & 1) === 1;
      
      // Emit mouse wheel event
      this.emitEvent(this.eventTypes.MOUSE_WHEEL, {
        x,
        y,
        direction: isWheelDown ? 'down' : 'up',
        buttonCode: button
      });
      
      this.processMouseWheel(x, y, isWheelDown ? 'down' : 'up');
    }
    // Check for left click (button code 0 with eventType 'M')
    else if (eventType === 'M' && button === 0) {
      // Emit mouse click event
      this.emitEvent(this.eventTypes.MOUSE_CLICK, {
        x,
        y,
        button: 'left',
        buttonCode: button
      });
      
      this.processMouseClick(x, y);
    }
  }

  /**
   * Handles X10 mouse events (legacy protocol)
   * @private
   * @param {Array<string>} match - Regex match groups
   */
  handleX10MouseEvent(match) {
    const bytes = match[1];
    const button = bytes.charCodeAt(0) - 32;
    const x = bytes.charCodeAt(1) - 33;
    const y = bytes.charCodeAt(2) - 33;

    // Check for mouse wheel events in X10 mode (button codes 96 and 97 for wheel up/down)
    if (button >= 96 && button <= 97) {
      const isWheelDown = button === 97;
      
      // Emit mouse wheel event
      this.emitEvent(this.eventTypes.MOUSE_WHEEL, {
        x,
        y,
        direction: isWheelDown ? 'down' : 'up',
        buttonCode: button
      });
      
      this.processMouseWheel(x, y, isWheelDown ? 'down' : 'up');
    }
    // Check for left click (button code 0)
    else if (button === 0) {
      // Emit mouse click event
      this.emitEvent(this.eventTypes.MOUSE_CLICK, {
        x,
        y,
        button: 'left',
        buttonCode: button
      });
      
      this.processMouseClick(x, y);
    }
  }

  /**
   * Processes mouse click events
   * @private
   * @param {number} x - X coordinate of click
   * @param {number} y - Y coordinate of click
   */
  processMouseClick(x, y) {
    if (this.isClickInProgress) return;

    const { normalizedOptions, question, setFocus, selectOption } = this.currentMenuState;
    const clickedIndex = this.findOptionIndexAtCoordinates(y, x, normalizedOptions, question);

    if (clickedIndex === -1) return;

    const { line: targetLine, column: targetColumn } = this.getCoordinatesFromLinearIndex(normalizedOptions, clickedIndex);

    setFocus(targetLine, targetColumn);

    const currentTime = Date.now();
    const isDoubleClick = (currentTime - this.lastMouseClick.time < this.DOUBLE_CLICK_DELAY &&
                          this.lastMouseClick.x === x && 
                          this.lastMouseClick.y === y);

    if (isDoubleClick) {
      // Emit mouse double click event
      this.emitEvent(this.eventTypes.MOUSE_DOUBLE_CLICK, {
        x,
        y,
        button: 'left'
      });
      
      this.lastMouseClick = { time: 0, x: -1, y: -1 };
      if (this.doubleClickTimeout) {
        clearTimeout(this.doubleClickTimeout);
        this.doubleClickTimeout = null;
      }
      
      selectOption('mouse').catch(error => {
        console.error('Error in menu selection:', error);
      });
    } else {
      this.lastMouseClick = { time: currentTime, x, y };
      
      if (this.doubleClickTimeout) {
        clearTimeout(this.doubleClickTimeout);
      }
      
      this.doubleClickTimeout = setTimeout(() => {
        this.lastMouseClick = { time: 0, x: -1, y: -1 };
        this.doubleClickTimeout = null;
      }, this.DOUBLE_CLICK_DELAY);
    }
  }

  /**
   * Processes mouse wheel events for navigation
   * @private
   * @param {number} x - X coordinate of wheel event
   * @param {number} y - Y coordinate of wheel event
   * @param {'up'|'down'} direction - Wheel direction
   */
  processMouseWheel(x, y, direction) {
    if (!this.currentMenuState || !this.mouseWheel || this.isClickInProgress) {
      return;
    }

    const { normalizedOptions, setFocus, currentLine, currentColumn } = this.currentMenuState;
    
    // Accumulate wheel events to smooth out navigation
    this.wheelAccumulator += (direction === 'down' ? 1 : -1);
    
    // Only navigate when threshold is reached
    if (Math.abs(this.wheelAccumulator) >= this.WHEEL_THRESHOLD) {
      let newLine = currentLine;
      let newColumn = currentColumn;
      
      if (direction === 'down') {
        // Move down (next item)
        const linearIndex = this.getLinearIndexFromCoordinates(normalizedOptions, currentLine, currentColumn);
        const totalItems = normalizedOptions.reduce((sum, line) => sum + line.length, 0);
        
        if (linearIndex < totalItems - 1) {
          const newLinearIndex = linearIndex + 1;
          const coordinates = this.getCoordinatesFromLinearIndex(normalizedOptions, newLinearIndex);
          newLine = coordinates.line;
          newColumn = coordinates.column;
        }
      } else {
        // Move up (previous item)
        const linearIndex = this.getLinearIndexFromCoordinates(normalizedOptions, currentLine, currentColumn);
        
        if (linearIndex > 0) {
          const newLinearIndex = linearIndex - 1;
          const coordinates = this.getCoordinatesFromLinearIndex(normalizedOptions, newLinearIndex);
          newLine = coordinates.line;
          newColumn = coordinates.column;
        }
      }
      
      // Update the menu state with new position
      this.currentMenuState.currentLine = newLine;
      this.currentMenuState.currentColumn = newColumn;
      
      // Set focus to new position
      setFocus(newLine, newColumn);
      
      // Reset accumulator
      this.wheelAccumulator = 0;
    }
  }

  /**
   * Finds the menu option index at given terminal coordinates
   * @private
   * @param {number} terminalY - Terminal Y coordinate
   * @param {number} terminalX - Terminal X coordinate
   * @param {Array<Array<object>>} normalizedOptions - Normalized menu options
   * @param {string} question - Menu question/title
   * @returns {number} Index of the option or -1 if not found
   */
  findOptionIndexAtCoordinates(terminalY, terminalX, normalizedOptions, question) {
    let startRow = 0;
    if (question) {
      const questionLines = question.split('\n').length;
      startRow += questionLines + 1;
    }

    for (let row = 0; row < normalizedOptions.length; row++) {
      const actualRow = startRow + row;
      
      if (actualRow === terminalY) {
        let currentColumn = 0;
        for (let column = 0; column < normalizedOptions[row].length; column++) {
          const option = normalizedOptions[row][column];
          const text = typeof option === 'string' ? option : option.name || JSON.stringify(option);
          const textWidth = text.length;

          const optionStart = currentColumn;
          const optionEnd = currentColumn + textWidth;
          
          if (terminalX >= optionStart && terminalX <= optionEnd + 2) {
            return this.getLinearIndexFromCoordinates(normalizedOptions, row, column);
          }

          currentColumn += textWidth + 3;
        }
        break;
      }
    }

    return -1;
  }
}

// Event type definitions for JSDoc

/**
 * Event emitted when a menu is displayed
 * @event TerminalHUD#menu:display
 * @type {object}
 * @property {number} timestamp - Event timestamp
 * @property {string} question - Menu question/title
 * @property {Array<object|Array<object>>} options - Menu options (sanitized)
 * @property {object} configuration - Configuration object
 * @property {number} [initialIndex] - Initial selected index
 * @property {'arrow'|'arrow-original'|'numbered'|'numbered-from-options'} menuType - Type of menu displayed
 */

/**
 * Event emitted when a menu option is selected
 * @event TerminalHUD#menu:selection
 * @type {object}
 * @property {number} timestamp - Event timestamp
 * @property {number} index - Linear index of selected option
 * @property {number} line - Row index of selected option
 * @property {number} column - Column index of selected option
 * @property {object} selected - Selected option data (sanitized)
 * @property {string} question - Menu question/title
 * @property {'keyboard'|'mouse'|'numbered'} source - Source of selection
 * @property {object} [customData] - Custom data from option
 * @property {object} [metadata] - Metadata from option
 */

/**
 * Event emitted when navigating through menu options
 * @event TerminalHUD#menu:navigation
 * @type {object}
 * @property {number} timestamp - Event timestamp
 * @property {number} line - New row index
 * @property {number} column - New column index
 * @property {number} linearIndex - New linear index
 * @property {string} question - Menu question/title
 */

/**
 * Event emitted when a menu is closed
 * @event TerminalHUD#menu:close
 * @type {object}
 * @property {number} timestamp - Event timestamp
 */

/**
 * Event emitted when asking a question
 * @event TerminalHUD#question:ask
 * @type {object}
 * @property {number} timestamp - Event timestamp
 * @property {string} question - The question being asked
 * @property {object} configuration - Configuration object
 */

/**
 * Event emitted when a question is answered
 * @event TerminalHUD#question:answer
 * @type {object}
 * @property {number} timestamp - Event timestamp
 * @property {string} question - The question that was asked
 * @property {string} answer - The answer provided
 * @property {object} configuration - Configuration object
 */

/**
 * Event emitted when loading starts
 * @event TerminalHUD#loading:start
 * @type {object}
 * @property {number} timestamp - Event timestamp
 */

/**
 * Event emitted when loading stops
 * @event TerminalHUD#loading:stop
 * @type {object}
 * @property {number} timestamp - Event timestamp
 */

/**
 * Event emitted on mouse click
 * @event TerminalHUD#mouse:click
 * @type {object}
 * @property {number} timestamp - Event timestamp
 * @property {number} x - X coordinate of click
 * @property {number} y - Y coordinate of click
 * @property {'left'|'right'|'middle'} button - Mouse button
 * @property {number} buttonCode - Raw button code
 */

/**
 * Event emitted on mouse double click
 * @event TerminalHUD#mouse:doubleclick
 * @type {object}
 * @property {number} timestamp - Event timestamp
 * @property {number} x - X coordinate of click
 * @property {number} y - Y coordinate of click
 * @property {'left'|'right'|'middle'} button - Mouse button
 */

/**
 * Event emitted on mouse wheel scroll
 * @event TerminalHUD#mouse:wheel
 * @type {object}
 * @property {number} timestamp - Event timestamp
 * @property {number} x - X coordinate of wheel event
 * @property {number} y - Y coordinate of wheel event
 * @property {'up'|'down'} direction - Wheel direction
 * @property {number} buttonCode - Raw button code
 */

/**
 * Event emitted on key press
 * @event TerminalHUD#key:press
 * @type {object}
 * @property {number} timestamp - Event timestamp
 * @property {string} [key] - Key name (for keypress events)
 * @property {string} [sequence] - Raw key sequence
 * @property {boolean} [ctrl] - Ctrl key pressed
 * @property {boolean} [shift] - Shift key pressed
 * @property {boolean} [meta] - Meta key pressed
 * @property {boolean} [inMenu] - Whether in menu context
 * @property {string} [key] - Key character (for generic key press)
 * @property {boolean} [isCtrlC] - Whether it's Ctrl+C
 */

/**
 * Event emitted when waiting for key press
 * @event TerminalHUD#press:wait
 * @type {object}
 * @property {number} timestamp - Event timestamp
 */

/**
 * Wildcard event emitted for all events
 * @event TerminalHUD#*
 * @type {object}
 * @property {string} event - Original event name
 * @property {number} timestamp - Event timestamp
 * @property {object} [additionalData] - Original event data
 */


// --------------------------- Util interfaces --------------------------------------------


class Session {
  constructor(config = {uniqueid : undefined,machine_id : undefined,process_id : undefined,userid : undefined,external : false}){
    this.MachineID = config.machine_id || ''
    this.ProcessID = config.process_id || undefined
    this.UserID = config.userid || undefined
    this.External = config.external || false
    this.UniqueID = config.uniqueid || `${this.MachineID}-P${this.ProcessID}`
    this.ActualPath = undefined
    this.PreviousPath = undefined
    this.ActualProps = undefined
    this.PreviousProps = undefined
  }
}

class userBuild {
  constructor(data = {session : new Session}){
    this.Session = data.session || new Session()
    this.UniqueID = this.Session.UniqueID
    this.MachineID = this.Session.MachineID
    this.ProcessID = this.Session.ProcessID || undefined
    this.UserID = this.Session.UserID || undefined
    this.Text = ''
    this.Buttons = []
    this.WaitInput = false
    this.InputPath = ''
    this.InputProps = ''
    this.InputQuestion = ''
    
    // Dropdown state properties
    this.droplevel = 0
    this.dropdown_color = undefined
    this.dropdown_spacement = undefined
    this.dropdown_horizontal = undefined
    this.last_dropdown_button = undefined
  }
}

//--------------------------- SyAPP Structure start below ----------------------------------

class SyAPP_Func {
    constructor(name,build = async (props = {session : new Session}) => {},config = {routes : [{name : '',stream: false,method : '',input_model : [],output_model : []}],userid_only : false,log : false,linked : []}){
        this.Name = name
        this.Linked = config.linked || []
        this.Log = config.log || false
        this.UserID_Only = config.userid_only || false

    /** @type {Map<string, userBuild>} */
    this.Builds = new Map()

    this.UserStorage = new Map()
    this.Storages = {
    Set: (id, key, value) => {
    if (!this.UserStorage.has(id)) {
      this.UserStorage.set(id, {})
    }
    this.UserStorage.get(id)[key] = value
    return true
    },
  
    Get: (id, key) => {
    const user = this.UserStorage.get(id)
    return user ? user[key] : undefined
    },
  
    Has: (id, key) => {
    const user = this.UserStorage.get(id)
    return user ? key in user : false
    },
  
    Delete: (id, key) => {
    const user = this.UserStorage.get(id)
    if (!user) return false
    const existed = key in user
    if (existed) delete user[key]
    return existed
    },
  
    DeleteUser: (id) => {
    return this.UserStorage.delete(id)
    },
  
    GetAll: (id) => {
    const user = this.UserStorage.get(id)
    return user ? { ...user } : null
    },
  
    Update: (id, updateFn) => {
    if (!this.UserStorage.has(id)) {
      this.UserStorage.set(id, {})
    }
    const user = this.UserStorage.get(id)
    return updateFn(user)
    },
  
    SetMany: (id, data) => {
    if (!this.UserStorage.has(id)) {
      this.UserStorage.set(id, {})
    }
    const user = this.UserStorage.get(id)
    Object.assign(user, data)
    return Object.keys(data).length
   },
  
    ClearUser: (id) => {
    const user = this.UserStorage.get(id)
    if (!user) return false
    for (const key in user) {
      delete user[key]
    }
    return true
    },
  
    Count: () => {
    return this.UserStorage.size
    },
  
    GetUsers: () => {
    return Array.from(this.UserStorage.keys())
    },
  
    GetAllData: () => {
    const result = {}
    for (const [id, user] of this.UserStorage) {
      result[id] = { ...user }
    }
    return result
    },
  
  Clear: () => {
    this.UserStorage.clear()
    }
  }

      this.TextColor = ColorText

      this.WaitLog = async (message,ms = 5000) => {
        console.log(message)
        await new Promise(resolve => setTimeout(resolve, ms));
      }

      // Add this method to the SyAPP_Func class, after the DropDown method

      this.Page = async (id, name = '', code = async () => {}, config = {
        pagelabel: undefined,
        jumpTo: 1,
        lock: false,
        lockKey: undefined
      }) => {
        if (this.Builds.has(id)) {
          const userBuild = this.Builds.get(id);
          const currentProps = userBuild.Session.ActualProps || {};
          const currentPage = currentProps.page || '';
          
          if (config.lock) {
            const lockKey = config.lockKey || `page-lock-${name}`;
            const isLocked = this.Storages.Get(id, lockKey);
            
            if (isLocked && !currentProps._unlock) {
              return;
            }
            
            if (!isLocked && name === currentPage) {
              this.Storages.Set(id, lockKey, true);
            }
            
            if (currentProps._unlock === lockKey) {
              this.Storages.Clear(id, lockKey);
              delete userBuild.Session.ActualProps._unlock;
            }
          }
          
          const shouldExecute = (name === currentPage) || (name === '' && !currentPage);
          
          if (shouldExecute) {
            if (config.pagelabel) {
              this.Text(id, `• ${config.pagelabel}`);
            }
            
            await code();
          }
        } else {
          if (this.Log) {
            console.log(`this.Page() Error - userBuild not found | BuildID: ${id} | Page: ${name}`);
          }
        }
      };
      
      this.LockPage = (id, pageName, lockKey = null) => {
        if (this.Builds.has(id)) {
          const key = lockKey || `page-lock-${pageName}`;
          this.Storages.Set(id, key, true);
        }
      };
      
      this.UnlockPage = (id, pageName, lockKey = null) => {
        if (this.Builds.has(id)) {
          const key = lockKey || `page-lock-${pageName}`;
          this.Storages.Clear(id, key);
        }
      };
      
      this.IsPageLocked = (id, pageName, lockKey = null) => {
        if (this.Builds.has(id)) {
          const key = lockKey || `page-lock-${pageName}`;
          return !!this.Storages.Get(id, key);
        }
        return false;
      };



// Enhanced SetPage with unlock option
this.SetPage = (id, page, unlock = false) => {
  if (this.Builds.has(id)) {
    const userBuild = this.Builds.get(id);
    if (!userBuild.Session.ActualProps) {
      userBuild.Session.ActualProps = {};
    }
    userBuild.Session.ActualProps.page = page;
    
    // Add unlock flag if needed
    if (unlock && page) {
      userBuild.Session.ActualProps._unlock = `page-lock-${page}`;
    }
  } else {
    if (this.Log) {
      console.log(`this.SetPage() Error - userBuild not found | BuildID: ${id}`);
    }
  }
};

      this.Pagination = {
        Button: (id, name = '', data = [], config = {
          actual_page: 1,
          items_per_page: 5,
          button: {
            text: [{ type: 'text', value: 'text1' }, { type: 'key', value: 'ID' }],
            path: { type: 'text', value: 'path1' },
            props: [{ props_key: 'id', type: 'text', value: 'ID' }]
          },
          template_config: true
        }) => {
          if (data.length) {
            // Initialize return object
            let obj_return = {
              actual_page: config.actual_page || 1,
              total_pages: undefined
            }
      
            // Paginate the data
            let paginated_data = BuildPagination(data, config.items_per_page || 5)
      
            // Initialize storage for this pagination
            if (!this.Storages.Has(id, name)) {
              this.Storages.Set(id, name, {
                actual_page: config.actual_page || 1,
                total_pages: paginated_data.length
              })
            }
      
            // Get stored pagination state
            let storaged = this.Storages.Get(id, name)
            let actual_page = storaged.actual_page
      
            // Handle page navigation via props
            const currentProps = this.Builds.get(id).Session.ActualProps
            
            // Check for next page navigation
            if (currentProps.pagination_next === name) {
              if (actual_page < storaged.total_pages) {
                actual_page++
              }
              // Clear the prop after processing
              delete this.Builds.get(id).Session.ActualProps.pagination_next
            }
            
            // Check for previous page navigation
            if (currentProps.pagination_prev === name) {
              if (actual_page > 1) {
                actual_page--
              }
              // Clear the prop after processing
              delete this.Builds.get(id).Session.ActualProps.pagination_prev
            }
      
            // Update storage with new page
            storaged.actual_page = actual_page
            this.Storages.Set(id, name, storaged)
      
            // Display page info
            this.Text(id, `Page ${actual_page} of ${storaged.total_pages}`)
      
            // Get current page items
            const currentPageItems = paginated_data[actual_page - 1]?.list || []
      
            // Display items as buttons
            if (config.button && !config.template_config) {
              // Custom button configuration
              currentPageItems.forEach(item => {
                let buttonText = ''
                let buttonPath = this.Name // Default to current function
                let buttonProps = {}
      
                // Build button text
                if (config.button.text) {
                  config.button.text.forEach(textConfig => {
                    switch (textConfig.type) {
                      case 'text':
                        buttonText += textConfig.value
                        break
                      case 'key':
                        if (typeof item === 'object' && item[textConfig.value]) {
                          buttonText += item[textConfig.value]
                        }
                        break
                    }
                  })
                }
      
                // Build button path
                if (config.button.path) {
                  switch (config.button.path.type) {
                    case 'text':
                      buttonPath = config.button.path.value
                      break
                    case 'key':
                      if (typeof item === 'object' && item[config.button.path.value]) {
                        buttonPath = item[config.button.path.value]
                      }
                      break
                  }
                }
      
                // Build button props
                if (config.button.props) {
                  config.button.props.forEach(propConfig => {
                    switch (propConfig.type) {
                      case 'text':
                        buttonProps[propConfig.props_key] = propConfig.value
                        break
                      case 'key':
                        if (typeof item === 'object' && item[propConfig.value]) {
                          buttonProps[propConfig.props_key] = item[propConfig.value]
                        }
                        break
                    }
                  })
                }
      
                // Create button
                this.Button(id, {
                  name: buttonText || JSON.stringify(item),
                  path: buttonPath,
                  props: buttonProps
                })
              })
            } else {
              // Default template configuration
              currentPageItems.forEach(item => {
                let buttonName
                let buttonProps = {}
                
                if (typeof item === 'object') {
                  // Use first key-value pair for display
                  const firstKey = Object.keys(item)[0]
                  buttonName = `${firstKey}: ${item[firstKey]}`
                  
                  // Pass the entire object as props
                  buttonProps = { ...item }
                } else {
                  buttonName = item.toString()
                  buttonProps = { value: item }
                }
      
                this.Button(id, {
                  name: buttonName,
                  path: this.Name, // Stay in current function by default
                  props: buttonProps
                })
              })
            }
      
            // Add spacing between items and navigation
            this.Button(id, { name: ' ' })
      
            // Add navigation buttons
            if (actual_page > 1) {
              this.SideButton(id, {
                name: '<- Prev',
                props: { pagination_prev: name }
              })
            }
      
            if (actual_page < storaged.total_pages) {
              this.SideButton(id, {
                name: 'Next ->',
                props: { pagination_next: name }
              })
            }
      
            // Return pagination info
            return {
              actual_page: actual_page,
              total_pages: storaged.total_pages
            }
      
          } else {
            if (this.Log) {
              console.log(`This.Pagination.Button() Error - Empty Data Array | BuildID: ${id}`)
            }
            return {
              actual_page: 0,
              total_pages: 0
            }
          }
        }
      }
      
      this.DropDown = async (id, name, code = async () => {}, config = {
        up_buttontext: 'Show More',
        down_buttontext: 'Hide',
        down_emoji: '▼',
        up_emoji: '▶',
        open_colors: true,
        open_spacement: true,
        horizontal: false, // NEW: Open to the right instead of down
        jumpTo : 1
      }) => {
        const storageKey = `dropdown-${name}`;
      
        // Set defaults for all config options
        config = {
          up_buttontext: 'Show More',
          down_buttontext: 'Hide',
          down_emoji: '▼',
          up_emoji: '▶',
          open_colors: true,
          open_spacement: true,
          horizontal: false,
          ...config
        };
      
        // Adjust emojis for horizontal mode if using defaults
        if (config.horizontal) {
          if (config.down_emoji === '▼') config.down_emoji = '▶';
          if (config.up_emoji === '▶') config.up_emoji = '⧾';
        }
      
        // Initialize or get state
        if (!this.Storages.Has(id, storageKey)) {
          this.Storages.Set(id, storageKey, { dropped: false });
        }
      
        const state = this.Storages.Get(id, storageKey);
        const wasClicked = this.Builds.get(id).Session.ActualProps.droprun === storageKey;
      
        // Toggle if clicked
        if (wasClicked) {
          state.dropped = !state.dropped;
          this.Storages.Set(id, storageKey, state);
        }
      
        // Store current dropdown state for nested dropdowns
        const wasHorizontal = this.Builds.get(id).dropdown_horizontal;
        const wasSpacement = this.Builds.get(id).dropdown_spacement;
        const wasColors = this.Builds.get(id).dropdown_color;
        const wasDroplevel = this.Builds.get(id).droplevel || 0;
      
        // Render button and content
        if (state.dropped) {
          if (config.horizontal) {
            // In horizontal mode, we need to handle rendering differently
            this.Button(id, {
              name: this.TextColor.orange(`${config.down_emoji} ${config.down_buttontext}`),
              props: { droprun: storageKey }
            });
      
            // Store current button index for horizontal layout
            const currentButtonCount = this.Builds.get(id).Buttons.length;
            this.Builds.get(id).last_dropdown_button = currentButtonCount - 1;
      
            // Apply horizontal configuration
            this.Builds.get(id).dropdown_horizontal = true;
            if (config.open_colors) this.Builds.get(id).dropdown_color = true;
            if (config.open_spacement) this.Builds.get(id).dropdown_spacement = true;
            this.Builds.get(id).droplevel = (wasDroplevel > 0) ? wasDroplevel + 1 : 1;
      
            // Execute the dropdown content code
            await code();
      
            // Reset to previous state
            this.Builds.get(id).dropdown_horizontal = wasHorizontal;
            if (config.open_colors && this.Builds.get(id).droplevel === 1) {
              this.Builds.get(id).dropdown_color = undefined;
            }
            if (config.open_spacement && this.Builds.get(id).droplevel === 1) {
              this.Builds.get(id).dropdown_spacement = undefined;
            }
            this.Builds.get(id).droplevel = this.Builds.get(id).droplevel - 1;
            this.Builds.get(id).last_dropdown_button = undefined;
          } else {
            // Original vertical dropdown behavior
            this.Button(id, {
              name: this.TextColor.orange(`${config.down_emoji} ${config.down_buttontext}`),
              props: { droprun: storageKey }
            });
      
            // Apply vertical configuration
            if (config.open_colors) this.Builds.get(id).dropdown_color = true;
            if (config.open_spacement) this.Builds.get(id).dropdown_spacement = true;
            this.Builds.get(id).droplevel = (wasDroplevel > 0) ? wasDroplevel + 1 : 1;
      
            await code();
      
            // Reset to previous state
            if (config.open_colors && this.Builds.get(id).droplevel === 1) {
              this.Builds.get(id).dropdown_color = undefined;
            }
            if (config.open_spacement && this.Builds.get(id).droplevel === 1) {
              this.Builds.get(id).dropdown_spacement = undefined;
            }
            this.Builds.get(id).droplevel = this.Builds.get(id).droplevel - 1;
          }
        } else {
          // Closed state - show "Show More" button
          const emoji = config.horizontal ? config.up_emoji : config.up_emoji;
          this.Button(id, {
            name: this.TextColor.gold(`${emoji} ${config.up_buttontext}`),
            props: { droprun: storageKey },
            jumpTo: config.jumpTo !== undefined ? config.jumpTo : 1  // Fixed: allow 0 as valid value
          });
        }
      
        // Restore previous state if we're exiting a nested dropdown
        if (wasDroplevel === 0 && this.Builds.get(id).droplevel === 0) {
          this.Builds.get(id).dropdown_horizontal = wasHorizontal;
          this.Builds.get(id).dropdown_color = wasColors;
          this.Builds.get(id).dropdown_spacement = wasSpacement;
        }
      };

      this.Button = (id, config = {name: undefined, path: this.Name, props: {}, action: () => {},jumpTo : false ,resetSelection: false, buttons: false}) => {
        if (this.Builds.has(id)) {
          if (typeof config === 'string') {
            config = { name: config };
          }
          if (!config.path) { config.path = this.Name }
          
          let button_obj = {
            name: config.name || '',
            metadata: { props: config.props || {}, path: config.path || this.Name, resetSelection: config.resetSelection || false ,jumpTo: config.jumpTo || false },
            action: (config.action) ? config.action : () => {},
          }
      
          // Apply dropdown styling
          if (this.Builds.get(id).dropdown_color) {
            button_obj.name = this.TextColor.rgb(
              button_obj.name,
              (127 + Math.floor(Math.sin(this.Builds.get(id).droplevel * 1.7) * 128)),
              (127 + Math.floor(Math.cos(this.Builds.get(id).droplevel * 2.3) * 128)),
              (127 + Math.floor(Math.sin(this.Builds.get(id).droplevel * 1.3 + 1.5) * 128))
            );
          }
      
          if (this.Builds.get(id).dropdown_spacement) {
            let space = '';
            for (let i = 0; i < this.Builds.get(id).droplevel; i++) {
              space = ` ${space}`;
            }
            button_obj.name = `${space}${button_obj.name}`;
          }
      
          // Handle horizontal dropdown layout
          if (this.Builds.get(id).dropdown_horizontal && 
              this.Builds.get(id).last_dropdown_button !== undefined) {
            
            const buttonsArray = this.Builds.get(id).Buttons;
            const lastDropdownIndex = this.Builds.get(id).last_dropdown_button;
            
            // Find the position to insert (right after the dropdown button)
            let insertIndex = lastDropdownIndex + 1;
            let foundGroup = false;
            
            // Look for an existing options group to add to
            for (let i = lastDropdownIndex + 1; i < buttonsArray.length; i++) {
              if (buttonsArray[i].type === 'options') {
                // Add to existing group for horizontal layout
                buttonsArray[i].value.push(button_obj);
                foundGroup = true;
                break;
              }
            }
            
            if (!foundGroup) {
              // Create new group starting from the dropdown button
              // Move existing dropdown button into a group if it's not already
              if (lastDropdownIndex >= 0 && lastDropdownIndex < buttonsArray.length) {
                const dropdownButton = buttonsArray[lastDropdownIndex];
                
                // If the dropdown button is standalone, convert it to a group
                if (!dropdownButton.type) {
                  const newGroup = {
                    type: 'options',
                    value: [dropdownButton, button_obj]
                  };
                  buttonsArray[lastDropdownIndex] = newGroup;
                } else if (dropdownButton.type === 'options') {
                  // Add to existing dropdown button's group
                  dropdownButton.value.push(button_obj);
                }
              }
            }
            
          } else if (config.buttons) {
            // Original grouped buttons behavior (for vertical layout)
            const buttonsArray = this.Builds.get(id).Buttons;
            if (buttonsArray.length === 0 || !buttonsArray[buttonsArray.length - 1].type) {
              buttonsArray.push({ type: 'options', value: [button_obj] });
            } else if (buttonsArray[buttonsArray.length - 1].type === 'options') {
              buttonsArray[buttonsArray.length - 1].value.push(button_obj);
            } else {
              buttonsArray.push({ type: 'options', value: [button_obj] });
            }
          } else {
            // Single button
            this.Builds.get(id).Buttons.push(button_obj);
          }
        } else {
          if (this.Log) {
            console.log(`This.Button() Error - userBuild not founded | BuildID: ${id}`);
          }
        }
      };

      this.Buttons = (id, configs = []) => {
        if (!Array.isArray(configs)) {
            configs = [configs];
        }
        configs.forEach(config => {
           
            this.Button(id, {
                ...config,
                buttons: true  
            });
        });
    };

    this.SideButton = (id, config = {}) => {
      this.Button(id, {
          ...config,
          buttons: true 
      });
  };
    
      this.Text = (id,text,config = {}) => {
        if(this.Builds.has(id)){
          if(this.Builds.get(id).Text != ''){
            this.Builds.get(id).Text = `${this.Builds.get(id).Text}\n${text}`
          } else {
            this.Builds.get(id).Text = text
          }
            
        } else {
            if(this.Log){console.log(`This.Text() Error - userBuild not founded | Text : ${text} | BuildID : ${id} | Path : ${path}`)}
        }

      }

     this.WaitInput = (id,config = {path : this.Name,props : {},question : ''}) => {
      this.Builds.get(id).WaitInput = true
      this.Builds.get(id).InputPath = config.path || this.Name
      this.Builds.get(id).InputProps = config.props || {}
      this.Builds.get(id).InputQuestion = config.question || ''
     } 


      this.Build = async (props = {session : new Session}) => {
        this.Builds.set(props.session.UniqueID,new userBuild({session : props.session}))
        await build(props) //handle .catch aqui
        let obj_return = {
          hud_obj : {
            title : this.Builds.get(props.session.UniqueID).Text,
            options : this.Builds.get(props.session.UniqueID).Buttons
          },
          wait_input : this.Builds.get(props.session.UniqueID).WaitInput,
          input_obj : {
            path : this.Builds.get(props.session.UniqueID).InputPath,
            props : this.Builds.get(props.session.UniqueID).InputProps,
            question : this.Builds.get(props.session.UniqueID).InputQuestion
          }
        }
        this.Builds.delete(props.session.UniqueID)
        return obj_return
      }

      }
}

class NotFounded extends SyAPP_Func {
  constructor(){
    super(
      'notfounded',
      async (props) => {
      let uid = props.session.UniqueID
      this.Text(uid,`Func ${this.TextColor.brightRed(props.notfounded_func)} not founded !`)
      this.Button(uid,{name : '← Return',path : props.session.PreviousPath,props : props.session.PreviousProps})

      }
    )
  }
}

class Error extends SyAPP_Func {
  constructor(){
    super(
      'error',
      async (props) => {
      let uid = props.session.UniqueID
      this.Text(uid,`Internal error loading ${this.TextColor.brightRed(props.error_func)}\n`)
      //await this.WaitLog(props.error_message,5000)
      if(props.error_message){this.Text(uid,props.error_message.toString())}
      this.SideButton(uid,{name : '← Return',path : props.session.PreviousPath})
      this.SideButton(uid,{name : '⌂ Main Func',path : props.mainfunc})
      }
    )
  }
}

class TemplateFunc extends SyAPP_Func {
  constructor(){
    super(
      'templatefunc',
      async (props) => {
      let uid = props.session.UniqueID
      
      //await this.WaitLog(props,2000)
      
      if(props.errorforce){
        this.Text(d)
      }

      if(props.inputnumero){
        this.WaitInput(uid)
      }

      if(props.inputValue){
        this.Text(uid,`Numero digitado : ${props.inputValue}`)
      }

      this.Text(uid,'Hello World')
      this.Button(uid,{name : 'Button 1'})
      this.Buttons(uid,[
        {name : 'Error',props : {errorforce : true}},
        {name : 'Inexistent Func',path : 'dasded'}
      ])
      await this.DropDown(uid,'drop1',async () =>{
        this.Button(uid,{name : 'opa'})
        await this.DropDown(uid,'drop2',async () => {
          this.Button(uid,{name : 'testing1'})
          await this.DropDown(uid,'drop3',() => {
            this.Button(uid,{name : 'maisum1'})
            this.Button(uid,{name : 'outro'})
          })
          this.Button(uid,{name : 'testing2'})
        })
        this.Button(uid,{name : 'opa 2'})
      })
      await this.DropDown(uid,'drop55',async () =>{

        this.Button(uid,{name : 'dsdsdasd'})
        this.Button(uid,{name : 'dsddfsdd'})
        this.Button(uid,{name : 'dsdfsddasd'})
      })

      this.Button(uid,{name : 'Button 4',resetSelection : true})
      await this.DropDown(uid,'lateral',async () =>{

        this.Button(uid,{name : 'dsdsdasd'})
        this.Button(uid,{name : 'dsdfsddasd'})
      },{horizontal : true})
      this.Button(uid,{name : 'Button 5',props : {testando : true}})
      if(props.testando){
        this.Button(uid,{name : 'Button 6'})
      }

      this.Button(uid,{name : 'Inserir numero',props : {inputnumero : true}})
      

      }
    )
  }
}


class SyAPP {
  constructor(config = {mainfunc : TemplateFunc, userid_only : false}){
      this.HUD = new TerminalHUD()
      
      this.MainFunc = {Func : config.mainfunc || TemplateFunc,Name : undefined}
      this.MainFunc.Name = new this.MainFunc.Func().Name
      
      /** @type {Map<string, SyAPP_Func>} */
      this.Funcs = new Map()
      
      this.MainSessionID = `${getMachineID()}-P${process.pid}`

      /** @type {Map<string, Session>} */
      this.Sessions = new Map([[this.MainSessionID, new Session({
          machine_id: getMachineID(),
          process_id: process.pid
      })]])

      this.WaitLog = async (message,ms = 5000) => {
        console.log(message)
        await new Promise(resolve => setTimeout(resolve, ms));
      }

    this.ProcessFuncs = (FuncClass) => {
          const tempInstance = new FuncClass()
          const funcName = tempInstance.Name
          
          if (this.Funcs.has(funcName)) {
              return
          }
          
          const instance = new FuncClass()
          this.Funcs.set(funcName, instance)
          
          instance.Linked.forEach(linkedFunc => {
              const linkedTemp = new linkedFunc()
              if (!this.Funcs.has(linkedTemp.Name)) {
                  this.ProcessFuncs(linkedFunc)
              }
          })
      }

      this.ProcessFuncs(this.MainFunc.Func)
      this.ProcessFuncs(NotFounded)
      this.ProcessFuncs(Error)

      this.LoadScreen = async (funcname = this.MainFunc.Name,config = {jumpTo : false,resetSelection : false,props : {}}) => { 
        if(!config.props){config.props = {}}

        if(!this.Funcs.has(funcname)){
          config.props.notfounded_func = funcname
          funcname = 'notfounded'
        }
          config.props.mainfunc = this.MainFunc.Name

          this.Sessions.get(this.MainSessionID).PreviousPath = this.Sessions.get(this.MainSessionID).ActualPath
          this.Sessions.get(this.MainSessionID).ActualPath = funcname
          this.Sessions.get(this.MainSessionID).PreviousProps = this.Sessions.get(this.MainSessionID).ActualProps
          config.props.session = this.Sessions.get(this.MainSessionID)
          this.Sessions.get(this.MainSessionID).ActualProps = config.props
          
          await this.Funcs.get(funcname).Build(config.props)
          .then(async return_obj => {

           //after let it more robust and with func optional config to force inverse of it check
            if (config.props) {
              if (config.props.session) {
               if (config.props.session.ActualPath && config.props.session.PreviousPath) {
                  if (config.props.session.ActualPath != config.props.session.PreviousPath) {
                    config.resetSelection = true
                  }
              }
            }
          }
            
            this.HUD.displayMenu(return_obj.hud_obj,{remember : (!config.resetSelection) ? true : false,jumpToIndex : (!config.jumpTo) ? undefined : config.jumpTo})
            .catch(e => {
              this.LoadScreen('error',{props : {error_message : e,error_func : funcname,mainfunc : this.MainFunc.Name}})
            })
            if(return_obj.wait_input){
              let response = await this.HUD.ask(return_obj.input_obj.question || 'Type : ')
              .catch(e => {
                this.LoadScreen('error',{props : {error_message : e,error_func : funcname,mainfunc : this.MainFunc.Name}})
              })
              this.LoadScreen(return_obj.input_obj.path,{props : {inputValue : response,...return_obj.input_obj.props}})
            }
          })
          .catch(e => {
            this.LoadScreen('error',{props : {error_message : e,error_func : funcname,mainfunc : this.MainFunc.Name}})
          })
          
      }

    // In the SyAPP constructor, replace the HUD.on menu selection handler:

this.HUD.on(this.HUD.eventTypes.MENU_SELECTION, (e) => {
  // Get current session props before navigation
  const currentSession = this.Sessions.get(this.MainSessionID);
  const currentProps = currentSession.ActualProps || {};
  const currentPage = currentProps.page || '';
  
  // Merge current page with new props if not explicitly overridden
  const newProps = e.metadata.props || {};
  
  // If the new props don't have a 'page' property, preserve the current page
  if (!('page' in newProps) && currentPage) {
    newProps.page = currentPage;
  }
  
  this.LoadScreen(e.metadata.path, {
    jumpTo: e.metadata.jumpTo || false,
    resetSelection: e.metadata.resetSelection || false,
    props: newProps
  }).catch(er => {
    this.LoadScreen('error', {
      props: {
        error_message: er,
        error_func: e.metadata.path,
        mainfunc: this.MainFunc.Name
      }
    });
  });
});

      this.LoadScreen()
  }

static Func(){return SyAPP_Func}

}

class MyFunction extends SyAPP_Func {
  constructor() {
    super(
      'myfunction',
      async (props) => {
        const uid = props.session.UniqueID;
        
        await this.Page(uid,'',async () => {
          this.Text(uid,'Main menu')
          this.Button(uid,{name : 'Pagina 1',props : {page : 'page1'}})
          this.Button(uid,{name : 'Pagina 2',props : {page : 'page2'}})
        })

        await this.Page(uid,'page1',async () => {
          this.Text(uid,'PAGINA 1')
          this.Button(uid,{name : 'Button test'})
          this.Button(uid,{name : 'Button test'})
          this.Button(uid,{name : '<- voltar',props : {page : ''}})
        })

        await this.Page(uid,'page2',async () => {
          this.Text(uid,'PAGINA 2')
          this.Button(uid,{name : 'Button test'})
          this.Button(uid,{name : 'Button test'})
          this.Button(uid,{name : '<- voltar',props : {page : ''}})
        })
      
      }
    );
  }
}

// If this file is run directly, execute the CLI
if (import.meta.url === `file://${process.argv[1]}`) {
    new SyAPP({mainfunc : MyFunction})
}


export default SyAPP