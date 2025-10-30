import { spawn } from 'child_process';
import fs from 'fs';
import crypto from 'crypto';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';

/**
 * A class for compiling and executing C code with caching capabilities
 * Supports both inline code and .c files
 * @class
 */
class C {
  /** @private */
  static #cacheDir = path.join(os.homedir(), '.c_runner_cache');
  /** @private */
  static #compiler = 'gcc';
  /** @private */
  static #logTime = false;
  /** @private */
  static #forceRecompile = false;
  /** @private */
  static #childProcesses = new Map();
  /** @private */
  static #cleanupSetup = false;

  /**
   * Configure the C runner settings
   * @param {Object} config - Configuration object
   * @param {boolean} [config.logTime=false] - Whether to log execution time
   * @param {string} [config.compiler='gcc'] - Compiler to use (gcc, clang, etc.)
   * @param {boolean} [config.forceRecompile=false] - Force recompilation even if cached
   * @param {string} [config.cacheDir] - Custom cache directory path
   * @static
   */
  static config({ 
    logTime = false, 
    compiler = 'gcc',
    forceRecompile = false,
    cacheDir = null
  } = {}) {
    this.#logTime = logTime;
    this.#compiler = compiler;
    this.#forceRecompile = forceRecompile;
    if (cacheDir) this.#cacheDir = cacheDir;
  }

  /**
   * @private
   */
  static #initCache() {
    if (!fs.existsSync(this.#cacheDir)) {
      fs.mkdirSync(this.#cacheDir, { recursive: true, mode: 0o755 });
    }
  }

  /**
   * @private
   */
  static #getExecutablePath(tag) {
    return path.join(this.#cacheDir, `${tag}.out`);
  }

  /**
   * @private
   */
  static #getFileHash(filePath) {
    const content = fs.readFileSync(filePath);
    return crypto.createHash('md5').update(content).digest('hex');
  }

  /**
   * @private
   */
  static #compileAndSave(codeOrFilePath, tag) {
    this.#initCache();
    const executable = this.#getExecutablePath(tag);

    try {
      // Check if input is a file path or inline code
      const isFilePath = typeof codeOrFilePath === 'string' && 
                        (codeOrFilePath.endsWith('.c') || fs.existsSync(codeOrFilePath));
      
      let compileCommand;
      
      if (isFilePath) {
        // Compile from file
        if (!fs.existsSync(codeOrFilePath)) {
          throw new Error(`File not found: ${codeOrFilePath}`);
        }
        compileCommand = `${this.#compiler} "${codeOrFilePath}" -o "${executable}"`;
      } else {
        // Compile from inline code
        const tempFile = path.join(this.#cacheDir, `${tag}.c`);
        fs.writeFileSync(tempFile, codeOrFilePath, { mode: 0o644 });
        compileCommand = `${this.#compiler} "${tempFile}" -o "${executable}"`;
        
        // Clean up temporary source file after compilation
        try {
          execSync(compileCommand);
          fs.chmodSync(executable, 0o755);
          fs.unlinkSync(tempFile);
        } catch (err) {
          if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
          throw err;
        }
        return executable;
      }

      // Execute compilation for file path case
      execSync(compileCommand);
      fs.chmodSync(executable, 0o755);
      return executable;
    } catch (err) {
      throw new Error(`Compilation failed: ${err.message}`);
    }
  }

  /**
   * @private
   */
  static #setupProcessCleanup() {
    if (this.#cleanupSetup) return;
    this.#cleanupSetup = true;

    // Store original signal handlers
    const originalHandlers = {
      SIGINT: process.listeners('SIGINT'),
      SIGTERM: process.listeners('SIGTERM')
    };

    const cleanupChildProcesses = () => {
      for (const [pid, childProcess] of this.#childProcesses) {
        try {
          if (!childProcess.killed && childProcess.exitCode === null) {
            // Use process group kill to ensure all child processes are terminated
            try {
              process.kill(-childProcess.pid, 'SIGTERM');
            } catch (err) {
              // If process group kill fails, kill the process directly
              childProcess.kill('SIGTERM');
            }
            
            // Force kill after short timeout
            setTimeout(() => {
              try {
                if (!childProcess.killed && childProcess.exitCode === null) {
                  try {
                    process.kill(-childProcess.pid, 'SIGKILL');
                  } catch (err) {
                    childProcess.kill('SIGKILL');
                  }
                }
              } catch (err) {
                // Ignore errors during force kill
              }
            }, 100).unref();
          }
        } catch (err) {
          // Ignore errors during cleanup
        }
      }
    };

    // Handle process exit (normal termination)
    process.on('exit', () => {
      cleanupChildProcesses();
    });

    // Handle SIGTERM (kill command)
    process.on('SIGTERM', () => {
      cleanupChildProcesses();
      // Restore original handlers and re-emit signal after cleanup
      process.removeAllListeners('SIGTERM');
      originalHandlers.SIGTERM.forEach(handler => {
        process.on('SIGTERM', handler);
      });
      process.kill(process.pid, 'SIGTERM');
    });

    // Handle SIGHUP (terminal closed)
    process.on('SIGHUP', () => {
      cleanupChildProcesses();
      process.exit(0);
    });

    // Handle uncaught exceptions
    process.on('uncaughtException', (error) => {
      cleanupChildProcesses();
      // Let the original exception handling proceed
      if (originalHandlers.SIGTERM.length === 0) {
        console.error('Uncaught Exception:', error);
        process.exit(1);
      }
    });
  }

