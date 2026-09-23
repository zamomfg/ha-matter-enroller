// Matter QR ("MT:") payload decoder.
//
// Ported from the algorithm used by https://github.com/chill-uk/matter-qr-app
// and following the Matter/CHIP onboarding-payload spec: base38 decode the
// payload, bit-unpack the TLV header, then build the numeric manual pairing
// code (11 digits for the standard flow, 21 for a custom flow) with a trailing
// Verhoeff check digit.

const MATTER_BASE38_CHARSET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-.";
const STANDARD_COMMISSIONING_FLOW = 0;
const MATTER_LONG_TO_SHORT_DISCRIMINATOR_SHIFT = 8;

export function extractMatterQrPayload(text) {
  if (!text) return null;
  const trimmed = String(text).trim();
  const idx = trimmed.toUpperCase().indexOf("MT:");
  if (idx === -1) return null;
  return trimmed.slice(idx + 3).trim();
}

function decodeBase38(payload) {
  const bytes = [];
  let remainingCharacters = payload.length;
  let offset = 0;

  while (remainingCharacters > 0) {
    let charactersInChunk = 0;
    let bytesInChunk = 0;

    if (remainingCharacters >= 5) {
      charactersInChunk = 5;
      bytesInChunk = 3;
    } else if (remainingCharacters === 4) {
      charactersInChunk = 4;
      bytesInChunk = 2;
    } else if (remainingCharacters === 2) {
      charactersInChunk = 2;
      bytesInChunk = 1;
    } else {
      throw new Error("Invalid Matter base38 payload length.");
    }

    let value = 0;
    for (let index = charactersInChunk - 1; index >= 0; index -= 1) {
      const digit = MATTER_BASE38_CHARSET.indexOf(payload[offset + index]);
      if (digit === -1) {
        throw new Error("Invalid character in Matter base38 payload.");
      }
      value = value * 38 + digit;
    }

    for (let index = 0; index < bytesInChunk; index += 1) {
      bytes.push(value & 0xff);
      value = Math.floor(value / 256);
    }

    if (value > 0) {
      throw new Error("Invalid Matter base38 payload chunk.");
    }

    offset += charactersInChunk;
    remainingCharacters -= charactersInChunk;
  }

  return bytes;
}

function readBits(bytes, state, bitCount) {
  let value = 0;
  for (let offset = 0; offset < bitCount; offset += 1) {
    const bitIndex = state.index + offset;
    const byte = bytes[Math.floor(bitIndex / 8)];
    if (byte === undefined) {
      throw new Error("Matter payload ended unexpectedly.");
    }
    if (byte & (1 << bitIndex % 8)) {
      value += 2 ** offset;
    }
  }
  state.index += bitCount;
  return value;
}

export function parseMatterQrData(text) {
  const payload = extractMatterQrPayload(text);
  if (!payload) return null;

  const bytes = decodeBase38(payload);
  const state = { index: 0 };

  const version = readBits(bytes, state, 3);
  const vendorId = readBits(bytes, state, 16);
  const productId = readBits(bytes, state, 16);
  const commissioningFlow = readBits(bytes, state, 2);
  const rendezvousInformation = readBits(bytes, state, 8);
  const discriminator = readBits(bytes, state, 12);
  const setupPinCode = readBits(bytes, state, 27);

  return {
    version,
    vendorId,
    productId,
    commissioningFlow,
    rendezvousInformation,
    discriminator,
    setupPinCode,
  };
}

function decimalStringWithPadding(number, length) {
  return String(number).padStart(length, "0");
}

function computeVerhoeffCheckDigit(value) {
  const multiplicationTable = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
    [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
    [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
    [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
    [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
    [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
    [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
    [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
    [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
  ];
  const permutationTable = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
    [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
    [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
    [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
    [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
    [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
    [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
  ];
  const inverseTable = [0, 4, 3, 2, 1, 5, 6, 7, 8, 9];

  const digits = value
    .split("")
    .reverse()
    .map((d) => Number.parseInt(d, 10));
  let checksum = 0;

  for (let i = 0; i < digits.length; i += 1) {
    checksum =
      multiplicationTable[checksum][permutationTable[(i + 1) % 8][digits[i]]];
  }

  return String(inverseTable[checksum]);
}

// Build the numeric manual pairing code from the parsed payload.
export function manualPairingCodeFromPayload(payload) {
  const shortDiscriminator =
    (payload.discriminator >> MATTER_LONG_TO_SHORT_DISCRIMINATOR_SHIFT) & 0x0f;
  const hasVendorAndProduct =
    payload.commissioningFlow !== STANDARD_COMMISSIONING_FLOW;

  const chunk1 =
    ((shortDiscriminator >> 2) & 0x03) | (Number(hasVendorAndProduct) << 2);
  const chunk2 =
    (payload.setupPinCode & ((1 << 14) - 1)) | ((shortDiscriminator & 0x03) << 14);
  const chunk3 = (payload.setupPinCode >> 14) & ((1 << 13) - 1);

  let code =
    decimalStringWithPadding(chunk1, 1) +
    decimalStringWithPadding(chunk2, 5) +
    decimalStringWithPadding(chunk3, 4);

  if (hasVendorAndProduct) {
    code += decimalStringWithPadding(payload.vendorId, 5);
    code += decimalStringWithPadding(payload.productId, 5);
  }

  return code + computeVerhoeffCheckDigit(code);
}

export function generateManualPairingCode(text) {
  const payload = parseMatterQrData(text);
  if (!payload) return "";
  return manualPairingCodeFromPayload(payload);
}

// Normalize a manually-typed code (strip spaces/dashes) to digits only.
export function normalizeManualCode(text) {
  return String(text || "").replace(/[^0-9]/g, "");
}
