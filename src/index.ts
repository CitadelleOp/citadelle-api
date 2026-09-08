import express from 'express';
import type { Request, Response } from 'express';
import cors from 'cors';
import morgan from 'morgan';
import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';
import https from 'https';
import cron from 'node-cron';
import { startIndexer } from './indexer';
import { privateKeyToAccount } from 'viem/accounts';
import { keccak256, encodePacked, parseEther } from 'viem';

import { logger } from './logger';

dotenv.config();

// Disable strict TLS checking for development bypass (Binance API certificate issues)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const app = express();
const prisma = new PrismaClient();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Add morgan middleware to log HTTP requests
app.use(morgan('combined', {
  stream: {
    write: (message) => logger.info(message.trim())
  }
}));

// Basic health check
app.get('/', (req: Request, res: Response) => {
  res.send('Citadelle API is running');
});

// GET /api/markets
// Fetch all active markets with their liquidity and current premium
app.get('/api/markets', async (req: Request, res: Response) => {
  const network = (req.query.network as string) || 'testnet';
  try {
    const markets = await prisma.market.findMany({
      where: { network },
      orderBy: { createdAt: 'desc' }
    });
    res.json({ success: true, data: markets });
  } catch (error) {
    logger.error('Error fetching markets:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch markets' });
  }
});

// GET /api/portfolio/:wallet
// Fetch positions and trade history for a specific wallet
app.get('/api/portfolio/:wallet', async (req: Request, res: Response) => {
  const wallet = req.params.wallet as string;
  const network = (req.query.network as string) || 'testnet';
  
  if (!wallet) {
    return res.status(400).json({ success: false, error: 'Wallet address is required' });
  }

  try {
    const positions = await prisma.optionPosition.findMany({
      where: { ownerAddress: wallet, network },
      include: { market: true },
      orderBy: { createdAt: 'desc' }
    });

    const trades = await prisma.tradeHistory.findMany({
      where: { userAddress: wallet, network },
      include: { market: true },
      orderBy: { createdAt: 'desc' }
    });

    res.json({
      success: true,
      data: {
        positions,
        trades
      }
    });
  } catch (error) {
    logger.error('Error fetching portfolio:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch portfolio' });
  }
});

// POST /api/positions/:id/close-signature
// Generate a signature for closing an option position
app.post('/api/positions/:id/close-signature', async (req: Request, res: Response) => {
  const positionId = req.params.id as string;
  try {
    const position = await prisma.optionPosition.findUnique({
      where: { id: positionId }
    });

    if (!position) {
      return res.status(404).json({ success: false, error: 'Position not found' });
    }

    if (position.status === 'CLOSED' || position.quantity === 0) {
      return res.status(400).json({ success: false, error: 'Position already closed' });
    }

    const backendSignerKey = process.env.BACKEND_SIGNER_PRIVATE_KEY as `0x${string}`;
    if (!backendSignerKey) {
      logger.error('BACKEND_SIGNER_PRIVATE_KEY not set');
      return res.status(500).json({ success: false, error: 'Internal server configuration error' });
    }

    const account = privateKeyToAccount(backendSignerKey);
    const marginToUnlock = parseEther(position.quantity.toString()); // Assuming 1 quantity = 1 ether of margin or properly calculated margin

    // The message hash includes msg.sender (owner), positionId, collateralToken, marginToUnlock
    const messageHash = keccak256(
      encodePacked(
        ['address', 'string', 'address', 'uint256'],
        [position.ownerAddress as `0x${string}`, position.id, position.collateralToken as `0x${string}`, marginToUnlock]
      )
    );

    const signature = await account.signMessage({
      message: { raw: messageHash }
    });

    res.json({
      success: true,
      data: {
        signature,
        marginToUnlock: marginToUnlock.toString(),
        collateralToken: position.collateralToken
      }
    });
  } catch (error) {
    logger.error(`Error generating signature for position ${positionId}:`, error);
    res.status(500).json({ success: false, error: 'Failed to generate signature' });
  }
});

