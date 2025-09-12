import { exec } from 'child_process';
import os from 'os';
import util from 'util';

const execPromise = util.promisify(exec);

// Configuration
const PING_TIMEOUT = 1000; // 1 second per ping
const ARP_TIMEOUT = 1000; // 1 second for ARP lookup
const NSLOOKUP_TIMEOUT = 1000; // 1 second for hostname lookup
const PARALLEL_LIMITS = {
  ping: 50, // Max parallel pings
  details: 10 // Max parallel detail lookups
};

// Timeout wrapper for promises
function withTimeout(promise, timeoutMs) {
  return Promise.race([
    promise,
    new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Timeout')), timeoutMs)
    )
  ]);
}

// Native ping implementation
async function pingIP(ip) {
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

// MAC address lookup
async function getMACAddress(ip) {
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

// Hostname resolution
async function getHostname(ip) {
  try {
    const { stdout } = await withTimeout(execPromise(`nslookup ${ip}`), NSLOOKUP_TIMEOUT);
    const match = stdout.match(/name = (.+)\./);
    return match ? match[1] : ip;
  } catch {
    return ip;
  }
}

// Batch processor with parallel limit
async function processInBatches(items, processFn, batchSize) {
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

// Network scanner for a specific range
async function scanNetwork(range, interfaceInfo) {
  const baseIP = range.split('.')[0] + '.' + 
               range.split('.')[1] + '.' + 
               range.split('.')[2];
  
  console.log(`\n🔍 Scanning network: ${range}`);
  console.log(`📡 Interface: ${interfaceInfo.name}`);
  console.log(`📍 IP Address: ${interfaceInfo.address}`);
  console.log(`🔒 Netmask: ${interfaceInfo.netmask}`);
  console.log(`📶 MAC: ${interfaceInfo.mac || 'Unknown'}`);
  console.log(`🌐 Family: ${interfaceInfo.family}`);
  console.log('─'.repeat(60));

  // Generate all IPs to scan
  const ips = Array.from({length: 254}, (_, i) => `${baseIP}.${i+1}`);

  // First pass: Fast ping scan
  const pingResults = await processInBatches(ips, pingIP, PARALLEL_LIMITS.ping);
  const reachableIPs = pingResults.filter(r => r.reachable).map(r => r.ip);

  // Second pass: Gather details
  const devices = [];
  const detailResults = await processInBatches(
    reachableIPs, 
    async (ip) => {
      try {
        const [mac, hostname] = await Promise.all([
          getMACAddress(ip),
          getHostname(ip)
        ]);
        return { ip, mac, hostname, status: 'Online' };
      } catch {
        return { ip, mac: 'Unknown', hostname: ip, status: 'Unresponsive' };
      }
    },
    PARALLEL_LIMITS.details
  );

  return {
    interface: interfaceInfo,
    range: range,
    devices: detailResults.filter(Boolean),
    totalScanned: ips.length,
    reachable: reachableIPs.length
  };
}

// Get all network interfaces with detailed information
function getAllNetworkInterfaces() {
  const interfaces = os.networkInterfaces();
  const networkInterfaces = [];

  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name]) {
      // Skip internal and non-IPv4 interfaces
      if (net.internal || net.family !== 'IPv4') continue;
      
      const parts = net.address.split('.');
      const range = `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
      
      networkInterfaces.push({
        name: name,
        address: net.address,
        netmask: net.netmask,
        mac: net.mac,
        family: net.family,
        cidr: net.cidr,
        range: range
      });
    }
  }

  return networkInterfaces;
}

// Main function
async function main() {
  try {
    console.log('🌐 Network Scanner - Starting comprehensive scan...\n');
    
    const networkInterfaces = getAllNetworkInterfaces();
    
    if (networkInterfaces.length === 0) {
      console.log('❌ No active network interfaces found.');
      return;
    }

    console.log(`📊 Found ${networkInterfaces.length} network interface(s):`);
    console.log('─'.repeat(60));

    const scanResults = [];

    for (const interfaceInfo of networkInterfaces) {
      const startTime = Date.now();
      const result = await scanNetwork(interfaceInfo.range, interfaceInfo);
      const scanTime = ((Date.now() - startTime)/1000).toFixed(2);
      
      result.scanTime = scanTime;
      scanResults.push(result);

      console.log(`\n✅ Scan completed in ${scanTime} seconds`);
      console.log(`📈 Devices found: ${result.devices.length}/${result.totalScanned}`);
      
      if (result.devices.length > 0) {
        console.log('\n📋 Discovered devices:');
        console.table(result.devices);
      } else {
        console.log('❌ No devices found in this network range.');
      }
      console.log('─'.repeat(60));
    }

    // Summary report
    console.log('\n🎯 SCAN SUMMARY');
    console.log('═'.repeat(60));
    
    let totalDevices = 0;
    let totalScanned = 0;
    
    scanResults.forEach((result, index) => {
      console.log(`\n${index + 1}. Interface: ${result.interface.name}`);
      console.log(`   Network: ${result.range}`);
      console.log(`   Devices: ${result.devices.length} found (${result.reachable}/${result.totalScanned})`);
      console.log(`   Scan Time: ${result.scanTime}s`);
      
      totalDevices += result.devices.length;
      totalScanned += result.totalScanned;
    });

    console.log('\n' + '═'.repeat(60));
    console.log(`📊 TOTAL: ${totalDevices} devices found across ${scanResults.length} network(s)`);
    console.log('✅ Scan completed successfully!');

  } catch (err) {
    console.error('❌ Scan error:', err);
  }
}

// Run the scanner
main();