import {
  ArkAddress,
  ArkTransaction,
  ExtendedCoin,
  ExtendedVirtualCoin,
  Ramps,
  SingleKey,
  TxType,
  Wallet,
  assertPageRequest,
  contractHandlers,
  pageResult,
  type Contract,
  type ContractFilter,
  type ContractRepository,
  type ContractScope,
  type Outpoint,
  type PageRequest,
  type PageResult,
  type TransactionHistoryPageCursor,
  type TransactionHistoryPageFilter,
  type WalletBalance,
  type WalletRepository,
} from '@arkade-os/sdk';
import { ExpoIndexerProvider, ExpoOperatorProvider } from '@arkade-os/sdk/adapters/expo';
import ecc from '@bitcoinerlab/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { parseStoredTransactionList, parseStoredUtxoList, parseStoredVtxoList, stringifyTransactionList, stringifyUtxoList, stringifyVtxoList } from './ark-wallet-storage';
import assert from 'assert';
import BIP32Factory from 'bip32';
import * as bip39 from 'bip39';

import { IStorage } from '@shared/types/IStorage';
import { CommonSwap } from '@shared/types/common-swap';
import * as BlueElectrum from '../../blue_modules/BlueElectrum';
import { sleep } from '../../modules/sleep';
import { CommonTokenTransfer, CommonTransaction } from '../../types/common-transaction';
import { NETWORK_ARK, NETWORK_ARK_MUTINYNET } from '../../types/networks';
import { CachedTokenInfo } from '../../types/token-info';
import { AbstractHDElectrumWallet } from './abstract-hd-electrum-wallet';
import { createLightningInvoiceResponse, InterfaceLightningWallet, LightningPaymentLimitsResponse } from './interface-lightning-wallet';
import { InterfaceAccountBasedWallet } from './interface-account-based-wallet';
import { InterfaceCanHaveTokens } from './interface-can-have-tokens';

const bip32 = BIP32Factory(ecc);

const ARK_STORAGE_PREFIX = 'ark-sdk-v2';

/**
 * Boltz shut down, so Ark Lightning is unavailable until the Arkade 0.5 migration
 * brings it back (receive via LNURL, send via Arkade swaps).
 */
const LIGHTNING_UNAVAILABLE_MESSAGE = 'Lightning on Arkade is temporarily unavailable while the wallet migrates to the new Arkade Lightning backend';

type ArkadeNetwork = typeof NETWORK_ARK | typeof NETWORK_ARK_MUTINYNET;

/** serverUrl keys the storage namespace (sha256) — changing it orphans persisted state. */
const ARKADE_NETWORK_CONFIG: Record<ArkadeNetwork, { serverUrl: string }> = {
  [NETWORK_ARK]: { serverUrl: 'https://arkade.computer' },
  [NETWORK_ARK_MUTINYNET]: { serverUrl: 'https://mutinynet.arkade.sh' },
};

/** Set once restore() has succeeded in this namespace; gates the boot-time full restore. */
const BOOTSTRAP_FLAG = 'bootstrap:restoredV1';

/**
 * 0.4 caches carry `virtualStatus` rows that read back as "not swept" under 0.5. Wipe the
 * VTXO cache once and clear the sync cursor so the SDK re-fetches canonical facts. The legacy
 * UTXO rows are deliberately kept: `migrateLegacyUtxos` copies them into VTXO rows on boot.
 */
const SDK05_UPGRADE_FLAG = 'upgrade:sdk05V1';

/** `WalletState` and `ContractWatchState` are internal to the SDK, so we mirror them here. */
type WalletState = {
  settings?: Record<string, any>;
  lastSyncTime?: number;
};

type ContractWatchState = 'watched' | 'awaiting-funds' | 'retained';

// The SDK does not export its own `watchStateOf` / `scopeOf`, but it does export the
// `contractHandlers` registry they read. Deriving the defaults from that registry (instead of
// mirroring its contents here) keeps our filters in lockstep with the SDK across version bumps:
// a handler that gains a `defaultScope` is picked up without a code change on our side.
const watchStateOf = (contract: Pick<Contract, 'watch'>): ContractWatchState => contract.watch ?? 'watched';
const scopeOf = (contract: Pick<Contract, 'type' | 'scope'>): ContractScope => contract.scope ?? contractHandlers.get(contract.type)?.defaultScope ?? 'offchain';

