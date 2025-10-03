import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';
import { spawn, execSync } from 'child_process';

// ES6 module compatibility for __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Global configuration file path
const CONFIG_FILE = path.join(os.homedir(), '.dirserver-config.json');

class DirServer {
    static server = null;
    static config = {
        port: 3000,
        folderPath: './public',
        contentTypes: {
            '.html': 'text/html',
            '.css': 'text/css',
            '.js': 'text/javascript',
            '.json': 'application/json',
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.gif': 'image/gif',
            '.svg': 'image/svg+xml',
            '.ico': 'image/x-icon',
            '.txt': 'text/plain',
            '.woff': 'font/woff',
            '.woff2': 'font/woff2',
            '.ttf': 'font/ttf',
            '.eot': 'application/vnd.ms-fontobject',
            '.mp4': 'video/mp4',
            '.webm': 'video/webm',
            '.mp3': 'audio/mpeg',
            '.wav': 'audio/wav'
        }
    };

    /**
     * Starts the server using system-level configuration
     * @param {string} folderPath - Optional folder path to serve
     * @param {number} port - Optional port number
     */
    static Start(folderPath = null, port = null) {
        this.loadConfig();
        
        // Override config with provided parameters
        if (folderPath) this.config.folderPath = folderPath;
        if (port) this.config.port = port;

        const absolutePath = path.resolve(this.config.folderPath);
        
        // Verify the folder exists
        if (!fs.existsSync(absolutePath)) {
            throw new Error(`Folder not found: ${absolutePath}`);
        }

        const indexHtmlPath = path.join(absolutePath, 'index.html');
        if (!fs.existsSync(indexHtmlPath)) {
            console.warn(`Warning: index.html not found in: ${absolutePath}`);
        }

        this.server = http.createServer((req, res) => {
            this.handleRequest(req, res, absolutePath);
        });

        this.server.listen(this.config.port, () => {
            console.log(`🚀 DirServer running at http://localhost:${this.config.port}`);
            console.log(`📁 Serving files from: ${absolutePath}`);
            console.log(`⚙️  Config file: ${CONFIG_FILE}`);
            console.log(`⏹️  Press Ctrl+C to stop the server`);
        });

        this.server.on('error', (error) => {
            console.error('❌ Server error:', error.message);
        });

        // Handle graceful shutdown
        process.on('SIGINT', () => {
            this.Stop();
        });

        process.on('SIGTERM', () => {
            this.Stop();
        });
    }

    /**
     * Stops the server
     */
    static Stop() {
        if (this.server) {
            this.server.close();
            console.log('🛑 DirServer stopped');
        }
        process.exit(0);
    }

    /**
     * Installs DirServer globally on the system
     */
    static InstallGlobal() {
        console.log('🌐 Installing DirServer globally...');
        
        const currentScriptPath = import.meta.url.replace('file://', '');
        
        try {
            if (os.platform() === 'win32') {
                this.installWindows(currentScriptPath);
            } else {
                this.installUnix(currentScriptPath);
            }
        } catch (error) {
            console.error('❌ Installation failed:', error.message);
            console.log('💡 You may need to run with administrator/sudo privileges');
        }
    }

    /**
     * Installs on Windows using PowerShell
     */
    static installWindows(scriptPath) {
        const binName = 'dirserver';
        const tempBat = path.join(os.tmpdir(), 'dirserver_install.bat');
        
        // Create a batch file that runs the Node.js script
        const batContent = `@echo off
node "${scriptPath}" %*`;

        fs.writeFileSync(tempBat, batContent);

        // Get Windows PATH directories
        const systemPath = process.env.PATH.split(';');
        const userBinDir = path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'WindowsApps');
        
        if (!fs.existsSync(userBinDir)) {
            fs.mkdirSync(userBinDir, { recursive: true });
        }

        const batTargetPath = path.join(userBinDir, `${binName}.bat`);
        fs.copyFileSync(tempBat, batTargetPath);
        fs.unlinkSync(tempBat);

