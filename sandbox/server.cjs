const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, 'public');
http.createServer((req, res) => {
 const pathname = new URL(req.url, 'http://localhost').pathname;
 const files = {'/':'index.html','/app.js':'app.js','/style.css':'style.css'};
 if (!files[pathname]) { res.writeHead(404); return res.end('Not found'); }
 res.setHeader('Content-Type', {'/':'text/html; charset=utf-8','/app.js':'text/javascript; charset=utf-8','/style.css':'text/css; charset=utf-8'}[pathname]);
 fs.createReadStream(path.join(root, files[pathname])).pipe(res);
}).listen(Number(process.env.PORT || 4173), '127.0.0.1');
