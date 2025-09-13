#!/bin/bash

# QEMU Bridge Configurator with Logging and Multi-Distribution Support
# Sets up /etc/qemu/bridge.conf to allow virbr0 and ensures libvirt is installed

LOG_FILE="/var/log/qemu_bridge_setup.log"

echo "=== QEMU Bridge Configuration Started $(date) ===" | tee -a $LOG_FILE

# Check if we're running as root
if [ "$EUID" -ne 0 ]; then
    echo "Please run as root or with sudo" | tee -a $LOG_FILE
    exit 1
fi

# Detect distribution and set package manager variables
echo -e "\n[0/6] Detecting distribution..." | tee -a $LOG_FILE
if [ -f /etc/alpine-release ]; then
    DISTRO="alpine"
    PKG_MGR="apk"
    PKG_INSTALL="$PKG_MGR add"
    BRIDGE_UTILS="bridge"
    LIBVIRT_PKG="libvirt"
    QEMU_BRIDGE_HELPER="/usr/lib/qemu/qemu-bridge-helper"
    echo "Alpine Linux detected" | tee -a $LOG_FILE
elif [ -f /etc/debian_version ] || [ -f /etc/ubuntu-release ] || [ -f /etc/os-release ] && grep -qiE '(ubuntu|debian)' /etc/os-release; then
    DISTRO="ubuntu"
    PKG_MGR="apt-get"
    PKG_INSTALL="$PKG_MGR install -y"
    BRIDGE_UTILS="bridge-utils"
    LIBVIRT_PKG="libvirt-daemon-system libvirt-clients bridge-utils"
    QEMU_BRIDGE_HELPER="/usr/lib/qemu/qemu-bridge-helper"
    echo "Ubuntu/Debian detected" | tee -a $LOG_FILE
else
    echo "Unsupported distribution. Exiting." | tee -a $LOG_FILE
    exit 1
fi

# Install libvirt if not already installed
echo -e "\n[1/6] Checking for libvirt installation..." | tee -a $LOG_FILE
if ! command -v virsh >/dev/null 2>&1; then
    echo "libvirt not found, installing..." | tee -a $LOG_FILE
    $PKG_INSTALL $LIBVIRT_PKG | tee -a $LOG_FILE
    
    # Start and enable libvirt service
    if [ "$DISTRO" = "alpine" ]; then
        rc-update add libvirtd default
        rc-service libvirtd start
    else
        systemctl enable libvirtd
        systemctl start libvirtd
    fi
    echo "libvirt installed and service started" | tee -a $LOG_FILE
else
    echo "libvirt already installed" | tee -a $LOG_FILE
fi

# Install bridge-utils if not already installed
echo -e "\n[2/6] Checking for bridge-utils..." | tee -a $LOG_FILE
if ! command -v brctl >/dev/null 2>&1; then
    echo "bridge-utils not found, installing..." | tee -a $LOG_FILE
    $PKG_INSTALL $BRIDGE_UTILS | tee -a $LOG_FILE
else
    echo "bridge-utils already installed" | tee -a $LOG_FILE
fi

echo -e "\n[3/6] Creating directory structure..." | tee -a $LOG_FILE
mkdir -p /etc/qemu | tee -a $LOG_FILE

echo -e "\n[4/6] Configuring bridge permissions..." | tee -a $LOG_FILE
echo "allow virbr0" | tee /etc/qemu/bridge.conf | tee -a $LOG_FILE
chmod 644 /etc/qemu/bridge.conf | tee -a $LOG_FILE

echo -e "\n[5/6] Checking for bridge interface..." | tee -a $LOG_FILE
if ! brctl show | grep -q virbr0; then
    echo "Bridge virbr0 not found, ensuring default network is active..." | tee -a $LOG_FILE
    
    # Start the default network if using libvirt
    if virsh net-list --all | grep -q default; then
        virsh net-start default | tee -a $LOG_FILE
        virsh net-autostart default | tee -a $LOG_FILE
        echo "Default libvirt network started and set to autostart" | tee -a $LOG_FILE
    else
        echo "No default libvirt network found. Creating bridge manually..." | tee -a $LOG_FILE
        brctl addbr virbr0
        ip addr add 192.168.100.1/24 dev virbr0
        ip link set dev virbr0 up
        echo "Bridge virbr0 created manually" | tee -a $LOG_FILE
    fi
else
    echo "Bridge virbr0 already exists" | tee -a $LOG_FILE
fi

echo -e "\n[6/6] Verification steps:" | tee -a $LOG_FILE
echo -e "\nCurrent bridge configuration:" | tee -a $LOG_FILE
cat /etc/qemu/bridge.conf | tee -a $LOG_FILE

echo -e "\nBridge interfaces available:" | tee -a $LOG_FILE
brctl show | tee -a $LOG_FILE

echo -e "\nQEMU bridge helper permissions:" | tee -a $LOG_FILE
if [ -f "$QEMU_BRIDGE_HELPER" ]; then
    ls -l "$QEMU_BRIDGE_HELPER" | tee -a $LOG_FILE
else
    echo "QEMU bridge helper not found at $QEMU_BRIDGE_HELPER" | tee -a $LOG_FILE
fi

echo -e "\nLibvirt networks:" | tee -a $LOG_FILE
virsh net-list --all | tee -a $LOG_FILE

echo -e "\n=== EXAMPLE QEMU STARTUP COMMAND ===" | tee -a $LOG_FILE
echo "After this configuration, you can start QEMU with:" | tee -a $LOG_FILE
echo -e "\nqemu-system-x86_64 \\" | tee -a $LOG_FILE
echo "  -m 2048M \\" | tee -a $LOG_FILE
echo "  -smp 2 \\" | tee -a $LOG_FILE
echo "  -hda /path/to/your/vm.qcow2 \\" | tee -a $LOG_FILE
echo "  -enable-kvm \\" | tee -a $LOG_FILE
echo "  -vga std \\" | tee -a $LOG_FILE
echo "  -net nic,model=virtio \\" | tee -a $LOG_FILE
echo "  -net bridge,br=virbr0" | tee -a $LOG_FILE

echo -e "\n=== Configuration Complete $(date) ===" | tee -a $LOG_FILE
echo "Log saved to $LOG_FILE" | tee -a $LOG_FILE
