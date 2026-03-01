// fast-executor.js
import { exec, execSync, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { platform } from 'node:os';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

class FastExecutor {
    constructor(options = {}) {
        this.workingDirectory = options.workingDirectory || process.cwd();
        this.safeMode = options.safeMode !== false;
        this.timeout = options.timeout || 30000;
        this.maxBuffer = options.maxBuffer || 1024 * 1024; // 1MB
        this.dangerousPatterns = [
            'rm -rf /', 'rm -rf /*', 'mkfs', 'format', 
            'dd if=', '> /dev/sd', 'chmod 000 /',
            ':(){ :|:& };:', 'mv / /dev/null'
        ];
    }

    // Ultra-fast sync execution (use with caution)
    execSync(command, args = [], options = {}) {
        const cmdString = Array.isArray(command) ? command.join(' ') : `${command} ${args.join(' ')}`;
        
        try {
            if (this.safeMode && this.isDangerous(cmdString)) {
                return {
                    success: false,
                    error: 'Dangerous command blocked',
                    command: cmdString
                };
            }

            const output = execSync(cmdString, {
                cwd: options.cwd || this.workingDirectory,
                encoding: 'utf8',
                stdio: options.stdio || 'pipe',
                timeout: options.timeout || this.timeout,
                maxBuffer: options.maxBuffer || this.maxBuffer,
                windowsHide: true,
                ...options
            });

            return {
                success: true,
                output: output?.trim() || '',
                command: cmdString
            };
        } catch (error) {
            return {
                success: false,
                error: error.message,
                output: error.stdout?.toString()?.trim() || '',
                stderr: error.stderr?.toString()?.trim() || '',
                command: cmdString
            };
        }
    }

    // Fast async execution
    async exec(command, args = [], options = {}) {
        const cmdString = Array.isArray(command) ? command.join(' ') : `${command} ${args.join(' ')}`;
        
        try {
            if (this.safeMode && this.isDangerous(cmdString)) {
                return {
                    success: false,
                    error: 'Dangerous command blocked',
                    command: cmdString
                };
            }

            const { stdout, stderr } = await execAsync(cmdString, {
                cwd: options.cwd || this.workingDirectory,
                timeout: options.timeout || this.timeout,
                maxBuffer: options.maxBuffer || this.maxBuffer,
                windowsHide: true,
                ...options
            });

            return {
                success: true,
                stdout: stdout?.trim() || '',
                stderr: stderr?.trim() || '',
                command: cmdString
            };
        } catch (error) {
            return {
                success: false,
                error: error.message,
                stdout: error.stdout?.toString()?.trim() || '',
                stderr: error.stderr?.toString()?.trim() || '',
                command: cmdString
            };
        }
    }

    // Fast batch execution
    execBatch(commands, options = {}) {
        const results = [];
        const parallel = options.parallel || false;

        if (parallel) {
            // Execute in parallel
            return Promise.all(commands.map(cmd => 
                this.exec(cmd.command || cmd, cmd.args || [], options)
            ));
        } else {
            // Execute sequentially
            return commands.reduce(async (prevPromise, cmd) => {
                const results = await prevPromise;
                const result = await this.exec(
                    cmd.command || cmd, 
                    cmd.args || [], 
                    options
                );
                results.push(result);
                return results;
            }, Promise.resolve([]));
        }
    }

    // Stream execution (for large output)
    execStream(command, args = [], options = {}) {
        const cmdString = `${command} ${args.join(' ')}`;
        
        if (this.safeMode && this.isDangerous(cmdString)) {
            throw new Error('Dangerous command blocked');
        }

        const childProcess = spawn(command, args, {
            cwd: options.cwd || this.workingDirectory,
            shell: options.shell || true,
            windowsHide: true,
            ...options
        });

        return childProcess;
    }

    // Fast file operations
    async remove(target) {
        try {
            const resolvedPath = path.resolve(this.workingDirectory, target);
            
            if (!existsSync(resolvedPath)) {
                return { success: false, error: 'Path does not exist' };
            }

            const stats = await fs.stat(resolvedPath);
            
            if (stats.isDirectory()) {
                await fs.rm(resolvedPath, { recursive: true, force: true });
            } else {
                await fs.unlink(resolvedPath);
            }

            return { success: true, path: resolvedPath };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    // Fast remove (rm -rf style)
    async removeForce(target) {
        try {
            const resolvedPath = path.resolve(this.workingDirectory, target);
            
            // Basic safety check
            if (resolvedPath === '/' || resolvedPath === '/home' || resolvedPath === '/etc') {
                return { success: false, error: 'System directory protection' };
            }

            if (!existsSync(resolvedPath)) {
                return { success: false, error: 'Path does not exist' };
            }

            await fs.rm(resolvedPath, { recursive: true, force: true });
            return { success: true, path: resolvedPath };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    // Create directory
    async mkdir(target, options = {}) {
        try {
            const resolvedPath = path.resolve(this.workingDirectory, target);
            await fs.mkdir(resolvedPath, { recursive: options.recursive || false });
            return { success: true, path: resolvedPath };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    // Read file
    async readFile(filepath, encoding = 'utf8') {
        try {
            const resolvedPath = path.resolve(this.workingDirectory, filepath);
            const content = await fs.readFile(resolvedPath, encoding);
            return { success: true, content, path: resolvedPath };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    // Write file
    async writeFile(filepath, content, options = {}) {
        try {
            const resolvedPath = path.resolve(this.workingDirectory, filepath);
            await fs.writeFile(resolvedPath, content, { encoding: 'utf8', ...options });
            return { success: true, path: resolvedPath };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    // List directory
    async ls(target = '.') {
        try {
            const resolvedPath = path.resolve(this.workingDirectory, target);
            const files = await fs.readdir(resolvedPath);
            return { success: true, files, path: resolvedPath };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    // Check if path exists
    exists(target) {
        const resolvedPath = path.resolve(this.workingDirectory, target);
        return existsSync(resolvedPath);
    }

    // Get file stats
    async stat(target) {
        try {
            const resolvedPath = path.resolve(this.workingDirectory, target);
            const stats = await fs.stat(resolvedPath);
            return {
                success: true,
                isFile: stats.isFile(),
                isDirectory: stats.isDirectory(),
                size: stats.size,
                modified: stats.mtime,
                created: stats.birthtime,
                path: resolvedPath
            };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    // Check if command is dangerous
    isDangerous(command) {
        const lowerCmd = command.toLowerCase();
        return this.dangerousPatterns.some(pattern => 
            lowerCmd.includes(pattern.toLowerCase())
        );
    }

    // Get system info fast
    getSystemInfo() {
        return {
            platform: platform(),
            cwd: this.workingDirectory,
            timestamp: Date.now(),
            pid: process.pid,
            memory: process.memoryUsage(),
            uptime: process.uptime()
        };
    }

    // Change working directory
    cd(target) {
        try {
            const newPath = path.resolve(this.workingDirectory, target);
            process.chdir(newPath);
            this.workingDirectory = newPath;
            return { success: true, cwd: this.workingDirectory };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }
}

// Export singleton instance
const executor = new FastExecutor({
    safeMode: true,
    timeout: 10000
});

export default executor;
export { FastExecutor };