import { requireAuth } from "../_lib/auth.js";
import { checkRateLimit } from "../_lib/rateLimit.js";
import { setCache } from "../_lib/cache.js";
import lighthouse from '@lighthouse-web3/sdk';

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

    const rateKey = `upload-metadata:${user.address.toLowerCase()}`;
    if (!(await checkRateLimit({ key: rateKey, limit: 5, windowMs: 60000 }, env))) {
      return new Response(JSON.stringify({ error: 'Too many metadata uploads. Try again later.' }), {
        status: 429,
        headers: { "Content-Type": "application/json" }
      });
    }

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
    if (!/^(https?|ipfs):\/\/.+/.test(metadata.image)) {
      return new Response(JSON.stringify({ error: 'Image must be a valid HTTP/HTTPS or IPFS URL' }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    const allowedFields = ['name', 'image', 'description', 'attributes', 'animation_url'];
    for (const key of Object.keys(metadata)) {
      if (!allowedFields.includes(key)) {
        delete metadata[key];
      }
    }

    console.log(`🚀 Augšupielādējam metadatus caur Lighthouse SDK (Annual Storage)...`);

    const jsonString = JSON.stringify(metadata);
    const buffer = Buffer.from(jsonString, 'utf-8');

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
      console.error('❌ Lighthouse SDK neatgrieza CID metadatiem. Atbilde:', JSON.stringify(uploadResponse));
      throw new Error('No CID returned for metadata from Lighthouse SDK');
    }

    console.log(`✅ Metadati veiksmīgi augšupielādēti! CID: ${cid}`);

    await setCache(`lastUploadCID:${user.address.toLowerCase()}`, cid, env, 5 * 60 * 1000);

    return new Response(JSON.stringify({
      ipfs: `ipfs://${cid}`,
      http: `https://meaningful-macaw-y3g2r.lighthouseweb3.xyz/ipfs/${cid}`,
      cid: cid
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });

  } catch (error) {
    console.error('💥 Metadatu augšupielādes kļūda:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}
