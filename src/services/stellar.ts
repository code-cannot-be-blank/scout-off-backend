import {
  SorobanRpc,
  Networks,
  Contract,
  TransactionBuilder,
  BASE_FEE,
  Keypair,
  Account,
  Address,
  scValToNative,
  nativeToScVal,
} from '@stellar/stellar-sdk';
import config from '../config';

const server = new SorobanRpc.Server(config.sorobanRpcUrl, {
  allowHttp: config.sorobanRpcUrl.startsWith('http://'),
});

export { server };

export function networkPassphrase(): string {
  return config.network === 'mainnet'
    ? Networks.PUBLIC
    : Networks.TESTNET;
}

export async function getLatestLedger(): Promise<number> {
  const ledger = await server.getLatestLedger();
  return ledger.sequence;
}

export type PaymentStatus = 'pending' | 'submitted' | 'failed';

export interface ContactPaymentResult {
  transactionId: string;
  status: PaymentStatus;
}

export class PaymentError extends Error {
  constructor(
    message: string,
    public readonly code: 'INSUFFICIENT_FUNDS' | 'INVALID_ACCOUNT' | 'NETWORK_ERROR' | 'UNKNOWN',
  ) {
    super(message);
    this.name = 'PaymentError';
  }
}

/**
 * Ping the Soroban RPC to verify network reachability.
 */
export async function stellarHealth(): Promise<boolean> {
  try {
    await server.getLatestLedger();
    return true;
  } catch {
    return false;
  }
}

/**
 * Check whether a scout has an active on-chain subscription by invoking
 * `is_subscribed(scout)` on the Soroban contract via simulateTransaction.
 *
 * The contract function returns a plain bool; the expiry ledger is not
 * exposed via this entry point, so expiresAt is '' for active and null
 * for inactive/absent subscriptions.
 */
export async function isSubscribed(
  scoutWallet: string,
): Promise<{ active: boolean; expiresAt: string | null }> {
  if (!scoutWallet) {
    throw new PaymentError('Missing scoutWallet', 'INVALID_ACCOUNT');
  }

  try {
    const contract = new Contract(config.contractId);
    // Use a random ephemeral keypair as the simulation source — no on-chain
    // auth is required for this view-only call, and we never submit the tx.
    const ephemeral = Keypair.random();
    const sourceAccount = new Account(ephemeral.publicKey(), '0');

    const tx = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: networkPassphrase(),
    })
      .addOperation(
        contract.call('is_subscribed', Address.fromString(scoutWallet).toScVal()),
      )
      .setTimeout(30)
      .build();

    const simResult = await server.simulateTransaction(tx);

    if (SorobanRpc.Api.isSimulationError(simResult)) {
      throw new PaymentError(
        `Contract simulation failed: ${simResult.error}`,
        'NETWORK_ERROR',
      );
    }

    const successSim = simResult as SorobanRpc.Api.SimulateTransactionSuccessResponse;
    const retval = successSim.result?.retval;
    if (!retval) {
      return { active: false, expiresAt: null };
    }

    const active = scValToNative(retval) as boolean;
    return { active, expiresAt: active ? '' : null };
  } catch (err) {
    if (err instanceof PaymentError) throw err;
    throw new PaymentError(
      `RPC call failed: ${(err as Error).message}`,
      'NETWORK_ERROR',
    );
  }
}

/**
 * Stub: submit a pay-to-contact micro-fee on Stellar.
 * Replace with real Soroban invocation when ready.
 */
export async function submitContactPayment(
  scoutWallet: string,
  playerId: string,
): Promise<ContactPaymentResult> {
  if (!scoutWallet || !playerId) {
    throw new PaymentError('Missing scoutWallet or playerId', 'INVALID_ACCOUNT');
  }
  // TODO: build and submit pay_to_contact Soroban transaction
  return {
    transactionId: `stub-txid-${Date.now()}`,
    status: 'submitted',
  };
}

// ─── Trial offer ──────────────────────────────────────────────────────────────

