import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';

class PackScan extends EventEmitter {
  static #instance = null;
  static #foundPackages = [];
  static #isScanning = false;
  static #scannedPaths = new Set();
  static #scanQueue = [];
  static #MAX_QUEUE_SIZE = 100000;
  static #BATCH_SIZE = 1000;
  static #MEMORY_CLEANUP_THRESHOLD = 10000;

  /**
   * Private constructor for singleton pattern
   */
  constructor() {
    super();
    if (PackScan.#instance) {
      return PackScan.#instance;
    }
    PackScan.#instance = this;
  }

  /**
   * Scans the entire Linux system for package.json files with export default
   * Uses iterative queue-based scanning to avoid recursion and memory issues
   * @returns {Promise<void>}
   */
  static async scanEntireSystem() {
    if (this.#isScanning) {
      throw new Error('Scan already in progress');
    }

    this.#isScanning = true;
    this.#foundPackages = [];
    this.#scannedPaths.clear();
    this.#scanQueue = [];

    // Initialize scan queue with root directories
    const rootDirectories = this.#getLinuxRootDirectories();
    for (const dir of rootDirectories) {
      this.#enqueueDirectory(dir);
    }

    // Emit start event
    if (this.#instance) {
      this.#instance.emit('start', { rootCount: rootDirectories.length });
    }

    try {
      // Process queue iteratively with memory management
      await this.#processQueue();
      
      // Emit completion event
      if (this.#instance) {
        this.#instance.emit('complete', this.#foundPackages);
      }
    } catch (error) {
      if (this.#instance) {
        this.#instance.emit('error', error);
      }
    } finally {
      this.#isScanning = false;
      this.#scanQueue = []; // Clear queue
    }
  }

  /**
   * Processes the scan queue iteratively
   * @returns {Promise<void>}
   */
  static async #processQueue() {
    let processedCount = 0;
    
    while (this.#scanQueue.length > 0 && this.#isScanning) {
      // Process in batches to avoid memory pressure
      const batchSize = Math.min(this.#BATCH_SIZE, this.#scanQueue.length);
      const batch = [];
      
      for (let i = 0; i < batchSize; i++) {
        const dir = this.#scanQueue.shift();
        if (dir) {
          batch.push(dir);
        }
      }
      
      // Process batch
      for (const dir of batch) {
        if (!this.#isScanning) break;
        await this.#scanSingleDirectory(dir);
        processedCount++;
        
        // Clean up memory periodically
        if (processedCount % this.#MEMORY_CLEANUP_THRESHOLD === 0) {
          this.#forceGarbageCollection();
        }
      }
      
      // Small delay to prevent overwhelming the system
      if (this.#scanQueue.length > 0) {
        await new Promise(resolve => setTimeout(resolve, 1));
      }
    }
  }

  /**
   * Enqueues a directory for scanning
   * @param {string} dir - Directory path
   */
  static #enqueueDirectory(dir) {
    if (this.#scanQueue.length < this.#MAX_QUEUE_SIZE) {
      const normalizedDir = path.normalize(dir);
      if (!this.#scannedPaths.has(normalizedDir)) {
        this.#scanQueue.push(normalizedDir);
      }
    }
  }

  /**
   * Scans a single directory
   * @param {string} dir - Directory to scan
   * @returns {Promise<void>}
   */
  static async #scanSingleDirectory(dir) {
    // Mark as scanned
    this.#scannedPaths.add(dir);
    
