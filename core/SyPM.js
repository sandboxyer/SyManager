/**
 * SyPM - System Process Manager
 * 
 * A comprehensive process management system for Node.js applications that provides
 * background process execution, auto-restart capabilities, process monitoring,
 * and system-wide process management.
 * 
 * @class SyPM
 * @author Your Name
 * @version 1.0.0
 * @license MIT
 */

import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);

/**
 * Global base directory for SyPM configuration and data storage
 * @constant {string}
 */
const GLOBAL_BASE_DIR = path.join(os.homedir(), '.sypm');

/**
 * Path to the process registry JSON file
 * @constant {string}
 */
const PROCESS_REGISTRY = path.join(GLOBAL_BASE_DIR, 'processes.json');

/**
 * Directory for storing process log files
 * @constant {string}
 */
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

/**
 * Main SyPM class for managing system processes
 * @class
 */
class SyPM {
    /**
     * Loads the process registry from the filesystem
     * @static
     * @private
     * @returns {Array<Object>} Array of process entries
     */
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

    /**
     * Saves the process registry to the filesystem
     * @static
     * @private
     * @param {Array<Object>} data - Process registry data to save
     */
    static _saveRegistry(data) {
        fs.writeFileSync(PROCESS_REGISTRY, JSON.stringify(data, null, 2));
    }

    /**
     * Generates a unique process ID
     * @static
     * @private
     * @returns {string} Unique process identifier
     */
    static _generateId() {
        return Math.random().toString(36).substr(2, 9);
    }

