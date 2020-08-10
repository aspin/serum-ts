import { seq, struct } from 'buffer-layout';
import {
  publicKeyLayout,
  setLayoutDecoder,
  u128,
  u64,
  WideBits,
} from './layout';
import { SLAB_LAYOUT } from './slab';
import { DEX_PROGRAM_ID } from './instructions';
import BN from 'bn.js';

const ACCOUNT_FLAGS_LAYOUT = new WideBits();
ACCOUNT_FLAGS_LAYOUT.addBoolean('initialized');
ACCOUNT_FLAGS_LAYOUT.addBoolean('market');
ACCOUNT_FLAGS_LAYOUT.addBoolean('openOrders');
ACCOUNT_FLAGS_LAYOUT.addBoolean('requestQueue');
ACCOUNT_FLAGS_LAYOUT.addBoolean('eventQueue');
ACCOUNT_FLAGS_LAYOUT.addBoolean('bids');
ACCOUNT_FLAGS_LAYOUT.addBoolean('asks');

export function accountFlags(property = 'accountFlags') {
  return ACCOUNT_FLAGS_LAYOUT.replicate(property);
}

export const MARKET_STATE_LAYOUT = struct([
  accountFlags('accountFlags'),

  publicKeyLayout('ownAddress'),

  u64('vaultSignerNonce'),

  publicKeyLayout('baseMint'),
  publicKeyLayout('quoteMint'),

  publicKeyLayout('baseVault'),
  u64('baseDepositsTotal'),
  u64('baseFeesAccrued'),

  publicKeyLayout('quoteVault'),
  u64('quoteDepositsTotal'),
  u64('quoteFeesAccrued'),

  u64('quoteDustThreshold'),

  publicKeyLayout('requestQueue'),
  publicKeyLayout('eventQueue'),

  publicKeyLayout('bids'),
  publicKeyLayout('asks'),

  u64('baseLotSize'),
  u64('quoteLotSize'),
]);

export class Market {
  constructor(decoded) {
    if (!decoded.accountFlags.initialized || !decoded.accountFlags.market) {
      throw new Error('Invalid market state');
    }
    this._decoded = decoded;

    // TODO: populate these
    this._baseMintDecimals = 0;
    this._quoteMintDecimals = 0;
  }

  static decode(buffer) {
    return MARKET_STATE_LAYOUT.decode(buffer);
  }

  static async load(connection, address) {
    const { owner, data } = await connection.getAccountInfo(address);
    if (!owner.equals(DEX_PROGRAM_ID)) {
      throw new Error('Address not owned by program');
    }
    return MARKET_STATE_LAYOUT.decode(data);
    // TODO: also load mint account info
  }

  async loadBids(connection) {
    const { data } = await connection.getAccountInfo(this._decoded.bids);
    return Orderbook.decode(this, data);
  }

  async loadAsks(connection) {
    const { data } = await connection.getAccountInfo(this._decoded.asks);
    return Orderbook.decode(this, data);
  }

  priceBnToNumber(price) {
    return divideBnToNumber(
      price
        .mul(this._decoded.quoteLotSize)
        .mul(new BN(10).pow(this._baseMintDecimals)),
      this._decoded.baseLotSize.mul(new BN(10).pow(this._quoteMintDecimals)),
    );
  }

  baseSizeBnToNumber(size) {
    return divideBnToNumber(
      size.mul(this._decoded.baseLotSize),
      new BN(10).pow(this._baseMintDecimals),
    );
  }

  quoteSizeBnToNumber(size) {
    return divideBnToNumber(
      size.mul(this._decoded.quoteLotSize),
      new BN(10).pow(this._quoteMintDecimals),
    );
  }
}

setLayoutDecoder(MARKET_STATE_LAYOUT, (decoded) => new Market(decoded));

export const OPEN_ORDERS_LAYOUT = struct([
  accountFlags('accountFlags'),

  publicKeyLayout('market'),
  publicKeyLayout('owner'),

  // These are in native (i.e. not lot) units
  u64('baseTotal'),
  u64('baseFree'),
  u64('quoteTotal'),
  u64('quoteFree'),

  u128('freeSlotBits'),
  u128('isBidBits'),

  seq(u128(), 128, 'orders'),
]);

export class OpenOrders {}

export const ORDERBOOK_LAYOUT = struct([
  accountFlags('accountFlags'),
  SLAB_LAYOUT.replicate('slab'),
]);

export class Orderbook {
  constructor(market, accountFlags, slab) {
    if (!accountFlags.initialized || !(accountFlags.bids ^ accountFlags.asks)) {
      throw new Error('Invalid orderbook');
    }
    this.market = market;
    this.isBids = accountFlags.bids;
    this.slab = slab;
  }

  static decode(market, buffer) {
    const { accountFlags, slab } = ORDERBOOK_LAYOUT.decode(buffer);
    return new Orderbook(market, accountFlags, slab);
  }

  getLevels(depth) {
    const descending = this.isBids;
    const levels = []; // (price, size)
    for (const { key, quantity } of this.slab.items(descending)) {
      const price = getPriceFromKey(key);
      if (levels.length > 0 && levels[levels.length - 1][0].equals(price)) {
        levels[levels.length - 1].iadd(quantity);
      } else if (levels.length === depth) {
        break;
      } else {
        levels.push([price, quantity]);
      }
    }
    return levels.map(([price, size]) => [
      this.market.priceBnToNumber(price),
      this.market.baseSizeBnToNumber(size.mul(this.market.baseLotSize)),
    ]);
  }
}

function getPriceFromKey(key) {
  return key.ushrn(64);
}

function divideBnToNumber(numerator, denominator) {
  const quotient = numerator.div(denominator).toNumber();
  const rem = numerator.umod(denominator);
  const gcd = rem.gcd(denominator);
  return quotient + rem.div(gcd).toNumber() / denominator.div(gcd).toNumber();
}