export interface TrialOfferResult {
  transactionId: string;
  playerId: string;
  detailsUri: string;
  playerTier: number;
}

/**
 * Invoke the contract's `log_trial_offer(scout, player_id, details_uri)` method.
 * Creates an immutable on-chain record of the offer; the contract promotes the
 * player's tier and returns the updated value.
 *
 * Flow mirrors cancelSubscriptionOnChain():
 *   getAccount → build tx → simulateTransaction → assembleTransaction
 *   → sign → sendTransaction → poll getTransaction until final status.
 *
 * On success returns the confirmed transaction hash and the player's
 * updated tier as reported by the contract's return value.
 */
export async function logTrialOffer(
  scoutWallet: string,
  playerId: string,
  detailsUri: string,
): Promise<TrialOfferResult> {
  if (!scoutWallet || !playerId || !detailsUri) {
    throw new PaymentError('Missing scoutWallet, playerId, or detailsUri', 'INVALID_ACCOUNT');
  }

  const { getPlatformKeypair } = await import('../utils/signer');
  const keypair = getPlatformKeypair();

  let account;
  try {
    account = await server.getAccount(keypair.publicKey());
  } catch (err) {
    throw new PaymentError(`RPC call failed: ${(err as Error).message}`, 'NETWORK_ERROR');
  }

  const contract = new Contract(config.contractId);

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: networkPassphrase(),
  })
    .addOperation(
      contract.call(
        'log_trial_offer',
        Address.fromString(scoutWallet).toScVal(),
        nativeToScVal(playerId, { type: 'string' }),
        nativeToScVal(detailsUri, { type: 'string' }),
      ),
    )
    .setTimeout(30)
    .build();

  let simResult;
  try {
    simResult = await server.simulateTransaction(tx);
  } catch (err) {
    throw new PaymentError(`Simulation request failed: ${(err as Error).message}`, 'NETWORK_ERROR');
  }

  if (SorobanRpc.Api.isSimulationError(simResult)) {
    throw new PaymentError(`Simulation failed: ${simResult.error}`, 'NETWORK_ERROR');
  }

  const preparedTx = SorobanRpc.assembleTransaction(tx, simResult).build();
  preparedTx.sign(keypair);

  let sendResult;
  try {
    sendResult = await server.sendTransaction(preparedTx);
  } catch (err) {
    throw new PaymentError(`Submit request failed: ${(err as Error).message}`, 'NETWORK_ERROR');
  }
  if (sendResult.status === 'ERROR') {
    throw new PaymentError(`Submit failed: ${sendResult.errorResult}`, 'NETWORK_ERROR');
  }

  const hash = sendResult.hash;

  let getResult;
  try {
    getResult = await server.getTransaction(hash);
    while (getResult.status === SorobanRpc.Api.GetTransactionStatus.NOT_FOUND) {
      await new Promise((r) => setTimeout(r, 1000));
      getResult = await server.getTransaction(hash);
    }
  } catch (err) {
    throw new PaymentError(`RPC call failed: ${(err as Error).message}`, 'NETWORK_ERROR');
  }

  if (getResult.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
    throw new PaymentError('log_trial_offer transaction failed on-chain', 'NETWORK_ERROR');
  }

  const success = getResult as SorobanRpc.Api.GetSuccessfulTransactionResponse;
  const playerTier = success.returnValue
    ? (scValToNative(success.returnValue) as number)
    : 3;

  return {
    transactionId: hash,
    playerId,
    detailsUri,
    playerTier,
  };
}

// ─── Milestone query ──────────────────────────────────────────────────────────

export interface OnChainMilestone {
  milestoneId: string;
  playerId: string;
  milestoneType: string;
  evidenceUri: string;
  approved: boolean;
  approvedBy: string | null;
  ledger: number | null;
}

export interface FeeWithdrawalResult {
  transactionId: string;
  recipient: string;
  amount: string; // u128 as string to avoid precision loss
  token: string;
}

