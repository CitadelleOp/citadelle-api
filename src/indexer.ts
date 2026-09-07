import { createPublicClient, http, parseAbiItem } from 'viem';
import { PrismaClient } from '@prisma/client';
import * as dotenv from 'dotenv';
import { logger } from './logger';

dotenv.config();

const prisma = new PrismaClient();

const RPC_URL_TESTNET = process.env.ROBINHOOD_TESTNET_RPC || 'https://rpc.testnet.chain.robinhood.com';
const PROGRAM_ID_TESTNET = process.env.CITADELLE_CONTRACT_ADDRESS || '';

if (!PROGRAM_ID_TESTNET) {
  logger.warn('⚠️ CITADELLE_CONTRACT_ADDRESS is not set in .env. Indexer will not run.');
}

const client = createPublicClient({
  transport: http(RPC_URL_TESTNET)
});

const OptionWrittenEvent = parseAbiItem('event OptionWritten(address indexed user, address indexed market, uint256 quantity, uint256 price)');
const OptionBoughtEvent = parseAbiItem('event OptionBought(address indexed user, address indexed market, uint256 quantity, uint256 price)');

export async function startIndexer() {
  const mode = process.env.INDEXER_MODE || 'testnet'; 

  if (mode === 'testnet' && PROGRAM_ID_TESTNET) {
    logger.info(`🔌 Connecting to EVM RPC at ${RPC_URL_TESTNET}`);
    logger.info(`📡 Listening for EVM events on Contract: ${PROGRAM_ID_TESTNET}`);

    client.watchEvent({
      address: PROGRAM_ID_TESTNET as `0x${string}`,
      event: OptionWrittenEvent,
      onLogs: async (logs) => {
        for (const log of logs) {
          logger.info(`\n🔔 OptionWritten Event Detected: ${log.transactionHash}`);
          const { user, market, quantity, price } = log.args;
          
          if (!market || !user) continue;

          let marketData = await prisma.market.findFirst({ where: { address: market, network: 'testnet' } });
          if (!marketData) continue;

          const existingTx = await prisma.tradeHistory.findUnique({ where: { txSignature: log.transactionHash } });
          if (!existingTx) {
            await prisma.tradeHistory.create({
              data: {
                userAddress: user,
                marketId: marketData.id,
                action: 'WRITE',
                quantity: Number(quantity) || 0,
                price: Number(price) || marketData.premiumAsk || 0,
                txSignature: log.transactionHash,
                network: 'testnet'
              }
            });
            logger.info(`✅ Logged WRITE for ${user} in tx ${log.transactionHash}`);
          }
        }
      }
    });

    client.watchEvent({
      address: PROGRAM_ID_TESTNET as `0x${string}`,
      event: OptionBoughtEvent,
      onLogs: async (logs) => {
        for (const log of logs) {
          logger.info(`\n🔔 OptionBought Event Detected: ${log.transactionHash}`);
          const { user, market, quantity, price } = log.args;
          
          if (!market || !user) continue;

          let marketData = await prisma.market.findFirst({ where: { address: market, network: 'testnet' } });
          if (!marketData) continue;

          const existingTx = await prisma.tradeHistory.findUnique({ where: { txSignature: log.transactionHash } });
          if (!existingTx) {
            await prisma.tradeHistory.create({
              data: {
                userAddress: user,
                marketId: marketData.id,
                action: 'BUY',
                quantity: Number(quantity) || 0,
                price: Number(price) || marketData.premiumAsk || 0,
                txSignature: log.transactionHash,
                network: 'testnet'
              }
            });
            logger.info(`✅ Logged BUY for ${user} in tx ${log.transactionHash}`);
          }
        }
      }
    });
  }
}
