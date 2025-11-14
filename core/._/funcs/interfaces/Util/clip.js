#!/usr/bin/env node

import { execSync } from 'child_process';
import { readFileSync, appendFileSync, existsSync } from 'fs';
import { homedir } from 'os';

class ClipInstaller {
  constructor() {
    this.bashrcPath = `${homedir()}/.bashrc`;
    this.aliasLine = "alias clip='xclip -selection clipboard'";
  }
  
  runCommand(command) {
    try {
      execSync(command, { stdio: 'inherit' });
      return true;
    } catch (error) {
      throw new Error(`Command failed: ${command}\nError: ${error.message}`);
    }
  }
  
  installXclip() {
    if (this.isCommandInstalled('xclip')) {
      console.log('✓ xclip already installed');
      return;
    }
    
    console.log('📦 Installing xclip...');
    this.runCommand('sudo apt install -y xclip');
    console.log('✓ xclip installed successfully');
  }
  
  isCommandInstalled(command) {
    try {
      execSync(`which ${command}`, { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }
  
  aliasExists() {
    if (!existsSync(this.bashrcPath)) return false;
    
    const content = readFileSync(this.bashrcPath, 'utf8');
    return content.includes(this.aliasLine);
  }
  
  addAlias() {
    if (this.aliasExists()) {
      console.log('✓ Clip alias already configured');
      return;
    }
    
    console.log('🔧 Adding clip alias to ~/.bashrc...');
    appendFileSync(this.bashrcPath, `\n${this.aliasLine}\n`);
    console.log('✓ Alias added successfully');
  }
  
  reloadShell() {
    console.log('🔄 Reloading shell configuration...');
    try {
      this.runCommand('exec bash');
    } catch {
      console.log('💡 Please start a new terminal session or run: source ~/.bashrc');
    }
  }
  
  async install() {
    console.log('🎯 Setting up clip command for Ubuntu...\n');
    
    try {
      this.installXclip();
      this.addAlias();
      this.reloadShell();
      
      console.log('\n✅ Installation complete!');
      console.log('🎉 You can now use: clip file.js');
      
    } catch (error) {
      console.error('\n❌ Installation failed:');
      console.error(error.message);
      process.exit(1);
    }
  }
}

// Main execution
if (import.meta.url === `file://${process.argv[1]}`) {
  const installer = new ClipInstaller();
  installer.install();
}

export default ClipInstaller;
