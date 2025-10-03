import { exec, spawn } from 'child_process';

class Clipboard {
  static async copy(text) {
    const platform = process.platform;
    
    try {
      if (platform === 'darwin') {
        await this.executeCommand(`echo "${this.escapeString(text)}" | pbcopy`);
      } else if (platform === 'win32') {
        await this.executePowerShell(`Set-Clipboard -Value "${this.escapeString(text)}"`);
      } else if (platform === 'linux') {
        await this.tryLinuxCopy(text);
      } else {
        throw new Error(`Unsupported platform: ${platform}`);
      }
    } catch (error) {
      throw new Error(`Failed to copy to clipboard: ${error.message}`);
    }
  }

  static async paste() {
    const platform = process.platform;
    
    try {
      if (platform === 'darwin') {
        return await this.executeCommand('pbpaste');
      } else if (platform === 'win32') {
        return await this.executePowerShell('Get-Clipboard');
      } else if (platform === 'linux') {
        return await this.tryLinuxPaste();
      } else {
        throw new Error(`Unsupported platform: ${platform}`);
      }
    } catch (error) {
      throw new Error(`Failed to paste from clipboard: ${error.message}`);
    }
  }

  static executeCommand(command) {
    return new Promise((resolve, reject) => {
      exec(command, (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout.toString().trim());
      });
    });
  }

  static executePowerShell(command) {
    return new Promise((resolve, reject) => {
      const ps = spawn('powershell', ['-Command', command]);
      let stdout = '';
      let stderr = '';

      ps.stdout.on('data', (data) => stdout += data.toString());
      ps.stderr.on('data', (data) => stderr += data.toString());
      
      ps.on('close', (code) => {
        if (code === 0) resolve(stdout.trim());
        else reject(new Error(stderr || `PowerShell exited with code ${code}`));
      });
    });
  }

  static async tryLinuxCopy(text) {
    // Try xclip first, then xsel
    try {
      await this.executeCommand(`echo "${this.escapeString(text)}" | xclip -selection clipboard`);
    } catch (error) {
      await this.executeCommand(`echo "${this.escapeString(text)}" | xsel --clipboard --input`);
    }
  }

  static async tryLinuxPaste() {
    // Try xclip first, then xsel
    try {
      return await this.executeCommand('xclip -selection clipboard -o');
    } catch (error) {
      return await this.executeCommand('xsel --clipboard --output');
    }
  }

  static escapeString(str) {
    return str.replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`');
  }
}

// Usage
async function demo() {
  const textToCopy = 'Hello World! This is from Node.js.';
  
  try {
    console.log('Copying to clipboard...');
    await Clipboard.copy(textToCopy);
    console.log('✓ Successfully copied to clipboard');
    
    console.log('Reading from clipboard...');
    const content = await Clipboard.paste();
    console.log('✓ Clipboard content:', content);
  } catch (error) {
    console.error('✗ Error:', error.message);
  }
}

// Run demo if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  demo();
}

export default Clipboard;
