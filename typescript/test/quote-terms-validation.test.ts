import { secp256k1 } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { describe, expect, it } from 'vitest'
import {
  contentHashesPriceSatoshis,
  decodeFileQuoteTerms,
  encodeFileQuoteTerms,
  validateFileQuoteTerms,
  verifyContentPayloads,
  type FileQuoteTerms
} from '../src/index.js'

const buyerPublicKey = secp256k1.getPublicKey(new Uint8Array(32).fill(0xb1), true)

function baseTerms (overrides: Partial<FileQuoteTerms> = {}): FileQuoteTerms {
  return {
    seedHash: new Uint8Array(32).fill(0x11),
    buyerPublicKey: buyerPublicKey.slice(),
    seedPriceSatoshis: 100n,
    fullBlockPriceSatoshis: 1000n,
    tailPriceSatoshis: 15n,
    fileSizeBytes: 4096n,
    quoteExpiresAtUnixSeconds: 2000000000n,
    supportedArbiterPublicKeys: [],
    recommendedFilename: 'file.bin',
    maxBlocksPerBatch: 64,
    mediaType: 'application/octet-stream',
    ...overrides
  }
}

/** 两个各 100 字节的块：哈希正确，但长度不符合固定尾块模型。 */
function twoShortBlocksFixture (): { seed: Uint8Array, seedHash: Uint8Array, blocks: Uint8Array[] } {
  const blocks = [new Uint8Array(100).fill(7), new Uint8Array(100).fill(9)]
  const seed = new Uint8Array(64)
  seed.set(sha256(blocks[0]!), 0)
  seed.set(sha256(blocks[1]!), 32)
  return { seed, seedHash: sha256(seed), blocks }
}

describe('报价尾价校验', () => {
  it('拒绝负数尾价', () => {
    expect(() => validateFileQuoteTerms(baseTerms({ tailPriceSatoshis: -1n }))).toThrowError(expect.objectContaining({ field: 'tail_price_satoshis' }))
  })

  it('拒绝越界尾价', () => {
    expect(() => validateFileQuoteTerms(baseTerms({ tailPriceSatoshis: 0x10000000000000000n }))).toThrowError(expect.objectContaining({ field: 'tail_price_satoshis' }))
  })

  it('接受零尾价', () => {
    expect(() => validateFileQuoteTerms(baseTerms({ tailPriceSatoshis: 0n }))).not.toThrow()
  })

  it('编码与解码同样拒绝负数尾价', () => {
    expect(() => encodeFileQuoteTerms(baseTerms({ tailPriceSatoshis: -1n }))).toThrowError(expect.objectContaining({ field: 'tail_price_satoshis' }))
  })
})

describe('声明长度不决定内容有效性', () => {
  it('fileSizeBytes 为 0（未知）时仍接受非空 Seed 报价', () => {
    expect(() => validateFileQuoteTerms(baseTerms({ fileSizeBytes: 0n }))).not.toThrow()
  })

  it('fileSizeBytes 错误时仍接受报价', () => {
    expect(() => validateFileQuoteTerms(baseTerms({ fileSizeBytes: 1n }))).not.toThrow()
  })

  it('往返编码保留未知长度', () => {
    const terms = baseTerms({ fileSizeBytes: 0n })
    expect(decodeFileQuoteTerms(encodeFileQuoteTerms(terms)).fileSizeBytes).toBe(0n)
  })

  it('两个短块：长度为零仍能验收并按 Seed 计价', async () => {
    const { seed, seedHash, blocks } = twoShortBlocksFixture()
    // 末项按尾价 15，其余按完整块价 1000。
    const terms = baseTerms({ seedHash, seedPriceSatoshis: 100n, fullBlockPriceSatoshis: 1000n, tailPriceSatoshis: 15n, fileSizeBytes: 0n })
    expect(() => validateFileQuoteTerms(terms)).not.toThrow()
    const hashes = blocks.map(block => sha256(block))
    const price = await contentHashesPriceSatoshis(terms, hashes, seed)
    expect(price).toBe(1000n + 15n)
    const payloads = await verifyContentPayloads(terms, hashes, blocks, seed)
    expect(payloads).toEqual(seed)
  })

  it('两个短块：错误长度同样能验收并按 Seed 计价', async () => {
    const { seed, seedHash, blocks } = twoShortBlocksFixture()
    const terms = baseTerms({ seedHash, seedPriceSatoshis: 100n, fullBlockPriceSatoshis: 1000n, tailPriceSatoshis: 15n, fileSizeBytes: 999999n })
    expect(() => validateFileQuoteTerms(terms)).not.toThrow()
    const hashes = blocks.map(block => sha256(block))
    const price = await contentHashesPriceSatoshis(terms, hashes, seed)
    expect(price).toBe(1000n + 15n)
  })
})
