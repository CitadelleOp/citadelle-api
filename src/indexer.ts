import { createPublicClient, http, parseAbiItem } from 'viem';
import { PrismaClient } from '@prisma/client';
import * as dotenv from 'dotenv';
import { logger } from './logger';

dotenv.config();

const prisma = new PrismaClient();

const RPC_URL = process.env.RPC_URL as string;
const ENGINE_CONTRACT_ADDRESS = process.env.ENGINE_CONTRACT_ADDRESS as string;
const INDEXER_NETWORK = process.env.INDEXER_NETWORK as string;

if (!ENGINE_CONTRACT_ADDRESS || !RPC_URL || !INDEXER_NETWORK) {
  logger.warn('⚠️ Environment variables are missing. Indexer will not run.');
}

const client = createPublicClient({
  transport: http(RPC_URL)
});

const OptionWrittenEvent = parseAbiItem('event OptionWritten(address indexed writer, string marketSymbol, uint256 strikePrice, uint256 expiry, address indexed collateralToken, uint256 premium)');
const OptionBoughtEvent = parseAbiItem('event OptionBought(address indexed buyer, string marketSymbol, uint256 strikePrice, uint256 expiry, address indexed collateralToken, uint256 premium)');

export async function startIndexer() {
  if (ENGINE_CONTRACT_ADDRESS) {
    logger.info(`🔌 Connecting to EVM RPC at ${RPC_URL}`);
    logger.info(`📡 Listening for EVM events on Engine: ${ENGINE_CONTRACT_ADDRESS} [Network: ${INDEXER_NETWORK}]`);

    client.watchEvent({
      address: ENGINE_CONTRACT_ADDRESS as `0x${string}`,
      event: OptionWrittenEvent,
      onLogs: async (logs) => {
        for (const log of logs) {
          logger.info(`\n🔔 OptionWritten Event Detected: ${log.transactionHash}`);
          const { writer, marketSymbol, strikePrice, expiry, collateralToken, premium } = log.args as any;
          
          if (!marketSymbol || !writer) continue;

          const parsedStrike = Number(strikePrice) / 1e6; // assume 6 decimals for strike
          const parsedPremium = Number(premium) / 1e6; // assume 6 decimals for premium tracking
          const expiryDate = new Date(Number(expiry) * 1000);

          let marketData = await prisma.market.findFirst({ 
            where: { 
              symbol: marketSymbol,
              strike: parsedStrike,
              expiry: expiryDate,
              collateralToken: collateralToken,
              engineAddress: ENGINE_CONTRACT_ADDRESS,
              network: INDEXER_NETWORK
            } 
          });

          if (!marketData) {
            marketData = await prisma.market.create({
              data: {
                engineAddress: ENGINE_CONTRACT_ADDRESS,
                symbol: marketSymbol,
                strike: parsedStrike,
                expiry: expiryDate,
                collateralToken: collateralToken,
                network: INDEXER_NETWORK,
                totalLiquidity: 0,
                premiumAsk: parsedPremium
              }
            });
            logger.info(`✨ Created new Market for ${marketSymbol} $${parsedStrike}`);
          }

          const existingTx = await prisma.tradeHistory.findUnique({ where: { txSignature: log.transactionHash } });
          if (!existingTx) {
            await prisma.tradeHistory.create({
              data: {
                userAddress: writer,
                marketId: marketData.id,
                action: 'WRITE',
                quantity: 1,
                price: parsedPremium,
                collateralToken: collateralToken,
                expiry: expiryDate,
                txSignature: log.transactionHash,
                network: INDEXER_NETWORK
              }
            });

            await prisma.optionPosition.create({
              data: {
                ownerAddress: writer,
                marketId: marketData.id,
                quantity: 1,
                positionType: 'WRITTEN',
                collateralToken: collateralToken,
                expiry: expiryDate,
                network: INDEXER_NETWORK
              }
            });

            await prisma.market.update({
              where: { id: marketData.id },
              data: { 
                totalLiquidity: marketData.totalLiquidity + 1,
                premiumAsk: parsedPremium // Update latest premium ask
              }
            });

            logger.info(`✅ Logged WRITE & Liquidity Added for ${writer} in tx ${log.transactionHash}`);
          }
        }
      }
    });

    client.watchEvent({
      address: ENGINE_CONTRACT_ADDRESS as `0x${string}`,
      event: OptionBoughtEvent,
      onLogs: async (logs) => {
        for (const log of logs) {
          logger.info(`\n🔔 OptionBought Event Detected: ${log.transactionHash}`);
          const { buyer, marketSymbol, strikePrice, expiry, collateralToken, premium } = log.args as any;
          
          if (!marketSymbol || !buyer) continue;

          const parsedStrike = Number(strikePrice) / 1e6;
          const parsedPremium = Number(premium) / 1e6;
          const expiryDate = new Date(Number(expiry) * 1000);

          let marketData = await prisma.market.findFirst({ 
            where: { 
              symbol: marketSymbol,
              strike: parsedStrike,
              expiry: expiryDate,
              collateralToken: collateralToken,
              engineAddress: ENGINE_CONTRACT_ADDRESS,
              network: INDEXER_NETWORK
            } 
          });

          if (!marketData) {
            logger.warn(`⚠️ OptionBought event for unknown market: ${marketSymbol} $${parsedStrike}`);
            continue;
          }

          const existingTx = await prisma.tradeHistory.findUnique({ where: { txSignature: log.transactionHash } });
          if (!existingTx) {
            await prisma.tradeHistory.create({
              data: {
                userAddress: buyer,
                marketId: marketData.id,
                action: 'BUY',
                quantity: 1,
                price: parsedPremium,
                collateralToken: collateralToken,
                expiry: expiryDate,
                txSignature: log.transactionHash,
                network: INDEXER_NETWORK
              }
            });

            await prisma.optionPosition.create({
              data: {
                ownerAddress: buyer,
                marketId: marketData.id,
                quantity: 1,
                positionType: 'BOUGHT',
                collateralToken: collateralToken,
                expiry: expiryDate,
                network: INDEXER_NETWORK
              }
            });

            if (marketData.totalLiquidity >= 1) {
              await prisma.market.update({
                where: { id: marketData.id },
                data: { totalLiquidity: marketData.totalLiquidity - 1 }
              });
            }

            logger.info(`✅ Logged BUY & Liquidity Absorbed for ${buyer} in tx ${log.transactionHash}`);
          }
        }
      }
    });
  }
}
