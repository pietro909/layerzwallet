import assert from 'assert';
import { beforeEach, test, vi } from 'vitest';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { MAX_PAGE_SIZE, type Contract, type ExtendedCoin, type ExtendedVirtualCoin } from '@arkade-os/sdk';

import { ArkWallet } from '../../class/wallets/ark-wallet';
import { serializeUtxo, serializeVtxo } from '../../class/wallets/ark-wallet-storage';
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
const NAMESPACE = `ark-sdk-v2:${bytesToHex(sha256('https://mutinynet.arkade.sh')).slice(0, 16)}:account_0`;
const OFFCHAIN_ADDRESS = 'ark1legacyoffchain';
const BOARDING_ADDRESS = 'ark1legacyboarding';

const tapLeaf = () => {
  const internalKey = new Uint8Array(32).fill(9);
  return [{ version: 192, internalKey, merklePath: [] as Uint8Array[] }, new Uint8Array([0x51])] as ExtendedVirtualCoin['proofTapLeafScript'];
};

const vtxo = (txid: string, vout = 0): ExtendedVirtualCoin =>
  ({
    txid,
    vout,
    value: 2100,
    createdAt: new Date(1756199879000),
    tapTree: new Uint8Array([1, 2, 3]),
    forfeitTapLeafScript: tapLeaf(),
    proofTapLeafScript: tapLeaf(),
    script: '5120' + '00'.repeat(32),
    status: { confirmed: true, block_time: 1756199879 },
    isUnrolled: false,
    isSwept: false,
    isPreconfirmed: false,
    commitmentTxIds: [],
  }) as ExtendedVirtualCoin;

const utxo = (txid: string, vout = 0): ExtendedCoin =>
  ({
    txid,
    vout,
    value: 5000,
    tapTree: new Uint8Array([1, 2, 3]),
    forfeitTapLeafScript: tapLeaf(),
    proofTapLeafScript: tapLeaf(),
    status: { confirmed: true, block_time: 1756199879 },
  }) as ExtendedCoin;

/** A 0.4.42 codec row: intentTapLeafScript + virtualStatus, no flat fields. */
const legacyVtxoRow = (txid: string): Record<string, unknown> => {
  const stored = serializeVtxo(vtxo(txid)) as unknown as Record<string, unknown>;
  stored.intentTapLeafScript = stored.proofTapLeafScript;
  delete stored.proofTapLeafScript;
  stored.virtualStatus = { state: 'settled', batchExpiry: 1756286279000, commitmentTxIds: [] };
  for (const field of ['isSwept', 'isPreconfirmed', 'isUnrolled', 'commitmentTxIds', 'expiresAt']) delete stored[field];
  return stored;
};

const legacyUtxoRow = (txid: string): Record<string, unknown> => {
  const stored = serializeUtxo(utxo(txid)) as unknown as Record<string, unknown>;
  stored.intentTapLeafScript = stored.proofTapLeafScript;
  delete stored.proofTapLeafScript;
  return stored;
};

const legacyContract = (script: string, type: string): Contract =>
  ({
    type,
    params: {},
    script,
    address: BOARDING_ADDRESS,
    state: 'active',
    createdAt: 1756199879000,
  }) as Contract;

/**
 * A 0.4.42 Layerz data dump: old VTXO rows, old UTXO rows, a boarding contract,
 * a stale sync cursor and the Boltz swap rows step 6 still needs. No real device dump
 * was available, so the rows are built in the exact shape the 0.4.42 codec wrote.
 */
const legacyDump = (): Record<string, string> => {
  const swapRows = {
    [`${NAMESPACE}:swaps:reverse`]: JSON.stringify([{ id: 'rev1', type: 'reverse', status: 'invoice.settled' }]),
    [`${NAMESPACE}:swaps:submarine`]: JSON.stringify([{ id: 'sub1', type: 'submarine', status: 'invoice.pending' }]),
    [`${NAMESPACE}:swaps:chain`]: '[]',
  };

  return {
    [`${NAMESPACE}:wallet:addresses`]: JSON.stringify([OFFCHAIN_ADDRESS, BOARDING_ADDRESS]),
    [`${NAMESPACE}:wallet:vtxos:${OFFCHAIN_ADDRESS}`]: JSON.stringify([legacyVtxoRow('a'.repeat(64))]),
    [`${NAMESPACE}:wallet:utxos:${BOARDING_ADDRESS}`]: JSON.stringify([legacyUtxoRow('b'.repeat(64))]),
    [`${NAMESPACE}:wallet:txs:${OFFCHAIN_ADDRESS}`]: '[]',
    [`${NAMESPACE}:wallet:state`]: JSON.stringify({ lastSyncTime: 1756199879000 }),
    [`${NAMESPACE}:contracts`]: JSON.stringify([legacyContract('5120aa', 'boarding'), legacyContract('5120bb', 'default')]),
    ...swapRows,
  };
};

const makeStorage = (cache: Record<string, string>): IStorage => ({
  async setItem(key: string, value: string) {
    cache[key] = value;
  },
  async getItem(key: string) {
    return cache[key];
  },
});

const makeWalletStub = (clearSyncCursor: () => Promise<void>) => ({
  dispose: vi.fn().mockResolvedValue(undefined),
  restore: vi.fn().mockResolvedValue(undefined),
  clearSyncCursor: vi.fn().mockImplementation(clearSyncCursor),
  getBalance: vi.fn().mockResolvedValue({ available: 0, recoverable: 0, assets: [] }),
  assetManager: { getAssetDetails: vi.fn() },
});

beforeEach(() => {
  createMock.mockReset();
});

