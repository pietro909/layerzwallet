import assert from 'assert';
import { test, vi } from 'vitest';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

import { ArkWallet } from '../../class/wallets/ark-wallet';
import { IStorage } from '../../types/IStorage';

// Boltz is gone; the SDK Wallet is stubbed so init() and balance reads run without a server.
const { walletCreateMock } = vi.hoisted(() => ({ walletCreateMock: vi.fn() }));

vi.mock('@arkade-os/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@arkade-os/sdk')>();
  return {
    ...actual,
    Wallet: class extends actual.Wallet {
      static create = walletCreateMock;
    },
  };
});

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const managerStub = {
  getExpiringVtxos: vi.fn().mockResolvedValue([]),
  renewVtxos: vi.fn(),
};

const walletStub = {
  getVtxoManager: vi.fn().mockResolvedValue(managerStub),
  restore: vi.fn().mockResolvedValue(undefined),
  clearSyncCursor: vi.fn().mockResolvedValue(undefined),
  arkProvider: { getInfo: vi.fn().mockResolvedValue({}) },
  getContractManager: vi.fn().mockResolvedValue({ getContracts: vi.fn().mockResolvedValue([]) }),
  getBalance: vi.fn().mockResolvedValue({ available: 42, assets: [] }),
  assetManager: { getAssetDetails: vi.fn() },
};

test('ark lightning methods reject with a clear message while Boltz is removed', async () => {
  const w = new ArkWallet();
  const message = /temporarily unavailable/;

  await assert.rejects(w.createLightningInvoice(1000, 'memo'), message);
  await assert.rejects(w.payLightningInvoice('lnbc1invoice'), message);
  await assert.rejects(w.isInvoicePaid('lnbc1invoice'), message);
  await assert.rejects(w.isInvoicePaidByHash('a'.repeat(64)), message);

  assert.strictEqual(w.allowLightning(), false);

  // limits stay readable so the Lightning screens keep rendering until steps 3-4
  const limits = await w.fetchLightningLimits();
  assert.ok(limits.send.minSat > 0);
  assert.ok(limits.receive.minSat > 0);
});

test('init and a balance read leave stored Boltz swap rows byte-identical', async () => {
  walletCreateMock.mockResolvedValue(walletStub);

  // same namespace ArkWallet derives for the default server and account 0
  const namespace = `ark-sdk-v2:${bytesToHex(sha256('https://mutinynet.arkade.sh')).slice(0, 16)}:account_0`;
  const swapRows: Record<string, string> = {
    [`${namespace}:swaps:reverse`]: JSON.stringify([{ id: 'rev1', type: 'reverse', status: 'invoice.settled', createdAt: 1756199879000, response: { invoice: 'lnbc5u1p5ddkvz' } }]),
    [`${namespace}:swaps:submarine`]: JSON.stringify([{ id: 'sub1', type: 'submarine', status: 'invoice.pending', createdAt: 1756199879000, invoice: 'lnbc19u1p5dd0qv', redeemScript: '0020abcd' }]),
    [`${namespace}:swaps:chain`]: '[]',
  };

  const cache: Record<string, string> = { ...swapRows };
  const storage: IStorage = {
    async setItem(key: string, value: string) {
      cache[key] = value;
    },
    async getItem(key: string) {
      return cache[key];
    },
  };

  const w = new ArkWallet();
  w.setSecret(TEST_MNEMONIC);
  await w.init(storage);

  // the SDK is wired without any swap repository
  const config = walletCreateMock.mock.calls[0][0];
  assert.ok(config.storage.walletRepository);
  assert.ok(config.storage.contractRepository);
  assert.ok(!('swapRepository' in config.storage));

  assert.strictEqual(await w.getOffchainBalance(), 42);

  for (const [key, value] of Object.entries(swapRows)) {
    assert.strictEqual(cache[key], value, `${key} must stay untouched for the step 6 refund`);
  }
});