const contractFilterMatchesNothing = (filter?: ContractFilter): boolean =>
  [filter?.script, filter?.state, filter?.type, filter?.watch, filter?.scope].some((value) => Array.isArray(value) && value.length === 0);

const matches = <T>(value: T, criterion?: T | T[]): boolean => {
  if (criterion === undefined) return true;
  return Array.isArray(criterion) ? criterion.includes(value) : value === criterion;
};

const compareOutpoints = (a: Outpoint, b: Outpoint): number => (a.txid < b.txid ? -1 : a.txid > b.txid ? 1 : a.vout - b.vout);

const compareTxKeys = (a: TransactionHistoryPageCursor['key'], b: TransactionHistoryPageCursor['key']): number => {
  for (const field of ['boardingTxid', 'commitmentTxid', 'arkTxid'] as const) {
    if (a[field] < b[field]) return -1;
    if (a[field] > b[field]) return 1;
  }
  return 0;
};

const compareHistoryCursors = (a: TransactionHistoryPageCursor, b: TransactionHistoryPageCursor): number => a.createdAt - b.createdAt || compareTxKeys(a.key, b.key);

const assertHistoryPageFilter = (filter: TransactionHistoryPageFilter): void => {
  if (filter.since !== undefined && (!Number.isSafeInteger(filter.since) || filter.since < 0)) {
    throw new RangeError('history since must be non-negative Unix milliseconds');
  }
};

/** Copied from the SDK's in-memory repository: sort by outpoint, `after` exclusive, bounded result. */
const pageOutpoints = <Item extends Outpoint>(rows: Item[], page: PageRequest<Outpoint>): PageResult<Item, Outpoint> => {
  assertPageRequest(page);
  const selected = rows
    .filter((row) => page.after === undefined || compareOutpoints(row, page.after) > 0)
    .sort(compareOutpoints)
    .slice(0, page.limit + 1);
  return pageResult(selected, page.limit, ({ txid, vout }) => ({ txid, vout }));
};

/** Both saveUtxos call shapes, as `[address, utxos]` entries. */
const utxoEntries = (addressOrBatch: string | ReadonlyMap<string, ExtendedCoin[]>, utxos: ExtendedCoin[] = []): [string, ExtendedCoin[]][] =>
  typeof addressOrBatch === 'string' ? [[addressOrBatch, utxos]] : [...addressOrBatch];

/**
 * Merge persisted and freshly fetched SDK records without creating duplicates.
 *
 * the SDK writes data over time as wallet state changes. We need one place that
 * says "keep the latest value for each logical record" so our simple storage
 * does not accumulate duplicate VTXOs, UTXOs or transactions forever.
 */
const mergeByKey = <T>(existing: T[], incoming: T[], toKey: (value: T) => string): T[] => {
  const next = new Map<string, T>();

  existing.forEach((value) => next.set(toKey(value), value));
  incoming.forEach((value) => next.set(toKey(value), value));

  return [...next.values()];
};

/**
 * Small helper that scopes app storage to one Ark wallet instance.
 *
 * the same app can hold multiple Ark accounts and even different Ark servers.
 * This wrapper prevents their persisted SDK state from overwriting each other.
 */
class NamespacedStorage {
  private readonly namespace: string;

  constructor(
    private readonly storage: IStorage,
    serverUrl: string,
    accountNumber: number
  ) {
    const networkId = bytesToHex(sha256(serverUrl)).slice(0, 16);
    this.namespace = `${ARK_STORAGE_PREFIX}:${networkId}:account_${accountNumber}`;
  }

  private key(suffix: string) {
    return `${this.namespace}:${suffix}`;
  }

