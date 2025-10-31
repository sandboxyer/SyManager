import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);

// Global paths - fixed system locations
const GLOBAL_BASE_DIR = path.join(os.homedir(), '.sypm');
const PROCESS_REGISTRY = path.join(GLOBAL_BASE_DIR, 'processes.json');
const LOG_DIR = path.join(GLOBAL_BASE_DIR, 'logs');

// Ensure global directories exist
if (!fs.existsSync(GLOBAL_BASE_DIR)) {
    fs.mkdirSync(GLOBAL_BASE_DIR, { recursive: true });
}
if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
}
if (!fs.existsSync(PROCESS_REGISTRY)) {
    fs.writeFileSync(PROCESS_REGISTRY, '[]', 'utf-8');
}

class SyPM {
    static _loadRegistry() {
        try {
            const raw = fs.readFileSync(PROCESS_REGISTRY, 'utf-8');
            return JSON.parse(raw);
        } catch (error) {
            // If registry is corrupted, reset it
            console.warn('Registry corrupted, resetting...');
            fs.writeFileSync(PROCESS_REGISTRY, '[]', 'utf-8');
            return [];
        }
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

    static _createMonitorScript(processId, filePath, processName, logPath, autoRestart, restartTries, workingDir) {
        // Escape paths for use in bash script
        const escapedRegistryPath = PROCESS_REGISTRY.replace(/'/g, "'\\''");
        const escapedFilePath = filePath.replace(/'/g, "'\\''");
        const escapedLogPath = logPath.replace(/'/g, "'\\''");
        const escapedWorkingDir = workingDir ? workingDir.replace(/'/g, "'\\''") : '';
        
        const scriptContent = `#!/usr/bin/env bash
PROCESS_ID='${processId}'
FILE_PATH='${escapedFilePath}'
PROCESS_NAME='${processName}'
LOG_PATH='${escapedLogPath}'
AUTO_RESTART='${autoRestart}'
RESTART_TRIES='${restartTries}'
REGISTRY_PATH='${escapedRegistryPath}'
WORKING_DIR='${escapedWorkingDir}'
CURRENT_TRIES=0
MAX_RETRIES=${restartTries > 0 ? restartTries : 999999}

echo "=== PROCESS MONITOR STARTED ===" >> "$LOG_PATH"
echo "Process: $PROCESS_NAME (ID: $PROCESS_ID)" >> "$LOG_PATH"
echo "Auto-restart: $AUTO_RESTART" >> "$LOG_PATH"
echo "Max restarts: $MAX_RETRIES" >> "$LOG_PATH"
echo "Working Directory: $WORKING_DIR" >> "$LOG_PATH"
echo "Started at: \$(date)" >> "$LOG_PATH"
echo "Registry: $REGISTRY_PATH" >> "$LOG_PATH"
echo "=================================" >> "$LOG_PATH"

# Function to update registry
update_registry() {
    local status="\$1"
    local node_pid="\$2"
    local current_tries="\$3"
    
    # Create a temporary Node.js script to update the registry
    cat > /tmp/update_registry_$$.js << EOF
const fs = require('fs');
try {
    const registryPath = '${escapedRegistryPath}';
    if (fs.existsSync(registryPath)) {
        const registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
        const processIndex = registry.findIndex(p => p.id === '${processId}');
        if (processIndex !== -1) {
            registry[processIndex].status = '\$status';
            if ('\$node_pid' && '\$node_pid' !== 'null') {
                registry[processIndex].pid = parseInt('\$node_pid');
            }
            registry[processIndex].monitorPid = $$;
            registry[processIndex].config.currentTries = parseInt('\$current_tries');
            registry[processIndex].lastUpdate = new Date().toISOString();
            fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));
        }
    }
} catch (error) {
    // Silently fail if registry update fails
}
EOF
    
    node /tmp/update_registry_$$.js 2>/dev/null
    rm -f /tmp/update_registry_$$.js
}

# Function to check if we should continue
should_continue() {
    # Create a temporary Node.js script to check registry
    cat > /tmp/check_registry_$$.js << EOF
const fs = require('fs');
try {
    const registryPath = '${escapedRegistryPath}';
    if (fs.existsSync(registryPath)) {
        const registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
        const process = registry.find(p => p.id === '${processId}');
        if (!process || process.status === 'stopped' || process.status === 'dead') {
            process.exit(1);
        }
        process.exit(0);
    } else {
        process.exit(1);
    }
} catch (e) {
    process.exit(0); // Continue by default if registry is corrupted
}
EOF
    
    node /tmp/check_registry_$$.js 2>/dev/null
    local result=\$?
    rm -f /tmp/check_registry_$$.js
    return \$result
}

# Function to start and monitor the Node.js process
start_and_monitor() {
    local attempt=\$1
    echo "[\$(date +'%Y-%m-%d %H:%M:%S')] Starting process - Attempt: \$((attempt + 1))/\$MAX_RETRIES" >> "\$LOG_PATH"
    
    # Set working directory if specified
    local cd_command=""
    if [[ -n "\$WORKING_DIR" && -d "\$WORKING_DIR" ]]; then
        cd_command="cd '\$WORKING_DIR' && "
        echo "[\$(date +'%Y-%m-%d %H:%M:%S')] Working directory: \$WORKING_DIR" >> "\$LOG_PATH"
    fi
    
    # Start the Node.js process
    eval "\${cd_command}node '\$FILE_PATH'" >> "\$LOG_PATH" 2>&1 &
    local NODE_PID=\$!
    
    echo "[\$(date +'%Y-%m-%d %H:%M:%S')] Process started with PID: \$NODE_PID" >> "\$LOG_PATH"
    
    # Update registry with running status
    update_registry "running" "\$NODE_PID" "\$attempt"
    
    # Wait for the process to exit
    wait \$NODE_PID
    local exit_code=\$?
    
    echo "[\$(date +'%Y-%m-%d %H:%M:%S')] Process exited with code: \$exit_code" >> "\$LOG_PATH"
    
    return \$exit_code
}

# Main monitor function
main() {
    while true; do
        # Check if we should continue monitoring
        if ! should_continue; then
            echo "[\$(date +'%Y-%m-%d %H:%M:%S')] Monitor stopped by registry" >> "\$LOG_PATH"
            update_registry "dead" "null" "\$CURRENT_TRIES"
            break
        fi
        
        # Start and monitor the process
        start_and_monitor \$CURRENT_TRIES
        local exit_code=\$?
        
        # Check if auto-restart is enabled and we have tries left
        if [[ "\$AUTO_RESTART" == "true" && \$CURRENT_TRIES -lt \$((MAX_RETRIES - 1)) ]]; then
            CURRENT_TRIES=\$((CURRENT_TRIES + 1))
            echo "[\$(date +'%Y-%m-%d %H:%M:%S')] Auto-restarting... Attempt: \$CURRENT_TRIES/\$MAX_RETRIES" >> "\$LOG_PATH"
            update_registry "restarting" "null" "\$CURRENT_TRIES"
            sleep 2
        else
            echo "[\$(date +'%Y-%m-%d %H:%M:%S')] No more restart attempts" >> "\$LOG_PATH"
            update_registry "dead" "null" "\$CURRENT_TRIES"
            break
        fi
    done
    
    echo "[\$(date +'%Y-%m-%d %H:%M:%S')] Monitor stopped for process: \$PROCESS_NAME" >> "\$LOG_PATH"
}

# Start the main function
main
`;

        const scriptPath = path.join(LOG_DIR, `monitor_${processId}.sh`);
        fs.writeFileSync(scriptPath, scriptContent, 'utf-8');
        fs.chmodSync(scriptPath, 0o755);
        return scriptPath;
    }

    static run(filepathOrCode, config = {}) {
        let resolvedPath;
        let isTempFile = false;
        let tempFilePath = null;
        let workingDir = config.workingDir || null;

        // Validate working directory if provided
        if (workingDir) {
            workingDir = path.resolve(workingDir);
            if (!fs.existsSync(workingDir)) {
                throw new Error(`Working directory does not exist: ${workingDir}`);
            }
            if (!fs.statSync(workingDir).isDirectory()) {
                throw new Error(`Working directory is not a directory: ${workingDir}`);
            }
        }

        // Check if the input is a code string (contains JavaScript code patterns)
        if (typeof filepathOrCode === 'string' && 
            (filepathOrCode.includes('function') || 
             filepathOrCode.includes('const ') || 
             filepathOrCode.includes('let ') || 
             filepathOrCode.includes('var ') || 
             filepathOrCode.includes('require(') || 
             filepathOrCode.includes('import ') ||
             filepathOrCode.includes('export ') ||
             filepathOrCode.trim().startsWith('//') ||
             filepathOrCode.trim().startsWith('/*') ||
             filepathOrCode.includes('console.log'))) {
            
            // It's a code string - create temporary file
            isTempFile = true;
            
            // Detect if it's ESM (using import/export syntax) or CommonJS
            const isESM = (filepathOrCode.includes('import ') && !filepathOrCode.includes('require(')) || 
                         filepathOrCode.includes('export ');
            
            const extension = isESM ? '.mjs' : '.js';
            const tempName = config.name ? `sypm_${config.name}_${Date.now()}${extension}` : `sypm_temp_${Date.now()}${extension}`;
            
            // Determine where to create the temp file
            if (workingDir) {
                // Create temp file in the specified working directory
                tempFilePath = path.join(workingDir, tempName);
            } else {
                // Use system temp directory as before
                tempFilePath = path.join(tmpdir(), tempName);
            }
            
            // Write code to temporary file
            fs.writeFileSync(tempFilePath, filepathOrCode, 'utf-8');
            resolvedPath = tempFilePath;
            
            console.log(`✓ Created temporary ${isESM ? 'ESM' : 'CommonJS'} file: ${tempFilePath}`);
            if (workingDir) {
                console.log(`✓ Running in working directory: ${workingDir}`);
            }
        } else {
            // It's a file path - use existing logic
            resolvedPath = path.resolve(filepathOrCode);
            if (!fs.existsSync(resolvedPath)) {
                throw new Error(`File not found: ${resolvedPath}`);
            }
            
            // If working directory is specified and different from file directory, create temp copy
            if (workingDir && path.dirname(resolvedPath) !== workingDir) {
                isTempFile = true;
                const fileName = path.basename(resolvedPath);
                tempFilePath = path.join(workingDir, fileName);
                
                // Copy the file to working directory
                fs.copyFileSync(resolvedPath, tempFilePath);
                resolvedPath = tempFilePath;
                
                console.log(`✓ Copied file to working directory: ${workingDir}`);
            }
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
                config.restartTries || 0,
                workingDir
            );
           
            // Start the monitor script
            child = spawn('bash', [monitorScript], {
                detached: true,
                stdio: 'ignore'
            });
    
            actualPid = child.pid;
            child.unref();
    
            console.log(`✓ Started monitor with PID: ${actualPid}`);
        } else {
            // For regular processes, start directly
            const logFileDescriptor = fs.openSync(logPath, 'a');
           
            const spawnOptions = {
                detached: true,
                stdio: ['ignore', logFileDescriptor, logFileDescriptor]
            };
            
            // Add working directory if specified
            if (workingDir) {
                spawnOptions.cwd = workingDir;
            }
           
            child = spawn(process.execPath, [resolvedPath], spawnOptions);
    
            actualPid = child.pid;
            child.unref();
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
                currentTries: 0,
                workingDir: workingDir
            },
            isAutoRestart: !!(config.autoRestart || config.restartTries),
            monitorPid: (config.autoRestart || config.restartTries) ? actualPid : null,
            lastUpdate: new Date().toISOString(),
            isTempFile: isTempFile,
            tempFilePath: isTempFile ? tempFilePath : null,
            originalPath: !isTempFile ? filepathOrCode : null
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
            // For auto-restart processes, trust the registry status completely
            // Don't overwrite with process alive checks
            let status = proc.status;
            let displayStatus = status.charAt(0).toUpperCase() + status.slice(1);
            
            // Only check if process is alive for status verification, but don't auto-update status
            let isAlive = false;
            try {
                if (proc.isAutoRestart && proc.monitorPid) {
                    process.kill(proc.monitorPid, 0);
                    isAlive = true;
                } else {
                    process.kill(proc.pid, 0);
                    isAlive = true;
                }
            } catch (e) {
                isAlive = false;
            }

            // If the monitor says it's running/restarting but process is dead, update status
            if (!isAlive && (proc.status === 'running' || proc.status === 'restarting')) {
                status = 'dead';
                proc.status = status;
                displayStatus = 'Dead';
                this._saveRegistry(registry);
            }
            // If monitor says it's stopped but process is alive, update to running
            else if (isAlive && proc.status === 'stopped') {
                status = 'running';
                proc.status = status;
                displayStatus = 'Running';
                this._saveRegistry(registry);
            }

            processList.push({
                status: displayStatus,
                id: proc.id,
                name: proc.name,
                pid: proc.pid,
                monitorPid: proc.monitorPid || 'N/A',
                tries: proc.config?.currentTries || 0,
                autoRestart: proc.isAutoRestart ? 'Yes' : 'No',
                workingDir: proc.config?.workingDir || 'Default',
                path: proc.path
            });
        }

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
        const proc = registry.find(p => p.pid == pidOrId || p.id === pidOrId);
       
        if (!proc) {
            console.error('Process not found in registry.');
            return false;
        }
       
        console.log(`Killing process: ${proc.name} (ID: ${proc.id})`);
       
        // Mark as stopped in registry first
        proc.status = 'stopped';
        this._saveRegistry(registry);
       
        let killed = false;
       
        if (proc.isAutoRestart) {
            // For auto-restart processes, kill the monitor and all its children
            if (proc.monitorPid) {
                killed = this._killProcessTree(proc.monitorPid);
            }
            // Also kill the main PID if different
            if (proc.pid !== proc.monitorPid) {
                this._killProcessTree(proc.pid);
            }
        } else {
            // For regular processes, kill the process tree
            killed = this._killProcessTree(proc.pid);
        }
       
        if (killed) {
            console.log(`✓ Successfully killed process: ${proc.name}`);
        } else {
            console.log(`- Process ${proc.name} was not running`);
        }
        
        // Clean up temporary file if this was a temp file process
        if (proc.isTempFile && proc.tempFilePath) {
            try {
                if (fs.existsSync(proc.tempFilePath)) {
                    fs.unlinkSync(proc.tempFilePath);
                    console.log(`✓ Removed temporary file: ${proc.tempFilePath}`);
                }
            } catch (error) {
                console.log(`⚠ Could not remove temp file: ${error.message}`);
            }
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
        for (const proc of registry) {
            proc.status = 'stopped';
        }
        this._saveRegistry(registry);
       
        let killedCount = 0;
       
        // Then kill all processes
        for (const proc of registry) {
            let killed = false;
           
            if (proc.isAutoRestart && proc.monitorPid) {
                killed = this._killProcessTree(proc.monitorPid);
            } else {
                killed = this._killProcessTree(proc.pid);
            }
           
            if (killed) {
                killedCount++;
                console.log(`✓ Killed: ${proc.name}`);
            } else {
                console.log(`- Already dead: ${proc.name}`);
            }
            
            // Clean up temporary files for killed processes
            if (proc.isTempFile && proc.tempFilePath) {
                try {
                    if (fs.existsSync(proc.tempFilePath)) {
                        fs.unlinkSync(proc.tempFilePath);
                        console.log(`  ✓ Removed temporary file: ${proc.tempFilePath}`);
                    }
                } catch (error) {
                    console.log(`  ⚠ Could not remove temp file: ${error.message}`);
                }
            }
        }
       
        // Clear registry after killing all
        this._saveRegistry([]);
        console.log(`\n✓ Successfully killed ${killedCount} out of ${registry.length} processes.`);
        return killedCount;
    }
   
    static isAlive(pidOrId) {
        const registry = this._loadRegistry();
        const proc = registry.find(p => p.pid == pidOrId || p.id === pidOrId);
   
        if (!proc) return false;
   
        try {
            if (proc.isAutoRestart && proc.monitorPid) {
                process.kill(proc.monitorPid, 0);
            } else {
                process.kill(proc.pid, 0);
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
        if (proc.config?.workingDir) {
            console.log(`📁 Working directory: ${proc.config.workingDir}`);
        }
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

        // Handle cleanup
        const cleanup = () => {
            watcher.close();
            console.log('\n\n📋 Log following stopped.');
            process.exit(0);
        };

        process.on('SIGINT', cleanup);
        process.on('SIGTERM', cleanup);
    }

    static restart(pidOrId) {
        const registry = this._loadRegistry();
        const proc = registry.find(p => p.pid == pidOrId || p.id === pidOrId);
   
        if (!proc) {
            console.error('Process not found.');
            return false;
        }
   
        console.log(`Restarting process: ${proc.name} (ID: ${proc.id})`);
       
        // Kill the current process
        this.kill(proc.id);
       
        // Wait a moment for cleanup
        setTimeout(() => {
            // Remove from registry
            this._removeFromRegistry(proc.id);
           
            // Start a new process with the same configuration
            const originalSource = proc.originalPath || proc.path;
            const newProcess = this.run(originalSource, {
                name: proc.name,
                autoRestart: proc.config.autoRestart,
                restartTries: proc.config.restartTries,
                workingDir: proc.config.workingDir
            });
           
            console.log(`✓ Successfully restarted: ${newProcess.name} (New PID: ${newProcess.pid}, ID: ${newProcess.id})`);
            if (newProcess.config.workingDir) {
                console.log(`✓ Running in working directory: ${newProcess.config.workingDir}`);
            }
        }, 1000);
       
        return true;
    }

    static cleanup() {
        const registry = this._loadRegistry();
        const aliveProcesses = [];
       
        for (const proc of registry) {
            if (this.isAlive(proc.id)) {
                aliveProcesses.push(proc);
            } else {
                console.log(`Cleaning up dead process: ${proc.name} (ID: ${proc.id})`);
                
                // Clean up temporary files for dead processes
                if (proc.isTempFile && proc.tempFilePath) {
                    try {
                        if (fs.existsSync(proc.tempFilePath)) {
                            fs.unlinkSync(proc.tempFilePath);
                            console.log(`  ✓ Removed temporary file: ${proc.tempFilePath}`);
                        }
                    } catch (error) {
                        console.log(`  ⚠ Could not remove temp file: ${error.message}`);
                    }
                }
                
                // Also try to remove the monitor script if it exists
                try {
                    const monitorScript = path.join(LOG_DIR, `monitor_${proc.id}.sh`);
                    if (fs.existsSync(monitorScript)) {
                        fs.unlinkSync(monitorScript);
                    }
                } catch (error) {
                    // Ignore cleanup errors
                }
            }
        }
       
        if (aliveProcesses.length !== registry.length) {
            this._saveRegistry(aliveProcesses);
            console.log(`✓ Cleaned up ${registry.length - aliveProcesses.length} dead processes.`);
        } else {
            console.log('✓ No dead processes to clean up.');
        }
    }

    static info() {
        console.log(`SyPM Global Information:`);
        console.log(`Base Directory: ${GLOBAL_BASE_DIR}`);
        console.log(`Registry File: ${PROCESS_REGISTRY}`);
        console.log(`Log Directory: ${LOG_DIR}`);
        
        const registry = this._loadRegistry();
        console.log(`Total Processes: ${registry.length}`);
        console.log(`Active Processes: ${registry.filter(p => this.isAlive(p.id)).length}`);
    }

    static displayHelp() {
        console.log(`
Process Manager CLI Usage (Global):
  node SyPM [command] [options]

Commands:
  --run <file>          Run a Node.js script as a background process
  --list                List all managed processes (global)
  --kill <pid|id>       Kill a process by PID or ID
  --kill-all            Stop all managed processes and remove from registry
  --restart <pid|id>    Restart a process by PID or ID
  --alive <pid|id>      Check if a process is alive
  --log <pid|id>        Follow logs of a process (real-time)
  --cleanup             Remove dead processes from registry
  --info                Show global SyPM information
  --help                Display this help message

Options for --run:
  --name <name>         Specify a name for the process
  --auto-restart        Auto-restart the process if it crashes
  --restart-tries <n>   Number of restart attempts (implies auto-restart)
  --working-dir <path>  Run the process in specified working directory

Global Features:
  • Processes are managed system-wide from: ${GLOBAL_BASE_DIR}
  • Access process list from any directory
  • Persistent registry across terminal sessions
  • Real-time status updates for auto-restart processes
  • Optional working directory support

Examples:
  node SyPM --run app.js --name my-app
  node SyPM --run app.js --auto-restart
  node SyPM --run app.js --restart-tries 3
  node SyPM --run app.js --name my-app --auto-restart --restart-tries 5
  node SyPM --run app.js --working-dir /path/to/directory
  node SyPM --list      # Shows all processes regardless of current directory
        `);
    }

    static parseArguments() {
        const args = process.argv.slice(2);
       
        if (args.length === 0 || args.includes('--help')) {
            this.displayHelp();
            return;
        }

        if (args.includes('--info')) {
            this.info();
            return;
        }

        if (args.includes('--list')) {
            const processes = this.list();
            console.log('Managed Processes (Global):');
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

            if (args.includes('--working-dir')) {
                const dirIndex = args.indexOf('--working-dir');
                if (dirIndex + 1 < args.length && !args[dirIndex + 1].startsWith('--')) {
                    config.workingDir = args[dirIndex + 1];
                }
            }
           
            try {
                const result = this.run(filePath, config);
                console.log(`✓ Started process: ${result.name} (PID: ${result.pid}, ID: ${result.id})`);
                console.log(`✓ Global registry: ${PROCESS_REGISTRY}`);
                if (config.autoRestart) {
                    console.log(`✓ Auto-restart enabled${config.restartTries ? ` with ${config.restartTries} tries` : ''}`);
                }
                if (config.workingDir) {
                    console.log(`✓ Working directory: ${config.workingDir}`);
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
    SyPM.parseArguments();
}

export default SyPM;
