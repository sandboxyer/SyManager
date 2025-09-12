import fs from 'fs';
import http from 'http';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

// Get current file and directory paths for ES6 modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Get local network IP
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

// Simple MIME type lookup
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
const PORT = 3000;
const DIRECTORY = process.cwd(); // Use current working directory instead of __dirname

const server = http.createServer((req, res) => {
    const requestedPath = decodeURIComponent(req.url.split('?')[0]);
    const filePath = path.join(DIRECTORY, requestedPath);
    
    // Security check to prevent directory traversal
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

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running. Access your files at:`);
    console.log(`http://${localIP}:${PORT}/`);
    console.log(`Use wget to download files:`);
    console.log(`wget http://${localIP}:${PORT}/yourfile.json`);
    console.log(`Serving files from: ${DIRECTORY}`);
});

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.log('\nShutting down server...');
    server.close(() => {
        console.log('Server stopped.');
        process.exit(0);
    });
});