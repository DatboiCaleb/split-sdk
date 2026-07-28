import { describe, it, expect, vi } from "vitest";
import { NetworkPassphraseValidator } from "../NetworkPassphraseValidator";

// Mock the SorobanRpc server
vi.mock("@stellar/stellar-sdk", () => ({
  SorobanRpc: {
    Server: vi.fn().mockImplementation(() => ({
      getNetwork: vi.fn().mockResolvedValue({
        networkPassphrase: "Test SDF Network ; September 2015"
      })
    }))
  }
}));

describe("Network Logic", () => {
  it("detects mismatching passphrases", async () => {
    const result = await NetworkPassphraseValidator.validate(
      "Wrong Passphrase",
      "https://testnet.stellar.org"
    );
    expect(result.valid).toBe(false);
    expect(result.mismatch).toBe(true);
  });

  it("validates successful passphrase", async () => {
    const result = await NetworkPassphraseValidator.validate(
      "Test SDF Network ; September 2015",
      "https://testnet.stellar.org"
    );
    expect(result.valid).toBe(true);
  });
});
