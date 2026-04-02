#!/usr/bin/env node
// bridge-manager.js - Pure Node.js native module for network bridge management
// Works with: ash (Alpine), bash (Ubuntu/Debian), and WSL

import { execSync, exec } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createInterface } from 'readline';

class Bridge {
    constructor(options = {}) {
        this.debug = options.debug || false;
        this.shell = this.detectShell();
        this.environment = this.detectEnvironment();
        this.supported = this.checkSupport();
        this.ipVersion = this.detectIpVersion();
        this.configPaths = {
            qemuBridgeConf: '/etc/qemu/bridge.conf',
            networkInterfaces: '/etc/network/interfaces',
            netplanDir: '/etc/netplan/'
        };
    }

    /**
     * Detect which shell to use (Alpine uses /bin/ash, others use /bin/bash)
     */
    detectShell() {
        // Check for ash (Alpine)
        try {
            fs.accessSync('/bin/ash', fs.constants.X_OK);
            const test = execSync('echo test', { shell: '/bin/ash', encoding: 'utf8' });
            if (test.trim() === 'test') {
                return '/bin/ash';
            }
        } catch (err) {}
        
        // Check for bash
        try {
            fs.accessSync('/bin/bash', fs.constants.X_OK);
            return '/bin/bash';
        } catch (err) {
            return '/bin/sh';
        }
    }

    /**
     * Detect if using busybox ip (Alpine) or full iproute2 (Ubuntu)
     */
    detectIpVersion() {
        try {
            const result = execSync('ip --version 2>&1', { shell: this.shell, encoding: 'utf8' });
            if (result.toLowerCase().includes('busybox')) {
                return 'busybox';
            }
        } catch (err) {}
        return 'full';
    }

    /**
     * Detect the current environment
     */
    detectEnvironment() {
        // Check for WSL
        try {
            const version = fs.readFileSync('/proc/version', 'utf8');
            if (version.toLowerCase().includes('microsoft') || 
                version.toLowerCase().includes('wsl')) {
                return { type: 'wsl', name: 'Windows Subsystem for Linux', bridgeSupport: false };
            }
        } catch (err) {}

        // Check for Alpine
        try {
            fs.accessSync('/etc/alpine-release', fs.constants.R_OK);
            return { type: 'alpine', name: 'Alpine Linux', bridgeSupport: true, init: 'openrc' };
        } catch (err) {}

        // Check for Ubuntu/Debian
        try {
            const osRelease = fs.readFileSync('/etc/os-release', 'utf8');
            if (osRelease.toLowerCase().includes('ubuntu') || 
                osRelease.toLowerCase().includes('debian')) {
                return { type: 'debian', name: 'Ubuntu/Debian', bridgeSupport: true, init: 'systemd' };
            }
        } catch (err) {}

        return { type: 'unknown', name: 'Unknown', bridgeSupport: false };
    }

    /**
     * Check if bridge networking is supported
     */
    checkSupport() {
        if (!this.environment.bridgeSupport) {
            return {
                bridge: false,
                kvm: false,
                reason: `${this.environment.name} does not support bridge mode`
            };
        }

        let hasBrctl = false;
        let hasIp = false;
        
        try {
            execSync('which brctl', { stdio: 'ignore', shell: this.shell });
            hasBrctl = true;
        } catch (err) {}
        
        try {
            execSync('which ip', { stdio: 'ignore', shell: this.shell });
            hasIp = true;
        } catch (err) {}

        let hasKvm = false;
        try {
            if (this.environment.type === 'alpine') {
                execSync('modprobe kvm 2>/dev/null || true', { stdio: 'ignore', shell: this.shell });
            }
            fs.accessSync('/dev/kvm', fs.constants.RW_OK);
            hasKvm = true;
        } catch (err) {}

        return {
            bridge: (hasBrctl || hasIp),
            kvm: hasKvm,
            bridgeUtils: hasBrctl ? 'bridge-utils' : (hasIp ? 'iproute2' : 'none'),
            reason: hasKvm ? 'Ready' : 'KVM not available (using TCG)'
        };
    }

    /**
     * Execute shell command with promise
     */
    execCommand(cmd, options = {}) {
        return new Promise((resolve, reject) => {
            if (this.debug) console.log(`[DEBUG] Executing: ${cmd}`);
            
            const execOptions = { 
                shell: this.shell,
                ...options 
            };
            
            exec(cmd, execOptions, (error, stdout, stderr) => {
                if (error && !options.ignoreError) {
                    reject({ error, stdout, stderr, cmd });
                } else {
                    resolve({ stdout: stdout?.trim() || '', stderr: stderr?.trim() || '', exitCode: error?.code || 0 });
                }
            });
        });
    }

