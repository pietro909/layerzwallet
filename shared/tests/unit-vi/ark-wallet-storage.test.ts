import assert from 'assert';
import { beforeEach, test, vi } from 'vitest';
import {
  MAX_PAGE_SIZE,
  collectVtxos,
  type ArkTransaction,
  type Contract,
  type ContractRepository,
  type ExtendedCoin,
  type ExtendedVirtualCoin,
  type TxType,
  type WalletRepository,
} from '@arkade-os/sdk';

import { ArkWallet } from '../../class/wallets/ark-wallet';
import { parseStoredTransactionList, parseStoredUtxoList, stringifyUtxoList } from '../../class/wallets/ark-wallet-storage';
import { IStorage } from '../../types/IStorage';
import { NETWORK_ARK_MUTINYNET } from '../../types/networks';

const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));

vi.mock('@arkade-os/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@arkade-os/sdk')>();
  return {
    ...actual,
    Wallet: class extends actual.Wallet {
      static create = createMock;
    },
  };
});

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const walletStub = {
  dispose: vi.fn().mockResolvedValue(undefined),
  restore: vi.fn().mockResolvedValue(undefined),
  clearSyncCursor: vi.fn().mockResolvedValue(undefined),
  getBalance: vi.fn().mockResolvedValue({ available: 0, recoverable: 0, assets: [] }),
  assetManager: { getAssetDetails: vi.fn() },
};

const tapLeaf = () => {
  const internalKey = new Uint8Array(32).fill(9);
  return [{ version: 192, internalKey, merklePath: [] as Uint8Array[] }, new Uint8Array([0x51])] as ExtendedVirtualCoin['proofTapLeafScript'];
};

const vtxo = (txid: string, vout: number): ExtendedVirtualCoin =>
  ({
    txid,
    vout,
    value: 1000,
    createdAt: new Date(1756199879000),
    tapTree: new Uint8Array([1, 2, 3]),
    forfeitTapLeafScript: tapLeaf(),
    proofTapLeafScript: tapLeaf(),
    script: '5120' + '00'.repeat(32),
    status: { confirmed: true },
    isUnrolled: false,
    isSwept: false,
    isPreconfirmed: false,
    commitmentTxIds: [],
  }) as ExtendedVirtualCoin;

const utxo = (txid: string, vout: number): ExtendedCoin =>
  ({
    txid,
    vout,
    value: 1000,
    tapTree: new Uint8Array([1, 2, 3]),
    forfeitTapLeafScript: tapLeaf(),
    proofTapLeafScript: tapLeaf(),
    status: { confirmed: true },
  }) as ExtendedCoin;

const contract = (script: string, overrides: Partial<Contract> = {}): Contract =>
  ({
    label: script,
    type: 'default',
    params: {},
    script,
    address: `ark1${script}`,
    state: 'active',
    createdAt: 1756199879000,
    ...overrides,
  }) as Contract;

const tx = (arkTxid: string, createdAt: number): ArkTransaction =>
  ({
    key: { boardingTxid: '', commitmentTxid: '', arkTxid },
    type: 'received' as TxType,
    amount: 1000,
    settled: true,
    createdAt,
  }) as ArkTransaction;

type HarnessConfig = {
  storage: { walletRepository: WalletRepository; contractRepository: ContractRepository };
  operatorProvider: unknown;
  arkProvider?: unknown;
  delegateProvider?: unknown;
};

/** Boot a real ArkWallet against an in-memory IStorage and hand back the SDK repositories. */
const makeHarness = async () => {
  const cache: Record<string, string> = {};
  const storage: IStorage = {
    async setItem(key: string, value: string) {
      cache[key] = value;
    },
    async getItem(key: string) {
      return cache[key];
    },
  };

  createMock.mockResolvedValue(walletStub);
  const w = new ArkWallet();
  w.setSecret(TEST_MNEMONIC);
  w.setArkadeNetwork(NETWORK_ARK_MUTINYNET);
  await w.init(storage);

  const config = createMock.mock.calls.at(-1)![0] as HarnessConfig;
  return {
    cache,
    storage,
    wallet: w,
    config,
    walletRepo: config.storage.walletRepository,
    contractRepo: config.storage.contractRepository,
    namespace: Object.keys(cache)
      .find((k) => k.endsWith(':upgrade:sdk05V1'))!
      .replace(':upgrade:sdk05V1', ''),
  };
};

beforeEach(() => {
  createMock.mockReset();
  walletStub.restore.mockClear();
  walletStub.clearSyncCursor.mockClear();
  walletStub.dispose.mockClear();
});

