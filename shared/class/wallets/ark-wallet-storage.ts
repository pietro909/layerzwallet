import type { ArkTransaction, ExtendedCoin, ExtendedVirtualCoin } from '@arkade-os/sdk';
import { hex } from '@scure/base';
import { TaprootControlBlock } from '@scure/btc-signer';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';

type TapLeafTuple = ExtendedVirtualCoin['proofTapLeafScript'];
type StoredTapLeaf = { cb: string; s: string };

type StoredAsset = { assetId: string; amount: string | number | bigint };

/**
 * JSON-safe VTXO row persisted in app storage (matches the @arkade-os/sdk 0.5 repository shape).
 *
 * 0.5 replaced the `intentTapLeafScript` proof leaf with `proofTapLeafScript` and the
 * `virtualStatus` blob with flat fields. `expiresAt` is a Date in memory, a timestamp here.
 */
export type StoredVtxo = Omit<ExtendedVirtualCoin, 'createdAt' | 'expiresAt' | 'tapTree' | 'forfeitTapLeafScript' | 'proofTapLeafScript' | 'intentTapLeafScript' | 'extraWitness' | 'assets'> & {
  createdAt: string | number;
  expiresAt?: string | number;
  tapTree: string;
  forfeitTapLeafScript: StoredTapLeaf;
  proofTapLeafScript: StoredTapLeaf;
  extraWitness?: string[];
  assets?: StoredAsset[];
};

export type StoredUtxo = Omit<ExtendedCoin, 'tapTree' | 'forfeitTapLeafScript' | 'proofTapLeafScript' | 'intentTapLeafScript' | 'extraWitness'> & {
  tapTree: string;
  forfeitTapLeafScript: StoredTapLeaf;
  proofTapLeafScript: StoredTapLeaf;
  extraWitness?: string[];
};

export const serializeTapLeaf = ([cb, s]: TapLeafTuple): StoredTapLeaf => ({
  cb: hex.encode(TaprootControlBlock.encode(cb)),
  s: hex.encode(s),
});

export const deserializeTapLeaf = (t: StoredTapLeaf): TapLeafTuple => {
  const cb = TaprootControlBlock.decode(hex.decode(t.cb));
  const s = hex.decode(t.s);
  return [cb, s];
};

const serializeAsset = (a: { assetId: string; amount: bigint }) => ({
  assetId: a.assetId,
  amount: a.amount.toString(),
});

const deserializeAsset = (a: StoredAsset) => {
  // only these three shapes are amounts; anything else (null, false, '', floats) must not coerce to 0n
  const valid =
    (typeof a.amount === 'bigint' && a.amount >= 0n) || (typeof a.amount === 'number' && Number.isSafeInteger(a.amount) && a.amount >= 0) || (typeof a.amount === 'string' && /^\d+$/.test(a.amount));
  if (!valid) throw new Error(`Malformed asset amount for ${a.assetId}`);

  return {
    assetId: a.assetId,
    amount: typeof a.amount === 'bigint' ? a.amount : BigInt(a.amount),
  };
};

export const serializeVtxo = (v: ExtendedVirtualCoin): StoredVtxo => {
  const { createdAt, expiresAt, tapTree, forfeitTapLeafScript, proofTapLeafScript, intentTapLeafScript, extraWitness, assets, ...rest } = v;
  // 0.4 called the proof leaf intentTapLeafScript; 0.5 renamed it proofTapLeafScript.
  const proof = proofTapLeafScript ?? intentTapLeafScript ?? forfeitTapLeafScript;
  return {
    ...rest,
    createdAt: createdAt.getTime(),
    ...(expiresAt ? { expiresAt: expiresAt.getTime() } : {}),
    tapTree: hex.encode(tapTree),
    forfeitTapLeafScript: serializeTapLeaf(forfeitTapLeafScript),
    proofTapLeafScript: serializeTapLeaf(proof),
    extraWitness: extraWitness?.map((w) => hex.encode(w)),
    assets: assets?.map(serializeAsset),
  };
};

