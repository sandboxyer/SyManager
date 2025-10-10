import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);

const PROCESS_REGISTRY = path.resolve('./processes.json');
const LOG_DIR = path.resolve('./logs');

// Ensure directories exist
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

    static _getAllChildPids(pid) {
        const childPids = [];
        try {
            if (os.platform() === 'win32') {
                // Windows - get all child processes
                const output = execSync(`wmic process where (ParentProcessId=${pid}) get ProcessId 2>nul`, { encoding: 'utf-8' });
                const pids = output.split('\n')
                    .filter(line => line.trim() && !isNaN(parseInt(line.trim())))
                    .map(pid => parseInt(pid.trim()));
                childPids.push(...pids);
               
                // Recursively get children of children
                for (const childPid of pids) {
                    childPids.push(...this._getAllChildPids(childPid));
                }
            } else {
                // Unix - get all child processes
                const output = execSync(`pgrep -P ${pid} 2>/dev/null`, { encoding: 'utf-8' });
                const pids = output.split('\n')
                    .filter(line => line.trim())
                    .map(pid => parseInt(pid.trim()));
                childPids.push(...pids);
               
                // Recursively get children of children
                for (const childPid of pids) {
                    childPids.push(...this._getAllChildPids(childPid));
                }
            }
        } catch (error) {
            // No child processes or command failed
        }
        return childPids;
    }

    static _killProcessTree(pid) {
        let killedCount = 0;
       
        try {
            // Get all child processes recursively
            const allPids = this._getAllChildPids(pid);
           
            // Kill all children first (from deepest to shallowest)
            const pidsToKill = [...allPids, pid];
           
            for (const processPid of pidsToKill) {
                try {
                    process.kill(processPid, 'SIGKILL');
                    killedCount++;
                } catch (error) {
                    if (error.code !== 'ESRCH') {
                        // Process doesn't exist, that's fine
                    }
                }
            }
           
            // Force kill on Windows if needed
            if (os.platform() === 'win32' && killedCount === 0) {
                try {
                    execSync(`taskkill /pid ${pid} /T /F 2>nul`);
                    killedCount = 1;
                } catch (error) {
                    // Ignore errors
                }
            }
        } catch (error) {
            // Ignore errors in process tree killing
        }
       
        return killedCount > 0;
    }

    static _createMonitorScript(processId, filePath, processName, logPath, autoRestart, restartTries) {
        const scriptContent = `#!/usr/bin/env bash
PROCESS_ID="${processId}"
FILE_PATH="${filePath}"
PROCESS_NAME="${processName}"
LOG_PATH="${logPath}"
AUTO_RESTART="${autoRestart}"
RESTART_TRIES="${restartTries}"
CURRENT_TRIES=0
MAX_RETRIES=${restartTries > 0 ? restartTries : 999999}
REGISTRY_FILE="${PROCESS_REGISTRY}"
MONITOR_PID=$$

cleanup() {
    echo "\$(date +'%Y-%m-%d %H:%M:%S') - MONITOR STOPPED - Process: \$PROCESS_NAME" >> "\$LOG_PATH"
    update_registry "dead" "null"
    exit 0
}

trap cleanup SIGINT SIGTERM

echo "\$(date +'%Y-%m-%d %H:%M:%S') - MONITOR STARTED - Process: \$PROCESS_NAME (ID: \$PROCESS_ID)" >> "\$LOG_PATH"

# Function to update registry
update_registry() {
    local status="\\$1"
    local node_pid="\\$2"
    node -e "
    const fs = require('fs');
    const path = require('path');
    const registryPath = '${PROCESS_REGISTRY}';
    try {
        const registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
        const processIndex = registry.findIndex(p => p.id === '${processId}');
        if (processIndex !== -1) {
            registry[processIndex].status = '\$status';
            if ('\$node_pid' && '\$node_pid' !== 'null') {
                registry[processIndex].pid = parseInt('\$node_pid');
            }
            registry[processIndex].monitorPid = \$MONITOR_PID;
            registry[processIndex].config.currentTries = \$CURRENT_TRIES;
            registry[processIndex].lastUpdate = new Date().toISOString();
            fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));
        }
    } catch (error) {
        // Registry might be temporarily unavailable
    }
    " 2>/dev/null || true
}

# Function to check if we should continue monitoring
should_continue_monitoring() {
    node -e "
    const fs = require('fs');
    const path = require('path');
    const registryPath = '${PROCESS_REGISTRY}';
    try {
        const registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
        const process = registry.find(p => p.id === '${processId}');
        if (!process || process.status === 'stopped' || process.status === 'dead') {
            process.exit(1);
        }
        process.exit(0);
    } catch (e) {
        process.exit(1);
    }
    " 2>/dev/null
    return \\$?
}

# Function to start the Node.js process
start_node_process() {
    echo "\$(date +'%Y-%m-%d %H:%M:%S') - STARTING NODE PROCESS - Attempt: \$((CURRENT_TRIES + 1))/\$MAX_RETRIES" >> "\$LOG_PATH"
   
    # Start Node.js process
    node "\$FILE_PATH" >> "\$LOG_PATH" 2>&1 &
    NODE_PID=\$!
   
    # Update registry with running status and actual Node.js PID
    update_registry "running" "\$NODE_PID"
   
    echo "\$(date +'%Y-%m-%d %H:%M:%S') - NODE PROCESS STARTED - PID: \$NODE_PID" >> "\$LOG_PATH"
   
    # Wait for the Node.js process to exit
    wait \$NODE_PID
    NODE_EXIT_CODE=\$?
   
    echo "\$(date +'%Y-%m-%d %H:%M:%S') - NODE PROCESS EXITED - Code: \$NODE_EXIT_CODE" >> "\$LOG_PATH"
   
    return \$NODE_EXIT_CODE
}

# Main monitor loop
monitor_loop() {
    while true; do
        if ! should_continue_monitoring; then
            echo "\$(date +'%Y-%m-%d %H:%M:%S') - MONITOR STOPPED BY REGISTRY" >> "\$LOG_PATH"
            break
        fi
        
        # Start the Node.js process and wait for it to complete
        start_node_process
        NODE_EXIT_CODE=\$?
       
        # Check if we should restart
        if [[ "\$AUTO_RESTART" == "true" && \$CURRENT_TRIES -lt \$((MAX_RETRIES - 1)) ]]; then
            CURRENT_TRIES=\$((CURRENT_TRIES + 1))
            echo "\$(date +'%Y-%m-%d %H:%M:%S') - AUTO-RESTARTING - Attempt: \$CURRENT_TRIES/\$MAX_RETRIES" >> "\$LOG_PATH"
            update_registry "restarting" "null"
            sleep 2
        else
            echo "\$(date +'%Y-%m-%d %H:%M:%S') - NO MORE RESTART ATTEMPTS" >> "\$LOG_PATH"
            update_registry "dead" "null"
            break
        fi
    done
}

# Start the monitoring loop
echo "\$(date +'%Y-%m-%d %H:%M:%S') - STARTING MONITOR LOOP" >> "\$LOG_PATH"
monitor_loop

echo "\$(date +'%Y-%m-%d %H:%M:%S') - MONITOR STOPPED - Process: \$PROCESS_NAME" >> "\$LOG_PATH"

# Final cleanup
update_registry "dead" "null"
`;

        const scriptPath = path.join(LOG_DIR, `monitor_${processId}.sh`);
        fs.writeFileSync(scriptPath, scriptContent, 'utf-8');
        fs.chmodSync(scriptPath, 0o755);
        return scriptPath;
    }

    static run(filepath, config = {}) {
        const resolvedPath = path.resolve(filepath);
        if (!fs.existsSync(resolvedPath)) {
            throw new Error(`File not found: ${resolvedPath}`);
        }

        const id = this._generateId();
        const processName = config.name || this._generateProcessName();
        const logPath = path.join(LOG_DIR, `${processName}.log`);

        // Create initial log entry
        fs.writeFileSync(logPath, `Process Manager - Started: ${new Date().toISOString()}\n`, 'utf-8');

        let child;
        let actualPid;

        if (config.autoRestart || config.restartTries) {
            // For auto-restart processes, create and start monitor script
            const monitorScript = this._createMonitorScript(
                id,
                resolvedPath,
                processName,
                logPath,
                config.autoRestart ? 'true' : 'false',
                config.restartTries || 0
            );
           
            child = spawn('bash', [monitorScript], {
                detached: true,
                stdio: 'ignore'
            });

            child.unref();
            actualPid = child.pid;
        } else {
            // For regular processes, start directly
            const logFileDescriptor = fs.openSync(logPath, 'a');
           
            child = spawn(process.execPath, [resolvedPath], {
                detached: true,
                stdio: ['ignore', logFileDescriptor, logFileDescriptor]
            });

            child.unref();
            actualPid = child.pid;
        }

        const entry = {
            id,
            pid: actualPid,
            name: processName,
            path: resolvedPath,
            log: logPath,
            createdAt: new Date().toISOString(),
            status: 'running',
            config: {
                autoRestart: !!config.autoRestart,
                restartTries: config.restartTries || 0,
                currentTries: 0
            },
            isAutoRestart: !!(config.autoRestart || config.restartTries),
            monitorPid: (config.autoRestart || config.restartTries) ? actualPid : null
        };

        const registry = this._loadRegistry();
        registry.push(entry);
        this._saveRegistry(registry);

        return entry;
    }

    static list() {
        const registry = this._loadRegistry();
        const processList = [];

        for (const proc of registry) {
            let status = proc.status;
           
            // For auto-restart processes, check if monitor is alive
            let isAlive = false;
            try {
                if (proc.isAutoRestart && proc.monitorPid) {
                    // Check if monitor process is alive
                    process.kill(proc.monitorPid, 0);
                    isAlive = true;
                } else {
                    // Check if regular process is alive
                    process.kill(proc.pid, 0);
                    isAlive = true;
                }
            } catch (e) {
                isAlive = false;
            }

            // Update status based on actual process state
            if (!isAlive && (proc.status === 'running' || proc.status === 'restarting')) {
                status = 'stopped';
                proc.status = status;
            } else if (isAlive && proc.status === 'stopped') {
                status = 'running';
                proc.status = status;
            }

            // Format display status
            let displayStatus = status.charAt(0).toUpperCase() + status.slice(1);
            if (status === 'restarting' && proc.isAutoRestart) {
                displayStatus = 'Restarting';
            }

            processList.push({
                status: displayStatus,
                id: proc.id,
                name: proc.name,
                pid: proc.pid,
                monitorPid: proc.monitorPid || 'N/A',
                tries: proc.config?.currentTries || 0,
                autoRestart: proc.isAutoRestart ? 'Yes' : 'No'
            });
        }

        // Save any status updates
        this._saveRegistry(registry);

        return processList;
    }

    static _removeFromRegistry(id) {
        const registry = this._loadRegistry();
        const index = registry.findIndex(process => process.id === id);
       
        if (index !== -1) {
            registry.splice(index, 1);
            this._saveRegistry(registry);
            return true;
        }
        return false;
    }

    static kill(pidOrId) {
        const registry = this._loadRegistry();
        const process = registry.find(p => p.pid == pidOrId || p.id === pidOrId);
   
        if (!process) {
            console.error('Process not found in registry.');
            return false;
        }
   
        console.log(`Killing process: ${process.name} (ID: ${process.id})`);
       
        // Mark as stopped in registry first
        process.status = 'stopped';
        this._saveRegistry(registry);
       
        let killed = false;
       
        if (process.isAutoRestart) {
            // For auto-restart processes, kill the monitor and all its children
            if (process.monitorPid) {
                killed = this._killProcessTree(process.monitorPid);
            }
            // Also kill the main PID if different
            if (process.pid !== process.monitorPid) {
                this._killProcessTree(process.pid);
            }
        } else {
            // For regular processes, kill the process tree
            killed = this._killProcessTree(process.pid);
        }
       
        if (killed) {
            console.log(`✓ Successfully killed process: ${process.name}`);
        } else {
            console.log(`- Process ${process.name} was not running`);
        }
       
        return true;
    }

    static killAll() {
        const registry = this._loadRegistry();
       
        if (registry.length === 0) {
            console.log('No processes to kill.');
            return 0;
        }

        console.log(`Killing all ${registry.length} processes...`);
       
        // First, mark all as stopped in registry
        for (const process of registry) {
            process.status = 'stopped';
        }
        this._saveRegistry(registry);
       
        let killedCount = 0;
       
        // Then kill all processes
        for (const process of registry) {
            let killed = false;
           
            if (process.isAutoRestart && process.monitorPid) {
                killed = this._killProcessTree(process.monitorPid);
            } else {
                killed = this._killProcessTree(process.pid);
            }
           
            if (killed) {
                killedCount++;
                console.log(`✓ Killed: ${process.name}`);
            } else {
                console.log(`- Already dead: ${process.name}`);
            }
        }
       
        // Clear registry after killing all
        this._saveRegistry([]);
        console.log(`\n✓ Successfully killed ${killedCount} out of ${registry.length} processes.`);
        return killedCount;
    }
   
    static isAlive(pidOrId) {
        const registry = this._loadRegistry();
        const process = registry.find(p => p.pid == pidOrId || p.id === pidOrId);
   
        if (!process) return false;
   
        try {
            if (process.isAutoRestart && process.monitorPid) {
                process.kill(process.monitorPid, 0);
            } else {
                process.kill(process.pid, 0);
            }
            return true;
        } catch (error) {
            return false;
        }
    }

    static log(pidOrId) {
        const registry = this._loadRegistry();
        const proc = registry.find(p => p.pid == pidOrId || p.id === pidOrId);

        if (!proc) {
            console.error('Process not found.');
            return;
        }

        const logPath = proc.log;

        if (!fs.existsSync(logPath)) {
            console.error('Log file not found.');
            return;
        }

        console.log(`🚀 Following logs for: ${proc.name} (ID: ${proc.id})`);
        console.log(`📁 Log file: ${logPath}`);
        console.log('=' .repeat(80));
        console.log('Press Ctrl+C to stop following logs\n');

        // First, output existing content
        try {
            const existingContent = fs.readFileSync(logPath, 'utf-8');
            console.log(existingContent);
        } catch (error) {
            console.error('Error reading log file:', error.message);
            return;
        }

        let lastSize = fs.statSync(logPath).size;

        // Use fs.watch for real-time file monitoring
        const watcher = fs.watch(logPath, (eventType) => {
            if (eventType === 'change') {
                try {
                    const stats = fs.statSync(logPath);
                    if (stats.size > lastSize) {
                        const stream = fs.createReadStream(logPath, {
                            start: lastSize,
                            end: stats.size
                        });

                        stream.on('data', (chunk) => {
                            process.stdout.write(chunk.toString());
                        });

                        stream.on('end', () => {
                            lastSize = stats.size;
                        });

                        stream.on('error', () => {
                            // Ignore stream errors
                        });
                    } else if (stats.size < lastSize) {
                        // File was truncated, read from beginning
                        lastSize = 0;
                        const fullContent = fs.readFileSync(logPath, 'utf-8');
                        process.stdout.write(fullContent);
                        lastSize = fullContent.length;
                    }
                } catch (error) {
                    // File might be temporarily unavailable
                }
            }
        });

        // Handle cleanup - FIXED: Use global process object
        const cleanup = () => {
            watcher.close();
            console.log('\n\n📋 Log following stopped.');
            process.exit(0);
        };

        // FIXED: Use global process object instead of parameter shadowing
        process.on('SIGINT', cleanup);
        process.on('SIGTERM', cleanup);
    }

    static restart(pidOrId) {
        const registry = this._loadRegistry();
        const process = registry.find(p => p.pid == pidOrId || p.id === pidOrId);
   
        if (!process) {
            console.error('Process not found.');
            return false;
        }
   
        console.log(`Restarting process: ${process.name} (ID: ${process.id})`);
       
        // Kill the current process
        this.kill(process.id);
       
        // Wait a moment for cleanup
        setTimeout(() => {
            // Remove from registry
            this._removeFromRegistry(process.id);
           
            // Start a new process with the same configuration
            const newProcess = this.run(process.path, {
                name: process.name,
                autoRestart: process.config.autoRestart,
                restartTries: process.config.restartTries
            });
           
            console.log(`✓ Successfully restarted: ${newProcess.name} (New PID: ${newProcess.pid}, ID: ${newProcess.id})`);
        }, 1000);
       
        return true;
    }

    static cleanup() {
        const registry = this._loadRegistry();
        const aliveProcesses = [];
       
        for (const process of registry) {
            if (this.isAlive(process.id)) {
                aliveProcesses.push(process);
            } else {
                console.log(`Cleaning up dead process: ${process.name} (ID: ${process.id})`);
            }
        }
       
        if (aliveProcesses.length !== registry.length) {
            this._saveRegistry(aliveProcesses);
            console.log(`✓ Cleaned up ${registry.length - aliveProcesses.length} dead processes.`);
        } else {
            console.log('✓ No dead processes to clean up.');
        }
    }

    static displayHelp() {
        console.log(`
Process Manager CLI Usage:
  node ProcessManager [command] [options]

Commands:
  --run <file>          Run a Node.js script as a background process
  --list                List all managed processes
  --kill <pid|id>       Kill a process by PID or ID
  --kill-all            Stop all managed processes and remove from registry
  --restart <pid|id>    Restart a process by PID or ID
  --alive <pid|id>      Check if a process is alive
  --log <pid|id>        Follow logs of a process (real-time)
  --cleanup             Remove dead processes from registry
  --help                Display this help message

Options for --run:
  --name <name>         Specify a name for the process
  --auto-restart        Auto-restart the process if it crashes
  --restart-tries <n>   Number of restart attempts (implies auto-restart)

Examples:
  node ProcessManager --run app.js --name my-app
  node ProcessManager --run app.js --auto-restart
  node ProcessManager --run app.js --restart-tries 3
  node ProcessManager --run app.js --name my-app --auto-restart --restart-tries 5
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
                console.log('No processes found.');
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
            const config = {};
           
            if (args.includes('--name')) {
                const nameIndex = args.indexOf('--name');
                if (nameIndex + 1 < args.length && !args[nameIndex + 1].startsWith('--')) {
                    config.name = args[nameIndex + 1];
                }
            }
           
            if (args.includes('--auto-restart')) {
                config.autoRestart = true;
            }
           
            if (args.includes('--restart-tries')) {
                const triesIndex = args.indexOf('--restart-tries');
                if (triesIndex + 1 < args.length && !args[triesIndex + 1].startsWith('--')) {
                    const tries = parseInt(args[triesIndex + 1]);
                    if (!isNaN(tries) && tries > 0) {
                        config.restartTries = tries;
                        config.autoRestart = true;
                    }
                }
            }
           
            try {
                const result = this.run(filePath, config);
                console.log(`✓ Started process: ${result.name} (PID: ${result.pid}, ID: ${result.id})`);
                if (config.autoRestart) {
                    console.log(`✓ Auto-restart enabled${config.restartTries ? ` with ${config.restartTries} tries` : ''}`);
                }
            } catch (error) {
                console.error('✗ Error starting process:', error.message);
            }
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

        if (args.includes('--kill-all')) {
            this.killAll();
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
            this.log(pidOrId);
            return;
        }

        if (args.includes('--cleanup')) {
            this.cleanup();
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