// GET /api/stocks/change
// Fetch daily change percentages for US stocks via Yahoo Finance
app.get('/api/stocks/change', async (req: Request, res: Response) => {
  const symbols = (req.query.symbols as string || '').split(',').filter(Boolean);
  if (symbols.length === 0) return res.json({ success: true, data: {} });

  try {
    const promises = symbols.map(sym => new Promise<{symbol: string, change24h: number, volume24h: number}>((resolve, reject) => {
      https.get(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}`, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (response) => {
        let data = '';
        response.on('data', chunk => data += chunk);
        response.on('end', () => {
          try {
            const json = JSON.parse(data);
            const meta = json?.chart?.result?.[0]?.meta;
            if (meta && meta.regularMarketPrice && meta.previousClose) {
              const change24h = ((meta.regularMarketPrice - meta.previousClose) / meta.previousClose) * 100;
              resolve({ symbol: sym, change24h, volume24h: meta.regularMarketVolume || 0 });
            } else {
              resolve({ symbol: sym, change24h: 0, volume24h: 0 });
            }
          } catch (e) {
            resolve({ symbol: sym, change24h: 0, volume24h: 0 });
          }
        });
      }).on('error', () => resolve({ symbol: sym, change24h: 0, volume24h: 0 }));
    }));

    const results = await Promise.all(promises);
    const dataMap: Record<string, {change24h: number, volume24h: number}> = {};
    results.forEach(r => {
      dataMap[r.symbol] = { change24h: r.change24h, volume24h: r.volume24h };
    });

    res.json({ success: true, data: dataMap });
  } catch (error: any) {
    logger.error('Error fetching stock changes:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/assets - Fetch all dynamic assets
app.get('/api/assets', async (req: Request, res: Response) => {
  const network = (req.query.network as string) || 'testnet';
  try {
    const assets = await prisma.asset.findMany({
      where: { isActive: true, network },
      orderBy: { symbol: 'asc' }
    });
    res.json({ success: true, data: assets });
  } catch (error: any) {
    logger.error(`Error fetching assets: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/markets/:id/writers
// Fetch an available writer for a specific market
app.get('/api/markets/:id/writers', async (req: Request, res: Response) => {
  const marketId = req.params.id as string;
  const network = (req.query.network as string) || 'testnet';
  
  if (!marketId) {
    return res.status(400).json({ success: false, error: 'Market ID is required' });
  }

  try {
    // Find an open written position for this market
    const openPosition = await prisma.optionPosition.findFirst({
      where: { 
        marketId: marketId, 
        network: network,
        positionType: 'WRITTEN'
      },
      orderBy: { createdAt: 'asc' } // Oldest first
    });

    if (openPosition) {
      res.json({ success: true, data: { writer: openPosition.ownerAddress } });
    } else {
      res.json({ success: true, data: null });
    }
  } catch (error) {
    logger.error('Error fetching writers:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch writers' });
  }
});

// POST /api/rpc
// Proxy RPC requests to the configured node to hide API keys from the frontend
app.post('/api/rpc', async (req: Request, res: Response) => {
  const rpcUrl = process.env.RPC_URL as string;
  
  try {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(req.body)
    });
    
    const data = await response.json();
    res.json(data);
  } catch (error: any) {
    logger.error(`RPC Proxy Error: ${error.message}`);
    res.status(500).json({ error: 'RPC proxy error' });
  }
});

async function fetchBypassPrice(feedId: string): Promise<number | null> {
  const asset = await prisma.asset.findFirst({
    where: { pythFeedId: feedId }
  });

  if (!asset) return null;

  try {
    if (asset.type === 'crypto') {
      const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${asset.symbol}-USD?interval=1d&range=1d`, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(5000)
      });
      const data = await res.json();
      return data.chart.result[0].meta.regularMarketPrice;
    } else {
      const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${asset.symbol}?interval=1d&range=1d`, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(5000)
      });
      const data = await res.json();
      return data.chart.result[0].meta.regularMarketPrice;
    }
  } catch (e) {
    console.error(`Bypass fetch failed for ${asset.symbol}:`, e);
    return null;
  }
}

// Proxy for Pyth Hermes to attach API key and fix CORS
app.get('/api/pyth/v2/updates/price/latest', async (req: Request, res: Response) => {
  try {
    const pythKey = process.env.PYTH_API_KEY || '';
    const query = new URLSearchParams(req.query as any).toString();
    const url = `https://hermes.pyth.network/v2/updates/price/latest?${query}`;
    
    // Attempt real Pyth fetch if key exists
    if (pythKey) {
      const response = await fetch(url, {
        headers: { 'Authorization': `Bearer ${pythKey}` }
      });
      if (response.ok) {
        const data = await response.json();
        
        // Log requested prices so user sees live activity for currently viewed assets
        try {
          if (data && data.parsed) {
            let ids = req.query['ids[]'] || req.query.ids;
            if (ids && !Array.isArray(ids)) ids = [ids as string];
            if (ids && ids.length > 0) {
              const activeAssets = await prisma.asset.findMany({
                where: { pythFeedId: { in: ids as string[] } }
              });
              
              const logParts = data.parsed.map((feed: any) => {
                const price = feed.price.price * (10 ** feed.price.expo);
                const asset = activeAssets.find(a => a.pythFeedId === feed.id);
                return asset ? `${asset.symbol}: $${price.toFixed(4)}` : `Feed[${feed.id.slice(0,6)}]: $${price.toFixed(4)}`;
              });
              
              if (logParts.length > 0) {
                logger.info(`📈 Live Ticker: ${logParts.join(' | ')}`);
              }
            }
          }
        } catch (err) {}
        
        return res.json(data);
      }
    }

    // Bypass Fallback if no key or Pyth is down
    // logger.info("Using Pyth Bypass Fallback...");
    let ids = req.query['ids[]'] || req.query.ids;
    if (!ids) {
      return res.json({ parsed: [] });
    }
    if (!Array.isArray(ids)) {
      ids = [ids as string];
    }

    const parsed = [];
    const logParts = [];
    
    // We already have activeAssets lookup, let's just do it individually here
    for (const feedId of ids as string[]) {
      const price = await fetchBypassPrice(feedId);
      if (price !== null) {
        
        // Find asset to log
        try {
          const asset = await prisma.asset.findFirst({ where: { pythFeedId: feedId } });
          if (asset) logParts.push(`${asset.symbol}: $${price.toFixed(4)}`);
        } catch(e) {}
        
        // Mock Pyth payload structure: price * 10^8
        parsed.push({
          id: feedId,
          price: {
            price: Math.floor(price * 100000000).toString(),
            conf: "0",
            expo: -8,
            publish_time: Math.floor(Date.now() / 1000)
          },
          ema_price: {
            price: Math.floor(price * 100000000).toString(),
            conf: "0",
            expo: -8,
            publish_time: Math.floor(Date.now() / 1000)
          }
        });
      }
    }
    
    if (logParts.length > 0) {
      logger.info(`📈 Live Ticker (Bypass): ${logParts.join(' | ')}`);
    }
    
    return res.json({ 
      binary: { encoding: "hex", data: ["00"] },
      parsed 
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Start the server and Indexer
app.listen(PORT, () => {
  logger.info(`🚀 Citadelle API Server running on port ${PORT}`);
  
  // Start the background indexer in the same process
  startIndexer().then(() => {
    logger.info('✅ Background Indexer initialized');
  }).catch(err => {
    logger.error('❌ Failed to start background indexer:', err);
  });
});
