#!/bin/sh

# =============================================================================
# GENERIC INSTALLATION TEMPLATE
# =============================================================================
# CUSTOMIZE THE VARIABLES BELOW FOR YOUR SPECIFIC PROJECT
# =============================================================================

# PROJECT BASIC INFO (REQUIRED)
PROJECT_NAME="SyManager"                    # Change to your project name
PROJECT_DESCRIPTION="General System Manager in AppLevel"      # Brief description

# INSTALLATION PATHS (REQUIRED)
INSTALL_DIR="/usr/local/etc/$PROJECT_NAME"          # Where project will be installed
BIN_DIR="/usr/local/bin"                            # Where command symlinks will be created

# SOURCE PATHS (REQUIRED - adjust to your project structure)
REPO_DIR=$(pwd)                                     # Current repository directory
MAIN_SOURCE_DIR="$REPO_DIR"                         # Root of your project files
# DEB_DIR="$REPO_DIR/deb-packages"                  # Uncomment if using .deb packages
# DEB_SERVER_DIR="$REPO_DIR/deb-packages-server"    # Uncomment for server-specific debs
# ARCHIVE_DIR="$REPO_DIR/archives"                  # Uncomment if using archives like pm2

# NODE.JS COMMAND MAPPING (REQUIRED - define your commands)
# Using space-separated lists for ash compatibility (no associative arrays)
NODE_ENTRY_POINTS_SRC="SyManager.js ._/SyPM.js ._/SyDB.js pkg-cli.js"
NODE_ENTRY_POINTS_CMD="sy sypm sydb pkg"

# COMMAND WORKING DIRECTORY CONFIGURATION
# Set to "caller" to use the directory where command was called from
# Set to "global" to use the installation directory (default)
# Using case statements for ash compatibility
get_command_working_dir() {
    command="$1"
    case "$command" in
        "sy") echo "global" ;;
        "sypm") echo "caller" ;;
        "sydb") echo "global" ;;
        "pkg") echo "caller" ;;
        *) echo "global" ;;
    esac
}

# PRESERVATION WHITELIST (OPTIONAL - files to keep during updates)
PRESERVATION_WHITELIST=""
# To add files/directories, use space-separated list:
# PRESERVATION_WHITELIST="config data models user-settings.json"

# =============================================================================
# ADVANCED CONFIGURATION (Usually don't need changes)
# =============================================================================

# Installation options (set via command line flags)
BACKUP_DIR="/usr/local/etc/${PROJECT_NAME}_old_$(date +%s)"
LOG_FILE="/var/log/${PROJECT_NAME}-install.log"
LOG_MODE=false
SKIP_DEBS=false
LOCAL_DIR_MODE=false
PRESERVE_DATA=true

# External dependencies (uncomment and configure if needed)
# PM2_TAR_GZ="$ARCHIVE_DIR/pm2.tar.gz"              # Uncomment if using pm2
# PM2_EXTRACT_DIR="$INSTALL_DIR/vendor/pm2"         # Uncomment if using pm2

# =============================================================================
# FUNCTION DEFINITIONS (Ash-compatible versions)
# =============================================================================

show_help() {
    echo "Usage: $0 [OPTIONS]"
    echo "Install $PROJECT_NAME - $PROJECT_DESCRIPTION"
    echo
    echo "Options:"
    echo "  -h, --help       Show this help"
    echo "  -log             Enable installation logging"
    echo "  --skip-debs      Skip .deb package installation"
    echo "  --local-dir      Run commands from current directory"
    echo "  --no-preserve    Don't preserve files during update"
    echo
    echo "Commands will be created for:"
    for cmd in $NODE_ENTRY_POINTS_CMD; do
        echo "  $cmd"
    done
    echo
    echo "Working directory configuration:"
    for cmd in $NODE_ENTRY_POINTS_CMD; do
        working_dir=$(get_command_working_dir "$cmd")
        echo "  $cmd: $working_dir"
    done
    echo
    echo "Generic pkg command features:"
    echo "  pkg run <script>          Run npm script from any package.json"
    echo "  pkg version <type|ver>    Update version (major|minor|patch|X.Y.Z) and git commit"
    exit 0
}

detect_ubuntu_variant() {
    if command -v dpkg >/dev/null 2>&1 && dpkg -l 2>/dev/null | grep -q ubuntu-desktop; then
        echo "desktop"
    else
        echo "server"
    fi
}

