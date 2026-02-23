// orm.js - Pure Vanilla Node.js ORM with Zero Dependencies
// Uses only native Node.js modules: net, tls, crypto, events, etc.

import net from 'net';
import tls from 'tls';
import EventEmitter from 'events';
import crypto from 'crypto';
import fs from 'fs';

// ==================== PostgreSQL Native Protocol ====================
class PostgreSQLProtocol {
  constructor(config) {
    this.config = config;
    this.socket = null;
    this.params = [];
    this.rowDescription = null;
    this.currentResult = null;
    this.results = [];
    this.buffer = Buffer.alloc(0);
    this.authenticated = false;
    this.encoding = 'utf8';
    this.processId = null;
    this.secretKey = null;
    this.transactionStatus = 'I'; // I = idle, T = transaction, E = error
  }

  // PostgreSQL message types
  static MSG_TYPES = {
    AUTHENTICATION: 'R',
    BACKEND_KEY_DATA: 'K',
    BIND: 'B',
    BIND_COMPLETE: '2',
    CLOSE: 'C',
    CLOSE_COMPLETE: '3',
    COMMAND_COMPLETE: 'C',
    COPY_DATA: 'd',
    COPY_DONE: 'c',
    COPY_FAIL: 'f',
    DATA_ROW: 'D',
    EMPTY_QUERY: 'I',
    ERROR: 'E',
    EXECUTE: 'E',
    FLUSH: 'H',
    FUNCTION_CALL: 'F',
    FUNCTION_CALL_RESPONSE: 'V',
    NEGOTIATE_PROTOCOL: 'v',
    NO_DATA: 'n',
    NOTICE: 'N',
    NOTIFICATION: 'A',
    PARAMETER_DESCRIPTION: 't',
    PARAMETER_STATUS: 'S',
    PARSE: 'P',
    PARSE_COMPLETE: '1',
    PASSWORD: 'p',
    PORTAL_SUSPENDED: 's',
    QUERY: 'Q',
    READY_FOR_QUERY: 'Z',
    ROW_DESCRIPTION: 'T',
    SSL_REQUEST: 'sslv3',
    SYNC: 'S',
    TERMINATE: 'X'
  };

  async connect() {
    return new Promise((resolve, reject) => {
      const port = this.config.port || 5432;
      const host = this.config.host || 'localhost';
      
      // Check if SSL is requested
      if (this.config.ssl) {
        // Start with SSL request
        this.socket = net.createConnection(port, host, () => {
          // Send SSL request (int32: 8, int32: 80877103)
          const sslRequest = Buffer.alloc(8);
          sslRequest.writeInt32BE(8, 0);
          sslRequest.writeInt32BE(80877103, 4);
          this.socket.write(sslRequest);
          
          // Wait for SSL response
          this.socket.once('data', (data) => {
            if (data[0] === 0x53) { // 'S' - SSL supported
              // Upgrade to TLS
              const tlsSocket = tls.connect({
                socket: this.socket,
                rejectUnauthorized: this.config.ssl.rejectUnauthorized !== false
              }, () => {
                this.socket = tlsSocket;
                this.sendStartup();
              });
              tlsSocket.on('error', reject);
            } else {
              reject(new Error('SSL not supported by server'));
            }
          });
        });
      } else {
        this.socket = net.createConnection(port, host, () => {
          this.sendStartup();
        });
      }

      this.socket.on('data', (data) => {
        this.handleData(data);
      });

      this.socket.on('error', reject);
      this.socket.on('close', () => {
        this.authenticated = false;
      });

      // Wait for authentication
      const authTimeout = setTimeout(() => {
        reject(new Error('Authentication timeout'));
      }, this.config.connectionTimeout || 10000);

      this.once('authenticated', () => {
        clearTimeout(authTimeout);
        resolve();
      });
    });
  }

