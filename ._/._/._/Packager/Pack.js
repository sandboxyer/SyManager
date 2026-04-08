#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';
import { exec } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const readdir = promisify(fs.readdir);
const stat = promisify(fs.stat);
const readFile = promisify(fs.readFile);
const access = promisify(fs.access);
const execPromise = promisify(exec);

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

// Get terminal size
const terminalWidth = process.stdout.columns || 80;
const terminalHeight = process.stdout.rows || 24;

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
  cmake: ['CMakeLists.txt', '.cmake'],
  zig : ['.zig']
};

// Archive file extensions
const ARCHIVE_EXTENSIONS = new Set([
  '.zip', '.tar', '.gz', '.tgz', '.rar', '.7z', '.bz2', '.xz', '.zst', '.br',
  '.jar', '.war', '.ear', '.apk', '.ipa', '.deb', '.rpm', '.pkg', '.msi',
  '.json', '.jsonc', '.json5'
]);

// Binary file extensions
const BINARY_EXTENSIONS = new Set([
  '.exe', '.dll', '.so', '.dylib', '.bin', '.out', '.elf', '.app',
  '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.ico', '.svg', '.webp', '.tiff', '.psd',
  '.raw', '.cr2', '.nef', '.orf', '.sr2', '.eps', '.ai', '.cdr', '.wmf',
  '.ttf', '.otf', '.woff', '.woff2', '.eot', '.pfb', '.pfm', '.afm',
  '.mp3', '.mp4', '.wav', '.avi', '.mov', '.mkv', '.flac', '.ogg', '.webm',
  '.m4a', '.m4v', '.wma', '.wmv', '.aac', '.ac3', '.ape', '.mid', '.midi',
  '.mpg', '.mpeg', '.m2v', '.mts', '.m2ts', '.ts', '.flv', '.swf', '.vob',
  '.3gp', '.3g2', '.asf', '.rm', '.ra', '.ram', '.divx', '.xvid',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods',
  '.odp', '.odg', '.odf', '.pub', '.rtf', '.wpd', '.wps', '.key', '.numbers',
  '.pages', '.ps', '.epub', '.mobi', '.azw', '.djvu',
  '.db', '.sqlite', '.sqlite3', '.mdb', '.accdb', '.dbf', '.pdb', '.frm',
  '.myd', '.myi', '.ibd', '.fdb', '.gdb', '.kdb', '.kdbx',
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

// Helper to truncate string with ellipsis
function truncate(str, maxLength) {
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength - 3) + '...';
}

// Helper to create a horizontal line
function horizontalLine(char = '─', color = colors.dim) {
  return color + char.repeat(terminalWidth - 1) + colors.reset;
}

// Helper to center text
function centerText(text, width = terminalWidth) {
  const padding = Math.max(0, Math.floor((width - text.length) / 2));
  return ' '.repeat(padding) + text;
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
 */
async function isExecutableBinary(filePath, stats) {
  try {
    if (stats.isFile()) {
      await access(filePath, fs.constants.X_OK);
      const ext = path.extname(filePath).toLowerCase();
      if (ext === '') {
        return true;
      }
      if (BINARY_EXTENSIONS.has(ext)) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * GENERIC: Quick check for binary content (looks for null bytes)
 */
async function isBinaryContent(filePath, stats) {
  if (stats.size < 1024) return false;
  
  try {
    const fd = await fs.promises.open(filePath, 'r');
    try {
      const buffer = Buffer.alloc(1024);
      const { bytesRead } = await fd.read(buffer, 0, 1024, 0);
      
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
 */
async function isBinaryFile(filePath, stats) {
  const filename = path.basename(filePath);
  const ext = path.extname(filename).toLowerCase();
  
  if (BINARY_EXTENSIONS.has(ext)) {
    return true;
  }
  
  if (ext === '') {
    try {
      await access(filePath, fs.constants.X_OK);
      return true;
    } catch {
      // Not executable
    }
  }
  
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
 * Analyzer for total directory size
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
      
      if (isArchiveFile(filename)) {
        this.archiveSize += stats.size;
      }
      else if (await isBinaryFile(filePath, stats)) {
        this.binarySize += stats.size;
      }
      else {
        const ext = path.extname(filename).toLowerCase();
        for (const extensions of Object.values(LANGUAGE_EXTENSIONS)) {
          if (extensions.includes(ext) || extensions.includes(filename)) {
            this.codeSize += stats.size;
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
    
    if (isArchiveFile(filename)) {
      return;
    }
    
    if (await isBinaryFile(filePath, stats)) {
      return;
    }
    
    if (ASSEMBLY_EXTENSIONS.has(ext)) {
      try {
        const content = await readFile(filePath, 'utf8');
        const lines = content.split('\n').length;
        this.linesByLanguage['assembly'] = (this.linesByLanguage['assembly'] || 0) + lines;
        this.filesByLanguage['assembly'] = (this.filesByLanguage['assembly'] || 0) + 1;
        this.totalLines += lines;
        return;
      } catch (error) {}
    }
    
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
    
    for (const [language, extensions] of Object.entries(LANGUAGE_EXTENSIONS)) {
      if (extensions.includes(ext) || extensions.includes(filename)) {
        try {
          const content = await readFile(filePath, 'utf8');
          const lines = content.split('\n').length;
          
          this.linesByLanguage[language] = (this.linesByLanguage[language] || 0) + lines;
          this.filesByLanguage[language] = (this.filesByLanguage[language] || 0) + 1;
          this.totalLines += lines;
        } catch (error) {}
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
 * Analyzer for binary files
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
    
    if (isArchiveFile(filename)) {
      return;
    }
    
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
 * NEW: Analyzer for Git repositories to get contributors and commits
 * This is a completely separate analyzer that won't affect existing functionality
 */
class GitAnalyzer extends BaseAnalyzer {
  constructor() {
    super();
    this.name = 'Git Analyzer';
    this.repositories = [];
    this.gitDirs = new Set(); // Store unique .git directories found
  }

  async findGitRepositories(dir) {
    const gitRepos = [];
    
    async function scan(currentPath) {
      try {
        const items = await readdir(currentPath);
        
        // Check if current directory has a .git folder
        if (items.includes('.git')) {
          const gitPath = path.join(currentPath, '.git');
          const stats = await stat(gitPath);
          if (stats.isDirectory()) {
            gitRepos.push(currentPath);
            return; // Don't go deeper into git repos
          }
        }
        
        // Continue scanning subdirectories (skip ignored dirs)
        for (const item of items) {
          if (IGNORE_DIRS.has(item)) {
            continue;
          }
          
          const fullPath = path.join(currentPath, item);
          const stats = await stat(fullPath);
          
          if (stats.isDirectory() && !fullPath.includes('.git')) {
            await scan(fullPath);
          }
        }
      } catch (error) {
        // Silently skip directories that can't be read
      }
    }
    
    await scan(dir);
    return gitRepos;
  }

  async analyzeRepository(repoPath) {
    try {
      // Get total commit count
      const { stdout: commitCountOutput } = await execPromise('git rev-list --all --count', {
        cwd: repoPath,
        encoding: 'utf8'
      });
      const totalCommits = parseInt(commitCountOutput.trim(), 10) || 0;
      
      // Get unique contributors (by email)
      const { stdout: contributorsOutput } = await execPromise('git log --format="%ae" | sort -u | wc -l', {
        cwd: repoPath,
        shell: true,
        encoding: 'utf8'
      });
      const uniqueContributors = parseInt(contributorsOutput.trim(), 10) || 0;
      
      // Get detailed contributor list with names and emails
      const { stdout: contributorDetailsOutput } = await execPromise('git log --format="%an|%ae" | sort -u', {
        cwd: repoPath,
        shell: true,
        encoding: 'utf8'
      });
      
      const contributors = contributorDetailsOutput
        .split('\n')
        .filter(line => line.trim() && line.includes('|'))
        .map(line => {
          const [name, email] = line.split('|');
          return { name: name.trim(), email: email.trim() };
        });
      
      return {
        path: repoPath,
        name: path.basename(repoPath),
        totalCommits,
        uniqueContributors,
        contributors,
        success: true
      };
    } catch (error) {
      // Git command failed - might not be a valid git repo or git not installed
      return {
        path: repoPath,
        name: path.basename(repoPath),
        totalCommits: 0,
        uniqueContributors: 0,
        contributors: [],
        success: false,
        error: error.message
      };
    }
  }

  async processFile(filePath, stats) {
    // This analyzer doesn't process individual files
    // It will be called separately
  }

  async scanDirectory(dir) {
    const repositories = await this.findGitRepositories(dir);
    
    for (const repo of repositories) {
      const analysis = await this.analyzeRepository(repo);
      this.repositories.push(analysis);
    }
  }

  getReport() {
    const totalRepos = this.repositories.length;
    const successfulRepos = this.repositories.filter(r => r.success).length;
    const totalCommitsAcrossRepos = this.repositories.reduce((sum, repo) => sum + repo.totalCommits, 0);
    const totalUniqueContributorsAcrossRepos = this.repositories.reduce((sum, repo) => sum + repo.uniqueContributors, 0);
    
    // Find repo with most contributors
    const repoWithMostContributors = this.repositories.length > 0
      ? this.repositories.reduce((max, repo) => repo.uniqueContributors > max.uniqueContributors ? repo : max, this.repositories[0])
      : null;
    
    // Find repo with most commits
    const repoWithMostCommits = this.repositories.length > 0
      ? this.repositories.reduce((max, repo) => repo.totalCommits > max.totalCommits ? repo : max, this.repositories[0])
      : null;
    
    return {
      totalRepositories: totalRepos,
      successfulRepositories: successfulRepos,
      failedRepositories: totalRepos - successfulRepos,
      totalCommits: totalCommitsAcrossRepos,
      totalUniqueContributors: totalUniqueContributorsAcrossRepos,
      repositories: this.repositories,
      repoWithMostContributors: repoWithMostContributors,
      repoWithMostCommits: repoWithMostCommits
    };
  }

  reset() {
    this.repositories = [];
    this.gitDirs.clear();
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
          // Silently skip files that can't be accessed
        }
      }
    } catch (error) {
      // Silently skip directories that can't be read
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
 * Print functions for single directory mode
 */
function printHeader(title, color = colors.cyan) {
  console.log('\n' + color + colors.bright + '┌' + '─'.repeat(terminalWidth - 2) + '┐' + colors.reset);
  console.log(color + colors.bright + '│' + centerText(title, terminalWidth - 2) + '│' + colors.reset);
  console.log(color + colors.bright + '└' + '─'.repeat(terminalWidth - 2) + '┘' + colors.reset);
}

function printSubHeader(title, color = colors.cyan) {
  console.log('\n' + color + colors.bright + '┌─ ' + title + ' ' + '─'.repeat(Math.max(0, terminalWidth - title.length - 6)) + '┐' + colors.reset);
}

function printStat(label, value, color = colors.white, indent = 2) {
  const indentStr = ' '.repeat(indent);
  const line = `${indentStr}${colors.dim}${label}:${colors.reset} ${color}${value}${colors.reset}`;
  console.log(line);
}

function printProgressBar(value, max, width = Math.min(30, terminalWidth - 20), color = colors.green) {
  if (max === 0) return;
  const percentage = Math.min(100, Math.round((value / max) * 100));
  const filled = Math.round((percentage / 100) * width);
  const empty = width - filled;
  const bar = color + '█'.repeat(filled) + colors.dim + '░'.repeat(empty) + colors.reset;
  console.log(`   ${bar} ${colors.bright}${percentage}%${colors.reset}`);
}

function printKeyValue(label, value, color = colors.white, width1 = 20, width2 = 15) {
  const truncatedLabel = truncate(label, width1);
  const truncatedValue = truncate(value.toString(), width2);
  console.log(`  ${colors.dim}${truncatedLabel.padEnd(width1)}:${colors.reset} ${color}${truncatedValue.padEnd(width2)}${colors.reset}`);
}

/**
 * NEW: Print Git analysis for single directory mode
 */
function printGitAnalysis(gitReport) {
  if (!gitReport || gitReport.totalRepositories === 0) {
    return;
  }
  
  printHeader('🔀 GIT REPOSITORY ANALYSIS', colors.magenta);
  
  printKeyValue('Git repositories', gitReport.totalRepositories, colors.bright, 25, 15);
  
  if (gitReport.successfulRepositories > 0) {
    printKeyValue('Total commits (all repos)', gitReport.totalCommits.toLocaleString(), colors.green, 25, 15);
    printKeyValue('Unique contributors (all repos)', gitReport.totalUniqueContributors.toLocaleString(), colors.cyan, 25, 15);
    
    if (gitReport.repoWithMostContributors && gitReport.repoWithMostContributors.uniqueContributors > 0) {
      console.log(`\n  ${colors.dim}Repository with most contributors:${colors.reset}`);
      console.log(`    ${colors.yellow}📦 ${truncate(gitReport.repoWithMostContributors.name, 50)}${colors.reset}`);
      console.log(`    ${colors.cyan}   👥 ${gitReport.repoWithMostContributors.uniqueContributors} unique contributors${colors.reset}`);
      console.log(`    ${colors.green}   📝 ${gitReport.repoWithMostContributors.totalCommits.toLocaleString()} total commits${colors.reset}`);
    }
    
    if (gitReport.repoWithMostCommits && gitReport.repoWithMostCommits !== gitReport.repoWithMostContributors) {
      console.log(`\n  ${colors.dim}Repository with most commits:${colors.reset}`);
      console.log(`    ${colors.yellow}📦 ${truncate(gitReport.repoWithMostCommits.name, 50)}${colors.reset}`);
      console.log(`    ${colors.green}   📝 ${gitReport.repoWithMostCommits.totalCommits.toLocaleString()} total commits${colors.reset}`);
      console.log(`    ${colors.cyan}   👥 ${gitReport.repoWithMostCommits.uniqueContributors} unique contributors${colors.reset}`);
    }
    
    // List all repositories found
    if (gitReport.repositories.length > 0) {
      console.log(`\n  ${colors.dim}Repositories found:${colors.reset}`);
      gitReport.repositories.slice(0, 5).forEach((repo, idx) => {
        if (repo.success) {
          const statusIcon = repo.uniqueContributors > 0 ? '✓' : '○';
          console.log(`    ${colors.green}${statusIcon}${colors.reset} ${truncate(repo.name, 40)} - ${colors.cyan}${repo.uniqueContributors} contributors${colors.reset}, ${colors.green}${repo.totalCommits.toLocaleString()} commits${colors.reset}`);
        } else {
          console.log(`    ${colors.red}✗${colors.reset} ${truncate(repo.name, 40)} - ${colors.dim}Failed to analyze${colors.reset}`);
        }
      });
      
      if (gitReport.repositories.length > 5) {
        console.log(`    ${colors.dim}... and ${gitReport.repositories.length - 5} more repositories${colors.reset}`);
      }
    }
  } else {
    console.log(`  ${colors.yellow}⚠ No valid Git repositories could be analyzed${colors.reset}`);
    if (gitReport.failedRepositories > 0) {
      console.log(`  ${colors.dim}Failed repositories: ${gitReport.failedRepositories}${colors.reset}`);
    }
  }
}

/**
 * Print functions for multi-directory comparison mode
 */
function printComparisonHeader(directories) {
  console.log('\n' + colors.bgBlue + colors.white + colors.bright + '╔' + '═'.repeat(terminalWidth - 2) + '╗' + colors.reset);
  console.log(colors.bgBlue + colors.white + colors.bright + '║' + centerText('📊 DIRECTORY COMPARISON ANALYZER', terminalWidth - 2) + '║' + colors.reset);
  console.log(colors.bgBlue + colors.white + colors.bright + '╚' + '═'.repeat(terminalWidth - 2) + '╝' + colors.reset);
  
  console.log(`\n${colors.cyan}${colors.bright}Comparing:${colors.reset}`);
  directories.forEach((dir, i) => {
    const displayDir = truncate(dir, terminalWidth - 10);
    console.log(`  ${colors.bright}${i + 1}.${colors.reset} ${colors.yellow}${displayDir}${colors.reset}`);
  });
  console.log(`\n${colors.dim}Ignoring: ${Array.from(IGNORE_DIRS).join(', ')}${colors.reset}`);
  console.log();
}

function createTable(directories, metrics, reportsByDir) {
  const dirCount = directories.length;
  const maxDirNameLength = Math.min(25, Math.floor(terminalWidth * 0.2));
  const valueWidth = Math.min(15, Math.floor((terminalWidth - maxDirNameLength - 10) / dirCount));
  
  // Header
  let headerLine = ' '.repeat(maxDirNameLength);
  directories.forEach(dir => {
    const shortName = truncate(path.basename(dir), valueWidth);
    headerLine += `│ ${colors.bright}${shortName.padEnd(valueWidth)}${colors.reset} `;
  });
  
  console.log('\n' + colors.dim + '┌' + '─'.repeat(maxDirNameLength + 2) + '┬' + '─'.repeat((valueWidth + 4) * dirCount - 1) + '┐' + colors.reset);
  console.log(headerLine);
  console.log(colors.dim + '├' + '─'.repeat(maxDirNameLength + 2) + '┼' + '─'.repeat((valueWidth + 4) * dirCount - 1) + '┤' + colors.reset);
  
  // Rows
  metrics.forEach((metric, idx) => {
    const values = directories.map(dir => {
      const report = reportsByDir[dir];
      if (metric.getValue) {
        return metric.getValue(report);
      }
      return report[metric.key];
    });
    
    // Determine winners
    const numericValues = values.map(v => {
      if (typeof v === 'string' && v.includes(' ')) {
        // Handle formatted sizes like "1.23 MB"
        const num = parseFloat(v.split(' ')[0]);
        return isNaN(num) ? 0 : num;
      }
      const num = parseFloat(v);
      return isNaN(num) ? 0 : num;
    });
    
    const winnerValue = metric.winner === 'largest' 
      ? Math.max(...numericValues) 
      : Math.min(...numericValues);
    
    let row = `  ${truncate(metric.label, maxDirNameLength - 2).padEnd(maxDirNameLength)}`;
    directories.forEach((dir, i) => {
      const value = values[i];
      const isWinner = numericValues[i] === winnerValue;
      const color = isWinner ? colors.green + colors.bright : colors.white;
      row += `│ ${color}${truncate(value.toString(), valueWidth).padEnd(valueWidth)}${colors.reset} `;
    });
    console.log(row);
    
    if (idx < metrics.length - 1) {
      console.log(colors.dim + '├' + '─'.repeat(maxDirNameLength + 2) + '┼' + '─'.repeat((valueWidth + 4) * dirCount - 1) + '┤' + colors.reset);
    }
  });
  
  console.log(colors.dim + '└' + '─'.repeat(maxDirNameLength + 2) + '┴' + '─'.repeat((valueWidth + 4) * dirCount - 1) + '┘' + colors.reset);
}

function printLanguagesComparison(directories, reportsByDir) {
  const dirCount = directories.length;
  const maxDirNameLength = Math.min(20, Math.floor(terminalWidth * 0.15));
  const langWidth = Math.min(15, Math.floor((terminalWidth - maxDirNameLength - 10) / dirCount));
  
  // Get top languages across all directories
  const allLanguages = new Set();
  directories.forEach(dir => {
    const languages = reportsByDir[dir]['Lines of Code Analyzer'].languages || [];
    languages.slice(0, 3).forEach(l => allLanguages.add(l.language));
  });
  
  const topLanguages = Array.from(allLanguages).slice(0, 5);
  
  if (topLanguages.length === 0) return;
  
  console.log('\n' + colors.cyan + colors.bright + '📊 TOP LANGUAGES' + colors.reset);
  console.log(colors.dim + '┌' + '─'.repeat(maxDirNameLength + 2) + '┬' + '─'.repeat((langWidth + 4) * dirCount - 1) + '┐' + colors.reset);
  
  let headerLine = ' '.repeat(maxDirNameLength);
  directories.forEach(dir => {
    const shortName = truncate(path.basename(dir), langWidth);
    headerLine += `│ ${colors.bright}${shortName.padEnd(langWidth)}${colors.reset} `;
  });
  console.log(headerLine);
  console.log(colors.dim + '├' + '─'.repeat(maxDirNameLength + 2) + '┼' + '─'.repeat((langWidth + 4) * dirCount - 1) + '┤' + colors.reset);
  
  topLanguages.forEach((language, idx) => {
    let row = `  ${truncate(language, maxDirNameLength - 2).padEnd(maxDirNameLength)}`;
    directories.forEach(dir => {
      const langData = (reportsByDir[dir]['Lines of Code Analyzer'].languages || [])
        .find(l => l.language === language);
      const value = langData ? langData.lines.toLocaleString() : '-';
      row += `│ ${colors.yellow}${truncate(value, langWidth).padEnd(langWidth)}${colors.reset} `;
    });
    console.log(row);
    
    if (idx < topLanguages.length - 1) {
      console.log(colors.dim + '├' + '─'.repeat(maxDirNameLength + 2) + '┼' + '─'.repeat((langWidth + 4) * dirCount - 1) + '┤' + colors.reset);
    }
  });
  
  console.log(colors.dim + '└' + '─'.repeat(maxDirNameLength + 2) + '┴' + '─'.repeat((langWidth + 4) * dirCount - 1) + '┘' + colors.reset);
}

/**
 * NEW: Print Git comparison for multi-directory mode
 */
function printGitComparison(directories, reportsByDir) {
  const hasGitRepos = directories.some(dir => {
    const gitReport = reportsByDir[dir]['Git Analyzer'];
    return gitReport && gitReport.totalRepositories > 0;
  });
  
  if (!hasGitRepos) return;
  
  console.log('\n' + colors.magenta + colors.bright + '🔀 GIT REPOSITORY COMPARISON' + colors.reset);
  
  const gitMetrics = [
    { 
      label: 'Git Repos', 
      key: 'totalRepositories', 
      winner: 'largest', 
      getValue: (r) => r['Git Analyzer'].totalRepositories 
    },
    { 
      label: 'Total Commits', 
      key: 'totalCommits', 
      winner: 'largest', 
      getValue: (r) => r['Git Analyzer'].totalCommits?.toLocaleString() || '0' 
    },
    { 
      label: 'Unique Contributors', 
      key: 'totalUniqueContributors', 
      winner: 'largest', 
      getValue: (r) => r['Git Analyzer'].totalUniqueContributors?.toLocaleString() || '0' 
    }
  ];
  
  createTable(directories, gitMetrics, reportsByDir);
  
  // Show detailed repository info for each directory
  console.log(`\n  ${colors.dim}Detailed repository information:${colors.reset}`);
  directories.forEach(dir => {
    const gitReport = reportsByDir[dir]['Git Analyzer'];
    if (gitReport && gitReport.totalRepositories > 0 && gitReport.repositories.length > 0) {
      const shortName = truncate(path.basename(dir), 40);
      console.log(`\n    ${colors.yellow}📁 ${shortName}${colors.reset}`);
      
      gitReport.repositories.slice(0, 3).forEach(repo => {
        if (repo.success) {
          console.log(`      ${colors.green}└─${colors.reset} ${truncate(repo.name, 35)} - ${colors.cyan}${repo.uniqueContributors} contributors${colors.reset}, ${colors.green}${repo.totalCommits.toLocaleString()} commits${colors.reset}`);
        } else {
          console.log(`      ${colors.red}└─${colors.reset} ${truncate(repo.name, 35)} - ${colors.dim}Failed to analyze${colors.reset}`);
        }
      });
      
      if (gitReport.repositories.length > 3) {
        console.log(`      ${colors.dim}   ... and ${gitReport.repositories.length - 3} more repositories${colors.reset}`);
      }
    }
  });
}

function printWinnerPodium(winners) {
  const sortedWinners = Object.entries(winners)
    .sort(([,a], [,b]) => b - a)
    .slice(0, 3);
  
  if (sortedWinners.length === 0) return;
  
  console.log('\n' + colors.green + colors.bright + '🏆 WINNER PODIUM' + colors.reset);
  console.log(colors.dim + '┌' + '─'.repeat(terminalWidth - 2) + '┐' + colors.reset);
  
  sortedWinners.forEach(([dir, wins], i) => {
    const medal = i === 0 ? '🥇 GOLD' : i === 1 ? '🥈 SILVER' : '🥉 BRONZE';
    const displayDir = truncate(dir, terminalWidth - 30);
    const line = `│ ${colors.bright}${medal}${colors.reset}  ${colors.yellow}${displayDir.padEnd(terminalWidth - 25)}${colors.reset} ${colors.green}${wins} wins${colors.reset} │`;
    console.log(line);
  });
  
  console.log(colors.dim + '└' + '─'.repeat(terminalWidth - 2) + '┘' + colors.reset);
}

/**
 * Process a single directory
 */
async function processSingleDirectory(targetDir) {
  const absolutePath = path.resolve(targetDir);
  
  try {
    const stats = await stat(absolutePath);
    if (!stats.isDirectory()) {
      console.error(`${colors.red}Error: The provided path is not a directory${colors.reset}`);
      process.exit(1);
    }
  } catch (error) {
    console.error(`${colors.red}Error: Directory does not exist: ${absolutePath}${colors.reset}`);
    process.exit(1);
  }
  
  console.clear();
  console.log('\n' + colors.bgBlue + colors.white + colors.bright + '╔' + '═'.repeat(terminalWidth - 2) + '╗' + colors.reset);
  console.log(colors.bgBlue + colors.white + colors.bright + '║' + centerText('🔍 DIRECTORY ANALYZER', terminalWidth - 2) + '║' + colors.reset);
  console.log(colors.bgBlue + colors.white + colors.bright + '╚' + '═'.repeat(terminalWidth - 2) + '╝' + colors.reset);
  
  console.log(`\n${colors.cyan}${colors.bright}Scanning:${colors.reset} ${colors.white}${absolutePath}${colors.reset}`);
  console.log(`${colors.cyan}${colors.bright}Ignoring:${colors.reset} ${colors.dim}${Array.from(IGNORE_DIRS).join(', ')}${colors.reset}`);
  
  const analyzer = new DirectoryAnalyzer();
  
  analyzer.registerAnalyzer(new TotalSizeAnalyzer(IGNORE_DIRS));
  analyzer.registerAnalyzer(new PackageJsonAnalyzer());
  analyzer.registerAnalyzer(new LocAnalyzer());
  analyzer.registerAnalyzer(new ArchiveAnalyzer());
  analyzer.registerAnalyzer(new BinaryAnalyzer());
  
  // NEW: Register Git analyzer (optional, won't break anything if git is not available)
  const gitAnalyzer = new GitAnalyzer();
  analyzer.registerAnalyzer(gitAnalyzer);
  
  console.log(`\n${colors.dim}Registered analyzers:${colors.reset}`);
  analyzer.analyzers.forEach(a => console.log(`  ${colors.green}✓${colors.reset} ${a.name}`));
  
  console.log(`\n${colors.yellow}Processing files...${colors.reset}`);
  
  const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let spinnerIndex = 0;
  const spinnerInterval = setInterval(() => {
    process.stdout.write(`\r${colors.cyan}${spinnerFrames[spinnerIndex]} Scanning...${colors.reset}`);
    spinnerIndex = (spinnerIndex + 1) % spinnerFrames.length;
  }, 100);
  
  analyzer.resetAll();
  await analyzer.traverseDirectory(absolutePath);
  
  // NEW: Run Git analysis separately (since it's not file-based)
  await gitAnalyzer.scanDirectory(absolutePath);
  
  clearInterval(spinnerInterval);
  process.stdout.write('\r' + ' '.repeat(30) + '\r');
  
  const reports = analyzer.getReport();
  
  // Total Size Report
  printHeader('📊 DIRECTORY STATISTICS', colors.cyan);
  const sizeReport = reports['Total Size Analyzer'];
  
  const statsData = [
    { label: 'Total Size', value: sizeReport.totalSizeFormatted, color: colors.green },
    { label: '├─ Pure Code', value: sizeReport.codeSizeFormatted, color: colors.green },
    { label: '├─ Binary Files', value: sizeReport.binarySizeFormatted, color: colors.blue },
    { label: '└─ Archive Files', value: sizeReport.archiveSizeFormatted, color: colors.yellow },
    { label: 'Files Scanned', value: sizeReport.fileCount.toLocaleString(), color: colors.cyan },
    { label: 'Directories', value: sizeReport.dirCount.toLocaleString(), color: colors.cyan }
  ];
  
  statsData.forEach(({label, value, color}) => {
    printKeyValue(label, value, color, 20, 15);
  });
  
  if (sizeReport.skippedDirs.length > 0) {
    console.log(`\n  ${colors.dim}Ignored: ${colors.yellow}${Array.from(new Set(sizeReport.skippedDirs)).slice(0, 3).join(', ')}${colors.reset}`);
    if (sizeReport.skippedCount > 3) {
      console.log(`  ${colors.dim}  and ${sizeReport.skippedCount - 3} more items${colors.reset}`);
    }
  }
  
  // Package.json Report
  printHeader('📦 PACKAGE.JSON ANALYSIS', colors.magenta);
  const pkgReport = reports['Package.json Analyzer'];
  
  if (pkgReport.totalFiles > 0) {
    const pkgData = [
      { label: 'package.json files', value: pkgReport.totalFiles, color: colors.bright },
      { label: 'Production deps', value: pkgReport.totalDeps, color: colors.yellow },
      { label: 'Dev dependencies', value: pkgReport.totalDevDeps, color: colors.cyan },
      { label: 'Average deps', value: pkgReport.averageDeps, color: colors.white },
      { label: 'Purity', value: `${pkgReport.purityPercentage}%`, color: pkgReport.purityPercentage > 80 ? colors.green : pkgReport.purityPercentage > 50 ? colors.yellow : colors.red }
    ];
    
    pkgData.forEach(({label, value, color}) => {
      printKeyValue(label, value, color, 20, 15);
    });
    
    console.log(`\n  ${colors.dim}Purity bar:${colors.reset}`);
    printProgressBar(pkgReport.pureProjects, pkgReport.totalFiles, 30, 
      pkgReport.purityPercentage > 80 ? colors.green : pkgReport.purityPercentage > 50 ? colors.yellow : colors.red);
    console.log(`   ${pkgReport.pureProjects} pure projects (no production deps)`);
  } else {
    console.log(`  ${colors.yellow}No package.json files found${colors.reset}`);
  }
  
  // Lines of Code Report
  printHeader('📝 LINES OF CODE', colors.green);
  const locReport = reports['Lines of Code Analyzer'];
  
  if (locReport.totalLines > 0) {
    printKeyValue('Total lines', locReport.totalLinesFormatted, colors.bright, 20, 15);
    
    const assemblyLang = locReport.languages.find(l => l.language === 'assembly');
    if (assemblyLang) {
      console.log(`\n  ${colors.yellow}🔧 Assembly detected: ${assemblyLang.lines.toLocaleString()} lines in ${assemblyLang.files} files${colors.reset}`);
    }
    
    console.log(`\n  ${colors.dim}Top languages:${colors.reset}`);
    locReport.languages.slice(0, 5).forEach(({language, lines, percentage}) => {
      const langColor = language === 'assembly' ? colors.yellow : 
                       percentage > 30 ? colors.green : 
                       percentage > 10 ? colors.yellow : colors.blue;
      console.log(`    ${langColor}${language.padEnd(12)}${colors.reset} ${lines.toLocaleString().padStart(8)} lines ${colors.dim}(${percentage}%)${colors.reset}`);
      printProgressBar(lines, locReport.totalLines, 25, langColor);
    });
    
    if (locReport.languages.length > 5) {
      console.log(`    ${colors.dim}... and ${locReport.languages.length - 5} more languages${colors.reset}`);
    }
  } else {
    console.log(`  ${colors.yellow}No code files found${colors.reset}`);
  }
  
  // Archive Files Report
  printHeader('📦 ARCHIVE FILES', colors.yellow);
  const archiveReport = reports['Archive Files Analyzer'];
  
  if (archiveReport.totalCount > 0) {
    printKeyValue('Archive files', archiveReport.totalCount, colors.bright, 20, 15);
    printKeyValue('Total size', archiveReport.totalSizeFormatted, colors.yellow, 20, 15);
    
    console.log(`\n  ${colors.dim}By type:${colors.reset}`);
    Object.entries(archiveReport.byType).slice(0, 4).forEach(([type, count]) => {
      console.log(`    ${colors.cyan}${type.padEnd(8)}${colors.reset}: ${count} files`);
    });
    
    if (archiveReport.largest.length > 0) {
      console.log(`\n  ${colors.dim}Largest:${colors.reset}`);
      archiveReport.largest.slice(0, 2).forEach(archive => {
        console.log(`    ${colors.red}▸${colors.reset} ${truncate(archive.name, 40)} ${colors.yellow}(${archive.sizeFormatted})${colors.reset}`);
      });
    }
  } else {
    console.log(`  ${colors.yellow}No archive files found${colors.reset}`);
  }
  
  // Binary Files Report
  printHeader('💾 BINARY FILES', colors.blue);
  const binaryReport = reports['Binary Files Analyzer'];
  
  if (binaryReport.totalCount > 0) {
    printKeyValue('Binary files', binaryReport.totalCount, colors.bright, 20, 15);
    printKeyValue('Total size', binaryReport.totalSizeFormatted, colors.blue, 20, 15);
    
    console.log(`\n  ${colors.dim}Largest:${colors.reset}`);
    binaryReport.largest.slice(0, 3).forEach(binary => {
      const execMarker = binary.type === '[no ext]' ? ' (executable)' : '';
      console.log(`    ${colors.blue}▸${colors.reset} ${truncate(binary.name, 40)}${colors.dim}${execMarker}${colors.reset} - ${colors.blue}${binary.sizeFormatted}${colors.reset}`);
    });
  } else {
    console.log(`  ${colors.yellow}No binary files found${colors.reset}`);
  }
  
  // NEW: Git Analysis Report
  const gitReport = reports['Git Analyzer'];
  if (gitReport && gitReport.totalRepositories > 0) {
    printGitAnalysis(gitReport);
  }
  
  // Summary
  printHeader('⚡ SUMMARY', colors.white + colors.bgBlue);
  
  const summaryItems = [
    { icon: '📁', label: 'Total', value: sizeReport.totalSizeFormatted, color: colors.green },
    { icon: '📝', label: 'Code', value: sizeReport.codeSizeFormatted, color: colors.green },
    { icon: '💾', label: 'Binary', value: `${binaryReport.totalCount} files (${sizeReport.binarySizeFormatted})`, color: colors.blue },
    { icon: '📦', label: 'Archive', value: `${archiveReport.totalCount} files (${sizeReport.archiveSizeFormatted})`, color: colors.yellow },
    { icon: '📊', label: 'Lines', value: locReport.totalLinesFormatted, color: colors.green },
    { icon: '📋', label: 'Files', value: sizeReport.fileCount.toLocaleString(), color: colors.cyan }
  ];
  
  // NEW: Add Git summary if available
  if (gitReport && gitReport.totalRepositories > 0) {
    summaryItems.push(
      { icon: '🔀', label: 'Repos', value: gitReport.totalRepositories, color: colors.magenta },
      { icon: '👥', label: 'Contributors', value: gitReport.totalUniqueContributors.toLocaleString(), color: colors.cyan },
      { icon: '📝', label: 'Commits', value: gitReport.totalCommits.toLocaleString(), color: colors.green }
    );
  }
  
  summaryItems.forEach(({icon, label, value, color}) => {
    console.log(`  ${icon} ${colors.bright}${label}:${colors.reset} ${color}${value}${colors.reset}`);
  });
  
  if (pkgReport.totalFiles > 0) {
    const purityEmoji = pkgReport.purityPercentage > 80 ? '🟢' : pkgReport.purityPercentage > 50 ? '🟡' : '🔴';
    console.log(`\n  ${purityEmoji} ${colors.dim}Purity:${colors.reset} ${pkgReport.pureProjects}/${pkgReport.totalFiles} projects without deps`);
  }
  
  console.log('\n' + colors.dim + '─'.repeat(terminalWidth - 1) + colors.reset);
  console.log(colors.green + '✓ Analysis complete!' + colors.reset);
}

/**
 * Process multiple directories in comparison mode
 */
async function processMultipleDirectories(directories) {
  // Validate all directories
  const validDirs = [];
  for (const dir of directories) {
    const absolutePath = path.resolve(dir);
    try {
      const stats = await stat(absolutePath);
      if (!stats.isDirectory()) {
        console.error(`${colors.red}Warning: ${dir} is not a directory, skipping${colors.reset}`);
        continue;
      }
      validDirs.push(absolutePath);
    } catch (error) {
      console.error(`${colors.red}Warning: Directory does not exist: ${dir}, skipping${colors.reset}`);
    }
  }

  if (validDirs.length === 0) {
    console.error(`${colors.red}Error: No valid directories to analyze${colors.reset}`);
    process.exit(1);
  }

  if (validDirs.length === 1) {
    console.log(`${colors.yellow}Only one valid directory provided, switching to single mode${colors.reset}\n`);
    await processSingleDirectory(validDirs[0]);
    return;
  }

  console.clear();
  printComparisonHeader(validDirs);

  // Create analyzer for each directory
  const reports = {};
  const gitAnalyzers = {}; // Store Git analyzers separately

  // Progress tracking
  let completedDirs = 0;
  const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let spinnerIndex = 0;

  const spinnerInterval = setInterval(() => {
    const progress = Math.floor((completedDirs / validDirs.length) * 100);
    process.stdout.write(`\r${colors.cyan}${spinnerFrames[spinnerIndex]} Processing directories... ${progress}% (${completedDirs}/${validDirs.length})${colors.reset}`);
    spinnerIndex = (spinnerIndex + 1) % spinnerFrames.length;
  }, 100);

  // Process each directory
  for (const dir of validDirs) {
    const analyzer = new DirectoryAnalyzer();
    
    analyzer.registerAnalyzer(new TotalSizeAnalyzer(IGNORE_DIRS));
    analyzer.registerAnalyzer(new PackageJsonAnalyzer());
    analyzer.registerAnalyzer(new LocAnalyzer());
    analyzer.registerAnalyzer(new ArchiveAnalyzer());
    analyzer.registerAnalyzer(new BinaryAnalyzer());
    
    // NEW: Register Git analyzer
    const gitAnalyzer = new GitAnalyzer();
    analyzer.registerAnalyzer(gitAnalyzer);
    gitAnalyzers[dir] = gitAnalyzer;
    
    analyzer.resetAll();
    await analyzer.traverseDirectory(dir);
    
    // NEW: Run Git analysis separately
    await gitAnalyzer.scanDirectory(dir);
    
    reports[dir] = analyzer.getReport();
    completedDirs++;
  }

  clearInterval(spinnerInterval);
  process.stdout.write('\r' + ' '.repeat(60) + '\r');

  // Flatten reports for easier access
  const flattenedReports = {};
  validDirs.forEach(dir => {
    const sizeReport = reports[dir]['Total Size Analyzer'];
    const pkgReport = reports[dir]['Package.json Analyzer'];
    const locReport = reports[dir]['Lines of Code Analyzer'];
    const archiveReport = reports[dir]['Archive Files Analyzer'];
    const binaryReport = reports[dir]['Binary Files Analyzer'];
    const gitReport = reports[dir]['Git Analyzer'];
    
    flattenedReports[dir] = {
      ...sizeReport,
      'Package.json Analyzer': pkgReport,
      'Lines of Code Analyzer': locReport,
      'Archive Files Analyzer': archiveReport,
      'Binary Files Analyzer': binaryReport,
      'Git Analyzer': gitReport
    };
  });

  // Directory Statistics Table
  console.log('\n' + colors.cyan + colors.bright + '📁 DIRECTORY STATISTICS' + colors.reset);
  const dirMetrics = [
    { label: 'Total Size', key: 'totalSizeFormatted', winner: 'smallest', getValue: (r) => r.totalSizeFormatted },
    { label: 'Code Size', key: 'codeSizeFormatted', winner: 'largest', getValue: (r) => r.codeSizeFormatted },
    { label: 'Binary Size', key: 'binarySizeFormatted', winner: 'smallest', getValue: (r) => r.binarySizeFormatted },
    { label: 'Archive Size', key: 'archiveSizeFormatted', winner: 'smallest', getValue: (r) => r.archiveSizeFormatted },
    { label: 'Files', key: 'fileCount', winner: 'largest', getValue: (r) => r.fileCount.toLocaleString() },
    { label: 'Directories', key: 'dirCount', winner: 'largest', getValue: (r) => r.dirCount.toLocaleString() }
  ];
  createTable(validDirs, dirMetrics, flattenedReports);

  // Package.json Table
  const hasPackageJson = validDirs.some(dir => flattenedReports[dir]['Package.json Analyzer'].totalFiles > 0);
  if (hasPackageJson) {
    console.log('\n' + colors.magenta + colors.bright + '📦 PACKAGE.JSON ANALYSIS' + colors.reset);
    const pkgMetrics = [
      { label: 'package.json', key: 'totalFiles', winner: 'largest', getValue: (r) => r['Package.json Analyzer'].totalFiles },
      { label: 'Dependencies', key: 'totalDeps', winner: 'smallest', getValue: (r) => r['Package.json Analyzer'].totalDeps },
      { label: 'Purity %', key: 'purityPercentage', winner: 'largest', getValue: (r) => `${r['Package.json Analyzer'].purityPercentage}%` }
    ];
    createTable(validDirs, pkgMetrics, flattenedReports);
  }

  // Lines of Code Table
  const hasLoc = validDirs.some(dir => flattenedReports[dir]['Lines of Code Analyzer'].totalLines > 0);
  if (hasLoc) {
    console.log('\n' + colors.green + colors.bright + '📝 LINES OF CODE' + colors.reset);
    const locMetrics = [
      { label: 'Total Lines', key: 'totalLines', winner: 'largest', getValue: (r) => r['Lines of Code Analyzer'].totalLinesFormatted }
    ];
    createTable(validDirs, locMetrics, flattenedReports);
    printLanguagesComparison(validDirs, flattenedReports);
  }

  // Archive Files Table
  const hasArchives = validDirs.some(dir => flattenedReports[dir]['Archive Files Analyzer'].totalCount > 0);
  if (hasArchives) {
    console.log('\n' + colors.yellow + colors.bright + '📦 ARCHIVE FILES' + colors.reset);
    const archiveMetrics = [
      { label: 'Archive Files', key: 'totalCount', winner: 'smallest', getValue: (r) => r['Archive Files Analyzer'].totalCount },
      { label: 'Archive Size', key: 'totalSize', winner: 'smallest', getValue: (r) => r['Archive Files Analyzer'].totalSizeFormatted }
    ];
    createTable(validDirs, archiveMetrics, flattenedReports);
  }

  // Binary Files Table
  const hasBinaries = validDirs.some(dir => flattenedReports[dir]['Binary Files Analyzer'].totalCount > 0);
  if (hasBinaries) {
    console.log('\n' + colors.blue + colors.bright + '💾 BINARY FILES' + colors.reset);
    const binaryMetrics = [
      { label: 'Binary Files', key: 'totalCount', winner: 'smallest', getValue: (r) => r['Binary Files Analyzer'].totalCount },
      { label: 'Binary Size', key: 'totalSize', winner: 'smallest', getValue: (r) => r['Binary Files Analyzer'].totalSizeFormatted }
    ];
    createTable(validDirs, binaryMetrics, flattenedReports);
  }

  // NEW: Git Comparison Table
  printGitComparison(validDirs, flattenedReports);

  // Calculate winners
  const winners = {};
  validDirs.forEach(dir => winners[dir] = 0);

  const allMetrics = [...dirMetrics];
  if (hasPackageJson) allMetrics.push(...[
    { label: 'package.json', key: 'totalFiles', winner: 'largest' },
    { label: 'Dependencies', key: 'totalDeps', winner: 'smallest' },
    { label: 'Purity %', key: 'purityPercentage', winner: 'largest' }
  ]);
  if (hasLoc) allMetrics.push({ label: 'Total Lines', key: 'totalLines', winner: 'largest' });
  if (hasArchives) allMetrics.push({ label: 'Archive Files', key: 'totalCount', winner: 'smallest' });
  if (hasBinaries) allMetrics.push({ label: 'Binary Files', key: 'totalCount', winner: 'smallest' });
  
  // NEW: Add Git metrics to winners calculation
  const hasGit = validDirs.some(dir => flattenedReports[dir]['Git Analyzer'].totalRepositories > 0);
  if (hasGit) {
    allMetrics.push(
      { label: 'Git Repos', key: 'totalRepositories', winner: 'largest' },
      { label: 'Total Commits', key: 'totalCommits', winner: 'largest' },
      { label: 'Unique Contributors', key: 'totalUniqueContributors', winner: 'largest' }
    );
  }

  allMetrics.forEach(metric => {
    const values = validDirs.map(dir => {
      if (metric.key.includes('Formatted') || metric.key === 'totalLinesFormatted') {
        const report = flattenedReports[dir];
        if (metric.key === 'totalSizeFormatted') return parseFloat(report.totalSizeMB);
        if (metric.key === 'codeSizeFormatted') return parseFloat(report.codeSizeMB);
        if (metric.key === 'binarySizeFormatted') return parseFloat(report.binarySizeMB);
        if (metric.key === 'archiveSizeFormatted') return parseFloat(report.archiveSizeMB);
        if (metric.key === 'totalLinesFormatted') return flattenedReports[dir]['Lines of Code Analyzer'].totalLines;
      }
      if (metric.key === 'totalFiles' || metric.key === 'totalDeps' || metric.key === 'purityPercentage') {
        return parseFloat(flattenedReports[dir]['Package.json Analyzer'][metric.key]) || 0;
      }
      if (metric.key === 'totalCount') {
        if (metric.label.includes('Archive')) {
          return flattenedReports[dir]['Archive Files Analyzer'].totalCount;
        }
        if (metric.label.includes('Binary')) {
          return flattenedReports[dir]['Binary Files Analyzer'].totalCount;
        }
      }
      // NEW: Handle Git metrics
      if (metric.key === 'totalRepositories' || metric.key === 'totalCommits' || metric.key === 'totalUniqueContributors') {
        return flattenedReports[dir]['Git Analyzer'][metric.key] || 0;
      }
      return parseFloat(flattenedReports[dir][metric.key]) || 0;
    });

    const winnerValue = metric.winner === 'largest' ? Math.max(...values) : Math.min(...values);
    const winnerIndex = values.indexOf(winnerValue);
    if (winnerIndex !== -1) {
      winners[validDirs[winnerIndex]]++;
    }
  });

  printWinnerPodium(winners);

  console.log('\n' + colors.dim + '─'.repeat(terminalWidth - 1) + colors.reset);
  console.log(colors.green + '✓ Comparison complete!' + colors.reset);
  console.log(colors.dim + `Analyzed ${validDirs.length} directories` + colors.reset);
}

/**
 * Main function
 */
async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.error(`${colors.red}Error: Please provide at least one directory path${colors.reset}`);
    console.error(`${colors.yellow}Usage: node script.js <directory-path> [directory-path2 ...]${colors.reset}`);
    process.exit(1);
  }
  
  if (args.length === 1) {
    await processSingleDirectory(args[0]);
  } else {
    await processMultipleDirectories(args);
  }
}

process.on('unhandledRejection', (error) => {
  console.error(`${colors.red}Unhandled rejection: ${error}${colors.reset}`);
  process.exit(1);
});

main();