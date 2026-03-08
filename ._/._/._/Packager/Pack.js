#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const readdir = promisify(fs.readdir);
const stat = promisify(fs.stat);
const readFile = promisify(fs.readFile);
const access = promisify(fs.access);

// ANSI color codes for terminal output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  underscore: '\x1b[4m',
  blink: '\x1b[5m',
  reverse: '\x1b[7m',
  hidden: '\x1b[8m',
  
  black: '\x1b[30m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  
  bgBlack: '\x1b[40m',
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgBlue: '\x1b[44m',
  bgMagenta: '\x1b[45m',
  bgCyan: '\x1b[46m',
  bgWhite: '\x1b[47m'
};

// Directories to ignore
const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.cache', 'tmp', 'temp']);

// File extensions by language for LOC counting
const LANGUAGE_EXTENSIONS = {
  assembly: ['.asm', '.s', '.inc', '.nasm', '.masm', '.arm', '.lst'],
  javascript: ['.js', '.jsx', '.mjs', '.cjs'],
  typescript: ['.ts', '.tsx'],
  python: ['.py', '.py3', '.pyc', '.pyo', '.pyd', '.pyw'],
  java: ['.java', '.class'],
  cpp: ['.cpp', '.cc', '.cxx', '.hpp', '.h', '.hh', '.hxx', '.c++', '.h++'],
  c: ['.c', '.h'],
  csharp: ['.cs', '.csx'],
  go: ['.go'],
  ruby: ['.rb', '.rbw', '.gemspec'],
  php: ['.php', '.php3', '.php4', '.php5', '.phtml'],
  swift: ['.swift'],
  kotlin: ['.kt', '.kts', '.ktm'],
  rust: ['.rs', '.rlib'],
  html: ['.html', '.htm', '.xhtml', '.html5'],
  css: ['.css', '.scss', '.sass', '.less', '.styl'],
  markdown: ['.md', '.markdown', '.mdown', '.mdwn'],
  shell: ['.sh', '.bash', '.zsh', '.fish', '.ksh'],
  sql: ['.sql', '.mysql', '.pgsql'],
  yaml: ['.yml', '.yaml'],
  docker: ['Dockerfile', '.dockerignore'],
  git: ['.gitignore', '.gitattributes', '.gitmodules'],
  xml: ['.xml', '.xsd', '.xslt', '.xsl'],
  perl: ['.pl', '.pm', '.t', '.pod'],
  lua: ['.lua'],
  r: ['.r', '.rdata'],
  dart: ['.dart'],
  scala: ['.scala', '.sc'],
  groovy: ['.groovy', '.gvy', '.gy', '.gsh'],
  powershell: ['.ps1', '.psm1', '.psd1'],
  make: ['Makefile', '.mk', '.mak'],
  cmake: ['CMakeLists.txt', '.cmake']
};

// Archive file extensions
const ARCHIVE_EXTENSIONS = new Set([
  '.zip', '.tar', '.gz', '.tgz', '.rar', '.7z', '.bz2', '.xz', '.zst', '.br',
  '.jar', '.war', '.ear', '.apk', '.ipa', '.deb', '.rpm', '.pkg', '.msi',
  '.json', '.jsonc', '.json5'
]);

// Binary file extensions
const BINARY_EXTENSIONS = new Set([
  // Executables
  '.exe', '.dll', '.so', '.dylib', '.bin', '.out', '.elf', '.app',
  
  // Images
  '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.ico', '.svg', '.webp', '.tiff', '.psd',
  '.raw', '.cr2', '.nef', '.orf', '.sr2', '.eps', '.ai', '.cdr', '.wmf',
  
  // Fonts
  '.ttf', '.otf', '.woff', '.woff2', '.eot', '.pfb', '.pfm', '.afm',
  
  // Audio/Video
  '.mp3', '.mp4', '.wav', '.avi', '.mov', '.mkv', '.flac', '.ogg', '.webm',
  '.m4a', '.m4v', '.wma', '.wmv', '.aac', '.ac3', '.ape', '.mid', '.midi',
  '.mpg', '.mpeg', '.m2v', '.mts', '.m2ts', '.ts', '.flv', '.swf', '.vob',
  '.3gp', '.3g2', '.asf', '.rm', '.ra', '.ram', '.divx', '.xvid',
  
  // Documents
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods',
  '.odp', '.odg', '.odf', '.pub', '.rtf', '.wpd', '.wps', '.key', '.numbers',
  '.pages', '.ps', '.epub', '.mobi', '.azw', '.djvu',
  
  // Databases
  '.db', '.sqlite', '.sqlite3', '.mdb', '.accdb', '.dbf', '.pdb', '.frm',
  '.myd', '.myi', '.ibd', '.fdb', '.gdb', '.kdb', '.kdbx',
  
  // Object files
  '.o', '.obj', '.lib', '.a', '.la', '.lo', '.mod', '.ko', '.prx',
  '.class', '.dex', '.odex'
]);