  sendStartup() {
    // Protocol version 3.0 (int32: 196608)
    const startup = {
      user: this.config.user || this.config.username || process.env.USER || '',
      database: this.config.database || this.config.db || '',
      application_name: this.config.application_name || 'nodejs-orm',
      ...this.config.params
    };

    let length = 4 + 4; // Length (int32) + Protocol version (int32)
    const pairs = [];
    
    Object.entries(startup).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        pairs.push(key);
        pairs.push(String(value));
        length += Buffer.byteLength(key, 'utf8') + 1;
        length += Buffer.byteLength(String(value), 'utf8') + 1;
      }
    });
    pairs.push(''); // Terminating null

    const buffer = Buffer.alloc(length + 1);
    let offset = 0;
    buffer.writeInt32BE(length, offset);
    offset += 4;
    buffer.writeInt32BE(196608, offset); // Protocol 3.0
    offset += 4;

    pairs.forEach((str) => {
      const bytes = Buffer.byteLength(str, 'utf8');
      buffer.write(str, offset, bytes, 'utf8');
      offset += bytes;
      buffer[offset] = 0;
      offset += 1;
    });

    this.socket.write(buffer);
  }

  handleData(data) {
    this.buffer = Buffer.concat([this.buffer, data]);
    
    while (this.buffer.length >= 5) {
      const type = String.fromCharCode(this.buffer[0]);
      const length = this.buffer.readInt32BE(1);
      
      if (this.buffer.length < length + 1) break;

      const message = this.buffer.subarray(5, length + 1);
      this.buffer = this.buffer.subarray(length + 1);

      this.processMessage(type, message);
    }
  }

  processMessage(type, message) {
    switch (type) {
      case PostgreSQLProtocol.MSG_TYPES.AUTHENTICATION:
        this.handleAuthentication(message);
        break;
      case PostgreSQLProtocol.MSG_TYPES.BACKEND_KEY_DATA:
        this.processId = message.readInt32BE(0);
        this.secretKey = message.readInt32BE(4);
        break;
      case PostgreSQLProtocol.MSG_TYPES.READY_FOR_QUERY:
        this.transactionStatus = String.fromCharCode(message[0]);
        this.emit('ready');
        break;
      case PostgreSQLProtocol.MSG_TYPES.ROW_DESCRIPTION:
        this.handleRowDescription(message);
        break;
      case PostgreSQLProtocol.MSG_TYPES.DATA_ROW:
        this.handleDataRow(message);
        break;
      case PostgreSQLProtocol.MSG_TYPES.COMMAND_COMPLETE:
        this.handleCommandComplete(message);
        break;
      case PostgreSQLProtocol.MSG_TYPES.PARAMETER_STATUS:
        // Parameter status (ignored)
        break;
      case PostgreSQLProtocol.MSG_TYPES.ERROR:
        this.handleError(message);
        break;
      case PostgreSQLProtocol.MSG_TYPES.NOTICE:
        // Notice (ignored)
        break;
    }
  }

  handleAuthentication(message) {
    const authType = message.readInt32BE(0);
    
    switch (authType) {
      case 0: // AuthenticationOk
        this.authenticated = true;
        this.emit('authenticated');
        break;
      case 3: // AuthenticationCleartextPassword
        this.sendPassword();
        break;
      case 5: // AuthenticationMD5Password
        this.sendMD5Password(message.subarray(4, 8));
        break;
      default:
        this.emit('error', new Error(`Unsupported authentication type: ${authType}`));
    }
  }

  sendPassword() {
    const password = this.config.password || '';
    const buffer = Buffer.alloc(4 + 1 + Buffer.byteLength(password, 'utf8') + 1);
    buffer.writeInt32BE(4 + 1 + Buffer.byteLength(password, 'utf8') + 1, 0);
    buffer[4] = 'p'.charCodeAt(0);
    buffer.write(password, 5, Buffer.byteLength(password, 'utf8'), 'utf8');
    buffer[5 + Buffer.byteLength(password, 'utf8')] = 0;
    this.socket.write(buffer);
  }

  sendMD5Password(salt) {
    const password = this.config.password || '';
    const user = this.config.user || this.config.username || '';
    
    // MD5(md5(password + user) + salt)
    const innerHash = crypto.createHash('md5')
      .update(password + user)
      .digest('hex');
    
    const outerHash = crypto.createHash('md5')
      .update(innerHash + salt.toString('binary'))
      .digest('hex');
    
    const hashedPassword = 'md5' + outerHash;
    
    const buffer = Buffer.alloc(4 + 1 + Buffer.byteLength(hashedPassword, 'utf8') + 1);
    buffer.writeInt32BE(4 + 1 + Buffer.byteLength(hashedPassword, 'utf8') + 1, 0);
    buffer[4] = 'p'.charCodeAt(0);
    buffer.write(hashedPassword, 5, Buffer.byteLength(hashedPassword, 'utf8'), 'utf8');
    buffer[5 + Buffer.byteLength(hashedPassword, 'utf8')] = 0;
    this.socket.write(buffer);
  }

  handleRowDescription(message) {
    const fieldCount = message.readInt16BE(0);
    this.rowDescription = [];
    let offset = 2;
    
    for (let i = 0; i < fieldCount; i++) {
      const nameBytes = [];
      while (offset < message.length && message[offset] !== 0) {
        nameBytes.push(message[offset]);
        offset++;
      }
      const name = Buffer.from(nameBytes).toString('utf8');
      offset++; // Skip null terminator
      
      const tableOid = message.readInt32BE(offset); offset += 4;
      const columnIndex = message.readInt16BE(offset); offset += 2;
      const typeOid = message.readInt32BE(offset); offset += 4;
      const typeSize = message.readInt16BE(offset); offset += 2;
      const typeModifier = message.readInt32BE(offset); offset += 4;
      const formatCode = message.readInt16BE(offset); offset += 2;
      
      this.rowDescription.push({
        name,
        tableOid,
        columnIndex,
        typeOid,
        typeSize,
        typeModifier,
        formatCode
      });
    }
    
    this.currentResult = [];
  }

  handleDataRow(message) {
    const fieldCount = message.readInt16BE(0);
    let offset = 2;
    const row = {};
    
    for (let i = 0; i < fieldCount; i++) {
      const columnLength = message.readInt32BE(offset); offset += 4;
      if (columnLength === -1) {
        row[this.rowDescription[i].name] = null;
      } else {
        const value = message.subarray(offset, offset + columnLength);
        offset += columnLength;
        
        // Basic type conversion
        const typeOid = this.rowDescription[i].typeOid;
        if (typeOid === 20 || typeOid === 21 || typeOid === 23) { // int8, int2, int4
          row[this.rowDescription[i].name] = parseInt(value.toString('utf8'), 10);
        } else if (typeOid === 700 || typeOid === 701) { // float4, float8
          row[this.rowDescription[i].name] = parseFloat(value.toString('utf8'));
        } else if (typeOid === 16) { // bool
          row[this.rowDescription[i].name] = value[0] === 1;
        } else {
          row[this.rowDescription[i].name] = value.toString('utf8');
        }
      }
    }
    
    this.currentResult.push(row);
  }

  handleCommandComplete(message) {
    const tagBytes = [];
    let i = 0;
    while (i < message.length && message[i] !== 0) {
      tagBytes.push(message[i]);
      i++;
    }
    const tag = Buffer.from(tagBytes).toString('utf8');
    
    this.results.push({
      rows: this.currentResult || [],
      command: tag
    });
    
    this.rowDescription = null;
    this.currentResult = null;
  }

  handleError(message) {
    let offset = 0;
    const error = {};
    
    while (offset < message.length) {
      const field = String.fromCharCode(message[offset]); offset++;
      const valueBytes = [];
      while (offset < message.length && message[offset] !== 0) {
        valueBytes.push(message[offset]);
        offset++;
      }
      const value = Buffer.from(valueBytes).toString('utf8');
      offset++; // Skip null
      
      error[field] = value;
    }
    
    const err = new Error(error.M || 'Database error');
    Object.assign(err, error);
    this.emit('error', err);
  }

  async query(sql, params = []) {
    if (params && params.length > 0) {
      return this.extendedQuery(sql, params);
    }
    
    return new Promise((resolve, reject) => {
      const onError = (err) => {
        this.removeListener('ready', onReady);
        reject(err);
      };
      
      const onReady = () => {
        this.removeListener('error', onError);
        this.results = [];
        
        // Simple query
        const buffer = Buffer.alloc(4 + 1 + Buffer.byteLength(sql, 'utf8') + 1);
        buffer.writeInt32BE(4 + 1 + Buffer.byteLength(sql, 'utf8') + 1, 0);
        buffer[4] = 'Q'.charCodeAt(0);
        buffer.write(sql, 5, Buffer.byteLength(sql, 'utf8'), 'utf8');
        buffer[5 + Buffer.byteLength(sql, 'utf8')] = 0;
        
        this.socket.write(buffer);
        
        const resultHandler = () => {
          if (this.results.length > 0) {
            this.removeListener('ready', resultHandler);
            this.removeListener('error', onError);
            resolve(this.results[0].rows);
          }
        };
        
        this.on('ready', resultHandler);
        this.once('error', onError);
      };
      
      if (this.authenticated) {
        onReady();
      } else {
        this.once('authenticated', onReady);
        this.once('error', onError);
      }
    });
  }

  async extendedQuery(sql, params) {
    return new Promise((resolve, reject) => {
      // Parse
      const parseBuffer = this.buildParseMessage(sql, params.length);
      
      // Bind
      const bindBuffer = this.buildBindMessage(params);
      
      // Describe
      const describeBuffer = Buffer.from([0x44, 0x00, 0x00, 0x00, 0x06, 0x50, 0x00, 0x00]); // Describe portal
      
      // Execute
      const executeBuffer = Buffer.from([0x45, 0x00, 0x00, 0x00, 0x09, 0x00, 0x00, 0x00, 0x00, 0x00]); // Execute portal
      
      // Sync
      const syncBuffer = Buffer.from([0x53, 0x00, 0x00, 0x00, 0x04]);
      
      this.results = [];
      
      this.socket.write(Buffer.concat([parseBuffer, bindBuffer, describeBuffer, executeBuffer, syncBuffer]));
      
      const onReady = () => {
        this.removeListener('error', onError);
        resolve(this.results[0]?.rows || []);
      };
      
      const onError = (err) => {
        this.removeListener('ready', onReady);
        reject(err);
      };
      
      this.once('ready', onReady);
      this.once('error', onError);
    });
  }

  buildParseMessage(sql, paramCount) {
    const statementName = '';
    const sqlBytes = Buffer.byteLength(sql, 'utf8');
    const length = 4 + 1 + 1 + sqlBytes + 1 + 2 + (2 * paramCount);
    
    const buffer = Buffer.alloc(length + 1);
    buffer.writeInt32BE(length, 0);
    buffer[4] = 'P'.charCodeAt(0);
    buffer.write(statementName, 5, 0, 'utf8');
    buffer[5] = 0;
    buffer.write(sql, 6, sqlBytes, 'utf8');
    buffer[6 + sqlBytes] = 0;
    
    // Number of parameters
    buffer.writeInt16BE(paramCount, 6 + sqlBytes + 1);
    
    // Parameter types (all text for simplicity)
    for (let i = 0; i < paramCount; i++) {
      buffer.writeInt32BE(25, 6 + sqlBytes + 1 + 2 + (i * 2)); // TEXT oid
    }
    
    return buffer;
  }

  buildBindMessage(params) {
    const portalName = '';
    const statementName = '';
    const paramFormatCodes = Buffer.alloc(params.length * 2, 0); // All text format
    const paramValues = params.map(p => String(p));
    
    let totalLength = 0;
    const paramBuffers = paramValues.map(v => {
      const buf = Buffer.from(v, 'utf8');
      totalLength += buf.length;
      return buf;
    });
    
    const length = 4 + 1 + portalName.length + 1 + statementName.length + 1 + 
                   2 + (params.length * 2) + // Parameter format codes
                   2 + // Result format codes (all text)
                   2 + // Number of parameters
                   (params.length * 4) + totalLength; // Parameter lengths and values
    
    const buffer = Buffer.alloc(length + 1);
    let offset = 0;
    
    buffer.writeInt32BE(length, offset); offset += 4;
    buffer[offset] = 'B'.charCodeAt(0); offset++;
    
    // Portal name
    buffer.write(portalName, offset, 'utf8'); offset += portalName.length;
    buffer[offset] = 0; offset++;
    
    // Statement name
    buffer.write(statementName, offset, 'utf8'); offset += statementName.length;
    buffer[offset] = 0; offset++;
    
    // Parameter format codes
    buffer.writeInt16BE(params.length, offset); offset += 2;
    paramFormatCodes.copy(buffer, offset); offset += paramFormatCodes.length;
    
    // Number of parameters
    buffer.writeInt16BE(params.length, offset); offset += 2;
    
    // Parameter values
    for (let i = 0; i < params.length; i++) {
      const paramBuf = paramBuffers[i];
      buffer.writeInt32BE(paramBuf.length, offset); offset += 4;
      paramBuf.copy(buffer, offset); offset += paramBuf.length;
    }
    
    // Result format codes (all text)
    buffer.writeInt16BE(1, offset); offset += 2;
    buffer.writeInt16BE(0, offset); offset += 2; // Text format
    
    return buffer;
  }

  async execute(sql, params = []) {
    const rows = await this.query(sql, params);
    
    // Try to get insert ID for INSERT statements
    let insertId = null;
    if (sql.trim().toUpperCase().startsWith('INSERT')) {
      // PostgreSQL returns OID or sequence value
      const lastResult = this.results[this.results.length - 1];
      if (lastResult && lastResult.command) {
        const match = lastResult.command.match(/INSERT \d+ (\d+)/);
        if (match) {
          insertId = parseInt(match[1], 10);
        }
      }
    }
    
    return {
      rowsAffected: rows.length,
      insertId
    };
  }

  async transaction(callback) {
    await this.query('BEGIN');
    
    try {
      const result = await callback({
        query: (sql, params) => this.query(sql, params),
        execute: (sql, params) => this.execute(sql, params)
      });
      
      await this.query('COMMIT');
      return result;
    } catch (error) {
      await this.query('ROLLBACK');
      throw error;
    }
  }

  disconnect() {
    if (this.socket) {
      const buffer = Buffer.from([0x58, 0x00, 0x00, 0x00, 0x04]); // Terminate
      this.socket.write(buffer);
      this.socket.end();
    }
  }

  on(event, callback) {
    if (!this._events) this._events = {};
    this._events[event] = callback;
  }

  once(event, callback) {
    const onceWrapper = (...args) => {
      this.removeListener(event, onceWrapper);
      callback(...args);
    };
    this.on(event, onceWrapper);
  }

  emit(event, ...args) {
    if (this._events && this._events[event]) {
      this._events[event](...args);
    }
  }

  removeListener(event, callback) {
    if (this._events && this._events[event] === callback) {
      delete this._events[event];
    }
  }
}

// ==================== MySQL Native Protocol ====================
class MySQLProtocol {
  constructor(config) {
    this.config = config;
    this.socket = null;
    this.sequenceId = 0;
    this.buffer = Buffer.alloc(0);
    this.authenticated = false;
    this.serverCapabilities = 0;
    this.connectionId = 0;
    this.authPluginData = null;
    this.charset = 33; // utf8_general_ci
    this.status = 0;
  }

  async connect() {
    return new Promise((resolve, reject) => {
      const port = this.config.port || 3306;
      const host = this.config.host || 'localhost';
      
      this.socket = net.createConnection(port, host, () => {
        // Wait for initial handshake
      });

      this.socket.on('data', (data) => {
        this.handleData(data);
      });

      this.socket.on('error', reject);
      
      // Wait for handshake
      this.once('handshake', (handshake) => {
        this.sendHandshakeResponse()
          .then(() => {
            this.once('ok', () => {
              this.authenticated = true;
              resolve();
            });
          })
          .catch(reject);
      });
    });
  }

  handleData(data) {
    this.buffer = Buffer.concat([this.buffer, data]);
    
    while (this.buffer.length >= 4) {
      const packetLength = this.buffer.readUInt32LE(0) & 0xFFFFFF; // First 3 bytes
      const packetSequence = this.buffer[3];
      
      if (this.buffer.length < packetLength + 4) break;
      
      const packet = this.buffer.subarray(4, packetLength + 4);
      this.buffer = this.buffer.subarray(packetLength + 4);
      
      this.processPacket(packet, packetSequence);
    }
  }

