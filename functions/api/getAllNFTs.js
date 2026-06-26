import { ethers } from "ethers";
import { getOptionalUser } from "../_lib/auth.js";
import { getCache, setCache } from "../_lib/cache.js";
import { checkRateLimit } from "../_lib/rateLimit.js";

const MAX_PAGES = 5;

// Chain konfigurācija
const getChainConfig = (chain) => {
  const configs = {
    sepolia: { type: 'alchemy', network: 'eth-sepolia' },
    mumbai: { type: 'alchemy', network: 'polygon-amoy' },
    bscTestnet: { type: 'bscscan', network: 'bsc-testnet' },
    arbitrumSepolia: { type: 'alchemy', network: 'arb-sepolia' },
    optimismSepolia: { type: 'alchemy', network: 'opt-sepolia' },
    baseSepolia: { type: 'alchemy', network: 'base-sepolia' },
    avalancheFuji: { type: 'alchemy', network: 'avalanche-fuji' }
  };
  return configs[chain] || configs.sepolia;
};

const getAlchemyNFTUrl = ({ apiKey, network, owner, contract, pageKey }) => {
  let url = `https://${network}.g.alchemy.com/nft/v2/${apiKey}/getNFTs?owner=${owner}`;
  if (contract) url += `&contractAddresses[]=${contract}`;
  if (pageKey) url += `&pageKey=${pageKey}`;
  return url;
};

const getBSCScanNFTs = async (owner, apiKey) => {
  const url = `https://api-testnet.bscscan.com/api?module=account&action=tokennfttx&address=${owner}&sort=desc&apikey=${apiKey}`;
  const response = await fetch(url);
  const data = await response.json();
  
  if (data.status !== '1' || !data.result) return [];
  
  const uniqueNFTs = new Map();
  data.result.forEach(tx => {
    const key = `${tx.contractAddress}_${tx.tokenID}`;
    if (!uniqueNFTs.has(key)) {
      uniqueNFTs.set(key, {
        contract: { address: tx.contractAddress, symbol: tx.tokenSymbol || 'NFT' },
        id: { tokenId: tx.tokenID },
        balance: 1
      });
    }
  });
  
  return Array.from(uniqueNFTs.values());
};

// JSON Response palīgfunkcija
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

// Validācijas funkcijas
function getAccount(user, accountParam) {
  const account = accountParam || (user?.address || null);
  if (!account) {
    return { error: "Missing account. Please provide it in query or log in." };
  }
  return { account };
}

function validateEthereumAddress(address) {
  try {
    return { address: ethers.getAddress(address) };
  } catch {
    return { error: "Invalid Ethereum address" };
  }
}

// Rate limiting ar atslēgu
async function checkRateLimitForKey(request, user, chain, env) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const rateKey = user ? `user_${user.address}_nfts_${chain}` : `ip_${ip}_nfts_${chain}`;
  
  if (!(await checkRateLimit({ key: rateKey }, env))) {
    return false;
  }
  return true;
}

// Alchemy NFT iegūšana pa lapām
async function fetchAlchemyNFTs(API_KEY, network, owner, contract) {
  const allNFTs = [];
  let pageKey = null;
  
  for (let i = 0; i < MAX_PAGES; i++) {
    const alchemyUrl = getAlchemyNFTUrl({
      apiKey: API_KEY,
      network,
      owner,
      contract,
      pageKey
    });

    const response = await fetch(alchemyUrl);
    if (!response.ok) break;
    
    const data = await response.json();
    allNFTs.push(...(data?.ownedNfts || []));
    
    if (!data?.pageKey) break;
    pageKey = data.pageKey;
  }
  
  return allNFTs;
}

// NFT formatēšana
function formatNFTs(nfts, chain) {
  return nfts.map(nft => ({
    contract: {
      address: nft.contract?.address || "",
      symbol: nft.contract?.symbol || "NFT"
    },
    id: {
      tokenId: nft.id?.tokenId || ""
    },
    balance: 1,
    chain
  }));
}

export async function onRequestGet(context) {
  const { request, env } = context;
  let chain = 'sepolia';

  try {
    const url = new URL(request.url);
    const accountParam = url.searchParams.get("account");
    const contract = url.searchParams.get("contract");
    chain = url.searchParams.get("chain") || 'sepolia';

    // Autentifikācija un konta iegūšana
    const user = await getOptionalUser(request, env);
    const { account, error: accountError } = getAccount(user, accountParam);
    if (accountError) return jsonResponse({ error: accountError }, 400);

    // Adrešu validācija
    const { address: safeAccount, error: addrError } = validateEthereumAddress(account);
    if (addrError) return jsonResponse({ error: addrError }, 400);

    let safeContract = null;
    if (contract) {
      const { address: validatedContract, error: contractError } = validateEthereumAddress(contract);
      if (contractError) return jsonResponse({ error: "Invalid contract address" }, 400);
      safeContract = validatedContract;
    }

    // Rate limiting
    if (!(await checkRateLimitForKey(request, user, chain, env))) {
      return jsonResponse({ error: "Too many requests" }, 429);
    }

    // Cache pārbaude
    const cacheKey = safeContract
      ? `nfts_${safeAccount}_${safeContract}_${chain}`
      : `nfts_${safeAccount}_${chain}`;

    const cached = await getCache(cacheKey, env);
    if (cached) return jsonResponse(cached);

    // NFT iegūšana
    const chainConfig = getChainConfig(chain);
    let allNFTs = [];

    if (chainConfig.type === 'bscscan') {
      allNFTs = await getBSCScanNFTs(safeAccount, env.BSCSCAN_API_KEY);
    } else {
      allNFTs = await fetchAlchemyNFTs(env.ALCHEMY_API_KEY, chainConfig.network, safeAccount, safeContract);
    }

    // Rezultātu formatēšana un kešošana
    const formatted = formatNFTs(allNFTs, chain);
    const result = { result: { nfts: formatted }, chain };
    
    await setCache(cacheKey, result, env);
    return jsonResponse(result);

  } catch (err) {
    console.error("NFT ERROR for chain:", chain, err);
    return jsonResponse({
      error: "Failed to fetch NFTs",
      result: { nfts: [] }
    }, 500);
  }
}
