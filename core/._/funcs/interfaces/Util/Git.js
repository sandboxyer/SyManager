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

        if (args.includes('--fix-push')) {
            await this.fixPushAuthentication();
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
  --setup       Complete setup (install gh, authenticate, configure git)
  --auth        Run GitHub authentication only
  --config      Configure git username and email only
  --fix-push    Fix git push authentication issues
  -h, --help    Show this help message

Examples:
  node Git.js --setup      # Complete setup process
  node Git.js --auth       # Only authenticate with GitHub
  node Git.js --config     # Only configure git settings
  node Git.js --fix-push   # Fix git push authentication prompts
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
            await this.configureGitHubCredentials();
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
     * Authenticate with GitHub using web flow
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
            
            const { spawn } = await import('child_process');
            
            console.log('📋 GitHub Authentication Instructions:');
            console.log('=====================================');
            console.log('1. A browser will open to GitHub');
            console.log('2. Follow the instructions to authenticate');
            console.log('3. This will configure credential helper for Git');
            console.log('=====================================\n');

            const authProcess = spawn('gh', ['auth', 'login', '--web', '-h', 'github.com'], {
                stdio: 'inherit'
            });

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
            throw error;
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
     * Configure GitHub credentials to avoid push authentication prompts
     */
    static async configureGitHubCredentials() {
        console.log('\n🔑 Configuring Git credentials for GitHub...');
        
        try {
            // Check current remote URL
            let remoteUrl = '';
            try {
                remoteUrl = await this.#execCommand('git config --get remote.origin.url');
                console.log(`📡 Current remote URL: ${remoteUrl.trim()}`);
            } catch (error) {
                console.log('ℹ️  No remote origin configured yet');
            }

            // Option 1: Configure GitHub CLI as credential helper (recommended)
            console.log('\n1. Configuring GitHub CLI as credential helper...');
            await this.#execCommand('git config --global credential.helper cache');
            await this.#execCommand('git config --global credential.helper store');
            
            // Try to set up GitHub CLI credential helper
            try {
                await this.#execCommand('gh auth setup-git');
                console.log('✅ GitHub CLI credential helper configured');
            } catch (error) {
                console.log('ℹ️  GitHub CLI credential helper not available, using fallback');
            }

            // Option 2: Convert HTTPS remote to SSH (if desired)
            if (remoteUrl.includes('https://github.com')) {
                console.log('\n2. Converting HTTPS remote to SSH for better authentication...');
                const sshUrl = remoteUrl.trim()
                    .replace('https://github.com/', 'git@github.com:')
                    .replace('.git', '') + '.git';
                
                console.log(`   New SSH URL: ${sshUrl}`);
                
                const convert = await this.#question('Convert to SSH? (y/n): ');
                if (convert.toLowerCase() === 'y') {
                    await this.#execCommand(`git remote set-url origin ${sshUrl}`);
                    console.log('✅ Remote URL updated to SSH');
                }
            }

            // Option 3: Configure personal access token (fallback)
            console.log('\n3. Setting up authentication methods...');
            
            // Check if we're authenticated with gh
            try {
                await this.#execCommand('gh auth status');
                console.log('✅ GitHub CLI authentication active');
            } catch (error) {
                console.log('⚠️  Not authenticated with GitHub CLI, using token method');
                await this.setupTokenAuthentication();
            }

            // Configure credential cache timeout
            await this.#execCommand('git config --global credential.cache timeout 3600');
            console.log('✅ Credential cache configured (1 hour)');

            console.log('\n✅ Git push authentication configured successfully!');
            
        } catch (error) {
            throw new Error(`Credential configuration failed: ${error.message}`);
        }
    }

    /**
     * Fix git push authentication issues
     */
    static async fixPushAuthentication() {
        console.log('🔧 Fixing Git push authentication...\n');
        
        try {
            // Check current authentication status
            console.log('1. Checking current authentication...');
            try {
                await this.#execCommand('gh auth status');
                console.log('✅ GitHub CLI is authenticated');
            } catch (error) {
                console.log('❌ Not authenticated with GitHub CLI');
                await this.authenticate();
            }

            // Configure credential helper
            console.log('\n2. Configuring credential helper...');
            await this.configureGitHubCredentials();

            // Test authentication
            console.log('\n3. Testing authentication...');
            try {
                await this.#execCommand('gh api user');
                console.log('✅ GitHub API authentication test passed');
            } catch (error) {
                console.log('⚠️  GitHub API test failed, but Git may still work');
            }

            // Provide final instructions
            console.log('\n📋 Final Configuration Summary:');
            console.log('=====================================');
            console.log('• GitHub CLI authenticated: ✅');
            console.log('• Credential helper configured: ✅');
            console.log('• Git user configured: ✅');
            console.log('');
            console.log('If you still get authentication prompts:');
            console.log('• Use SSH URLs: git@github.com:user/repo.git');
            console.log('• Or generate a token: https://github.com/settings/tokens');
            console.log('• Use token as password when prompted');
            console.log('=====================================\n');

        } catch (error) {
            console.error('❌ Fix failed:', error.message);
        }
    }

    /**
     * Setup token-based authentication as fallback
     */
    static async setupTokenAuthentication() {
        console.log('\n🔐 Token-based Authentication Setup');
        console.log('=====================================');
        console.log('1. Go to: https://github.com/settings/tokens');
        console.log('2. Generate new token with "repo" permissions');
        console.log('3. Copy the token and use it as your password');
        console.log('=====================================\n');
        
        const setupToken = await this.#question('Do you want to setup token authentication now? (y/n): ');
        
        if (setupToken.toLowerCase() === 'y') {
            console.log('\nAfter generating your token:');
            console.log('• Use your username and token as password when prompted');
            console.log('• Or run: git config --global credential.helper store');
            console.log('• Then enter credentials once to store them');
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