export type FeeWithdrawalErrorCode =
  | 'NO_FEES'
  | 'INVALID_RECIPIENT'
  | 'NETWORK_ERROR'
  | 'CONTRACT_PAUSED';

/** Non-retryable codes — the caller should not retry without corrective action. */
const NON_RETRYABLE_CODES: ReadonlySet<FeeWithdrawalErrorCode> = new Set([
  'NO_FEES',
  'INVALID_RECIPIENT',
  'CONTRACT_PAUSED',
]);

export class FeeWithdrawalError extends Error {
  /** Whether the operation may succeed if retried (e.g. transient network blip). */
  public readonly retryable: boolean;

  constructor(
    message: string,
    public readonly code: FeeWithdrawalErrorCode,
  ) {
    super(message);
    this.name = 'FeeWithdrawalError';
    this.retryable = !NON_RETRYABLE_CODES.has(code);
  }
}

/**
 * Stub: invoke the contract's `withdraw_fees(recipient: Address) -> u128` method.
 * Returns the withdrawn amount and transaction metadata.
 * Throws FeeWithdrawalError with code 'NO_FEES' when balance is zero.
 */
export async function withdrawFees(recipient: string): Promise<FeeWithdrawalResult> {
  if (!recipient) {
    throw new FeeWithdrawalError('Missing recipient', 'INVALID_RECIPIENT');
  }
  // TODO: build and submit withdraw_fees Soroban transaction
  // Example (pseudocode):
  //   const tx = await buildInvokeContractTx('withdraw_fees', [Address.fromString(recipient)]);
  //   const result = await server.sendTransaction(tx);
  //   const amount = parseU128FromXdr(result.returnValue);
  //   if (amount === 0n) throw new FeeWithdrawalError('No fees available', 'NO_FEES');
  //   return { transactionId: result.hash, recipient, amount: amount.toString(), token: 'XLM' };
  throw new FeeWithdrawalError('No fees available to withdraw', 'NO_FEES');
}

export type SubscriptionTier = 'basic' | 'premium';

export interface SubscriptionResult {
  transactionId: string;
  tier: SubscriptionTier;
  expiresAt: number; // Unix timestamp
  status: 'active';
}

/** Matches Soroban contract error #7 (InsufficientFee) in a simulation/result error string. */
function isInsufficientFeeError(message: string): boolean {
  return /#7\b/.test(message) || /insufficient.?fee/i.test(message);
}

/**
 * Invoke `subscribe(scout, tier, duration)` on the Soroban contract.
 *
 * Flow mirrors cancelSubscriptionOnChain() / logTrialOffer():
 *   getAccount → build tx → simulateTransaction → assembleTransaction
 *   → sign → sendTransaction → poll getTransaction until final status.
 *
 * On success returns the confirmed transaction hash and the on-chain expiry
 * timestamp decoded from the contract's return value.
 * Throws PaymentError with code 'INSUFFICIENT_FUNDS' for contract error #7
 * (InsufficientFee).
 */
