// functions/api/upload-metadata.js
import { requireAuth } from "../_lib/auth.js";
import { checkRateLimit } from "../_lib/rateLimit.js";
import { setCache } from "../_lib/cache.js";
import { TurboFactory, EthereumSigner } from '@ardrive/turbo-sdk';

const ALLOWED_FIELDS = ['name', 'image', 'description', 'attributes', 'animation_url', 'tokens', 'nfts'];

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function parseMetadata(body) {
  let metadata = body;
  if (metadata?.metadata && !metadata.name) {
    metadata = metadata.metadata;
  }
  return metadata;
}

function validateMetadata(metadata) {
  if (!metadata?.name || !metadata?.image) {
    return { error: 'Metadata must contain name and image' };
  }

  if (typeof metadata.name !== 'string' || metadata.name.length > 100) {
    return { error: 'Invalid name (max 100 characters)' };
  }

  if (typeof metadata.image !== 'string' || metadata.image.length > 500) {
    return { error: 'Invalid image URL' };
  }

  const isValidUrl = /^(https?|ar|ipfs|local):\/\/.+/.test(metadata.image);
  const isImageFile = metadata.image.endsWith('.png');
  
  if (!isValidUrl && !isImageFile) {
    return { error: 'Image must be a valid URL or image filename' };
  }

  return { metadata };
}

function filterMetadataFields(metadata) {
  for (const key of Object.keys(metadata)) {
    if (!ALLOWED_FIELDS.includes(key)) {
      delete metadata[key];
    }
  }
  return metadata;
}

function createTurboUploader(privateKey) {
  const signer = new EthereumSigner(privateKey);
  return TurboFactory.authenticated({
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
}

async function uploadMetadataToArweave(turbo, metadata, userAddress) {
  const jsonString = JSON.stringify(metadata);
  
  const uploadResult = await turbo.upload({
    data: jsonString,
    dataItemOpts: {
      tags: [
        { name: "Content-Type", value: "application/json" },
        { name: "App-Name", value: "WalletVisualizer-v2.0" },
        { name: "User-Address", value: userAddress.toLowerCase() },
        { name: "Metadata-Type", value: "NFT-Metadata" }
      ],
    }
  });

  const txId = uploadResult?.id;
  
  if (!txId) {
    console.error('❌ Turbo SDK did not return transaction ID for metadata. Response:', JSON.stringify(uploadResult));
    throw new Error('No transaction ID returned for metadata from Turbo SDK');
  }

  return txId;
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    // Auth validācija
    const user = await requireAuth(request, env);
    if (user instanceof Response) return user;
    if (!user?.address) {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }

    // Rate limiting
    const rateKey = `upload-metadata:${user.address.toLowerCase()}`;
    if (!(await checkRateLimit({ key: rateKey, limit: 5, windowMs: 60000 }, env))) {
      return jsonResponse({ error: 'Too many metadata uploads. Try again later.' }, 429);
    }

    // JSON parsēšana
    let body;
    try {
      body = await request.json();
    } catch (e) {
      return jsonResponse({ error: 'Invalid JSON format' }, 400);
    }

    // Metadatu apstrāde un validācija
    const metadata = parseMetadata(body);
    const { error: metadataError } = validateMetadata(metadata);
    if (metadataError) return jsonResponse({ error: metadataError }, 400);

    // Filtrēšana
    const filteredMetadata = filterMetadataFields(metadata);

    console.log(`🚀 Uploading metadata to Arweave via Turbo SDK...`);

    // Turbo inicializācija
    const privateKey = env.ARWEAVE_STORAGE_KEY;
    if (!privateKey) {
      throw new Error('ARWEAVE_STORAGE_KEY not configured');
    }

    const turbo = createTurboUploader(privateKey);
    const txId = await uploadMetadataToArweave(turbo, filteredMetadata, user.address);

    console.log(`✅ Metadata successfully uploaded! TX ID: ${txId}`);

    // Kešatmiņas atjaunošana
    await setCache(`lastUploadId:${user.address.toLowerCase()}`, txId, env, 5 * 60 * 1000);

    return jsonResponse({
      success: true,
      id: txId,
      url: `https://arweave.net/${txId}`
    });

  } catch (error) {
    console.error('💥 Metadata upload error:', error);
    return jsonResponse({ error: error.message }, 500);
  }
}