  processPacket(packet, sequence) {
    const firstByte = packet[0];
    
    if (sequence === 0 && this.sequenceId === 0) {
      // Initial handshake
      this.handleHandshake(packet);
    } else if (firstByte === 0x00) {
      // OK packet
      this.handleOK(packet);
    } else if (firstByte === 0xFF) {
      // Error packet
      this.handleError(packet);
    } else if (firstByte === 0xFB) {
      // EOF packet
      this.handleEOF(packet);
    } else {
      // Result set
      this.handleResultSet(packet);
    }
  }

  handleHandshake(packet) {
    const protocol = packet[0];
    this.serverVersion = this.readNullTerminatedString(packet, 1);
    let offset = 1 + this.serverVersion.length + 1;
    
    this.connectionId = packet.readUInt32LE(offset); offset += 4;
    
    // Auth plugin data part 1 (8 bytes)
    this.authPluginData = packet.subarray(offset, offset + 8); offset += 8;
    
    // Filler
    offset += 1;
    
    // Capability flags (lower 2 bytes)
    const capabilityLower = packet.readUInt16LE(offset); offset += 2;
    
    this.charset = packet[offset]; offset += 1;
    this.status = packet.readUInt16LE(offset); offset += 2;
    
    // Capability flags (upper 2 bytes)
    const capabilityUpper = packet.readUInt16LE(offset); offset += 2;
    
    this.serverCapabilities = capabilityLower | (capabilityUpper << 16);
    
    // Auth plugin data length
    const authPluginDataLength = packet[offset]; offset += 1;
    
    // Reserved
    offset += 10;
    
    // Auth plugin data part 2 (max 13 bytes)
    if (this.serverCapabilities & 0x00080000) { // CLIENT_PLUGIN_AUTH
      const remainingData = packet.subarray(offset, offset + Math.max(13, authPluginDataLength - 8));
      this.authPluginData = Buffer.concat([this.authPluginData, remainingData]);
    }
    
    // Auth plugin name
    if (this.serverCapabilities & 0x00080000) {
      this.authPluginName = this.readNullTerminatedString(packet, offset + Math.max(13, authPluginDataLength - 8));
    }
    
    this.emit('handshake', {
      protocol,
      serverVersion: this.serverVersion,
      connectionId: this.connectionId,
      serverCapabilities: this.serverCapabilities,
      charset: this.charset,
      status: this.status,
      authPluginData: this.authPluginData,
      authPluginName: this.authPluginName
    });
  }

  async sendHandshakeResponse() {
    const capabilities = 0x00000001 | // CLIENT_LONG_PASSWORD
                        0x00000002 | // CLIENT_FOUND_ROWS
                        0x00000004 | // CLIENT_LONG_FLAG
                        0x00000800 | // CLIENT_PROTOCOL_41
                        0x00020000 | // CLIENT_SECURE_CONNECTION
                        0x00080000 | // CLIENT_PLUGIN_AUTH
                        0x00200000 | // CLIENT_MULTI_STATEMENTS
                        0x00400000;  // CLIENT_MULTI_RESULTS
    
    const maxPacketSize = 0x1000000;
    const charset = this.config.charset || 33; // utf8_general_ci
    const username = this.config.user || this.config.username || '';
    const password = this.config.password || '';
    const database = this.config.database || this.config.db || '';
    
    // Build auth response
    let authResponse;
    if (this.authPluginName === 'mysql_native_password') {
      authResponse = this.mysqlNativePassword(password, this.authPluginData);
    } else {
      authResponse = Buffer.from(password, 'utf8');
    }
    
    // Calculate packet length
    let length = 32 + // Fixed header
                username.length + 1;
    
    if (this.serverCapabilities & 0x00080000) { // CLIENT_PLUGIN_AUTH
      length += authResponse.length + 1;
    } else {
      length += authResponse.length;
    }
    
    if (database) {
      length += database.length + 1;
    }
    
    if (this.authPluginName) {
      length += this.authPluginName.length + 1;
    }
    
    const packet = Buffer.alloc(length);
    let offset = 0;
    
    packet.writeUInt32LE(capabilities, offset); offset += 4;
    packet.writeUInt32LE(maxPacketSize, offset); offset += 4;
    packet[offset] = charset; offset += 1;
    
    // Reserved (23 bytes)
    for (let i = 0; i < 23; i++) {
      packet[offset] = 0; offset++;
    }
    
    // Username
    packet.write(username, offset, 'utf8'); offset += username.length;
    packet[offset] = 0; offset++;
    
    // Auth response length
    packet[offset] = authResponse.length; offset++;
    
    // Auth response
    authResponse.copy(packet, offset); offset += authResponse.length;
    
    if (!(this.serverCapabilities & 0x00080000)) {
      packet[offset] = 0; offset++;
    }
    
    // Database
    if (database) {
      packet.write(database, offset, 'utf8'); offset += database.length;
      packet[offset] = 0; offset++;
    }
    
    // Auth plugin name
    if (this.authPluginName && (this.serverCapabilities & 0x00080000)) {
      packet.write(this.authPluginName, offset, 'utf8'); offset += this.authPluginName.length;
      packet[offset] = 0; offset++;
    }
    
    await this.writePacket(packet);
  }

  mysqlNativePassword(password, scramble) {
    if (!password) return Buffer.alloc(0);
    
    // SHA1(password)
    const hash1 = crypto.createHash('sha1').update(password, 'utf8').digest();
    
    // SHA1(SHA1(password))
    const hash2 = crypto.createHash('sha1').update(hash1).digest();
    
    // SHA1(scramble + hash2)
    const hash3 = crypto.createHash('sha1')
      .update(Buffer.concat([scramble, hash2]))
      .digest();
    
    // XOR hash1 with hash3
    const result = Buffer.alloc(hash1.length);
    for (let i = 0; i < hash1.length; i++) {
      result[i] = hash1[i] ^ hash3[i];
    }
    
    return result;
  }

  handleOK(packet) {
    const ok = {
      affectedRows: packet[1] < 0xFB ? packet[1] : packet.readUInt16LE(1),
      insertId: 0,
      serverStatus: 0,
      warningCount: 0,
      message: ''
    };
    
    let offset = 1;
    
    if (packet[1] === 0xFB) {
      offset += 2;
      ok.affectedRows = packet.readUInt16LE(offset - 2);
    } else {
      offset += 1;
    }
    
    if (packet[offset] === 0xFB) {
      offset += 2;
      ok.insertId = packet.readUInt16LE(offset - 2);
    } else {
      ok.insertId = packet[offset]; offset++;
    }
    
    ok.serverStatus = packet.readUInt16LE(offset); offset += 2;
    ok.warningCount = packet.readUInt16LE(offset); offset += 2;
    
    if (offset < packet.length) {
      ok.message = packet.toString('utf8', offset);
    }
    
    this.emit('ok', ok);
  }

  handleError(packet) {
    const err = new Error();
    err.code = packet.readUInt16LE(1);
    err.sqlState = packet.toString('ascii', 3, 8);
    err.message = packet.toString('utf8', 9);
    this.emit('error', err);
  }

  handleEOF(packet) {
    const eof = {
      warningCount: packet.readUInt16LE(1),
      serverStatus: packet.readUInt16LE(3)
    };
    this.emit('eof', eof);
  }

  handleResultSet(packet) {
    // Simplified result set handling
    this.emit('result', packet);
  }

  readNullTerminatedString(buffer, start) {
    let end = start;
    while (end < buffer.length && buffer[end] !== 0) {
      end++;
    }
    return buffer.toString('utf8', start, end);
  }

  async writePacket(data) {
    const header = Buffer.alloc(4);
    header.writeUInt32LE((data.length << 8) | this.sequenceId, 0);
    this.sequenceId = (this.sequenceId + 1) & 0xFF;
    
    this.socket.write(Buffer.concat([header, data]));
  }

  async query(sql, params = []) {
    if (params && params.length > 0) {
      // Prepare statement (simplified - in production you'd use prepared statements)
      sql = this.prepareQuery(sql, params);
    }
    
    return new Promise((resolve, reject) => {
      const results = [];
      let currentRow = null;
      let columns = [];
      
      const onResult = (packet) => {
        if (packet[0] === 0x00) { // OK packet
          // End of result set
          this.removeListener('result', onResult);
          this.removeListener('error', onError);
          this.removeListener('eof', onEOF);
          resolve(results);
        } else if (packet[0] === 0xFB) { // EOF packet
          // End of field definition
        } else {
          // Column definition or data row
          if (columns.length === 0) {
            // Column definition
            const column = this.parseColumnDefinition(packet);
            columns.push(column);
          } else if (!currentRow) {
            // Data row
            currentRow = this.parseRowData(packet, columns);
          }
        }
      };
      
      const onEOF = (eof) => {
        if (currentRow) {
          results.push(currentRow);
          currentRow = null;
        } else if (columns.length > 0) {
          // End of column definitions
          columns = [];
        }
      };
      
      const onError = (err) => {
        this.removeListener('result', onResult);
        this.removeListener('eof', onEOF);
        this.removeListener('error', onError);
        reject(err);
      };
      
      this.on('result', onResult);
      this.on('eof', onEOF);
      this.once('error', onError);
      
      // Send query
      const queryPacket = Buffer.alloc(1 + Buffer.byteLength(sql, 'utf8') + 1);
      queryPacket[0] = 0x03; // COM_QUERY
      queryPacket.write(sql, 1, Buffer.byteLength(sql, 'utf8'), 'utf8');
      
      this.writePacket(queryPacket).catch(onError);
    });
  }

  parseColumnDefinition(packet) {
    return {
      catalog: this.readLengthEncodedString(packet, 0),
      schema: this.readLengthEncodedString(packet),
      table: this.readLengthEncodedString(packet),
      orgTable: this.readLengthEncodedString(packet),
      name: this.readLengthEncodedString(packet),
      orgName: this.readLengthEncodedString(packet),
      charset: packet.readUInt16LE(),
      columnLength: packet.readUInt32LE(),
      type: packet[0],
      flags: packet.readUInt16LE(),
      decimals: packet[0]
    };
  }

  parseRowData(packet, columns) {
    const row = {};
    let offset = 0;
    
    for (const column of columns) {
      const len = this.readLengthEncodedNumber(packet, offset);
      offset += len.bytes;
      
      if (len.value === null) {
        row[column.name] = null;
      } else {
        const value = packet.toString('utf8', offset, offset + len.value);
        offset += len.value;
        row[column.name] = value;
      }
    }
    
    return row;
  }