  async readJson<T>(suffix: string, fallback: T): Promise<T> {
    const raw = await this.storage.getItem(this.key(suffix));
    if (!raw) return fallback;

    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed === null) return fallback;
      return parsed as T;
    } catch (error) {
      console.error('ARK storage: failed to read', this.key(suffix), error);
      return fallback;
    }
  }

  async writeJson(suffix: string, value: unknown): Promise<void> {
    await this.storage.setItem(this.key(suffix), JSON.stringify(value));
  }

  async readTrackedAddresses(): Promise<string[]> {
    return this.readJson<string[]>('wallet:addresses', []);
  }

  /**
   * Wipe only the VTXO buckets. The legacy UTXO rows must survive until the SDK's
   * `migrateLegacyUtxos` has copied them into VTXO rows (0.5 stores boarding coins there).
   */
  async clearVtxoCacheForAddresses(addresses: string[]): Promise<void> {
    await Promise.all(addresses.map((address) => this.storage.setItem(this.key(`wallet:vtxos:${address}`), '[]')));
  }

  async readVtxos(address: string): Promise<ExtendedVirtualCoin[]> {
    const raw = await this.storage.getItem(this.key(`wallet:vtxos:${address}`));
    if (!raw) return [];
    try {
      return parseStoredVtxoList(raw);
    } catch (error) {
      console.error('ARK storage: failed to parse vtxos for', address, error);
      return [];
    }
  }

  async writeVtxos(address: string, vtxos: ExtendedVirtualCoin[]): Promise<void> {
    await this.storage.setItem(this.key(`wallet:vtxos:${address}`), stringifyVtxoList(vtxos));
  }

  async readUtxos(address: string): Promise<ExtendedCoin[]> {
    const raw = await this.storage.getItem(this.key(`wallet:utxos:${address}`));
    if (!raw) return [];
    try {
      return parseStoredUtxoList(raw);
    } catch (error) {
      console.error('ARK storage: failed to parse utxos for', address, error);
      return [];
    }
  }

  async writeUtxos(address: string, utxos: ExtendedCoin[]): Promise<void> {
    await this.storage.setItem(this.key(`wallet:utxos:${address}`), stringifyUtxoList(utxos));
  }

  async readTransactions(address: string): Promise<ArkTransaction[]> {
    const raw = await this.storage.getItem(this.key(`wallet:txs:${address}`));
    if (!raw) return [];
    try {
      return parseStoredTransactionList(raw);
    } catch (error) {
      console.error('ARK storage: failed to parse transactions for', address, error);
      return [];
    }
  }

  async writeTransactions(address: string, txs: ArkTransaction[]): Promise<void> {
    await this.storage.setItem(this.key(`wallet:txs:${address}`), stringifyTransactionList(txs));
  }
}

/**
 * WalletRepository v2 over Layerz's IStorage. Mirrors the SDK's InMemoryWalletRepository,
 * with paged reads, the `saveUtxos(Map)` overload and the same namespace/keys as 0.4.
 * The optional script-based VTXO methods are omitted: the SDK falls back to address buckets.
 */
class LayerzWalletRepository implements WalletRepository {
  readonly version = 2 as const;