export const serializeUtxo = (u: ExtendedCoin): StoredUtxo => {
  const { tapTree, forfeitTapLeafScript, proofTapLeafScript, intentTapLeafScript, extraWitness, ...rest } = u;
  const proof = proofTapLeafScript ?? intentTapLeafScript ?? forfeitTapLeafScript;
  return {
    ...rest,
    tapTree: hex.encode(tapTree),
    forfeitTapLeafScript: serializeTapLeaf(forfeitTapLeafScript),
    proofTapLeafScript: serializeTapLeaf(proof),
    extraWitness: extraWitness?.map((w) => hex.encode(w)),
  };
};

export const serializeTransaction = (t: ArkTransaction) => ({
  ...t,
  assets: t.assets?.map(serializeAsset),
});

export const deserializeVtxo = (o: StoredVtxo): ExtendedVirtualCoin => {
  const { createdAt, expiresAt, tapTree, forfeitTapLeafScript, proofTapLeafScript, extraWitness, assets, ...rest } = o;
  return {
    ...rest,
    createdAt: new Date(createdAt),
    ...(expiresAt !== undefined ? { expiresAt: new Date(expiresAt) } : {}),
    tapTree: hex.decode(tapTree),
    forfeitTapLeafScript: deserializeTapLeaf(forfeitTapLeafScript),
    proofTapLeafScript: deserializeTapLeaf(proofTapLeafScript),
    extraWitness: extraWitness?.map((w) => hex.decode(w)),
    assets: assets?.map(deserializeAsset),
  } as ExtendedVirtualCoin;
};

export const deserializeUtxo = (o: StoredUtxo): ExtendedCoin => {
  const { tapTree, forfeitTapLeafScript, proofTapLeafScript, extraWitness, ...rest } = o;
  return {
    ...rest,
    tapTree: hex.decode(tapTree),
    forfeitTapLeafScript: deserializeTapLeaf(forfeitTapLeafScript),
    proofTapLeafScript: deserializeTapLeaf(proofTapLeafScript),
    extraWitness: extraWitness?.map((w) => hex.decode(w)),
  } as ExtendedCoin;
};

export const deserializeTransaction = (o: ArkTransaction & { assets?: StoredAsset[] }) => ({
  ...o,
  assets: o.assets?.map(deserializeAsset),
});

