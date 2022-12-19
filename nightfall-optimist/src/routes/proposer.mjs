import express from 'express';
import config from 'config';
import Timber from '@polygon-nightfall/common-files/classes/timber.mjs';
import logger from '@polygon-nightfall/common-files/utils/logger.mjs';
import {
  getContractInstance,
  waitForContract,
} from '@polygon-nightfall/common-files/utils/contract.mjs';
import { enqueueEvent } from '@polygon-nightfall/common-files/utils/event-queue.mjs';
import constants from '@polygon-nightfall/common-files/constants/index.mjs';
import Block from '../classes/block.mjs';
import { Transaction, TransactionError } from '../classes/index.mjs';
import {
  setRegisteredProposerAddress,
  findRegisteredProposerAddress,
  deleteRegisteredProposerAddress,
  getMempoolTransactions,
  getLatestTree,
  findBlocksByProposer,
  getBlockByBlockHash,
} from '../services/database.mjs';
import transactionSubmittedEventHandler from '../event-handlers/transaction-submitted.mjs';
import getProposers from '../services/proposer.mjs';
import {
  createSignedTransaction,
  sendSignedTransaction,
} from '../services/transaction-sign-send.mjs';
import auth from '../utils/auth.mjs';
import txsQueue from '../utils/transactions-queue.mjs';

const router = express.Router();
const { TIMBER_HEIGHT, HASH_TYPE } = config;
const { STATE_CONTRACT_NAME, PROPOSERS_CONTRACT_NAME, SHIELD_CONTRACT_NAME, ZERO } = constants;

let proposer;
export function setProposer(p) {
  proposer = p;
}

/**
 * @openapi
 *  /proposer/register:
 *    post:
 *      security:
 *        - ApiKeyAuth: []
 *      tags:
 *      - Proposer
 *      summary: Register proposer.
 *      description: Registers a proposer to the Proposers contract.
 *        The user must post the url, stake and fee.
 *        A stake of 0 is taken as minimum configured stake.
 *      parameters:
 *        - in: header
 *          name: api_key
 *          schema:
 *            type: string
 *            format: uuid
 *          required: true
 *      requestBody:
 *        content:
 *          application/json:
 *            schema:
 *              $ref: '#/components/schemas/Proposer'
 *      responses:
 *        200:
 *          $ref: '#/components/responses/SuccessProposerRegister'
 *        401:
 *          $ref: '#/components/responses/Unauthorized'
 *        500:
 *          $ref: '#/components/responses/InternalServerError'
 */
