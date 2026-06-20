import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

if (!globalThis.File) {
    const { File, Blob } = await import('node:buffer');
    globalThis.File = File;
    globalThis.Blob = Blob;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// 🔒 DROŠĪBA 1: Paslēpjam Express versiju
app.disable('x-powered-by');

// 🔒 DROŠĪBA 2: MAKSIMĀLI SAŠAURINĀTS CSP (BEZ GLOBĀLIEM WILDCARDS)
app.use((req, res, next) => {
    // Šeit esam nomainījuši zvaigznītes uz konkrētiem, drošiem Web3 infrastruktūras domēniem
    const strictWeb3CSP = 
        "default-src 'none'; " +
        "script-src 'self' https://cdn.jsdelivr.net chrome-extension:; " + // Izmests 'unsafe-eval' un 'unsafe-inline' skriptiem
        "connect-src 'self' https://*.ardrive.io https://*.sepolia.base.org https://sepolia.base.org https://*.arweave.net https://*.rpc.com wss://*.rpc.com chrome-extension:; " + // Tikai specifiski Web3 domēni
        "img-src 'self' data: https://*.arweave.net https://*.ardrive.io blob:; " + // Attēli tikai no Arweave/ArDrive
        "style-src 'self' https://fonts.googleapis.com 'unsafe-inline'; " + // Fontiem stili joprojām drošības pēc vajadzīgi inline
        "font-src 'self' https://fonts.gstatic.com; " +
        "media-src 'self' blob: https://*.arweave.net; " +
        "video-src 'self' blob: https://*.arweave.net; " +
        "object-src 'none'; " +
        "frame-ancestors 'none'; " +
        "form-action 'self'; " +
        "base-uri 'self'; " +
        "manifest-src 'self'; " +
        "worker-src 'self' blob:; " +
        "upgrade-insecure-requests;";

    res.setHeader('Content-Security-Policy', strictWeb3CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=()');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
    next();
});

// Standarta Express parseri
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// 🛡️ DROŠĪBA 3: Multipart parseris ar RAM aizsardzību
app.use((req, res, next) => {
    if (req.headers['content-type'] && req.headers['content-type'].includes('multipart/form-data')) {
        const maxLimit = 100 * 1024 * 1024;
        let receivedBytes = 0;
        let data = [];
        
        req.on('data', chunk => {
            receivedBytes += chunk.length;
            if (receivedBytes > maxLimit) {
                req.destroy();
                return res.status(413).json({ error: "Payload Too Large", message: "Maksimālais faila izmērs ir 100MB" });
            }
            data.push(chunk);
        });

        req.on('end', () => {
            if (receivedBytes <= maxLimit) {
                req.rawBody = Buffer.concat(data);
                next();
            }
        });
    } else {
        next();
    }
});

// --- CLOUDFLARE -> EXPRESS ADAPTERIS ---
function createCloudflareAdapter(handler) {
    return async (req, res) => {
        try {
            const headersEmulator = {
                ...req.headers,
                get: (headerName) => {
                    const name = headerName.toLowerCase();
                    return req.headers[name] || null;
                }
            };

            const context = {
                env: process.env, 
                request: {
                    json: async () => req.body,
                    formData: async () => {
                        const storage = {};
                        
                        if (req.rawBody) {
                            const contentType = req.headers['content-type'];
                            const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
                            
                            if (boundaryMatch) {
                                const boundary = '--' + (boundaryMatch[1] || boundaryMatch[2]);
                                const buffer = req.rawBody;
                                
                                let offset = 0;
                                while ((offset = buffer.indexOf(boundary, offset)) !== -1) {
                                    offset += boundary.length;
                                    if (buffer[offset] === 0x2d && buffer[offset + 1] === 0x2d) break;
                                    offset += 2;
                                    
                                    const nextBoundary = buffer.indexOf(boundary, offset);
                                    if (nextBoundary === -1) break;
                                    
                                    const part = buffer.subarray(offset, nextBoundary);
                                    const headerEnd = part.indexOf('\r\n\r\n');
                                    
                                    if (headerEnd !== -1) {
                                        const headerStr = part.subarray(0, headerEnd).toString('utf-8');
                                        const body = part.subarray(headerEnd + 4, part.length - 2);
                                        
                                        const nameMatch = headerStr.match(/name="([^"]+)"/);
                                        const filenameMatch = headerStr.match(/filename="([^"]+)"/);
                                        const typeMatch = headerStr.match(/Content-Type:\s*([^\s\r\n]+)/);
                                        
                                        if (nameMatch) {
                                            const key = nameMatch[1];
                                            if (filenameMatch) {
                                                const filename = filenameMatch[1];
                                                const mimeType = typeMatch ? typeMatch[1] : 'application/octet-stream';
                                                storage[key] = new File([body], filename, { type: mimeType });
                                            } else {
                                                storage[key] = body.toString('utf-8');
                                            }
                                        }
                                    }
                                    offset = nextBoundary;
                                }
                            }
                        }
                        
                        if (req.body) {
                            Object.keys(req.body).forEach(key => {
                                storage[key] = req.body[key];
                            });
                        }
                        
                        return {
                            get: (key) => storage[key] || null,
                            has: (key) => key in storage
                        };
                    },
                    url: `${req.protocol}://${req.get('host')}${req.originalUrl}`,
                    headers: headersEmulator
                },
                params: req.params
            };

            const cfResponse = await handler(context);

            if (cfResponse && (cfResponse instanceof Response || typeof cfResponse.json === 'function')) {
                res.status(cfResponse.status || 200);
                
                if (cfResponse.headers && typeof cfResponse.headers.forEach === 'function') {
                    cfResponse.headers.forEach((value, key) => res.setHeader(key, value));
                } else {
                    res.setHeader('Content-Type', 'application/json');
                }

                try {
                    const jsonBuffer = await cfResponse.json();
                    return res.json(jsonBuffer);
                } catch {
                    const textBuffer = await cfResponse.text();
                    return res.send(textBuffer);
                }
            } 
            
            if (cfResponse && typeof cfResponse === 'object') {
                return res.json(cfResponse);
            }

            res.status(200).end();
        } catch (err) {
            console.error(`Kļūda adapterī izpildot maršrutu:`, err);
            res.status(500).json({ error: "Internal Server Error", message: err.message });
        }
    };
}

