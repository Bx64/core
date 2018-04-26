'use strict';

const async = require('async')

const pluginManager = require('@arkecosystem/core-plugin-manager')
const logger = pluginManager.get('logger')
const blockchainManager = pluginManager.get('blockchain')

const client = require('@arkecosystem/client')
const { Transaction } = client.models
const { crypto, slots } = client

const TransactionPoolManager = require('./manager')

let instance

module.exports = class TransactionPoolHandler {
  /**
   * [constructor description]
   * @param  {Object} config
   * @return {TransactionPoolHandler}
   */
  constructor (config) {
    this.walletManager = blockchainManager.getDatabaseConnection().walletManager
    this.config = config
    this.poolManager = config.enabled ? new TransactionPoolManager(config) : false

    if (!instance) {
      instance = this
    }

    const that = this
    this.queue = async.queue((transaction, qcallback) => {
      if (that.verify(transaction)) {
        that.addTransactionToRedis(transaction)
      }
      qcallback()
    }, 1)

    if (!config.enabled) {
      logger.warn('Transaction Pool is disabled! If this node runs in production please enable it.')
    }
    return instance
  }

  /**
   * [getInstance description]
   * @return {TransactionPoolHandler}
   */
  static getInstance () {
    return instance
  }

  /**
   * [addTransaction description]
   * @param {Transaction} transaction
   */
  async addTransaction (transaction) {
    if (this.poolManager) {
      this.queue.push(new Transaction(transaction))
    }
  }

  /**
   * [addTransactions description]
   * @param {Array} transactions
   */
  async addTransactions (transactions) {
    this.queue.push(transactions.map(tx => {
      let transaction = new Transaction(tx)

      // TODO for TESTING - REMOVE LATER ON expiration and time lock testing remove from production
      if (process.env.ARK_ENV === 'testnet') {
        const current = slots.getTime()
        transaction.data.expiration = current + Math.floor(Math.random() * Math.floor(1000) + 1)

        if (Math.round(Math.random() * Math.floor(1)) === 0) {
          transaction.data.timelocktype = 0 // timestamp
          transaction.data.timelock = current + Math.floor(Math.random() * Math.floor(50) + 1)
        } else {
          transaction.data.timelocktype = 1 // block
          transaction.data.timelock = blockchainManager.getState().lastBlock.data.height + Math.floor(Math.random() * Math.floor(20) + 1)
        }
      }
      return transaction
    }))
  }

  /**
   * [verify description]
   * @param  {Transaction} transaction
   * @return {Boolean}
   */
  verify (transaction) {
    const wallet = this.walletManager.getWalletByPublicKey(transaction.senderPublicKey)

    if (crypto.verify(transaction) && wallet.canApply(transaction)) {
      this.walletManager.applyTransaction(transaction)

      return true
    }

    return false
  }

  /**
   * [undoBlock description]
   * @param  {Block} block
   * @return {void}
   */
  async undoBlock (block) { // we add back the block txs to the pool
    if (block.transactions.length === 0) {
      return
    }

    // no return the main thread is liberated
    this.addTransactions(block.transactions.map(tx => tx.data))
  }

  /**
   * [addTransactionToRedis description]
   * @param {Transaction} transaction
   */
  async addTransactionToRedis (transaction) {
    if (this.poolManager) {
      await this.poolManager.addTransaction(transaction)
    }
  }

  /**
   * [removeForgedTransactions description]
   * @param  {Number} transactions
   * @return {void}
   */
  async removeForgedTransactions (transactions) { // we remove the txs from the pool
    if (this.poolManager) {
      await this.poolManager.removeTransactions(transactions)
    }
  }

  /**
   * [getUnconfirmedTransactions description]
   * @param  {Number} start
   * @param  {Number} size
   * @return {Array}
   */
  async getUnconfirmedTransactions (start, size) {
    return this.poolManager.getTransactions(start, size)
  }

  /**
   * [getTransactionsForForging description]
   * @param  {Number} start
   * @param  {Number} size
   * @return {Array}
   */
  async getTransactionsForForging (start, size) {
    return this.poolManager.getTransactionsForForging(start, size)
  }

  /**
   * [getUnconfirmedTransaction description]
   * @param  {Number} id
   * @return {Object}
   */
  async getUnconfirmedTransaction (id) {
    return this.poolManager.getTransaction(id)
  }

  /**
   * [getPoolSize description]
   * @return {Number}
   */
  async getPoolSize () {
    return this.poolManager.getPoolSize()
  }

  // rebuildBlockHeader (block) {

  // }
}
