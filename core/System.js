import os from 'os';
import fs from 'fs';
import childProcess from 'child_process';

//transformar em uma class com um metodo que traz o sistema, e ai utilizar classe como principal operador da interface

/**
 * Detects the operating system with optional Linux distribution detection
 * @param {Object} options - Configuration options
 * @param {boolean} options.detectLinuxDistribution - Whether to detect specific Linux distribution
 * @param {boolean} options.enableLogging - Whether to log execution time in milliseconds
 * @returns {string} The detected operating system
 */
function System(options = {}) {
  const startTime = options.enableLogging ? Date.now() : null;
  
  const {
    detectLinuxDistribution = false,
    enableLogging = false
  } = options;

  const platform = os.platform();
  let result;

  if (platform.startsWith('win')) {
    result = 'windows';
  } else if (platform === 'linux') {
    if (detectLinuxDistribution) {
      try {
        const release = fs.readFileSync('/etc/os-release', 'utf8');
        const ubuntuRegex = /ubuntu/i;
        const centosRegex = /centos/i;
        const debianRegex = /debian/i;
        const fedoraRegex = /fedora/i;

        if (ubuntuRegex.test(release)) {
          result = 'ubuntu';
        } else if (centosRegex.test(release)) {
          result = 'centos';
        } else if (debianRegex.test(release)) {
          result = 'debian';
        } else if (fedoraRegex.test(release)) {
          result = 'fedora';
        } else {
          result = 'unknown linux distribution';
        }
      } catch (error) {
        // Fallback to using lsb-release command (Ubuntu-based distributions only)
        try {
          const lsbRelease = childProcess.spawnSync('lsb_release', ['-a']);
          const output = lsbRelease.stdout.toString();
          const ubuntuRegex = /ubuntu/i;
          const debianRegex = /debian/i;

          if (ubuntuRegex.test(output)) {
            result = 'ubuntu';
          } else if (debianRegex.test(output)) {
            result = 'debian';
          } else {
            result = 'unknown linux distribution';
          }
        } catch (fallbackError) {
          result = 'linux'; // Fallback to generic linux if both methods fail
        }
      }
    } else {
      result = 'linux';
    }
  } else if (platform === 'darwin') {
    result = 'macos';
  } else {
    result = 'unknown';
  }

  // Log execution time if enabled
  if (enableLogging && startTime !== null) {
    const executionTime = Date.now() - startTime;
    console.log(`System detection executed in ${executionTime}ms`);
  }

  return result;
}

// Maintain backward compatibility with the original function signature
System.default = function(detectLinuxDistribution = false) {
  return System({ detectLinuxDistribution });
};

export default System