import HUD from '../HUD/HUD.js'
import DirServer from '../DirServer.js'
import fs from 'fs'
import path from 'path'
import os from 'os'
import MainMenu from './MainMenu.js'

// Global state to track current directory and selected path
let currentDir = '';
let selectedPath = '';

/**
 * Gets the initial directory based on OS
 */
const getInitialDir = () => {
    const platform = os.platform();
    if (platform === 'win32') {
        return path.join(os.homedir(), 'Downloads');
    } else {
        // Linux, macOS, Alpine, etc.
        return os.homedir();
    }
};

/**
 * Gets directory contents with proper filtering and sorting
 */
const getDirectoryContents = (dirPath) => {
    try {
        if (!fs.existsSync(dirPath)) {
            return { error: 'Directory does not exist', files: [], directories: [] };
        }

        const items = fs.readdirSync(dirPath);
        const directories = [];
        const files = [];

        for (const item of items) {
            try {
                const fullPath = path.join(dirPath, item);
                const stats = fs.statSync(fullPath);
                
                if (stats.isDirectory()) {
                    directories.push({
                        name: item,
                        path: fullPath,
                        isDirectory: true
                    });
                } else {
                    files.push({
                        name: item,
                        path: fullPath,
                        isDirectory: false
                    });
                }
            } catch (error) {
                // Skip items that can't be accessed
                continue;
            }
        }

        // Sort directories and files alphabetically
        directories.sort((a, b) => a.name.localeCompare(b.name));
        files.sort((a, b) => a.name.localeCompare(b.name));

        return { directories, files, error: null };
    } catch (error) {
        return { error: error.message, files: [], directories: [] };
    }
};

/**
 * Navigate to parent directory
 */
const goToParentDir = () => {
    const parentDir = path.dirname(currentDir);
    if (parentDir !== currentDir) { // Prevent going above root
        currentDir = parentDir;
        HUD.displayMenu(DirSelectorMenu);
    }
};

/**
 * Navigate to a subdirectory
 */
const goToSubDir = (subDirPath) => {
    currentDir = subDirPath;
    HUD.displayMenu(DirSelectorMenu);
};

/**
 * Confirm directory selection and start server
 */
const confirmDirectorySelection = (dirPath) => {
    selectedPath = dirPath;
    HUD.displayMenu(ConfirmSelectionMenu);
};

/**
 * Actually start the DirServer with selected path
 */
const startDirServer = () => {
    try {
        console.log(`🚀 Starting DirServer with directory: ${selectedPath}`);
        DirServer.Start(selectedPath);
        // Optionally go back to main menu or show success message
        HUD.displayMenu(DirServerMenu);
    } catch (error) {
        console.error('❌ Failed to start server:', error.message);
        // You might want to show an error menu here
        HUD.displayMenu(DirSelectorMenu);
    }
};

// Menu Definitions

const ConfirmSelectionMenu = () => {
    const final = {
        title: `Sy Manager > DirServer > Confirm Selection`,
        options: []
    };

    final.options.push({
        name: `✅ YES - Start Server in:\n    ${selectedPath}`,
        action: () => {
            startDirServer();
        }
    });

    final.options.push({
        name: '❌ NO - Go Back to Directory Selection',
        action: () => {
            HUD.displayMenu(DirSelectorMenu);
        }
    });

    final.options.push({
        name: '📁 Choose Different Directory',
        action: () => {
            HUD.displayMenu(DirSelectorMenu);
        }
    });

    final.options.push({
        name: '🏠 Back to DirServer Menu',
        action: () => {
            HUD.displayMenu(DirServerMenu);
        }
    });

    return final;
};

const DirSelectorMenu = () => {
    // Initialize current directory if not set
    if (!currentDir) {
        currentDir = getInitialDir();
    }

    const directoryContents = getDirectoryContents(currentDir);
    const final = {
        title: `Sy Manager > DirServer > Directory Selector\n📁 Path: ${currentDir}`,
        options: []
    };

    // Show error if any
    if (directoryContents.error) {
        final.options.push({
            name: `❌ Error: ${directoryContents.error}`,
            action: () => {}
        });
    }

    // Parent directory option (if not at root)
    if (currentDir !== path.dirname(currentDir)) {
        final.options.push({
            name: '📂 .. (Go Up)',
            action: () => {
                goToParentDir();
            }
        });
    }

    // Directory options
    directoryContents.directories.forEach(dir => {
        final.options.push({
            name: `📁 ${dir.name}/`,
            action: () => {
                goToSubDir(dir.path);
            }
        });
    });

    // File options (read-only, for context)
    directoryContents.files.forEach(file => {
        final.options.push({
            name: `📄 ${file.name}`,
            action: () => {
                // Files are not selectable for serving, but you could add file operations here
                console.log(`Selected file: ${file.path}`);
            }
        });
    });

    // Action options
    final.options.push({
        name: '--- Actions ---',
        action: () => {}
    });

    // Select current directory
    final.options.push({
        name: `✅ SELECT THIS FOLDER: ${path.basename(currentDir)}`,
        action: () => {
            confirmDirectorySelection(currentDir);
        }
    });

    // Go home
    final.options.push({
        name: '🏠 Go to Home Directory',
        action: () => {
            currentDir = os.homedir();
            HUD.displayMenu(DirSelectorMenu);
        }
    });

    // Navigation
    final.options.push({
        name: '<- Back to DirServer Menu',
        action: () => {
            HUD.displayMenu(DirServerMenu);
        }
    });

    return final;
};

const DirServerMenu = () => {
    const final = {
        title: 'Sy Manager > DirServer Menu',
        options: []
    };

    // Show current selection if any
    if (selectedPath) {
        final.options.push({
            name: `📁 Current Selection: ${selectedPath}`,
            action: () => {
                HUD.displayMenu(DirSelectorMenu);
            }
        });

        final.options.push({
            name: '🚀 Start Server with Selected Directory',
            action: () => {
                startDirServer();
            }
        });
    }

    final.options.push({
        name: '📁 Select Directory to Serve',
        action: () => {
            // Reset to initial directory when starting new selection
            currentDir = getInitialDir();
            HUD.displayMenu(DirSelectorMenu);
        }
    });

    final.options.push({
        name: '⚙️ Show Current Configuration',
        action: () => {
            DirServer.ShowConfig();
            // Stay in current menu
            HUD.displayMenu(DirServerMenu);
        }
    });

    final.options.push({
        name: '🌐 Install Globally',
        action: () => {
            DirServer.InstallGlobal();
            HUD.displayMenu(DirServerMenu);
        }
    });

    final.options.push({
        name: '<- Back to Main Menu',
        action: () => {
            HUD.displayMenu(MainMenu);
        }
    });

    return final;
};

export default DirServerMenu;
