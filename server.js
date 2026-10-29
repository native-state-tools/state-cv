const http = require('http');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf'
};

function sendFile(response, filePath) {
  fs.readFile(filePath, (error, content) => {
    if (error) {
      response.writeHead(error.code === 'ENOENT' ? 404 : 500);
      response.end(error.code === 'ENOENT' ? 'Not found' : 'Server error');
      return;
    }
    response.writeHead(200, { 'Content-Type': types[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
    response.end(content);
  });
}

http.createServer((request, response) => {
  let requested;
  try {
    requested = decodeURIComponent(request.url.split('?')[0]);
  } catch {
    response.writeHead(400);
    response.end('Bad request');
    return;
  }
  if (!requested.startsWith('/')) {
    response.writeHead(400);
    response.end('Bad request');
    return;
  }
  const relativePath = requested.replace(/^\/+/, '');
  const filePath = path.resolve(root, relativePath);
  if (filePath !== root && !filePath.startsWith(root + path.sep)) {
    response.writeHead(403);
    response.end('Forbidden');
    return;
  }
  fs.stat(filePath, (statError, stat) => {
    if (!statError && stat.isDirectory()) {
      if (!requested.endsWith('/')) {
        response.writeHead(301, { Location: `${requested}/` });
        response.end();
        return;
      }
      sendFile(response, path.join(filePath, 'index.html'));
      return;
    }
    sendFile(response, filePath);
  });
}).listen(3000, '127.0.0.1', () => {
  console.log('State CV running at 127.0.0.1:3000');
});
