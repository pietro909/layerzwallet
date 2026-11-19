import assert from 'assert';
import { test, vi } from 'vitest';
import { ArkTransaction, TxType } from '@arkade-os/sdk';
import type { ExtendedVirtualCoin } from '@arkade-os/sdk';

import { ArkWallet } from '../../class/wallets/ark-wallet';
import { deserializeVtxo, parseStoredVtxoList, serializeVtxo, stringifyVtxoList } from '../../class/wallets/ark-wallet-storage';
import { IStorage } from '../../types/IStorage';
import { NETWORK_ARK } from '../../types/networks';
import { DeepPartial } from '../../class/wallets/types';

const minimalTapLeaf = (): ExtendedVirtualCoin['proofTapLeafScript'] => {
  const internalKey = new Uint8Array(32).fill(9);
  const cb = { version: 192, internalKey, merklePath: [] as Uint8Array[] };
  const script = new Uint8Array([0x51, 0x20, ...internalKey]);
  return [cb, script];
};

/** SDK 0.5 shape: flat fields, proof leaf, expiresAt as a Date. */
const minimalVtxo = (overrides: Partial<ExtendedVirtualCoin> = {}): ExtendedVirtualCoin =>
  ({
    txid: 'a'.repeat(64),
    vout: 0,
    value: 2100,
    createdAt: new Date(1756199879000),
    expiresAt: new Date(1756199879000 + 86_400_000),
    expiresAtHeight: 900_000,
    tapTree: new Uint8Array([1, 2, 3, 255]),
    forfeitTapLeafScript: minimalTapLeaf(),
    proofTapLeafScript: minimalTapLeaf(),
    script: '5120' + '00'.repeat(32),
    status: { confirmed: true, block_time: 1756199879 },
    isSpent: false,
    isUnrolled: false,
    isSwept: false,
    isPreconfirmed: true,
    commitmentTxIds: ['c'.repeat(64)],
    settledBy: undefined,
    arkTxId: undefined,
    assets: [{ assetId: 'token-1', amount: 12345678901234567890n }],
    ...overrides,
  }) as ExtendedVirtualCoin;

test('ark vtxo storage round-trips SDK-shaped fields', () => {
  const vtxo = minimalVtxo();
  const stored = serializeVtxo(vtxo);
  const restored = deserializeVtxo(stored);

  assert.ok(restored.createdAt instanceof Date);
  assert.strictEqual(restored.createdAt.getTime(), 1756199879000);
  assert.ok(restored.expiresAt instanceof Date);
  assert.strictEqual(restored.expiresAt.getTime(), vtxo.expiresAt!.getTime());
  assert.strictEqual(restored.expiresAtHeight, 900_000);
  assert.strictEqual(restored.isSwept, false);
  assert.strictEqual(restored.isPreconfirmed, true);
  assert.strictEqual(restored.isUnrolled, false);
  assert.deepEqual(restored.commitmentTxIds, ['c'.repeat(64)]);
  assert.ok(restored.tapTree instanceof Uint8Array);
  assert.deepEqual(Array.from(restored.tapTree), [1, 2, 3, 255]);
  assert.ok(Array.isArray(restored.forfeitTapLeafScript));
  assert.ok(Array.isArray(restored.proofTapLeafScript));
  assert.ok(restored.proofTapLeafScript[1] instanceof Uint8Array);
  assert.strictEqual(typeof restored.assets?.[0].amount, 'bigint');
  assert.strictEqual(restored.assets?.[0].amount, 12345678901234567890n);
});

test('ark vtxo storage parses legacy plain-JSON cache rows', () => {
  const tapLeaf = minimalTapLeaf();
  const legacyRow = {
    ...minimalVtxo({ assets: undefined }),
    createdAt: '2026-03-15T22:46:00.000Z',
    tapTree: Object.fromEntries([...minimalVtxo().tapTree.entries()]),
    forfeitTapLeafScript: [
      {
        version: tapLeaf[0].version,
        internalKey: Object.fromEntries([...tapLeaf[0].internalKey.entries()]),
        merklePath: tapLeaf[0].merklePath.map((p) => Object.fromEntries([...p.entries()])),
      },
      Object.fromEntries([...tapLeaf[1].entries()]),
    ],
    proofTapLeafScript: [
      {
        version: tapLeaf[0].version,
        internalKey: Object.fromEntries([...tapLeaf[0].internalKey.entries()]),
        merklePath: tapLeaf[0].merklePath.map((p) => Object.fromEntries([...p.entries()])),
      },
      Object.fromEntries([...tapLeaf[1].entries()]),
    ],
  };

  const parsed = parseStoredVtxoList(JSON.stringify([legacyRow]));
  assert.strictEqual(parsed.length, 1);
  assert.ok(parsed[0].createdAt instanceof Date);
  assert.ok(!Number.isNaN(parsed[0].createdAt.getTime()));
  assert.ok(parsed[0].tapTree instanceof Uint8Array);
  assert.ok(parsed[0].proofTapLeafScript[1] instanceof Uint8Array);
});

