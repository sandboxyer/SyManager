#!/usr/bin/env node

import { exec } from 'child_process';
import util from 'util';
import fs from 'fs';

const execPromise = util.promisify(exec);

// ANSI color codes for maximum contrast
const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    dim: '\x1b[2m',
    underscore: '\x1b[4m',
    blink: '\x1b[5m',
    reverse: '\x1b[7m',
    hidden: '\x1b[8m',
    
    // Foreground colors
    black: '\x1b[30m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    white: '\x1b[37m',
    
    // Bright foreground colors (higher contrast)
    brightBlack: '\x1b[90m',
    brightRed: '\x1b[91m',
    brightGreen: '\x1b[92m',
    brightYellow: '\x1b[93m',
    brightBlue: '\x1b[94m',
    brightMagenta: '\x1b[95m',
    brightCyan: '\x1b[96m',
    brightWhite: '\x1b[97m',
    
    // Background colors
    bgBlack: '\x1b[40m',
    bgRed: '\x1b[41m',
    bgGreen: '\x1b[42m',
    bgYellow: '\x1b[43m',
    bgBlue: '\x1b[44m',
    bgMagenta: '\x1b[45m',
    bgCyan: '\x1b[46m',
    bgWhite: '\x1b[47m',
    
    // Bright background colors
    bgBrightBlack: '\x1b[100m',
    bgBrightRed: '\x1b[101m',
    bgBrightGreen: '\x1b[102m',
    bgBrightYellow: '\x1b[103m',
    bgBrightBlue: '\x1b[104m',
    bgBrightMagenta: '\x1b[105m',
    bgBrightCyan: '\x1b[106m',
    bgBrightWhite: '\x1b[107m'
};

async function getGitDiff() {
    try {
        // Check if we're in a git repository
        await execPromise('git rev-parse --git-dir');
        
        // Get staged changes
        const { stdout: stagedDiff } = await execPromise('git diff --cached --no-color');
        
        // Get unstaged changes
        const { stdout: unstagedDiff } = await execPromise('git diff --no-color');
        
        // Get untracked files
        const { stdout: untracked } = await execPromise('git ls-files --others --exclude-standard');
        
        return { stagedDiff, unstagedDiff, untracked };
    } catch (error) {
        if (error.message.includes('not a git repository')) {
            console.error(`${colors.bgBrightRed}${colors.brightWhite} ERROR ${colors.reset} Not a git repository`);
            process.exit(1);
        }
        throw error;
    }
}

function formatFileHeader(filename, status) {
    const statusColors = {
        'staged': colors.bgBrightGreen + colors.black,
        'unstaged': colors.bgBrightYellow + colors.black,
        'untracked': colors.bgBrightRed + colors.white,
        'modified': colors.bgBrightCyan + colors.black
    };
    
    const statusStr = status.toUpperCase().padEnd(10);
    const color = statusColors[status] || colors.bgBrightWhite + colors.black;
    
    return `\n${colors.bright}${color} ${statusStr} ${colors.reset} ${colors.brightWhite}${filename}${colors.reset}\n`;
}

function formatDiffLine(line) {
    if (line.startsWith('diff --git')) {
        return `${colors.brightMagenta}${line}${colors.reset}`;
    }
    if (line.startsWith('index ')) {
        return `${colors.dim}${colors.cyan}${line}${colors.reset}`;
    }
    if (line.startsWith('---')) {
        return `${colors.brightRed}${line}${colors.reset}`;
    }
    if (line.startsWith('+++')) {
        return `${colors.brightGreen}${line}${colors.reset}`;
    }
    if (line.startsWith('@@')) {
        // Enhanced hunk header with background
        return `\n${colors.bgBrightBlue}${colors.brightWhite} ${line} ${colors.reset}`;
    }
    if (line.startsWith('+')) {
        // Added lines with bright green and background
        return `${colors.bgGreen}${colors.black}${colors.bright}+${line.substring(1)}${colors.reset}`;
    }
    if (line.startsWith('-')) {
        // Removed lines with bright red and background
        return `${colors.bgRed}${colors.white}${colors.bright}-${line.substring(1)}${colors.reset}`;
    }
    if (line.startsWith(' ')) {
        // Context lines with dim gray
        return `${colors.dim}${colors.brightBlack} ${line.substring(1)}${colors.reset}`;
    }
    return line;
}

function parseAndFormatDiff(diff, type) {
    if (!diff || diff.trim().length === 0) return '';
    
    const lines = diff.split('\n');
    let output = '';
    let currentFile = '';
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        
        // Extract filename from diff header
        if (line.startsWith('diff --git')) {
            const match = line.match(/a\/(.+?) b\//);
            if (match) {
                currentFile = match[1];
                output += formatFileHeader(currentFile, type);
            }
        }
        
        output += formatDiffLine(line) + '\n';
    }
    
    return output;
}