const apiDir = path.join(__dirname, 'functions', 'api');

async function walkRoutes(dir, routePrefix = '/api') {
    if (!fs.existsSync(dir)) return;

    const files = fs.readdirSync(dir);
    for (const file of files) {
        const fullPath = path.join(dir, file);
        const stat = fs.statSync(fullPath);

        if (stat.isDirectory()) {
            await walkRoutes(fullPath, `${routePrefix}/${file}`);
        } else if (file.endsWith('.js')) {
            const routeName = file === 'index.js' ? '' : `/${file.slice(0, -3)}`;
            const fullRoute = `${routePrefix}${routeName}`.toLowerCase();
            
            try {
                const fileUrl = new URL(`file://${fullPath}`).href;
                const module = await import(fileUrl);
                
                const getHandler = module.onRequestGet || module.onRequestGET || module.onrequestget;
                const postHandler = module.onRequestPost || module.onRequestPOST || module.onrequestpost;
                const genericHandler = module.onRequest || module.onRequestGeneric;
                const defaultHandler = module.default;

                if (getHandler) app.get(fullRoute, createCloudflareAdapter(getHandler));
                if (postHandler) app.post(fullRoute, createCloudflareAdapter(postHandler));
                if (genericHandler) app.all(fullRoute, createCloudflareAdapter(genericHandler));
                if (defaultHandler && !getHandler && !postHandler && !genericHandler) {
                    app.all(fullRoute, defaultHandler);
                }

                console.log(`Reģistrēts maršruts: ${fullRoute}`);
            } catch (e) {
                console.error(`Kļūda ielādējot maršrutu ${fullRoute}:`, e);
            }
        }
    }
}

await walkRoutes(apiDir);

// Statiskie faili
app.use(express.static(path.join(__dirname, 'public')));

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Serveris aktīvs uz porta ${PORT}`);
});