    try {
      // Skip if doesn't exist or not a directory
      if (!fs.existsSync(dir)) {
        return;
      }
      
      const stats = fs.statSync(dir);
      if (!stats.isDirectory()) {
        return;
      }
      
      // Skip system and cache directories
      if (this.#shouldSkipDirectory(dir)) {
        return;
      }
      
      // Check for package.json in current directory
      this.#checkForPackageJsonSync(dir);
      
      // Read directory contents
      let items;
      try {
        items = fs.readdirSync(dir);
      } catch {
        // Skip inaccessible directories
        return;
      }
      
      // Process subdirectories (add to queue instead of recursive calls)
      for (const item of items) {
        if (!this.#isScanning) break;
        
        const fullPath = path.join(dir, item);
        
        try {
          const itemStats = fs.statSync(fullPath);
          if (itemStats.isDirectory()) {
            // Skip if should be skipped
            if (!this.#shouldSkipDirectory(fullPath)) {
              this.#enqueueDirectory(fullPath);
            }
          }
        } catch {
          // Skip inaccessible items
          continue;
        }
      }
    } catch (error) {
      // Skip any errors and continue scanning
    }
  }

  /**
   * Returns all found packages as an array
   * Waits for any ongoing scan to complete
   * @returns {Promise<Array>}
   */
  static async getAllPackages() {
    if (this.#isScanning) {
      return new Promise((resolve, reject) => {
        if (!this.#instance) {
          reject(new Error('Scanner not initialized'));
          return;
        }
        
        const onComplete = (packages) => {
          this.#instance.off('error', onError);
          resolve(packages);
        };
        
        const onError = (error) => {
          this.#instance.off('complete', onComplete);
          reject(error);
        };
        
        this.#instance.once('complete', onComplete);
        this.#instance.once('error', onError);
      });
    }
    return this.#foundPackages;
  }

  /**
   * Stops the current scan
   */
  static stopScan() {
    this.#isScanning = false;
    this.#scanQueue = [];
    if (this.#instance) {
      this.#instance.emit('stopped');
    }
  }

  /**
   * Gets Linux root directories
   * @returns {Array<string>}
   */
  static #getLinuxRootDirectories() {
    const roots = new Set(['/']);
    
    // Add current user's home directory
    try {
      const home = process.env.HOME;
      if (home && home !== '/root' && fs.existsSync(home)) {
        roots.add(home);
      }
    } catch {
      // Ignore home directory errors
    }
    
    // Add current directory
    const cwd = process.cwd();
    if (cwd) {
      roots.add(cwd);
    }
    
