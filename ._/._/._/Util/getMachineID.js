import { readFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { createHash } from 'crypto';

function getMachineID() {
    // Try primary DMI method
    try {
        if (existsSync('/sys/class/dmi/id/product_uuid')) {
            const uuid = readFileSync('/sys/class/dmi/id/product_uuid', 'utf8').trim();
            if (uuid && uuid.length >= 36) {
                return uuid.toUpperCase();
            }
        }
    } catch {}

    // Fallback 1: /etc/machine-id (Linux)
    try {
        if (existsSync('/etc/machine-id')) {
            const id = readFileSync('/etc/machine-id', 'utf8').trim();
            if (id.length >= 32) return `MACHINE-ID-${id}`;
        }
    } catch {}

    // Fallback 2: CPU info serial (Linux ARM)
    try {
        const cpuinfo = readFileSync('/proc/cpuinfo', 'utf8');
        const lines = cpuinfo.split('\n');
        for (const line of lines) {
            if (line.includes('Serial') && line.includes(':')) {
                const serial = line.split(':')[1].trim();
                if (serial.length > 0) return `CPU-${serial}`;
            }
        }
    } catch {}

    // Fallback 3: MAC address (first network interface)
    try {
        const netPath = '/sys/class/net/';
        const interfaces = execSync(`ls ${netPath}`, { stdio: ['pipe', 'pipe', 'ignore'] })
            .toString()
            .split('\n')
            .filter(iface => iface && !iface.startsWith('lo'));
        
        if (interfaces.length > 0) {
            const mac = readFileSync(`${netPath}${interfaces[0]}/address`, 'utf8').trim();
            if (mac) return `MAC-${mac.replace(/:/g, '').toUpperCase()}`;
        }
    } catch {}

    // Fallback 4: Disk UUID (first disk)
    try {
        const disks = execSync('lsblk -o UUID,MOUNTPOINT -n 2>/dev/null || true', { shell: true })
            .toString()
            .split('\n')
            .filter(line => line && !line.includes('MOUNTPOINT'));
        
        if (disks.length > 0) {
            const diskUuid = disks[0].split(' ')[0].trim();
            if (diskUuid) return `DISK-${diskUuid}`;
        }
    } catch {}

    // Final fallback: Generate hash from hostname + timestamp
    const hostname = typeof window === 'undefined' 
        ? require('os').hostname() 
        : 'browser';
    
    const hash = createHash('sha256')
        .update(hostname + Date.now().toString())
        .digest('hex')
        .substring(0, 32);
    
    return `GEN-${hash.toUpperCase()}`;
}

export default getMachineID;