    /**
     * Execute sync command
     */
    execCommandSync(cmd, options = {}) {
        try {
            if (this.debug) console.log(`[DEBUG] Executing sync: ${cmd}`);
            const result = execSync(cmd, { 
                encoding: 'utf8',
                stdio: 'pipe',
                shell: this.shell,
                ...options 
            });
            return { stdout: result.trim(), stderr: '', exitCode: 0 };
        } catch (error) {
            if (!options.ignoreError) throw error;
            return { stdout: '', stderr: error.stderr?.toString() || error.message, exitCode: error.status };
        }
    }

    /**
     * Check if an interface is a bridge - FIXED for Alpine/busybox
     */
    async isBridge(interfaceName) {
        // Method 1: Check via /sys/class/net (most reliable)
        try {
            const bridgePath = `/sys/class/net/${interfaceName}/bridge`;
            fs.accessSync(bridgePath, fs.constants.R_OK);
            return true;
        } catch (err) {
            // Not a bridge or doesn't exist
        }
        
        // Method 2: Check via brctl (works on Alpine)
        try {
            const result = await this.execCommand(`brctl show 2>/dev/null | grep -w "^${interfaceName}"`, { ignoreError: true });
            if (result.stdout && result.exitCode === 0) {
                return true;
            }
        } catch (err) {}
        
        // Method 3: Check via ip link (for full iproute2)
        if (this.ipVersion === 'full') {
            try {
                const result = await this.execCommand(`ip link show type bridge 2>/dev/null | grep -q "${interfaceName}"`, { ignoreError: true });
                if (result.exitCode === 0) {
                    return true;
                }
            } catch (err) {}
        }
        
        return false;
    }

    /**
     * List all network interfaces
     */
    async listInterfaces() {
        const interfaces = [];
        
        // Get all network interfaces from /sys/class/net (most reliable)
        try {
            const netDevices = fs.readdirSync('/sys/class/net');
            for (const name of netDevices) {
                const isBridge = await this.isBridge(name);
                
                // Check if interface is up
                let isUp = false;
                try {
                    const operState = fs.readFileSync(`/sys/class/net/${name}/operstate`, 'utf8');
                    isUp = operState.trim() === 'up';
                } catch (err) {
                    // Fallback to ip command
                    const result = await this.execCommand(`ip link show ${name} 2>/dev/null | grep -q "state UP"`, { ignoreError: true });
                    isUp = result.exitCode === 0;
                }
                
                interfaces.push({
                    name,
                    isUp,
                    isBridge,
                    type: isBridge ? 'bridge' : 'physical'
                });
            }
        } catch (err) {
            // Fallback to ip command
            const result = await this.execCommand('ip link show 2>/dev/null', { ignoreError: true });
            const lines = result.stdout.split('\n');
            for (const line of lines) {
                const match = line.match(/^\d+:\s+(\w+):/);
                if (match) {
                    const name = match[1];
                    const isBridge = await this.isBridge(name);
                    const isUp = line.includes('state UP');
                    interfaces.push({
                        name,
                        isUp,
                        isBridge,
                        type: isBridge ? 'bridge' : 'physical'
                    });
                }
            }
        }
        
        return interfaces;
    }

