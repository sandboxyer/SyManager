import fs from 'fs';
import http from 'http';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import readline from 'readline';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Class representing a simple local file download server.
 */
 class DownloadHUB {
    /**
     * Start the file server with optional custom configuration.
     * Server will gracefully stop when any key is pressed.
     *
     * @param {Object} [config] - Optional server configuration.
     * @param {number} [config.port=3000] - The port number to run the server on.
     * @param {string} [config.path='./'] - The directory path to serve files from.
     * @returns {Promise<void>} A promise that resolves when the server is stopped.
     */
    static async Start(config = {}) {
        const PORT = config.port || 3000;
        const DIRECTORY = path.resolve(config.path || './');

        /**
         * Get the local network IP address.
         * @returns {string}
         */
        const getLocalIP = () => {
            const interfaces = os.networkInterfaces();
            for (const iface of Object.values(interfaces)) {
                for (const details of iface) {
                    if (details.family === 'IPv4' && !details.internal) {
                        return details.address;
                    }
                }
            }
            return 'localhost';
        };

        /**
         * Get MIME type based on file extension.
         * @param {string} filePath
         * @returns {string}
         */
        const getMimeType = (filePath) => {
            const ext = path.extname(filePath).toLowerCase();
            const mimeTypes = {
                '.html': 'text/html',
                '.htm': 'text/html',
                '.css': 'text/css',
                '.js': 'text/javascript',
                '.json': 'application/json',
                '.png': 'image/png',
                '.jpg': 'image/jpeg',
                '.jpeg': 'image/jpeg',
                '.gif': 'image/gif',
                '.svg': 'image/svg+xml',
                '.txt': 'text/plain',
                '.pdf': 'application/pdf',
                '.zip': 'application/zip',
                '.mp3': 'audio/mpeg',
                '.mp4': 'video/mp4',
                '.wav': 'audio/wav',
                '.avi': 'video/x-msvideo',
                '.mov': 'video/quicktime',
                '.doc': 'application/msword',
                '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                '.xls': 'application/vnd.ms-excel',
                '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                '.ppt': 'application/vnd.ms-powerpoint',
                '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
            };
            return mimeTypes[ext] || 'application/octet-stream';
        };

        const localIP = getLocalIP();

        const server = http.createServer((req, res) => {
            const requestedPath = decodeURIComponent(req.url.split('?')[0]);
            const filePath = path.join(DIRECTORY, requestedPath);

            if (!filePath.startsWith(DIRECTORY)) {
                res.writeHead(403, { 'Content-Type': 'text/plain' });
                res.end('Access denied');
                return;
            }

            try {
                if (!fs.existsSync(filePath)) {
                    res.writeHead(404, { 'Content-Type': 'text/plain' });
                    res.end('File not found');
                    return;
                }

                const stats = fs.statSync(filePath);

                if (stats.isDirectory()) {
                    const files = fs.readdirSync(filePath);
                    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                    res.end(`<h1>Index of ${requestedPath}</h1><ul>` +
                        files.map(file => {
                            const filePathEncoded = encodeURIComponent(path.join(requestedPath, file));
                            return `<li><a href="${filePathEncoded}">${file}</a></li>`;
                        }).join('') +
                        '</ul>');
                    return;
                }

                const contentType = getMimeType(filePath);
                res.writeHead(200, {
                    'Content-Type': contentType,
                    'Content-Disposition': `attachment; filename="${path.basename(filePath)}"`
                });

                const readStream = fs.createReadStream(filePath);
                readStream.pipe(res);

                readStream.on('error', (err) => {
                    console.error('Error reading file:', err);
                    res.writeHead(500, { 'Content-Type': 'text/plain' });
                    res.end('Error reading file');
                });

            } catch (error) {
                console.error('Server error:', error);
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('Internal server error');
            }
        });

        await new Promise((resolve) => {
            server.listen(PORT, '0.0.0.0', () => {
                console.log(`\n📁 File server is running.`);
                console.log(`🌐 Access: http://${localIP}:${PORT}/`);
                console.log(`📥 Download with: wget http://${localIP}:${PORT}/yourfile.txt`);
                console.log(`📂 Serving path: ${DIRECTORY}`);
                console.log('⌨️  Press any key to stop the server...\n');
            });

            // Setup stdin for keypress detection
            const rl = readline.createInterface({
                input: process.stdin,
                output: process.stdout
            });

            process.stdin.setRawMode(true);
            process.stdin.resume();

            process.stdin.once('data', () => {
                process.stdin.setRawMode(false);
                rl.close();
                console.log('\n🛑 Shutting down server...');
                server.close(() => {
                    console.log('✅ Server stopped.\n');
                    resolve(); // clean finish
                });
            });
        });

        // .Start() ends here
    }
}

export default DownloadHUB