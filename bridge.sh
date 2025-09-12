#!/bin/bash

# QEMU Bridge Configurator with Logging
# Sets up /etc/qemu/bridge.conf to allow virbr0

LOG_FILE="/var/log/qemu_bridge_setup.log"

echo "=== QEMU Bridge Configuration Started $(date) ===" | tee -a $LOG_FILE

echo -e "\n[1/4] Creating directory structure..." | tee -a $LOG_FILE
sudo mkdir -p /etc/qemu | tee -a $LOG_FILE

echo -e "\n[2/4] Configuring bridge permissions..." | tee -a $LOG_FILE
echo "allow virbr0" | sudo tee /etc/qemu/bridge.conf | tee -a $LOG_FILE
sudo chmod 644 /etc/qemu/bridge.conf | tee -a $LOG_FILE

echo -e "\n[3/4] Verification steps:" | tee -a $LOG_FILE
echo -e "\nCurrent bridge configuration:" | tee -a $LOG_FILE
cat /etc/qemu/bridge.conf | tee -a $LOG_FILE

echo -e "\nBridge interfaces available:" | tee -a $LOG_FILE
sudo brctl show 2>/dev/null | tee -a $LOG_FILE || echo "bridge-utils not installed, install with: sudo apt install bridge-utils" | tee -a $LOG_FILE

echo -e "\n[4/4] QEMU bridge helper permissions:" | tee -a $LOG_FILE
ls -l /usr/lib/qemu/qemu-bridge-helper | tee -a $LOG_FILE

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