    /**
     * Get bridge details - FIXED for Alpine
     */
    async getBridgeDetails(bridgeName) {
        const isBridge = await this.isBridge(bridgeName);
        if (!isBridge) {
            throw new Error(`Bridge ${bridgeName} does not exist or is not a bridge`);
        }

        const details = {
            name: bridgeName,
            exists: true,
            interfaces: [],
            ipAddress: null,
            macAddress: null,
            state: 'down'
        };

        // Get bridge members - try multiple methods
        // Method 1: via /sys/class/net (most reliable)
        try {
            const ifLinks = fs.readdirSync(`/sys/class/net/${bridgeName}/brif`);
            details.interfaces = ifLinks;
        } catch (err) {
            // Method 2: via brctl
            const membersResult = await this.execCommand(`brctl showmacs ${bridgeName} 2>/dev/null | tail -n +2 | awk '{print $2}' | sort -u`, { ignoreError: true });
            if (membersResult.stdout) {
                details.interfaces = membersResult.stdout.split('\n').filter(Boolean);
            }
            
            // Method 3: via bridge command
            if (details.interfaces.length === 0 && this.ipVersion === 'full') {
                const membersResult = await this.execCommand(`bridge link show master ${bridgeName} 2>/dev/null | grep -oP '(?<=: )\\w+'`, { ignoreError: true });
                if (membersResult.stdout) {
                    details.interfaces = membersResult.stdout.split('\n').filter(Boolean);
                }
            }
        }

        // Get IP address
        const ipResult = await this.execCommand(`ip addr show ${bridgeName} 2>/dev/null | grep 'inet ' | awk '{print $2}' | head -1`, { ignoreError: true });
        details.ipAddress = ipResult.stdout || null;

        // Get MAC address
        const macResult = await this.execCommand(`ip link show ${bridgeName} 2>/dev/null | grep 'link/ether' | awk '{print $2}'`, { ignoreError: true });
        details.macAddress = macResult.stdout || null;

        // Get state
        const stateResult = await this.execCommand(`ip link show ${bridgeName} 2>/dev/null | grep -o 'state [A-Z]\\+' | awk '{print $2}' | tr '[:upper:]' '[:lower:]'`, { ignoreError: true });
        details.state = stateResult.stdout || 'unknown';

        return details;
    }

    async createBridge(options) {
        const {
            name = 'br0',
            ipAddress = '192.168.100.1/24',
            addToInterface = null,
            enableNat = true,
            stp = true
        } = options;
    
        if (!this.supported.bridge) {
            throw new Error(`Bridge mode not supported in ${this.environment.name}`);
        }
    
        if (this.environment.type === 'wsl') {
            throw new Error('Cannot create bridges in WSL - use user-mode networking instead');
        }
    
        // Check if bridge already exists
        const exists = await this.isBridge(name);
        if (exists) {
            throw new Error(`Bridge ${name} already exists`);
        }
    
        // Try to remove any existing interface with same name (cleanup)
        await this.execCommand(`ip link delete ${name} 2>/dev/null || true`, { ignoreError: true });
        
        // Use brctl on Alpine as it's more reliable
        let bridgeCreated = false;
        
        if (this.environment.type === 'alpine' || this.ipVersion === 'busybox') {
            try {
                await this.execCommand(`brctl addbr ${name}`, { ignoreError: false });
                bridgeCreated = true;
                
                // Disable STP temporarily to bring bridge up
                if (!stp) {
                    await this.execCommand(`brctl stp ${name} off`, { ignoreError: true });
                } else {
                    await this.execCommand(`brctl stp ${name} on`, { ignoreError: true });
                }
            } catch (err) {
                if (this.debug) console.log('brctl failed, trying ip...');
            }
        }
        
        // If brctl failed or not on Alpine, try ip command
        if (!bridgeCreated) {
            try {
                await this.execCommand(`ip link add name ${name} type bridge`, { ignoreError: false });
                bridgeCreated = true;
            } catch (err) {
                throw new Error(`Failed to create bridge: ${err.message}`);
            }
        }
        
        if (bridgeCreated) {
            // CRITICAL: Bring bridge UP with multiple attempts and delays
            await this.execCommand(`ip link set ${name} up`, { ignoreError: true });
            
            // Small delay for Alpine
            await new Promise(resolve => setTimeout(resolve, 500));
            
            // Second attempt
            await this.execCommand(`ip link set ${name} up`, { ignoreError: true });
            
            // Alternative method for Alpine
            await this.execCommand(`ifconfig ${name} up 2>/dev/null || true`, { ignoreError: true });
            
            // Add IP address
            await this.execCommand(`ip addr add ${ipAddress} dev ${name} 2>/dev/null || true`, { ignoreError: true });
    
            // Add interface to bridge if specified
            if (addToInterface) {
                await this.execCommand(`ip link set ${addToInterface} master ${name} 2>/dev/null || brctl addif ${name} ${addToInterface} 2>/dev/null || true`, { ignoreError: true });
                await this.execCommand(`ip link set ${addToInterface} up`, { ignoreError: true });
            }
    
            // Enable IP forwarding for NAT
            if (enableNat) {
                await this.execCommand('echo 1 > /proc/sys/net/ipv4/ip_forward 2>/dev/null || true', { ignoreError: true });
                
                const networkBase = ipAddress.split('/')[0];
                await this.execCommand(`iptables -t nat -A POSTROUTING -s ${networkBase}/24 -j MASQUERADE 2>/dev/null || true`, { ignoreError: true });
                await this.execCommand(`iptables -A FORWARD -i ${name} -j ACCEPT 2>/dev/null || true`, { ignoreError: true });
                await this.execCommand(`iptables -A FORWARD -o ${name} -j ACCEPT 2>/dev/null || true`, { ignoreError: true });
            }
            
            // Final verification and force up
            const finalState = await this.execCommand(`ip link show ${name} | grep -o 'state [A-Z]\\+' | awk '{print $2}'`, { ignoreError: true });
            if (finalState.stdout !== 'UP') {
                // Force up using sysfs
                await this.execCommand(`echo 1 > /sys/class/net/${name}/operstate 2>/dev/null || true`, { ignoreError: true });
                // One more attempt
                await this.execCommand(`ip link set ${name} up`, { ignoreError: true });
            }
        }
    
        // Verify bridge was created
        const bridgeExists = await this.isBridge(name);
        if (!bridgeExists) {
            throw new Error(`Bridge ${name} was not created successfully`);
        }
    
        // Configure QEMU bridge permissions
        await this.configureQemuBridge(name);
    
        // Save configuration for persistence (if requested)
        if (options.makePersistent) {
            await this.makeBridgePersistent(name, ipAddress, addToInterface);
        }
    
        return await this.getBridgeDetails(name);
    }

