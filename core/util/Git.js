#!/usr/bin/env node

import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class Git {
    static #isExecuting = false;
    static #rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    /**
     * Initialize Git class - main entry point
     */
    static async init() {
        this.#isExecuting = import.meta.url === `file://${process.argv[1]}` || 
                           process.argv[1] && process.argv[1].includes('Git.js');
        
        if (this.#isExecuting) {
            await this.#handleCommandLine();
        }
    }

    /**
     * Handle command line arguments
     */
    static async #handleCommandLine() {
        const args = process.argv.slice(2);
        
        if (args.includes('-h') || args.includes('--help')) {
            this.#showHelp();
            return;
        }

        if (args.includes('--setup')) {
            await this.setup();
            return;
        }

        if (args.includes('--auth')) {
            await this.authenticate();
            return;
        }

        if (args.includes('--config')) {
            await this.configure();
            return;
        }

        if (args.length === 0) {
            console.log('No arguments provided. Use -h for help.');
            return;
        }

        console.log('Unknown arguments. Use -h for help.');
    }

    /**
     * Show help information
     */
    static #showHelp() {
        console.log(`
Git Management Tool

Usage:
  node Git.js [options]

Options:
  --setup     Complete setup (install gh, authenticate, configure git)
  --auth      Run GitHub authentication only
  --config    Configure git username and email only
  -h, --help  Show this help message

Examples:
  node Git.js --setup    # Complete setup process
  node Git.js --auth     # Only authenticate with GitHub
  node Git.js --config   # Only configure git settings
        `.trim());
    }

    /**
     * Complete setup process
     */
    static async setup() {
        console.log('🚀 Starting Git setup process...\n');
        
        try {
            await this.installGh();
            await this.authenticate();
            await this.configure();
            console.log('\n✅ Git setup completed successfully!');
        } catch (error) {
            console.error('\n❌ Setup failed:', error.message);
            process.exit(1);
        }
    }

    /**
     * Install GitHub CLI via apt (Ubuntu only)
     */
    static async installGh() {
        console.log('📦 Checking system and installing GitHub CLI...');
        
        try {
            // Check if system is Ubuntu
            const osRelease = await this.#execCommand('cat /etc/os-release');
            if (!osRelease.includes('Ubuntu')) {
                console.log('ℹ️  Not Ubuntu system, skipping gh installation');
                return;
            }

            // Check if gh is already installed
            try {
                await this.#execCommand('gh --version');
                console.log('✅ GitHub CLI is already installed');
                return;
            } catch {
                // gh not installed, proceed with installation
            }

            console.log('Installing GitHub CLI...');
            await this.#execCommand('sudo apt update');
            await this.#execCommand('sudo apt install -y gh');
            console.log('✅ GitHub CLI installed successfully');
        } catch (error) {
            throw new Error(`Failed to install GitHub CLI: ${error.message}`);
        }
    }

    /**
     * Authenticate with GitHub using web flow with manual code display
     */
    static async authenticate() {
        console.log('\n🔐 Authenticating with GitHub...');
        
        try {
            // Check if already authenticated
            try {
                await this.#execCommand('gh auth status');
                console.log('✅ Already authenticated with GitHub');
                return;
            } catch {
                // Not authenticated, proceed with login
            }

            console.log('Starting GitHub authentication process...');
            
            // Use the web flow but capture the output to get the device code
            const { spawn } = await import('child_process');
            
            console.log('📋 GitHub Authentication Instructions:');
            console.log('=====================================');
            console.log('1. The system will display a one-time code');
            console.log('2. A browser window will open to GitHub');
            console.log('3. Enter the code when prompted');
            console.log('4. Complete the authentication in your browser');
            console.log('=====================================\n');

            // Start the authentication process
            const authProcess = spawn('gh', ['auth', 'login', '--web', '-h', 'github.com'], {
                stdio: ['pipe', 'pipe', 'pipe']
            });

            let authOutput = '';
            let oneTimeCode = '';

            // Capture stdout to extract the one-time code
            authProcess.stdout.on('data', (data) => {
                const output = data.toString();
                authOutput += output;
                console.log(output);
                
                // Look for the one-time code in the output
                if (output.includes('one-time code:')) {
                    const codeMatch = output.match(/one-time code:\s*([A-Z0-9-]+)/i);
                    if (codeMatch) {
                        oneTimeCode = codeMatch[1];
                        console.log('\n✨ One-time code detected!');
                        console.log(`📋 Your code: ${oneTimeCode}`);
                        console.log('💡 Copy this code and enter it in the browser window that opened.\n');
                    }
                }
            });

            // Capture stderr for error handling
            authProcess.stderr.on('data', (data) => {
                const errorOutput = data.toString();
                console.error('gh auth stderr:', errorOutput);
            });

            // Wait for the process to complete
            const exitCode = await new Promise((resolve, reject) => {
                authProcess.on('close', (code) => {
                    resolve(code);
                });
                
                authProcess.on('error', (error) => {
                    reject(error);
                });
            });

            if (exitCode === 0) {
                console.log('✅ GitHub authentication completed successfully!');
            } else {
                throw new Error(`Authentication process exited with code ${exitCode}`);
            }
            
        } catch (error) {
            console.error('\n❌ Authentication failed:', error.message);
            await this.#fallbackAuthentication();
        }
    }

    /**
     * Fallback authentication method
     */
    static async #fallbackAuthentication() {
        console.log('\n🔄 Trying alternative authentication method...');
        
        try {
            console.log('📋 Manual GitHub Authentication Instructions:');
            console.log('=====================================');
            console.log('1. Run this command in your terminal:');
            console.log('   gh auth login --web -h github.com');
            console.log('2. Copy the one-time code that appears');
            console.log('3. Enter it in the browser window that opens');
            console.log('4. Complete the authentication process');
            console.log('=====================================\n');

            const response = await this.#question('Press Enter after you have completed authentication, or type "skip" to skip: ');
            
            if (response.toLowerCase() !== 'skip') {
                // Verify authentication was successful
                try {
                    await this.#execCommand('gh auth status');
                    console.log('✅ GitHub authentication verified!');
                } catch (verifyError) {
                    console.log('❌ Authentication not completed. You can run this again later with:');
                    console.log('   node Git.js --auth');
                }
            }
        } catch (error) {
            console.error('Fallback authentication failed:', error.message);
        }
    }

    /**
     * Alternative method using token-based authentication
     */
    static async authenticateWithToken() {
        console.log('\n🔐 Token-based GitHub Authentication');
        console.log('=====================================');
        console.log('1. Go to: https://github.com/settings/tokens');
        console.log('2. Generate a new token with appropriate permissions');
        console.log('3. Copy the token and enter it below');
        console.log('=====================================\n');
        
        try {
            const token = await this.#question('Enter your GitHub personal access token: ');
            
            if (!token.trim()) {
                throw new Error('Token is required');
            }

            // Authenticate using the token
            const { spawn } = await import('child_process');
            const authProcess = spawn('gh', ['auth', 'login', '--with-token'], {
                stdio: ['pipe', 'pipe', 'pipe']
            });

            // Send the token to the process
            authProcess.stdin.write(token.trim());
            authProcess.stdin.end();

            // Wait for completion
            const exitCode = await new Promise((resolve, reject) => {
                authProcess.on('close', (code) => {
                    resolve(code);
                });
                
                authProcess.on('error', (error) => {
                    reject(error);
                });
            });

            if (exitCode === 0) {
                console.log('✅ GitHub token authentication completed successfully!');
            } else {
                throw new Error('Token authentication failed');
            }
            
        } catch (error) {
            console.error('Token authentication failed:', error.message);
            console.log('You can try web authentication instead.');
        }
    }

    /**
     * Configure git username and email
     */
    static async configure() {
        console.log('\n⚙️  Configuring Git user settings...');
        
        try {
            const username = await this.#question('Enter your Git username: ');
            const email = await this.#question('Enter your Git email: ');

            if (!username.trim() || !email.trim()) {
                throw new Error('Username and email are required');
            }

            await this.#execCommand(`git config --global user.name "${username.trim()}"`);
            await this.#execCommand(`git config --global user.email "${email.trim()}"`);

            // Verify configuration
            const configuredName = await this.#execCommand('git config --global user.name');
            const configuredEmail = await this.#execCommand('git config --global user.email');

            console.log('✅ Git configuration completed:');
            console.log(`   Name: ${configuredName.trim()}`);
            console.log(`   Email: ${configuredEmail.trim()}`);
        } catch (error) {
            throw new Error(`Git configuration failed: ${error.message}`);
        }
    }

    /**
     * Execute a shell command
     */
    static #execCommand(command, options = {}) {
        return new Promise((resolve, reject) => {
            exec(command, options, (error, stdout, stderr) => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve(stdout);
            });
        });
    }

    /**
     * Ask question to user
     */
    static #question(query) {
        return new Promise((resolve) => {
            this.#rl.question(query, (answer) => {
                resolve(answer);
            });
        });
    }

    /**
     * Close readline interface
     */
    static close() {
        if (this.#rl) {
            this.#rl.close();
        }
    }
}

// Auto-execute if run directly
if (import.meta.url === `file://${process.argv[1]}`) {
    Git.init().then(() => {
        Git.close();
    }).catch((error) => {
        console.error('Error:', error);
        Git.close();
        process.exit(1);
    });
}

export default Git;