  readLengthEncodedString(buffer, start = 0) {
    const len = this.readLengthEncodedNumber(buffer, start);
    if (len.value === null) return null;
    
    const str = buffer.toString('utf8', start + len.bytes, start + len.bytes + len.value);
    return { value: str, bytes: len.bytes + len.value };
  }

  readLengthEncodedNumber(buffer, start = 0) {
    const first = buffer[start];
    
    if (first < 0xFB) {
      return { value: first, bytes: 1 };
    } else if (first === 0xFC) {
      return { value: buffer.readUInt16LE(start + 1), bytes: 3 };
    } else if (first === 0xFD) {
      return { value: buffer.readUInt32LE(start + 1) & 0xFFFFFF, bytes: 4 };
    } else if (first === 0xFE) {
      return { value: buffer.readUInt32LE(start + 1), bytes: 9 };
    } else if (first === 0xFB) {
      return { value: null, bytes: 1 };
    }
  }

  prepareQuery(sql, params) {
    let preparedSql = sql;
    let paramIndex = 0;
    
    preparedSql = preparedSql.replace(/\?/g, () => {
      const param = params[paramIndex++];
      if (typeof param === 'string') {
        return `'${param.replace(/'/g, "''")}'`;
      } else if (param === null) {
        return 'NULL';
      } else if (Buffer.isBuffer(param)) {
        return `X'${param.toString('hex')}'`;
      } else {
        return String(param);
      }
    });
    
    return preparedSql;
  }

  async execute(sql, params = []) {
    const rows = await this.query(sql, params);
    
    return {
      rowsAffected: rows.length,
      insertId: rows.insertId || 0
    };
  }

  async transaction(callback) {
    await this.query('START TRANSACTION');
    
    try {
      const result = await callback({
        query: (sql, params) => this.query(sql, params),
        execute: (sql, params) => this.execute(sql, params)
      });
      
      await this.query('COMMIT');
      return result;
    } catch (error) {
      await this.query('ROLLBACK');
      throw error;
    }
  }

  disconnect() {
    if (this.socket) {
      const packet = Buffer.from([0x01]); // COM_QUIT
      this.writePacket(packet).then(() => {
        this.socket.end();
      });
    }
  }

  on(event, callback) {
    if (!this._events) this._events = {};
    this._events[event] = callback;
  }

  once(event, callback) {
    const onceWrapper = (...args) => {
      this.removeListener(event, onceWrapper);
      callback(...args);
    };
    this.on(event, onceWrapper);
  }

  emit(event, ...args) {
    if (this._events && this._events[event]) {
      this._events[event](...args);
    }
  }

  removeListener(event, callback) {
    if (this._events && this._events[event] === callback) {
      delete this._events[event];
    }
  }
}

// ==================== SQLite Native Protocol ====================
// SQLite is file-based, so we use the native fs module
// ==================== SQLite Native Protocol (Fixed) ====================
class SQLiteProtocol {
  constructor(config) {
    this.fs = fs;
    this.filename = config.filename || ':memory:';
    this.fd = null;
    this.pageSize = 4096;
    this.database = null;
    this.statements = new Map();
    this._events = {};
  }

  async connect() {
    if (this.filename === ':memory:') {
      // In-memory database
      this.database = {
        tables: new Map(),
        data: new Map(),
        rowId: 1
      };
      return Promise.resolve();
    }
    
    return new Promise((resolve, reject) => {
      // Check if file exists
      this.fs.access(this.filename, this.fs.constants.F_OK, (err) => {
        if (err) {
          // File doesn't exist, create it
          this.fs.open(this.filename, 'w+', (err, fd) => {
            if (err) {
              reject(err);
            } else {
              this.fd = fd;
              this.initializeDatabase();
              resolve();
            }
          });
        } else {
          // File exists, open for reading and writing
          this.fs.open(this.filename, 'r+', (err, fd) => {
            if (err) {
              reject(err);
            } else {
              this.fd = fd;
              this.readDatabase();
              resolve();
            }
          });
        }
      });
    });
  }

  initializeDatabase() {
    // Write SQLite header
    const header = Buffer.alloc(100);
    header.write('SQLite format 3\0', 0);
    header.writeUInt32BE(1, 18); // File change counter
    header.writeUInt32BE(0, 28); // First freelist trunk page
    header.writeUInt32BE(0, 32); // Number of freelist pages
    header.writeUInt32BE(2, 36); // Schema cookie
    header.writeUInt32BE(0, 40); // Schema format number
    header.writeUInt32BE(0, 44); // Default page cache size
    header.writeUInt32BE(0, 48); // Largest root b-tree page
    header.writeUInt32BE(1, 52); // Text encoding (UTF-8)
    header.writeUInt32BE(0, 56); // User version
    header.writeUInt32BE(0, 60); // Incremental vacuum mode
    header.writeUInt32BE(0, 64); // Application ID
    header.fill(0, 68, 72);      // Reserved
    header.writeUInt32BE(0, 72); // Version valid for
    header.writeUInt32BE(2, 76); // SQLite version (3.x)
    
    // Write header to file
    this.fs.writeSync(this.fd, header, 0, 100, 0);
    
    // Initialize in-memory structure
    this.database = {
      tables: new Map(),
      data: new Map(),
      rowId: 1
    };
  }

  readDatabase() {
    // For this demo, we'll just initialize an empty structure
    // In a real implementation, you would parse the SQLite file
    this.database = {
      tables: new Map(),
      data: new Map(),
      rowId: 1
    };
  }

  async query(sql, params = []) {
    // Normalize SQL and remove multiple spaces
    sql = sql.replace(/\s+/g, ' ').trim();
    
    try {
      const results = this.executeSQL(sql, params);
      return results;
    } catch (error) {
      console.error('SQL Error:', error.message);
      console.error('SQL:', sql);
      console.error('Params:', params);
      throw error;
    }
  }

  executeSQL(sql, params) {
    const normalizedSql = sql.toUpperCase();
    const results = [];
    
    // Parse SQL command
    if (normalizedSql.startsWith('SELECT')) {
      return this.executeSelect(sql, params);
    } else if (normalizedSql.startsWith('INSERT')) {
      return this.executeInsert(sql, params);
    } else if (normalizedSql.startsWith('UPDATE')) {
      return this.executeUpdate(sql, params);
    } else if (normalizedSql.startsWith('DELETE')) {
      return this.executeDelete(sql, params);
    } else if (normalizedSql.startsWith('CREATE TABLE')) {
      return this.executeCreateTable(sql);
    } else if (normalizedSql.startsWith('DROP TABLE')) {
      return this.executeDropTable(sql);
    } else if (normalizedSql.startsWith('PRAGMA')) {
      return this.executePragma(sql);
    }
    
    return results;
  }

  executeSelect(sql, params) {
    const results = [];
    const fromMatch = sql.match(/FROM\s+(\w+)/i);
    const whereMatch = sql.match(/WHERE\s+(.+?)(?:\s+ORDER\s+BY|\s+GROUP\s+BY|\s+LIMIT|$)/i);
    const orderMatch = sql.match(/ORDER\s+BY\s+(.+?)(?:\s+LIMIT|$)/i);
    const groupMatch = sql.match(/GROUP\s+BY\s+(.+?)(?:\s+HAVING|\s+ORDER\s+BY|\s+LIMIT|$)/i);
    const limitMatch = sql.match(/LIMIT\s+(\d+)(?:\s+OFFSET\s+(\d+))?/i);
    const selectMatch = sql.match(/SELECT\s+(.+?)\s+FROM/i);
    
    if (!fromMatch || !selectMatch) return [];
    
    const tableName = fromMatch[1];
    const tableData = this.database.data.get(tableName) || [];
    
    // Parse SELECT fields
    const fields = selectMatch[1].split(',').map(f => f.trim());
    
    // Handle COUNT(*) specially
    if (fields.length === 1 && fields[0].toUpperCase().includes('COUNT(*)')) {
      const count = tableData.length;
      return [{ 'COUNT(*)': count }];
    }
    
    // Handle SUM, AVG, etc.
    if (fields.length === 1 && fields[0].toUpperCase().includes('SUM(')) {
      const fieldMatch = fields[0].match(/SUM\((\w+)\)/i);
      if (fieldMatch) {
        const field = fieldMatch[1];
        const sum = tableData.reduce((acc, row) => acc + (Number(row[field]) || 0), 0);
        return [{ [`SUM(${field})`]: sum }];
      }
    }
    
    if (fields.length === 1 && fields[0].toUpperCase().includes('AVG(')) {
      const fieldMatch = fields[0].match(/AVG\((\w+)\)/i);
      if (fieldMatch) {
        const field = fieldMatch[1];
        const sum = tableData.reduce((acc, row) => acc + (Number(row[field]) || 0), 0);
        const avg = tableData.length > 0 ? sum / tableData.length : 0;
        return [{ [`AVG(${field})`]: avg }];
      }
    }
    
    let filteredData = [...tableData];
    
    // Apply WHERE clause
    if (whereMatch) {
      const condition = whereMatch[1];
      filteredData = filteredData.filter(row => {
        return this.evaluateCondition(row, condition, params);
      });
    }
    
    // Apply GROUP BY
    if (groupMatch) {
      const groupField = groupMatch[1].trim();
      const groups = new Map();
      
      filteredData.forEach(row => {
        const key = row[groupField];
        if (!groups.has(key)) {
          groups.set(key, []);
        }
        groups.get(key).push(row);
      });
      
      // Convert groups back to array for further processing
      filteredData = Array.from(groups.entries()).map(([key, rows]) => {
        const result = { [groupField]: key };
        
        // If there are aggregate functions in SELECT, compute them
        if (fields.length > 1 || fields[0].includes('COUNT') || fields[0].includes('SUM')) {
          fields.forEach(field => {
            field = field.trim();
            if (field.toUpperCase().includes('COUNT(')) {
              const countField = field.match(/COUNT\((\w+)\)/i)?.[1] || '*';
              result[field] = rows.length;
            } else if (field.toUpperCase().includes('SUM(')) {
              const sumField = field.match(/SUM\((\w+)\)/i)[1];
              result[field] = rows.reduce((acc, row) => acc + (Number(row[sumField]) || 0), 0);
            } else if (field.toUpperCase().includes('AVG(')) {
              const avgField = field.match(/AVG\((\w+)\)/i)[1];
              const sum = rows.reduce((acc, row) => acc + (Number(row[avgField]) || 0), 0);
              result[field] = rows.length > 0 ? sum / rows.length : 0;
            } else if (field !== groupField) {
              result[field] = rows[0][field];
            }
          });
        }
        
        return result;
      });
    }
    
    // Apply ORDER BY
    if (orderMatch && !groupMatch) { // Skip if we already grouped
      const orderClause = orderMatch[1];
      const [field, direction] = orderClause.split(/\s+/);
      const desc = direction && direction.toUpperCase() === 'DESC';
      
      filteredData.sort((a, b) => {
        if (a[field] < b[field]) return desc ? 1 : -1;
        if (a[field] > b[field]) return desc ? -1 : 1;
        return 0;
      });
    }
    
    // Apply LIMIT/OFFSET
    if (limitMatch) {
      const limit = parseInt(limitMatch[1], 10);
      const offset = limitMatch[2] ? parseInt(limitMatch[2], 10) : 0;
      filteredData = filteredData.slice(offset, offset + limit);
    }
    
    // Format results based on SELECT fields
    filteredData.forEach(row => {
      if (fields[0] === '*') {
        results.push({ ...row });
      } else {
        const resultRow = {};
        fields.forEach(field => {
          field = field.trim();
          if (field.includes(' as ') || field.includes(' AS ')) {
            const [expr, alias] = field.split(/\s+as\s+/i);
            resultRow[alias] = row[expr.trim()];
          } else {
            resultRow[field] = row[field];
          }
        });
        results.push(resultRow);
      }
    });
    
    return results;
  }

