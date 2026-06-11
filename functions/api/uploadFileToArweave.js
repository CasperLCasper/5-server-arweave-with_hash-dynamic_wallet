import { requireAuth } from "../_lib/auth.js";
import { checkRateLimit } from "../_lib/rateLimit.js";
import { TurboFactory, EthereumSigner } from '@ardrive/turbo-sdk';
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

    console.log(`🚀 Uploading file to Arweave via Turbo SDK (Base Sepolia)...`);

    const arrayBuffer = await fileEntry.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Aprēķina SHA-256 hash
    const fileHash = '0x' + crypto.createHash('sha256').update(buffer).digest('hex');

    // Inicializē Turbo ar Base Sepolia testnet
    const privateKey = env.ARWEAVE_STORAGE_KEY;
    if (!privateKey) {
      throw new Error('ARWEAVE_STORAGE_KEY not configured');
    }

    const signer = new EthereumSigner(privateKey);
    const turbo = TurboFactory.authenticated({
      signer,
      token: 'base-eth',
      gatewayUrl: 'https://sepolia.base.org',
      paymentServiceConfig: {
        url: 'https://payment.ardrive.dev',
      },
      uploadServiceConfig: {
        url: 'https://upload.ardrive.dev',
      }
    });

    // Nosaka Content-Type tag
    const mimeType = contentType || 'application/octet-stream';

    // Augšupielādē caur Turbo
    const uploadResult = await turbo.upload({
      data: buffer,
      dataItemOpts: {
        tags: [
          { name: "Content-Type", value: mimeType },
          { name: "App-Name", value: "WalletVisualizer-v2.0" },
          { name: "User-Address", value: user.address.toLowerCase() },
          { name: "File-Hash", value: fileHash }
        ],
      }
    });

    const txId = uploadResult?.id;
    if (!txId) {
      console.error("Turbo upload response:", JSON.stringify(uploadResult));
      throw new Error("Failed to get transaction ID from Turbo");
    }

    console.log(`✅ File uploaded to Arweave! TX ID: ${txId}, Hash: ${fileHash}`);

    return new Response(JSON.stringify({
      success: true,
      id: txId,
      hash: fileHash,
      url: `https://arweave.net/${txId}`,
      owner: uploadResult.owner,
      dataCaches: uploadResult.dataCaches
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });

  } catch (error) {
    console.error('💥 Turbo upload error:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}
