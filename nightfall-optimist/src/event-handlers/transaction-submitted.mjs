/**
 * Module to handle new Transactions being posted
 */
import config from 'config';
import axios from 'axios';

import logger from '@polygon-nightfall/common-files/utils/logger.mjs';
import {
  saveTransaction,
  getBlockByTransactionHash,
  getTransactionByTransactionHash,
} from '../services/database.mjs';

import checkTransaction from '../services/transaction-checker.mjs';
import TransactionError from '../classes/transaction-error.mjs';
import { getTransactionSubmittedCalldata } from '../services/process-calldata.mjs';

const { txWorkerUrl, txWorkerCount } = config.TX_WORKER_PARAMS;

// Flag to enable/disable worker processing
let isWorkerEnable = true;

export function setWorkerEnable(flag) {
  isWorkerEnable = flag;
}
export function getWorkerEnable() {
  return isWorkerEnable;
}
/**
 * It's possible this is a replay or a re-mine of a transaction that's already
 * in a block. Check for this.  This is not part of the general transaction
 * check because we don't want to do it as part of the block check, only when the
 * transaction is received. If we did it as part of the block check it would fail
 * because at that point we're bound to have the transaction both in the mempool and
 * in the block.
 */
async function checkAlreadyInBlock(_transaction) {
  const transaction = { ..._transaction };
  const [block] = await getBlockByTransactionHash(transaction.transactionHash);
  if (!block) {
    return transaction; // all ok, we've not seen this before
  }

  const storedTransaction = await getTransactionByTransactionHash(transaction.transactionHash);

  if (storedTransaction?.blockNumber) {
    // it's a re-play of an existing transaction that's in a block
    throw new TransactionError('This transaction has been processed previously', 6);
  }

  // it's a re-mine of an existing transaction that's in a block
  transaction.mempool = false; // we don't want to put it in another block or we'll get a duplicate transaction challenge

  logger.debug({
    msg: 'Transaction has been re-mined but is already in a block - mempool set to false',
    transactionHash: transaction.transactionHash,
  });

  return transaction; // but it's otherwise ok
}

/**
 * Transaction Event Handler processing. It can be processed by main thread
 * or by worker thread
 *
 * @param {Object} _transaction Transaction data
 * @param {boolean} fromBlockProposer Flag indicating whether this transaction comes from
 * block proposer (for those transactions that werent picked by current proposer).
 */
export async function submitTransaction(_transaction, fromBlockProposer) {
  logger.info({
    msg: 'Transaction Handler - New transaction received.',
    _transaction,
    fromBlockProposer,
  });

  try {
    const transaction = await checkAlreadyInBlock(_transaction);
    // save transaction if not in block
    if (fromBlockProposer) {
      await saveTransaction({ ...transaction });
    }

    await checkTransaction(transaction, true);

    logger.info('Transaction checks passed');

    // save it
    if (!fromBlockProposer) {
      await saveTransaction({ ...transaction });
    }
  } catch (err) {
    if (err instanceof TransactionError) {
      logger.warn(
        `The transaction check failed with error: ${err.message}. The transaction has been ignored`,
      );
    } else {
      logger.error(err);
    }
  }
}

/**
 * This handler runs whenever a new transaction is submitted to the blockchain
 */
export async function transactionSubmittedEventHandler(eventParams) {
  const { offchain = false, fromBlockProposer, ...data } = eventParams;
  let transaction;
  if (offchain) {
    transaction = data;
    transaction.blockNumber = 'offchain';
    transaction.transactionHashL1 = 'offchain';
  } else {
    transaction = await getTransactionSubmittedCalldata(data);
    transaction.blockNumber = data.blockNumber;
    transaction.transactionHashL1 = data.transactionHash;
  }

  logger.info({
    msg: 'Transaction Handler Main Thread - New transaction received.',
    transaction,
    txWorkerCount,
    isWorkerEnable,
  });

  // If TX WORKERS enabled or not responsive, route transaction requests to main thread
  if (Number(txWorkerCount) && isWorkerEnable) {
    axios
      .get(`${txWorkerUrl}/tx-submitted`, {
        params: {
          tx: transaction,
          proposerFlag: fromBlockProposer === true,
        },
      })
      .catch(function (error) {
        logger.error(`Error submit tx worker ${error}`);
        // Main thread (no workers)
        if (error.request) {
          submitTransaction(transaction, fromBlockProposer);
        }
      });
  } else {
    // Main thread (no workers)
    await submitTransaction(transaction, fromBlockProposer);
  }
}