    /**
     * Configure QEMU bridge helper
     */
    async configureQemuBridge(bridgeName) {
        await this.execCommand('mkdir -p /etc/qemu', { ignoreError: true });
        
        const configContent = `allow ${bridgeName}\n`;
        fs.writeFileSync(this.configPaths.qemuBridgeConf, configContent, { mode: 0o644 });
        
        const qemuHelper = await this.findQemuBridgeHelper();
        if (qemuHelper) {
            await this.execCommand(`chown root:root ${qemuHelper} 2>/dev/null || true`, { ignoreError: true });
            await this.execCommand(`chmod 4750 ${qemuHelper} 2>/dev/null || true`, { ignoreError: true });
        }
        
        return { configured: true, bridgeHelper: qemuHelper };
    }

    /**
     * Find QEMU bridge helper location
     */
    async findQemuBridgeHelper() {
        const possiblePaths = [
            '/usr/lib/qemu/qemu-bridge-helper',
            '/usr/libexec/qemu-bridge-helper',
            '/usr/local/lib/qemu/qemu-bridge-helper',
            '/usr/lib/qemu-system-x86_64/qemu-bridge-helper',
            '/usr/lib/qemu/qemu-bridge-helper-qemu-system-x86_64'
        ];
        
        for (const p of possiblePaths) {
            try {
                fs.accessSync(p, fs.constants.X_OK);
                return p;
            } catch (err) {}
        }
        
        try {
            const result = await this.execCommand('which qemu-bridge-helper 2>/dev/null', { ignoreError: true });
            if (result.stdout) return result.stdout;
        } catch (err) {}
        
        return null;
    }

    /**
     * Make bridge persistent across reboots
     */
    async makeBridgePersistent(bridgeName, ipAddress, interfaceToBridge) {
        if (this.environment.type === 'alpine') {
            const interfaceConfig = `
auto ${bridgeName}
iface ${bridgeName} inet static
    address ${ipAddress}
    bridge_ports ${interfaceToBridge || 'none'}
    bridge_stp on
    bridge_fd 0
`;
            fs.appendFileSync('/etc/network/interfaces', interfaceConfig);
            
            const startupScript = `/etc/local.d/bridge-${bridgeName}.start`;
            const startupContent = `#!/bin/sh
# Auto-created bridge configuration
if ! brctl show | grep -q "^${bridgeName}"; then
    brctl addbr ${bridgeName}
    brctl stp ${bridgeName} on
    ip link set ${bridgeName} up
    ip addr add ${ipAddress} dev ${bridgeName}
    ${interfaceToBridge ? `ip link set ${interfaceToBridge} master ${bridgeName} 2>/dev/null || brctl addif ${bridgeName} ${interfaceToBridge}` : ''}
fi
`;
            fs.writeFileSync(startupScript, startupContent);
            fs.chmodSync(startupScript, 0o755);
            await this.execCommand('rc-update add local default 2>/dev/null || true', { ignoreError: true });
        } else {
            const netplanConfig = {
                network: {
                    bridges: {
                        [bridgeName]: {
                            interfaces: interfaceToBridge ? [interfaceToBridge] : [],
                            addresses: [ipAddress],
                            parameters: {
                                stp: true,
                                forwardDelay: 0
                            }
                        }
                    }
                }
            };
            
            const configFile = path.join(this.configPaths.netplanDir, `99-${bridgeName}.yaml`);
            fs.writeFileSync(configFile, this.objectToYaml(netplanConfig));
            await this.execCommand('netplan apply', { ignoreError: true });
        }
        
        return true;
    }

