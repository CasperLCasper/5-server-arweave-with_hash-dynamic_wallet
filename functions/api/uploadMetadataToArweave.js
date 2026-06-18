// functions/api/upload-metadata.js
import { requireAuth } from "../_lib/auth.js";
import { checkRateLimit } from "../_lib/rateLimit.js";
import { setCache } from "../_lib/cache.js";
import { TurboFactory, EthereumSigner } from '@ardrive/turbo-sdk';

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    // 1. Autentifikācijas pārbaude
    const user = await requireAuth(request, env);
    if (user instanceof Response) return user;
    if (!user || !user.address) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" }
      });
    }

    // 2. Ātruma ierobežojuma pārbaude
    const rateKey = `upload-metadata:${user.address.toLowerCase()}`;
    if (!(await checkRateLimit({ key: rateKey, limit: 5, windowMs: 60000 }, env))) {
      return new Response(JSON.stringify({ error: 'Too many metadata uploads. Try again later.' }), {
        status: 429,
        headers: { "Content-Type": "application/json" }
      });
    }

    // 3. JSON datu saņemšana un parsēšana
    let body;
    try {
      body = await request.json();
    } catch (e) {
      return new Response(JSON.stringify({ error: 'Invalid JSON format' }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    let metadata = body;
    if (metadata.metadata && !metadata.name) {
      metadata = metadata.metadata;
    }

    // 4. Pamata validācijas
    if (!metadata || !metadata.name || !metadata.image) {
      return new Response(JSON.stringify({ error: 'Metadata must contain name and image' }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    if (typeof metadata.name !== 'string' || metadata.name.length > 100) {
      return new Response(JSON.stringify({ error: 'Invalid name (max 100 characters)' }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }
    if (typeof metadata.image !== 'string' || metadata.image.length > 500) {
      return new Response(JSON.stringify({ error: 'Invalid image URL' }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    // Paplašināta validācija, lai atbalstītu Arweave linkus, lokālos hašus un parastos attēlu nosaukumus
    if (!/^(https?|ar|ipfs|local):\/\/.+/.test(metadata.image) && !metadata.image.endsWith('.png')) {
      return new Response(JSON.stringify({ error: 'Image must be a valid URL or image filename' }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    // 5. Filtra modifikācija: Atļaujam 'tokens' un 'nfts' laukus jaunajai loģikai
    const allowedFields = ['name', 'image', 'description', 'attributes', 'animation_url', 'tokens', 'nfts'];
    for (const key of Object.keys(metadata)) {
      if (!allowedFields.includes(key)) {
        delete metadata[key];
      }
    }

    console.log(`🚀 Uploading metadata to Arweave via Turbo SDK...`);

    // 6. Turbo SDK inicializācija
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

    const jsonString = JSON.stringify(metadata);

    // 7. Augšupielāde uz Arweave
    const uploadResult = await turbo.upload({
      data: jsonString,
      dataItemOpts: {
        tags: [
          { name: "Content-Type", value: "application/json" },
          { name: "App-Name", value: "WalletVisualizer-v2.0" },
          { name: "User-Address", value: user.address.toLowerCase() },
          { name: "Metadata-Type", value: "NFT-Metadata" }
        ],
      }
    });

    const txId = uploadResult?.id;

    if (!txId) {
      console.error('❌ Turbo SDK did not return transaction ID for metadata. Response:', JSON.stringify(uploadResult));
      throw new Error('No transaction ID returned for metadata from Turbo SDK');
    }

    console.log(`✅ Metadata successfully uploaded! TX ID: ${txId}`);

    // Kešatmiņas atjaunošana
    await setCache(`lastUploadId:${user.address.toLowerCase()}`, txId, env, 5 * 60 * 1000);

    // 8. Atbilde
    return new Response(JSON.stringify({
      success: true,
      id: txId,
      url: `https://arweave.net/${txId}`
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });

  } catch (error) {
    console.error('💥 Metadata upload error:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}
