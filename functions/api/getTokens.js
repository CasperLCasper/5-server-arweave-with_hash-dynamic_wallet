import { ethers } from "ethers";
import { getOptionalUser } from "../_lib/auth.js";
import { checkRateLimit } from "../_lib/rateLimit.js";
import { getCache, setCache } from "../_lib/cache.js";

// Chain konfigurācija
const getChainConfig = (chain, apiKey) => {
  const configs = {
    sepolia: {
      type: 'alchemy',
      url: `https://eth-sepolia.g.alchemy.com/v2/${apiKey}`,
      method: 'alchemy_getTokenBalances'
    },
    mumbai: {
      type: 'alchemy',
      url: `https://polygon-amoy.g.alchemy.com/v2/${apiKey}`,
      method: 'alchemy_getTokenBalances'
    },
    bscTestnet: {
      type: 'bscscan',
      url: `https://api-testnet.bscscan.com/api`,
      method: 'bscscan'
    },
    arbitrumSepolia: {
      type: 'alchemy',
      url: `https://arb-sepolia.g.alchemy.com/v2/${apiKey}`,
      method: 'alchemy_getTokenBalances'
    },
    optimismSepolia: {
      type: 'alchemy',
      url: `https://opt-sepolia.g.alchemy.com/v2/${apiKey}`,
      method: 'alchemy_getTokenBalances'
    },
    baseSepolia: {
      type: 'alchemy',
      url: `https://base-sepolia.g.alchemy.com/v2/${apiKey}`,
      method: 'alchemy_getTokenBalances'
    },
    avalancheFuji: {
      type: 'alchemy',
      url: `https://avalanche-fuji.g.alchemy.com/v2/${apiKey}`,
      method: 'alchemy_getTokenBalances'
    }
  };
  return configs[chain] || configs.sepolia;
};

// JSON Response palīgfunkcija
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

// Konta iegūšana
function getAccount(user, accountParam) {
  const account = accountParam || (user?.address || null);
  if (!account) return { error: "Missing account" };
  return { account };
}

// Adreses validācija
function validateAddress(address) {
  try {
    return { address: ethers.getAddress(address) };
  } catch {
    return { error: "Invalid address" };
  }
}

// Rate limiting
async function checkTokenRateLimit(request, user, chain, env) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const key = user ? `user_${user.address}_tokens_${chain}` : `ip_${ip}_tokens_${chain}`;
  
  if (!(await checkRateLimit({ key }, env))) {
    return { error: "Too many requests" };
  }
  return {};
}

// BSCScan tokenu iegūšana
async function fetchBSCScanTokens(baseUrl, apiKey, address) {
  const tokens = [];
  
  // Iegūstam tokenu bilances
  const balanceUrl = `${baseUrl}?module=account&action=tokenbalance&address=${address}&tag=latest&apikey=${apiKey}`;
  const balanceResponse = await fetch(balanceUrl);
  const balanceData = await balanceResponse.json();
  
  if (balanceData.status !== '1' || !balanceData.result) return tokens;

  // Iegūstam tokenu transakcijas
  const txUrl = `https://api-testnet.bscscan.com/api?module=account&action=tokentx&address=${address}&sort=desc&apikey=${apiKey}`;
  const txResponse = await fetch(txUrl);
  const txData = await txResponse.json();
  
  if (txData.status !== '1' || !txData.result) return tokens;

  // Veidojam tokenu mapi
  const tokenMap = new Map();
  txData.result.forEach(tx => {
    if (!tokenMap.has(tx.contractAddress)) {
      tokenMap.set(tx.contractAddress, {
        contract: tx.contractAddress,
        symbol: tx.tokenSymbol,
        decimals: Number.parseInt(tx.tokenDecimal),
        balance: "0x0"
      });
    }
  });

  // Pievienojam bilances
  if (typeof balanceData.result === 'object') {
    for (const [contractAddress, balance] of Object.entries(balanceData.result)) {
      if (tokenMap.has(contractAddress)) {
        tokenMap.get(contractAddress).balance = balance;
      }
    }
  }

  return Array.from(tokenMap.values());
}

// Alchemy tokenu iegūšana
async function fetchAlchemyTokens(url, method, address) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method,
      params: [address],
      id: 42
    })
  });

  const data = await response.json();
  
  if (data.error) {
    throw new Error(data.error.message);
  }

  const balances = data?.result?.tokenBalances || [];
  
  return balances.map(t => ({
    contract: t.contractAddress,
    balance: t.tokenBalance,
    decimalBalance: BigInt(t.tokenBalance).toString()
  }));
}

export async function onRequestGet(context) {
  const { request, env } = context;
  let chain = 'sepolia';

  try {
    const url = new URL(request.url);
    const accountParam = url.searchParams.get("account");
    chain = url.searchParams.get("chain") || 'sepolia';

    // Validācija
    const user = await getOptionalUser(request, env);
    const { account, error: accountError } = getAccount(user, accountParam);
    if (accountError) return jsonResponse({ error: accountError }, 400);

    const { address: safeAccount, error: addrError } = validateAddress(account);
    if (addrError) return jsonResponse({ error: addrError }, 400);

    // Rate limiting
    const { error: rateError } = await checkTokenRateLimit(request, user, chain, env);
    if (rateError) return jsonResponse({ error: rateError }, 429);

    // Cache pārbaude
    const cacheKey = `tokens_${safeAccount}_${chain}`;
    const cached = await getCache(cacheKey, env);
    if (cached) return jsonResponse(cached);

    // Tokenu iegūšana
    const chainConfig = getChainConfig(chain, env.ALCHEMY_API_KEY);
    let tokens = [];

    if (chainConfig.type === 'bscscan') {
      tokens = await fetchBSCScanTokens(chainConfig.url, env.BSCSCAN_API_KEY, safeAccount);
    } else {
      tokens = await fetchAlchemyTokens(chainConfig.url, chainConfig.method, safeAccount);
    }

    // Rezultāts un kešošana
    const result = { tokens, chain };
    await setCache(cacheKey, result, env, 60000);
    
    return jsonResponse(result);

  } catch (err) {
    console.error("TOKEN ERROR for chain:", chain, err);
    return jsonResponse({ 
      error: "Failed to fetch tokens", 
      details: err.message,
      tokens: [] 
    }, 500);
  }
}