        console.log(`✅ Created ${batTargetPath}`);
        console.log('🎉 DirServer installed globally!');
        console.log('🔧 You can now use "dirserver" command anywhere');
        console.log('🔄 You may need to restart your terminal for changes to take effect');
    }

    /**
     * Installs on Unix-like systems (Linux, macOS, Alpine)
     */
    static installUnix(scriptPath) {
        const binName = 'dirserver';
        const possibleDirs = [
            '/usr/local/bin',
            '/usr/bin',
            path.join(os.homedir(), '.local', 'bin'),
            '/opt/local/bin'
        ];

        let targetDir = null;
        for (const dir of possibleDirs) {
            if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
                // Check if we have write access
                try {
                    fs.accessSync(dir, fs.constants.W_OK);
                    targetDir = dir;
                    break;
                } catch (e) {
                    continue;
                }
            }
        }

        if (!targetDir) {
            // Try to create ~/.local/bin
            const localBin = path.join(os.homedir(), '.local', 'bin');
            fs.mkdirSync(localBin, { recursive: true });
            targetDir = localBin;
        }

        const targetPath = path.join(targetDir, binName);
        
        // Create shell script
        const scriptContent = `#!/bin/bash
node "${scriptPath}" "$@"`;

        fs.writeFileSync(targetPath, scriptContent);
        fs.chmodSync(targetPath, 0o755); // Make executable

        console.log(`✅ Created ${targetPath}`);
        console.log('🎉 DirServer installed globally!');
        console.log('🔧 You can now use "dirserver" command anywhere');
        
        // Check if target directory is in PATH
        const currentPath = process.env.PATH || '';
        if (!currentPath.includes(targetDir)) {
            console.log('⚠️  Note: You may need to add this to your ~/.bashrc or ~/.zshrc:');
            console.log(`    export PATH="$PATH:${targetDir}"`);
        }
    }

    /**
     * Uninstalls global installation
     */
    static UninstallGlobal() {
        console.log('🗑️  Uninstalling DirServer globally...');
        
        try {
            if (os.platform() === 'win32') {
                this.uninstallWindows();
            } else {
                this.uninstallUnix();
            }
        } catch (error) {
            console.error('❌ Uninstallation failed:', error.message);
        }
    }

    static uninstallWindows() {
        const binName = 'dirserver';
        const userBinDir = path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'WindowsApps');
        const batPath = path.join(userBinDir, `${binName}.bat`);
        
        if (fs.existsSync(batPath)) {
            fs.unlinkSync(batPath);
            console.log(`✅ Removed ${batPath}`);
        } else {
            console.log('❌ DirServer not found in global location');
        }
    }

    static uninstallUnix() {
        const binName = 'dirserver';
        const possiblePaths = [
            '/usr/local/bin/dirserver',
            '/usr/bin/dirserver',
            path.join(os.homedir(), '.local', 'bin', 'dirserver'),
            '/opt/local/bin/dirserver'
        ];

        let found = false;
        for (const possiblePath of possiblePaths) {
            if (fs.existsSync(possiblePath)) {
                fs.unlinkSync(possiblePath);
                console.log(`✅ Removed ${possiblePath}`);
                found = true;
            }
        }

        if (!found) {
            console.log('❌ DirServer not found in global locations');
        }
    }

    /**
     * Loads configuration from system file or creates default
     */
    static loadConfig() {
        try {
            if (fs.existsSync(CONFIG_FILE)) {
                const fileContent = fs.readFileSync(CONFIG_FILE, 'utf8');
                const savedConfig = JSON.parse(fileContent);
                this.config = { ...this.config, ...savedConfig };
            } else {
                this.saveConfig();
            }
        } catch (error) {
            console.warn('⚠️ Error loading config, using defaults:', error.message);
            this.saveConfig();
        }
    }

    /**
     * Saves current configuration to system file
     */
    static saveConfig() {
        try {
            fs.writeFileSync(CONFIG_FILE, JSON.stringify(this.config, null, 2));
        } catch (error) {
            console.error('❌ Error saving config:', error);
        }
    }

    /**
     * Updates configuration and saves to system file
     */
    static UpdateConfig(newConfig) {
        this.config = { ...this.config, ...newConfig };
        this.saveConfig();
        console.log('✅ Configuration updated and saved');
    }

    /**
     * Shows current configuration
     */
    static ShowConfig() {
        console.log('📋 Current configuration:');
        console.log(JSON.stringify(this.config, null, 2));
        console.log('📁 Config file location:', CONFIG_FILE);
    }

    /**
     * Handles incoming HTTP requests
     */
    static handleRequest(req, res, basePath) {
        // Remove query parameters and normalize the URL
        let urlPath = decodeURIComponent(new URL(req.url, `http://${req.headers.host}`).pathname);
        
        // Default to index.html for root path
        if (urlPath === '/') {
            urlPath = '/index.html';
        }

        // Security: Prevent directory traversal
        const requestedPath = path.join(basePath, urlPath);
        if (!requestedPath.startsWith(basePath)) {
            this.sendError(res, 403, 'Forbidden');
            return;
        }

        this.serveFile(res, requestedPath, basePath);
    }

    /**
     * Serves a file if it exists, otherwise returns 404
     */
    static serveFile(res, filePath, basePath) {
        fs.stat(filePath, (err, stats) => {
            if (err || !stats.isFile()) {
                // If file doesn't exist, try with .html extension
                if (!filePath.endsWith('.html')) {
                    this.serveFile(res, filePath + '.html', basePath);
                    return;
                }
                
                // Try index.html for directory paths
                if (filePath.endsWith('/index.html')) {
                    const dirPath = filePath.slice(0, -10);
                    const dirIndexPath = path.join(dirPath, 'index.html');
                    this.serveFile(res, dirIndexPath, basePath);
                    return;
                }
                
                this.sendError(res, 404, `File not found: ${path.relative(basePath, filePath)}`);
                return;
            }

            // Get file extension and content type
            const ext = path.extname(filePath).toLowerCase();
            const contentType = this.config.contentTypes[ext] || 'application/octet-stream';

            // Read and serve the file
            const stream = fs.createReadStream(filePath);
            
            stream.on('open', () => {
                res.writeHead(200, {
                    'Content-Type': contentType,
                    'Cache-Control': 'public, max-age=3600'
                });
                stream.pipe(res);
            });

            stream.on('error', (err) => {
                console.error('❌ File read error:', err.message);
                this.sendError(res, 500, 'Internal server error');
            });
        });
    }

    /**
     * Sends error responses
     */
    static sendError(res, statusCode, message) {
        res.writeHead(statusCode, { 'Content-Type': 'text/html' });
        res.end(this.generateErrorPage(statusCode, message));
    }

    /**
     * Generates beautiful error pages
     */
    static generateErrorPage(statusCode, message) {
        const emojis = {
            403: '🚫',
            404: '🔍',
            500: '💥'
        };
        
        const emoji = emojis[statusCode] || '❓';
        
        return `<!DOCTYPE html>
<html>
<head>
    <title>Error ${statusCode}</title>
    <style>
        body { 
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; 
            text-align: center; 
            padding: 50px; 
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            min-height: 100vh;
            display: flex;
            flex-direction: column;
            justify-content: center;
            align-items: center;
            margin: 0;
        }
        .error-container {
            background: rgba(255,255,255,0.1);
            padding: 40px;
            border-radius: 15px;
            backdrop-filter: blur(10px);
            box-shadow: 0 8px 32px rgba(0,0,0,0.1);
            max-width: 500px;
            width: 90%;
        }
        h1 { 
            font-size: 4em; 
            margin: 0; 
            text-shadow: 2px 2px 4px rgba(0,0,0,0.3);
        }
        p { 
            font-size: 1.2em; 
            margin: 20px 0; 
        }
        .emoji { 
            font-size: 3em; 
            margin-bottom: 20px;
        }
        a {
            color: white;
            text-decoration: underline;
        }
    </style>
</head>
<body>
    <div class="error-container">
        <div class="emoji">${emoji}</div>
        <h1>${statusCode}</h1>
        <p>${message}</p>
        <hr style="border: none; border-top: 1px solid rgba(255,255,255,0.3); margin: 20px 0;">
        <small>DirServer • ${new Date().toLocaleString()}</small>
    </div>
</body>
</html>`;
    }
}