    // Limit to fewer directories initially
    return Array.from(roots);
  }

  /**
   * Checks if a directory should be skipped
   * @param {string} dirPath - Directory path
   * @returns {boolean}
   */
  static #shouldSkipDirectory(dirPath) {
    const dirName = path.basename(dirPath);
    
    // Quick checks first
    if (dirName.startsWith('.')) return true;
    
    const skipDirs = new Set([
      'node_modules',
      '.git',
      '.cache',
      '.npm',
      '.yarn',
      '.pnpm',
      '.docker',
      '.vscode',
      '.idea',
      'tmp',
      'temp',
      'cache',
      'log',
      'logs',
      'proc',
      'sys',
      'dev',
      'run',
      'snap',
      'lost+found',
      'recovery',
      '__pycache__',
      'venv',
      'env',
      'virtualenv',
      'dist',
      'build',
      'coverage',
      '.next',
      '.nuxt',
      '.output'
    ]);
    
    if (skipDirs.has(dirName)) return true;
    
    // Check path patterns
    const skipPatterns = [
      /node_modules$/i,
      /\.git$/i,
      /\.cache$/i,
      /proc$/i,
      /sys$/i,
      /dev$/i,
      /run$/i,
      /snap$/i,
    ];
    
    for (const pattern of skipPatterns) {
      if (pattern.test(dirPath)) {
        return true;
      }
    }
    
    return false;
  }

  /**
   * Checks for package.json and files with export default in directory
   * Uses synchronous methods for better memory control
   * @param {string} dir - Directory to check
   */
  static #checkForPackageJsonSync(dir) {
    const packageJsonPath = path.join(dir, 'package.json');
    
    try {
      if (!fs.existsSync(packageJsonPath)) {
        return;
      }
      
      // Read package.json
      const packageContent = fs.readFileSync(packageJsonPath, 'utf8');
      const packageJson = JSON.parse(packageContent);
      
      // Find files with export default in the same directory
      const filesWithExportDefault = this.#findFilesWithExportDefaultSync(dir);
      
      if (filesWithExportDefault.length > 0) {
        // Get the largest file
        const largestFile = this.#getLargestFile(filesWithExportDefault);
        
        const result = {
          Package: packageJson,
          FileName: path.basename(largestFile.path),
          Export: largestFile.path
        };
        
        this.#foundPackages.push(result);
        
        // Emit found event
        if (this.#instance) {
          this.#instance.emit('found', result);
        }
      }
    } catch (error) {
      // Skip invalid package.json files
    }
  }

  /**
   * Finds files with export default in directory (synchronous)
   * @param {string} dir - Directory to search
   * @returns {Array<{path: string, size: number}>}
   */
  static #findFilesWithExportDefaultSync(dir) {
    const filesWithExport = [];
    
    try {
      const items = fs.readdirSync(dir);
      
      for (const item of items) {
        const fullPath = path.join(dir, item);
        
        try {
          const stats = fs.statSync(fullPath);
          
          if (stats.isFile()) {
            // Check for JavaScript/TypeScript files by extension only
            const ext = path.extname(item).toLowerCase();
            const isJsFile = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'].includes(ext);
            
            if (isJsFile) {
              // For memory efficiency, only read first 10KB of file
              const buffer = Buffer.alloc(10240);
              const fd = fs.openSync(fullPath, 'r');
              const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
              fs.closeSync(fd);
              
              if (bytesRead > 0) {
                const content = buffer.toString('utf8', 0, bytesRead);
                
                // Check for export default
                if (content.includes('export default')) {
                  filesWithExport.push({
                    path: fullPath,
                    size: stats.size
                  });
                }
              }
            }
          }
        } catch {
          // Skip inaccessible files
          continue;
        }
      }
    } catch {
      // Skip inaccessible directories
    }
    
    return filesWithExport;
  }

  /**
   * Gets the largest file from array
   * @param {Array<{path: string, size: number}>} files
   * @returns {{path: string, size: number}}
   */
  static #getLargestFile(files) {
    if (files.length === 0) {
      return null;
    }
    
    let largest = files[0];
    for (let i = 1; i < files.length; i++) {
      if (files[i].size > largest.size) {
        largest = files[i];
      }
    }
    return largest;
  }

  /**
   * Attempts to force garbage collection (Node.js specific)
   */
  static #forceGarbageCollection() {
    if (global.gc) {
      try {
        global.gc();
      } catch (e) {
        // GC might not be available
      }
    }
    
    // Clear some internal caches periodically
    if (this.#scannedPaths.size > 50000) {
      // Keep only recent scans to reduce memory
      const pathsArray = Array.from(this.#scannedPaths);
      if (pathsArray.length > 30000) {
        this.#scannedPaths = new Set(pathsArray.slice(-30000));
      }
    }
  }

  /**
   * Get scanner instance
   * @returns {PackScan}
   */
  static getInstance() {
    if (!this.#instance) {
      new PackScan();
    }
    return this.#instance;
  }

  /**
   * Get current scan statistics
   * @returns {Object}
   */
  static getStats() {
    return {
      isScanning: this.#isScanning,
      foundPackages: this.#foundPackages.length,
      scannedPaths: this.#scannedPaths.size,
      queueSize: this.#scanQueue.length
    };
  }
}

export default PackScan;

let scanner = PackScan.getInstance()

scanner.on('found', (packageInfo) => {
    console.log('Found package:', packageInfo.FileName);
    console.log('Package name:', packageInfo.Package.name);
    console.log('Package name:', packageInfo.Package.version);
    console.log('Export path:', packageInfo.Export);
    console.log('---');
  });

  await PackScan.scanEntireSystem()