test('a 0.4.42 data dump upgrades in place: VTXOs wiped, UTXOs kept, swap rows untouched', async () => {
  const cache = legacyDump();
  const swapRows = Object.fromEntries(Object.entries(cache).filter(([key]) => key.includes(':swaps:')));
  const utxoRowBefore = cache[`${NAMESPACE}:wallet:utxos:${BOARDING_ADDRESS}`];

  let capturedConfig: any;
  let walletStub: ReturnType<typeof makeWalletStub>;
  createMock.mockImplementation(async (config: any) => {
    capturedConfig = config;
    // Simulate what the SDK does during Wallet.create: migrateLegacyUtxos reads the
    // legacy UTXO buckets through the paged repository before copying them.
    const legacyUtxos = await config.storage.walletRepository.getUtxosPage(BOARDING_ADDRESS, { limit: MAX_PAGE_SIZE });
    assert.strictEqual(legacyUtxos.items.length, 1, 'legacy UTXOs must still be readable at boot');
    const contracts = await config.storage.contractRepository.getContractsPage(undefined, { limit: MAX_PAGE_SIZE });
    assert.strictEqual(contracts.items.length, 2);

    walletStub = makeWalletStub(async () => {
      const repo = config.storage.walletRepository;
      const state = (await repo.getWalletState()) ?? {};
      await repo.saveWalletState({ ...state, lastSyncTime: undefined });
    });
    return walletStub;
  });

  const w = new ArkWallet();
  w.setSecret(TEST_MNEMONIC);
  w.setArkadeNetwork(NETWORK_ARK_MUTINYNET);
  await w.init(makeStorage(cache));

  // 0.5 config: renamed provider, no delegate, same two repositories
  assert.ok(capturedConfig.operatorProvider);
  assert.ok(!capturedConfig.arkProvider);
  assert.ok(!capturedConfig.delegateProvider);

  // the legacy virtualStatus VTXO cache is gone, but the legacy UTXO rows survive
  assert.strictEqual(cache[`${NAMESPACE}:wallet:vtxos:${OFFCHAIN_ADDRESS}`], '[]');
  assert.strictEqual(cache[`${NAMESPACE}:wallet:utxos:${BOARDING_ADDRESS}`], utxoRowBefore);
  assert.strictEqual(JSON.parse(cache[`${NAMESPACE}:wallet:state`]).lastSyncTime, undefined);

  // flags are written only after the pieces succeeded
  assert.strictEqual(JSON.parse(cache[`${NAMESPACE}:upgrade:sdk05V1`]), true);
  assert.strictEqual(JSON.parse(cache[`${NAMESPACE}:bootstrap:restoredV1`]), true);
  assert.strictEqual(walletStub!.clearSyncCursor.mock.calls.length, 1);
  assert.strictEqual(walletStub!.restore.mock.calls.length, 1);

  // step 6 still has its rows, byte for byte
  for (const [key, value] of Object.entries(swapRows)) {
    assert.strictEqual(cache[key], value, `${key} must stay untouched for the step 6 refund`);
  }

  // the surviving legacy UTXO row is decoded with the new codec
  const rows = await capturedConfig.storage.walletRepository.getUtxosPage(BOARDING_ADDRESS, { limit: MAX_PAGE_SIZE });
  assert.strictEqual(rows.items.length, 1);
  assert.ok(rows.items[0].proofTapLeafScript[1] instanceof Uint8Array);
});

test('the 0.5 upgrade and restore run once per namespace', async () => {
  const cache = legacyDump();
  let clearCalls = 0;
  let restoreCalls = 0;
  createMock.mockImplementation(async () => ({
    dispose: vi.fn().mockResolvedValue(undefined),
    restore: vi.fn().mockImplementation(async () => {
      restoreCalls += 1;
    }),
    clearSyncCursor: vi.fn().mockImplementation(async () => {
      clearCalls += 1;
    }),
    getBalance: vi.fn().mockResolvedValue({ available: 0, recoverable: 0, assets: [] }),
    assetManager: { getAssetDetails: vi.fn() },
  }));

  const storage = makeStorage(cache);
  const w1 = new ArkWallet();
  w1.setSecret(TEST_MNEMONIC);
  w1.setArkadeNetwork(NETWORK_ARK_MUTINYNET);
  await w1.init(storage);

  // a fresh SDK row written after the first boot must not be wiped by the next one
  cache[`${NAMESPACE}:wallet:vtxos:${OFFCHAIN_ADDRESS}`] = JSON.stringify([legacyVtxoRow('c'.repeat(64))]);

  const w2 = new ArkWallet();
  w2.setSecret(TEST_MNEMONIC);
  w2.setArkadeNetwork(NETWORK_ARK_MUTINYNET);
  await w2.init(storage);

  assert.strictEqual(clearCalls, 1);
  assert.strictEqual(restoreCalls, 1);
  assert.notStrictEqual(cache[`${NAMESPACE}:wallet:vtxos:${OFFCHAIN_ADDRESS}`], '[]');
});

test('re-init disposes the previous SDK wallet', async () => {
  const cache = legacyDump();
  const disposes: number[] = [];
  createMock.mockImplementation(async () => ({
    dispose: vi.fn().mockImplementation(async () => {
      disposes.push(1);
    }),
    restore: vi.fn().mockResolvedValue(undefined),
    clearSyncCursor: vi.fn().mockResolvedValue(undefined),
    getBalance: vi.fn().mockResolvedValue({ available: 0, recoverable: 0, assets: [] }),
    assetManager: { getAssetDetails: vi.fn() },
  }));

  const w = new ArkWallet();
  w.setSecret(TEST_MNEMONIC);
  w.setArkadeNetwork(NETWORK_ARK_MUTINYNET);
  await w.init(makeStorage(cache));
  assert.strictEqual(disposes.length, 0);

  await w.init(makeStorage(cache));
  assert.strictEqual(disposes.length, 1);
});