  /**
   * The tracked-address list is a read-modify-write over one JSON blob; serialize its writes so
   * concurrent saves (SDK syncs vtxos, utxos and txs at once) cannot drop each other's address,
   * which would leave a bucket that `clear()` and the 0.5 upgrade wipe then miss.
   */
  private addressListQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly storage: NamespacedStorage) {}

  /** Clear all cached SDK wallet state for this Ark wallet only. */
  async clear(): Promise<void> {
    const addresses = await this.storage.readTrackedAddresses();
    await Promise.all(addresses.flatMap((address) => [this.storage.writeVtxos(address, []), this.storage.writeUtxos(address, []), this.storage.writeTransactions(address, [])]));
    await this.storage.writeJson('wallet:state', null);
    // Routed through the queue so a save that started concurrently cannot re-track an address
    // into a wallet whose buckets clear() has already emptied.
    await this.mutate(async () => this.storage.writeJson('wallet:addresses', []));
  }

  async getVtxosPage(address: string, page: PageRequest<Outpoint>): Promise<PageResult<ExtendedVirtualCoin, Outpoint>> {
    return pageOutpoints(await this.storage.readVtxos(address), page);
  }

  async saveVtxos(address: string, vtxos: ExtendedVirtualCoin[]): Promise<void> {
    const existing = await this.storage.readVtxos(address);
    await this.trackAddress(address);
    await this.storage.writeVtxos(
      address,
      mergeByKey(existing, vtxos, (item) => `${item.txid}:${item.vout}`)
    );
  }

  async deleteVtxos(address: string): Promise<void> {
    await this.storage.writeVtxos(address, []);
  }

  async getUtxosPage(address: string, page: PageRequest<Outpoint>): Promise<PageResult<ExtendedCoin, Outpoint>> {
    return pageOutpoints(await this.storage.readUtxos(address), page);
  }

  async saveUtxos(address: string, utxos: ExtendedCoin[]): Promise<void>;
  async saveUtxos(utxosByAddress: ReadonlyMap<string, ExtendedCoin[]>): Promise<void>;
  async saveUtxos(addressOrBatch: string | ReadonlyMap<string, ExtendedCoin[]>, utxos: ExtendedCoin[] = []): Promise<void> {
    for (const [address, list] of utxoEntries(addressOrBatch, utxos)) {
      const existing = await this.storage.readUtxos(address);
      await this.trackAddress(address);
      await this.storage.writeUtxos(
        address,
        mergeByKey(existing, list, (item) => `${item.txid}:${item.vout}`)
      );
    }
  }

  async deleteUtxos(address: string): Promise<void> {
    await this.storage.writeUtxos(address, []);
  }

  async getTransactionHistoryPage(filter: TransactionHistoryPageFilter, page: PageRequest<TransactionHistoryPageCursor>): Promise<PageResult<ArkTransaction, TransactionHistoryPageCursor>> {
    assertPageRequest(page);
    assertHistoryPageFilter(filter);
    const rows = (await this.storage.readTransactions(filter.address))
      .filter((tx) => (filter.since === undefined || tx.createdAt >= filter.since) && (page.after === undefined || compareHistoryCursors({ createdAt: tx.createdAt, key: tx.key }, page.after) > 0))
      .sort((a, b) => compareHistoryCursors({ createdAt: a.createdAt, key: a.key }, { createdAt: b.createdAt, key: b.key }))
      .slice(0, page.limit + 1);
    return pageResult(rows, page.limit, (tx) => ({ createdAt: tx.createdAt, key: tx.key }));
  }

  /**
   * Merge new transaction snapshots into persisted history for one address.
   * The same Ark transaction may be seen many times as its status evolves.
   */
  async saveTransactions(address: string, txs: ArkTransaction[]): Promise<void> {
    const existing = await this.storage.readTransactions(address);
    await this.trackAddress(address);
    await this.storage.writeTransactions(
      address,
      mergeByKey(existing, txs, (tx) => `${tx.key.boardingTxid}:${tx.key.commitmentTxid}:${tx.key.arkTxid}`)
    );
  }

  async deleteTransactions(address: string): Promise<void> {
    await this.storage.writeTransactions(address, []);
  }

  async getWalletState(): Promise<WalletState | null> {
    return this.storage.readJson<WalletState | null>('wallet:state', null);
  }

  async saveWalletState(state: WalletState): Promise<void> {
    await this.storage.writeJson('wallet:state', state);
  }

  async [Symbol.asyncDispose](): Promise<void> {
    // no-op
  }

  private async trackAddress(address: string): Promise<void> {
    await this.mutate(async () => {
      const addresses = await this.storage.readTrackedAddresses();
      if (addresses.includes(address)) return;
      await this.storage.writeJson('wallet:addresses', [...addresses, address]);
    });
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.addressListQueue.then(operation);
    this.addressListQueue = run.catch(() => undefined);
    return run;
  }
}

type StoredContract = Contract & { expiresAt?: number };

/**
 * ContractRepository v4 over Layerz's IStorage. Mirrors the SDK's InMemoryContractRepository:
 * paged script-order reads, `watch`/`scope` filters (with their defaults), empty-array filters
 * matching nothing, and serialized read-modify-write mutations.
 */
class LayerzContractRepository implements ContractRepository {
  readonly version = 4 as const;

