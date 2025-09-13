// network.js
import { exec } from 'child_process';
import os from 'os';
import util from 'util';

const execPromise = util.promisify(exec);

// Constants
const PING_TIMEOUT = 1000;
const ARP_TIMEOUT = 1000;
const NSLOOKUP_TIMEOUT = 1000;
const PARALLEL_LIMITS = {
  ping: 50,
  details: 10
};

// Utility
function withTimeout(promise, timeoutMs) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), timeoutMs))
  ]);
}

export class Network {
  static async #pingIP(ip) {
    const platform = os.platform();
    const command = platform === 'win32'
      ? `ping -n 1 -w ${PING_TIMEOUT} ${ip}`
      : `ping -c 1 -W 1 ${ip}`;
    
    try {
      await withTimeout(execPromise(command), PING_TIMEOUT);
      return { ip, reachable: true };
    } catch {
      return { ip, reachable: false };
    }
  }

  static async #getMACAddress(ip) {
    try {
      const platform = os.platform();
      const command = platform === 'win32'
        ? `arp -a ${ip}`
        : `arp -n ${ip}`;
  
      const { stdout } = await withTimeout(execPromise(command), ARP_TIMEOUT);
      const macRegex = /(([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2}))/;
      const match = stdout.match(macRegex);
      return match ? match[0] : 'Unknown';
    } catch {
      return 'Unknown';
    }
  }

  static async #getHostname(ip) {
    try {
      const { stdout } = await withTimeout(execPromise(`nslookup ${ip}`), NSLOOKUP_TIMEOUT);
      const match = stdout.match(/name = (.+)\./);
      return match ? match[1] : ip;
    } catch {
      return ip;
    }
  }

  static async #processInBatches(items, processFn, batchSize) {
    const results = [];
    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);
      const batchResults = await Promise.allSettled(batch.map(item =>
        processFn(item).catch(e => ({ error: e.message }))
      ));
      results.push(...batchResults.map(r => r.value || r.reason));
    }
    return results;
  }

  static #getAllNetworkInterfaces() {
    const interfaces = os.networkInterfaces();
    const networkInterfaces = [];

    for (const name of Object.keys(interfaces)) {
      for (const net of interfaces[name]) {
        if (net.internal || net.family !== 'IPv4') continue;

        const parts = net.address.split('.');
        const range = `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;

        networkInterfaces.push({
          name,
          address: net.address,
          netmask: net.netmask,
          mac: net.mac,
          family: net.family,
          cidr: net.cidr,
          range
        });
      }
    }

    return networkInterfaces;
  }

  static async #scanNetwork(range, interfaceInfo, log) {
    const baseIP = range.split('.').slice(0, 3).join('.');

    if (log) {
      console.log(`\n🔍 Scanning network: ${range}`);
      console.log(`📡 Interface: ${interfaceInfo.name}`);
      console.log(`📍 IP Address: ${interfaceInfo.address}`);
      console.log(`🔒 Netmask: ${interfaceInfo.netmask}`);
      console.log(`📶 MAC: ${interfaceInfo.mac || 'Unknown'}`);
      console.log(`🌐 Family: ${interfaceInfo.family}`);
      console.log('─'.repeat(60));
    }

    const ips = Array.from({ length: 254 }, (_, i) => `${baseIP}.${i + 1}`);

    const pingResults = await this.#processInBatches(ips, this.#pingIP, PARALLEL_LIMITS.ping);
    const reachableIPs = pingResults.filter(r => r.reachable).map(r => r.ip);

    const detailResults = await this.#processInBatches(
      reachableIPs,
      async (ip) => {
        const [mac, hostname] = await Promise.all([
          this.#getMACAddress(ip),
          this.#getHostname(ip)
        ]);
        return { ip, mac, hostname, status: 'Online' };
      },
      PARALLEL_LIMITS.details
    );

    const result = {
      interface: interfaceInfo,
      range,
      devices: detailResults.filter(Boolean),
      totalScanned: ips.length,
      reachable: reachableIPs.length
    };

    if (log) {
      const scanTime = ((result.scanTime ?? 0) / 1000).toFixed(2);
      console.log(`\n✅ Scan completed`);
      console.log(`📈 Devices found: ${result.devices.length}/${result.totalScanned}`);
      if (result.devices.length > 0) {
        console.log('\n📋 Discovered devices:');
        console.table(result.devices);
      } else {
        console.log('❌ No devices found in this network range.');
      }
      console.log('─'.repeat(60));
    }

    return result;
  }

  static async Scan(config = { log: false }) {
    const log = config.log === true;
    const networkInterfaces = this.#getAllNetworkInterfaces();

    if (log) {
      console.log('🌐 Network Scanner - Starting comprehensive scan...\n');
    }

    if (networkInterfaces.length === 0) {
      if (log) console.log('❌ No active network interfaces found.');
      return [];
    }

    if (log) {
      console.log(`📊 Found ${networkInterfaces.length} network interface(s):`);
      console.log('─'.repeat(60));
    }

    const scanResults = [];

    for (const interfaceInfo of networkInterfaces) {
      const startTime = Date.now();
      const result = await this.#scanNetwork(interfaceInfo.range, interfaceInfo, log);
      result.scanTime = Date.now() - startTime;
      scanResults.push(result);
    }

    if (log) {
      console.log('\n🎯 SCAN SUMMARY');
      console.log('═'.repeat(60));

      let totalDevices = 0;
      let totalScanned = 0;

      scanResults.forEach((result, index) => {
        const scanTimeSec = (result.scanTime / 1000).toFixed(2);
        console.log(`\n${index + 1}. Interface: ${result.interface.name}`);
        console.log(`   Network: ${result.range}`);
        console.log(`   Devices: ${result.devices.length} found (${result.reachable}/${result.totalScanned})`);
        console.log(`   Scan Time: ${scanTimeSec}s`);

        totalDevices += result.devices.length;
        totalScanned += result.totalScanned;
      });

      console.log('\n' + '═'.repeat(60));
      console.log(`📊 TOTAL: ${totalDevices} devices found across ${scanResults.length} network(s)`);
      console.log('✅ Scan completed successfully!');
    }

    return scanResults;
  }
}

export default Network