// Assembly extensions set for quick lookup
const ASSEMBLY_EXTENSIONS = new Set(['.asm', '.s', '.inc', '.nasm', '.masm', '.arm', '.lst']);

// Helper to format bytes to human readable
function formatSize(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${units[i]}`;
}

// Helper to format bytes to MB with 2 decimals
function formatMB(bytes) {
  return (bytes / (1024 * 1024)).toFixed(2);
}

// ===== GENERIC BINARY DETECTION =====

/**
 * Check if a file is an archive based on extension
 */
function isArchiveFile(filename) {
  const ext = path.extname(filename).toLowerCase();
  return ARCHIVE_EXTENSIONS.has(ext);
}

/**
 * GENERIC: Check if a file is a binary executable
 * This works for ANY file without extension that's executable
 */
async function isExecutableBinary(filePath, stats) {
  try {
    // Check if it's a file and has execute permission
    if (stats.isFile()) {
      // Check execute permission (fs.constants.X_OK)
      await access(filePath, fs.constants.X_OK);
      
      // Files with execute permission and no extension are likely binaries
      const ext = path.extname(filePath).toLowerCase();
      if (ext === '') {
        return true;
      }
      
      // Also check common binary extensions
      if (BINARY_EXTENSIONS.has(ext)) {
        return true;
      }
    }
    return false;
  } catch {
    // No execute permission
    return false;
  }
}

/**
 * GENERIC: Quick check for binary content (looks for null bytes)
 * This catches any file that's likely binary regardless of extension
 */
async function isBinaryContent(filePath, stats) {
  // Skip very small files
  if (stats.size < 1024) return false;
  
  try {
    const fd = await fs.promises.open(filePath, 'r');
    try {
      const buffer = Buffer.alloc(1024);
      const { bytesRead } = await fd.read(buffer, 0, 1024, 0);
      
      // Check for null bytes in the first chunk
      for (let i = 0; i < bytesRead; i++) {
        if (buffer[i] === 0) {
          return true;
        }
      }
      return false;
    } finally {
      await fd.close();
    }
  } catch {
    return false;
  }
}

/**
 * GENERIC: Main function to determine if a file is binary
 * Uses multiple strategies:
 * 1. Common binary extensions
 * 2. Execute permission + no extension (Unix executables)
 * 3. Binary content detection (null bytes)
 */
async function isBinaryFile(filePath, stats) {
  const filename = path.basename(filePath);
  const ext = path.extname(filename).toLowerCase();
  
  // Rule 1: Check by extension (fastest)
  if (BINARY_EXTENSIONS.has(ext)) {
    return true;
  }
  
  // Rule 2: Check if it's an executable with no extension
  if (ext === '') {
    try {
      await access(filePath, fs.constants.X_OK);
      return true; // It's executable with no extension = binary
    } catch {
      // Not executable, continue to next check
    }
  }
  
  // Rule 3: For larger files, check content for null bytes
  if (stats.size > 1024) {
    return await isBinaryContent(filePath, stats);
  }
  
  return false;
}

/**
 * Base Analyzer class
 */
class BaseAnalyzer {
  constructor() {
    this.name = 'Base Analyzer';
  }

  async processFile(filePath, stats) {
    // Override in child classes
  }

  getReport() {
    return {};
  }

  reset() {
    // Override in child classes
  }
}

/**
 * Analyzer for total directory size (with GENERIC binary detection)
 */
class TotalSizeAnalyzer extends BaseAnalyzer {
  constructor(ignoreDirs) {
    super();
    this.name = 'Total Size Analyzer';
    this.ignoreDirs = ignoreDirs;
    this.totalSize = 0;
    this.codeSize = 0;
    this.binarySize = 0;
    this.archiveSize = 0;
    this.fileCount = 0;
    this.dirCount = 0;
    this.skippedDirs = [];
    this.skippedCount = 0;
  }

  async processFile(filePath, stats) {
    // Check if we're in an ignored directory
    const relativePath = path.relative(process.cwd(), filePath);
    const pathParts = relativePath.split(path.sep);
    
    for (const part of pathParts) {
      if (this.ignoreDirs.has(part)) {
        this.skippedDirs.push(part);
        this.skippedCount++;
        return;
      }
    }

    this.totalSize += stats.size;
    
    if (stats.isFile()) {
      const filename = path.basename(filePath);
      
      // Check archives first
      if (isArchiveFile(filename)) {
        this.archiveSize += stats.size;
      }
      // Use GENERIC binary detection
      else if (await isBinaryFile(filePath, stats)) {
        this.binarySize += stats.size;
      }
      else {
        // Check if it's a code file
        const ext = path.extname(filename).toLowerCase();
        let isCode = false;
        
        for (const extensions of Object.values(LANGUAGE_EXTENSIONS)) {
          if (extensions.includes(ext) || extensions.includes(filename)) {
            this.codeSize += stats.size;
            isCode = true;
            break;
          }
        }
      }
      
      this.fileCount++;
    } else if (stats.isDirectory()) {
      this.dirCount++;
    }
  }

  getReport() {
    return {
      totalSize: this.totalSize,
      totalSizeFormatted: formatSize(this.totalSize),
      totalSizeMB: formatMB(this.totalSize),
      codeSize: this.codeSize,
      codeSizeFormatted: formatSize(this.codeSize),
      codeSizeMB: formatMB(this.codeSize),
      binarySize: this.binarySize,
      binarySizeFormatted: formatSize(this.binarySize),
      binarySizeMB: formatMB(this.binarySize),
      archiveSize: this.archiveSize,
      archiveSizeFormatted: formatSize(this.archiveSize),
      archiveSizeMB: formatMB(this.archiveSize),
      fileCount: this.fileCount,
      dirCount: this.dirCount,
      skippedDirs: [...new Set(this.skippedDirs)],
      skippedCount: this.skippedCount
    };
  }

  reset() {
    this.totalSize = 0;
    this.codeSize = 0;
    this.binarySize = 0;
    this.archiveSize = 0;
    this.fileCount = 0;
    this.dirCount = 0;
    this.skippedDirs = [];
    this.skippedCount = 0;
  }
}

/**
 * Analyzer for package.json files
 */
class PackageJsonAnalyzer extends BaseAnalyzer {
  constructor() {
    super();
    this.name = 'Package.json Analyzer';
    this.packageJsonFiles = [];
    this.results = [];
    this.totalDeps = 0;
    this.totalDevDeps = 0;
    this.projectsWithDeps = 0;
  }

  async processFile(filePath, stats) {
    if (path.basename(filePath) === 'package.json') {
      this.packageJsonFiles.push(filePath);
      
      try {
        const content = await readFile(filePath, 'utf8');
        const packageJson = JSON.parse(content);
        
        const dependencies = packageJson.dependencies || {};
        const devDependencies = packageJson.devDependencies || {};
        
        const result = {
          path: filePath,
          name: packageJson.name || path.basename(path.dirname(filePath)),
          version: packageJson.version || 'N/A',
          dependencyCount: Object.keys(dependencies).length,
          devDependencyCount: Object.keys(devDependencies).length,
          dependencies: Object.keys(dependencies),
          hasProductionDeps: Object.keys(dependencies).length > 0
        };
        
        this.results.push(result);
        this.totalDeps += result.dependencyCount;
        this.totalDevDeps += result.devDependencyCount;
        if (result.hasProductionDeps) {
          this.projectsWithDeps++;
        }
      } catch (error) {
        this.results.push({
          path: filePath,
          error: `Failed to parse: ${error.message}`
        });
      }
    }
  }

  getReport() {
    const totalFiles = this.packageJsonFiles.length;
    const pureProjects = totalFiles - this.projectsWithDeps;
    const purityPercentage = totalFiles > 0 ? (pureProjects / totalFiles * 100).toFixed(2) : '0.00';
    
    return {
      totalFiles,
      projectsWithDeps: this.projectsWithDeps,
      totalDeps: this.totalDeps,
      totalDevDeps: this.totalDevDeps,
      averageDeps: totalFiles > 0 ? (this.totalDeps / totalFiles).toFixed(2) : '0.00',
      pureProjects,
      purityPercentage,
      results: this.results
    };
  }

  reset() {
    this.packageJsonFiles = [];
    this.results = [];
    this.totalDeps = 0;
    this.totalDevDeps = 0;
    this.projectsWithDeps = 0;
  }
}

/**
 * Analyzer for counting lines of code by language
 */
class LocAnalyzer extends BaseAnalyzer {
  constructor() {
    super();
    this.name = 'Lines of Code Analyzer';
    this.linesByLanguage = {};
    this.filesByLanguage = {};
    this.totalLines = 0;
  }

  async processFile(filePath, stats) {
    const filename = path.basename(filePath);
    const ext = path.extname(filename).toLowerCase();
    
    // Skip archive files
    if (isArchiveFile(filename)) {
      return;
    }
    
    // Skip binary files (using GENERIC detection)
    if (await isBinaryFile(filePath, stats)) {
      return;
    }
    
    // Check for assembly language
    if (ASSEMBLY_EXTENSIONS.has(ext)) {
      try {
        const content = await readFile(filePath, 'utf8');
        const lines = content.split('\n').length;
        this.linesByLanguage['assembly'] = (this.linesByLanguage['assembly'] || 0) + lines;
        this.filesByLanguage['assembly'] = (this.filesByLanguage['assembly'] || 0) + 1;
        this.totalLines += lines;
        return;
      } catch (error) {
        // Skip files that can't be read
      }
    }
    
    // Check for special files without extensions
    if (filename === 'Dockerfile') {
      try {
        const content = await readFile(filePath, 'utf8');
        const lines = content.split('\n').length;
        this.linesByLanguage['docker'] = (this.linesByLanguage['docker'] || 0) + lines;
        this.filesByLanguage['docker'] = (this.filesByLanguage['docker'] || 0) + 1;
        this.totalLines += lines;
        return;
      } catch (error) {}
    }
    
    if (filename === 'Makefile' || filename.endsWith('.mk')) {
      try {
        const content = await readFile(filePath, 'utf8');
        const lines = content.split('\n').length;
        this.linesByLanguage['make'] = (this.linesByLanguage['make'] || 0) + lines;
        this.filesByLanguage['make'] = (this.filesByLanguage['make'] || 0) + 1;
        this.totalLines += lines;
        return;
      } catch (error) {}
    }
    
    // Check for other languages by extension
    for (const [language, extensions] of Object.entries(LANGUAGE_EXTENSIONS)) {
      if (extensions.includes(ext) || extensions.includes(filename)) {
        try {
          const content = await readFile(filePath, 'utf8');
          const lines = content.split('\n').length;
          
          this.linesByLanguage[language] = (this.linesByLanguage[language] || 0) + lines;
          this.filesByLanguage[language] = (this.filesByLanguage[language] || 0) + 1;
          this.totalLines += lines;
        } catch (error) {
          // Skip files that can't be read as text
        }
        break;
      }
    }
  }

  getReport() {
    const sortedLanguages = Object.entries(this.linesByLanguage)
      .sort(([, a], [, b]) => b - a)
      .map(([language, lines]) => ({
        language,
        lines,
        files: this.filesByLanguage[language],
        percentage: this.totalLines > 0 ? ((lines / this.totalLines) * 100).toFixed(2) : '0.00'
      }));

    return {
      totalLines: this.totalLines,
      totalLinesFormatted: this.totalLines.toLocaleString(),
      languages: sortedLanguages
    };
  }

  reset() {
    this.linesByLanguage = {};
    this.filesByLanguage = {};
    this.totalLines = 0;
  }
}

/**
 * Analyzer for archive files
 */
class ArchiveAnalyzer extends BaseAnalyzer {
  constructor() {
    super();
    this.name = 'Archive Files Analyzer';
    this.archives = [];
    this.totalSize = 0;
    this.totalCount = 0;
    this.byType = {};
  }

  async processFile(filePath, stats) {
    const filename = path.basename(filePath);
    
    if (isArchiveFile(filename)) {
      const ext = path.extname(filename).toLowerCase();
      
      this.archives.push({
        path: filePath,
        name: filename,
        size: stats.size,
        sizeFormatted: formatSize(stats.size),
        sizeMB: formatMB(stats.size),
        type: ext
      });
      this.totalSize += stats.size;
      this.totalCount++;
      this.byType[ext] = (this.byType[ext] || 0) + 1;
    }
  }

  getReport() {
    return {
      totalCount: this.totalCount,
      totalSize: this.totalSize,
      totalSizeFormatted: formatSize(this.totalSize),
      totalSizeMB: formatMB(this.totalSize),
      byType: this.byType,
      largest: this.archives.sort((a, b) => b.size - a.size).slice(0, 5)
    };
  }

  reset() {
    this.archives = [];
    this.totalSize = 0;
    this.totalCount = 0;
    this.byType = {};
  }
}

/**
 * Analyzer for binary files (GENERIC version)
 */
class BinaryAnalyzer extends BaseAnalyzer {
  constructor() {
    super();
    this.name = 'Binary Files Analyzer';
    this.binaries = [];
    this.totalSize = 0;
    this.totalCount = 0;
    this.byType = {};
  }

  async processFile(filePath, stats) {
    const filename = path.basename(filePath);
    
    // Skip archives
    if (isArchiveFile(filename)) {
      return;
    }
    
    // Use GENERIC binary detection
    if (await isBinaryFile(filePath, stats)) {
      const ext = path.extname(filename).toLowerCase() || '[no ext]';
      
      this.binaries.push({
        path: filePath,
        name: filename,
        size: stats.size,
        sizeFormatted: formatSize(stats.size),
        sizeMB: formatMB(stats.size),
        type: ext
      });
      this.totalSize += stats.size;
      this.totalCount++;
      this.byType[ext] = (this.byType[ext] || 0) + 1;
    }
  }

  getReport() {
    return {
      totalCount: this.totalCount,
      totalSize: this.totalSize,
      totalSizeFormatted: formatSize(this.totalSize),
      totalSizeMB: formatMB(this.totalSize),
      byType: this.byType,
      largest: this.binaries.sort((a, b) => b.size - a.size).slice(0, 10)
    };
  }

  reset() {
    this.binaries = [];
    this.totalSize = 0;
    this.totalCount = 0;
    this.byType = {};
  }
}

/**
 * Main class to orchestrate file traversal and analyzers
 */
class DirectoryAnalyzer {
  constructor() {
    this.analyzers = [];
  }

  registerAnalyzer(analyzer) {
    if (analyzer instanceof BaseAnalyzer) {
      this.analyzers.push(analyzer);
    } else {
      throw new Error('Analyzer must extend BaseAnalyzer');
    }
  }

  resetAll() {
    this.analyzers.forEach(analyzer => analyzer.reset());
  }

  async traverseDirectory(dir) {
    try {
      const items = await readdir(dir);
      
      for (const item of items) {
        // Skip ignored directories
        if (IGNORE_DIRS.has(item)) {
          continue;
        }
        
        const fullPath = path.join(dir, item);
        
        try {
          const stats = await stat(fullPath);
          
          for (const analyzer of this.analyzers) {
            await analyzer.processFile(fullPath, stats);
          }
          
          if (stats.isDirectory()) {
            await this.traverseDirectory(fullPath);
          }
        } catch (error) {
          console.error(`${colors.red}Error processing ${fullPath}: ${error.message}${colors.reset}`);
        }
      }
    } catch (error) {
      console.error(`${colors.red}Error reading directory ${dir}: ${error.message}${colors.reset}`);
    }
  }

  getReport() {
    const reports = {};
    this.analyzers.forEach(analyzer => {
      reports[analyzer.name] = analyzer.getReport();
    });
    return reports;
  }
}

/**
 * Print functions
 */
function printHeader(title, color = colors.cyan) {
  console.log('\n' + color + colors.bright + '='.repeat(60) + colors.reset);
  console.log(color + colors.bright + `  ${title}` + colors.reset);
  console.log(color + colors.bright + '='.repeat(60) + colors.reset);
}

function printStat(label, value, color = colors.white) {
  console.log(`  ${colors.dim}${label}:${colors.reset} ${color}${value}${colors.reset}`);
}

function printProgressBar(value, max, width = 20, color = colors.green) {
  if (max === 0) return;
  const percentage = Math.min(100, Math.round((value / max) * 100));
  const filled = Math.round((percentage / 100) * width);
  const empty = width - filled;
  const bar = color + '█'.repeat(filled) + colors.dim + '░'.repeat(empty) + colors.reset;
  console.log(`  ${bar} ${colors.bright}${percentage}%${colors.reset}`);
}

async function main() {
  const targetDir = process.argv[2];
  
  if (!targetDir) {
    console.error(`${colors.red}Please provide a directory path${colors.reset}`);
    console.error(`${colors.yellow}Usage: node script.js <directory-path>${colors.reset}`);
    process.exit(1);
  }
  
  const absolutePath = path.resolve(targetDir);
  
  try {
    const stats = await stat(absolutePath);
    if (!stats.isDirectory()) {
      console.error(`${colors.red}The provided path is not a directory${colors.reset}`);
      process.exit(1);
    }
  } catch (error) {
    console.error(`${colors.red}Directory does not exist: ${absolutePath}${colors.reset}`);
    process.exit(1);
  }
  
  console.log('\n' + colors.bgBlue + colors.white + colors.bright + '🔍 DIRECTORY ANALYZER ' + colors.reset);
  console.log(`${colors.cyan}Scanning: ${colors.bright}${absolutePath}${colors.reset}`);
  console.log(`${colors.yellow}Ignoring: ${Array.from(IGNORE_DIRS).join(', ')}${colors.reset}`);
  console.log(`${colors.dim}Note: ._ directories are processed normally${colors.reset}\n`);
  
  const analyzer = new DirectoryAnalyzer();
  
  analyzer.registerAnalyzer(new TotalSizeAnalyzer(IGNORE_DIRS));
  analyzer.registerAnalyzer(new PackageJsonAnalyzer());
  analyzer.registerAnalyzer(new LocAnalyzer());
  analyzer.registerAnalyzer(new ArchiveAnalyzer());
  analyzer.registerAnalyzer(new BinaryAnalyzer());
  
  console.log(`${colors.dim}Registered analyzers:${colors.reset}`);
  analyzer.analyzers.forEach(a => console.log(`  ${colors.green}✓${colors.reset} ${a.name}`));
  console.log(`\n${colors.yellow}Processing files...${colors.reset}\n`);
  
  const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let spinnerIndex = 0;
  const spinnerInterval = setInterval(() => {
    process.stdout.write(`\r${colors.cyan}${spinnerFrames[spinnerIndex]} Scanning...${colors.reset}`);
    spinnerIndex = (spinnerIndex + 1) % spinnerFrames.length;
  }, 100);
  
  analyzer.resetAll();
  await analyzer.traverseDirectory(absolutePath);
  
  clearInterval(spinnerInterval);
  process.stdout.write('\r' + ' '.repeat(30) + '\r');
  
  const reports = analyzer.getReport();
  
  // Package.json Report
  printHeader('📦 PACKAGE.JSON ANALYSIS', colors.magenta);
  const pkgReport = reports['Package.json Analyzer'];
  if (pkgReport.totalFiles > 0) {
    printStat('Total package.json files', pkgReport.totalFiles, colors.bright);
    printStat('Total production dependencies', pkgReport.totalDeps, colors.yellow);
    printStat('Total dev dependencies', pkgReport.totalDevDeps, colors.cyan);
    printStat('Average deps per project', pkgReport.averageDeps, colors.white);
    
    console.log(`\n  ${colors.dim}Directory Purity:${colors.reset}`);
    printProgressBar(pkgReport.pureProjects, pkgReport.totalFiles, 20, 
      pkgReport.purityPercentage > 80 ? colors.green : pkgReport.purityPercentage > 50 ? colors.yellow : colors.red);
    console.log(`   ${pkgReport.pureProjects} pure projects (no production deps) - ${pkgReport.purityPercentage}%`);
  } else {
    console.log(`  ${colors.yellow}No package.json files found${colors.reset}`);
  }
  
  // Lines of Code Report
  printHeader('📝 LINES OF CODE BY LANGUAGE', colors.green);
  const locReport = reports['Lines of Code Analyzer'];
  if (locReport.totalLines > 0) {
    printStat('Total lines of code', locReport.totalLinesFormatted, colors.bright);
    
    const assemblyLang = locReport.languages.find(l => l.language === 'assembly');
    if (assemblyLang) {
      console.log(`  ${colors.yellow}🔧 Assembly detected: ${assemblyLang.lines.toLocaleString()} lines in ${assemblyLang.files} files${colors.reset}`);
    }
    
    console.log(`\n  ${colors.dim}Languages by lines of code:${colors.reset}`);
    locReport.languages.slice(0, 8).forEach(({language, lines, files, percentage}) => {
      const langColor = language === 'assembly' ? colors.yellow : 
                       percentage > 30 ? colors.green : 
                       percentage > 10 ? colors.yellow : colors.blue;
      console.log(`  ${langColor}${language.padEnd(12)}${colors.reset} ${lines.toLocaleString().padStart(8)} lines ${colors.dim}(${files} files, ${percentage}%)${colors.reset}`);
      printProgressBar(lines, locReport.totalLines, 15, langColor);
    });
    
    if (locReport.languages.length > 8) {
      console.log(`  ${colors.dim}... and ${locReport.languages.length - 8} more languages${colors.reset}`);
    }
  } else {
    console.log(`  ${colors.yellow}No code files found${colors.reset}`);
  }
  
  // Archive Files Report
  printHeader('📦 ARCHIVE & DATA FILES', colors.yellow);
  const archiveReport = reports['Archive Files Analyzer'];
  if (archiveReport.totalCount > 0) {
    printStat('Total archives/data files', archiveReport.totalCount, colors.bright);
    printStat('Total size', archiveReport.totalSizeFormatted, colors.yellow);
    
    console.log(`\n  ${colors.dim}By type:${colors.reset}`);
    Object.entries(archiveReport.byType).slice(0, 5).forEach(([type, count]) => {
      console.log(`  ${colors.cyan}${type.padEnd(8)}${colors.reset}: ${count} files`);
    });
    
    const jsonCount = archiveReport.byType['.json'] || 0;
    if (jsonCount > 0) {
      console.log(`\n  ${colors.dim}JSON files:${colors.reset} ${jsonCount} files`);
    }
    
    if (archiveReport.largest.length > 0) {
      console.log(`\n  ${colors.dim}Largest archives/data files:${colors.reset}`);
      archiveReport.largest.slice(0, 3).forEach(archive => {
        console.log(`  ${colors.red}▸${colors.reset} ${archive.name} ${colors.yellow}(${archive.sizeFormatted})${colors.reset}`);
      });
    }
  } else {
    console.log(`  ${colors.yellow}No archive or data files found${colors.reset}`);
  }
  
  // Binary Files Report (GENERIC)
  printHeader('💾 BINARY FILES', colors.blue);
  const binaryReport = reports['Binary Files Analyzer'];
  if (binaryReport.totalCount > 0) {
    printStat('Total binary files', binaryReport.totalCount, colors.bright);
    printStat('Total size', binaryReport.totalSizeFormatted, colors.blue);
    
    console.log(`\n  ${colors.dim}Binary files detected:${colors.reset}`);
    binaryReport.largest.slice(0, 10).forEach(binary => {
      const execMarker = binary.type === '[no ext]' ? ' (executable)' : '';
      console.log(`  ${colors.blue}▸${colors.reset} ${binary.name}${colors.dim}${execMarker}${colors.reset} - ${colors.blue}${binary.sizeFormatted}${colors.reset}`);
    });
    
    console.log(`\n  ${colors.dim}By type:${colors.reset}`);
    Object.entries(binaryReport.byType)
      .sort(([,a], [,b]) => b - a)
      .slice(0, 5)
      .forEach(([type, count]) => {
        console.log(`  ${colors.cyan}${type.padEnd(10)}${colors.reset}: ${count} files`);
      });
  } else {
    console.log(`  ${colors.yellow}No binary files found${colors.reset}`);
  }
  
  // Total Size Report
  printHeader('📊 TOTAL DIRECTORY SIZE', colors.cyan);
  const sizeReport = reports['Total Size Analyzer'];
  printStat('Total size (excluding ignored)', sizeReport.totalSizeFormatted, colors.bright + colors.green);
  printStat('Pure code size', sizeReport.codeSizeFormatted, colors.green);
  printStat('Binary files size', sizeReport.binarySizeFormatted, colors.blue);
  printStat('Archive/data files size', sizeReport.archiveSizeFormatted, colors.yellow);
  printStat('Total files scanned', sizeReport.fileCount.toLocaleString(), colors.cyan);
  printStat('Total directories scanned', sizeReport.dirCount.toLocaleString(), colors.cyan);
  
  if (sizeReport.skippedDirs.length > 0) {
    console.log(`\n  ${colors.dim}Ignored directories encountered:${colors.reset}`);
    console.log(`  ${colors.yellow}${Array.from(new Set(sizeReport.skippedDirs)).slice(0, 5).join(', ')}${colors.reset}`);
    console.log(`  ${colors.dim}Total items skipped: ${sizeReport.skippedCount}${colors.reset}`);
  }
  
  // Quick Summary
  printHeader('⚡ QUICK SUMMARY', colors.white + colors.bgBlue);
  
  const jsonFileCount = archiveReport.byType['.json'] || 0;
  
  const summaryData = [
    { label: 'Total Size', value: sizeReport.totalSizeFormatted, color: colors.green },
    { label: 'Pure Code', value: sizeReport.codeSizeFormatted, color: colors.green },
    { label: 'Binaries', value: `${binaryReport.totalCount} files (${sizeReport.binarySizeFormatted})`, color: colors.blue },
    { label: 'Archives/Data', value: `${archiveReport.totalCount} files (${sizeReport.archiveSizeFormatted})`, color: colors.yellow },
    { label: 'Lines of Code', value: locReport.totalLinesFormatted, color: colors.green }
  ];
  
  if (jsonFileCount > 0) {
    summaryData.push({ 
      label: 'JSON files', 
      value: `${jsonFileCount} files (archived)`, 
      color: colors.yellow 
    });
  }
  
  if (pkgReport.totalFiles > 0) {
    summaryData.push({ 
      label: 'Package.json', 
      value: `${pkgReport.totalFiles} files, ${pkgReport.totalDeps} deps (${pkgReport.purityPercentage}% pure)`, 
      color: colors.magenta 
    });
  } else {
    summaryData.push({ 
      label: 'Package.json', 
      value: `0 files, 0 deps`, 
      color: colors.magenta 
    });
  }
  
  summaryData.push({ label: 'Files Scanned', value: sizeReport.fileCount.toLocaleString(), color: colors.cyan });
  
  const maxLabelLength = Math.max(...summaryData.map(d => d.label.length));
  
  summaryData.forEach(({label, value, color}) => {
    console.log(`  ${colors.bright}${label.padEnd(maxLabelLength)}:${colors.reset} ${color}${value}${colors.reset}`);
  });
  
  if (pkgReport.totalFiles > 0) {
    const purityEmoji = pkgReport.purityPercentage > 80 ? '🟢' : pkgReport.purityPercentage > 50 ? '🟡' : '🔴';
    console.log(`\n  ${colors.dim}Dependency Purity:${colors.reset} ${purityEmoji} ${pkgReport.pureProjects}/${pkgReport.totalFiles} projects without deps (${pkgReport.totalDeps} total deps)`);
  }
  
  if (locReport.languages.some(l => l.language === 'assembly')) {
    console.log(`  ${colors.yellow}🔧 Assembly language detected${colors.reset}`);
  }
  
  console.log('\n' + colors.dim + '─'.repeat(60) + colors.reset);
  console.log(colors.green + '✓ Analysis complete!' + colors.reset);
  console.log(colors.dim + `Scanned ${sizeReport.fileCount.toLocaleString()} files in ${sizeReport.dirCount.toLocaleString()} directories` + colors.reset);
}

process.on('unhandledRejection', (error) => {
  console.error(`${colors.red}Unhandled rejection: ${error}${colors.reset}`);
  process.exit(1);
});

main();