  /** Mutations are read-modify-write over one JSON blob; serialize them so a concurrent save cannot drop another's row. */
  private mutationQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly storage: NamespacedStorage) {}

  async clear(): Promise<void> {
    await this.mutate(async () => this.writeContracts([]));
  }

  async getContractsPage(filter: ContractFilter | undefined, page: PageRequest): Promise<PageResult<Contract>> {
    assertPageRequest(page);
    if (contractFilterMatchesNothing(filter)) return { items: [] };

    const contracts = await this.readContracts();
    const rows = contracts
      .filter((contract) => page.after === undefined || contract.script > page.after)
      .filter(
        (contract) =>
          !filter ||
          (matches(contract.script, filter.script) &&
            matches(contract.state, filter.state) &&
            matches(contract.type, filter.type) &&
            matches(watchStateOf(contract), filter.watch) &&
            matches(scopeOf(contract), filter.scope))
      )
      .sort((a, b) => (a.script < b.script ? -1 : a.script > b.script ? 1 : 0))
      .slice(0, page.limit + 1);
    return pageResult(rows, page.limit, (contract) => contract.script);
  }

  /** Upsert a contract using its script as the stable identifier. */
  async saveContract(contract: Contract): Promise<void> {
    await this.mutate(async () => {
      const contracts = await this.readContracts();
      const nextContracts = contracts.filter((existingContract) => existingContract.script !== contract.script);
      nextContracts.push(contract as StoredContract);
      await this.writeContracts(nextContracts);
    });
  }

  async deleteContract(script: string): Promise<void> {
    await this.mutate(async () => {
      const contracts = await this.readContracts();
      await this.writeContracts(contracts.filter((contract) => contract.script !== script));
    });
  }

  async [Symbol.asyncDispose](): Promise<void> {
    // no-op
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutationQueue.then(operation);
    this.mutationQueue = run.catch(() => undefined);
    return run;
  }

  /** Read all persisted contracts and keep only structurally valid entries. */
  private async readContracts(): Promise<StoredContract[]> {
    const parsed = await this.storage.readJson<StoredContract[]>('contracts', []);
    return parsed.filter(
      (contract): contract is StoredContract =>
        !!contract &&
        typeof contract === 'object' &&
        typeof contract.script === 'string' &&
        typeof contract.address === 'string' &&
        typeof contract.type === 'string' &&
        typeof contract.createdAt === 'number'
    );
  }

  private async writeContracts(contracts: StoredContract[]): Promise<void> {
    await this.storage.writeJson('contracts', contracts);
  }
}

export class ArkWallet extends AbstractHDElectrumWallet implements InterfaceLightningWallet, InterfaceAccountBasedWallet, InterfaceCanHaveTokens {
  private _wallet: Wallet | undefined = undefined;
  private _arkadeNetwork: ArkadeNetwork = NETWORK_ARK_MUTINYNET;
  protected _accountNumber: number = 0;
  private _arkTokenBalances: CachedTokenInfo[] = [];
  _lastTokensFetch: number = 0;

  private get _arkServerUrl(): string {
    return ARKADE_NETWORK_CONFIG[this._arkadeNetwork].serverUrl;
  }

  setAccountNumber(value: number) {
    this._accountNumber = value;
  }

  /** Server endpoints derive from ARKADE_NETWORK_CONFIG; no URL sniffing anywhere else. */
  setArkadeNetwork(network: ArkadeNetwork) {
    assert(!this._wallet, 'Wallet already initialized');
    this._arkadeNetwork = network;
  }

  _getIdentity() {
    assert(this.secret, 'No secret provided');
    const mnemonic = this.secret;
    const passphrase = this.passphrase;
    const seed = bip39.mnemonicToSeedSync(mnemonic, passphrase);

    const index = 0;
    const internal = 0;
    const accountNumber = this._accountNumber;
    const root = bip32.fromSeed(seed);
    const path = `m/86'/0'/${accountNumber}'/${internal}/${index}`;
    const child = root.derivePath(path);
    assert(child.privateKey, 'Internal error: no private key for child');

    return SingleKey.fromPrivateKey(child.privateKey);
  }

  async init(layerzStorage: IStorage) {
    // A re-init (account switch) must stop the previous SDK instance's settle poll and watchers.
    await this.dispose();

    const identity = this._getIdentity();
    const storage = new NamespacedStorage(layerzStorage, this._arkServerUrl, this._accountNumber);
    const walletRepository = new LayerzWalletRepository(storage);
    const contractRepository = new LayerzContractRepository(storage);

    // Wipe the legacy VTXO cache BEFORE the SDK boots: migrateLegacyUtxos needs the old
    // UTXO rows, and copies them into VTXO rows during Wallet.create.
    const needsUpgrade = await this._prepareSdk05Upgrade(storage);

    const wallet = await Wallet.create({
      identity,
      storage: {
        walletRepository,
        contractRepository,
      },
      operatorProvider: new ExpoOperatorProvider(this._arkServerUrl),
      indexerProvider: new ExpoIndexerProvider(this._arkServerUrl),
    });
    this._wallet = wallet;

    if (needsUpgrade) {
      try {
        // Force a full re-bootstrap now that the 0.4 coin cache is gone; the flag is only
        // written after the cursor has actually been cleared.
        await wallet.clearSyncCursor();
        await storage.writeJson(SDK05_UPGRADE_FLAG, true);
      } catch (error) {
        globalThis.handleError?.(error, 'ark-wallet.ts');
        console.log('ARK 0.5 upgrade error:', error);
      }
    }

    await this._bootstrapWalletState(storage);
  }

