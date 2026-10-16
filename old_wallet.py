#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
old_wallet.py — 生成“老式”比特币钱包并用于签名/验签测试（纯标准库，零第三方依赖）

这是一个本地离线工具，所有密钥均为随机生成，仅用于项目测试，切勿存入真实资金。

功能：
  1. 生成 secp256k1 密钥对（secrets 模块的安全随机源）
  2. 派生老式地址（Legacy P2PKH, 1 开头）：
     - 非压缩公钥版本（最老的钱包默认格式）
     - 压缩公钥版本
  3. WIF（Wallet Import Format）私钥编码 / 解码（老格式：5 / K / L 开头）
  4. ECDSA 签名 / 验签（RFC6979 确定性 nonce + low-s）
  5. Bitcoin "signmessage" 消息签名 / 验证（可恢复签名，与 Bitcoin Core 兼容）

用法示例：
  python old_wallet.py selftest                      # 自检（用已知标准测试向量）
  python old_wallet.py generate -n 5                 # 生成 5 个老钱包
  python old_wallet.py derive <WIF或私钥hex>          # 从已知私钥推导地址
  python old_wallet.py sign <WIF> "要签名的消息"        # 对消息签名（输出 base64）
  python old_wallet.py verify <地址> <base64签名> "消息" # 验证消息签名
