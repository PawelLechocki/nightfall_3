/**
 This module creates blockchain transactions to interact with the KYC smart contract
*/

import constants from 'common-files/constants/index.mjs';
import { waitForContract } from 'common-files/utils/contract.mjs';

const { SHIELD_CONTRACT_NAME } = constants;

export async function isWhitelisted(address) {
  const shieldContractInstance = await waitForContract(SHIELD_CONTRACT_NAME);
  return shieldContractInstance.methods.isWhitelisted(address).call();
}

export async function addUserToWhitelist(address) {
  const shieldContractInstance = await waitForContract(SHIELD_CONTRACT_NAME);
  return shieldContractInstance.methods.addUserToWhitelist(address).encodeABI();
}

export async function removeUserFromWhitelist(address) {
  const shieldContractInstance = await waitForContract(SHIELD_CONTRACT_NAME);
  return shieldContractInstance.methods.removeUserFromWhitelist(address).encodeABI();
}