    /**
     * Simple object to YAML converter
     */
    objectToYaml(obj, indent = 0) {
        let yaml = '';
        const spaces = ' '.repeat(indent);
        
        for (const [key, value] of Object.entries(obj)) {
            if (typeof value === 'object' && !Array.isArray(value)) {
                yaml += `${spaces}${key}:\n`;
                yaml += this.objectToYaml(value, indent + 2);
            } else if (Array.isArray(value)) {
                yaml += `${spaces}${key}:\n`;
                value.forEach(item => {
                    yaml += `${spaces}  - ${item}\n`;
                });
            } else {
                yaml += `${spaces}${key}: ${value}\n`;
            }
        }
        
        return yaml;
    }

    /**
     * Remove a bridge
     */
    async removeBridge(bridgeName, options = {}) {
        const exists = await this.isBridge(bridgeName);
        if (!exists) {
            throw new Error(`Bridge ${bridgeName} does not exist`);
        }

        const details = await this.getBridgeDetails(bridgeName);
        
        // Remove interfaces from bridge
        for (const iface of details.interfaces) {
            await this.execCommand(`ip link set ${iface} nomaster 2>/dev/null || brctl delif ${bridgeName} ${iface} 2>/dev/null || true`, { ignoreError: true });
        }
        
        // Bring bridge down
        await this.execCommand(`ip link set ${bridgeName} down`, { ignoreError: true });
        
        // Delete bridge
        await this.execCommand(`ip link delete ${bridgeName} 2>/dev/null || brctl delbr ${bridgeName} 2>/dev/null || true`, { ignoreError: true });
        
        // Remove iptables rules
        if (details.ipAddress) {
            const network = details.ipAddress.split('/')[0];
            await this.execCommand(`iptables -t nat -D POSTROUTING -s ${network}/24 -j MASQUERADE 2>/dev/null || true`, { ignoreError: true });
            await this.execCommand(`iptables -D FORWARD -i ${bridgeName} -j ACCEPT 2>/dev/null || true`, { ignoreError: true });
            await this.execCommand(`iptables -D FORWARD -o ${bridgeName} -j ACCEPT 2>/dev/null || true`, { ignoreError: true });
        }
        
        if (options.removeFromConfig) {
            await this.removeFromConfig(bridgeName);
        }
        
        return { removed: true, name: bridgeName };
    }

    /**
     * Remove bridge from config files
     */
    async removeFromConfig(bridgeName) {
        if (this.environment.type === 'alpine') {
            try {
                const content = fs.readFileSync('/etc/network/interfaces', 'utf8');
                const lines = content.split('\n');
                const newLines = [];
                let skip = false;
                
                for (const line of lines) {
                    if (line.includes(`auto ${bridgeName}`) || line.includes(`iface ${bridgeName}`)) {
                        skip = true;
                        continue;
                    }
                    if (skip && line.trim() === '') {
                        skip = false;
                        continue;
                    }
                    if (!skip) {
                        newLines.push(line);
                    }
                }
                
                fs.writeFileSync('/etc/network/interfaces', newLines.join('\n'));
            } catch (err) {}
            
            try {
                fs.unlinkSync(`/etc/local.d/bridge-${bridgeName}.start`);
            } catch (err) {}
        } else {
            const configFile = path.join(this.configPaths.netplanDir, `99-${bridgeName}.yaml`);
            if (fs.existsSync(configFile)) {
                fs.unlinkSync(configFile);
                await this.execCommand('netplan apply', { ignoreError: true });
            }
        }
        
        return true;
    }