"""

import argparse
import base64
import hashlib
import hmac
import secrets
import sys

# ---------------------------------------------------------------------------
# secp256k1 曲线参数
# ---------------------------------------------------------------------------
P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F  # 域素数
N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141  # 群阶
A = 0
B = 7
GX = 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798
GY = 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8
G = (GX, GY)

BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def inv(a, m):
    """模逆。Python 3.8+ 支持 pow(a, -1, m)。"""
    return pow(a, -1, m)


# ---------------------------------------------------------------------------
# 椭圆曲线点运算（Jacobian 未用，直接仿射坐标；仅用于演示与测试，性能足够）
# ---------------------------------------------------------------------------
def point_add(p1, p2):
    if p1 is None:
        return p2
    if p2 is None:
        return p1
    x1, y1 = p1
    x2, y2 = p2
    if x1 == x2:
        if (y1 + y2) % P == 0:
            return None  # 无穷远点
        lam = (3 * x1 * x1) * inv(2 * y1, P) % P
    else:
        lam = (y2 - y1) * inv(x2 - x1, P) % P
    x3 = (lam * lam - x1 - x2) % P
    y3 = (lam * (x1 - x3) - y1) % P
    return (x3, y3)


def scalar_mult(k, pt):
    """双倍-相加法标量乘法。"""
    result = None
    addend = pt
    k = k % N
    while k:
        if k & 1:
            result = point_add(result, addend)
        addend = point_add(addend, addend)
        k >>= 1
    return result


def on_curve(pt):
    if pt is None:
        return True
    x, y = pt
    return (y * y - (x * x * x + B)) % P == 0


# ---------------------------------------------------------------------------
# 密钥、公钥、地址、WIF
# ---------------------------------------------------------------------------
def generate_key():
    priv = secrets.randbelow(N - 1) + 1
    return priv


def pubkey_from_priv(priv, compressed=False):
    pt = scalar_mult(priv, G)
    x, y = pt
    if compressed:
        prefix = b"\x02" if (y & 1) == 0 else b"\x03"
        return prefix + x.to_bytes(32, "big")
    return b"\x04" + x.to_bytes(32, "big") + y.to_bytes(32, "big")


def hash160(data):
    return hashlib.new("ripemd160", hashlib.sha256(data).digest()).digest()


def base58_encode(b):
    n = int.from_bytes(b, "big")
    s = ""
    while n:
        n, r = divmod(n, 58)
        s = BASE58_ALPHABET[r] + s
    pad = 0
    for byte in b:
        if byte == 0:
            pad += 1
        else:
            break
    return "1" * pad + (s or "")


def base58_decode(s):
    n = 0
    for c in s:
        n = n * 58 + BASE58_ALPHABET.index(c)
    pad = 0
    for c in s:
        if c == "1":
            pad += 1
        else:
            break
    return b"\x00" * pad + (n.to_bytes((n.bit_length() + 7) // 8, "big") if n else b"")


def base58check_encode(payload):
    checksum = hashlib.sha256(hashlib.sha256(payload).digest()).digest()[:4]
    return base58_encode(payload + checksum)


def base58check_decode(s):
    raw = base58_decode(s)
    payload, checksum = raw[:-4], raw[-4:]
    if hashlib.sha256(hashlib.sha256(payload).digest()).digest()[:4] != checksum:
        raise ValueError("base58check 校验失败")
    return payload


def p2pkh_address(pubkey_bytes):
    return base58check_encode(b"\x00" + hash160(pubkey_bytes))


def priv_to_wif(priv, compressed=False):
    payload = b"\x80" + priv.to_bytes(32, "big")
    if compressed:
        payload += b"\x01"
    return base58check_encode(payload)


def wif_to_priv(wif):
    payload = base58check_decode(wif)
    if payload[0] != 0x80:
        raise ValueError("不是比特币主网 WIF")
    if len(payload) == 33:  # 非压缩
        priv = int.from_bytes(payload[1:], "big")
        compressed = False
    elif len(payload) == 34 and payload[-1] == 0x01:  # 压缩
        priv = int.from_bytes(payload[1:-1], "big")
        compressed = True
    else:
        raise ValueError("WIF 长度非法")
    if not (1 <= priv < N):
        raise ValueError("私钥超出范围")
    return priv, compressed


# ---------------------------------------------------------------------------
# ECDSA（RFC6979 确定性 nonce，low-s）
# ---------------------------------------------------------------------------
def rfc6979_k(priv, z_bytes):
    x = priv.to_bytes(32, "big")
    h1 = z_bytes
    v = b"\x01" * 32
    k = b"\x00" * 32
    k = hmac.new(k, v + b"\x00" + x + h1, hashlib.sha256).digest()
    v = hmac.new(k, v, hashlib.sha256).digest()
    k = hmac.new(k, v + b"\x01" + x + h1, hashlib.sha256).digest()
    v = hmac.new(k, v, hashlib.sha256).digest()
    while True:
        v = hmac.new(k, v, hashlib.sha256).digest()
        candidate = int.from_bytes(v, "big")
        if 1 <= candidate < N:
            return candidate
        k = hmac.new(k, v + b"\x00", hashlib.sha256).digest()
        v = hmac.new(k, v, hashlib.sha256).digest()


def ecdsa_sign(priv, z_bytes):
    """对 32 字节摘要签名，返回 (r, s)。"""
    z = int.from_bytes(z_bytes, "big")
    k = rfc6979_k(priv, z_bytes)
    R = scalar_mult(k, G)
    r = R[0] % N
    s = (inv(k, N) * (z + r * priv)) % N
    if s > N // 2:  # low-s 规范化
        s = N - s
    return r, s


def ecdsa_verify(pub_pt, z_bytes, r, s):
    if not (1 <= r < N and 1 <= s < N):
        return False
    z = int.from_bytes(z_bytes, "big")
    w = inv(s, N)
    u1 = z * w % N
    u2 = r * w % N
    P = point_add(scalar_mult(u1, G), scalar_mult(u2, pub_pt))
    if P is None:
        return False
    return P[0] % N == r


# ---------------------------------------------------------------------------
# Bitcoin signmessage（可恢复签名）
# ---------------------------------------------------------------------------
def varint(n):
    if n < 0xFD:
        return bytes([n])
    if n <= 0xFFFF:
        return b"\xFD" + n.to_bytes(2, "little")
    if n <= 0xFFFFFFFF:
        return b"\xFE" + n.to_bytes(4, "little")
    return b"\xFF" + n.to_bytes(8, "little")


def message_hash(message):
    if isinstance(message, str):
        message = message.encode("utf-8")
    prefix = b"\x18Bitcoin Signed Message:\n" + varint(len(message)) + message
    return hashlib.sha256(hashlib.sha256(prefix).digest()).digest()


def sign_message(priv, message, compressed=True):
    z_bytes = message_hash(message)
    z = int.from_bytes(z_bytes, "big")
    k = rfc6979_k(priv, z_bytes)
    R = scalar_mult(k, G)
    r = R[0] % N
    s = (inv(k, N) * (z + r * priv)) % N
    if s > N // 2:
        s = N - s
    recid = (R[1] & 1) | (2 if R[0] >= N else 0)
    header = 27 + recid + (4 if compressed else 0)
    sig = bytes([header]) + r.to_bytes(32, "big") + s.to_bytes(32, "big")
    return base64.b64encode(sig).decode("ascii")


def _sqrt_mod_p(x):
    """secp256k1 中 p ≡ 3 (mod 4)，故 sqrt = x^((p+1)/4)。"""
    return pow(x, (P + 1) // 4, P)


def recover_pubkey(r, s, z_bytes, header):
    if not (1 <= r < N and 1 <= s < N):
        raise ValueError("r/s 超出范围")
    if header < 27 or header > 34:
        raise ValueError("签名头字节非法")
    compressed = header >= 31
    recid = (header - 27) & 3
    x = r + (N if (recid & 2) else 0)
    if x >= P:
        raise ValueError("无法恢复：x >= P")
    y = _sqrt_mod_p((x * x * x + B) % P)
    if (y & 1) != (recid & 1):
        y = P - y
    R = (x, y)
    z = int.from_bytes(z_bytes, "big")
    rinv = inv(r, N)
    sR = scalar_mult(s, R)
    zG = scalar_mult(z, G)
    neg_zG = (zG[0], P - zG[1])
    Q = scalar_mult(rinv, point_add(sR, neg_zG))
    if not on_curve(Q):
        raise ValueError("恢复的公钥不在曲线上")
    return Q, compressed


def verify_message(address, sig_b64, message):
    sig = base64.b64decode(sig_b64)
    if len(sig) != 65:
        raise ValueError("签名长度非法")
    header = sig[0]
    r = int.from_bytes(sig[1:33], "big")
    s = int.from_bytes(sig[33:65], "big")
    z_bytes = message_hash(message)
    Q, compressed = recover_pubkey(r, s, z_bytes, header)
    x, y = Q
    if compressed:
        pubkey_bytes = (b"\x02" if (y & 1) == 0 else b"\x03") + x.to_bytes(32, "big")
    else:
        pubkey_bytes = b"\x04" + x.to_bytes(32, "big") + y.to_bytes(32, "big")
    recovered_addr = p2pkh_address(pubkey_bytes)
    return recovered_addr == address, recovered_addr


# ---------------------------------------------------------------------------
# 展示 / CLI
# ---------------------------------------------------------------------------
def wallet_info(priv, compressed):
    pub = pubkey_from_priv(priv, compressed=compressed)
    addr = p2pkh_address(pub)
    wif = priv_to_wif(priv, compressed=compressed)
    pub_hex = pub.hex()
    return {
        "priv_hex": priv.to_bytes(32, "big").hex(),
        "wif": wif,
        "address": addr,
        "pubkey": pub_hex,
        "compressed": compressed,
    }


def print_wallet(priv):
    print("=" * 78)
    print(f"私钥 (hex)        : {priv.to_bytes(32, 'big').hex()}")
    print("-" * 78)
    for compressed in (False, True):
        info = wallet_info(priv, compressed)
        kind = "压缩公钥" if compressed else "非压缩公钥(老格式)"
        print(f"[{kind}]")
        print(f"  公钥 (hex) : {info['pubkey']}")
        print(f"  地址       : {info['address']}")
        print(f"  WIF 私钥   : {info['wif']}")
    print("=" * 78)


def do_selftest():
    """用已知标准测试向量自检实现正确性。"""
    # 私钥 1 的公钥 = G
    assert pubkey_from_priv(1, compressed=True).hex() == (
        "0279BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798"
    ).lower(), "压缩公钥(priv=1) 不符"
    assert pubkey_from_priv(1, compressed=False).hex() == (
        "0479BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798"
        "483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8"
    ).lower(), "非压缩公钥(priv=1) 不符"

    assert p2pkh_address(pubkey_from_priv(1, False)) == "1EHNa6Q4Jz2uvNExL497mE43ikXhwF6kZm", "P2PKH 地址(非压缩) 不符"
    assert p2pkh_address(pubkey_from_priv(1, True)) == "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH", "P2PKH 地址(压缩) 不符"

    assert priv_to_wif(1, False) == "5HpHagT65TZzG1PH3CSu63k8DbpvD8s5ip4nEB3kEsreAnchuDf", "WIF(非压缩) 不符"
    assert priv_to_wif(1, True) == "KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn", "WIF(压缩) 不符"

    # ECDSA 自签自验
    priv = generate_key()
    msg = b"old-wallet-selftest"
    z_bytes = hashlib.sha256(msg).digest()
    r, s = ecdsa_sign(priv, z_bytes)
    pub_pt = scalar_mult(priv, G)
    assert ecdsa_verify(pub_pt, z_bytes, r, s), "ECDSA 自验失败"

    # 消息签名 / 验证往返
    for compressed in (False, True):
        wif = priv_to_wif(priv, compressed)
        addr = p2pkh_address(pubkey_from_priv(priv, compressed))
        sig = sign_message(priv, "你好，老钱包", compressed)
        ok, recovered = verify_message(addr, sig, "你好，老钱包")
        assert ok, "消息签名验证失败"
        assert recovered == addr, "恢复地址不符"

    # WIF 往返
    p2, c2 = wif_to_priv(priv_to_wif(priv, True))
    assert p2 == priv and c2 is True, "WIF 往返(压缩) 不符"
    p3, c3 = wif_to_priv(priv_to_wif(priv, False))
    assert p3 == priv and c3 is False, "WIF 往返(非压缩) 不符"

    print("✅ 自检通过：secp256k1 / P2PKH / WIF / ECDSA / signmessage 全部正确。")


def main():
    parser = argparse.ArgumentParser(description="老式比特币钱包生成与签名测试工具")
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("selftest", help="自检（标准测试向量）")

    g = sub.add_parser("generate", help="生成随机老钱包")
    g.add_argument("-n", type=int, default=1, help="生成数量")

    d = sub.add_parser("derive", help="从已知 WIF 或私钥 hex 推导地址")
    d.add_argument("key", help="WIF 或 64 位 hex 私钥")

    s = sub.add_parser("sign", help="用 WIF 对消息签名")
    s.add_argument("wif", help="WIF 私钥")
    s.add_argument("message", help="要签名的消息")

    v = sub.add_parser("verify", help="验证消息签名")
    v.add_argument("address", help="地址")
    v.add_argument("sig", help="base64 签名")
    v.add_argument("message", help="原始消息")

    args = parser.parse_args()

    if args.cmd == "selftest":
        do_selftest()
    elif args.cmd == "generate":
        for i in range(args.n):
            print_wallet(generate_key())
    elif args.cmd == "derive":
        key = args.key.strip()
        if key.startswith(("5", "K", "L")):
            priv, compressed = wif_to_priv(key)
        elif len(key) == 64:
            priv = int(key, 16)
            compressed = True
        else:
            sys.exit("无法识别密钥：请输入 WIF 或 64 位 hex 私钥")
        print_wallet(priv)
    elif args.cmd == "sign":
        priv, compressed = wif_to_priv(args.wif)
        addr = p2pkh_address(pubkey_from_priv(priv, compressed))
        sig = sign_message(priv, args.message, compressed)
        print(f"地址       : {addr}")
        print(f"base64 签名 : {sig}")
    elif args.cmd == "verify":
        ok, recovered = verify_message(args.address, args.sig, args.message)
        if ok:
            print(f"✅ 签名有效，地址匹配：{args.address}")
        else:
            print(f"❌ 签名无效（恢复地址：{recovered}，期望：{args.address}）")
            sys.exit(1)


if __name__ == "__main__":
    main()
