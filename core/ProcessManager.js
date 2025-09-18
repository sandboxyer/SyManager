import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);

const PROCESS_REGISTRY = path.resolve('./processes.json');
const LOG_DIR = path.resolve('./logs');

// Ensure logs directory and registry file exist
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR);
if (!fs.existsSync(PROCESS_REGISTRY)) fs.writeFileSync(PROCESS_REGISTRY, '[]', 'utf-8');

class ProcessManager {
    static _loadRegistry() {
        const raw = fs.readFileSync(PROCESS_REGISTRY, 'utf-8');
        return JSON.parse(raw);
    }

    static _saveRegistry(data) {
        fs.writeFileSync(PROCESS_REGISTRY, JSON.stringify(data, null, 2));
    }

    static _generateId() {
        return Math.random().toString(36).substr(2, 9);
    }

    static _generateProcessName() {
        return `process_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    }

    static run(filepath, name = null) {
        const resolvedPath = path.resolve(filepath);
        const id = this._generateId();
        const processName = name || this._generateProcessName();
        const logPath = path.join(LOG_DIR, `${processName}.log`);

        const logFileDescriptor = fs.openSync(logPath, 'a');

        const child = spawn(process.execPath, [resolvedPath], {
            detached: true,
            stdio: ['ignore', logFileDescriptor, logFileDescriptor]
        });

        child.unref();

        const entry = {
            id,
            pid: child.pid,
            name: processName,
            path: resolvedPath,
            log: logPath,
            createdAt: new Date().toISOString(),
            status: 'running' // Track process status
        };

        const registry = this._loadRegistry();
        registry.push(entry);
        this._saveRegistry(registry);

        return entry;
    }

    static list() {
        const registry = this._loadRegistry();
        const cleanedRegistry = [];
        
        // Check each process and clean up dead ones
        for (const process of registry) {
            // Skip processes that are in the middle of a restart
            if (process.status === 'restarting') {
                cleanedRegistry.push({
                    status: 'Restarting',
                    id: process.id,
                    name: process.name
                });
                continue;
            }
            
            const isAlive = this.isAlive(process.id);
            
            if (isAlive) {
                cleanedRegistry.push({
                    status: 'Running',
                    id: process.id,
                    name: process.name
                });
            } else {
                // Remove dead process from registry
                this._removeFromRegistry(process.id);
                console.log(`Removed dead process: ${process.name} (ID: ${process.id})`);
                
                // Try to clean up log file
                try {
                    if (fs.existsSync(process.log)) {
                        fs.unlinkSync(process.log);
                    }
                } catch (error) {
                    // Ignore errors when deleting log files
                }
            }
        }
        
        return cleanedRegistry;
    }

    static _removeFromRegistry(id) {
        const registry = this._loadRegistry();
        const index = registry.findIndex(process => process.id === id);
        
        if (index !== -1) {
            registry.splice(index, 1);
            this._saveRegistry(registry);
        }
    }

    static _updateProcessStatus(id, status) {
        const registry = this._loadRegistry();
        const index = registry.findIndex(process => process.id === id);
        
        if (index !== -1) {
            registry[index].status = status;
            this._saveRegistry(registry);
            return true;
        }
        
        return false;
    }

    static kill(pidOrId) {
        const registry = this._loadRegistry();
        const index = registry.findIndex(process => process.pid === pidOrId || process.id === pidOrId);
    
        if (index === -1) {
            console.error('Process not found in registry.');
            return false;
        }
    
        const entry = registry[index];
        const processId = entry.pid;
    
        // Try to kill the process if it's alive
        let wasRunning = false;
        try {
            process.kill(processId, 0); // Check if it exists
            process.kill(processId);    // Try to kill it
            wasRunning = true;
            console.log(`Killed process PID ${processId}`);
        } catch (error) {
            if (error.code === 'ESRCH') {
                console.warn(`Process PID ${processId} is not running (already exited).`);
            } else {
                console.error(`Error killing process PID ${processId}:`, error.message);
                return false;
            }
        }
    
        // Remove from registry
        registry.splice(index, 1);
        this._saveRegistry(registry);
    
        // Remove log file
        try {
            if (fs.existsSync(entry.log)) {
                fs.unlinkSync(entry.log);
                console.log(`Deleted log file: ${entry.log}`);
            }
        } catch (error) {
            console.warn(`Could not delete log file: ${entry.log}`, error.message);
        }
    
        return true;
    }
    
    static isAlive(pidOrId) {
        const registry = this._loadRegistry();
        const entry = registry.find(process => process.pid === pidOrId || process.id === pidOrId);
    
        if (!entry) return false;
    
        const processId = entry.pid;
    
        // First: Check if the process exists
        try {
            process.kill(processId, 0); // Works on Windows & Unix
        } catch (error) {
            return false; // Process doesn't exist or no permission
        }
    
        // Second: Try to verify it's a Node.js process
        try {
            const platform = os.platform();
    
            if (platform === 'win32') {
                const output = execSync(`wmic process where ProcessId=${processId} get CommandLine`, { encoding: 'utf-8' });
                return output.toLowerCase().includes('node');
            } else {
                const output = fs.readFileSync(`/proc/${processId}/cmdline`, 'utf-8');
                return output.includes('node');
            }
        } catch (error) {
            // Could not verify command line, fallback to basic liveness check
            return true;
        }
    }

    static log(pidOrId) {
        const registry = this._loadRegistry();
        const entry = registry.find(process => process.pid === pidOrId || process.id === pidOrId);

        if (!entry) {
            console.error('Process not found.');
            return;
        }

        const logPath = entry.log;

        let lastSize = 0;

        fs.stat(logPath, (error, stats) => {
            if (error) {
                console.error('Could not stat log file:', error.message);
                return;
            }
            lastSize = stats.size;
        });

        setInterval(() => {
            fs.stat(logPath, (error, stats) => {
                if (error) return;

                if (stats.size > lastSize) {
                    const stream = fs.createReadStream(logPath, {
                        start: lastSize,
                        end: stats.size
                    });

                    stream.on('data', chunk => {
                        process.stdout.write(chunk.toString());
                    });

                    lastSize = stats.size;
                }
            });
        }, 500);
    }

    static restart(pidOrId) {
        const registry = this._loadRegistry();
        const index = registry.findIndex(process => process.pid === pidOrId || process.id === pidOrId);
    
        if (index === -1) {
            console.error('Process not found in registry.');
            return false;
        }
    
        const entry = registry[index];
        const processId = entry.pid;
        
        // Mark process as restarting to prevent accidental removal
        this._updateProcessStatus(entry.id, 'restarting');
    
        // Try to kill the process if it's alive
        try {
            process.kill(processId, 0); // Check if it exists
            process.kill(processId);    // Try to kill it
            console.log(`Killed process PID ${processId} for restart`);
        } catch (error) {
            if (error.code !== 'ESRCH') {
                console.warn(`Process PID ${processId} may not be running:`, error.message);
            }
        }
        
        // Wait a moment for the process to fully exit
        setTimeout(() => {
            // Start a new process with the same configuration
            const logFileDescriptor = fs.openSync(entry.log, 'a');
            
            const child = spawn(process.execPath, [entry.path], {
                detached: true,
                stdio: ['ignore', logFileDescriptor, logFileDescriptor]
            });
    
            child.unref();
            
            // Update registry with new PID and status
            registry[index].pid = child.pid;
            registry[index].status = 'running';
            this._saveRegistry(registry);
            
            console.log(`Restarted process: ${entry.name} (New PID: ${child.pid}, ID: ${entry.id})`);
        }, 500);
        
        return true;
    }

    static displayHelp() {
        console.log(`
Process Manager CLI Usage:
  node ProcessManager [command] [options]

Commands:
  --run <file>          Run a Node.js script as a background process
  --list                List all managed processes (shows status, ID, and name)
  --kill <pid|id>       Kill a process by PID or ID
  --restart <pid|id>    Restart a process by PID or ID
  --alive <pid|id>      Check if a process is alive
  --log <pid|id>        Follow logs of a process
  --help                Display this help message

Options:
  --name <name>         Specify a name for the process (used with --run)
        `);
    }

    static parseArguments() {
        const args = process.argv.slice(2);
        
        if (args.length === 0 || args.includes('--help')) {
            this.displayHelp();
            return;
        }

        if (args.includes('--list')) {
            const processes = this.list();
            console.log('Managed Processes:');
            if (processes.length === 0) {
                console.log('No running processes found.');
            } else {
                console.table(processes);
            }
            return;
        }

        if (args.includes('--run')) {
            const runIndex = args.indexOf('--run');
            if (runIndex + 1 >= args.length || args[runIndex + 1].startsWith('--')) {
                console.error('Error: --run requires a file path');
                return;
            }
            
            const filePath = args[runIndex + 1];
            let name = null;
            
            if (args.includes('--name')) {
                const nameIndex = args.indexOf('--name');
                if (nameIndex + 1 < args.length && !args[nameIndex + 1].startsWith('--')) {
                    name = args[nameIndex + 1];
                }
            }
            
            const result = this.run(filePath, name);
            console.log(`Started process: ${result.name} (PID: ${result.pid}, ID: ${result.id})`);
            return;
        }

        if (args.includes('--kill')) {
            const killIndex = args.indexOf('--kill');
            if (killIndex + 1 >= args.length || args[killIndex + 1].startsWith('--')) {
                console.error('Error: --kill requires a PID or ID');
                return;
            }
            
            const pidOrId = args[killIndex + 1];
            this.kill(pidOrId);
            return;
        }

        if (args.includes('--restart')) {
            const restartIndex = args.indexOf('--restart');
            if (restartIndex + 1 >= args.length || args[restartIndex + 1].startsWith('--')) {
                console.error('Error: --restart requires a PID or ID');
                return;
            }
            
            const pidOrId = args[restartIndex + 1];
            this.restart(pidOrId);
            return;
        }

        if (args.includes('--alive')) {
            const aliveIndex = args.indexOf('--alive');
            if (aliveIndex + 1 >= args.length || args[aliveIndex + 1].startsWith('--')) {
                console.error('Error: --alive requires a PID or ID');
                return;
            }
            
            const pidOrId = args[aliveIndex + 1];
            const isAlive = this.isAlive(pidOrId);
            console.log(`Process ${pidOrId} is ${isAlive ? 'alive' : 'not alive'}`);
            return;
        }

        if (args.includes('--log')) {
            const logIndex = args.indexOf('--log');
            if (logIndex + 1 >= args.length || args[logIndex + 1].startsWith('--')) {
                console.error('Error: --log requires a PID or ID');
                return;
            }
            
            const pidOrId = args[logIndex + 1];
            console.log(`Following logs for process ${pidOrId}. Press Ctrl+C to stop.`);
            this.log(pidOrId);
            return;
        }

        console.error('Error: Unknown command or invalid arguments');
        this.displayHelp();
    }
}

if (process.argv[1] === __filename) {
    ProcessManager.parseArguments();
}

export default ProcessManager;