    /**
     * Generates a unique process name
     * @static
     * @private
     * @returns {string} Unique process name
     */
    static _generateProcessName() {
        return `process_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    }

    /**
     * Recursively gets all child process IDs for a given parent PID
     * @static
     * @private
     * @param {number} pid - Parent process ID
     * @returns {Array<number>} Array of child process IDs
     */
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

    /**
     * Kills a process tree including all child processes
     * @static
     * @private
     * @param {number} pid - Root process ID to kill
     * @returns {boolean} True if any processes were killed
     */
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

    /**
     * Creates a monitor script for auto-restart processes
     * @static
     * @private
     * @param {string} processId - Unique process identifier
     * @param {string} filePath - Path to the script file to monitor
     * @param {string} processName - Name of the process
     * @param {string} logPath - Path to the log file
     * @param {boolean} autoRestart - Whether to auto-restart the process
     * @param {number} restartTries - Number of restart attempts
     * @param {string} [workingDir] - Optional working directory
     * @returns {string} Path to the created monitor script
     */
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
        if ! should_continue; then {
            echo "[\$(date +'%Y-%m-%d %H:%M:%S')] Monitor stopped by registry" >> "\$LOG_PATH"
            update_registry "dead" "null" "\$CURRENT_TRIES"
            break
        }
        
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

    /**
     * Runs a Node.js script as a managed background process
     * @static
     * @param {string} filepathOrCode - File path to the script or JavaScript code string
     * @param {Object} [config={}] - Configuration options for the process
     * @param {string} [config.name] - Custom name for the process
     * @param {boolean} [config.autoRestart] - Whether to auto-restart the process on crash
     * @param {number} [config.restartTries] - Number of restart attempts (implies autoRestart)
     * @param {string} [config.workingDir] - Working directory to run the process in
     * @returns {Object} Process entry object with process details
     * @throws {Error} If file not found or working directory is invalid
     * 
     * @example
     * // Run a file with auto-restart
     * SyPM.run('/path/to/app.js', { 
     *   name: 'my-app',
     *   autoRestart: true,
     *   restartTries: 3
     * });
     * 
     * @example
     * // Run code string with working directory
     * SyPM.run('console.log("Hello World")', {
     *   name: 'hello-script',
     *   workingDir: '/tmp'
     * });
     */
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

    /**
     * Lists all managed processes with their current status
     * @static
     * @returns {Array<Object>} Array of process objects with status information
     * 
     * @example
     * const processes = SyPM.list();
     * console.table(processes);
     */
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

    /**
     * Removes a process from the registry by ID
     * @static
     * @private
     * @param {string} id - Process ID to remove
     * @returns {boolean} True if process was found and removed
     */
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

    /**
     * Kills a process by PID or ID
     * @static
     * @param {string|number} pidOrId - Process ID or PID to kill
     * @returns {boolean} True if process was found and killed
     * 
     * @example
     * // Kill by PID
     * SyPM.kill(12345);
     * 
     * @example
     * // Kill by ID
     * SyPM.kill('abc123def');
     */
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

    /**
     * Kills all managed processes
     * @static
     * @returns {number} Number of processes killed
     * 
     * @example
     * const killedCount = SyPM.killAll();
     * console.log(`Killed ${killedCount} processes`);
     */
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
   
    /**
     * Checks if a process is alive by PID or ID
     * @static
     * @param {string|number} pidOrId - Process ID or PID to check
     * @returns {boolean} True if process is running
     * 
     * @example
     * if (SyPM.isAlive('abc123def')) {
     *   console.log('Process is running');
     * }
     */
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

    /**
     * Follows logs of a process in real-time
     * @static
     * @param {string|number} pidOrId - Process ID or PID to follow logs for
     * 
     * @example
     * // Follow logs for a process
     * SyPM.log('abc123def');
     */
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

    /**
     * Restarts a process by PID or ID
     * @static
     * @param {string|number} pidOrId - Process ID or PID to restart
     * @returns {boolean} True if process was found and restarted
     * 
     * @example
     * SyPM.restart('abc123def');
     */
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

    /**
     * Cleans up dead processes and removes them from registry
     * @static
     * 
     * @example
     * // Clean up dead processes
     * SyPM.cleanup();
     */
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

    /**
     * Displays global SyPM information
     * @static
     * 
     * @example
     * SyPM.info();
     */
    static info() {
        console.log(`SyPM Global Information:`);
        console.log(`Base Directory: ${GLOBAL_BASE_DIR}`);
        console.log(`Registry File: ${PROCESS_REGISTRY}`);
        console.log(`Log Directory: ${LOG_DIR}`);
        
        const registry = this._loadRegistry();
        console.log(`Total Processes: ${registry.length}`);
        console.log(`Active Processes: ${registry.filter(p => this.isAlive(p.id)).length}`);
    }
/**
 * Comprehensive test method to verify all SyPM functionality
 * @static
 * @returns {Promise<boolean>} True if all tests pass
 * 
 * @example
 * // Run comprehensive tests
 * SyPM.Test();
 */
static async Test() {
    console.log('🧪 Starting SyPM Comprehensive Test Suite...\n');
    
    let testCount = 0;
    let passedTests = 0;
    let failedTests = 0;
    
    /**
     * Test utility function with async support
     * @param {string} testName - Name of the test
     * @param {Function} testFunction - Test function to execute
     */
    const runTest = async (testName, testFunction) => {
        testCount++;
        process.stdout.write(`  ${testCount}. ${testName}... `);
        
        try {
            await testFunction();
            console.log('✓ PASSED');
            passedTests++;
        } catch (error) {
            console.log('✗ FAILED');
            console.log(`     Error: ${error.message}`);
            failedTests++;
        }
    };

    /**
     * Wait for a condition to be true
     * @param {Function} condition - Function that returns a boolean
     * @param {number} timeout - Timeout in milliseconds
     * @param {number} interval - Check interval in milliseconds
     */
    const waitFor = (condition, timeout = 5000, interval = 100) => {
        return new Promise((resolve, reject) => {
            const startTime = Date.now();
            
            const checkCondition = () => {
                try {
                    if (condition()) {
                        resolve();
                    } else if (Date.now() - startTime > timeout) {
                        reject(new Error(`Timeout waiting for condition after ${timeout}ms`));
                    } else {
                        setTimeout(checkCondition, interval);
                    }
                } catch (error) {
                    reject(error);
                }
            };
            
            checkCondition();
        });
    };

    /**
     * Clean up before tests
     */
    const cleanupBeforeTests = () => {
        // Kill all existing processes
        const registry = this._loadRegistry();
        if (registry.length > 0) {
            console.log('Cleaning up existing processes before tests...');
            this.killAll();
        }
        
        // Clear registry
        this._saveRegistry([]);
    };

    /**
     * Create test scripts
     */
    const createTestScripts = () => {
        // Simple script that runs for a short time
        const simpleScript = `
console.log('Simple test script started');
setTimeout(() => {
    console.log('Simple test script completed');
}, 5000);
`;
        
        // Script that exits immediately (for crash testing)
        const crashScript = `
console.log('Crash test script started');
process.exit(1);
`;
        
        // Long running script
        const longRunningScript = `
console.log('Long running test script started');
setInterval(() => {
    console.log('Long running script still alive...');
}, 10000);
`;

        const scripts = {
            simple: { code: simpleScript, file: path.join(tmpdir(), 'test_simple.js') },
            crash: { code: crashScript, file: path.join(tmpdir(), 'test_crash.js') },
            long: { code: longRunningScript, file: path.join(tmpdir(), 'test_long.js') }
        };

        // Write test scripts to files
        for (const script of Object.values(scripts)) {
            fs.writeFileSync(script.file, script.code, 'utf-8');
        }

        return scripts;
    };

    /**
     * Clean up test scripts
     */
    const cleanupTestScripts = (scripts) => {
        for (const script of Object.values(scripts)) {
            try {
                if (fs.existsSync(script.file)) {
                    fs.unlinkSync(script.file);
                }
            } catch (error) {
                // Ignore cleanup errors
            }
        }
    };

    // Start comprehensive testing
    cleanupBeforeTests();
    const testScripts = createTestScripts();

    console.log('📋 Running Core Functionality Tests:\n');

    // Test 1: Registry operations
    await runTest('Registry load/save operations', () => {
        const testData = [{ id: 'test', name: 'test' }];
        this._saveRegistry(testData);
        const loadedData = this._loadRegistry();
        if (JSON.stringify(loadedData) !== JSON.stringify(testData)) {
            throw new Error('Registry save/load mismatch');
        }
        this._saveRegistry([]); // Reset
    });

    // Test 2: ID generation
    await runTest('Unique ID generation', () => {
        const id1 = this._generateId();
        const id2 = this._generateId();
        if (id1 === id2) {
            throw new Error('Generated duplicate IDs');
        }
        if (typeof id1 !== 'string' || id1.length === 0) {
            throw new Error('Invalid ID generated');
        }
    });

    // Test 3: Process name generation
    await runTest('Process name generation', () => {
        const name1 = this._generateProcessName();
        const name2 = this._generateProcessName();
        if (name1 === name2) {
            throw new Error('Generated duplicate names');
        }
        if (!name1.startsWith('process_')) {
            throw new Error('Invalid name format');
        }
    });

    // Test 4: Run file-based process
    let simpleProcessId;
    await runTest('Run file-based process', async () => {
        const process = this.run(testScripts.simple.file, { 
            name: 'test-simple-file' 
        });
        simpleProcessId = process.id;
        
        if (!process.id || !process.pid || !process.name) {
            throw new Error('Invalid process object returned');
        }
        
        // Wait for process to start properly
        await waitFor(() => this.isAlive(process.id), 3000, 100);
    });

    // Test 5: Run code-based process
    let codeProcessId;
    await runTest('Run code-based process', async () => {
        const process = this.run(testScripts.long.code, {
            name: 'test-code-process'
        });
        codeProcessId = process.id;
        
        if (!process.isTempFile) {
            throw new Error('Code process should be marked as temp file');
        }
        
        // Wait for process to start properly
        await waitFor(() => this.isAlive(process.id), 3000, 100);
    });

    // Test 6: Run process with working directory
    await runTest('Run process with working directory', async () => {
        const testWorkingDir = path.join(tmpdir(), 'sypm_test_dir');
        if (!fs.existsSync(testWorkingDir)) {
            fs.mkdirSync(testWorkingDir, { recursive: true });
        }
        
        const process = this.run(testScripts.simple.code, {
            name: 'test-working-dir',
            workingDir: testWorkingDir
        });
        
        if (!process.config.workingDir) {
            throw new Error('Working directory not set in process config');
        }
        
        // Wait for process to start properly
        await waitFor(() => this.isAlive(process.id), 3000, 100);
        
        // Clean up
        this.kill(process.id);
        
        // Wait for process to be killed
        await waitFor(() => !this.isAlive(process.id), 3000, 100);
        
        try {
            fs.rmdirSync(testWorkingDir);
        } catch (error) {
            // Ignore cleanup errors
        }
    });

    // Test 7: List processes
    await runTest('List processes functionality', () => {
        const processes = this.list();
        if (!Array.isArray(processes)) {
            throw new Error('List should return an array');
        }
        
        const ourProcesses = processes.filter(p => 
            p.name === 'test-simple-file' || p.name === 'test-code-process'
        );
        
        if (ourProcesses.length < 2) {
            throw new Error('Not all test processes found in list');
        }
    });

    // Test 8: Process alive check
    await runTest('Process alive status check', () => {
        if (!this.isAlive(simpleProcessId)) {
            throw new Error('Process should be alive');
        }
    });

    // Test 9: Kill process by ID
    await runTest('Kill process by ID', async () => {
        const killed = this.kill(simpleProcessId);
        if (!killed) {
            throw new Error('Failed to kill process by ID');
        }
        
        // Wait for process to die
        await waitFor(() => !this.isAlive(simpleProcessId), 3000, 100);
    });

    // Test 10: Kill process by PID
    await runTest('Kill process by PID', async () => {
        const processes = this.list();
        const codeProcess = processes.find(p => p.name === 'test-code-process');
        if (!codeProcess) {
            throw new Error('Code process not found for PID test');
        }
        
        const killed = this.kill(codeProcess.pid);
        if (!killed) {
            throw new Error('Failed to kill process by PID');
        }
        
        // Wait for process to die
        await waitFor(() => !this.isAlive(codeProcess.id), 3000, 100);
    });

    // Test 11: Run process with auto-restart
    let autoRestartProcessId;
    await runTest('Run process with auto-restart', async () => {
        const process = this.run(testScripts.crash.file, {
            name: 'test-auto-restart',
            autoRestart: true,
            restartTries: 2
        });
        autoRestartProcessId = process.id;
        
        if (!process.isAutoRestart) {
            throw new Error('Auto-restart process not properly configured');
        }
        
        if (!process.config.autoRestart) {
            throw new Error('Auto-restart flag not set in config');
        }
        
        // Wait for process to start
        await waitFor(() => this.isAlive(process.id), 3000, 100);
    });

    // Test 12: Cleanup functionality
    await runTest('Cleanup dead processes', async () => {
        // Kill the auto-restart process first
        this.kill(autoRestartProcessId);
        
        // Wait for it to die
        await waitFor(() => !this.isAlive(autoRestartProcessId), 3000, 100);
        
        this.cleanup();
        const processes = this.list();
        const found = processes.find(p => p.id === autoRestartProcessId);
        if (found) {
            throw new Error('Dead process not cleaned up');
        }
    });

    // Test 13: Kill all processes
    await runTest('Kill all processes', async () => {
        // Start a few processes first
        this.run(testScripts.simple.file, { name: 'test-kill-all-1' });
        this.run(testScripts.simple.file, { name: 'test-kill-all-2' });
        
        // Wait for processes to start
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        const beforeCount = this.list().length;
        const killedCount = this.killAll();
        
        // Wait for processes to be killed
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        const afterCount = this.list().length;
        if (afterCount !== 0) {
            throw new Error('Not all processes were killed');
        }
    });

    // Test 14: Info functionality
    await runTest('System info display', () => {
        // This should not throw an error
        this.info();
    });

    // Test 15: Process restart functionality
    await runTest('Process restart functionality', async () => {
        const process = this.run(testScripts.long.file, {
            name: 'test-restart'
        });
        
        const originalPid = process.pid;
        
        // Wait for process to start
        await waitFor(() => this.isAlive(process.id), 3000, 100);
        
        const restartSuccess = this.restart(process.id);
        
        if (!restartSuccess) {
            throw new Error('Restart failed');
        }
        
        // Wait for restart to complete
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        const newProcesses = this.list();
        const restartedProcess = newProcesses.find(p => p.name === 'test-restart');
        
        if (!restartedProcess) {
            throw new Error('Restarted process not found');
        }
        
        if (restartedProcess.pid === originalPid) {
            throw new Error('Process PID did not change after restart');
        }
        
        // Clean up
        this.kill(restartedProcess.id);
        
        // Wait for process to be killed
        await waitFor(() => !this.isAlive(restartedProcess.id), 3000, 100);
    });

    // Final cleanup
    this.killAll();
    cleanupTestScripts(testScripts);

    // Test Results Summary
    console.log('\n📊 Test Results Summary:');
    console.log('=' .repeat(40));
    console.log(`Total Tests: ${testCount}`);
    console.log(`Passed: ${passedTests} ✓`);
    console.log(`Failed: ${failedTests} ✗`);
    console.log(`Success Rate: ${((passedTests / testCount) * 100).toFixed(1)}%`);
    
    if (failedTests === 0) {
        console.log('\n🎉 ALL TESTS PASSED! SyPM is working correctly.');
        return true;
    } else {
        console.log('\n⚠️  Some tests failed. Please check the implementation.');
        return false;
    }
}

    /**
     * Displays help information for CLI usage
     * @static
     * 
     * @example
     * SyPM.displayHelp();
     */
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
  --test                Run comprehensive test suite
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
  node SyPM --test      # Run comprehensive test suite
        `);
    }

    /**
     * Parses command line arguments and executes corresponding commands
     * @static
     * @private
     */
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

        if (args.includes('--test')) {
            this.Test();
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

// CLI entry point
if (process.argv[1] === __filename) {
    SyPM.parseArguments();
}

export default SyPM;
