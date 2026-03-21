import https from 'https';
import http from 'http';
import { pipeline } from 'stream/promises';

/**
 * @typedef {Object} RequestConfig
 * @property {string} [method='GET'] - HTTP method
 * @property {Object.<string, string>} [headers] - Custom headers
 * @property {Object|string|Buffer|ReadableStream} [body] - Request body
 * @property {number} [timeout=30000] - Request timeout in ms
 * @property {boolean} [stream=false] - Return response as stream
 * @property {string} [auth] - Basic auth credentials (user:pass)
 * @property {Object} [params] - URL query parameters
 * @property {boolean} [rejectUnauthorized=true] - Reject invalid SSL certs
 * @property {number} [maxRedirects=5] - Maximum redirects to follow
 */

/**
 * @typedef {Object} Response
 * @property {number} statusCode - HTTP status code
 * @property {Object.<string, string>} headers - Response headers
 * @property {string|Buffer|ReadableStream} data - Response body
 */

/**
 * Minimalistic HTTP client with static methods
 */
class HTTPClient {
  /**
   * Parse URL and add query parameters
   * @param {string} url
   * @param {Object} [params]
   * @returns {URL}
   * @private
   */
  static #parseUrl(url, params = {}) {
    const parsedUrl = new URL(url);
    
    Object.entries(params).forEach(([key, value]) => {
      parsedUrl.searchParams.append(key, String(value));
    });
    
    return parsedUrl;
  }

  /**
   * Prepare request body
   * @param {Object|string|Buffer} body
   * @param {Object.<string, string>} headers
   * @returns {string|Buffer}
   * @private
   */
  static #prepareBody(body, headers) {
    if (!body) return null;
    
    if (Buffer.isBuffer(body) || typeof body === 'string') {
      return body;
    }
    
    if (typeof body === 'object') {
      headers['Content-Type'] = headers['Content-Type'] || 'application/json';
      return JSON.stringify(body);
    }
    
    return body;
  }

  /**
   * Handle redirects
   * @param {string} location
   * @param {RequestConfig} config
   * @param {number} redirectCount
   * @returns {Promise<Response>}
   * @private
   */
  static async #handleRedirect(location, config, redirectCount) {
    if (redirectCount >= (config.maxRedirects || 5)) {
      throw new Error(`Maximum redirects exceeded (${config.maxRedirects || 5})`);
    }
    
    const newUrl = new URL(location, config.url).toString();
    const redirectConfig = { ...config, url: newUrl };
    
    return this.request(redirectConfig, redirectCount + 1);
  }

  /**
   * Make HTTP request
   * @param {string|RequestConfig} url - URL or configuration object
   * @param {RequestConfig} [options] - Additional options
   * @returns {Promise<Response>}
   */
  static async request(url, options = {}) {
    // Handle overloaded parameters
    let config;
    if (typeof url === 'string') {
      config = { url, ...options };
    } else {
      config = { ...url };
    }
    
    const {
      method = 'GET',
      headers = {},
      body = null,
      timeout = 30000,
      stream = false,
      auth,
      params = {},
      rejectUnauthorized = true,
      maxRedirects = 5
    } = config;
    
    // Parse URL with query parameters
    const parsedUrl = this.#parseUrl(config.url, params);
    
    // Handle basic auth
    if (auth && !parsedUrl.username && !parsedUrl.password) {
      const [username, password] = auth.split(':');
      parsedUrl.username = username;
      parsedUrl.password = password;
    }
    
    // Prepare headers
    const requestHeaders = { ...headers };
    if (parsedUrl.username && parsedUrl.password) {
      const authString = Buffer.from(`${parsedUrl.username}:${parsedUrl.password}`).toString('base64');
      requestHeaders['Authorization'] = `Basic ${authString}`;
    }
    
    // Prepare body
    const finalBody = this.#prepareBody(body, requestHeaders);
    
    // Determine protocol
    const protocol = parsedUrl.protocol === 'https:' ? https : http;
    
    // Request options
    const requestOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method,
      headers: requestHeaders,
      timeout,
      rejectUnauthorized
    };
    
    return new Promise((resolve, reject) => {
      const req = protocol.request(requestOptions, async (res) => {
        const { statusCode, headers: responseHeaders } = res;
        
        // Handle redirects
        if (statusCode >= 300 && statusCode < 400 && responseHeaders.location) {
          try {
            const redirectResponse = await this.#handleRedirect(responseHeaders.location, config, 1);
            resolve(redirectResponse);
          } catch (err) {
            reject(err);
          }
          return;
        }
        
        // Stream response
        if (stream) {
          resolve({
            statusCode,
            headers: responseHeaders,
            data: res
          });
          return;
        }
        
        // Buffer response
        const chunks = [];
        let size = 0;
        
        res.on('data', (chunk) => {
          chunks.push(chunk);
          size += chunk.length;
        });
        
        res.on('end', () => {
          const buffer = Buffer.concat(chunks, size);
          let data = buffer;
          
          // Auto-parse JSON if content-type indicates JSON
          const contentType = responseHeaders['content-type'] || '';
          if (contentType.includes('application/json') && buffer.length > 0) {
            try {
              data = JSON.parse(buffer.toString());
            } catch (err) {
              // If parsing fails, return as string
              data = buffer.toString();
            }
          } else if (contentType.includes('text/') && buffer.length > 0) {
            data = buffer.toString();
          }
          
          resolve({
            statusCode,
            headers: responseHeaders,
            data
          });
        });
      });
      
      // Handle errors
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`Request timeout after ${timeout}ms`));
      });
      
      // Send body
      if (finalBody) {
        if (finalBody.pipe) {
          // Stream body
          pipeline(finalBody, req).catch(reject);
        } else {
          req.write(finalBody);
          req.end();
        }
      } else {
        req.end();
      }
    });
  }

  /**
   * GET request
   * @param {string} url
   * @param {RequestConfig} [config]
   * @returns {Promise<Response>}
   */
  static async get(url, config = {}) {
    return this.request({ ...config, url, method: 'GET' });
  }

  /**
   * POST request
   * @param {string} url
   * @param {Object|string|Buffer} body
   * @param {RequestConfig} [config]
   * @returns {Promise<Response>}
   */
  static async post(url, body, config = {}) {
    return this.request({ ...config, url, method: 'POST', body });
  }

  /**
   * PUT request
   * @param {string} url
   * @param {Object|string|Buffer} body
   * @param {RequestConfig} [config]
   * @returns {Promise<Response>}
   */
  static async put(url, body, config = {}) {
    return this.request({ ...config, url, method: 'PUT', body });
  }

  /**
   * PATCH request
   * @param {string} url
   * @param {Object|string|Buffer} body
   * @param {RequestConfig} [config]
   * @returns {Promise<Response>}
   */
  static async patch(url, body, config = {}) {
    return this.request({ ...config, url, method: 'PATCH', body });
  }

  /**
   * DELETE request
   * @param {string} url
   * @param {RequestConfig} [config]
   * @returns {Promise<Response>}
   */
  static async delete(url, config = {}) {
    return this.request({ ...config, url, method: 'DELETE' });
  }
}

// Export default as the class
export default HTTPClient;