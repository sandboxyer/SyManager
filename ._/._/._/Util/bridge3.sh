#!/bin/bash
# UNIVERSAL QEMU Bridge Setup
# Works on: Ubuntu, Alpine, WSL (with limitations), Debian

set -e  # Stop on errors

# Color codes for better output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Function to print colored messages
print_status() {
    echo -e "${GREEN}[✓]${NC} $1"
}
print_error() {
    echo -e "${RED}[✗]${NC} $1"
}
print_warning() {
    echo -e "${YELLOW}[!]${NC} $1"
}

# Detect environment
detect_environment() {
    print_status "Detecting environment..."
    
    # Check for WSL
    if grep -qi microsoft /proc/version 2>/dev/null || grep -qi wsl /proc/version 2>/dev/null; then
        ENV="wsl"
        print_warning "WSL detected - Bridge mode requires Windows Hyper-V switch"
        print_warning "Will use user-mode networking (SLIRP) instead"
        USE_BRIDGE=false
        return
    fi
    
    # Check for Alpine
    if [ -f /etc/alpine-release ]; then
        ENV="alpine"
        USE_BRIDGE=true
        print_status "Alpine Linux detected"
        return
    fi
    
    # Check for Ubuntu/Debian
    if [ -f /etc/debian_version ] || grep -qi "ubuntu" /etc/os-release 2>/dev/null; then
        ENV="debian"
        USE_BRIDGE=true
        print_status "Ubuntu/Debian detected"
        return
    fi
    
    ENV="unknown"
    USE_BRIDGE=false
    print_warning "Unknown environment - using fallback networking"
}

# Install packages based on distro
install_packages() {
    print_status "Installing required packages..."
    
    case $ENV in
        alpine)
            apk update
            apk add qemu-system-x86_64 qemu-modules bridge-utils
            QEMU_BRIDGE_HELPER="/usr/libexec/qemu-bridge-helper"
            ;;
        debian)
            apt-get update
            apt-get install -y qemu-system-x86 bridge-utils uml-utilities
            QEMU_BRIDGE_HELPER="/usr/lib/qemu/qemu-bridge-helper"
            ;;
        wsl)
            # No installation needed for WSL
            QEMU_BRIDGE_HELPER=""
            ;;
    esac
}

# Create bridge interface (only if not WSL)
create_bridge() {
    if [ "$USE_BRIDGE" = false ]; then
        print_warning "Skipping bridge creation (WSL or unsupported environment)"
        return
    fi
    
    print_status "Creating bridge interface..."
    
    BRIDGE_NAME="br0"
    
    # Check if bridge already exists
    if ip link show "$BRIDGE_NAME" 2>/dev/null | grep -q "UP"; then
        print_status "Bridge $BRIDGE_NAME already exists"
        return
    fi
    
    # Create bridge
    sudo ip link add name "$BRIDGE_NAME" type bridge
    sudo ip link set "$BRIDGE_NAME" up
    
    # Assign IP address to bridge
    sudo ip addr add 192.168.100.1/24 dev "$BRIDGE_NAME"
    
    # Enable IP forwarding for NAT (optional)
    echo 1 | sudo tee /proc/sys/net/ipv4/ip_forward > /dev/null
    
    # Setup NAT with iptables (if available)
    if command -v iptables >/dev/null 2>&1; then
        sudo iptables -t nat -A POSTROUTING -s 192.168.100.0/24 -j MASQUERADE
        sudo iptables -A FORWARD -i "$BRIDGE_NAME" -j ACCEPT
        sudo iptables -A FORWARD -o "$BRIDGE_NAME" -j ACCEPT
    fi
    
    print_status "Bridge $BRIDGE_NAME created with IP 192.168.100.1"
}

# Configure bridge permissions
configure_bridge_permissions() {
    if [ "$USE_BRIDGE" = false ]; then
        return
    fi
    
    print_status "Configuring bridge permissions..."
    
    # Create qemu bridge configuration directory
    sudo mkdir -p /etc/qemu
    
    # Allow our bridge
    echo "allow br0" | sudo tee /etc/qemu/bridge.conf > /dev/null
    
    # Set proper permissions
    sudo chmod 644 /etc/qemu/bridge.conf
    
    # Check if qemu-bridge-helper exists
    if [ -n "$QEMU_BRIDGE_HELPER" ] && [ -f "$QEMU_BRIDGE_HELPER" ]; then
        # Make sure it's executable by root only (security)
        sudo chown root:root "$QEMU_BRIDGE_HELPER"
        sudo chmod 4750 "$QEMU_BRIDGE_HELPER"
        print_status "QEMU bridge helper configured"
    else
        print_warning "QEMU bridge helper not found - bridge mode may not work"
    fi
}

# Display how to start QEMU
show_qemu_commands() {
    echo ""
    echo "═══════════════════════════════════════════════════════════"
    echo "HOW TO START YOUR VM"
    echo "═══════════════════════════════════════════════════════════"
    
    if [ "$USE_BRIDGE" = true ]; then
        echo "✅ BRIDGE MODE (VM gets IP on your network):"
        echo ""
        echo "qemu-system-x86_64 \\"
        echo "  -m 2048 \\"
        echo "  -smp 2 \\"
        echo "  -drive file=/path/to/your/vm.qcow2,format=qcow2 \\"
        echo "  -enable-kvm \\"
        echo "  -netdev bridge,id=net0,br=br0 \\"
        echo "  -device virtio-net-pci,netdev=net0"
        echo ""
        
        echo "✅ USER-MODE NETWORKING (Simple, no config needed):"
        echo ""
        echo "qemu-system-x86_64 \\"
        echo "  -m 2048 \\"
        echo "  -smp 2 \\"
        echo "  -drive file=/path/to/your/vm.qcow2,format=qcow2 \\"
        echo "  -enable-kvm \\"
        echo "  -netdev user,id=net0,hostfwd=tcp::2222-:22 \\"
        echo "  -device virtio-net-pci,netdev=net0"
        echo ""
        echo "  Then SSH with: ssh -p 2222 user@localhost"
        
    else
        echo "⚠️  WSL MODE (User-mode networking only):"
        echo ""
        echo "qemu-system-x86_64 \\"
        echo "  -m 2048 \\"
        echo "  -smp 2 \\"
        echo "  -drive file=/path/to/your/vm.qcow2,format=qcow2 \\"
        echo "  -netdev user,id=net0,hostfwd=tcp::2222-:22 \\"
        echo "  -device virtio-net-pci,netdev=net0"
        echo ""
        echo "  Then SSH with: ssh -p 2222 user@localhost"
    fi
    
    echo ""
    echo "═══════════════════════════════════════════════════════════"
    echo "TROUBLESHOOTING"
    echo "═══════════════════════════════════════════════════════════"
    echo "Check bridge status:    ip link show type bridge"
    echo "Check interfaces:       ip addr show"
    echo "Check bridge members:   bridge link show"
    echo "View logs:              tail -f /var/log/qemu-bridge.log"
    echo ""
}

# Main execution
main() {
    echo ""
    echo "🔧 UNIVERSAL QEMU NETWORK SETUP"
    echo "═══════════════════════════════════════════════════════════"
    
    detect_environment
    install_packages
    create_bridge
    configure_bridge_permissions
    show_qemu_commands
    
    print_status "Setup complete!"
}

# Run main function
main