  /**
   * @private
   */
  static #addChildProcess(childProcess) {
    this.#childProcesses.set(childProcess.pid, childProcess);
    this.#setupProcessCleanup();
  }

  /**
   * @private
   */
  static #removeChildProcess(childProcess) {
    this.#childProcesses.delete(childProcess.pid);
  }

  /**
   * Compile and run C code or .c file with full terminal control
   * @param {string} codeOrFilePath - C source code or path to .c file to compile and execute
   * @param {Object} [options] - Execution options
   * @param {Array<string|number>} [options.args=[]] - Command line arguments to pass to the executable
   * @param {string} [options.tag] - Tag for caching the executable (if not provided, temporary execution)
   * @param {boolean} [options.force=false] - Force recompilation even if cached
   * @param {Function} [options.onLog] - Optional callback function that receives each log output in real-time
   * @returns {Promise<string>} - Promise that resolves with the complete output when process ends
   * @throws {Error} - If compilation or execution fails
   * @static
   */
  static async run(codeOrFilePath, { 
    args = [], 
    tag = null, 
    force = false,
    onLog = null
  } = {}) {
    // Validate onLog callback
    if (onLog && typeof onLog !== 'function') {
      throw new Error('onLog must be a function if provided');
    }

    // Validate input
    if (!codeOrFilePath) {
      throw new Error('Either C code or file path must be provided');
    }

    let executable;
    const isTemporary = !tag;

    try {
      // Determine if input is a file path or inline code
      const isFilePath = typeof codeOrFilePath === 'string' && 
                        (codeOrFilePath.endsWith('.c') || fs.existsSync(codeOrFilePath));

      // Generate tag based on file content hash for files, or use provided tag
      let finalTag = tag;
      if (isFilePath && !tag) {
        const fileHash = this.#getFileHash(codeOrFilePath);
        finalTag = `file_${path.basename(codeOrFilePath, '.c')}_${fileHash}`;
      } else if (!tag) {
        finalTag = `temp_${crypto.randomBytes(4).toString('hex')}`;
      }

      // Compile or get cached executable
      executable = this.#getExecutablePath(finalTag);
      if (force || this.#forceRecompile || !fs.existsSync(executable)) {
        this.#compileAndSave(codeOrFilePath, finalTag);
      }

      return await this.#executeWithFullTerminal(executable, args, onLog);
    } finally {
      // Clean up temporary executable (only for inline code without tag)
      if (isTemporary && executable && fs.existsSync(executable)) {
        try {
          fs.unlinkSync(executable);
        } catch (err) {
          // Ignore cleanup errors
        }
      }
    }
  }

  /**
   * Compile and run multiple C files together
   * @param {Array<string>} filePaths - Array of paths to .c files to compile together
   * @param {Object} [options] - Execution options
   * @param {Array<string|number>} [options.args=[]] - Command line arguments to pass to the executable
   * @param {string} [options.tag] - Tag for caching the executable
   * @param {boolean} [options.force=false] - Force recompilation even if cached
   * @param {Function} [options.onLog] - Optional callback function that receives each log output in real-time
   * @returns {Promise<string>} - Promise that resolves with the complete output when process ends
   * @throws {Error} - If compilation or execution fails
   * @static
   */
  static async runFiles(filePaths, { 
    args = [], 
    tag = null, 
    force = false,
    onLog = null
  } = {}) {
    if (!Array.isArray(filePaths) || filePaths.length === 0) {
      throw new Error('filePaths must be a non-empty array');
    }

    // Validate all files exist
    for (const filePath of filePaths) {
      if (!fs.existsSync(filePath)) {
        throw new Error(`File not found: ${filePath}`);
      }
      if (!filePath.endsWith('.c')) {
        throw new Error(`File must be a .c file: ${filePath}`);
      }
    }

    // Generate tag based on file content hashes
    let finalTag = tag;
    if (!tag) {
      const hash = crypto.createHash('md5');
      filePaths.forEach(filePath => {
        hash.update(this.#getFileHash(filePath));
      });
      const filesHash = hash.digest('hex');
      finalTag = `multi_${filesHash}`;
    }

    const executable = this.#getExecutablePath(finalTag);
    
    // Compile if needed
    if (force || this.#forceRecompile || !fs.existsSync(executable)) {
      this.#initCache();
      const fileList = filePaths.map(fp => `"${fp}"`).join(' ');
      const compileCommand = `${this.#compiler} ${fileList} -o "${executable}"`;
      
      try {
        execSync(compileCommand);
        fs.chmodSync(executable, 0o755);
      } catch (err) {
        throw new Error(`Compilation failed: ${err.message}`);
      }
    }

    return await this.#executeWithFullTerminal(executable, args, onLog);
  }

  /**
   * @private
   */
  static #executeWithFullTerminal(executable, args = [], onLog = null) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      
      // Spawn the process with proper process group handling
      const childProcess = spawn(executable, args, {
        stdio: ['inherit', 'pipe', 'pipe'],
        shell: true,
        detached: false // Keep in same process group for proper signal propagation
      });

      // Track child process for cleanup
      this.#addChildProcess(childProcess);

      let stdoutData = '';
      let stderrData = '';

      // Handle stdout - pipe to terminal and capture for return
      childProcess.stdout.on('data', (data) => {
        const chunk = data.toString();
        stdoutData += chunk;
        
        // Output to terminal
        process.stdout.write(chunk);
        
        // Call optional log callback
        if (onLog) {
          try {
            onLog(chunk, 'stdout');
          } catch (err) {
            console.error('Error in onLog callback:', err);
          }
        }
      });

      // Handle stderr - pipe to terminal and capture for error handling
      childProcess.stderr.on('data', (data) => {
        const chunk = data.toString();
        stderrData += chunk;
        
        // Output to terminal
        process.stderr.write(chunk);
        
        // Call optional log callback
        if (onLog) {
          try {
            onLog(chunk, 'stderr');
          } catch (err) {
            console.error('Error in onLog callback:', err);
          }
        }
      });

      // Handle process completion
      childProcess.on('close', (code, signal) => {
        // Remove from tracking
        this.#removeChildProcess(childProcess);
        
        if (this.#logTime) {
          console.log(`\nExecution time: ${Date.now() - start}ms`);
        }
        
        // If process was terminated by signal, handle appropriately
        if (signal) {
          if (signal === 'SIGINT') {
            // User pressed Ctrl+C - this is expected behavior
            resolve(stdoutData);
          } else {
            const error = new Error(`Process terminated by signal: ${signal}`);
            error.exitCode = code;
            error.signal = signal;
            error.stderr = stderrData;
            error.stdout = stdoutData;
            reject(error);
          }
          return;
        }
        
        // If process exited with non-zero code, reject
        if (code !== 0) {
          const error = new Error(`Process exited with code ${code}`);
          error.exitCode = code;
          error.stderr = stderrData;
          error.stdout = stdoutData;
          reject(error);
          return;
        }
        
        // Normal successful exit
        resolve(stdoutData);
      });

      childProcess.on('error', (err) => {
        this.#removeChildProcess(childProcess);
        reject(new Error(`Execution failed: ${err.message}`));
      });

      // Handle Ctrl+C - forward to child process but don't intercept
      const handleSigInt = () => {
        // Forward SIGINT to child process but continue normal Node.js shutdown
        try {
          childProcess.kill('SIGINT');
        } catch (err) {
          // Ignore if process is already dead
        }
      };

      // Add our SIGINT handler without removing existing ones
      process.on('SIGINT', handleSigInt);

      // Clean up when promise settles
      const cleanup = () => {
        this.#removeChildProcess(childProcess);
        process.removeListener('SIGINT', handleSigInt);
      };

      childProcess.on('close', cleanup);
      childProcess.on('error', cleanup);
    });
  }

  /**
   * Remove a cached executable by tag
   * @param {string} tag - Tag of the cached executable to remove
   * @returns {boolean} - True if the file was removed, false if it didn't exist
   * @static
   */
  static removeTag(tag) {
    const executable = this.#getExecutablePath(tag);
    if (fs.existsSync(executable)) {
      fs.unlinkSync(executable);
      return true;
    }
    return false;
  }

  /**
   * Clear the entire cache directory
   * @static
   */
  static clearCache() {
    if (fs.existsSync(this.#cacheDir)) {
      fs.rmSync(this.#cacheDir, { recursive: true });
    }
  }

  /**
   * Get the number of currently running C processes
   * @returns {number} - Number of active child processes
   * @static
   */
  static getActiveProcessCount() {
    return this.#childProcesses.size;
  }

  /**
   * Forcefully terminate all running C processes
   * @static
   */
  static terminateAll() {
    for (const [pid, childProcess] of this.#childProcesses) {
      try {
        if (!childProcess.killed && childProcess.exitCode === null) {
          try {
            process.kill(-childProcess.pid, 'SIGTERM');
          } catch (err) {
            childProcess.kill('SIGTERM');
          }
        }
      } catch (err) {
        // Ignore errors during termination
      }
    }
  }
}

export default C;
