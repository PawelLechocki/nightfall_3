/**
 Route for commitment to access commitment data from the database
 */

import express from 'express';
import gen from 'general-number';
import { getCircuitHash } from 'common-files/utils/worker-calls.mjs';
import constants from 'common-files/constants/index.mjs';
import {
  getCommitmentBySalt,
  getWalletBalance,
  getWalletBalanceUnfiltered,
  getWalletCommitments,
  getWalletPendingDepositBalance,
  getWalletPendingSpentBalance,
  getCommitments,
  getCommitmentsByCompressedZkpPublicKeyList,
  insertCommitments,
  getCommitmentsByCircuitHash,
  getCommitmentsDepositedRollbacked,
} from '../services/commitment-storage.mjs';
import { syncState } from '../services/state-sync.mjs';
import { getAllTransactions } from '../services/database.mjs';

const router = express.Router();

const { generalise } = gen;

const { WITHDRAW } = constants;

router.get('/salt', async (req, res, next) => {
  try {
    const { salt } = req.query;
    const commitment = await getCommitmentBySalt(salt);
    res.json({ commitment });
  } catch (err) {
    next(err);
  }
});

router.get('/balance', async (req, res, next) => {
  try {
    const { compressedZkpPublicKey, ercList } = req.query;
    let balance;
    if (compressedZkpPublicKey) balance = await getWalletBalance(compressedZkpPublicKey, ercList);
    else balance = await getWalletBalanceUnfiltered(compressedZkpPublicKey, ercList);
    res.json({ balance });
  } catch (err) {
    next(err);
  }
});

router.get('/pending-deposit', async (req, res, next) => {
  try {
    const { compressedZkpPublicKey, ercList } = req.query;
    const balance = await getWalletPendingDepositBalance(compressedZkpPublicKey, ercList);
    res.json({ balance });
  } catch (err) {
    next(err);
  }
});

router.get('/pending-spent', async (req, res, next) => {
  try {
    const { compressedZkpPublicKey, ercList } = req.query;
    const balance = await getWalletPendingSpentBalance(compressedZkpPublicKey, ercList);
    res.json({ balance });
  } catch (err) {
    next(err);
  }
});

router.get('/commitments', async (req, res, next) => {
  try {
    const { compressedZkpPublicKey, ercList } = req.query;
    const commitments = await getWalletCommitments(compressedZkpPublicKey, ercList);
    res.json({ commitments });
  } catch (err) {
    next(err);
  }
});

/**
 * @description the endpoint that will save a list of commitments
 */
router.post('/save', async (req, res, next) => {
  const listOfCommitments = req.body;
  try {
    const response = await insertCommitments(listOfCommitments);
    await syncState(); // Sycronize from beggining
    res.json(response);
  } catch (err) {
    next(err);
  }
});

/**
 * @description the endpoint that will send a reponse with all the
 * existent commitments for the list of compressedPkd received in the
 * request body. We're using POST for this endpoint, because if the
 * number of compressed keys per user increase the query params have
 * a size limit.
 * @author luizoamorim
 */
router.post('/compressedZkpPublicKeys', async (req, res, next) => {
  const listOfCompressedZkpPublicKey = req.body;
  try {
    const commitmentsByListOfCompressedZkpPublicKey =
      await getCommitmentsByCompressedZkpPublicKeyList(listOfCompressedZkpPublicKey);
    res.json({ commitmentsByListOfCompressedZkpPublicKey });
  } catch (err) {
    next(err);
  }
});

/**
 * @description the endpoint that will send a reponse with all the
 * existent commitments.
 * @author luizoamorim
 */
router.get('/', async (req, res, next) => {
  try {
    const allCommitments = await getCommitments();
    res.json({ allCommitments });
  } catch (err) {
    next(err);
  }
});

router.get('/withdraws', async (req, res, next) => {
  try {
    const circuitHash = await getCircuitHash(WITHDRAW);

    const withdrawCircuitHash = generalise(circuitHash).hex(32);

    const commitments = await getCommitmentsByCircuitHash(withdrawCircuitHash);
    res.json({ commitments });
  } catch (err) {
    next(err);
  }
});

router.get('/commitmentsRollbacked', async (req, res, next) => {
  try {
    const { compressedZkpPublicKey } = req.query;
    const commitmentsRollbacked = await getCommitmentsDepositedRollbacked(compressedZkpPublicKey);
    res.json({ commitmentsRollbacked });
  } catch (err) {
    next(err);
  }
});

router.get('/transactions', async (req, res, next) => {
  try {
    const transactions = await getAllTransactions();
    res.json({ transactions });
  } catch (err) {
    next(err);
  }
});

export default router;