router.post('/register', auth, async (req, res, next) => {
  const ethAddress = req.app.get('proposerEthAddress');
  const ethPrivateKey = req.app.get('proposerEthPrivateKey');

  const { url = '', stake = 0, fee = 0 } = req.body;

  try {
    // Validate url, stake
    if (url === '') {
      throw new Error('Rest API URL not provided');
    }

    const stateContractInstance = await waitForContract(STATE_CONTRACT_NAME);
    const minimumStake = await stateContractInstance.methods.getMinimumStake().call();
    let _stake = stake;
    if (_stake === 0) {
      _stake = minimumStake;
    }
    if (_stake < minimumStake) {
      throw new Error(`Given stake is below minimum required, ie ${minimumStake} Wei`);
    }

    // Recreate Proposer contracts
    const proposersContractInstance = await waitForContract(PROPOSERS_CONTRACT_NAME);

    // Check if the proposer is already registered on the blockchain
    const proposerAddresses = (await getProposers()).map(p => p.thisAddress);
    const isRegistered = proposerAddresses.includes(ethAddress);

    // Check if proposer is registered with this Optimist instance (aka 'locally')
    const registeredProposerInDb = await findRegisteredProposerAddress(ethAddress);

    // Ops in Proposers smart contract
    let txDataToSign = '';
    let signedTx = {};
    if (!isRegistered) {
      logger.debug('Register new proposer...');
      txDataToSign = await proposersContractInstance.methods.registerProposer(url, fee).encodeABI();

      // Sign tx
      const proposersContractAddress = proposersContractInstance.options.address;
      signedTx = await createSignedTransaction(
        ethPrivateKey,
        ethAddress,
        proposersContractAddress,
        txDataToSign,
        _stake,
      );

      // Submit tx
      txsQueue.push(async () => {
        try {
          const receipt = await sendSignedTransaction(signedTx);
          logger.debug({ msg: 'Proposer registered', receipt });
        } catch (err) {
          logger.error({
            msg: 'Something went wrong',
            err,
          });
        }
      });
    } else {
      logger.warn('Proposer was already registered, registration attempt ignored!');
    }

    // Ops in Optimist db
    const currentProposer = await stateContractInstance.methods.getCurrentProposer().call();
    if (!registeredProposerInDb) {
      logger.debug('Registering proposer with this Optimist instance...');
      await setRegisteredProposerAddress(ethAddress, url); // save the registration address

      // I we were already registered on the blockchain, check if we're the current proposer
      if (txDataToSign === '') {
        logger.warn(
          'Proposer was already registered on the blockchain, now is also registered with this Optimist instance',
        );
        if (ethAddress === currentProposer.thisAddress) {
          logger.warn(
            'Proposer is also current proposer, kickstart the queue for making blocks...',
          );
          proposer.isMe = true;
          await enqueueEvent(() => logger.info('Start Queue'), 0);
        }
      }
    } else if (ethAddress === currentProposer.thisAddress && !proposer.isMe) {
      logger.warn(
        'Proposer was already registered on the blockchain and with this Optimist instance, but proposer flag was not set - setting isMe flag',
      );
      proposer.isMe = true;
      proposer.address = ethAddress;
      await enqueueEvent(() => logger.info('Start Queue'), 0); // kickstart the queue
    }

    const { transactionHash } = signedTx;
    res.json({ transactionHash });
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 *  /proposer/update:
 *    post:
 *      security:
 *        - ApiKeyAuth: []
 *      tags:
 *      - Proposer
 *      summary: Update proposer.
 *      description: Update proposer's url, stake or fee.
 *      parameters:
 *        - in: header
 *          name: api_key
 *          schema:
 *            type: string
 *            format: uuid
 *          required: true
 *      requestBody:
 *        content:
 *          application/json:
 *            schema:
 *              $ref: '#/components/schemas/Proposer'
 *      responses:
 *        200:
 *          $ref: '#/components/responses/SuccessProposerUpdate'
 *        401:
 *          $ref: '#/components/responses/Unauthorized'
 *        500:
 *          $ref: '#/components/responses/InternalServerError'
 */
router.post('/update', auth, async (req, res, next) => {
  const ethAddress = req.app.get('proposerEthAddress');
  const ethPrivateKey = req.app.get('proposerEthPrivateKey');

  const { url = '', stake = 0, fee = 0 } = req.body;

  try {
    // Validate url
    if (url === '') {
      throw new Error('Rest API URL not provided');
    }

    // Recreate Proposer contract
    const proposersContractInstance = await waitForContract(PROPOSERS_CONTRACT_NAME);

    // Update proposer data
    const txDataToSign = await proposersContractInstance.methods
      .updateProposer(url, fee)
      .encodeABI();

    // Sign tx
    const proposersContractAddress = proposersContractInstance.options.address;
    const signedTx = await createSignedTransaction(
      ethPrivateKey,
      ethAddress,
      proposersContractAddress,
      txDataToSign,
      stake,
    );

    // Submit tx and update db if tx is successful
    txsQueue.push(async () => {
      try {
        const receipt = await sendSignedTransaction(signedTx);
        logger.debug({ msg: 'Proposer updated', receipt });

        await setRegisteredProposerAddress(ethAddress, url);
        logger.debug('Proposer updated in db');
      } catch (err) {
        logger.error({
          msg: 'Something went wrong',
          err,
        });
      }
    });

    const { transactionHash } = signedTx;
    res.json({ transactionHash });
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 *  /proposer/current-proposer:
 *    get:
 *      tags:
 *      - Proposer
 *      summary: Current proposer.
 *      description: Returns the proposer currently proposing L2 blocks.
 *      responses:
 *        200:
 *          $ref: '#/components/responses/SuccessCurrentProposer'
 *        400:
 *          $ref: '#/components/responses/BadRequest'
 *        500:
 *          $ref: '#/components/responses/InternalServerError'
 */
router.get('/current-proposer', async (req, res, next) => {
  try {
    const stateContractInstance = await getContractInstance(STATE_CONTRACT_NAME);
    const { thisAddress: currentProposer } = await stateContractInstance.methods
      .currentProposer()
      .call();

    res.json({ currentProposer });
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 *  /proposer/proposers:
 *    get:
 *      tags:
 *      - Proposer
 *      summary: Proposers list.
 *      description: Returns all registered proposers.
 *      responses:
 *        200:
 *          $ref: '#/components/responses/SuccessProposerList'
 *        400:
 *          $ref: '#/components/responses/BadRequest'
 *        500:
 *          $ref: '#/components/responses/InternalServerError'
 */
router.get('/proposers', async (req, res, next) => {
  try {
    const proposers = await getProposers();

    res.json({ proposers });
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 *  /proposer/de-register:
 *    post:
 *      security:
 *        - ApiKeyAuth: []
 *      tags:
 *      - Proposer
 *      summary: Deregister proposer.
 *      description: De-register a proposer - removes proposer from Proposers contract.
 *        Proposers can de-register even when they are the current proposer.
 *      parameters:
 *        - in: header
 *          name: api_key
 *          schema:
 *            type: string
 *            format: uuid
 *          required: true
 *      responses:
 *        200:
 *          $ref: '#/components/responses/SuccessDeregisterProposer'
 *        401:
 *          $ref: '#/components/responses/Unauthorized'
 *        500:
 *          $ref: '#/components/responses/InternalServerError'
 */
router.post('/de-register', auth, async (req, res, next) => {
  const ethAddress = req.app.get('proposerEthAddress');
  const ethPrivateKey = req.app.get('proposerEthPrivateKey');

  try {
    // Recreate Proposer contract
    const proposersContractInstance = await getContractInstance(PROPOSERS_CONTRACT_NAME);

    // Remove proposer
    const txDataToSign = await proposersContractInstance.methods.deRegisterProposer().encodeABI();

    // Sign tx
    const proposersContractAddress = proposersContractInstance.options.address;
    const signedTx = await createSignedTransaction(
      ethPrivateKey,
      ethAddress,
      proposersContractAddress,
      txDataToSign,
    );

    // Submit tx and update db if tx is successful
    txsQueue.push(async () => {
      try {
        const receipt = await sendSignedTransaction(signedTx);
        logger.debug({ msg: 'Proposer removed', receipt });

        await deleteRegisteredProposerAddress(ethAddress);
        logger.debug('Proposer removed from db');
      } catch (err) {
        logger.error({
          msg: 'Something went wrong',
          err,
        });
      }
    });

    const { transactionHash } = signedTx;
    res.json({ transactionHash });
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 *  /proposer/withdrawStake:
 *    post:
 *      security:
 *        - ApiKeyAuth: []
 *      tags:
 *      - Proposer
 *      summary: Withdraw stake.
 *      description: Withdraw stake for a de-registered proposer.
 *        Can only be called after the cooling off period.
 *      parameters:
 *        - in: header
 *          name: api_key
 *          schema:
 *            type: string
 *            format: uuid
 *          required: true
 *      responses:
 *        200:
 *          $ref: '#/components/responses/SuccessWithdrawStake'
 *        401:
 *          $ref: '#/components/responses/Unauthorized'
 *        500:
 *          $ref: '#/components/responses/InternalServerError'
 */
router.post('/withdrawStake', auth, async (req, res, next) => {
  const ethAddress = req.app.get('proposerEthAddress');
  const ethPrivateKey = req.app.get('proposerEthPrivateKey');

  try {
    // Recreate Proposer contract
    const proposersContractInstance = await getContractInstance(PROPOSERS_CONTRACT_NAME);

    // Withdraw proposer stake
    const txDataToSign = await proposersContractInstance.methods.withdrawStake().encodeABI();

    // Sign tx
    const proposersContractAddress = proposersContractInstance.options.address;
    const signedTx = await createSignedTransaction(
      ethPrivateKey,
      ethAddress,
      proposersContractAddress,
      txDataToSign,
    );

    // Submit tx
    txsQueue.push(async () => {
      try {
        const receipt = await sendSignedTransaction(signedTx);
        logger.debug({ msg: 'Proposer stake withdrawn', receipt });
      } catch (err) {
        logger.error({
          msg: 'Something went wrong',
          err,
        });
      }
    });

    const { transactionHash } = signedTx;
    res.json({ transactionHash });
  } catch (error) {
    next(error);
  }
});

/**
 * @openapi
 *  /proposer/pending-payments:
 *    get:
 *      security:
 *        - ApiKeyAuth: []
 *      tags:
 *      - Proposer
 *      summary: Pending payments.
 *      description: TBC Get pending payments for new blocks proposed or successful block challenges.
 *      parameters:
 *        - in: header
 *          name: api_key
 *          schema:
 *            type: string
 *            format: uuid
 *          required: true
 *      responses:
 *        200:
 *          $ref: '#/components/responses/SuccessPendingPayments'
 *        401:
 *          $ref: '#/components/responses/Unauthorized'
 *        500:
 *          $ref: '#/components/responses/InternalServerError'
 */
router.get('/pending-payments', auth, async (req, res, next) => {
  const ethAddress = req.app.get('proposerEthAddress');
  const pendingPayments = [];

  try {
    const blocks = await findBlocksByProposer(ethAddress);
    const shieldContractInstance = await getContractInstance(SHIELD_CONTRACT_NAME);

    for (let i = 0; i < blocks.length; i++) {
      let pending;
      let challengePeriod = false;
      try {
        // eslint-disable-next-line no-await-in-loop
        pending = await shieldContractInstance.methods
          .isBlockPaymentPending(blocks[i].blockNumberL2)
          .call();
      } catch (e) {
        if (e.message.includes('Too soon to get paid for this block')) {
          challengePeriod = true;
          pending = true;
        } else {
          pending = false;
        }
      }

      if (pending) {
        pendingPayments.push({ blockHash: blocks[i].blockHash, challengePeriod });
      }
    }
    res.json({ pendingPayments });
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 *  /proposer/stake:
 *    get:
 *      security:
 *        - ApiKeyAuth: []
 *      tags:
 *      - Proposer
 *      summary: Get stake.
 *      description: Request stake data - available stake, and locked stake plus locked time reference.
 *      parameters:
 *        - in: header
 *          name: api_key
 *          schema:
 *            type: string
 *            format: uuid
 *          required: true
 *      responses:
 *        200:
 *          $ref: '#/components/responses/SuccessCurrentStake'
 *        401:
 *          $ref: '#/components/responses/Unauthorized'
 *        400:
 *          $ref: '#/components/responses/BadRequest'
 *        500:
 *          $ref: '#/components/responses/InternalServerError'
 */
router.get('/stake', auth, async (req, res, next) => {
  const ethAddress = req.app.get('proposerEthAddress');

  try {
    const stateContractInstance = await getContractInstance(STATE_CONTRACT_NAME);
    const stakeAccount = await stateContractInstance.methods.getStakeAccount(ethAddress).call();

    res.json({
      amount: Number(stakeAccount[0]),
      challengeLocked: Number(stakeAccount[1]),
      time: Number(stakeAccount[2]),
    });
  } catch (err) {
    logger.error(err);
    next(err);
  }
});

/**
 * @openapi
 *  /proposer/withdraw:
 *    get:
 *      security:
 *        - ApiKeyAuth: []
 *      tags:
 *      - Proposer
 *      summary: Finalise withdrawal.
 *      description: Withdraw profits to account after calling /payment.
 *      parameters:
 *        - in: header
 *          name: api_key
 *          schema:
 *            type: string
 *            format: uuid
 *          required: true
 *      responses:
 *        200:
 *          $ref: '#/components/responses/SuccessWithdrawPayment'
 *        401:
 *          $ref: '#/components/responses/Unauthorized'
 *        500:
 *          $ref: '#/components/responses/InternalServerError'
 */
router.get('/withdraw', auth, async (req, res, next) => {
  const ethAddress = req.app.get('proposerEthAddress');
  const ethPrivateKey = req.app.get('proposerEthPrivateKey');

  try {
    // Recreate State contract
    const stateContractInstance = await getContractInstance(STATE_CONTRACT_NAME);

    // Withdraw profits
    const txDataToSign = await stateContractInstance.methods.withdraw().encodeABI();

    // Sign tx
    const stateContractAddress = stateContractInstance.options.address;
    const signedTx = await createSignedTransaction(
      ethPrivateKey,
      ethAddress,
      stateContractAddress,
      txDataToSign,
    );

    // Submit tx
    txsQueue.push(async () => {
      try {
        const receipt = await sendSignedTransaction(signedTx);
        logger.debug({ msg: 'Proposer profits withdrawn', receipt });
      } catch (err) {
        logger.error({
          msg: 'Something went wrong',
          err,
        });
      }
    });

    const { transactionHash } = signedTx;
    res.json({ transactionHash });
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /proposer/payment:
 *   post:
 *     security:
 *       - ApiKeyAuth: []
 *     tags:
 *     - Proposer
 *     summary: Initiate withdrawal.
 *     description: Request payment for new blocks successfully proposed or challenged.
 *       Also unlocks any locked stake after the cooling off period.
 *       Then /withdraw can be called to recover the money.
 *       Can only be called after the cooling off period.
 *     parameters:
 *        - in: header
 *          name: api_key
 *          schema:
 *            type: string
 *            format: uuid
 *          required: true
 *     requestBody:
 *       $ref: '#/components/requestBodies/ProposerPayment'
 *     responses:
 *       200:
 *         $ref: '#/components/responses/SuccessProposerPayment'
 *       401:
 *          $ref: '#/components/responses/Unauthorized'
 *       500:
 *         $ref: '#/components/responses/InternalServerError'
 */
router.post('/payment', auth, async (req, res, next) => {
  const ethAddress = req.app.get('proposerEthAddress');
  const ethPrivateKey = req.app.get('proposerEthPrivateKey');

  const { blockHash } = req.body;

  try {
    // Validate blockHash
    if (!blockHash) {
      throw new Error('Rest API `blockHash` not provided');
    }
    const block = await getBlockByBlockHash(blockHash);

    // Recreate Shield contract
    const shieldContractInstance = await getContractInstance(SHIELD_CONTRACT_NAME);

    // Request payment, unlock stake
    const txDataToSign = await shieldContractInstance.methods
      .requestBlockPayment(block)
      .encodeABI();

    // Sign tx
    const shieldContractAddress = shieldContractInstance.options.address;
    const signedTx = await createSignedTransaction(
      ethPrivateKey,
      ethAddress,
      shieldContractAddress,
      txDataToSign,
    );

    // Submit tx
    txsQueue.push(async () => {
      try {
        const receipt = await sendSignedTransaction(signedTx);
        logger.debug({ msg: 'Proposer payment completed', receipt });
      } catch (err) {
        logger.error({
          msg: 'Something went wrong',
          err,
        });
      }
    });

    const { transactionHash } = signedTx;
    res.json({ transactionHash });
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /proposer/change:
 *   get:
 *     security:
 *       - ApiKeyAuth: []
 *     tags:
 *     - Proposer
 *     summary: Change current proposer.
 *     description: Change the current proposer once their time has elapsed.
 *     parameters:
 *        - in: header
 *          name: api_key
 *          schema:
 *            type: string
 *            format: uuid
 *          required: true
 *     responses:
 *       200:
 *         $ref: '#/components/responses/SuccessChangeProposer'
 *       401:
 *          $ref: '#/components/responses/Unauthorized'
 *       500:
 *         $ref: '#/components/responses/InternalServerError'
 */
router.get('/change', auth, async (req, res, next) => {
  const ethAddress = req.app.get('proposerEthAddress');
  const ethPrivateKey = req.app.get('proposerEthPrivateKey');

  try {
    // Recreate State contract
    const stateContractInstance = await getContractInstance(STATE_CONTRACT_NAME);

    // Attempt to rotate proposer currently proposing blocks
    const txDataToSign = await stateContractInstance.methods.changeCurrentProposer().encodeABI();

    // Sign tx
    const stateContractAddress = stateContractInstance.options.address;
    const signedTx = await createSignedTransaction(
      ethPrivateKey,
      ethAddress,
      stateContractAddress,
      txDataToSign,
    );

    // Submit tx
    txsQueue.push(async () => {
      try {
        const receipt = await sendSignedTransaction(signedTx);
        logger.debug({ msg: 'Proposer was rotated', receipt });
      } catch (err) {
        logger.error({
          msg: 'Something went wrong',
          err,
        });
      }
    });

    const { transactionHash } = signedTx;
    res.json({ transactionHash });
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /proposer/mempool:
 *   get:
 *     tags:
 *     - Proposer
 *     summary: Get transactions still in mempool.
 *     description: Get transactions from this proposer's mempool.
 *     responses:
 *       200:
 *         $ref: '#/components/responses/Success'
 *       400:
 *          $ref: '#/components/responses/BadRequest'
 *       500:
 *         $ref: '#/components/responses/InternalServerError'
 */
router.get('/mempool', async (req, res, next) => {
  try {
    const mempool = await getMempoolTransactions();
    res.json({ result: mempool });
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /proposer/encode:
 *   post:
 *     security:
 *       - ApiKeyAuth: []
 *     tags:
 *     - Proposer
 *     summary: Encode.
 *     description: TBC
 *     parameters:
 *        - in: header
 *          name: api_key
 *          schema:
 *            type: string
 *            format: uuid
 *          required: true
 *     responses:
 *       200:
 *         $ref: '#/components/responses/Success'
 *       401:
 *          $ref: '#/components/responses/Unauthorized'
 *       500:
 *         $ref: '#/components/responses/InternalServerError'
 */
router.post('/encode', auth, async (req, res, next) => {
  const ethAddress = req.app.get('proposerEthAddress');
  const ethPrivateKey = req.app.get('proposerEthPrivateKey');

  const { transactions, block } = req.body;

  try {
    // Recreate State contract
    const stateContractInstance = await waitForContract(STATE_CONTRACT_NAME);

    const latestTree = await getLatestTree();
    let currentLeafCount = latestTree.leafCount;
    /*
      normally we re-compute the leafcount. If however block.leafCount is -ve
      that's a signal to use the value given (once we've flipped the sign back)
     */
    if (block.leafCount < 0) currentLeafCount = -block.leafCount;

    const newTransactions = await Promise.all(
      transactions.map(t => {
        const transaction = t;
        transaction.transactionHash = Transaction.calcHash(transaction);
        return transaction;
      }),
    );

    if (!block.root) {
      const leafValues = newTransactions
        .map(newTransaction => newTransaction.commitments.filter(c => c !== ZERO))
        .flat(Infinity);
      const { root, frontierTimber } = Timber.statelessUpdate(
        latestTree,
        leafValues,
        HASH_TYPE,
        TIMBER_HEIGHT,
      );
      block.root = root;
      block.frontierHash = await Block.calcFrontierHash(frontierTimber);
    }

    const newBlock = {
      proposer: block.proposer,
      transactionHashes: transactions.map(transaction => transaction.transactionHash),
      root: block.root,
      leafCount: currentLeafCount,
      nCommitments: block.nCommitments,
      blockNumberL2: block.blockNumberL2,
      previousBlockHash: block.previousBlockHash,
      frontierHash: block.frontierHash,
      transactionHashesRoot: block.transactionHashesRoot,
    };
    newBlock.blockHash = await Block.calcHash(newBlock, newTransactions);

    logger.debug({
      msg: 'New block encoded for test',
      newBlock,
    });

    const txDataToSign = await stateContractInstance.methods
      .proposeBlock(
        Block.buildSolidityStruct(newBlock),
        newTransactions.map(t => Transaction.buildSolidityStruct(t)),
      )
      .encodeABI();

    // Sign and submit tx
    const stateContractAddress = stateContractInstance.options.address;
    const signedTx = await createSignedTransaction(
      ethPrivateKey,
      ethAddress,
      stateContractAddress,
      txDataToSign,
    );
    const receipt = await sendSignedTransaction(signedTx);

    res.json({ receipt, block: newBlock, transactions: newTransactions });
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /proposer/offchain-transaction:
 *   post:
 *     tags:
 *     - Proposer
 *     summary: Add an off-chain transaction to mempool.
 *     description: Request to add an off-chain transaction from a client to this proposer mempool, for a fee.
 *       This is only available for L2 transfers amd withdrawals.
 *       Client must cover the proposer minimum fee.
 *     responses:
 *       200:
 *         $ref: '#/components/responses/Success'
 *       400:
 *          $ref: '#/components/responses/BadRequest'
 *       500:
 *         $ref: '#/components/responses/InternalServerError'
 */
router.post('/offchain-transaction', async (req, res) => {
  const { transaction } = req.body;
  /*
    When a transaction is built by client, they are generalised into hex(32) interfacing with web3
    The response from on-chain events converts them to saner string values (e.g. uint64 etc).
    Since we do the transfer off-chain, we do the conversation manually here.
   */
  const { circuitHash, fee } = transaction;

  try {
    const stateInstance = await waitForContract(STATE_CONTRACT_NAME);
    const circuitInfo = await stateInstance.methods.getCircuitInfo(circuitHash).call();
    if (circuitInfo.isEscrowRequired) {
      res.sendStatus(400);
    } else {
      /*
          When comparing this with getTransactionSubmittedCalldata,
          note we don't need to decompressProof as proofs are only compressed if they go on-chain.
          let's not directly call transactionSubmittedEventHandler, instead, we'll queue it
         */
      await enqueueEvent(transactionSubmittedEventHandler, 1, {
        offchain: true,
        ...transaction,
        fee: Number(fee),
      });

      res.sendStatus(200);
    }
  } catch (err) {
    if (err instanceof TransactionError) {
      logger.warn(
        `The transaction check failed with error: ${err.message}. The transaction has been ignored`,
      );
    } else {
      logger.error(err);
    }

    res.sendStatus(400);
  }
});

export default router;