test('a 0.4 intentTapLeafScript row is read back as proofTapLeafScript', () => {
  // 0.4 named the proof leaf intentTapLeafScript; 0.5 renamed it.
  const stored = serializeVtxo(minimalVtxo({ assets: undefined }));
  const legacy: Record<string, unknown> = {
    ...(stored as unknown as Record<string, unknown>),
    intentTapLeafScript: stored.proofTapLeafScript,
    virtualStatus: { state: 'settled', commitmentTxIds: [] },
  };
  delete legacy.proofTapLeafScript;

  const parsed = parseStoredVtxoList(JSON.stringify([legacy]));
  assert.strictEqual(parsed.length, 1);
  assert.ok(parsed[0].proofTapLeafScript[1] instanceof Uint8Array);
  assert.strictEqual(parsed[0].expiresAt instanceof Date, true);
  assert.strictEqual(parsed[0].isSwept, false);
  assert.ok(!('virtualStatus' in parsed[0]));
  assert.ok(!('intentTapLeafScript' in parsed[0]));
});

test('a 0.4 virtualStatus swept row keeps its swept fact', () => {
  const stored = serializeVtxo(minimalVtxo({ assets: undefined, isSwept: true }));
  const legacy: Record<string, unknown> = {
    ...(stored as unknown as Record<string, unknown>),
    intentTapLeafScript: stored.proofTapLeafScript,
    virtualStatus: { state: 'swept', commitmentTxIds: ['d'.repeat(64)] },
  };
  delete legacy.proofTapLeafScript;
  delete legacy.isSwept;
  delete legacy.commitmentTxIds;

  const parsed = parseStoredVtxoList(JSON.stringify([legacy]));
  assert.strictEqual(parsed.length, 1);
  assert.strictEqual(parsed[0].isSwept, true);
  assert.deepEqual(parsed[0].commitmentTxIds, ['d'.repeat(64)]);
});

test('ark vtxo storage drops rows that cannot be coerced', () => {
  const parsed = parseStoredVtxoList(JSON.stringify([{ txid: 'bad', vout: 0, value: 1 }]));
  assert.deepEqual(parsed, []);
});

test('persisted vtxo list uses SDK hex encoding', () => {
  const vtxo = minimalVtxo();
  const raw = JSON.parse(stringifyVtxoList([vtxo]))[0];

  assert.strictEqual(typeof raw.tapTree, 'string');
  assert.strictEqual(typeof raw.forfeitTapLeafScript.cb, 'string');
  assert.strictEqual(typeof raw.forfeitTapLeafScript.s, 'string');
  assert.strictEqual(typeof raw.proofTapLeafScript.cb, 'string');
  assert.strictEqual(typeof raw.proofTapLeafScript.s, 'string');
  assert.strictEqual(typeof raw.createdAt, 'number');
  assert.strictEqual(typeof raw.expiresAt, 'number');
  assert.ok(!('intentTapLeafScript' in raw));

  const loaded = parseStoredVtxoList(stringifyVtxoList([vtxo]));
  assert.strictEqual(loaded.length, 1);
  assert.strictEqual(loaded[0].createdAt.getTime(), vtxo.createdAt.getTime());
});

const _cache: Record<string, string> = {};
const storageMock: IStorage = {
  async setItem(key: string, value: string) {
    _cache[key] = value;
  },

  async getItem(key: string) {
    return _cache[key];
  },
};

test('ark mainnet can getCommonTransactions', async (context) => {
  if (!process.env.TEST_MNEMONIC) {
    console.warn('TEST_MNEMONIC not set, skipping');
    context.skip();
    return;
  }

  const w = new ArkWallet();
  w.setSecret(process.env.TEST_MNEMONIC);
  w.setArkadeNetwork(NETWORK_ARK);
  await w.init(storageMock);

  const transfers: DeepPartial<ArkTransaction>[] = [
    {
      amount: 100,
      createdAt: 1756199879000,
      key: { arkTxid: 'c08e5661587fa741aea8d4eb0be3b400aae75cee18b0e0afa70b9ba41d9ca3be', boardingTxid: '', commitmentTxid: 'fdfe123c8d87e82c81d1e76141684f6e2041a85c5f2fe403982a7bca523f74ff' },
      settled: true,
      type: TxType.TxSent,
    },
    {
      amount: 2100,
      createdAt: 1755786091000,
      key: { arkTxid: '5a41fdc280352cab91fef62a1f407a0c8559ecffb2f85bea1970b72eaf4d6058', boardingTxid: '', commitmentTxid: '44b0e7852490eba4ec6d19fff042e0191078c6ce67b38f99e200632d5be1622a' },
      settled: true,
      type: TxType.TxReceived,
    },
  ];

  (w as any)._wallet = {
    getTransactionHistory: vi.fn().mockImplementation(() => {
      return transfers as ArkTransaction[];
    }),
    assetManager: {
      getAssetDetails: vi.fn().mockResolvedValue({ metadata: {} }),
    },
  };

  const transactions = await w.getCommonTransactions();
  assert.deepEqual(transactions, [
    {
      amount: 100,
      direction: 'send',
      network: NETWORK_ARK,
      timestamp: 1756199879,
      tokenTransfers: [],
      txid: 'c08e5661587fa741aea8d4eb0be3b400aae75cee18b0e0afa70b9ba41d9ca3be',
      status: 'confirmed',
      confirmations: 1,
    },
    {
      amount: 2100,
      direction: 'receive',
      network: NETWORK_ARK,
      timestamp: 1755786091,
      tokenTransfers: [],
      txid: '5a41fdc280352cab91fef62a1f407a0c8559ecffb2f85bea1970b72eaf4d6058',
      status: 'confirmed',
      confirmations: 1,
    },
  ]);
});