log_message() {
    message="$1"
    timestamp=$(date '+%Y-%m-%d %H:%M:%S')
    
    if [ "$LOG_MODE" = true ]; then
        echo "[$timestamp] $message" | tee -a "$LOG_FILE"
    else
        echo "[$timestamp] $message"
    fi
}

show_progress() {
    message="$1"
    pid="$2"
    
    # Simple progress indicator without fancy input
    if [ -t 0 ]; then
        while kill -0 $pid 2>/dev/null; do
            printf "%s...\r" "$message"
            sleep 1
        done
        wait $pid 2>/dev/null || true
        printf "\n%s completed.\n" "$message"
    else
        wait $pid 2>/dev/null || true
        printf "%s completed.\n" "$message"
    fi
}

install_debs() {
    [ "$SKIP_DEBS" = true ] && return 0
    [ -z "$DEB_DIR" ] && return 0

    variant=$(detect_ubuntu_variant)
    deb_dir="$DEB_DIR"
    
    [ "$variant" = "server" ] && [ -n "$DEB_SERVER_DIR" ] && deb_dir="$DEB_SERVER_DIR"
    [ ! -d "$deb_dir" ] && return 0

    # Find .deb files
    deb_files=""
    for file in "$deb_dir"/*.deb; do
        [ -e "$file" ] && deb_files="$deb_files $file"
    done
    
    [ -z "$deb_files" ] && return 0

    log_message "Installing .deb packages..."
    if [ "$LOG_MODE" = true ]; then
        sudo dpkg -i $deb_files 2>&1 | tee -a "$LOG_FILE" &
    else
        sudo dpkg -i $deb_files > /dev/null 2>&1 &
    fi
    
    show_progress "Installing packages" $!
    return $?
}

copy_files() {
    src_dir="$1"
    dest_dir="$2"

    mkdir -p "$dest_dir"
    log_message "Copying files to $dest_dir..."

    # Create a simple copy function without rsync
    copy_with_progress() {
        # Count total files for progress (approx)
        total_files=0
        if [ -d "$src_dir" ]; then
            # Simple file count - won't work perfectly for complex structures but good enough
            total_files=$(find "$src_dir" -type f -not -path '*/\.git/*' | wc -l)
        fi
        
        # Copy files recursively
        if [ "$LOG_MODE" = true ]; then
            (cd "$src_dir" && find . -type f -not -path '*/\.git/*' -exec cp --parents {} "$dest_dir" \; 2>&1 | tee -a "$LOG_FILE") &
        else
            (cd "$src_dir" && find . -type f -not -path '*/\.git/*' -exec cp --parents {} "$dest_dir" \; > /dev/null 2>&1) &
        fi
        
        echo $!
    }
    
    pid=$(copy_with_progress)
    show_progress "Copying files" $pid
    return $?
}

remove_links() {
    # Convert space-separated list to lines for processing
    echo "$NODE_ENTRY_POINTS_CMD" | tr ' ' '\n' | while read cmd; do
        [ -z "$cmd" ] && continue
        dest_path="$BIN_DIR/$cmd"
        [ -L "$dest_path" ] && rm -f "$dest_path"
    done
}

preserve_files_from_backup() {
    [ "$PRESERVE_DATA" = false ] && return 0
    [ ! -d "$BACKUP_DIR" ] && return 0

    log_message "Restoring preserved files..."
    for item in $PRESERVATION_WHITELIST; do
        source_path="$BACKUP_DIR/$item"
        dest_path="$INSTALL_DIR/$item"
        
        if [ -e "$source_path" ]; then
            mkdir -p "$(dirname "$dest_path")"
            [ -e "$dest_path" ] && rm -rf "$dest_path"
            mv -f "$source_path" "$dest_path" 2>/dev/null || true
        fi
    done
    
    rm -rf "$BACKUP_DIR"
}

extract_archive() {
    archive_file="$1"
    extract_dir="$2"
    
    [ ! -f "$archive_file" ] && return 0

    log_message "Extracting $(basename $archive_file)..."
    mkdir -p "$extract_dir"
    tar -xzf "$archive_file" -C "$extract_dir" --strip-components=1 2>/dev/null
}

create_pkg_cli() {
    install_dir="$1"
    pkg_cli_path="$install_dir/pkg-cli.js"
    
    log_message "Creating generic pkg CLI utility with ES modules..."
    
    # Always remove existing pkg-cli.js to ensure fresh creation
    if [ -f "$pkg_cli_path" ]; then
        rm -f "$pkg_cli_path"
    fi
    
    # Create the generic pkg CLI JavaScript file with ES module syntax
    cat > "$pkg_cli_path" << 'PKG_EOF'
#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { execSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';

// Get the caller's current working directory
const callerCwd = process.cwd();
const packageJsonPath = path.join(callerCwd, 'package.json');

function readPackageJson() {
  try {
    const content = fs.readFileSync(packageJsonPath, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    console.error(`Error reading package.json: ${error.message}`);
    console.error(`Make sure you're in a project directory with a package.json file`);
    process.exit(1);
  }
}

async function runScript(scriptName, ...scriptArgs) {
  const packageJson = readPackageJson();
  
  if (!packageJson.scripts || !packageJson.scripts[scriptName]) {
    console.error(`Script "${scriptName}" not found in package.json`);
    console.error(`Available scripts: ${Object.keys(packageJson.scripts || {}).join(', ') || 'None'}`);
    process.exit(1);
  }
  
  const command = packageJson.scripts[scriptName];
  
  // Check if the script uses npm run or similar pattern
  let fullCommand;
  if (command.startsWith('npm ') || command.startsWith('yarn ') || command.startsWith('pnpm ')) {
    // For npm/yarn/pnpm commands, append our args
    fullCommand = `${command} ${scriptArgs.join(' ')}`.trim();
  } else {
    // For other commands, pass args directly
    fullCommand = `${command} ${scriptArgs.join(' ')}`.trim();
  }
  
  console.log(`Running: ${fullCommand}`);
  
  try {
    // Use spawn to preserve colors and real-time output
    const child = spawn(fullCommand, {
      shell: true,
      stdio: 'inherit',
      cwd: callerCwd
    });
    
    return new Promise((resolve, reject) => {
      child.on('close', (code) => {
        process.exit(code);
      });
      
      child.on('error', (error) => {
        console.error(`Error running script: ${error.message}`);
        process.exit(1);
      });
    });
  } catch (error) {
    console.error(`Error running script: ${error.message}`);
    process.exit(1);
  }
}

function bumpVersion(bumpType) {
  const packageJson = readPackageJson();
  const currentVersion = packageJson.version || '0.0.0';
  
  // Parse current version
  const versionParts = currentVersion.split('.');
  if (versionParts.length < 3) {
    console.error(`Invalid current version format: ${currentVersion}`);
    console.error('Expected format: major.minor.patch');
    process.exit(1);
  }
  
  let major = parseInt(versionParts[0]) || 0;
  let minor = parseInt(versionParts[1]) || 0;
  let patch = parseInt(versionParts[2]) || 0;
  
  // Handle prerelease versions
  const prereleaseMatch = versionParts[2].match(/^(\d+)(-.+)?$/);
  if (prereleaseMatch) {
    patch = parseInt(prereleaseMatch[1]) || 0;
  }
  
  // Bump version based on type
  let newVersion;
  switch (bumpType) {
    case 'major':
      major += 1;
      minor = 0;
      patch = 0;
      newVersion = `${major}.${minor}.${patch}`;
      break;
      
    case 'minor':
      minor += 1;
      patch = 0;
      newVersion = `${major}.${minor}.${patch}`;
      break;
      
    case 'patch':
      patch += 1;
      newVersion = `${major}.${minor}.${patch}`;
      break;
      
    default:
      // Assume it's a direct version string
      const versionRegex = /^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$/;
      if (!versionRegex.test(bumpType)) {
        console.error(`Invalid version: ${bumpType}`);
        console.error('Use: major, minor, patch, or X.Y.Z format');
        process.exit(1);
      }
      newVersion = bumpType;
  }
  
  return updateVersion(currentVersion, newVersion);
}

async function updateVersion(oldVersion, newVersion) {
  const packageJson = readPackageJson();
  packageJson.version = newVersion;
  
  try {
    // Update package.json
    fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2));
    
    // Git operations
    try {
      // Check if we're in a git repository
      execSync('git rev-parse --is-inside-work-tree', { cwd: callerCwd, stdio: 'ignore' });
      
      // Add package.json to git
      execSync('git add package.json', { cwd: callerCwd, stdio: 'pipe' });
      
      // Create commit
      const commitMessage = `${newVersion}`;
      execSync(`git commit -m "${commitMessage}"`, { cwd: callerCwd, stdio: 'pipe' });
      
      console.log(`${commitMessage}`);
      
      execSync(`git tag -a v${newVersion} -m "Version ${newVersion}"`, { 
        cwd: callerCwd, 
        stdio: 'pipe' 
      });
      //console.log(`Created git tag: v${newVersion}`);
           
    } catch (gitError) {
      console.log('Not a git repository or git not available. Skipping git operations.');
    }
    
  } catch (error) {
    console.error(`Error updating version: ${error.message}`);
    process.exit(1);
  }
}

function showHelp() {
  console.log(`
pkg - Generic package.json utility

Usage: pkg <command> [options]

Commands:
  run <script> [args...]  Run any script from package.json with arguments
  version <type|ver>      Update version and create git commit
  
Arguments:
  For 'run' command:
    <script>              Script name from package.json scripts section
    [args...]            Arguments to pass to the script
  
  For 'version' command:
    major                 Bump major version (X+1.0.0)
    minor                 Bump minor version (X.Y+1.0)
    patch                 Bump patch version (X.Y.Z+1)
    <X.Y.Z>               Set specific version (e.g., 1.2.3)
    <X.Y.Z-prerelease>    Set version with prerelease tag

Examples:
  pkg run test            Run the 'test' script from package.json
  pkg run build           Run the 'build' script from package.json
  pkg run dev --port 3000 Run 'dev' script with --port argument
  pkg run test --watch    Run 'test' script with --watch argument
  pkg version patch       Bump patch version (1.2.3 -> 1.2.4)
  pkg version minor       Bump minor version (1.2.3 -> 1.3.0)
  pkg version major       Bump major version (1.2.3 -> 2.0.0)
  pkg version 2.1.0       Set version to 2.1.0
  pkg version 1.0.0-beta.1  Set version to 1.0.0-beta.1

Working directory: ${callerCwd}
  `);
}

// Main CLI logic
async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    showHelp();
    process.exit(0);
  }
  
  const command = args[0];
  
  switch (command) {
      case 'run':
      if (args.length < 2) {
        console.error('Usage: pkg run <script-name> [script-args...]');
        process.exit(1);
      }
      await runScript(args[1], ...args.slice(2));
      break;
      
    case 'version':
      if (args.length < 2) {
        console.error('Usage: pkg version <type|version>');
        console.error('Type: major, minor, patch, or specific version X.Y.Z');
        process.exit(1);
      }
      await bumpVersion(args[1]);
      break;
      
    case 'help':
    case '--help':
    case '-h':
      showHelp();
      break;
      
    default:
      console.error(`Unknown command: ${command}`);
      console.error('Use "pkg help" for usage information');
      process.exit(1);
  }
}

// Run the CLI
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`Unhandled error: ${error.message}`);
    process.exit(1);
  });
}
PKG_EOF
    
    chmod +x "$pkg_cli_path"
    log_message "Created generic pkg CLI utility at $pkg_cli_path"
}

create_command_links() {
    install_dir="$1"
    
    # Create pkg CLI in the installation directory
    create_pkg_cli "$install_dir"
    
    # Create arrays from space-separated lists
    src_list="$NODE_ENTRY_POINTS_SRC"
    cmd_list="$NODE_ENTRY_POINTS_CMD"
    
    # Process each command
    idx=1
    for src in $src_list; do
        # Get corresponding command name
        command_name=$(echo "$cmd_list" | tr ' ' '\n' | sed -n "${idx}p")
        [ -z "$command_name" ] && continue
        
        src_path="$install_dir/$src"
        dest_path="$BIN_DIR/$command_name"
        working_dir=$(get_command_working_dir "$command_name")
        
        # Ensure source file exists
        if [ ! -f "$src_path" ]; then
            log_message "Warning: Source file not found: $src_path"
            idx=$((idx + 1))
            continue
        fi
        
        chmod +x "$src_path" 2>/dev/null || true
        
        if [ "$LOCAL_DIR_MODE" = true ]; then
            [ -L "$dest_path" ] && rm -f "$dest_path"
            ln -sf "$src_path" "$dest_path"
        else
            wrapper_path="$install_dir/wrappers/$command_name"
            mkdir -p "$(dirname "$wrapper_path")"
            
            # Create wrapper based on working directory configuration
            if [ "$working_dir" = "caller" ]; then
                # Use caller's current directory
                cat > "$wrapper_path" <<EOF
#!/bin/sh
# Working directory: caller's current directory
exec node "$src_path" "\$@"
EOF
            else
                # Use global installation directory (default)
                cat > "$wrapper_path" <<EOF
#!/bin/sh
cd "$install_dir" || exit 1
exec node "$src_path" "\$@"
EOF
            fi
            
            chmod +x "$wrapper_path"
            [ -L "$dest_path" ] && rm -f "$dest_path"
            ln -sf "$wrapper_path" "$dest_path"
            
            log_message "Created command '$command_name' with working directory: $working_dir"
        fi
        
        idx=$((idx + 1))
    done
}

cleanup() {
    sudo dpkg --configure -a > /dev/null 2>&1 || true
}

interrupt_handler() {
    log_message "Installation interrupted. Cleaning up..."
    cleanup
    exit 1
}

# =============================================================================
# MAIN EXECUTION
# =============================================================================

trap interrupt_handler INT TERM

# Parse command line arguments
for arg in "$@"; do
    case "$arg" in
        -h|--help) show_help ;;
        -log) LOG_MODE=true; touch "$LOG_FILE" 2>/dev/null || true ;;
        --skip-debs) SKIP_DEBS=true ;;
        --local-dir) LOCAL_DIR_MODE=true ;;
        --no-preserve) PRESERVE_DATA=false ;;
    esac
done

log_message "Starting $PROJECT_NAME installation..."

if [ -d "$INSTALL_DIR" ]; then
    log_message "Existing installation found."
    printf "Choose: 1=Update, 2=Remove, 3=Exit\n"
    printf "Enter choice: "
    read choice
    case "$choice" in
        1) 
            # Always remove old pkg-cli.js during update to ensure fresh creation
            if [ -f "$INSTALL_DIR/pkg-cli.js" ]; then
                rm -f "$INSTALL_DIR/pkg-cli.js"
            fi
            mv -f "$INSTALL_DIR" "$BACKUP_DIR"
            remove_links 
            ;;
        2) remove_links; rm -rf "$INSTALL_DIR"; exit 0 ;;
        3) exit 0 ;;
        *) exit 1 ;;
    esac
fi

# Main installation steps
install_debs
mkdir -p "$INSTALL_DIR"
copy_files "$MAIN_SOURCE_DIR" "$INSTALL_DIR"
preserve_files_from_backup

# Extract archives if configured
[ -n "$PM2_TAR_GZ" ] && extract_archive "$PM2_TAR_GZ" "$PM2_EXTRACT_DIR"

create_command_links "$INSTALL_DIR"
cleanup

log_message "$PROJECT_NAME installation completed!"

printf "\n"
echo "Available commands:"
for cmd in $NODE_ENTRY_POINTS_CMD; do
    echo "  $cmd"
done

printf "\n"
echo "Working directory configuration:"
for cmd in $NODE_ENTRY_POINTS_CMD; do
    working_dir=$(get_command_working_dir "$cmd")
    echo "  $cmd: $working_dir"
done

printf "\n"
echo "Generic pkg command features:"
echo "  pkg run <script> [args...]   - Run any script from package.json with arguments"
echo "  pkg version <type|ver>       - Update version and create git commit"
printf "\n"
echo "pkg version supports:"
echo "  • patch    - Bump patch version (1.2.3 → 1.2.4)"
echo "  • minor    - Bump minor version (1.2.3 → 1.3.0)"
echo "  • major    - Bump major version (1.2.3 → 2.0.0)"
echo "  • X.Y.Z    - Set specific version"
echo "  • X.Y.Z-prerelease - Set version with prerelease tag"
printf "\n"
echo "Examples:"
echo "  pkg run test                    # Runs 'test' script from package.json"
echo "  pkg run build                   # Runs 'build' script from package.json"
echo "  pkg run dev --port 3000         # Runs 'dev' script with --port argument"
echo "  pkg run test --watch --verbose  # Runs 'test' script with multiple args"
echo "  pkg version patch               # Bumps patch version and commits"
echo "  pkg version 1.2.3               # Sets version to 1.2.3 and commits"
printf "\n"
echo "Note: pkg works from any directory with a package.json file"

printf "\n"
if [ "$LOCAL_DIR_MODE" = true ]; then
    echo "Commands run from current directory"
else
    echo "Installation directory: $INSTALL_DIR"
    echo "Node.js processes start in configured working directories (see above)"
fi