test('wallet repository is v2 and pages VTXOs by outpoint with an exclusive cursor', async () => {
  const { walletRepo } = await makeHarness();
  assert.strictEqual(walletRepo.version, 2);

  const address = 'ark1address';
  await walletRepo.saveVtxos(address, [vtxo('c'.repeat(64), 2), vtxo('a'.repeat(64), 0), vtxo('a'.repeat(64), 1), vtxo('b'.repeat(64), 0)]);

  const first = await walletRepo.getVtxosPage(address, { limit: 2 });
  assert.deepEqual(
    first.items.map((v) => `${v.txid}:${v.vout}`),
    [`${'a'.repeat(64)}:0`, `${'a'.repeat(64)}:1`]
  );
  assert.deepEqual(first.nextCursor, { txid: 'a'.repeat(64), vout: 1 });

  const second = await walletRepo.getVtxosPage(address, { limit: 2, after: first.nextCursor });
  assert.deepEqual(
    second.items.map((v) => `${v.txid}:${v.vout}`),
    [`${'b'.repeat(64)}:0`, `${'c'.repeat(64)}:2`]
  );
  assert.strictEqual(second.nextCursor, undefined);

  // the SDK collector walks the pages to the end
  const all = await collectVtxos(walletRepo, address);
  assert.strictEqual(all.length, 4);
});

test('saveUtxos accepts the batched Map overload and getUtxosPage is paged', async () => {
  const { walletRepo } = await makeHarness();
  const addressA = 'arkA';
  const addressB = 'arkB';

  await walletRepo.saveUtxos(
    new Map([
      [addressA, [utxo('a'.repeat(64), 0), utxo('b'.repeat(64), 0)]],
      [addressB, [utxo('c'.repeat(64), 0)]],
    ])
  );

  const pageA = await walletRepo.getUtxosPage(addressA, { limit: 1 });
  assert.deepEqual(
    pageA.items.map((u) => u.txid),
    ['a'.repeat(64)]
  );
  assert.deepEqual(pageA.nextCursor, { txid: 'a'.repeat(64), vout: 0 });
  assert.strictEqual((await walletRepo.getUtxosPage(addressB, { limit: 10 })).items.length, 1);
});

test('page limits are validated against the SDK MAX_PAGE_SIZE', async () => {
  const { walletRepo } = await makeHarness();
  await assert.rejects(walletRepo.getVtxosPage('ark', { limit: 0 }), RangeError);
  await assert.rejects(walletRepo.getVtxosPage('ark', { limit: MAX_PAGE_SIZE + 1 }), RangeError);
});

test('transaction history pages sort by (createdAt, key) and honour since/after', async () => {
  const { walletRepo } = await makeHarness();
  const address = 'ark1history';
  await walletRepo.saveTransactions(address, [tx('c'.repeat(64), 3000), tx('a'.repeat(64), 1000), tx('b'.repeat(64), 2000)]);

  const first = await walletRepo.getTransactionHistoryPage({ address }, { limit: 2 });
  assert.deepEqual(
    first.items.map((t) => t.key.arkTxid),
    ['a'.repeat(64), 'b'.repeat(64)]
  );
  assert.strictEqual(first.nextCursor?.createdAt, 2000);

  const rest = await walletRepo.getTransactionHistoryPage({ address }, { limit: 2, after: first.nextCursor });
  assert.deepEqual(
    rest.items.map((t) => t.key.arkTxid),
    ['c'.repeat(64)]
  );

  const since = await walletRepo.getTransactionHistoryPage({ address, since: 2000 }, { limit: 10 });
  assert.deepEqual(
    since.items.map((t) => t.key.arkTxid),
    ['b'.repeat(64), 'c'.repeat(64)]
  );
  await assert.rejects(walletRepo.getTransactionHistoryPage({ address, since: -1 }, { limit: 10 }), RangeError);
});

test('wallet state survives a read/write round trip', async () => {
  const { walletRepo } = await makeHarness();
  assert.strictEqual(await walletRepo.getWalletState(), null);
  await walletRepo.saveWalletState({ lastSyncTime: 123, settings: { legacyUtxosMigrated: true } });
  assert.deepEqual(await walletRepo.getWalletState(), { lastSyncTime: 123, settings: { legacyUtxosMigrated: true } });
});

