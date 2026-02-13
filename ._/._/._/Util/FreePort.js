import net from 'net';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration - Changed to system global directory
const LOCK_DIR = path.join(os.tmpdir(), 'node-port-locks-global');
const LOCK_DURATION = 10000; // 10 seconds
const CLEANUP_INTERVAL = 30000; // 30 seconds

// Global queue and state
let queue = [];
let processing = false;
let cleanupInterval;
let initializationPromise = null;

/**
 * Initialize the lock directory and cleanup process
 */
async function initialize() {
  // Ensure initialization only happens once
  if (!initializationPromise) {
    initializationPromise = (async () => {
      try {
        await fs.mkdir(LOCK_DIR, { recursive: true });
        
        // Start cleanup interval if not already running
        if (!cleanupInterval) {
          cleanupInterval = setInterval(cleanupExpiredLocks, CLEANUP_INTERVAL);
          process.on('exit', () => {
            if (cleanupInterval) clearInterval(cleanupInterval);
          });
        }
      } catch (error) {
        console.warn('Could not initialize global port lock directory:', error.message);
      }
    })();
  }
  
  return initializationPromise;
}

/**
 * Finds the next available network port starting from specified number
 * @param {number} [start=3000] - Port number to begin checking
 * @returns {Promise<number>} First available port found
 * @throws {Error} If no ports are available (after start through 65535)
 */
export async function FreePort(start = 3000) {
  await initialize();
  
  return new Promise((resolve, reject) => {
    // Add to queue
    queue.push({ start, resolve, reject });
    
    // Process queue if not already processing
    if (!processing) {
      processQueue();
    }
  });
}

/**
 * Process the queue of port requests
 */
async function processQueue() {
  if (processing || queue.length === 0) return;
  
  processing = true;
  
  while (queue.length > 0) {
    const request = queue.shift();
    try {
      const port = await findAvailablePortWithLock(request.start);
      request.resolve(port);
    } catch (error) {
      request.reject(error);
    }
  }
  
  processing = false;
}

/**
 * Finds an available port and creates a lock file
 * @param {number} start - Starting port number
 * @returns {Promise<number>} Available port with lock
 */
async function findAvailablePortWithLock(start) {
  for (let port = start; port < 65536; port++) {
    // Check if port is locked using global system lock
    if (await isPortLocked(port)) {
      continue;
    }
    
    // Check if port is actually available
    if (await isPortAvailable(port)) {
      // Try to create global system lock file
      if (await createLockFile(port)) {
        return port;
      }
    }
  }
  throw new Error('No available ports found');
}

/**
 * Checks if a port is currently locked in global system directory
 * @param {number} port - Port number to check
 * @returns {Promise<boolean>} True if port is locked
 */
async function isPortLocked(port) {
  const lockFile = getLockFilePath(port);
  
  try {
    const stats = await fs.stat(lockFile);
    const now = Date.now();
    
    // Check if lock has expired
    if (now - stats.mtime.getTime() > LOCK_DURATION) {
      // Lock expired, remove it
      await fs.unlink(lockFile).catch(() => {});
      return false;
    }
    
    return true;
  } catch (error) {
    // Lock file doesn't exist or can't be accessed
    return false;
  }
}

/**
 * Creates a lock file for a port in global system directory
 * @param {number} port - Port number to lock
 * @returns {Promise<boolean>} True if lock was created successfully
 */
async function createLockFile(port) {
  const lockFile = getLockFilePath(port);
  
  try {
    // Try to create lock file exclusively in global system directory
    const fd = await fs.open(lockFile, 'wx');
    await fd.close();
    
    // Write process info to lock file (optional, for debugging)
    const lockInfo = {
      port,
      timestamp: Date.now(),
      pid: process.pid,
      expires: Date.now() + LOCK_DURATION,
      // Additional info to identify it's a global system lock
      global: true,
      hostname: os.hostname()
    };
    
    await fs.writeFile(lockFile, JSON.stringify(lockInfo, null, 2));
    return true;
  } catch (error) {
    // Lock file already exists or can't be created in global directory
    return false;
  }
}

/**
 * Checks if a specific port is currently available
 * @param {number} port - Port number to check
 * @returns {Promise<boolean>} True if port is available
 */
async function isPortAvailable(port) {
  return new Promise((resolve) => {
    const test = net.createServer();
    
    // Set timeout to avoid hanging
    const timeout = setTimeout(() => {
      test.close(() => resolve(false));
    }, 1000);
    
    test.once('error', () => {
      clearTimeout(timeout);
      test.close(() => resolve(false));
    });
    
    test.once('listening', () => {
      clearTimeout(timeout);
      test.close(() => resolve(true));
    });
    
    test.listen(port);
  });
}

/**
 * Gets the file path for a port lock file in global system directory
 * @param {number} port - Port number
 * @returns {string} Global system lock file path
 */
function getLockFilePath(port) {
  return path.join(LOCK_DIR, `port-${port}.lock`);
}

/**
 * Clean up expired lock files from global system directory
 */
async function cleanupExpiredLocks() {
  try {
    const files = await fs.readdir(LOCK_DIR);
    
    for (const file of files) {
      if (file.endsWith('.lock')) {
        const filePath = path.join(LOCK_DIR, file);
        
        try {
          const stats = await fs.stat(filePath);
          const now = Date.now();
          
          if (now - stats.mtime.getTime() > LOCK_DURATION) {
            await fs.unlink(filePath).catch(() => {});
          }
        } catch (error) {
          // Ignore errors for individual files
        }
      }
    }
  } catch (error) {
    // Ignore cleanup errors
  }
}

/**
 * Manually release a port lock from global system directory (useful for testing or explicit cleanup)
 * @param {number} port - Port number to release
 */
export async function releasePort(port) {
  const lockFile = getLockFilePath(port);
  
  try {
    await fs.unlink(lockFile);
  } catch (error) {
    // Lock file doesn't exist or can't be removed
  }
}

/**
 * Get currently locked ports from global system directory (for debugging/monitoring)
 * @returns {Promise<number[]>} Array of locked ports
 */
export async function getLockedPorts() {
  try {
    const files = await fs.readdir(LOCK_DIR);
    const lockedPorts = [];
    
    for (const file of files) {
      if (file.startsWith('port-') && file.endsWith('.lock')) {
        const port = parseInt(file.replace('port-', '').replace('.lock', ''));
        if (!isNaN(port) && await isPortLocked(port)) {
          lockedPorts.push(port);
        }
      }
    }
    
    return lockedPorts;
  } catch (error) {
    return [];
  }
}

export default FreePort;