export async function purchaseSubscription(
  scoutWallet: string,
  tier: SubscriptionTier,
  duration: number,
): Promise<SubscriptionResult> {
  if (!scoutWallet) {
    throw new PaymentError('Missing scoutWallet', 'INVALID_ACCOUNT');
  }

  const { getPlatformKeypair } = await import('../utils/signer');
  const keypair = getPlatformKeypair();

  let account;
  try {
    account = await server.getAccount(keypair.publicKey());
  } catch (err) {
    throw new PaymentError(`RPC call failed: ${(err as Error).message}`, 'NETWORK_ERROR');
  }

  const contract = new Contract(config.contractId);

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: networkPassphrase(),
  })
    .addOperation(
      contract.call(
        'subscribe',
        Address.fromString(scoutWallet).toScVal(),
        nativeToScVal(tier, { type: 'string' }),
        nativeToScVal(duration, { type: 'u32' }),
      ),
    )
    .setTimeout(30)
    .build();

  let simResult;
  try {
    simResult = await server.simulateTransaction(tx);
  } catch (err) {
    throw new PaymentError(`Simulation request failed: ${(err as Error).message}`, 'NETWORK_ERROR');
  }

  if (SorobanRpc.Api.isSimulationError(simResult)) {
    const errMsg = simResult.error ?? '';
    if (isInsufficientFeeError(errMsg)) {
      throw new PaymentError('Insufficient funds for subscription', 'INSUFFICIENT_FUNDS');
    }
    throw new PaymentError(`Simulation failed: ${errMsg}`, 'NETWORK_ERROR');
  }

  const preparedTx = SorobanRpc.assembleTransaction(tx, simResult).build();
  preparedTx.sign(keypair);

  let sendResult;
  try {
    sendResult = await server.sendTransaction(preparedTx);
  } catch (err) {
    throw new PaymentError(`Submit request failed: ${(err as Error).message}`, 'NETWORK_ERROR');
  }
  if (sendResult.status === 'ERROR') {
    const errMsg = String(sendResult.errorResult ?? '');
    if (isInsufficientFeeError(errMsg)) {
      throw new PaymentError('Insufficient funds for subscription', 'INSUFFICIENT_FUNDS');
    }
    throw new PaymentError(`Submit failed: ${sendResult.errorResult}`, 'NETWORK_ERROR');
  }

  const hash = sendResult.hash;

  let getResult;
  try {
    getResult = await server.getTransaction(hash);
    while (getResult.status === SorobanRpc.Api.GetTransactionStatus.NOT_FOUND) {
      await new Promise((r) => setTimeout(r, 1000));
      getResult = await server.getTransaction(hash);
    }
  } catch (err) {
    throw new PaymentError(`RPC call failed: ${(err as Error).message}`, 'NETWORK_ERROR');
  }

  if (getResult.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
    const resultMeta = ((getResult as unknown) as { resultMetaXdr?: string }).resultMetaXdr ?? '';
    if (isInsufficientFeeError(resultMeta)) {
      throw new PaymentError('Insufficient funds for subscription', 'INSUFFICIENT_FUNDS');
    }
    throw new PaymentError('subscribe transaction failed on-chain', 'NETWORK_ERROR');
  }

  const success = getResult as SorobanRpc.Api.GetSuccessfulTransactionResponse;
  if (!success.returnValue) {
    throw new PaymentError('subscribe transaction returned no expiry value', 'NETWORK_ERROR');
  }
  const expiresAt = scValToNative(success.returnValue) as number;

  return {
    transactionId: hash,
    tier,
    expiresAt,
    status: 'active',
  };
}

/**
 * Stub: invoke renew_subscription(scout, tier, duration) on the Soroban contract.
 * Extends the existing expiry by `duration` days.
 */
export async function renewSubscription(
  scoutWallet: string,
  tier: SubscriptionTier,
  duration: number,
  currentExpiresAt: number,
): Promise<SubscriptionResult> {
  if (!scoutWallet) {
    throw new PaymentError('Missing scoutWallet', 'INVALID_ACCOUNT');
  }
  // Renewal extends from the current expiry (or now, if already expired)
  const now = Math.floor(Date.now() / 1000);
  const base = currentExpiresAt > now ? currentExpiresAt : now;
  const expiresAt = base + duration * 86400;
  // TODO: build and submit renew_subscription (or re-call subscribe) Soroban transaction
  return {
    transactionId: `stub-renew-txid-${Date.now()}`,
    tier,
    expiresAt,
    status: 'active',
  };
}

export type SubscriptionErrorCode =
  | 'NOT_SUBSCRIBED'
  | 'ALREADY_CANCELLED'
  | 'UNAUTHORIZED'
  | 'NETWORK_ERROR';

/**
 * Thrown when a cancel_subscription contract call cannot proceed due to a
 * known on-chain state — e.g. the scout was never subscribed or the
 * subscription was already cancelled.  These map to 4xx HTTP responses, not
 * 5xx, so we keep them separate from PaymentError.
 */
