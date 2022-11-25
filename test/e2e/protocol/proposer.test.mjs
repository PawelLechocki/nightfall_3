/* eslint-disable prefer-destructuring */
/* eslint-disable @babel/no-unused-expressions */
/* eslint-disable no-await-in-loop */
import chai from 'chai';
import chaiHttp from 'chai-http';
import chaiAsPromised from 'chai-as-promised';
import config from 'config';
import { UserFactory } from 'nightfall-sdk';
import axios from 'axios';
import constants from '@polygon-nightfall/common-files/constants/index.mjs';
import Nf3 from '../../../cli/lib/nf3.mjs';
import { isTransactionMined, Web3Client } from '../../utils.mjs';

const { expect } = chai;
chai.use(chaiHttp);
chai.use(chaiAsPromised);

const { PROPOSERS_CONTRACT_NAME, STATE_CONTRACT_NAME } = constants;

const environment = config.ENVIRONMENTS[process.env.ENVIRONMENT] || config.ENVIRONMENTS.localhost;
const { mnemonics, signingKeys, ROTATE_PROPOSER_BLOCKS, fee, transferValue } = config.TEST_OPTIONS;

const web3Client = new Web3Client();
const eventLogs = [];

let web3;
let stateAddress;
let proposersAddress;
let stateABI;

const getStakeAccount = async ethAccount => {
  const stateContractInstance = new web3.eth.Contract(stateABI, stateAddress);
  return stateContractInstance.methods.getStakeAccount(ethAccount).call();
};

const getCurrentProposer = async () => {
  const stateContractInstance = new web3.eth.Contract(stateABI, stateAddress);
  return stateContractInstance.methods.getCurrentProposer().call();
};

const filterByThisProposer = async nf3proposer => {
  const { proposers } = await nf3proposer.getProposers();
  return proposers.filter(p => p.thisAddress === nf3proposer.ethereumAddress);
};

const getCurrentSprint = async () => {
  const stateContractInstance = new web3.eth.Contract(stateABI, stateAddress);
  return stateContractInstance.methods.currentSprint().call();
};

