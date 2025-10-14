#!/bin/bash

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
declare -A NODE_ENTRY_POINTS=(
  # Format: ["path/to/your/file.js"]="command-name"
  # Example: ["src/cli/main.js"]="myapp"
  # Add your specific entry points below:
  ["core/HUD/HUD.js"]="sy"
  ["core/SyPM.js"]="sypm"
  # ["vendor/pm2/bin/pm2"]="pm2"                    # Uncomment if using pm2
)

# COMMAND WORKING DIRECTORY CONFIGURATION
# Set to "caller" to use the directory where command was called from
# Set to "global" to use the installation directory (default)
declare -A COMMAND_WORKING_DIR=(
  # Format: ["command-name"]="caller|global"
  # Default behavior is "global" if not specified
  ["sy"]="global"           # Uses installation directory
  ["sypm"]="caller"         # Uses caller's current directory
)

# PRESERVATION WHITELIST (OPTIONAL - files to keep during updates)
declare -a PRESERVATION_WHITELIST=(
  # Add files/directories to preserve during updates:
  # "config"
  # "data"
  # "models"
  # "user-settings.json"
)

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
# FUNCTION DEFINITIONS (No changes needed normally)
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
  for dest in "${NODE_ENTRY_POINTS[@]}"; do
    echo "  $dest"
  done
  echo
  echo "Working directory configuration:"
  for command in "${!COMMAND_WORKING_DIR[@]}"; do
    echo "  $command: ${COMMAND_WORKING_DIR[$command]}"
  done
  exit 0
}

detect_ubuntu_variant() {
  if command -v dpkg >/dev/null 2>&1 && dpkg -l | grep -q ubuntu-desktop; then
    echo "desktop"
  else
    echo "server"
  fi
}

log_message() {
  local message="$1"
  local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
  
  if [[ "$LOG_MODE" == true ]]; then
    echo "[$timestamp] $message" | tee -a "$LOG_FILE"
  else
    echo "[$timestamp] $message"
  fi
}

show_progress() {
  local message="$1"
  local pid="$2"
  
  while kill -0 $pid 2>/dev/null; do
    echo -ne "$message (press 'x' to skip)\r"
    read -t 1 -n 1 -s input || true
    if [[ $input == "x" ]]; then
      echo -e "\nSkipping step..."
      kill $pid 2>/dev/null
      break
    fi
  done
  wait $pid 2>/dev/null
  echo -e "\n$message completed."
}

