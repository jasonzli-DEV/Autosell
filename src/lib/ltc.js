const bitcoin = require('bitcoinjs-lib');
const bip39 = require('bip39');
const { HDKey } = require('@scure/bip32');
const { ECPairFactory } = require('ecpair');
const ecc = require('tiny-secp256k1');

bitcoin.initEccLib(ecc);
const ECPair = ECPairFactory(ecc);

// Litecoin mainnet network parameters
const LITECOIN = {
  messagePrefix: '\x19Litecoin Signed Message:\n',
  bech32: 'ltc',
  bip32: {
    public: 0x019da462,
    private: 0x019d9cfe,
  },
  pubKeyHash: 0x30,
  scriptHash: 0x32,
  wif: 0xb0,
};

const FEE_SAT_PER_BYTE = 10;
const DUST_THRESHOLD_SAT = 546;
const BLOCKCYPHER_BASE = 'https://api.blockcypher.com/v1/ltc/main';
const API_DELAY_MS = 400; // conservative rate limiting

let _keyPair = null;
let _walletAddress = null;

function initWallet() {
  const seedPhrase = `${process.env.LTC_SEED_PHRASE || ''}`.trim();
  if (!seedPhrase) throw new Error('LTC_SEED_PHRASE is not set.');
  if (!bip39.validateMnemonic(seedPhrase)) throw new Error('LTC_SEED_PHRASE is not a valid BIP39 mnemonic.');

  const seed = bip39.mnemonicToSeedSync(seedPhrase);
  const hdkey = HDKey.fromMasterSeed(seed);
  // BIP44 path for Litecoin: m/44'/2'/0'/0/0
  const child = hdkey.derive("m/44'/2'/0'/0/0");

  const privateKey = Buffer.from(child.privateKey);
  _keyPair = ECPair.fromPrivateKey(privateKey, { network: LITECOIN });

  const { address } = bitcoin.payments.p2pkh({
    pubkey: _keyPair.publicKey,
    network: LITECOIN,
  });
  _walletAddress = address;

  return _walletAddress;
}

function getWalletAddress() {
  if (!_walletAddress) initWallet();
  return _walletAddress;
}

function validateLtcAddress(address) {
  try {
    bitcoin.address.toOutputScript(`${address || ''}`.trim(), LITECOIN);
    return true;
  } catch {
    return false;
  }
}

function tokenSuffix() {
  const t = process.env.BLOCKCYPHER_TOKEN;
  return t ? `?token=${t}` : '';
}

function tokenParam(hasQuery) {
  const t = process.env.BLOCKCYPHER_TOKEN;
  if (!t) return '';
  return `${hasQuery ? '&' : '?'}token=${t}`;
}

async function blockcypherGet(path) {
  const url = `${BLOCKCYPHER_BASE}${path}${tokenParam(path.includes('?'))}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`BlockCypher GET ${path} failed (${res.status}): ${body}`);
  }
  return res.json();
}

function estimateFee(numInputs, numOutputs) {
  return (148 * numInputs + 34 * numOutputs + 10) * FEE_SAT_PER_BYTE;
}

async function getWalletBalanceLtc() {
  const walletAddress = getWalletAddress();
  const utxoData = await blockcypherGet(`/addrs/${walletAddress}?unspentOnly=true`);
  const allUtxos = (utxoData.txrefs || []).filter(u => !u.spent && u.confirmations > 0);
  const totalSat = allUtxos.reduce((sum, u) => sum + u.value, 0);
  return totalSat / 1e8;
}

async function sendLtc(toAddress, ltcAmount) {
  if (!_keyPair) initWallet();

  const amountSat = Math.round(ltcAmount * 1e8);
  const walletAddress = _walletAddress;

  // Fetch unspent outputs
  const utxoData = await blockcypherGet(`/addrs/${walletAddress}?unspentOnly=true`);
  const allUtxos = (utxoData.txrefs || []).filter(u => !u.spent && u.confirmations > 0);

  if (!allUtxos.length) throw new Error('Bot LTC wallet has no confirmed UTXOs.');

  // Select UTXOs (largest first) until we cover amount + estimated fee
  allUtxos.sort((a, b) => b.value - a.value);
  const selected = [];
  let totalIn = 0;
  for (const utxo of allUtxos) {
    selected.push(utxo);
    totalIn += utxo.value;
    if (totalIn >= amountSat + estimateFee(selected.length, 2)) break;
  }

  const fee = estimateFee(selected.length, 2);
  const change = totalIn - amountSat - fee;

  if (change < 0) {
    const have = (totalIn / 1e8).toFixed(8);
    const need = ((amountSat + fee) / 1e8).toFixed(8);
    throw new Error(`Insufficient wallet funds. Need ${need} LTC, have ${have} LTC.`);
  }

  // Build PSBT — fetch raw tx for each input (required for P2PKH nonWitnessUtxo)
  const psbt = new bitcoin.Psbt({ network: LITECOIN });

  for (const utxo of selected) {
    await new Promise(r => setTimeout(r, API_DELAY_MS));
    const rawTxData = await blockcypherGet(`/txs/${utxo.tx_hash}?includeHex=true`);
    if (!rawTxData.hex) throw new Error(`No raw hex for tx ${utxo.tx_hash}.`);

    psbt.addInput({
      hash: utxo.tx_hash,
      index: utxo.tx_output_n,
      nonWitnessUtxo: Buffer.from(rawTxData.hex, 'hex'),
    });
  }

  psbt.addOutput({ address: toAddress, value: amountSat });

  if (change > DUST_THRESHOLD_SAT) {
    psbt.addOutput({ address: walletAddress, value: change });
  }

  psbt.signAllInputs(_keyPair);
  psbt.finalizeAllInputs();
  const rawTx = psbt.extractTransaction().toHex();

  // Broadcast
  await new Promise(r => setTimeout(r, API_DELAY_MS));
  const broadcastRes = await fetch(`${BLOCKCYPHER_BASE}/txs/push${tokenSuffix()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tx: rawTx }),
  });

  const result = await broadcastRes.json();
  if (!broadcastRes.ok) {
    throw new Error(`Broadcast failed: ${result.error || JSON.stringify(result.errors || result)}`);
  }

  return result.tx.hash;
}

module.exports = { initWallet, getWalletAddress, validateLtcAddress, sendLtc, getWalletBalanceLtc };