export class SubscriptionError extends Error {
  constructor(
    message: string,
    public readonly code: SubscriptionErrorCode,
  ) {
    super(message);
    this.name = 'SubscriptionError';
  }
}

/**
 * Invoke `cancel_subscription(scout)` on the Soroban contract.
 *
 * Flow mirrors unpauseContractOnChain():
 *   getAccount → build tx → simulateTransaction → assembleTransaction
 *   → sign → sendTransaction → poll getTransaction until final status.
 *
 * On success returns the confirmed transaction hash.
 * Maps Soroban contract error codes to SubscriptionError:
 *   #8 NotSubscribed  → code: 'NOT_SUBSCRIBED'
 *   #9 Unauthorized   → code: 'UNAUTHORIZED'
 */
export async function cancelSubscriptionOnChain(
  scoutWallet: string,
): Promise<{ transactionId: string }> {
  if (!scoutWallet) {
    throw new PaymentError('Missing scoutWallet', 'INVALID_ACCOUNT');
  }

  const { getPlatformKeypair } = await import('../utils/signer');
  const keypair = getPlatformKeypair();

  const account = await server.getAccount(keypair.publicKey());
  const contract = new Contract(config.contractId);

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: networkPassphrase(),
  })
    .addOperation(
      contract.call('cancel_subscription', Address.fromString(scoutWallet).toScVal()),
    )
    .setTimeout(30)
    .build();

  const simResult = await server.simulateTransaction(tx);

  if (SorobanRpc.Api.isSimulationError(simResult)) {
    const errMsg = simResult.error ?? '';
    // Contract error #8 = NotSubscribed
    if (errMsg.includes('#8') || /not.?subscribed/i.test(errMsg)) {
      throw new SubscriptionError('Scout has no active on-chain subscription', 'NOT_SUBSCRIBED');
    }
    // Contract error #9 = Unauthorized
    if (errMsg.includes('#9') || /unauthorized/i.test(errMsg)) {
      throw new SubscriptionError('Unauthorized: wallet is not allowed to cancel this subscription', 'UNAUTHORIZED');
    }
    throw new PaymentError(`Simulation failed: ${errMsg}`, 'NETWORK_ERROR');
  }

  const preparedTx = SorobanRpc.assembleTransaction(tx, simResult).build();
  preparedTx.sign(keypair);

  const sendResult = await server.sendTransaction(preparedTx);
  if (sendResult.status === 'ERROR') {
    throw new PaymentError(`Submit failed: ${sendResult.errorResult}`, 'NETWORK_ERROR');
  }

  const hash = sendResult.hash;

  let getResult = await server.getTransaction(hash);
  while (getResult.status === SorobanRpc.Api.GetTransactionStatus.NOT_FOUND) {
    await new Promise((r) => setTimeout(r, 1000));
    getResult = await server.getTransaction(hash);
  }

  if (getResult.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
    // Inspect the result XDR for contract-level error codes.
    // Cast through unknown because GetFailedTransactionResponse and
    // GetSuccessfulTransactionResponse share no overlapping status type.
    const resultMeta = ((getResult as unknown) as { resultMetaXdr?: string }).resultMetaXdr ?? '';
    if (resultMeta.includes('#8') || /not.?subscribed/i.test(resultMeta)) {
      throw new SubscriptionError('Scout has no active on-chain subscription', 'NOT_SUBSCRIBED');
    }
    if (resultMeta.includes('#9') || /unauthorized/i.test(resultMeta)) {
      throw new SubscriptionError('Unauthorized: wallet is not allowed to cancel this subscription', 'UNAUTHORIZED');
    }
    throw new PaymentError('cancel_subscription transaction failed on-chain', 'NETWORK_ERROR');
  }

  return { transactionId: hash };
}

export interface ContractActionResult {
  transactionId: string;
}

export class ContractActionError extends Error {
  constructor(
    message: string,
    public readonly code: 'CONTRACT_NOT_PAUSED' | 'CONTRACT_ALREADY_PAUSED' | 'NETWORK_ERROR' | 'UNAUTHORIZED',
  ) {
    super(message);
    this.name = 'ContractActionError';
  }
}

