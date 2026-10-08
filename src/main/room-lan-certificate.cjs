"use strict";

const crypto = require("node:crypto");
const { promisify } = require("node:util");
const generateKeyPair = promisify(crypto.generateKeyPair);

function der(tag, ...values) {
  const body = Buffer.concat(values), octets = [];
  let length = body.length;
  do { octets.unshift(length & 255); length >>>= 8; } while (length);
  const size = body.length < 128 ? Buffer.from([body.length]) : Buffer.from([128 | octets.length, ...octets]);
  return Buffer.concat([Buffer.from([tag]), size, body]);
}
function date(value) {
  return der(0x18, Buffer.from(value.toISOString().replace(/[-:]/g, "").replace("T", "").replace(/\.\d{3}Z$/, "Z")));
}

// A minimal X.509 self-signed identity, trusted only by the invitation's SHA-256
// fingerprint. Each game gets a new in-memory key; no openssl or disk key store.
async function createLanCertificate() {
  const { privateKey, publicKey } = await generateKeyPair("rsa", { modulusLength: 2048 });
  const algorithm = der(0x30, Buffer.from("06092a864886f70d01010b0500", "hex"));
  const name = der(0x30, der(0x31, der(0x30, Buffer.from("0603550403", "hex"), der(0x0c, Buffer.from("Roomillion LAN")))));
  const now = Date.now();
  const validity = der(0x30, date(new Date(now - 60000)), date(new Date(now + 7 * 86400000)));
  const serial = crypto.randomBytes(16); serial[0] &= 127; serial[0] |= 1;
  const body = der(0x30, der(0xa0, der(0x02, Buffer.from([2]))), der(0x02, serial), algorithm, name, validity, name,
    publicKey.export({ type: "spki", format: "der" }));
  const signature = crypto.sign("sha256", body, privateKey);
  const certificate = der(0x30, body, algorithm, der(0x03, Buffer.from([0]), signature));
  return { key: privateKey.export({ type: "pkcs8", format: "pem" }),
    cert: `-----BEGIN CERTIFICATE-----\n${certificate.toString("base64").match(/.{1,64}/g).join("\n")}\n-----END CERTIFICATE-----\n`,
    fingerprint: crypto.createHash("sha256").update(certificate).digest("hex") };
}
module.exports = { createLanCertificate };