  executeInsert(sql, params) {
    const tableMatch = sql.match(/INTO\s+(\w+)/i);
    const valuesMatch = sql.match(/VALUES\s*\((.+?)\)/i);
    
    if (!tableMatch || !valuesMatch) return [];
    
    const tableName = tableMatch[1];
    
    // Parse column names if provided
    const columnsMatch = sql.match(/\((\w+(?:,\s*\w+)*)\)\s+VALUES/i);
    let columns = [];
    
    if (columnsMatch) {
      columns = columnsMatch[1].split(',').map(c => c.trim());
    }
    
    // Parse values
    const valuesStr = valuesMatch[1];
    const valueMatches = this.parseValueList(valuesStr);
    
    let paramIndex = 0;
    const values = valueMatches.map(v => {
      v = v.trim();
      if (v === '?') {
        return params[paramIndex++];
      } else if (v.startsWith("'") && v.endsWith("'")) {
        return v.substring(1, v.length - 1);
      } else if (v === 'NULL') {
        return null;
      } else if (v === 'true' || v === 'false') {
        return v === 'true';
      } else if (!isNaN(v)) {
        return Number(v);
      }
      return v;
    });
    
    // If no columns specified, assume all columns in order
    if (columns.length === 0) {
      // Get table schema to know columns
      const table = this.database.tables.get(tableName);
      if (table) {
        columns = table.map(col => col.name);
      }
    }
    
    const tableData = this.database.data.get(tableName) || [];
    const newRow = { id: this.database.rowId++ };
    
    // Map values to columns
    columns.forEach((col, index) => {
      newRow[col] = values[index];
    });
    
    tableData.push(newRow);
    this.database.data.set(tableName, tableData);
    
    return [{ insertId: newRow.id }];
  }

  parseValueList(valuesStr) {
    const values = [];
    let current = '';
    let inQuotes = false;
    let quoteChar = '';
    
    for (let i = 0; i < valuesStr.length; i++) {
      const char = valuesStr[i];
      
      if ((char === "'" || char === '"') && (i === 0 || valuesStr[i-1] !== '\\')) {
        if (!inQuotes) {
          inQuotes = true;
          quoteChar = char;
          current += char;
        } else if (char === quoteChar) {
          inQuotes = false;
          quoteChar = '';
          current += char;
        } else {
          current += char;
        }
      } else if (char === ',' && !inQuotes) {
        values.push(current);
        current = '';
      } else {
        current += char;
      }
    }
    
    if (current) {
      values.push(current);
    }
    
    return values;
  }

  executeUpdate(sql, params) {
    const tableMatch = sql.match(/UPDATE\s+(\w+)/i);
    const setMatch = sql.match(/SET\s+(.+?)(?:\s+WHERE|$)/i);
    const whereMatch = sql.match(/WHERE\s+(.+?)$/i);
    
    if (!tableMatch || !setMatch) return [];
    
    const tableName = tableMatch[1];
    const setClause = setMatch[1];
    const tableData = this.database.data.get(tableName) || [];
    let updatedCount = 0;
    
    // Parse SET assignments
    const assignments = [];
    const setParts = setClause.split(',');
    
    let paramIndex = 0;
    setParts.forEach(part => {
      const [field, value] = part.split('=').map(p => p.trim());
      let parsedValue = value;
      
      if (value === '?') {
        parsedValue = params[paramIndex++];
      } else if (value.startsWith("'") && value.endsWith("'")) {
        parsedValue = value.substring(1, value.length - 1);
      } else if (value === 'NULL') {
        parsedValue = null;
      } else if (value === 'true' || value === 'false') {
        parsedValue = value === 'true';
      } else if (!isNaN(value)) {
        parsedValue = Number(value);
      }
      
      assignments.push({ field, value: parsedValue });
    });
    
    // Apply updates
    tableData.forEach(row => {
      let shouldUpdate = true;
      
      if (whereMatch) {
        shouldUpdate = this.evaluateCondition(row, whereMatch[1], params);
      }
      
      if (shouldUpdate) {
        assignments.forEach(({ field, value }) => {
          row[field] = value;
        });
        updatedCount++;
      }
    });
    
    return [{ affectedRows: updatedCount }];
  }

  executeDelete(sql, params) {
    const tableMatch = sql.match(/FROM\s+(\w+)/i);
    const whereMatch = sql.match(/WHERE\s+(.+?)$/i);
    
    if (!tableMatch) return [];
    
    const tableName = tableMatch[1];
    const tableData = this.database.data.get(tableName) || [];
    const initialLength = tableData.length;
    
    let filteredData;
    if (whereMatch) {
      filteredData = tableData.filter(row => 
        !this.evaluateCondition(row, whereMatch[1], params)
      );
    } else {
      filteredData = [];
    }
    
    this.database.data.set(tableName, filteredData);
    
    const deletedCount = initialLength - filteredData.length;
    return [{ affectedRows: deletedCount }];
  }

  executeCreateTable(sql) {
    const tableMatch = sql.match(/CREATE\s+TABLE\s+(\w+)/i);
    const columnsMatch = sql.match(/\((.+)\)/s);
    
    if (!tableMatch || !columnsMatch) return [];
    
    const tableName = tableMatch[1];
    const columnsStr = columnsMatch[1];
    
    // Parse columns
    const columnDefs = [];
    const columnParts = columnsStr.split(',').map(c => c.trim());
    
    columnParts.forEach(part => {
      const parts = part.split(/\s+/);
      const column = {
        name: parts[0],
        type: parts[1].toUpperCase(),
        primaryKey: part.toUpperCase().includes('PRIMARY KEY'),
        nullable: !part.toUpperCase().includes('NOT NULL'),
        autoIncrement: part.toUpperCase().includes('AUTOINCREMENT')
      };
      columnDefs.push(column);
    });
    
    this.database.tables.set(tableName, columnDefs);
    this.database.data.set(tableName, []);
    
    return [];
  }

  executeDropTable(sql) {
    const tableMatch = sql.match(/DROP\s+TABLE\s+(\w+)/i);
    
    if (!tableMatch) return [];
    
    const tableName = tableMatch[1];
    
    this.database.tables.delete(tableName);
    this.database.data.delete(tableName);
    
    return [];
  }

  executePragma(sql) {
    const pragmaMatch = sql.match(/PRAGMA\s+(\w+)/i);
    
    if (!pragmaMatch) return [];
    
    const pragma = pragmaMatch[1];
    
    if (pragma === 'table_info') {
      const tableMatch = sql.match(/table_info\((\w+)\)/i);
      if (tableMatch) {
        const tableName = tableMatch[1];
        const table = this.database.tables.get(tableName) || [];
        return table.map((col, index) => ({
          cid: index,
          name: col.name,
          type: col.type,
          notnull: col.nullable ? 0 : 1,
          dflt_value: null,
          pk: col.primaryKey ? 1 : 0
        }));
      }
    }
    
    return [];
  }

  evaluateCondition(row, condition, params) {
    // Handle AND conditions
    if (condition.toUpperCase().includes(' AND ')) {
      const parts = condition.split(/\s+AND\s+/i);
      return parts.every(part => this.evaluateSingleCondition(row, part, params));
    }
    
    // Handle OR conditions
    if (condition.toUpperCase().includes(' OR ')) {
      const parts = condition.split(/\s+OR\s+/i);
      return parts.some(part => this.evaluateSingleCondition(row, part, params));
    }
    
    return this.evaluateSingleCondition(row, condition, params);
  }

  evaluateSingleCondition(row, condition, params) {
    const operators = ['>=', '<=', '!=', '<>', '=', '<', '>', ' LIKE ', ' IN '];
    
    for (const op of operators) {
      const opIndex = condition.indexOf(op.trim());
      if (opIndex > 0) {
        const field = condition.substring(0, opIndex).trim();
        let value = condition.substring(opIndex + op.length).trim();
        
        // Handle IN operator specially
        if (op.trim() === 'IN') {
          const inList = value.substring(1, value.length - 1).split(',').map(v => {
            v = v.trim();
            if (v === '?') {
              return params.shift();
            }
            if (v.startsWith("'") && v.endsWith("'")) {
              return v.substring(1, v.length - 1);
            }
            return v;
          });
          return inList.includes(row[field]);
        }
        
        // Handle LIKE operator
        if (op.trim() === 'LIKE') {
          if (value === '?') {
            value = params.shift();
          } else if (value.startsWith("'") && value.endsWith("'")) {
            value = value.substring(1, value.length - 1);
          }
          const pattern = value.replace(/%/g, '.*');
          const regex = new RegExp(`^${pattern}$`, 'i');
          return regex.test(String(row[field]));
        }
        
        // Handle comparison operators
        if (value === '?') {
          value = params.shift();
        } else if (value.startsWith("'") && value.endsWith("'")) {
          value = value.substring(1, value.length - 1);
        } else if (value === 'NULL') {
          value = null;
        } else if (value === 'true' || value === 'false') {
          value = value === 'true';
        } else if (!isNaN(value)) {
          value = Number(value);
        }
        
        const rowValue = row[field];
        
        switch (op.trim()) {
          case '=': return rowValue == value;
          case '!=': case '<>': return rowValue != value;
          case '<': return rowValue < value;
          case '>': return rowValue > value;
          case '<=': return rowValue <= value;
          case '>=': return rowValue >= value;
        }
      }
    }
    
    return true;
  }