/**
 * Invoke the contract's `unpause()` function via the platform keypair.
 * Returns the transaction hash on success.
 * Throws ContractActionError with code 'CONTRACT_NOT_PAUSED' if the simulation
 * indicates the contract is not currently paused (Soroban error code 10).
 */
export async function unpauseContractOnChain(): Promise<ContractActionResult> {
  const { getPlatformKeypair } = await import('../utils/signer');
  const keypair = getPlatformKeypair();

  const account = await server.getAccount(keypair.publicKey());
  const contract = new Contract(config.contractId);

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: networkPassphrase(),
  })
    .addOperation(contract.call('unpause'))
    .setTimeout(30)
    .build();

  const simResult = await server.simulateTransaction(tx);
  if (SorobanRpc.Api.isSimulationError(simResult)) {
    const errMsg = simResult.error ?? '';
    if (errMsg.includes('ContractPaused') || errMsg.includes('contract_paused') || errMsg.includes('#10')) {
      throw new ContractActionError('Contract is not currently paused', 'CONTRACT_NOT_PAUSED');
    }
    throw new ContractActionError(`Simulation failed: ${errMsg}`, 'NETWORK_ERROR');
  }

  const preparedTx = SorobanRpc.assembleTransaction(tx, simResult).build();
  preparedTx.sign(keypair);

  const sendResult = await server.sendTransaction(preparedTx);
  if (sendResult.status === 'ERROR') {
    throw new ContractActionError(`Submit failed: ${sendResult.errorResult}`, 'NETWORK_ERROR');
  }

  const hash = sendResult.hash;

  let getResult = await server.getTransaction(hash);
  while (getResult.status === SorobanRpc.Api.GetTransactionStatus.NOT_FOUND) {
    await new Promise((r) => setTimeout(r, 1000));
    getResult = await server.getTransaction(hash);
  }

  if (getResult.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
    throw new ContractActionError('Transaction failed on-chain', 'NETWORK_ERROR');
  }

  return { transactionId: hash };
}

export interface UpdateProfileResult {
  transactionId: string;
  metadataUri: string;
}

/**
 * Stub: invoke the contract's `update_profile(player_id, metadata_uri)` method.
 * Replace with a real Soroban invocation via invokeContract() when the RPC integration is ready.
 */
export async function updateProfile(
  playerId: string,
  metadataUri: string,
): Promise<UpdateProfileResult> {
  if (!playerId || !metadataUri) {
    throw new Error('playerId and metadataUri are required');
  }
  // TODO: Build and submit update_profile(player_id, metadata_uri) Soroban transaction
  // Example: await invokeContract(platformKeypair, 'update_profile', [strVal(playerId), strVal(metadataUri)]);
  return { transactionId: `stub-update-txid-${playerId.slice(0, 8)}`, metadataUri };
}

/**
 * Stub: query verified milestones for a player from the Soroban contract.
 *
 * Expected contract call: `get_milestones(player_id: String) -> Vec<Milestone>`
 * The contract returns a tamper-proof list of all milestones (pending and
 * approved) associated with the given player. Each entry includes the
 * milestone type, evidence CID, and the validator that approved it.
 *
 * Replace the stub body with a real Soroban `simulateTransaction` /
 * `invokeContractFunction` call when the RPC integration is ready.
 *
 * @param playerId - The on-chain player identifier (Stellar account or UUID).
 * @returns Array of on-chain milestones. Returns an empty array until wired.
 */
export async function queryMilestones(playerId: string): Promise<OnChainMilestone[]> {
  if (!playerId) {
    throw new PaymentError('Missing playerId', 'INVALID_ACCOUNT');
  }
  // TODO: invoke get_milestones on the Soroban contract via SorobanRpc.Server
  // Example (pseudocode):
  //   const result = await server.simulateTransaction(
  //     buildInvokeContractTx('get_milestones', [playerId])
  //   );
  //   return parseMilestonesFromXdr(result);
  return [];
}