    /**
     * Edit bridge properties
     */
    async editBridge(bridgeName, options) {
        const exists = await this.isBridge(bridgeName);
        if (!exists) {
            throw new Error(`Bridge ${bridgeName} does not exist`);
        }
        
        const updates = [];
        
        if (options.ipAddress) {
            const oldDetails = await this.getBridgeDetails(bridgeName);
            if (oldDetails.ipAddress) {
                updates.push(`ip addr del ${oldDetails.ipAddress} dev ${bridgeName} 2>/dev/null || true`);
            }
            updates.push(`ip addr add ${options.ipAddress} dev ${bridgeName} 2>/dev/null || true`);
        }
        
        if (options.addInterface) {
            updates.push(`ip link set ${options.addInterface} master ${bridgeName} 2>/dev/null || brctl addif ${bridgeName} ${options.addInterface} 2>/dev/null || true`);
        }
        
        if (options.removeInterface) {
            updates.push(`ip link set ${options.removeInterface} nomaster 2>/dev/null || brctl delif ${bridgeName} ${options.removeInterface} 2>/dev/null || true`);
        }
        
        if (options.stp !== undefined) {
            if (this.ipVersion === 'busybox' || this.environment.type === 'alpine') {
                updates.push(`brctl stp ${bridgeName} ${options.stp ? 'on' : 'off'} 2>/dev/null || true`);
            } else {
                updates.push(`ip link set ${bridgeName} type bridge stp_state ${options.stp ? 1 : 0} 2>/dev/null || true`);
            }
        }
        
        for (const cmd of updates) {
            await this.execCommand(cmd);
        }
        
        return await this.getBridgeDetails(bridgeName);
    }

    /**
     * Generate QEMU command for VM
     */
    generateQemuCommand(options) {
        const {
            bridgeName = 'br0',
            vmPath = '/path/to/your/vm.qcow2',
            memory = 2048,
            cpus = 2,
            sshPort = null,
            enableKvm = true,
            networking = 'bridge',
            additionalOptions = []
        } = options;

        const commands = ['qemu-system-x86_64'];
        
        commands.push(`-m ${memory}M`);
        commands.push(`-smp ${cpus}`);
        commands.push(`-drive file=${vmPath},format=qcow2`);
        
        if (enableKvm && this.supported.kvm) {
            commands.push('-enable-kvm');
        }
        
        commands.push('-cpu host');
        commands.push('-nographic');
        commands.push('-serial mon:stdio');
        
        if (networking === 'bridge' && this.supported.bridge) {
            commands.push(`-netdev bridge,id=net0,br=${bridgeName}`);
            commands.push('-device virtio-net-pci,netdev=net0');
        } else if (networking === 'user') {
            let userNetdev = 'user,id=net0';
            if (sshPort) {
                userNetdev += `,hostfwd=tcp::${sshPort}-:22`;
            }
            commands.push(`-netdev ${userNetdev}`);
            commands.push('-device virtio-net-pci,netdev=net0');
        } else {
            commands.push('-netdev none,id=net0');
        }
        
        commands.push(...additionalOptions);
        
        return {
            command: commands.join(' \\\n  '),
            sshCommand: networking === 'user' && sshPort ? 
                `ssh -p ${sshPort} user@localhost` : 
                `ssh user@<vm-ip>  # Find IP with: ip neigh | grep -i qemu`,
            networkingType: networking,
            bridgeUsed: networking === 'bridge' ? bridgeName : null
        };
    }

    /**
     * Get all bridge statistics
     */
    async getBridgeStats(bridgeName) {
        const exists = await this.isBridge(bridgeName);
        if (!exists) {
            throw new Error(`Bridge ${bridgeName} does not exist`);
        }
        
        const stats = {
            name: bridgeName,
            timestamp: new Date().toISOString(),
            packets: {},
            bytes: {}
        };
        
        try {
            const rxPackets = fs.readFileSync(`/sys/class/net/${bridgeName}/statistics/rx_packets`, 'utf8');
            const txPackets = fs.readFileSync(`/sys/class/net/${bridgeName}/statistics/tx_packets`, 'utf8');
            const rxBytes = fs.readFileSync(`/sys/class/net/${bridgeName}/statistics/rx_bytes`, 'utf8');
            const txBytes = fs.readFileSync(`/sys/class/net/${bridgeName}/statistics/tx_bytes`, 'utf8');
            
            stats.packets = { rx: parseInt(rxPackets), tx: parseInt(txPackets) };
            stats.bytes = { rx: parseInt(rxBytes), tx: parseInt(txBytes) };
        } catch (err) {
            stats.error = 'Could not read statistics';
        }
        
        return stats;
    }