  async execute(sql, params = []) {
    const results = await this.query(sql, params);
    
    let rowsAffected = 0;
    let insertId = null;
    
    if (results.length > 0) {
      if (results[0].affectedRows !== undefined) {
        rowsAffected = results[0].affectedRows;
      } else if (results[0].insertId !== undefined) {
        insertId = results[0].insertId;
        rowsAffected = 1;
      } else {
        rowsAffected = results.length;
      }
    }
    
    return { rowsAffected, insertId };
  }

  async transaction(callback) {
    // Simple transaction support
    const savepoint = `sp_${Date.now()}`;
    
    try {
      await this.query(`SAVEPOINT ${savepoint}`);
      
      const result = await callback({
        query: (sql, params) => this.query(sql, params),
        execute: (sql, params) => this.execute(sql, params)
      });
      
      await this.query(`RELEASE ${savepoint}`);
      return result;
    } catch (error) {
      await this.query(`ROLLBACK TO ${savepoint}`);
      throw error;
    }
  }

  disconnect() {
    if (this.fd) {
      this.fs.closeSync(this.fd);
      this.fd = null;
    }
    this.database = null;
  }

  on(event, callback) {
    if (!this._events) this._events = {};
    this._events[event] = callback;
  }

  once(event, callback) {
    const onceWrapper = (...args) => {
      this.removeListener(event, onceWrapper);
      callback(...args);
    };
    this.on(event, onceWrapper);
  }

  emit(event, ...args) {
    if (this._events && this._events[event]) {
      this._events[event](...args);
    }
  }

  removeListener(event, callback) {
    if (this._events && this._events[event] === callback) {
      delete this._events[event];
    }
  }
}

// ==================== ORM Core Classes ====================

// Query Builder (same as before, but updated to use native adapters)
class QueryBuilder {
  constructor(model) {
    this.model = model;
    this._where = [];
    this._orderBy = [];
    this._limit = null;
    this._offset = null;
    this._joins = [];
    this._groupBy = [];
    this._having = [];
    this._select = ['*'];
  }

  select(...fields) {
    this._select = fields;
    return this;
  }

  where(conditions) {
    if (typeof conditions === 'string') {
      this._where.push({ type: 'raw', sql: conditions });
    } else if (Array.isArray(conditions)) {
      this._where.push({ type: 'array', conditions });
    } else {
      Object.entries(conditions).forEach(([key, value]) => {
        this._where.push({ type: 'simple', field: key, value });
      });
    }
    return this;
  }

  orWhere(conditions) {
    const lastWhere = this._where[this._where.length - 1];
    if (lastWhere && !lastWhere.or) {
      lastWhere.or = conditions;
    } else {
      this._where.push({ type: 'or', conditions });
    }
    return this;
  }

  whereIn(field, values) {
    this._where.push({ type: 'in', field, values });
    return this;
  }

  whereBetween(field, [start, end]) {
    this._where.push({ type: 'between', field, start, end });
    return this;
  }

  whereNull(field) {
    this._where.push({ type: 'null', field });
    return this;
  }

  whereNotNull(field) {
    this._where.push({ type: 'notNull', field });
    return this;
  }

  join(table, first, operator, second) {
    this._joins.push({ type: 'INNER', table, first, operator, second });
    return this;
  }

  leftJoin(table, first, operator, second) {
    this._joins.push({ type: 'LEFT', table, first, operator, second });
    return this;
  }

  rightJoin(table, first, operator, second) {
    this._joins.push({ type: 'RIGHT', table, first, operator, second });
    return this;
  }

  orderBy(field, direction = 'ASC') {
    this._orderBy.push({ field, direction });
    return this;
  }

  groupBy(...fields) {
    this._groupBy = fields;
    return this;
  }

  having(conditions) {
    this._having.push(conditions);
    return this;
  }

  limit(limit) {
    this._limit = limit;
    return this;
  }

  offset(offset) {
    this._offset = offset;
    return this;
  }

  buildWhere() {
    if (this._where.length === 0) return { sql: '', params: [] };

    const parts = [];
    const params = [];

    this._where.forEach((condition, index) => {
      const prefix = index === 0 ? 'WHERE' : (condition.or ? 'OR' : 'AND');

      if (condition.type === 'raw') {
        parts.push(`${prefix} ${condition.sql}`);
      } else if (condition.type === 'simple') {
        parts.push(`${prefix} ${condition.field} = ?`);
        params.push(condition.value);
      } else if (condition.type === 'in') {
        const placeholders = condition.values.map(() => '?').join(', ');
        parts.push(`${prefix} ${condition.field} IN (${placeholders})`);
        params.push(...condition.values);
      } else if (condition.type === 'between') {
        parts.push(`${prefix} ${condition.field} BETWEEN ? AND ?`);
        params.push(condition.start, condition.end);
      } else if (condition.type === 'null') {
        parts.push(`${prefix} ${condition.field} IS NULL`);
      } else if (condition.type === 'notNull') {
        parts.push(`${prefix} ${condition.field} IS NOT NULL`);
      } else if (condition.type === 'array') {
        const conditionParts = [];
        condition.conditions.forEach(([field, operator, value]) => {
          conditionParts.push(`${field} ${operator} ?`);
          params.push(value);
        });
        parts.push(`${prefix} (${conditionParts.join(' AND ')})`);
      }
    });

    return { sql: parts.join(' '), params };
  }

  build() {
    let sql = `SELECT ${this._select.join(', ')} FROM ${this.model.tableName}`;

    // Joins
    this._joins.forEach(join => {
      sql += ` ${join.type} JOIN ${join.table} ON ${join.first} ${join.operator} ${join.second}`;
    });

    // Where
    const whereClause = this.buildWhere();
    sql += ` ${whereClause.sql}`;

    // Group By
    if (this._groupBy.length > 0) {
      sql += ` GROUP BY ${this._groupBy.join(', ')}`;
    }

    // Having
    if (this._having.length > 0) {
      sql += ` HAVING ${this._having.join(' AND ')}`;
    }

    // Order By
    if (this._orderBy.length > 0) {
      const orderParts = this._orderBy.map(o => `${o.field} ${o.direction}`);
      sql += ` ORDER BY ${orderParts.join(', ')}`;
    }

    // Limit & Offset
    if (this._limit !== null) {
      sql += ` LIMIT ${this._limit}`;
    }
    if (this._offset !== null) {
      sql += ` OFFSET ${this._offset}`;
    }

    return { sql, params: whereClause.params };
  }

  async get() {
    const { sql, params } = this.build();
    const results = await this.model.adapter.query(sql, params);
    return results.map(data => this.model.hydrate(data));
  }

  async first() {
    this.limit(1);
    const results = await this.get();
    return results[0] || null;
  }

async count() {
  this._select = ['COUNT(*) as count'];
  const { sql, params } = this.build();
  const results = await this.model.adapter.query(sql, params);
  return results[0]?.count || 0;
}

  async exists() {
    const count = await this.count();
    return count > 0;
  }
}

// Model class (same as before)
class Model extends EventEmitter {
  constructor(data = {}) {
    super();
    this._attributes = {};
    this._original = {};
    this._relations = {};
    this._exists = false;

    if (this.constructor.schema) {
      Object.keys(this.constructor.schema).forEach(key => {
        Object.defineProperty(this, key, {
          get: () => this._attributes[key],
          set: (value) => {
            this._attributes[key] = this.constructor.castAttribute(key, value);
            this.emit('attributeChange', key, value);
          },
          enumerable: true
        });
      });
    }

    this.fill(data);
  }

  static tableName = '';
  static primaryKey = 'id';
  static timestamps = true;
  static softDeletes = false;
  static connection = null;
  static adapter = null;
  static schema = {};
  static relations = {};

  static init(connection) {
    this.connection = connection;
    this.adapter = connection.adapter;
  }

  static castAttribute(key, value) {
    if (!this.schema[key]) return value;

    switch (this.schema[key].type) {
      case 'integer':
        return parseInt(value, 10);
      case 'float':
        return parseFloat(value);
      case 'boolean':
        return Boolean(value);
      case 'date':
        return value ? new Date(value) : null;
      case 'json':
        return typeof value === 'string' ? JSON.parse(value) : value;
      default:
        return value;
    }
  }

  fill(data) {
    Object.assign(this._attributes, data);
    this._original = { ...this._attributes };
    return this;
  }

  isDirty(attribute = null) {
    if (attribute) {
      return this._attributes[attribute] !== this._original[attribute];
    }
    return Object.keys(this._attributes).some(key => 
      this._attributes[key] !== this._original[key]
    );
  }

  getOriginal(attribute = null) {
    if (attribute) {
      return this._original[attribute];
    }
    return this._original;
  }

  async save() {
    const data = { ...this._attributes };

    if (this.constructor.timestamps) {
      const now = new Date().toISOString();
      if (!this._exists) {
        data.created_at = data.created_at || now;
      }
      data.updated_at = now;
    }

    if (!this._exists) {
      const keys = Object.keys(data);
      const values = Object.values(data);
      const placeholders = values.map(() => '?').join(', ');
      
      const sql = `INSERT INTO ${this.constructor.tableName} (${keys.join(', ')}) VALUES (${placeholders})`;
      const result = await this.constructor.adapter.execute(sql, values);
      
      if (result.insertId) {
        this._attributes[this.constructor.primaryKey] = result.insertId;
      }
      
      this._exists = true;
      this.emit('saved', this);
    } else {
      const id = this._attributes[this.constructor.primaryKey];
      const updates = Object.keys(data)
        .filter(key => key !== this.constructor.primaryKey)
        .map(key => `${key} = ?`);
      
      const values = Object.keys(data)
        .filter(key => key !== this.constructor.primaryKey)
        .map(key => data[key]);
      
      values.push(id);
      
      const sql = `UPDATE ${this.constructor.tableName} SET ${updates.join(', ')} WHERE ${this.constructor.primaryKey} = ?`;
      await this.constructor.adapter.execute(sql, values);
      
      this.emit('updated', this);
    }

    this._original = { ...this._attributes };
    return this;
  }

