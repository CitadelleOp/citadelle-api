# Citadelle API Infrastructure

Welcome to the backend infrastructure for **Citadelle Options** — an institutional-grade options and perpetuals protocol built natively on the **Robinhood Chain (EVM)**.

This repository houses the core REST APIs,  and the background EVM event indexers that power the entire Citadelle ecosystem.

---

## 🌟 Key Features

- **Real-time EVM Indexing:** Powered by `viem`, the background indexer continuously monitors the Robinhood Chain for `OptionWritten` and `OptionBought` smart contract events to keep the database perfectly synced with on-chain reality.
- **Robust Database Architecture:** Built on **Prisma ORM** and **PostgreSQL** to securely store market structures, user portfolios, and immutable trade histories.
- **High-Performance REST API:** Fast **Express.js** API that provides instant data access to both the Frontend Web UI and the AI Agent (MCP Server).
- **Automated Workflows:** Built-in `node-cron` schedulers designed for future automated market seeding and oracle price snapshotting.

---

## 🛠 Tech Stack

- **Runtime:** Node.js + TypeScript
- **Framework:** Express.js
- **Blockchain:** Viem (EVM / Solidity)
- **Database:** PostgreSQL + Prisma ORM
- **Logging:** Winston + Morgan

---

## 📡 Core API Endpoints

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/` | Basic health check to verify API status. |
| `GET` | `/api/markets` | Returns all active options markets including strike prices and expiry. |
| `GET` | `/api/portfolio/:wallet` | Returns open positions and trade history for a specific EVM wallet. |
| `GET` | `/api/stocks/change` | Fetches 24-hour stock changes and volume data for traditional equities. |

---

## 🛡 License

This project is licensed under the **MIT License**.
