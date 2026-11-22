// 完整备份加密 (2026-11-22 审查 H1)。
// 完整备份含所有账号的登录 Cookie、飞书 App Secret、订阅地址与节点凭据, 只能以加密形式落盘。
// 算法: scrypt 由密码派生 256 位密钥, AES-256-GCM 加密, 文件格式标识作为附加认证数据 (AAD)。
'use strict';

const crypto = require('crypto');

const FORMAT = 'muse-backup-encrypted';
const VERSION = 1;
const DEFAULT_KDF = { N: 1 << 15, r: 8, p: 1 };

function deriveKey(password, salt, params) {
  // scrypt 需要约 128 * N * r 字节内存, 给足余量避免 "memory limit exceeded"
  return crypto.scryptSync(String(password), salt, 32, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: 256 * params.N * params.r,
  });
}

function isEncryptedBackup(obj) {
  return !!(obj && typeof obj === 'object' && obj.format === FORMAT);
}

function encryptBackup(data, password) {
  if (typeof password !== 'string' || password.length === 0) throw new Error('缺少备份密码');
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(password, salt, DEFAULT_KDF);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(FORMAT));
  const plaintext = Buffer.from(JSON.stringify(data), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    format: FORMAT,
    version: VERSION,
    kdf: 'scrypt',
    kdfParams: { ...DEFAULT_KDF },
    cipher: 'aes-256-gcm',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: encrypted.toString('base64'),
  };
}

function decryptBackup(envelope, password) {
  if (!isEncryptedBackup(envelope)) throw new Error('不是加密备份文件');
  if (envelope.version !== VERSION || envelope.kdf !== 'scrypt' || envelope.cipher !== 'aes-256-gcm') {
    throw new Error('不支持的备份加密版本');
  }
  const kp = envelope.kdfParams || {};
  // 限制参数范围, 防止被篡改的文件用超大参数卡死应用
  const params = {
    N: Number.isInteger(kp.N) && kp.N >= 1024 && kp.N <= (1 << 20) && (kp.N & (kp.N - 1)) === 0 ? kp.N : null,
    r: Number.isInteger(kp.r) && kp.r >= 1 && kp.r <= 16 ? kp.r : null,
    p: Number.isInteger(kp.p) && kp.p >= 1 && kp.p <= 4 ? kp.p : null,
  };
  if (!params.N || !params.r || !params.p) throw new Error('备份加密参数无效');

  const salt = Buffer.from(String(envelope.salt || ''), 'base64');
  const iv = Buffer.from(String(envelope.iv || ''), 'base64');
  const tag = Buffer.from(String(envelope.tag || ''), 'base64');
  const data = Buffer.from(String(envelope.data || ''), 'base64');
  if (salt.length < 16 || iv.length !== 12 || tag.length !== 16) throw new Error('备份文件已损坏');

  const key = deriveKey(password, salt, params);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(FORMAT));
  decipher.setAuthTag(tag);
  let plaintext;
  try {
    plaintext = Buffer.concat([decipher.update(data), decipher.final()]);
  } catch (_) {
    const err = new Error('密码错误或备份文件已被修改');
    err.code = 'WRONG_PASSWORD';
    throw err;
  }
  return JSON.parse(plaintext.toString('utf8'));
}

module.exports = { isEncryptedBackup, encryptBackup, decryptBackup, BACKUP_FORMAT: FORMAT };