  /**
   * One-time 0.4 → 0.5 coin-cache upgrade. Legacy `virtualStatus` rows read back as
   * "not swept", so drop them and let the SDK re-fetch canonical facts from the indexer.
   * Only VTXO buckets are cleared; the UTXO rows are left for `migrateLegacyUtxos`.
   */
  private async _prepareSdk05Upgrade(storage: NamespacedStorage): Promise<boolean> {
    try {
      if (await storage.readJson<boolean>(SDK05_UPGRADE_FLAG, false)) return false;
      const addresses = await storage.readTrackedAddresses();
      if (addresses.length > 0) await storage.clearVtxoCacheForAddresses(addresses);
      return true;
    } catch (error) {
      globalThis.handleError?.(error, 'ark-wallet.ts');
      console.log('ARK 0.5 cache wipe error:', error);
      return false;
    }
  }

  /**
   * restore() is a full indexer re-bootstrap, so it runs once per namespace: BOOTSTRAP_FLAG
   * is written only after it succeeds, and a failed restore is retried on the next boot.
   */
  private async _bootstrapWalletState(storage: NamespacedStorage): Promise<void> {
    try {
      if (!(await storage.readJson<boolean>(BOOTSTRAP_FLAG, false)) && (await this._restoreWallet())) {
        await storage.writeJson(BOOTSTRAP_FLAG, true);
      }
    } catch (error) {
      globalThis.handleError?.(error, 'ark-wallet.ts');
      console.log('ARK bootstrap error:', error);
    }
  }

  private async _restoreWallet(): Promise<boolean> {
    assert(this._wallet, 'Ark wallet not initialized');
    try {
      await this._wallet.restore();
      return true;
    } catch (error) {
      globalThis.handleError?.(error, 'ark-wallet.ts');
      console.log('ARK restore error:', error);
      return false;
    }
  }

  /**
   * Stop the SDK's background settle poll and watchers; safe to call before init() or
   * repeatedly. SparkWallet/StacksWallet inherit this but never set `_wallet`, so it is a
   * no-op for them (they override init()).
   */
  async dispose() {
    const wallet = this._wallet;
    this._wallet = undefined;
    if (!wallet) return;
    try {
      await wallet.dispose();
    } catch (error) {
      globalThis.handleError?.(error, 'ark-wallet.ts');
      console.log('ARK dispose error:', error);
    }
  }

  async getOffchainBalance() {
    assert(this._wallet, 'Ark wallet not initialized');

    const balance = await this._wallet.getBalance();
    await this._populateArkTokenCacheFromWalletBalance(balance);
    this._lastBalanceFetch = Date.now();
    // decision 6: spendable offchain + recoverable. Boarding is excluded so a settling
    // refill is never double counted while the UTXO and the new VTXO both exist.
    return balance.available + balance.recoverable;
  }

  /** Full re-sync from the indexer now. */
  async resyncFromIndexer() {
    assert(this._wallet, 'Ark wallet not initialized');
    await this._wallet.restore();
    return this.getOffchainBalance();
  }

  private async _populateArkTokenCacheFromWalletBalance(balance: WalletBalance): Promise<void> {
    assert(this._wallet, 'Ark wallet not initialized');
    const assets = balance.assets ?? [];
    const cached: CachedTokenInfo[] = [];

    for (const { assetId, amount } of assets) {
      if (amount <= 0) continue;

      let name = `${assetId.slice(0, 16)}…`;
      let symbol = '';
      let decimals = 0;
      let logoURI: string | undefined;

      try {
        const details = await this._wallet.assetManager.getAssetDetails(assetId);
        const m = details?.metadata;
        if (m) {
          if (typeof m.name === 'string' && m.name.length > 0) name = m.name;
          if (typeof m.ticker === 'string' && m.ticker.length > 0) symbol = m.ticker;
          if (typeof m.decimals === 'number') decimals = m.decimals;
          if (typeof m.icon === 'string' && m.icon.length > 0) logoURI = m.icon;
        }
      } catch (error) {
        globalThis.handleError?.(error, 'ark-wallet.ts');
      }

      if (!symbol) symbol = 'ASSET';

      cached.push({
        id: assetId,
        chainId: 0,
        name,
        decimals,
        symbol,
        logoURI,
        balance: String(amount),
      });
    }

    this._arkTokenBalances = cached;
    this._lastTokensFetch = Date.now();
  }

