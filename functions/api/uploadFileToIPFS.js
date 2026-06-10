import { requireAuth } from "../_lib/auth.js";
import { checkRateLimit } from "../_lib/rateLimit.js";
import lighthouse from '@lighthouse-web3/sdk';
import crypto from 'crypto';

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'video/mp4', 'video/webm'];
const MAX_SIZE = 50 * 1024 * 1024; // 50MB

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const user = await requireAuth(request, env);
    if (user instanceof Response) return user;
    if (!user || !user.address) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" }
      });
    }

    const rateKey = `upload-file:${user.address.toLowerCase()}`;
    if (!(await checkRateLimit({ key: rateKey, limit: 5, windowMs: 60000 }, env))) {
      return new Response(JSON.stringify({ error: 'Too many file uploads. Try again later.' }), {
        status: 429,
        headers: { "Content-Type": "application/json" }
      });
    }

    let formData;
    try {
      formData = await request.formData();
    } catch (e) {
      return new Response(JSON.stringify({ error: "Invalid form data" }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    const fileEntry = formData.get('file');
    if (!fileEntry || !(fileEntry instanceof File)) {
      return new Response(JSON.stringify({ error: 'No file found under key "file"' }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    const contentType = fileEntry.type;
    const fileSize = fileEntry.size;
    if (!ALLOWED_TYPES.includes(contentType)) {
      return new Response(JSON.stringify({ error: `File type not allowed: ${contentType}` }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }
    if (fileSize > MAX_SIZE) {
      return new Response(JSON.stringify({ error: `File too large. Max 50MB` }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    console.log(`🚀 Augšupielādējam failu caur Lighthouse SDK (Annual Storage)...`);

    const arrayBuffer = await fileEntry.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // 🔐 Aprēķina SHA256 hash no faila baitiem
    const fileHash = '0x' + crypto.createHash('sha256').update(buffer).digest('hex');

    // ✅ Izmantojam Lighthouse SDK ar storageType
    const uploadResponse = await lighthouse.uploadBuffer(
      buffer,
      env.LIGHTHOUSE_API_KEY,
      false,
      null,
      { storageType: "annual" }
    );

    const cid = uploadResponse?.data?.Hash || uploadResponse?.Hash;

    if (!cid) {
      console.error("Lighthouse SDK atbilde:", JSON.stringify(uploadResponse));
      throw new Error("Neizdevās iegūt CID no Lighthouse SDK");
    }

    console.log(`✅ Fails veiksmīgi augšupielādēts! CID: ${cid}, Hash: ${fileHash}`);

    return new Response(JSON.stringify({
      ipfs: `ipfs://${cid}`,
      http: `https://meaningful-macaw-y3g2r.lighthouseweb3.xyz/ipfs/${cid}`,
      cid: cid,
      hash: fileHash
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });

  } catch (error) {
    console.error('💥 Lighthouse SDK kļūda:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}
