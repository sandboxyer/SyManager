import { spawn, execSync } from 'child_process';
import { platform } from 'os';

class WslManager {
  static isWindows() {
    return platform() === 'win32';
  }

  static async Run() {
    if (!this.isWindows()) {
      console.log('Not running on Windows, exiting.');
      return;
    }

    // Check if wsl command exists by trying to get distros list
    try {
      const distros = execSync('wsl -l', { encoding: 'utf8' });

      if (/no installed distributions/i.test(distros)) {
        console.log('No WSL distributions found, installing...');
        await this.installWSL();
        return;
      }

      console.log('WSL distributions found, launching interactive shell...');
      await this.launchInteractiveWsl();

    } catch (error) {
      if (error.code === 'ENOENT') {
        // wsl command not found
        console.log('WSL command not found, doing nothing.');
        return;
      }
      // Other errors, try install
      console.log('Error checking WSL:', error.message);
      console.log('Attempting to install WSL...');
      await this.installWSL();
    }
  }

  static installWSL() {
    return new Promise((resolve, reject) => {
      const installProcess = spawn('wsl', ['--install'], { stdio: 'inherit' });

      installProcess.on('close', (code) => {
        if (code === 0) {
          console.log('WSL installed successfully.');
          resolve();
        } else {
          reject(new Error(`WSL install exited with code ${code}`));
        }
      });

      installProcess.on('error', (err) => reject(err));
    });
  }

  static launchInteractiveWsl() {
    return new Promise((resolve, reject) => {
      // Spawn interactive WSL shell inheriting stdio so user can interact
      const wslProcess = spawn('wsl', [], { stdio: 'inherit' });

      wslProcess.on('close', (code) => {
        console.log(`WSL session ended with exit code ${code}. Returning control to Node.js.`);
        // Do NOT exit the Node.js process here
        resolve();
      });

      wslProcess.on('error', (err) => reject(err));
    });
  }
}

export default WslManager