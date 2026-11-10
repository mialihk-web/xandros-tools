/*
 * Xandros 拍賣計算器 — 計算邏輯（純函數，冇 DOM）
 * 網頁（index.html）同測試（test-calc.mjs）共用呢個檔。
 * 平台費率有變：只改下面 FEES，唔使郁其他地方。
 * 設計文件：Xandros/docs/auction-calc-prp.md
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.XCalc = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const FEES = {
    verified: '2026-11-10',
    fxBuffer: 0.01,          // 匯率保守差額：買 ×1.01，賣 ×0.99
    ukVat: 0.20,
    catawiki: {
      currency: 'EUR',
      buyerPct: 0.09,        // 買家保障費 9%（已含 VAT，只按落槌價計）
      buyerFixed: 3,         // 每單 €3
      sellerPctUK: 0.125,
      sellerPctHKLow: 0.075, // HK 帳戶：成交價 ≤ €10,000 成個價 7.5%
      sellerPctHKHigh: 0.05, //          成交價 > €10,000 成個價 5%
      hkThreshold: 10000,
      // 賣家定額費（兩個帳戶都收）：[成交價下限, 定額費]，由高至低
      sellerFixedTiers: [[1000, 10], [500, 5], [300, 3], [150, 2], [2, 1], [0, 0]],
    },
    wa: {
      currency: 'GBP',
      buyerPct: 0.125,       // 買家佣金 12.5% + VAT（VAT 只收喺佣金）
      cardSurcharge: 0.03,   // 香港／外國信用卡 3%
      sellerPct: 0.05,       // 賣家佣金 5% + VAT
      listingPerBottle: 7,   // 上架費每支 £7 + VAT
      reservePerLot: 10,     // 保留價費每 lot £10 + VAT
      minReserve: 200,       // 保留價最低 £200
    },
    swa: {
      currency: 'GBP',
      buyerPct: 0.15,        // 買家佣金 15% + VAT
      sellerPct: 0,
      entryPerBottle: 8,     // 登記費每支 £8 + VAT
      reservePerLot: 10,     // 保留價費每 lot £10 + VAT
    },
    hkDuty: { band: 200, bandRate: 1.0, aboveRate: 0.10 }, // 首 HK$200 收 100%，超出 10%
    carryFees: [500, 750],   // 朋友帶返香港，每支 HK$
    // Catawiki 賣出運費預設（Mia 2026-11-10）：買家付（€，Catawiki 轉交）／賣方實際運費
    catawikiSellShipDefaults: {
      hk: { buyer: 50, actual: 650, cur: 'hkd' },  // 實際 HK$650
      uk: { buyer: 20, actual: 30, cur: 'alt' },   // 實際約 £30
    },
    defaultLitres: 0.7,
  };

  const PLATFORMS = ['catawiki', 'wa', 'swa'];

  /** 將輸入（可以有逗號、空格）轉做數字；轉唔到就 NaN */
  function num(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
    const s = String(v == null ? '' : v).replace(/[,\s，]/g, '');
    if (s === '') return NaN;
    const n = Number(s);
    return Number.isFinite(n) ? n : NaN;
  }
  const pos = v => { const n = num(v); return n > 0 ? n : 0; };
  const qtyOf = v => { const n = Math.floor(num(v)); return n >= 1 ? n : 1; };

  /** 香港烈酒稅（每支）。valueHKD = 該支酒價（港幣）；litres = 容量 */
  function hkDuty(valueHKD, litres) {
    const v = pos(valueHKD);
    if (v === 0) return 0;
    const L = pos(litres) || FEES.defaultLitres;
    const d = FEES.hkDuty;
    const f = p => Math.min(p, d.band) * d.bandRate + Math.max(p - d.band, 0) * d.aboveRate;
    if (L <= 1) return f(v);
    return f(v / L) * L; // 1 公升以上：先計每公升價值
  }

  /**
   * 買：全包成本
   * o = { hammer, qty, shipping(平台貨幣), rate(1 外幣 = ? 港元), buffer,
   *       dest: 'uk'|'hk'|'carry', duty, carryFee, vat, card, buyerFixed, litres }
   */
  function buyCost(p, o) {
    const cfg = FEES[p];
    const hammer = pos(o.hammer);
    const qty = qtyOf(o.qty);
    const shipping = pos(o.shipping);
    const buffer = Number.isFinite(num(o.buffer)) ? num(o.buffer) : FEES.fxBuffer;
    const rateEff = pos(o.rate) * (1 + buffer);

    let premiumPct = hammer * cfg.buyerPct;
    let premiumFixed = 0;
    let premiumVat = 0;
    if (p === 'catawiki') {
      const bf = num(o.buyerFixed);
      premiumFixed = bf >= 0 ? bf : cfg.buyerFixed;
    } else if (o.vat) {
      premiumVat = premiumPct * FEES.ukVat;
    }
    const premium = premiumPct + premiumFixed;
    const subtotalFx = hammer + premium + premiumVat + shipping;
    const surcharge = (p === 'wa' && o.card) ? subtotalFx * cfg.cardSurcharge : 0;
    const totalFx = subtotalFx + surcharge;
    const fxHKD = totalFx * rateEff;
    const dutyPerBottle = o.duty ? hkDuty(hammer * rateEff / qty, o.litres) : 0;
    const duty = dutyPerBottle * qty;
    const carry = o.dest === 'carry' ? qty * pos(o.carryFee) : 0;
    const totalHKD = fxHKD + duty + carry;

    return {
      hammer, qty, premiumPct, premiumFixed, premium, premiumVat, shipping,
      surcharge, totalFx, rateEff, fxHKD, duty, dutyPerBottle, carry, totalHKD,
    };
  }

  /** 買：由全包預算（港幣）計最高落槌價（整數，向下取）。預算唔夠就 null */
  function maxBid(p, o, budgetHKD) {
    const budget = pos(budgetHKD);
    if (budget === 0 || !(pos(o.rate) > 0)) return null;
    const cost = h => buyCost(p, Object.assign({}, o, { hammer: h })).totalHKD;
    if (cost(1) > budget) return null;
    let lo = 1;
    let hi = 2;
    while (cost(hi) <= budget) { lo = hi; hi *= 2; if (hi > 1e10) return null; }
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (cost(mid) <= budget) lo = mid; else hi = mid;
    }
    return lo;
  }

  function catawikiSellerFixed(hammer) {
    for (const [min, fee] of FEES.catawiki.sellerFixedTiers) if (hammer >= min) return fee;
    return 0;
  }

  /** 賣：平台扣數（平台貨幣） o = { qty, account: 'hk'|'uk', reserve } */
  function sellFees(p, hammerIn, o) {
    const cfg = FEES[p];
    const hammer = pos(hammerIn);
    const qty = qtyOf(o.qty);
    const r = { pct: 0, commission: 0, fixed: 0, listing: 0, reserveFee: 0, vat: 0, total: 0 };
    if (p === 'catawiki') {
      r.pct = o.account === 'hk'
        ? (hammer > cfg.hkThreshold ? cfg.sellerPctHKHigh : cfg.sellerPctHKLow)
        : cfg.sellerPctUK;
      r.commission = hammer * r.pct;
      r.fixed = catawikiSellerFixed(hammer);
    } else {
      r.pct = cfg.sellerPct;
      r.commission = hammer * cfg.sellerPct;
      r.listing = qty * (p === 'wa' ? cfg.listingPerBottle : cfg.entryPerBottle);
      r.reserveFee = o.reserve ? cfg.reservePerLot : 0;
      r.vat = (r.commission + r.listing + r.reserveFee) * FEES.ukVat;
    }
    r.total = r.commission + r.fixed + r.listing + r.reserveFee + r.vat;
    return r;
  }

  /**
   * 賣：實收
   * o = { hammer, qty, account, reserve, rate, buffer, cost,
   *       buyerShipping（只限 Catawiki：買家付、Catawiki 轉交嘅運費，平台貨幣；佣金唔計呢部分）,
   *       shipping（賣方實際運費）, shipCur: 'hkd' 港幣 | 'fx' 平台貨幣 | 'alt' 第三種貨幣（要俾 altRate） }
   */
  function sellNet(p, o) {
    const hammer = pos(o.hammer);
    const fees = sellFees(p, hammer, o);
    const buffer = Number.isFinite(num(o.buffer)) ? num(o.buffer) : FEES.fxBuffer;
    const buyerShipping = p === 'catawiki' ? pos(o.buyerShipping) : 0;
    const ship = pos(o.shipping);
    const shipFx = o.shipCur === 'fx' ? ship : 0;
    const shipAlt = o.shipCur === 'alt' ? ship : 0;
    const altRateEff = pos(o.altRate) * (1 + buffer); // 支出：當外幣貴 1%
    const shipAltHKD = shipAlt * altRateEff;
    const shipHKD = (o.shipCur === 'fx' || o.shipCur === 'alt') ? 0 : ship;
    const rateEff = pos(o.rate) * (1 - buffer);
    const netFx = hammer - fees.total + buyerShipping - shipFx;
    const netHKD = netFx * rateEff - shipHKD - shipAltHKD;
    const cost = pos(o.cost);
    const profit = cost > 0 ? netHKD - cost : null;
    const profitPct = cost > 0 ? profit / cost : null;
    return { hammer, fees, buyerShipping, shipFx, shipHKD, shipAlt, altRateEff, shipAltHKD, rateEff, netFx, netHKD, cost, profit, profitPct };
  }

  /** 計底價時要分段處理嘅起點（段內實收隨成交價上升） */
  function segmentStarts(p, o) {
    if (p !== 'catawiki') return [1];
    const s = FEES.catawiki.sellerFixedTiers.map(t => t[0]).filter(m => m >= 1);
    if (!s.includes(1)) s.push(1);
    if (o.account === 'hk') s.push(FEES.catawiki.hkThreshold + 1);
    return Array.from(new Set(s)).sort((a, b) => a - b);
  }

  /**
   * 賣：最低底價（整數，向上取）。
   * 定義：設呢個底價之後，任何 ≥ 底價嘅成交都達到目標淨收。
   * 所以會自動避開 Catawiki 定額費跳級位同 HK 帳戶 €10,000 斷層。
   */
  function minPrice(p, o, targetHKD) {
    const target = pos(targetHKD);
    if (target === 0 || !(pos(o.rate) > 0)) return null;
    const net = h => sellNet(p, Object.assign({}, o, { hammer: h })).netHKD;
    const ok = h => net(h) >= target - 1e-9;
    const firstOk = (lo, hi) => { // 段內單調：搵 [lo, hi] 第一個達標（已知 hi 達標）
      if (ok(lo)) return lo;
      let L = lo, H = hi;
      while (H - L > 1) { const m = Math.floor((L + H) / 2); if (ok(m)) H = m; else L = m; }
      return H;
    };
    const starts = segmentStarts(p, o);
    const last = starts[starts.length - 1];
    let hi = last;
    while (!ok(hi)) { hi *= 2; if (hi > 1e10) return null; }
    let ans = firstOk(last, hi);
    if (ans > last) return ans;
    for (let i = starts.length - 2; i >= 0; i--) {
      const s = starts[i];
      const e = starts[i + 1] - 1;
      if (!ok(e)) return ans;
      ans = firstOk(s, e);
      if (ans > s) return ans;
    }
    return ans;
  }

  /** Catawiki HK 帳戶：成交價喺 €9,000–10,000，過 €10,000 實收會多幾多（歐元） */
  function catawikiCliffTip(o) {
    const h = pos(o.hammer);
    if (o.account !== 'hk' || h < 9000 || h > FEES.catawiki.hkThreshold) return null;
    const alt = FEES.catawiki.hkThreshold + 1;
    const now = sellNet('catawiki', o).netFx;
    const then = sellNet('catawiki', Object.assign({}, o, { hammer: alt })).netFx;
    return then > now ? { alt, gainFx: then - now } : null;
  }

  return {
    FEES, PLATFORMS, num, hkDuty, buyCost, maxBid, sellFees, sellNet,
    minPrice, catawikiSellerFixed, catawikiCliffTip, segmentStarts,
  };
});
