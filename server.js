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

// 🔒 DROŠĪBA 1: Pilnībā atslēdzam X-Powered-By galveni pašā saknē
app.disable('x-powered-by');

// 🔒 DROŠĪBA 2: Globāls drošības filtrs visiem pieprasījumiem (ZAP un Mozilla salāgošana)
app.use((req, res, next) => {
    // Tava oriģinālā, strādājošā CSP politika
    res.setHeader(
        'Content-Security-Policy',
        "default-src 'none'; script-src 'self' https://cdn.jsdelivr.net chrome-extension:; connect-src 'self' https: wss: chrome-extension:; img-src 'self' data: https: blob:; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; media-src 'self' blob:; video-src 'self' blob:; object-src 'none'; frame-ancestors 'none'; form-action 'self'; base-uri 'self'; manifest-src 'self'; worker-src 'self' blob:; upgrade-insecure-requests;"
    );
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff'); // Vienmēr aktīvs pret MIME-sniffing
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=()');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');

    // LABOJUMS PRET CORS: Tā kā frontend un backend ir vienā vietā, dzēšam CORS vaļā esošās galvenes, ja tādas parādās
    res.removeHeader('Access-Control-Allow-Origin');

    // LABOJUMS PRET TIMESTAMP DISCLOSURE: Neļaujam Express sūtīt servera laiku HTTP galvenēs
    res.removeHeader('Date');

    next();
});

const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// Pārtveram multipart datus pirms Express tos aiztiek
app.use((req, res, next) => {
    if (req.headers['content-type'] && req.headers['content-type'].includes('multipart/form-data')) {
        let data = [];
        req.on('data', chunk => data.push(chunk));
        req.on('end', () => {
            req.rawBody = Buffer.concat(data);
            next();
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
                                                const mimeType = typeMatch ? typeMatch[1] : 'image/png';
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

            // Nodrošinām drošības galveņu saglabāšanu arī adaptera atbildēs
            res.removeHeader('Date');

            if (cfResponse && (cfResponse instanceof Response || typeof cfResponse.json === 'function')) {
                res.status(cfResponse.status || 200);
                
                if (cfResponse.headers && typeof cfResponse.headers.forEach === 'function') {
                    cfResponse.headers.forEach((value, key) => {
                        if (key.toLowerCase() !== 'date') res.setHeader(key, value);
                    });
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
            // Salabota kļūdu lapa: ja API avarē, tai tik un tā būs uzliktas visas drošības galvenes un novākts laiks
            res.removeHeader('Date');
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

// Pārliecināmies, ka SPA fallback maršrutam arī nav laika zīmes
app.get('*', (req, res) => {
    res.removeHeader('Date');
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 🔒 DROŠĪBA 3: Centralizēts Express kļūdu middleware (Catch-all error handler)
// Ja kāds pieprasījums pilnībā salauž Express plūsmu, šis nodrošina drošības galvenes un tīru kļūdu bez noplūdēm
app.use((err, req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.removeHeader('Date');
    res.status(500).json({ error: "Internal Server Error" });
});

app.listen(PORT, () => {
    console.log(`Serveris aktīvs uz porta ${PORT}`);
});