  async delete() {
    if (!this._exists) return false;

    if (this.constructor.softDeletes) {
      this._attributes.deleted_at = new Date().toISOString();
      return this.save();
    } else {
      const id = this._attributes[this.constructor.primaryKey];
      const sql = `DELETE FROM ${this.constructor.tableName} WHERE ${this.constructor.primaryKey} = ?`;
      await this.constructor.adapter.execute(sql, [id]);
      
      this._exists = false;
      this.emit('deleted', this);
      return true;
    }
  }

  async restore() {
    if (!this.constructor.softDeletes) return false;
    
    this._attributes.deleted_at = null;
    return this.save();
  }

  static query() {
    return new QueryBuilder(this);
  }

  static async find(id) {
    const results = await this.query()
      .where({ [this.primaryKey]: id })
      .get();
    
    return results[0] || null;
  }

  static async findOrFail(id) {
    const model = await this.find(id);
    if (!model) {
      throw new Error(`Model not found with ${this.primaryKey}: ${id}`);
    }
    return model;
  }

  static async findMany(ids) {
    return this.query()
      .whereIn(this.primaryKey, ids)
      .get();
  }

  static async findOne(conditions) {
    const results = await this.query()
      .where(conditions)
      .limit(1)
      .get();
    
    return results[0] || null;
  }


static async findOrCreate(conditions, data = {}) {
  let model = await this.findOne(conditions);
  
  if (!model) {
    model = new this({ ...conditions, ...data });
    await model.save();
  }
  
  return model;  // Returns a single model, not an array
}

  static async updateOrCreate(conditions, data) {
    let model = await this.findOne(conditions);
    
    if (model) {
      model.fill(data);
    } else {
      model = new this({ ...conditions, ...data });
    }
    
    await model.save();
    return model;
  }

  static async create(data) {
    const model = new this(data);
    await model.save();
    return model;
  }

  static async update(conditions, data) {
    const models = await this.query().where(conditions).get();
    const results = [];
    
    for (const model of models) {
      model.fill(data);
      await model.save();
      results.push(model);
    }
    
    return results;
  }

  static async delete(conditions) {
    const models = await this.query().where(conditions).get();
    const results = [];
    
    for (const model of models) {
      await model.delete();
      results.push(model);
    }
    
    return results;
  }

  static async all() {
    return this.query().get();
  }

  static async count(conditions = {}) {
    return this.query().where(conditions).count();
  }

  static async exists(conditions) {
    return this.query().where(conditions).exists();
  }

  static async first() {
    return this.query().first();
  }

  static async pluck(key, value = null) {
    const models = await this.all();
    
    if (value) {
      const result = {};
      models.forEach(model => {
        result[model[key]] = model[value];
      });
      return result;
    }
    
    return models.map(model => model[key]);
  }

  static hydrate(data) {
    const model = new this();
    model._attributes = { ...data };
    model._original = { ...data };
    model._exists = true;
    return model;
  }

  static async paginate(page = 1, perPage = 15) {
    const offset = (page - 1) * perPage;
    const query = this.query();
    
    const [data, total] = await Promise.all([
      query.limit(perPage).offset(offset).get(),
      this.count()
    ]);
    
    return {
      data,
      meta: {
        current_page: page,
        per_page: perPage,
        total,
        last_page: Math.ceil(total / perPage),
        from: offset + 1,
        to: Math.min(offset + perPage, total)
      }
    };
  }

  static async chunk(size, callback) {
    let page = 1;
    let results;
    
    do {
      results = await this.query()
        .limit(size)
        .offset((page - 1) * size)
        .get();
      
      if (results.length > 0) {
        await callback(results, page);
      }
      
      page++;
    } while (results.length === size);
  }

  static belongsTo(relatedModel, foreignKey = null, ownerKey = null) {
    const model = this;
    const related = relatedModel;
    const fk = foreignKey || `${relatedModel.name.toLowerCase()}_id`;
    const ok = ownerKey || relatedModel.primaryKey;
    
    return {
      async get(parent) {
        const query = {};
        query[ok] = parent[fk];
        return related.findOne(query);
      }
    };
  }

  static hasMany(relatedModel, foreignKey = null, localKey = null) {
    const model = this;
    const related = relatedModel;
    const fk = foreignKey || `${model.name.toLowerCase()}_id`;
    const lk = localKey || model.primaryKey;
    
    return {
      async get(parent) {
        const query = {};
        query[fk] = parent[lk];
        return related.query().where(query).get();
      }
    };
  }

  static hasOne(relatedModel, foreignKey = null, localKey = null) {
    const relation = this.hasMany(relatedModel, foreignKey, localKey);
    return {
      async get(parent) {
        const results = await relation.get(parent);
        return results[0] || null;
      }
    };
  }

  static belongsToMany(relatedModel, pivotTable, foreignPivotKey = null, relatedPivotKey = null) {
    const model = this;
    const related = relatedModel;
    const fk = foreignPivotKey || `${model.name.toLowerCase()}_id`;
    const rk = relatedPivotKey || `${relatedModel.name.toLowerCase()}_id`;
    
    return {
      async get(parent) {
        const sql = `
          SELECT r.* FROM ${related.tableName} r
          INNER JOIN ${pivotTable} p ON p.${rk} = r.${related.primaryKey}
          WHERE p.${fk} = ?
        `;
        
        const results = await model.adapter.query(sql, [parent[model.primaryKey]]);
        return results.map(data => related.hydrate(data));
      }
    };
  }
}

// Connection Manager (updated to use native protocols)
class ConnectionManager {
  constructor() {
    this.connections = new Map();
    this.default = null;
    this.protocols = {
      postgres: PostgreSQLProtocol,
      mysql: MySQLProtocol,
      sqlite: SQLiteProtocol
    };
  }

  addConnection(name, config) {
    const { driver, ...connectionConfig } = config;
    
    if (!this.protocols[driver]) {
      throw new Error(`Unsupported database driver: ${driver}`);
    }
    
    const ProtocolClass = this.protocols[driver];
    const protocol = new ProtocolClass(connectionConfig);
    
    const connection = {
      name,
      driver,
      config: connectionConfig,
      adapter: protocol
    };
    
    this.connections.set(name, connection);
    
    if (!this.default) {
      this.default = name;
    }
    
    return connection;
  }

  async connect(name = null) {
    const connection = this.connection(name);
    await connection.adapter.connect();
    return connection;
  }

  connection(name = null) {
    const connectionName = name || this.default;
    const connection = this.connections.get(connectionName);
    
    if (!connection) {
      throw new Error(`Connection not found: ${connectionName}`);
    }
    
    return connection;
  }

  async disconnect(name = null) {
    const connection = this.connection(name);
    await connection.adapter.disconnect();
    this.connections.delete(connection.name);
  }

  async disconnectAll() {
    for (const [name, connection] of this.connections) {
      await connection.adapter.disconnect();
      this.connections.delete(name);
    }
  }
}

// Schema Builder (simplified for native implementation)
class Schema {
  constructor(connection) {
    this.connection = connection;
    this.adapter = connection.adapter;
  }

  async create(table, callback) {
    const blueprint = new Blueprint(table);
    await callback(blueprint);
    
    const sql = blueprint.toSQL();
    await this.adapter.execute(sql);
  }

  async table(table, callback) {
    const blueprint = new Blueprint(table, true);
    await callback(blueprint);
    
    const sql = blueprint.toSQL();
    if (sql) {
      await this.adapter.execute(sql);
    }
  }

  async drop(table) {
    await this.adapter.execute(`DROP TABLE IF EXISTS ${table}`);
  }

  async dropIfExists(table) {
    await this.adapter.execute(`DROP TABLE IF EXISTS ${table}`);
  }

  async hasTable(table) {
    try {
      await this.adapter.query(`SELECT 1 FROM ${table} LIMIT 1`);
      return true;
    } catch {
      return false;
    }
  }

  async hasColumn(table, column) {
    try {
      await this.adapter.query(`SELECT ${column} FROM ${table} LIMIT 1`);
      return true;
    } catch {
      return false;
    }
  }
}

// Blueprint (simplified)
// Blueprint for schema building (FIXED VERSION)
class Blueprint {
  constructor(table, altering = false) {
    this.table = table;
    this.altering = altering;
    this.columns = [];
    this.indexes = [];
    this.foreignKeys = [];
  }

  id(name = 'id') {
    return this.bigIncrements(name);
  }

  increments(name) {
    this.columns.push({
      name,
      type: 'INTEGER',
      autoIncrement: true,
      primary: true
    });
    return this;
  }

  bigIncrements(name) {
    this.columns.push({
      name,
      type: 'BIGINT',
      autoIncrement: true,
      primary: true
    });
    return this;
  }

  string(name, length = 255) {
    this.columns.push({
      name,
      type: `VARCHAR(${length})`
    });
    return this;
  }

  text(name) {
    this.columns.push({
      name,
      type: 'TEXT'
    });
    return this;
  }

  integer(name) {
    this.columns.push({
      name,
      type: 'INTEGER'
    });
    return this;
  }

  bigInteger(name) {
    this.columns.push({
      name,
      type: 'BIGINT'
    });
    return this;
  }

  float(name, precision = 8, scale = 2) {
    this.columns.push({
      name,
      type: `FLOAT`
    });
    return this;
  }

  decimal(name, precision = 8, scale = 2) {
    this.columns.push({
      name,
      type: `DECIMAL(${precision},${scale})`
    });
    return this;
  }

  boolean(name) {
    this.columns.push({
      name,
      type: 'BOOLEAN'
    });
    return this;
  }

  date(name) {
    this.columns.push({
      name,
      type: 'DATE'
    });
    return this;
  }

  datetime(name) {
    this.columns.push({
      name,
      type: 'DATETIME'
    });
    return this;
  }

  timestamp(name) {
    this.columns.push({
      name,
      type: 'TIMESTAMP'
    });
    return this;
  }

