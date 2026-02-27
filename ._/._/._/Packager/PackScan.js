// PackScan.js
import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';

class PackScan extends EventEmitter {
  constructor(options = {}) {
    super();
    
    // Vast default exclude directories
    this.defaultExcludes = [
      // Node.js and package managers
      'node_modules', '.npm', '.yarn', '.pnpm', '.cache', 
      'bower_components', 'jspm_packages', 'vendor',
      
      // Version control
      '.git', '.svn', '.hg', '.cvs', '.gitlab', '.github',
      
      // IDE and editor files
      '.vscode', '.idea', '.vs', '.eclipse', '.settings',
      '.project', '.classpath', '.sublime-*', '*.sublime-*',
      
      // Build and distribution
      'dist', 'build', 'out', 'target', 'bin', 'obj',
      'release', 'debug', 'coverage', '.next', '.nuxt',
      '.output', '.vercel', '.netlify', 'public/build',
      
      // Cache and temp directories
      'tmp', 'temp', 'cache', '.cache', '.temp', 
      '*.log', 'logs', '*.pid', '*.seed', '*.pid.lock',
      
      // OS and system directories
      '.Trash', '.Trashes', '$Recycle.Bin', 'System Volume Information',
      'lost+found', '.fseventsd', '.Spotlight-V100', '.TemporaryItems',
      
      // Python and other languages
      '__pycache__', '*.pyc', 'venv', '.venv', 'env', '.env',
      'virtualenv', '.virtualenv', '*.egg-info', '*.egg',
      '.mypy_cache', '.pytest_cache', '.tox',
      
      // Ruby
      '.bundle', 'vendor/bundle', 'Gemfile.lock',
      
      // PHP
      'vendor', 'composer.lock',
      
      // Java/Scala
      '.gradle', 'gradle', 'mvn', 'target', '.mvn',
      
      // Go
      'pkg/mod', 'vendor', '*.sum',
      
      // Rust
      'target', 'Cargo.lock',
      
      // Docker and containers
      '.docker', 'docker', '*.docker',
      
      // Minified and compressed
      '*.min.js', '*.min.css', '*.map', '*.gz', '*.zip',
      '*.tar', '*.tgz', '*.rar', '*.7z',
      
      // Media files
      '*.mp4', '*.mp3', '*.avi', '*.mkv', '*.mov',
      '*.jpg', '*.jpeg', '*.png', '*.gif', '*.ico',
      '*.svg', '*.woff', '*.woff2', '*.ttf', '*.eot',
      
      // Binary and compiled files
      '*.exe', '*.dll', '*.so', '*.dylib', '*.class',
      '*.o', '*.obj', '*.pyo', '*.pyd',
      
      // Database and data files
      '*.db', '*.sqlite', '*.sqlite3', '*.data',
      '*.log', '*.csv', '*.tsv',
      
      // Virtual environments and containers
      '.vagrant', 'Vagrantfile', 'Dockerfile', 'docker-compose.yml',
      '.devcontainer', '.codesandbox', '.stackblitz',
      
      // System directories to avoid
      '/proc', '/sys', '/dev', '/run', '/var/run',
      '/proc/*', '/sys/*', '/dev/*', '/run/*', '/var/run/*'
    ];

    this.options = {
      rootDirs: ['/home', '/usr/local'],
      excludeDirs: [...this.defaultExcludes, ...(options.excludeDirs || [])],
      continueAfterHome: true,
      maxDepth: 50,
      verbose: false,
      ...options
    };
    
    this.results = [];
    this.scannedCount = 0;
    this.startTime = null;
  }

  async scan() {
    this.results = [];
    this.scannedCount = 0;
    this.startTime = Date.now();
    
    // Scan priority directories first
    for (const rootDir of this.options.rootDirs) {
      if (this.pathExists(rootDir)) {
        await this.scanDirectory(rootDir, 0);
      }
    }
    
    // Continue to root if requested
    if (this.options.continueAfterHome) {
      await this.scanDirectory('/', 0);
    }
    
    return this.results;
  }