  async fetchTokenBalances(): Promise<void> {
    if (this._lastBalanceFetch > 0 && Date.now() - this._lastBalanceFetch > 5_000) {
      // tokens are fetched in `getOffchainBalance`, but since it was called a long time ago lets call it again
      // so we wont have stale data
      await this.getOffchainBalance();
    }
  }

  getTokenBalances(): CachedTokenInfo[] {
    if (!this._wallet) throw new Error('Ark wallet not initialized');
    return this._arkTokenBalances;
  }

  async transferToken(tokenId: string, amount: bigint, address: string, _memo?: string): Promise<string> {
    assert(this._wallet, 'Ark wallet not initialized');
    if (amount < 0n) throw new Error('Invalid amount');

    return await this._wallet.send({
      address,
      assets: [{ assetId: tokenId, amount }],
    });
  }

  async pay(address: string, amount: number): Promise<string> {
    if (!this._wallet) throw new Error('Ark wallet not initialized');

    console.log(`paying ${amount} sat...`);
    return await this._wallet.send({
      address,
      amount,
    });
  }

  async getOffchainReceiveAddress(): Promise<string> {
    if (!this._wallet) throw new Error('Ark wallet not initialized');

    const address = await this._wallet.getAddress();
    return address;
  }

  async getCommonTransactions(): Promise<CommonTransaction[]> {
    if (!this._wallet) throw new Error('Ark wallet not initialized');

    const transactions = await this._wallet.getTransactionHistory();

    const commonTransactions: CommonTransaction[] = [];

    for (const transaction of transactions) {
      if (!transaction.key.arkTxid) continue; // here we only show ark transactions

      const rawCreatedAt = transaction.createdAt ?? 0; // 0 when tx is still pending
      const isPending = rawCreatedAt === 0;
      const createdAt = isPending ? new Date().getTime() : rawCreatedAt;
      const timestamp = Math.floor(createdAt / 1000);

      const tokenTransfers: CommonTokenTransfer[] = [];

      for (const a of transaction.assets || []) {
        const aDetails = await this._wallet.assetManager.getAssetDetails(a.assetId);
        tokenTransfers.push({
          tokenId: a.assetId,
          amount: Number(a.amount),
          decimals: aDetails.metadata?.decimals || 0,
          name: aDetails.metadata?.name,
          symbol: aDetails.metadata?.ticker,
          logoURI: aDetails.metadata?.icon,
        });
      }

      commonTransactions.push({
        network: this._arkadeNetwork,
        txid: transaction.key.arkTxid,
        timestamp,
        direction: transaction.type === TxType.TxSent ? 'send' : 'receive',
        amount: transaction.amount,
        tokenTransfers,
        status: isPending ? 'pending' : 'confirmed',
        confirmations: isPending ? 0 : 1,
      });
    }

    return commonTransactions;
  }

  async createLightningInvoice(_amountSats: number, _memo: string): Promise<createLightningInvoiceResponse> {
    throw new Error(LIGHTNING_UNAVAILABLE_MESSAGE);
  }

  fetchLightningLimits(): Promise<LightningPaymentLimitsResponse> {
    // fixme
    return Promise.resolve({
      receive: {
        minSat: 333,
        maxSat: 100000000,
        maxZeroConfSat: 0,
      },
      send: {
        minSat: 333,
        maxSat: 100000000,
        maxZeroConfSat: 0,
      },
    });
  }

  async isInvoicePaid(_invoice: string): Promise<boolean> {
    throw new Error(LIGHTNING_UNAVAILABLE_MESSAGE);
  }

  async isInvoicePaidByHash(_preimageHash: string): Promise<boolean> {
    throw new Error(LIGHTNING_UNAVAILABLE_MESSAGE);
  }

  async payLightningInvoice(_invoice: string): Promise<boolean> {
    throw new Error(LIGHTNING_UNAVAILABLE_MESSAGE);
  }

  allowLightning() {
    // Lightning on Arkade returns with the Arkade 0.5 migration
    return false;
  }

  async getOnchainDepositAddress(): Promise<string> {
    if (!this._wallet) throw new Error('Ark wallet not initialized');

    return await this._wallet.getBoardingAddress();
  }