// Direct execution support
if (import.meta.url === `file://${process.argv[1]}`) {
    const args = process.argv.slice(2);
    const command = args[0];

    const showUsage = () => {
        console.log(`
🌐 DirServer - Static File Server
Usage:
  dirserver [command] [options]

Commands:
  start [folder] [port]    Start server with optional folder and port
  config                   Show current configuration
  set-port <port>          Change default port (3000)
  set-folder <path>        Change default folder (./public)
  install-global           Install globally as system command
  uninstall-global         Remove global installation
  help                     Show this help message

Examples:
  dirserver start                    # Start with default config
  dirserver start ./my-site          # Serve specific folder
  dirserver start ./dist 8080        # Serve folder on port 8080
  dirserver set-port 8080           # Change default port
  dirserver set-folder ./www        # Change default folder
  dirserver install-global          # Install as global command

Quick Start:
  mkdir public
  echo "<html><body><h1>Hello World!</h1></body></html>" > public/index.html
  dirserver start
        `.trim());
    };

    switch (command) {
        case 'start':
            const folderPath = args[1] || DirServer.config.folderPath;
            const port = args[2] ? parseInt(args[2]) : DirServer.config.port;
            
            if (port && (port < 1 || port > 65535)) {
                console.error('❌ Invalid port number. Must be between 1 and 65535');
                process.exit(1);
            }
            
            try {
                console.log('🚀 Starting DirServer...');
                DirServer.Start(folderPath, port);
            } catch (error) {
                console.error('❌ Failed to start server:', error.message);
                process.exit(1);
            }
            break;
        
        case 'config':
            DirServer.ShowConfig();
            break;
        
        case 'set-port':
            const newPort = parseInt(args[1]);
            if (newPort && newPort > 0 && newPort < 65536) {
                DirServer.UpdateConfig({ port: newPort });
                console.log(`✅ Port updated to: ${newPort}`);
            } else {
                console.error('❌ Invalid port number. Must be between 1 and 65535');
            }
            break;
        
        case 'set-folder':
            const newFolder = args[1];
            if (newFolder) {
                DirServer.UpdateConfig({ folderPath: newFolder });
                console.log(`✅ Folder path updated to: ${newFolder}`);
            } else {
                console.error('❌ Folder path is required');
            }
            break;
        
        case 'install-global':
            DirServer.InstallGlobal();
            break;
        
        case 'uninstall-global':
            DirServer.UninstallGlobal();
            break;
        
        case 'help':
        case '--help':
        case '-h':
        default:
            showUsage();
            break;
    }
}

export default DirServer;