/** Coerce legacy plain-JSON Uint8Array (numeric-key object) into bytes. */
export const coerceUint8Array = (value: unknown): Uint8Array | undefined => {
  if (value instanceof Uint8Array) return value;
  if (typeof value === 'string') {
    try {
      return hexToBytes(value);
    } catch {
      return undefined;
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;

  const record = value as Record<string, number>;
  const indices = Object.keys(record)
    .filter((k) => /^\d+$/.test(k))
    .map(Number)
    .sort((a, b) => a - b);
  if (indices.length === 0) return undefined;

  return Uint8Array.from(indices.map((i) => record[String(i)]));
};

const isStoredTapLeaf = (value: unknown): value is StoredTapLeaf =>
  !!value && typeof value === 'object' && typeof (value as StoredTapLeaf).cb === 'string' && typeof (value as StoredTapLeaf).s === 'string';

/** Accept both the stored `{cb, s}` shape and the pre-fix plain-JSON tuple. */
const coerceTapLeaf = (value: unknown): StoredTapLeaf | undefined => {
  if (isStoredTapLeaf(value)) return value;
  if (!Array.isArray(value) || value.length !== 2) return undefined;

  const scriptBytes = coerceUint8Array(value[1]);
  const cb = value[0];
  if (!scriptBytes || !cb || typeof cb !== 'object' || !('internalKey' in cb)) return undefined;

  try {
    const internalKey = coerceUint8Array((cb as { internalKey: unknown }).internalKey);
    const merklePath = ((cb as { merklePath?: unknown[] }).merklePath ?? []).map((p) => coerceUint8Array(p)).filter((p): p is Uint8Array => !!p);
    if (!internalKey) return undefined;
    return serializeTapLeaf([{ version: (cb as { version?: number }).version ?? 192, internalKey, merklePath }, scriptBytes]);
  } catch {
    return undefined;
  }
};

/**
 * Map a 0.4 `virtualStatus` blob onto the flat 0.5 fields where it is unambiguous.
 * `batchExpiry` is deliberately not mapped: it conflated milliseconds with a block height,
 * and the one-time cache wipe re-fetches canonical facts from the indexer instead.
 */
const legacyFacts = (value: unknown): Partial<StoredVtxo> => {
  if (!value || typeof value !== 'object') return {};
  const status = value as { state?: string; commitmentTxIds?: unknown };
  const facts: Record<string, unknown> = {};
  if (status.state === 'swept') facts.isSwept = true;
  if (status.state === 'preconfirmed') facts.isPreconfirmed = true;
  if (status.state === 'spent') facts.isSpent = true;
  if (Array.isArray(status.commitmentTxIds)) facts.commitmentTxIds = status.commitmentTxIds;
  return facts as Partial<StoredVtxo>;
};

const coerceAssets = (value: unknown): StoredAsset[] | undefined =>
  Array.isArray(value)
    ? value.map((a) => {
        const asset = a as StoredAsset;
        return {
          assetId: asset.assetId,
          amount: typeof asset.amount === 'bigint' ? asset.amount.toString() : asset.amount,
        };
      })
    : undefined;

const coerceExtraWitness = (value: unknown): string[] | undefined =>
  Array.isArray(value)
    ? value
        .map((w) => {
          const bytes = coerceUint8Array(w);
          return bytes ? bytesToHex(bytes) : typeof w === 'string' ? w : undefined;
        })
        .filter((w): w is string => typeof w === 'string')
    : undefined;

/**
 * Best-effort conversion of pre-fix persisted coin rows (plain JSON) into the stored
 * shape the SDK deserializer expects. Returns undefined when the row is too corrupt.
 * Legacy `intentTapLeafScript` rows become `proofTapLeafScript`; `virtualStatus` rows
 * get their unambiguous flat facts back.
 */
export const coerceStoredVtxo = (raw: unknown): StoredVtxo | undefined => {
  if (!raw || typeof raw !== 'object') return undefined;
  const row = raw as Record<string, unknown>;

  const tapTreeBytes = coerceUint8Array(row.tapTree);
  if (!tapTreeBytes) return undefined;

  const forfeit = coerceTapLeaf(row.forfeitTapLeafScript);
  const proof = coerceTapLeaf(row.proofTapLeafScript) ?? coerceTapLeaf(row.intentTapLeafScript);
  if (!forfeit || !proof) return undefined;

  let createdAt: string | number;
  if (row.createdAt instanceof Date) createdAt = row.createdAt.getTime();
  else if (typeof row.createdAt === 'string' || typeof row.createdAt === 'number') createdAt = row.createdAt;
  else return undefined;

  const expiresAt = typeof row.expiresAt === 'string' || typeof row.expiresAt === 'number' ? row.expiresAt : undefined;

  const {
    createdAt: _createdAt,
    expiresAt: _expiresAt,
    tapTree: _tapTree,
    forfeitTapLeafScript: _forfeit,
    proofTapLeafScript: _proof,
    intentTapLeafScript: _intent,
    extraWitness: _extra,
    assets: _assets,
    virtualStatus: _virtualStatus,
    ...rest
  } = row;

  return {
    ...(rest as Omit<StoredVtxo, 'createdAt' | 'expiresAt' | 'tapTree' | 'forfeitTapLeafScript' | 'proofTapLeafScript' | 'extraWitness' | 'assets'>),
    ...legacyFacts(row.virtualStatus),
    createdAt,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    tapTree: bytesToHex(tapTreeBytes),
    forfeitTapLeafScript: forfeit,
    proofTapLeafScript: proof,
    extraWitness: coerceExtraWitness(row.extraWitness),
    assets: coerceAssets(row.assets),
  };
};

export const coerceStoredUtxo = (raw: unknown): StoredUtxo | undefined => {
  if (!raw || typeof raw !== 'object') return undefined;
  const row = raw as Record<string, unknown>;

  const tapTreeBytes = coerceUint8Array(row.tapTree);
  if (!tapTreeBytes) return undefined;

  const forfeit = coerceTapLeaf(row.forfeitTapLeafScript);
  const proof = coerceTapLeaf(row.proofTapLeafScript) ?? coerceTapLeaf(row.intentTapLeafScript);
  if (!forfeit || !proof) return undefined;

  const { tapTree: _tapTree, forfeitTapLeafScript: _forfeit, proofTapLeafScript: _proof, intentTapLeafScript: _intent, extraWitness: _extra, virtualStatus: _virtualStatus, ...rest } = row;

  return {
    ...(rest as Omit<StoredUtxo, 'tapTree' | 'forfeitTapLeafScript' | 'proofTapLeafScript' | 'extraWitness'>),
    tapTree: bytesToHex(tapTreeBytes),
    forfeitTapLeafScript: forfeit,
    proofTapLeafScript: proof,
    extraWitness: coerceExtraWitness(row.extraWitness),
  };
};

/** A row carrying 0.4 fields needs coercion even when its stored tap leaves look new. */
const hasLegacyFields = (row: object): boolean => 'virtualStatus' in row || 'intentTapLeafScript' in row;

export const parseStoredVtxoList = (raw: string): ExtendedVirtualCoin[] => {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) return [];

  const vtxos: ExtendedVirtualCoin[] = [];
  for (const entry of parsed) {
    try {
      const row = entry as Partial<StoredVtxo>;
      if (!hasLegacyFields(entry as object) && isStoredTapLeaf(row.forfeitTapLeafScript) && isStoredTapLeaf(row.proofTapLeafScript)) {
        vtxos.push(deserializeVtxo(row as StoredVtxo));
        continue;
      }
      const coerced = coerceStoredVtxo(entry);
      if (coerced) vtxos.push(deserializeVtxo(coerced));
    } catch (error) {
      console.warn('ARK storage: skipping corrupt vtxo row', (entry as { txid?: string })?.txid, error);
    }
  }
  return vtxos;
};

export const parseStoredUtxoList = (raw: string): ExtendedCoin[] => {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) return [];

  const utxos: ExtendedCoin[] = [];
  for (const entry of parsed) {
    try {
      const row = entry as Partial<StoredUtxo>;
      if (!hasLegacyFields(entry as object) && isStoredTapLeaf(row.forfeitTapLeafScript) && isStoredTapLeaf(row.proofTapLeafScript)) {
        utxos.push(deserializeUtxo(row as StoredUtxo));
        continue;
      }
      const coerced = coerceStoredUtxo(entry);
      if (coerced) utxos.push(deserializeUtxo(coerced));
    } catch (error) {
      console.warn('ARK storage: skipping corrupt utxo row', (entry as { txid?: string })?.txid, error);
    }
  }
  return utxos;
};

export const stringifyVtxoList = (vtxos: ExtendedVirtualCoin[]): string => JSON.stringify(vtxos.map(serializeVtxo));

export const stringifyUtxoList = (utxos: ExtendedCoin[]): string => JSON.stringify(utxos.map(serializeUtxo));

export const parseStoredTransactionList = (raw: string): ArkTransaction[] => {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) return [];

  const txs: ArkTransaction[] = [];
  for (const entry of parsed) {
    const row = entry as ArkTransaction & { assets?: StoredAsset[] };
    try {
      // downstream code addresses transactions by tx.key, so a row without one is unusable
      if (!row?.key || typeof row.key !== 'object' || Array.isArray(row.key)) {
        console.warn('ARK storage: skipping malformed transaction row');
        continue;
      }
      txs.push(deserializeTransaction(row));
    } catch (error) {
      console.warn('ARK storage: skipping corrupt transaction row', row?.key?.arkTxid, error);
    }
  }
  return txs;
};

export const stringifyTransactionList = (txs: ArkTransaction[]): string => JSON.stringify(txs.map(serializeTransaction));