    /**
     * Start a DHCP server on the bridge
     */
    async startDhcpServer(bridgeName, options = {}) {
        const {
            dhcpRange = '192.168.100.50,192.168.100.200',
            leaseTime = '1h'
        } = options;
        
        let hasDnsmasq = false;
        try {
            await this.execCommand('which dnsmasq', { ignoreError: true });
            hasDnsmasq = true;
        } catch (err) {}
        
        if (!hasDnsmasq) {
            if (this.environment.type === 'alpine') {
                await this.execCommand('apk add dnsmasq', { ignoreError: true });
            } else {
                await this.execCommand('apt-get install -y dnsmasq', { ignoreError: true });
            }
        }
        
        const configContent = `
interface=${bridgeName}
dhcp-range=${dhcpRange}
dhcp-lease-time=${leaseTime}
dhcp-option=3,${options.gateway || '192.168.100.1'}
dhcp-option=6,${options.dns || '8.8.8.8'}
`;
        
        const configFile = `/etc/dnsmasq-${bridgeName}.conf`;
        fs.writeFileSync(configFile, configContent);
        
        await this.execCommand(`dnsmasq --conf-file=${configFile} --pid-file=/var/run/dnsmasq-${bridgeName}.pid`, { ignoreError: true });
        
        return { running: true, configFile, bridge: bridgeName };
    }

    /**
     * Get system information
     */
    async getSystemInfo() {
        return {
            environment: this.environment,
            support: this.supported,
            shell: this.shell,
            ipVersion: this.ipVersion,
            bridges: await this.listInterfaces().then(interfaces => interfaces.filter(i => i.isBridge)),
            kernel: os.release(),
            architecture: os.arch(),
            uptime: os.uptime()
        };
    }

    /**
     * Main menu for CLI usage
     */
    async interactiveMenu() {
        const rl = createInterface({
            input: process.stdin,
            output: process.stdout
        });
        
        const question = (query) => new Promise(resolve => rl.question(query, resolve));
        
        console.clear();
        console.log('═══════════════════════════════════════════════════════');
        console.log('     NETWORK BRIDGE MANAGER - Interactive Menu');
        console.log('═══════════════════════════════════════════════════════');
        console.log(`Environment: ${this.environment.name}`);
        console.log(`Shell: ${this.shell}`);
        console.log(`IP Version: ${this.ipVersion}`);
        console.log(`Bridge Support: ${this.supported.bridge ? '✓' : '✗'}`);
        console.log(`KVM Support: ${this.supported.kvm ? '✓' : '✗'}`);
        console.log('');
        
        while (true) {
            console.log('\nAvailable Actions:');
            console.log('1. List all interfaces');
            console.log('2. Create a new bridge');
            console.log('3. Remove a bridge');
            console.log('4. Edit a bridge');
            console.log('5. Show bridge details');
            console.log('6. Generate QEMU command');
            console.log('7. Show system info');
            console.log('8. Start DHCP server on bridge');
            console.log('9. Exit');
            
            const choice = await question('\nChoose action (1-9): ');
            
            try {
                switch(choice) {
                    case '1':
                        const interfaces = await this.listInterfaces();
                        console.log('\nNetwork Interfaces:');
                        console.table(interfaces);
                        break;
                        
                    case '2':
                        const name = await question('Bridge name [br0]: ');
                        const ip = await question('IP address [192.168.100.1/24]: ');
                        const iface = await question('Interface to add (optional): ');
                        
                        const bridge = await this.createBridge({
                            name: name || 'br0',
                            ipAddress: ip || '192.168.100.1/24',
                            addToInterface: iface || null,
                            enableNat: true
                        });
                        console.log('\n✓ Bridge created successfully!');
                        console.log(bridge);
                        break;
                        
                    case '3':
                        const bridges = await this.listInterfaces();
                        const bridgeList = bridges.filter(b => b.isBridge).map(b => b.name).join(', ');
                        const bridgeToRemove = await question(`Bridge to remove (${bridgeList}): `);
                        await this.removeBridge(bridgeToRemove);
                        console.log(`\n✓ Bridge ${bridgeToRemove} removed`);
                        break;
                        
                    case '4':
                        const bridges2 = await this.listInterfaces();
                        const bridgeList2 = bridges2.filter(b => b.isBridge).map(b => b.name).join(', ');
                        const bridgeToEdit = await question(`Bridge name to edit (${bridgeList2}): `);
                        const newIp = await question('New IP address (leave empty to keep): ');
                        const addIface = await question('Interface to add to bridge: ');
                        const removeIface = await question('Interface to remove from bridge: ');
                        
                        const updated = await this.editBridge(bridgeToEdit, {
                            ipAddress: newIp || null,
                            addInterface: addIface || null,
                            removeInterface: removeIface || null
                        });
                        console.log('\n✓ Bridge updated!');
                        console.log(updated);
                        break;
                        
                    case '5':
                        const bridges3 = await this.listInterfaces();
                        const bridgeList3 = bridges3.filter(b => b.isBridge).map(b => b.name).join(', ');
                        const bridgeName = await question(`Bridge name (${bridgeList3}): `);
                        const details = await this.getBridgeDetails(bridgeName);
                        console.log('\nBridge Details:');
                        console.log(details);
                        break;
                        
                    case '6':
                        const vmPath = await question('VM image path: ');
                        const memory = await question('Memory (MB) [2048]: ');
                        const cpus = await question('CPU cores [2]: ');
                        const netType = await question('Networking type (bridge/user/none) [bridge]: ');
                        const sshPort = await question('SSH port for user-mode (if applicable): ');
                        
                        const qemuCmd = this.generateQemuCommand({
                            vmPath,
                            memory: parseInt(memory) || 2048,
                            cpus: parseInt(cpus) || 2,
                            networking: netType || 'bridge',
                            sshPort: sshPort ? parseInt(sshPort) : null
                        });
                        console.log('\n═══════════════════════════════════════════════════════');
                        console.log('QEMU COMMAND:');
                        console.log('═══════════════════════════════════════════════════════');
                        console.log(qemuCmd.command);
                        console.log('\nSSH Command:');
                        console.log(qemuCmd.sshCommand);
                        break;
                        
                    case '7':
                        const info = await this.getSystemInfo();
                        console.log('\nSystem Information:');
                        console.log(JSON.stringify(info, null, 2));
                        break;
                        
                    case '8':
                        const bridges4 = await this.listInterfaces();
                        const bridgeList4 = bridges4.filter(b => b.isBridge).map(b => b.name).join(', ');
                        const bridgeForDhcp = await question(`Bridge name for DHCP (${bridgeList4}): `);
                        const range = await question('DHCP range [192.168.100.50,192.168.100.200]: ');
                        await this.startDhcpServer(bridgeForDhcp, { dhcpRange: range || '192.168.100.50,192.168.100.200' });
                        console.log(`\n✓ DHCP server started on ${bridgeForDhcp}`);
                        break;
                        
                    case '9':
                        console.log('Goodbye!');
                        rl.close();
                        return;
                        
                    default:
                        console.log('Invalid choice');
                }
            } catch (error) {
                console.error('\n✗ Error:', error.message || error);
                if (this.debug) console.error(error);
            }
            
            await question('\nPress Enter to continue...');
        }
    }
}

