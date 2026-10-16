/**
 * ============================================================
 * 签名抽象层（M2）
 * ------------------------------------------------------------
 * 每条施力输入都要被发送方签名，作为「不可伪造的证据」。
 * 结算时把全量签名输入提交，谁都无法伪造对方操作（无对方私钥）。
 *
 * 本文件提供：
 *   1. createMockSigner —— 自测用（确定性假签名，验证 rollback 逻辑）
 *   2. 真实版：用 ethers.js personal_sign（见 README，前端注入 signer）
 * ============================================================
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./protocol.js"));
  } else {
    root.Signer = factory(root.Protocol);
  }
})(typeof self !== "undefined" ? self : this, function (Protocol) {
  "use strict";

  /**
   * 自测用 mock signer：签名 = "mock:" + digest + ":" + secret。
   * 对称、确定性，仅用于验证 rollback 确定性一致；不具备真实防伪能力。
   * @param {string} secretHex 模拟私钥（任意 hex 字符串）
   */
  function createMockSigner(secretHex) {
    var address = "0x" + secretHex.toLowerCase();
    return {
      address: address,
      secret: secretHex,
      signInput: function (ev) {
        var d = Protocol.inputDigest(ev);
        return "mock:" + d + ":" + secretHex.toLowerCase();
      },
      verifyInput: function (ev) {
        return ev.signature === "mock:" + Protocol.inputDigest(ev) + ":" + secretHex.toLowerCase();
      }
    };
  }

  /**
   * 真实签名（ethers.js）——在前端这样用：
   *
   *   async function signInputEthers(signer, ev) {
   *     const digest = Protocol.inputDigest(ev); // 正式版换成 keccak256
   *     const msgBytes = ethers.getBytes(digest);
   *     return await signer.signMessage(msgBytes); // EIP-191 personal_sign
   *   }
   *   function verifyInputEthers(ev, expectedAddress) {
   *     const digest = Protocol.inputDigest(ev);
   *     const recovered = ethers.verifyMessage(ethers.getBytes(digest), ev.signature);
   *     return recovered.toLowerCase() === expectedAddress.toLowerCase();
   *   }
   *
   * 这里不 require ethers（避免自测依赖），由前端注入。
   */
  return {
    createMockSigner: createMockSigner
  };
});