  async getCommonSwaps(): Promise<CommonSwap[]> {
    if (!this._wallet) throw new Error('Ark wallet not initialized');
    if (!BlueElectrum.mainConnected) await BlueElectrum.connectMain();

    const swaps: CommonSwap[] = [];
    const network = this._arkadeNetwork;
    const transactions = await this._wallet.getTransactionHistory();

    // unclaimed swaps
    const unclaimedTxs = transactions.filter((tx) => tx.key.boardingTxid && !tx.settled);
    const txs1 = await BlueElectrum.multiGetTransactionByTxid([...unclaimedTxs.map((tx) => tx.key.boardingTxid)], true);
    const unclaimedSwaps: CommonSwap[] = unclaimedTxs.map((tx) => {
      const txDetails = txs1[tx.key.boardingTxid];
      const timestamp = tx.createdAt || new Date().getTime();
      const confirmations = txDetails.confirmations ?? 0;
      const claimable = confirmations >= 1; // claimable once the deposit confirms
      return {
        network,
        id: tx.key.boardingTxid,
        status: claimable ? 'claimable' : 'pending',
        amount: tx.amount,
        timestamp,
        direction: 'receive',
        // we only want to show confirmations for 'pending' swaps
        confirmations: !claimable ? confirmations : undefined,
        targetConfirmations: !claimable ? 1 : undefined,
      };
    });
    swaps.push(...unclaimedSwaps);

    // claimed swaps
    const claimedTxs = transactions.filter((tx) => tx.key.boardingTxid && tx.settled);
    const claimedSwaps: CommonSwap[] = claimedTxs.map((tx) => {
      const timestamp = tx.createdAt || new Date().getTime();
      return {
        network,
        id: tx.key.boardingTxid,
        status: 'confirmed',
        timestamp,
        amount: tx.amount,
        direction: 'receive',
      };
    });
    swaps.push(...claimedSwaps);

    return swaps;
  }

  async getSettledBoardingAmount(boardingTxid: string): Promise<{ txid: string; creditAmountSats: number } | null> {
    if (!this._wallet) return null;
    const txs = await this._wallet.getTransactionHistory();
    const tx = txs.find((t) => t.key.boardingTxid === boardingTxid && t.settled);
    if (!tx) return null;
    return { txid: tx.key.arkTxid || tx.key.commitmentTxid, creditAmountSats: tx.amount };
  }

  async claimDepositArk(txid: string): Promise<{ txid: string; creditAmountSats?: number }> {
    if (!this._wallet) throw new Error('Ark wallet not initialized');

    const boardingUtxos = (await this._wallet.getBoardingUtxos()).filter((utxo) => utxo.txid === txid);
    if (boardingUtxos.length === 0) {
      // The SDK's VtxoManager auto-settles boarding UTXOs in the background. If it won the
      // race with this manual claim, report the settled deposit instead of asking
      // Ramps.onboard() to settle an empty input set (which would fail on fees >= value).
      // When the deposit is merely not yet visible to the indexer, neither branch fires and
      // the caller sees a retryable message rather than an SDK internals error.
      const settled = await this.getSettledBoardingAmount(txid);
      if (settled) return settled;
      throw new Error('Boarding deposit is not claimable right now: it may already have been settled automatically, or the indexer has not caught up yet. Try again shortly.');
    }

    const { fees } = await this._wallet.arkProvider.getInfo();
    const resultTxid = await new Ramps(this._wallet).onboard(fees, boardingUtxos);

    // Look up the post-fee credited amount from the resulting VTXO
    // Retry with delay — indexer may not have processed the new VTXO immediately
    let creditAmountSats: number | undefined;
    try {
      for (let i = 0; i < 5; i++) {
        await sleep(2000);
        const txs = await this._wallet.getTransactionHistory();
        const resultTx = txs.find((tx) => tx.key.arkTxid === resultTxid || tx.key.commitmentTxid === resultTxid);
        if (resultTx) {
          creditAmountSats = resultTx.amount;
          break;
        }
      }
    } catch (e) {
      // Non-critical — dedup will still work via receiveTransferId
      /* ignore */
    }

    return { txid: resultTxid, creditAmountSats };
  }

  /**
   * Static method to validate ARK addresses
   * Uses ArkAddress.decode from @arkade-os/sdk to validate the address format
   * @param address The address to validate
   * @returns true if the address is valid, false otherwise
   */
  static isAddressValid(address: string): boolean {
    try {
      ArkAddress.decode(address);
      return true;
    } catch (error) {
      return false;
    }
  }

  isAddressValid(address: string): boolean {
    return ArkWallet.isAddressValid(address);
  }
}