describe('Basic Proposer tests', () => {
  let minimumStake;
  let erc20Address;
  let user;

  const feeDefault = 0;
  const bootProposer = new Nf3(signingKeys.proposer1, environment);
  const testProposersUrl = ['http://test-proposer1', 'http://test-proposer2'];

  before(async () => {
    web3 = web3Client.getWeb3();

    user = await UserFactory.create({
      blockchainWsUrl: environment.web3WsUrl,
      clientApiUrl: environment.clientApiUrl,
      ethereumPrivateKey: signingKeys.user1,
    });

    await bootProposer.init(mnemonics.proposer);

    minimumStake = await bootProposer.getMinimumStake();
    stateABI = await bootProposer.getContractAbi(STATE_CONTRACT_NAME);
    stateAddress = await bootProposer.getContractAddress(STATE_CONTRACT_NAME);
    proposersAddress = await bootProposer.getContractAddress(PROPOSERS_CONTRACT_NAME);
    erc20Address = await bootProposer.getContractAddress('ERC20Mock');
    web3Client.subscribeTo('logs', eventLogs, { address: stateAddress });
    web3Client.subscribeTo('logs', eventLogs, { address: proposersAddress });
  });

  it('Should access any public route with any API key', async () => {
    bootProposer.resetApiKey();
    const { status } = await axios.get(`${environment.optimistApiUrl}/proposer/mempool`);
    expect(status).to.equal(200);
  });

  it('Should access any public route with the correct API key', async () => {
    bootProposer.setApiKey(environment.PROPOSER_KEY);
    const { status } = await axios.get(`${environment.optimistApiUrl}/proposer/mempool`);
    expect(status).to.equal(200);
  });

  it('Should fail to register a proposer without an API key', async () => {
    try {
      bootProposer.resetApiKey();
      await bootProposer.registerProposer(testProposersUrl[0], minimumStake);
      expect.fail();
    } catch (err) {
      expect(err);
    } finally {
      bootProposer.setApiKey(environment.PROPOSER_KEY);
    }
  });

  it('Should fail to register a proposer without a valid API key', async () => {
    try {
      bootProposer.setApiKey('test');
      await bootProposer.registerProposer(testProposersUrl[0], minimumStake);
      expect.fail();
    } catch (err) {
      expect(err);
    } finally {
      bootProposer.setApiKey(environment.PROPOSER_KEY);
    }
  });

  it('Should register the boot proposer - await for this to become current', async () => {
    // Before registering proposer
    const proposersBeforeRegister = await filterByThisProposer(bootProposer);
    const stakeBeforeRegister = await getStakeAccount(bootProposer.ethereumAddress);

    // Register proposer, wait for proposer to become current proposer
    const url = testProposersUrl[0];
    await bootProposer.registerProposer(url, minimumStake, feeDefault);
    await web3Client.waitForEvent(eventLogs, ['NewCurrentProposer']);

    // After registering proposer
    const proposersAfterRegister = await filterByThisProposer(bootProposer);
    const stakeAfterRegister = await getStakeAccount(bootProposer.ethereumAddress);

    // Assertions, before registering
    expect(proposersBeforeRegister).to.be.an('array').that.is.empty;
    // After
    expect(proposersAfterRegister).to.have.lengthOf(1);

    expect(proposersAfterRegister[0].url).to.be.equal(url);
    expect(Number(proposersAfterRegister[0].fee)).to.be.equal(feeDefault);

    const amountAfterRegister = Number(stakeBeforeRegister.amount) + Number(minimumStake);
    expect(Number(stakeAfterRegister.amount)).equal(amountAfterRegister);
  });

  it('Should return registered proposer as current proposer', async () => {
    const { thisAddress: currentProposer } = await getCurrentProposer();
    expect(currentProposer).to.be.equal(bootProposer.ethereumAddress);
  });

  it('Should fail to register a proposer twice', async () => {
    const res = await bootProposer.registerProposer('potato', minimumStake);
    // Registration attempt will be ignored at the endpoint since the Eth address will be the same
    expect(res.data).to.be.an('object').that.is.empty;
  });

  it('Should update the proposer fee', async () => {
    // Before updating proposer
    const proposersBeforeUpdate = await filterByThisProposer(bootProposer);
    const stakeBeforeUpdate = await getStakeAccount(bootProposer.ethereumAddress);
    expect(proposersBeforeUpdate).to.have.lengthOf(1); // Leave here to safely access array by idx

    // Update proposer fee
    const currentUrl = proposersBeforeUpdate[0].url; // Need to pass current value
    const stake = 0; // Contract adds given value to existing amount
    const newFee = fee;
    const { transactionHash } = await bootProposer.updateProposer(currentUrl, stake, newFee);

    // Wait for transaction to be mined
    await isTransactionMined(transactionHash, web3);

    // After updating proposer
    const proposersAfterUpdate = await filterByThisProposer(bootProposer);
    const stakeAfterUpdate = await getStakeAccount(bootProposer.ethereumAddress);

    // Assertions, before updating fee
    expect(Number(proposersBeforeUpdate[0].fee)).to.be.equal(feeDefault);
    // After - url and stake remain the same
    expect(proposersAfterUpdate).to.have.lengthOf(1);
    expect(Number(proposersAfterUpdate[0].fee)).to.be.equal(newFee);

    expect(proposersAfterUpdate[0].url).to.be.equal(currentUrl);
    expect(Number(stakeAfterUpdate.amount)).to.be.equal(Number(stakeBeforeUpdate.amount));
  });

  it('Should update the proposer url', async () => {
    // Before updating proposer
    const proposersBeforeUpdate = await filterByThisProposer(bootProposer);
    const stakeBeforeUpdate = await getStakeAccount(bootProposer.ethereumAddress);
    expect(proposersBeforeUpdate).to.have.lengthOf(1); // Leave here to safely access array by idx

    // Update proposer url
    const newUrl = testProposersUrl[1];
    const stake = 0; // Contract adds given value to existing amount
    const currentFee = Number(proposersBeforeUpdate[0].fee); // Need to pass current value
    const { transactionHash } = await bootProposer.updateProposer(newUrl, stake, currentFee);

    // Wait for transaction to be mined
    await isTransactionMined(transactionHash, web3);

    // After updating proposer
    const proposersAfterUpdate = await filterByThisProposer(bootProposer);
    const stakeAfterUpdate = await getStakeAccount(bootProposer.ethereumAddress);

    // Assertions, before updating url
    expect(proposersBeforeUpdate[0].url).to.be.equal(testProposersUrl[0]);
    // After - fee and stake remain the same
    expect(proposersAfterUpdate).to.have.lengthOf(1);
    expect(proposersAfterUpdate[0].url).to.be.equal(newUrl);

    expect(Number(proposersAfterUpdate[0].fee)).to.be.equal(fee);
    expect(Number(stakeAfterUpdate.amount)).to.be.equal(Number(stakeBeforeUpdate.amount));
  });

  it('Should update the proposer stake', async () => {
    // Before updating proposer
    const proposersBeforeUpdate = await filterByThisProposer(bootProposer);
    const stakeBeforeUpdate = await getStakeAccount(bootProposer.ethereumAddress);
    expect(proposersBeforeUpdate).to.have.lengthOf(1); // Leave here to safely access array by idx

    // Update proposer url
    const currentUrl = proposersBeforeUpdate[0].url;
    const currentFee = Number(proposersBeforeUpdate[0].fee); // Need to pass current value
    const { transactionHash } = await bootProposer.updateProposer(
      currentUrl,
      minimumStake,
      currentFee,
    );

    // Wait for transaction to be mined
    await isTransactionMined(transactionHash, web3);

    // After updating proposer
    const proposersAfterUpdate = await filterByThisProposer(bootProposer);
    const stakeAfterUpdate = await getStakeAccount(bootProposer.ethereumAddress);

    // Assertions - url and fee remain the same
    expect(proposersAfterUpdate).to.have.lengthOf(1);

    const amountAfterUpdate = Number(stakeBeforeUpdate.amount) + Number(minimumStake);
    expect(Number(stakeAfterUpdate.amount)).to.be.equal(amountAfterUpdate);

    expect(proposersAfterUpdate[0].url).to.be.equal(currentUrl);
    expect(Number(proposersAfterUpdate[0].fee)).to.be.equal(currentFee);
  });

  it.skip('Should fail to change current proposer because insufficient blocks have passed', async () => {
    // SKIP Call fails as expected but revert reason `State: Too soon to rotate proposer` is not captured
    // TODO We should be able to assert that it is actually too soon

    // Note that the test operates with one proposer, which is why we use the current proposer
    // to call `changeCurrentProposer`, in reality this proposer would be the least interested
    let error = null;
    try {
      await bootProposer.changeCurrentProposer();
    } catch (err) {
      error = err;
    }
    expect(error.message).to.satisfy(message =>
      message.includes('Transaction has been reverted by the EVM'),
    );
  });

  it('Should be able to make a block any time as soon as there are txs in the mempool', async () => {
    // User balance in L2 before making deposit
    const balancesBeforeBlockProposed = await user.checkNightfallBalances();

    // Make deposit, then make block to settle the deposit
    const value = String(transferValue * 2);
    await user.makeDeposit({
      tokenContractAddress: String(erc20Address),
      value,
    });
    await bootProposer.makeBlockNow();

    // Wait before checking user balance in L2 again
    await web3Client.waitForEvent(eventLogs, ['blockProposed']);
    const balancesAfterBlockProposed = await user.checkNightfallBalances();

    // Assertions
    expect(balancesBeforeBlockProposed).to.be.an('object').that.is.empty;
    expect(balancesAfterBlockProposed).to.have.property(erc20Address);

    const erc20balances = balancesAfterBlockProposed[erc20Address];
    expect(erc20balances).to.have.lengthOf(1);
    expect(String(erc20balances[0].balance)).to.have.string(value); // Balance is in Wei, so we compare strings
  });

  it.skip('Should change the current proposer', async function () {
    // SKIP We need to spin a second optimist if we want to keep this test
    const CHANGE_PROPOSER_NO_TIMES = 8;
    let numChanges = 0;
    for (let i = 0; i < CHANGE_PROPOSER_NO_TIMES; i++) {
      try {
        const currentSprint = await getCurrentSprint();
        const currentProposer = await getCurrentProposer();
        console.log(
          `     [ Current sprint: ${currentSprint}, Current proposer: ${currentProposer.thisAddress} ]`,
        );

        console.log('     Waiting blocks to rotate current proposer...');
        const initBlock = await web3.eth.getBlockNumber();
        let currentBlock = initBlock;

        while (currentBlock - initBlock < ROTATE_PROPOSER_BLOCKS) {
          await new Promise(resolve => setTimeout(resolve, 10000));
          currentBlock = await web3.eth.getBlockNumber();
        }

        // const res = await secondProposer.changeCurrentProposer();
        // expectTransaction(res);
        numChanges++;
      } catch (err) {
        console.log(err);
      }
    }
    expect(numChanges).to.be.equal(CHANGE_PROPOSER_NO_TIMES);
  });

  it('Should de-register the proposer even when it is current proposer', async () => {
    // Before de-registering proposer
    const proposersBeforeDeregister = await filterByThisProposer(bootProposer);
    const { thisAddress: currentProposer } = await getCurrentProposer();

    // De-register proposer
    await bootProposer.deregisterProposer();
    await web3Client.waitForEvent(eventLogs, ['NewCurrentProposer']);

    // After de-registering proposer
    const proposersAfterDeregister = await filterByThisProposer(bootProposer);

    // Assertions, before de-registering
    expect(proposersBeforeDeregister).to.have.lengthOf(1);
    expect(currentProposer).to.be.equal(bootProposer.ethereumAddress);
    // After
    expect(proposersAfterDeregister).to.be.an('array').that.is.empty;
  });

  it('Should return default 0x0..0 as current proposer', async () => {
    const { thisAddress: currentProposer } = await getCurrentProposer();
    expect(currentProposer).to.have.string('0x0');
  });

  it.skip('Should fail to withdraw stake due to the cooling off period', async () => {
    // TODO
    try {
      await bootProposer.withdrawStake();
      expect.fail();
    } catch (err) {
      expect(err.message).to.satisfy(
        message =>
          message.includes(
            'Returned error: VM Exception while processing transaction: revert It is too soon to withdraw your bond',
          ) || message.includes('Transaction has been reverted by the EVM'),
      );
    }
  });

  it.skip('Should be able to withdraw stake', async () => {
    // TODO
    if ((await web3Client.getInfo()).includes('TestRPC')) await web3Client.timeJump(3600 * 24 * 10); // jump in time by 7 days
    if ((await web3Client.getInfo()).includes('TestRPC')) {
      await bootProposer.withdrawStake();
    } else {
      let error = null;
      try {
        await bootProposer.withdrawStake();
      } catch (err) {
        error = err;
      }
      expect(error.message).to.include('Transaction has been reverted by the EVM');
    }
  });

  after(async () => {
    await bootProposer.close();
    user.close();
    web3Client.closeWeb3();
  });
});
