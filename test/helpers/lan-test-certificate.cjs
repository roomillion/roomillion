"use strict";

const crypto = require("node:crypto");
// Generate a disposable self-signed certificate in memory; no private key fixture
// or external openssl installation is required by Windows CI.
function certificate() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const der = (tag, ...values) => {
    const body = Buffer.concat(values);
    let length = body.length;
    const octets = [];
    do { octets.unshift(length & 255); length >>>= 8; } while (length);
    const size = body.length < 128 ? Buffer.from([body.length]) : Buffer.from([128 | octets.length, ...octets]);
    return Buffer.concat([Buffer.from([tag]), size, body]);
  };
  const algorithm = der(0x30, Buffer.from("06092a864886f70d01010b0500", "hex"));
  const name = der(0x30, der(0x31, der(0x30, Buffer.from("0603550403", "hex"), der(0x0c, Buffer.from("Roomillion test")))));
  const validity = der(0x30, der(0x17, Buffer.from("260101000000Z")), der(0x17, Buffer.from("360101000000Z")));
  const serial = crypto.randomBytes(16); serial[0] &= 127; serial[0] |= 1;
  const body = der(0x30, der(0xa0, der(0x02, Buffer.from([2]))), der(0x02, serial), algorithm, name, validity, name,
    publicKey.export({ type: "spki", format: "der" }));
  const signature = crypto.sign("sha256", body, privateKey);
  const cert = der(0x30, body, algorithm, der(0x03, Buffer.from([0]), signature));
  return { key: privateKey.export({ type: "pkcs8", format: "pem" }), cert: `-----BEGIN CERTIFICATE-----\n${cert.toString("base64").match(/.{1,64}/g).join("\n")}\n-----END CERTIFICATE-----\n`,
    fingerprint: crypto.createHash("sha256").update(cert).digest("hex") };
}
module.exports = { certificate };