  timestamps() {
    this.datetime('created_at');
    this.datetime('updated_at');
    return this;
  }

  softDeletes() {
    this.datetime('deleted_at').nullable();
    return this;
  }

  enum(name, values) {
    const valuesStr = values.map(v => `'${v}'`).join(', ');
    this.columns.push({
      name,
      type: `TEXT CHECK(${name} IN (${valuesStr}))`
    });
    return this;
  }

  json(name) {
    this.columns.push({
      name,
      type: 'TEXT'
    });
    return this;
  }

  nullable() {
    const lastColumn = this.columns[this.columns.length - 1];
    if (lastColumn) {
      lastColumn.nullable = true;
    }
    return this;
  }

  default(value) {
    const lastColumn = this.columns[this.columns.length - 1];
    if (lastColumn) {
      lastColumn.default = value;
    }
    return this;
  }

  unsigned() {
    const lastColumn = this.columns[this.columns.length - 1];
    if (lastColumn) {
      lastColumn.unsigned = true;
    }
    return this;
  }

  unique(columns = null) {
    if (columns === null) {
      const lastColumn = this.columns[this.columns.length - 1];
      if (lastColumn) {
        columns = [lastColumn.name];
      }
    }
    
    if (columns) {
      this.indexes.push({
        type: 'UNIQUE',
        columns: Array.isArray(columns) ? columns : [columns]
      });
    }
    return this;
  }

  index(columns) {
    this.indexes.push({
      type: 'INDEX',
      columns: Array.isArray(columns) ? columns : [columns]
    });
    return this;
  }

  primary(columns) {
    this.indexes.push({
      type: 'PRIMARY KEY',
      columns: Array.isArray(columns) ? columns : [columns]
    });
    return this;
  }

  foreign(column) {
    // Create a foreign key object
    const foreignKey = {
      column,
      foreignColumn: null,
      foreignTable: null,
      onDelete: null,
      onUpdate: null
    };
    
    this.foreignKeys.push(foreignKey);
    
    // Return object with chainable methods
    const self = this;
    return {
      references: (foreignColumn) => {
        foreignKey.foreignColumn = foreignColumn;
        return {
          on: (foreignTable) => {
            foreignKey.foreignTable = foreignTable;
            // Return methods for further chaining
            return {
              onDelete: (action) => {
                foreignKey.onDelete = action;
                return self;
              },
              onUpdate: (action) => {
                foreignKey.onUpdate = action;
                return self;
              }
            };
          }
        };
      }
    };
  }

  onDelete(action) {
    const lastFK = this.foreignKeys[this.foreignKeys.length - 1];
    if (lastFK) {
      lastFK.onDelete = action;
    }
    return this;
  }

  onUpdate(action) {
    const lastFK = this.foreignKeys[this.foreignKeys.length - 1];
    if (lastFK) {
      lastFK.onUpdate = action;
    }
    return this;
  }

  toSQL() {
    if (this.columns.length === 0) return '';

    const columnsSQL = this.columns.map(col => {
      let sql = `${col.name} ${col.type}`;
      
      if (col.autoIncrement) {
        sql += ' PRIMARY KEY AUTOINCREMENT';
      } else {
        if (!col.nullable) {
          sql += ' NOT NULL';
        }
        
        if (col.default !== undefined) {
          if (typeof col.default === 'string') {
            sql += ` DEFAULT '${col.default}'`;
          } else {
            sql += ` DEFAULT ${col.default}`;
          }
        }
      }
      
      return sql;
    }).join(', ');

    let indexesSQL = '';
    this.indexes.forEach(idx => {
      if (idx.type === 'PRIMARY KEY' && !this.columns.some(c => c.autoIncrement)) {
        indexesSQL += `, PRIMARY KEY (${idx.columns.join(', ')})`;
      } else if (idx.type === 'UNIQUE') {
        indexesSQL += `, UNIQUE (${idx.columns.join(', ')})`;
      }
    });

    let foreignKeysSQL = '';
    this.foreignKeys.forEach(fk => {
      if (fk.foreignTable && fk.foreignColumn) {
        let sql = `, FOREIGN KEY (${fk.column}) REFERENCES ${fk.foreignTable}(${fk.foreignColumn})`;
        if (fk.onDelete) sql += ` ON DELETE ${fk.onDelete}`;
        if (fk.onUpdate) sql += ` ON UPDATE ${fk.onUpdate}`;
        foreignKeysSQL += sql;
      }
    });

    const action = this.altering ? 'ALTER TABLE' : 'CREATE TABLE';
    return `${action} ${this.table} (${columnsSQL}${indexesSQL}${foreignKeysSQL})`;
  }
}

// Migration Manager (simplified)
class MigrationManager {
  constructor(connection) {
    this.connection = connection;
    this.schema = new Schema(connection);
  }

  async createMigrationsTable() {
    const hasTable = await this.schema.hasTable('migrations');
    
    if (!hasTable) {
      await this.schema.create('migrations', table => {
        table.increments('id');
        table.string('migration');
        table.integer('batch');
        table.timestamps();
      });
    }
  }

  async getRan() {
    try {
      const results = await this.connection.adapter.query(
        'SELECT migration FROM migrations ORDER BY batch ASC, id ASC'
      );
      return results.map(r => r.migration);
    } catch {
      return [];
    }
  }

  async getMigrations() {
    try {
      const results = await this.connection.adapter.query(
        'SELECT * FROM migrations ORDER BY batch ASC, id ASC'
      );
      return results;
    } catch {
      return [];
    }
  }

  async getNextBatchNumber() {
    try {
      const results = await this.connection.adapter.query(
        'SELECT MAX(batch) as max_batch FROM migrations'
      );
      return (results[0]?.max_batch || 0) + 1;
    } catch {
      return 1;
    }
  }

  async log(migration, batch) {
    await this.connection.adapter.execute(
      'INSERT INTO migrations (migration, batch, created_at) VALUES (?, ?, ?)',
      [migration, batch, new Date().toISOString()]
    );
  }

  async delete(migration) {
    await this.connection.adapter.execute(
      'DELETE FROM migrations WHERE migration = ?',
      [migration]
    );
  }
}

// Seeder
class Seeder {
  constructor(connection) {
    this.connection = connection;
  }

  async call(seederClass) {
    const seeder = new seederClass(this.connection);
    await seeder.run();
  }
}

// Factory
class Factory {
  constructor(model, count = 1) {
    this.model = model;
    this.count = count;
    this.definition = null;
  }

  define(definition) {
    this.definition = definition;
    return this;
  }

  async create(overrides = {}) {
    const models = [];
    
    for (let i = 0; i < this.count; i++) {
      const data = { ...this.definition(i), ...overrides };
      const model = new this.model(data);
      await model.save();
      models.push(model);
    }
    
    return this.count === 1 ? models[0] : models;
  }

  async make(overrides = {}) {
    const models = [];
    
    for (let i = 0; i < this.count; i++) {
      const data = { ...this.definition(i), ...overrides };
      models.push(new this.model(data));
    }
    
    return this.count === 1 ? models[0] : models;
  }
}

// Main ORM class
class ORM {
  constructor() {
    this.connectionManager = new ConnectionManager();
    this.models = new Map();
    this.migrations = [];
    this.seeders = [];
    this.factories = new Map();
  }

  addConnection(name, config) {
    return this.connectionManager.addConnection(name, config);
  }

  async connect(name = null) {
    return this.connectionManager.connect(name);
  }

  connection(name = null) {
    return this.connectionManager.connection(name);
  }

  model(name, modelClass) {
    const connection = this.connection();
    modelClass.init(connection);
    this.models.set(name, modelClass);
    return modelClass;
  }

  schema(connectionName = null) {
    const connection = this.connectionManager.connection(connectionName);
    return new Schema(connection);
  }

  migration(name, callback) {
    this.migrations.push({ name, callback });
    return this;
  }

  seeder(name, callback) {
    this.seeders.push({ name, callback });
    return this;
  }

  factory(model) {
    return new Factory(model);
  }

  async migrate(connectionName = null) {
    await this.connect(connectionName);
    const connection = this.connectionManager.connection(connectionName);
    const manager = new MigrationManager(connection);
    
    await manager.createMigrationsTable();
    
    const ran = await manager.getRan();
    const pending = this.migrations.filter(m => !ran.includes(m.name));
    
    if (pending.length === 0) {
      console.log('Nothing to migrate');
      return;
    }
    
    const batch = await manager.getNextBatchNumber();
    
    for (const migration of pending) {
      console.log(`Migrating: ${migration.name}`);
      await migration.callback(connection);
      await manager.log(migration.name, batch);
      console.log(`Migrated: ${migration.name}`);
    }
  }

  async migrateRollback(connectionName = null) {
    await this.connect(connectionName);
    const connection = this.connectionManager.connection(connectionName);
    const manager = new MigrationManager(connection);
    
    const migrations = await manager.getMigrations();
    const lastBatch = Math.max(...migrations.map(m => m.batch));
    const toRollback = migrations.filter(m => m.batch === lastBatch);
    
    for (const migration of toRollback.reverse()) {
      console.log(`Rolling back: ${migration.migration}`);
      const migrationObj = this.migrations.find(m => m.name === migration.migration);
      
      if (migrationObj && migrationObj.rollback) {
        await migrationObj.rollback(connection);
      }
      
      await manager.delete(migration.migration);
      console.log(`Rolled back: ${migration.migration}`);
    }
  }

  async seed(connectionName = null) {
    await this.connect(connectionName);
    const connection = this.connectionManager.connection(connectionName);
    const seeder = new Seeder(connection);
    
    for (const seederObj of this.seeders) {
      console.log(`Seeding: ${seederObj.name}`);
      await seederObj.callback(connection);
      console.log(`Seeded: ${seederObj.name}`);
    }
  }

  async disconnect(connectionName = null) {
    await this.connectionManager.disconnect(connectionName);
  }

  async disconnectAll() {
    await this.connectionManager.disconnectAll();
  }

  async transaction(callback, connectionName = null) {
    await this.connect(connectionName);
    const connection = this.connectionManager.connection(connectionName);
    return connection.adapter.transaction(callback);
  }
}

// Export
module.exports = {
  ORM,
  Model,
  Schema,
  Blueprint,
  Seeder,
  Factory,
  QueryBuilder,
  ConnectionManager
};