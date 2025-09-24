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
            await this.#execCommand('sudo apt install -y gh');
            console.log('✅ GitHub CLI installed successfully');
        } catch (error) {
            throw new Error(`Failed to install GitHub CLI: ${error.message}`);
        }
    }

    /**
     * Authenticate with GitHub CLI
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

            console.log('Please complete the GitHub authentication in your browser...');
            
            // Use device flow for authentication (non-interactive)
            await this.#execCommand('gh auth login --web -h github.com', { 
                stdio: 'inherit' 
            });
            
            console.log('✅ GitHub authentication completed');
        } catch (error) {
            throw new Error(`GitHub authentication failed: ${error.message}`);
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