// Export default for ES6 modules
export default Bridge;

// CLI usage if run directly
if (import.meta.url === `file://${process.argv[1]}`) {
    const manager = new Bridge({ debug: false });
    
    const args = process.argv.slice(2);
    
    if (args.length === 0) {
        manager.interactiveMenu().catch(console.error);
    } else {
        const command = args[0];
        
        (async () => {
            try {
                switch(command) {
                    case 'list':
                        const interfaces = await manager.listInterfaces();
                        console.log(JSON.stringify(interfaces, null, 2));
                        break;
                        
                    case 'create':
                        const bridge = await manager.createBridge({
                            name: args[2] || 'br0',
                            ipAddress: args[3] || '192.168.100.1/24',
                            addToInterface: args[4] || null
                        });
                        console.log(JSON.stringify(bridge, null, 2));
                        break;
                        
                    case 'remove':
                        await manager.removeBridge(args[2]);
                        console.log(`Bridge ${args[2]} removed`);
                        break;
                        
                    case 'qemu':
                        const qemuCmd = manager.generateQemuCommand({
                            vmPath: args[2],
                            memory: parseInt(args[3]) || 2048,
                            cpus: parseInt(args[4]) || 2,
                            networking: args[5] || 'bridge'
                        });
                        console.log(qemuCmd.command);
                        break;
                        
                    case 'info':
                        const info = await manager.getSystemInfo();
                        console.log(JSON.stringify(info, null, 2));
                        break;
                        
                    default:
                        console.log('Commands: list, create <name> [ip] [interface], remove <name>, qemu <vm-path>, info');
                }
            } catch (error) {
                console.error('Error:', error.message);
                process.exit(1);
            }
        })();
    }
}