  pathExists(dirPath) {
    try {
      fs.accessSync(dirPath, fs.constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  shouldExclude(dirPath, dirName) {
    const fullPath = dirPath.toLowerCase();
    const name = dirName.toLowerCase();
    
    // Check against exclude patterns
    for (const pattern of this.options.excludeDirs) {
      const patternLower = pattern.toLowerCase();
      
      // Handle wildcard patterns
      if (patternLower.includes('*')) {
        const regexPattern = patternLower
          .replace(/\./g, '\\.')
          .replace(/\*/g, '.*');
        const regex = new RegExp(`^${regexPattern}$`);
        if (regex.test(name)) {
          return true;
        }
      } else if (name === patternLower || 
                 fullPath.includes(`/${patternLower}/`) || 
                 fullPath.endsWith(`/${patternLower}`)) {
        return true;
      }
      
      // Check for system paths
      if (patternLower.startsWith('/') && fullPath.startsWith(patternLower)) {
        return true;
      }
    }
    return false;
  }

  async scanDirectory(dir, depth = 0) {
    if (depth > this.options.maxDepth) {
      return;
    }

    try {
      const files = await fs.promises.readdir(dir);
      
      for (const file of files) {
        const fullPath = path.join(dir, file);
        
        try {
          const stat = await fs.promises.stat(fullPath);
          
          if (stat.isDirectory()) {
            // Skip excluded directories
            if (!this.shouldExclude(fullPath, file)) {
              await this.scanDirectory(fullPath, depth + 1);
            } else if (this.options.verbose) {
              console.log(`Skipping excluded: ${fullPath}`);
            }
          } else if (file === 'package.json') {
            await this.processPackageJson(dir);
            
            // Progress indicator
            this.scannedCount++;
            if (this.scannedCount % 100 === 0) {
              const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
              console.log(`📊 Scanned ${this.scannedCount} package.json files (${elapsed}s)...`);
            }
          }
        } catch (err) {
          // Skip files/directories we can't access
          continue;
        }
      }
    } catch (err) {
      // Skip directories we can't read
    }
  }

  async processPackageJson(packagePath) {
    try {
      const packageJsonPath = path.join(packagePath, 'package.json');
      const content = await fs.promises.readFile(packageJsonPath, 'utf8');
      const packageJson = JSON.parse(content);
      
      // Find JS files in the same directory
      const files = await fs.promises.readdir(packagePath);
      const jsFiles = files.filter(f => 
        f.endsWith('.js') && 
        !f.endsWith('.test.js') && 
        !f.endsWith('.spec.js') &&
        !f.endsWith('.min.js') &&
        !f.endsWith('.config.js') &&
        !f.endsWith('.setup.js') &&
        !f.endsWith('.jest.js')
      );
      
      let packageInfo = {
        package: packageJson.name || null,
        exported: null,
        path: null,
        size: null,
        lastmod: null
      };

      // If no package name, find the largest JS file with export default
      if (!packageInfo.package) {
        const largestJsFile = await this.findLargestJsFileWithDefaultExport(jsFiles, packagePath);
        if (largestJsFile) {
          packageInfo.package = largestJsFile.fileName.toLowerCase().replace('.js', '');
          packageInfo.exported = largestJsFile.exportedName;
          packageInfo.path = largestJsFile.fullPath;
        }
      } else {
        // Find a JS file with a single export default
        for (const jsFile of jsFiles) {
          const jsFilePath = path.join(packagePath, jsFile);
          const exportedName = await this.findSingleDefaultExport(jsFilePath);
          
          if (exportedName) {
            packageInfo.exported = exportedName;
            packageInfo.path = jsFilePath;
            break;
          }
        }
      }

      // If we found both package and exported, get directory info
      if (packageInfo.package && packageInfo.exported) {
        const dirInfo = await this.getDirectoryInfo(packagePath);
        packageInfo.size = dirInfo.size;
        packageInfo.lastmod = dirInfo.lastmod;
        
        this.results.push(packageInfo);
        this.emit('found', packageInfo);
      }
    } catch (err) {
      // Skip invalid package.json
    }
  }

  async findLargestJsFileWithDefaultExport(jsFiles, packagePath) {
    let largestFile = null;
    let largestSize = 0;

    for (const jsFile of jsFiles) {
      const jsFilePath = path.join(packagePath, jsFile);
      
      try {
        const stat = await fs.promises.stat(jsFilePath);
        const exportedName = await this.findSingleDefaultExport(jsFilePath);
        
        if (exportedName && stat.size > largestSize) {
          largestSize = stat.size;
          largestFile = {
            fileName: jsFile,
            fullPath: jsFilePath,
            exportedName: exportedName
          };
        }
      } catch (err) {
        continue;
      }
    }

    return largestFile;
  }

  async findSingleDefaultExport(filePath) {
    try {
      const content = await fs.promises.readFile(filePath, 'utf8');
      
      // Match different export default patterns
      const patterns = [
        /export\s+default\s+(\w+)/,                    // export default ClassName
        /export\s+default\s+class\s+(\w+)/,             // export default class ClassName
        /export\s+default\s+function\s+(\w+)/,          // export default function functionName
        /export\s+default\s+const\s+(\w+)\s*=/,         // export default const name = 
        /export\s*{\s*(\w+)\s+as\s+default\s*}/,        // export { name as default }
        /export\s*{\s*(\w+)\s*as\s+default\s*}/,        // export { name as default }
        /export\s*{\s*default\s+as\s+(\w+)\s*}/,        // export { default as name }
        /export\s*{\s*default\s+as\s+(\w+)\s*}/         // export { default as name }
      ];

      for (const pattern of patterns) {
        const match = content.match(pattern);
        if (match && match[1]) {
          // Check if there are other exports (to ensure single export)
          // Remove comments first to avoid false positives
          const contentWithoutComments = content
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/\/\/.*/g, '');
          
          const otherExports = contentWithoutComments.match(/export\s+(?!default)[^{]+\{/g);
          const namedExports = contentWithoutComments.match(/export\s+const\s+\w+|export\s+let\s+\w+|export\s+var\s+\w+|export\s+function\s+\w+|export\s+class\s+\w+/g);
          
          const hasOtherExports = (otherExports && otherExports.length > 0) || 
                                 (namedExports && namedExports.length > 0);
          
          if (!hasOtherExports) {
            return match[1];
          }
          break;
        }
      }

      return null;
    } catch (err) {
      return null;
    }
  }

  async getDirectoryInfo(dirPath) {
    let totalSize = 0;
    let latestMod = new Date(0);

    const processDir = async (dir) => {
      try {
        const files = await fs.promises.readdir(dir);
        
        for (const file of files) {
          const fullPath = path.join(dir, file);
          
          // Skip excluded directories in size calculation
          if (this.shouldExclude(fullPath, file)) {
            continue;
          }
          
          try {
            const stat = await fs.promises.stat(fullPath);
            
            if (stat.isDirectory()) {
              await processDir(fullPath);
            } else {
              totalSize += stat.size;
              if (stat.mtime > latestMod) {
                latestMod = stat.mtime;
              }
            }
          } catch (err) {
            continue;
          }
        }
      } catch (err) {
        // Skip directories we can't read
      }
    };

    await processDir(dirPath);

    // Format size
    const sizeFormatted = this.formatSize(totalSize);
    
    // Format date
    const dateFormatted = this.formatDate(latestMod);

    return {
      size: sizeFormatted,
      lastmod: dateFormatted
    };
  }

  formatSize(bytes) {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = bytes;
    let unitIndex = 0;
    
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }
    
    return `${size.toFixed(2)}${units[unitIndex]}`;
  }

  formatDate(date) {
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = date.getFullYear();
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    
    return `${day}/${month}/${year} ${hours}:${minutes}`;
  }

  getSummary() {
    const endTime = Date.now();
    const duration = ((endTime - this.startTime) / 1000).toFixed(2);
    
    return {
      totalFound: this.results.length,
      scannedFiles: this.scannedCount,
      durationSeconds: duration,
      startTime: this.startTime ? new Date(this.startTime).toISOString() : null,
      endTime: new Date().toISOString()
    };
  }
}

export default PackScan;


/*
const scanner = new PackScan({
  rootDirs: ['/home', '/usr/local'],
  continueAfterHome: true,
  verbose: false
});

// Listen for found packages
scanner.on('found', (pkg) => {
  console.log(`📦 Found: ${pkg.package} -> ${pkg.exported} (${pkg.size})`);
});

console.log('🔍 Starting scan...');
console.log('⏳ This may take a while depending on your system...\n');

scanner.scan()
  .then(results => {
    const summary = scanner.getSummary();
    
    console.log('\n' + '='.repeat(60));
    console.log('📊 SCAN SUMMARY');
    console.log('='.repeat(60));
    console.log(`✅ Found: ${summary.totalFound} packages`);
    console.log(`📁 Scanned: ${summary.scannedFiles} package.json files`);
    console.log(`⏱️  Duration: ${summary.durationSeconds} seconds`);
    
    if (results.length > 0) {
      console.log('\n📦 First 10 results:');
      results.slice(0, 10).forEach((r, i) => {
        console.log(`   ${i+1}. ${r.package} (${r.exported}) - ${r.size}`);
      });
    }
    
    console.log('\n✨ Scan complete!');
  })
  .catch(err => {
    console.error('❌ Error:', err.message);
  });
  */