test('contract repository is v4: watch defaults, scope defaults, paging and empty filters', async () => {
  const { contractRepo } = await makeHarness();
  assert.strictEqual(contractRepo.version, 4);

  await contractRepo.saveContract(contract('script-a', { type: 'boarding' })); // absent scope -> onchain
  await contractRepo.saveContract(contract('script-b', { type: 'default' })); // absent -> offchain
  await contractRepo.saveContract(contract('script-c', { watch: 'retained', scope: 'both' }));
  await contractRepo.saveContract(contract('script-d', { watch: 'awaiting-funds' }));

  const all = await contractRepo.getContractsPage(undefined, { limit: 10 });
  assert.deepEqual(
    all.items.map((c) => c.script),
    ['script-a', 'script-b', 'script-c', 'script-d']
  );

  // absent watch == "watched"
  assert.deepEqual(
    (await contractRepo.getContractsPage({ watch: 'watched' }, { limit: 10 })).items.map((c) => c.script),
    ['script-a', 'script-b']
  );
  assert.deepEqual(
    (await contractRepo.getContractsPage({ watch: 'retained' }, { limit: 10 })).items.map((c) => c.script),
    ['script-c']
  );

  // absent scope resolves through the handler default: boarding is onchain, everything else offchain
  assert.deepEqual(
    (await contractRepo.getContractsPage({ scope: 'onchain' }, { limit: 10 })).items.map((c) => c.script),
    ['script-a']
  );
  assert.deepEqual(
    (await contractRepo.getContractsPage({ scope: ['offchain', 'both'] }, { limit: 10 })).items.map((c) => c.script),
    ['script-b', 'script-c', 'script-d']
  );

  // an empty filter array matches nothing
  assert.deepEqual((await contractRepo.getContractsPage({ type: [] }, { limit: 10 })).items, []);

  const first = await contractRepo.getContractsPage(undefined, { limit: 2 });
  assert.strictEqual(first.nextCursor, 'script-b');
  assert.deepEqual(
    (await contractRepo.getContractsPage(undefined, { limit: 10, after: first.nextCursor })).items.map((c) => c.script),
    ['script-c', 'script-d']
  );
});

test('concurrent contract saves do not drop each other', async () => {
  const { contractRepo } = await makeHarness();
  await Promise.all(['a', 'b', 'c', 'd'].map((suffix) => contractRepo.saveContract(contract(`script-${suffix}`))));
  const all = await contractRepo.getContractsPage(undefined, { limit: 10 });
  assert.deepEqual(all.items.map((c) => c.script).sort(), ['script-a', 'script-b', 'script-c', 'script-d']);
});

test('legacy 0.4 UTXO rows (intentTapLeafScript) are still served by getUtxosPage', async () => {
  const { walletRepo, cache, namespace } = await makeHarness();
  const address = 'ark1legacy';
  const stored = stringifyUtxoList([utxo('a'.repeat(64), 0)]) as string;
  const legacyRow = JSON.parse(stored)[0];
  legacyRow.intentTapLeafScript = legacyRow.proofTapLeafScript;
  delete legacyRow.proofTapLeafScript;
  legacyRow.virtualStatus = { state: 'settled' };
  cache[`${namespace}:wallet:utxos:${address}`] = JSON.stringify([legacyRow]);

  const rows = await walletRepo.getUtxosPage(address, { limit: 10 });
  assert.strictEqual(rows.items.length, 1);
  assert.ok(rows.items[0].proofTapLeafScript[1] instanceof Uint8Array);
  assert.ok(!('virtualStatus' in rows.items[0]));
});

test('codec parses legacy UTXO rows and skips corrupt transaction rows', () => {
  const stored = JSON.parse(stringifyUtxoList([utxo('a'.repeat(64), 0)]))[0];
  stored.intentTapLeafScript = stored.proofTapLeafScript;
  delete stored.proofTapLeafScript;
  const parsed = parseStoredUtxoList(JSON.stringify([stored, { txid: 'bad' }]));
  assert.strictEqual(parsed.length, 1);

  const txs = parseStoredTransactionList(JSON.stringify([{ noKey: true }, tx('a'.repeat(64), 1000)]));
  assert.strictEqual(txs.length, 1);
  assert.strictEqual(txs[0].key.arkTxid, 'a'.repeat(64));
});

test('a stored VTXO round-trips its flat 0.5 fields through the repository', async () => {
  const { walletRepo, cache, namespace } = await makeHarness();
  const address = 'ark1flat';
  const coin = vtxo('a'.repeat(64), 0);
  (coin as ExtendedVirtualCoin).expiresAt = new Date(1756286279000);
  (coin as ExtendedVirtualCoin).isSwept = true;
  (coin as ExtendedVirtualCoin).commitmentTxIds = ['b'.repeat(64)];

  await walletRepo.saveVtxos(address, [coin]);
  const rows = await walletRepo.getVtxosPage(address, { limit: 10 });

  assert.ok(rows.items[0].createdAt instanceof Date);
  assert.ok(rows.items[0].expiresAt instanceof Date);
  assert.strictEqual(rows.items[0].expiresAt!.getTime(), 1756286279000);
  assert.strictEqual(rows.items[0].isSwept, true);
  assert.deepEqual(rows.items[0].commitmentTxIds, ['b'.repeat(64)]);
  assert.strictEqual(rows.items[0].isUnrolled, false);
  assert.ok(cache[`${namespace}:wallet:vtxos:${address}`]);
});