install_debs() {
  [[ "$SKIP_DEBS" == true ]] && return 0
  [[ -z "$DEB_DIR" ]] && return 0

  local variant=$(detect_ubuntu_variant)
  local deb_dir="$DEB_DIR"
  
  [[ "$variant" == "server" && -n "$DEB_SERVER_DIR" ]] && deb_dir="$DEB_SERVER_DIR"
  [[ ! -d "$deb_dir" ]] && return 0

  local deb_files=("$deb_dir"/*.deb)
  [[ ${#deb_files[@]} -eq 0 ]] && return 0

  log_message "Installing .deb packages..."
  if [[ "$LOG_MODE" == true ]]; then
    sudo dpkg -i "${deb_files[@]}" 2>&1 | tee -a "$LOG_FILE" &
  else
    sudo dpkg -i "${deb_files[@]}" > /dev/null 2>&1 &
  fi
  
  show_progress "Installing packages" $!
  return $?
}

copy_files() {
  local src_dir="$1"
  local dest_dir="$2"

  mkdir -p "$dest_dir"
  log_message "Copying files to $dest_dir..."

  if [[ "$LOG_MODE" == true ]]; then
    rsync -a --info=progress2 --exclude=".git" "$src_dir/" "$dest_dir" 2>&1 | tee -a "$LOG_FILE" &
  else
    rsync -a --info=progress2 --exclude=".git" "$src_dir/" "$dest_dir" > /dev/null 2>&1 &
  fi

  show_progress "Copying files" $!
  return $?
}

remove_links() {
  for dest in "${NODE_ENTRY_POINTS[@]}"; do
    local dest_path="$BIN_DIR/$dest"
    [[ -L "$dest_path" ]] && rm -f "$dest_path"
  done
}

preserve_files_from_backup() {
  [[ "$PRESERVE_DATA" == false ]] && return 0
  [[ ! -d "$BACKUP_DIR" ]] && return 0

  log_message "Restoring preserved files..."
  for item in "${PRESERVATION_WHITELIST[@]}"; do
    local source_path="$BACKUP_DIR/$item"
    local dest_path="$INSTALL_DIR/$item"
    
    if [[ -e "$source_path" ]]; then
      mkdir -p "$(dirname "$dest_path")"
      [[ -e "$dest_path" ]] && rm -rf "$dest_path"
      mv -f "$source_path" "$dest_path" 2>/dev/null || true
    fi
  done
  
  rm -rf "$BACKUP_DIR"
}

extract_archive() {
  local archive_file="$1"
  local extract_dir="$2"
  
  [[ ! -f "$archive_file" ]] && return 0

  log_message "Extracting $(basename $archive_file)..."
  mkdir -p "$extract_dir"
  tar -xzf "$archive_file" -C "$extract_dir" --strip-components=1 2>/dev/null
}

create_command_links() {
  local install_dir="$1"
  
  for src in "${!NODE_ENTRY_POINTS[@]}"; do
    local src_path="$install_dir/$src"
    local command_name="${NODE_ENTRY_POINTS[$src]}"
    local dest_path="$BIN_DIR/$command_name"
    local working_dir="${COMMAND_WORKING_DIR[$command_name]:-global}"
    
    [[ ! -f "$src_path" ]] && continue
    chmod +x "$src_path" 2>/dev/null || true
    
    if [[ "$LOCAL_DIR_MODE" == true ]]; then
      [[ -L "$dest_path" ]] && rm -f "$dest_path"
      ln -sf "$src_path" "$dest_path"
    else
      local wrapper_path="$install_dir/wrappers/$command_name"
      mkdir -p "$(dirname "$wrapper_path")"
      
      # Create wrapper based on working directory configuration
      if [[ "$working_dir" == "caller" ]]; then
        # Use caller's current directory
        cat > "$wrapper_path" <<EOF
#!/bin/bash
# Working directory: caller's current directory
exec node "$src_path" "\$@"
EOF
      else
        # Use global installation directory (default)
        cat > "$wrapper_path" <<EOF
#!/bin/bash
cd "$install_dir" || exit 1
exec node "$src_path" "\$@"
EOF
      fi
      
      chmod +x "$wrapper_path"
      [[ -L "$dest_path" ]] && rm -f "$dest_path"
      ln -sf "$wrapper_path" "$dest_path"
      
      log_message "Created command '$command_name' with working directory: $working_dir"
    fi
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

for arg in "$@"; do
  case "$arg" in
    -h|--help) show_help ;;
    -log) LOG_MODE=true; touch "$LOG_FILE" ;;
    --skip-debs) SKIP_DEBS=true ;;
    --local-dir) LOCAL_DIR_MODE=true ;;
    --no-preserve) PRESERVE_DATA=false ;;
  esac
done

log_message "Starting $PROJECT_NAME installation..."

if [[ -d "$INSTALL_DIR" ]]; then
  log_message "Existing installation found."
  echo "Choose: 1=Update, 2=Remove, 3=Exit"
  read -p "Enter choice: " choice
  case "$choice" in
    1) mv -f "$INSTALL_DIR" "$BACKUP_DIR"; remove_links ;;
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
[[ -n "$PM2_TAR_GZ" ]] && extract_archive "$PM2_TAR_GZ" "$PM2_EXTRACT_DIR"

create_command_links "$INSTALL_DIR"
cleanup

log_message "$PROJECT_NAME installation completed!"

echo
echo "Available commands:"
for command in "${NODE_ENTRY_POINTS[@]}"; do
  echo "  $command"
done

echo
echo "Working directory configuration:"
for command in "${NODE_ENTRY_POINTS[@]}"; do
  local working_dir="${COMMAND_WORKING_DIR[$command]:-global}"
  echo "  $command: $working_dir"
done

echo
if [[ "$LOCAL_DIR_MODE" == true ]]; then
  echo "Commands run from current directory"
else
  echo "Installation directory: $INSTALL_DIR"
  echo "Node.js processes start in configured working directories (see above)"
fi