function formatUntrackedFiles(files) {
    if (!files || files.trim().length === 0) return '';
    
    const fileList = files.split('\n').filter(f => f.trim());
    let output = `\n${colors.bgBrightRed}${colors.brightWhite} UNTRACKED FILES ${colors.reset}\n`;
    output += `${colors.brightRed}${'═'.repeat(50)}${colors.reset}\n`;
    
    fileList.forEach(file => {
        output += `${colors.bgRed}${colors.white} ? ${colors.reset} ${colors.brightRed}${file}${colors.reset}\n`;
    });
    
    return output;
}

function printSummary(stagedDiff, unstagedDiff, untrackedFiles) {
    const hasStaged = stagedDiff && stagedDiff.trim().length > 0;
    const hasUnstaged = unstagedDiff && unstagedDiff.trim().length > 0;
    const hasUntracked = untrackedFiles && untrackedFiles.trim().length > 0;
    
    console.log(`\n${colors.brightWhite}${colors.bgBlack} GIT STATUS SUMMARY ${colors.reset}\n`);
    
    // Staged changes
    const stagedCount = hasStaged ? (stagedDiff.match(/^\+/gm) || []).length : 0;
    const stagedRemovals = hasStaged ? (stagedDiff.match(/^-/gm) || []).length : 0;
    
    console.log(`${colors.bgBrightGreen}${colors.black} STAGED ${colors.reset} ${colors.green}+${stagedCount} ${colors.red}-${stagedRemovals}${colors.reset}`);
    
    // Unstaged changes
    const unstagedCount = hasUnstaged ? (unstagedDiff.match(/^\+/gm) || []).length : 0;
    const unstagedRemovals = hasUnstaged ? (unstagedDiff.match(/^-/gm) || []).length : 0;
    
    console.log(`${colors.bgBrightYellow}${colors.black} UNSTAGED ${colors.reset} ${colors.green}+${unstagedCount} ${colors.red}-${unstagedRemovals}${colors.reset}`);
    
    // Untracked files
    const untrackedCount = hasUntracked ? untrackedFiles.split('\n').filter(f => f.trim()).length : 0;
    console.log(`${colors.bgBrightRed}${colors.white} UNTRACKED ${colors.reset} ${colors.brightRed}${untrackedCount} files${colors.reset}`);
    
    console.log(`\n${colors.brightWhite}${'═'.repeat(60)}${colors.reset}\n`);
}

async function main() {
    console.clear(); // Clear console for better visibility
    
    // Title with big contrast
    console.log(`${colors.bgWhite}${colors.black}${colors.bright}`);
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║               EXTREME DETAIL GIT DIFF                    ║');
    console.log('╚══════════════════════════════════════════════════════════╝');
    console.log(`${colors.reset}`);
    
    try {
        const { stagedDiff, unstagedDiff, untracked } = await getGitDiff();
        
        // Print summary first
        printSummary(stagedDiff, unstagedDiff, untracked);
        
        // Show staged changes
        if (stagedDiff && stagedDiff.trim().length > 0) {
            console.log(parseAndFormatDiff(stagedDiff, 'staged'));
        } else {
            console.log(`${colors.dim}${colors.green}No staged changes${colors.reset}`);
        }
        
        // Show unstaged changes
        if (unstagedDiff && unstagedDiff.trim().length > 0) {
            console.log(parseAndFormatDiff(unstagedDiff, 'unstaged'));
        } else {
            console.log(`${colors.dim}${colors.yellow}No unstaged changes${colors.reset}`);
        }
        
        // Show untracked files
        if (untracked && untracked.trim().length > 0) {
            console.log(formatUntrackedFiles(untracked));
        }
        
        // Legend at the end
        console.log(`\n${colors.brightWhite}${'═'.repeat(60)}${colors.reset}`);
        console.log(`${colors.brightWhite}LEGEND:${colors.reset}`);
        console.log(`${colors.bgGreen}${colors.black} + ${colors.reset} Added lines  ${colors.bgRed}${colors.white} - ${colors.reset} Removed lines`);
        console.log(`${colors.bgBrightBlue}${colors.white} @@ ${colors.reset} Hunk headers  ${colors.brightMagenta}diff${colors.reset} File headers`);
        console.log(`${colors.dim}${colors.brightBlack} context ${colors.reset} Unchanged lines (dimmed)`);
        
    } catch (error) {
        console.error(`${colors.bgBrightRed}${colors.white} ERROR ${colors.reset} ${error.message}`);
        process.exit(1);
    }
}

// Run the script
if (import.meta.url === `file://${process.argv[1]}`) {
    main();
}

export { getGitDiff, formatDiffLine, parseAndFormatDiff };
