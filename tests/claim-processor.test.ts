import { describe, expect, it, vi, beforeEach } from "vitest";

// Interfaces for type safety
interface ClarityResponse<T> {
  ok: boolean;
  value: T | number; // number for error codes
}

interface ClaimRecord {
  farmerId: string;
  status: string;
  amount: number;
  timestamp: number;
  period: number;
  metadata: Buffer;
  verifierNotes: string | null;
}

interface FarmerClaimRecord {
  lastClaimBlock: number;
  claimCount: number;
  totalAmount: number;
  blacklisted: boolean;
}

interface ClaimProofRecord {
  proofHash: Buffer;
  verified: boolean;
}

interface ContractState {
  claimCounter: number;
  contractPaused: boolean;
  admin: string;
  totalClaimsProcessed: number;
  totalSubsidiesDisbursed: number;
  claims: Map<number, ClaimRecord>;
  farmerClaims: Map<string, FarmerClaimRecord>;
  claimProofs: Map<number, ClaimProofRecord>;
  currentBlock: number;
}

// Mock external contract interfaces
interface ExternalMocks {
  farmerRegistry: {
    isRegistered: (farmer: string) => ClarityResponse<boolean>;
    getFarmerData: (farmer: string) => ClarityResponse<{ landSize: number; cropYield: number; location: string }>;
  };
  eligibilityVerifier: {
    verifyEligibility: (farmer: string, period: number) => ClarityResponse<boolean>;
  };
  subsidyPool: {
    getPoolBalance: () => ClarityResponse<number>;
    disburse: (farmer: string, amount: number) => ClarityResponse<boolean>;
  };
  auditLogger: {
    logEvent: (farmer: string, status: string, amount: number, metadata?: Buffer) => ClarityResponse<boolean>;
  };
}

// Mock contract implementation
class ClaimProcessorMock {
  private state: ContractState = {
    claimCounter: 0,
    contractPaused: false,
    admin: "deployer",
    totalClaimsProcessed: 0,
    totalSubsidiesDisbursed: 0,
    claims: new Map(),
    farmerClaims: new Map(),
    claimProofs: new Map(),
    currentBlock: 1000,
  };

  private MAX_CLAIM_AMOUNT = 1000000;
  private CLAIM_COOLDOWN = 144;
  private MAX_CLAIMS_PER_FARMER = 5;
  private MAX_METADATA_LEN = 500;
  private MIN_PERIOD = 202300;
  private MAX_PERIOD = 210000;

  private ERR_NOT_AUTHORIZED = 100;
  private ERR_ALREADY_CLAIMED = 101;
  private ERR_INVALID_FARMER = 102;
  private ERR_VERIFICATION_FAILED = 103;
  private ERR_INSUFFICIENT_FUNDS = 104;
  private ERR_INVALID_AMOUNT = 105;
  private ERR_CLAIM_PERIOD_EXPIRED = 106;
  private ERR_INVALID_CLAIM_ID = 107;
  private ERR_CONTRACT_PAUSED = 108;
  private ERR_INVALID_METADATA = 109;
  private ERR_BLACKLISTED_FARMER = 110;
  private ERR_MAX_CLAIMS_REACHED = 111;
  private ERR_INVALID_PROOF = 112;
  private ERR_INVALID_ADMIN = 113;

  private external: ExternalMocks;

  constructor(externalMocks: ExternalMocks) {
    this.external = externalMocks;
  }

  advanceBlock(blocks: number = 1) {
    this.state.currentBlock += blocks;
  }

  private getBlockHeight(): number {
    return this.state.currentBlock;
  }

  private isAdmin(caller: string): boolean {
    return caller === this.state.admin;
  }

  private checkCooldown(farmer: string, period: number): boolean {
    const key = `${farmer}-${period}`;
    const data = this.state.farmerClaims.get(key);
    if (!data) return true;
    return (
      !data.blacklisted &&
      this.getBlockHeight() > data.lastClaimBlock + this.CLAIM_COOLDOWN &&
      data.claimCount < this.MAX_CLAIMS_PER_FARMER
    );
  }

  private updateFarmerClaims(farmer: string, period: number, amount: number): void {
    const key = `${farmer}-${period}`;
    const existing = this.state.farmerClaims.get(key);
    if (existing) {
      this.state.farmerClaims.set(key, {
        lastClaimBlock: this.getBlockHeight(),
        claimCount: existing.claimCount + 1,
        totalAmount: existing.totalAmount + amount,
        blacklisted: existing.blacklisted,
      });
    } else {
      this.state.farmerClaims.set(key, {
        lastClaimBlock: this.getBlockHeight(),
        claimCount: 1,
        totalAmount: amount,
        blacklisted: false,
      });
    }
  }

  private logClaimEvent(claimId: number, status: string, farmer: string, amount: number): ClarityResponse<boolean> {
    return this.external.auditLogger.logEvent(farmer, status, amount, Buffer.from(JSON.stringify({ claimId })));
  }

  submitClaim(caller: string, amount: number, period: number, metadata: Buffer, proofHash: Buffer): ClarityResponse<number> {
    if (this.state.contractPaused) return { ok: false, value: this.ERR_CONTRACT_PAUSED };
    if (amount <= 0 || amount > this.MAX_CLAIM_AMOUNT) return { ok: false, value: this.ERR_INVALID_AMOUNT };
    if (metadata.length > this.MAX_METADATA_LEN) return { ok: false, value: this.ERR_INVALID_METADATA };
    if (period < this.MIN_PERIOD || period > this.MAX_PERIOD) return { ok: false, value: this.ERR_CLAIM_PERIOD_EXPIRED };
    if (!this.checkCooldown(caller, period)) return { ok: false, value: this.ERR_ALREADY_CLAIMED };
    if (proofHash.length !== 32) return { ok: false, value: this.ERR_INVALID_PROOF };
    const isRegistered = this.external.farmerRegistry.isRegistered(caller);
    if (!isRegistered.ok || !isRegistered.value) {
      return { ok: false, value: this.ERR_INVALID_FARMER };
    }
    const claimId = this.state.claimCounter + 1;
    this.state.claims.set(claimId, {
      farmerId: caller,
      status: "pending",
      amount,
      timestamp: this.getBlockHeight(),
      period,
      metadata,
      verifierNotes: null,
    });
    this.state.claimProofs.set(claimId, {
      proofHash,
      verified: false,
    });
    this.state.claimCounter = claimId;
    const logResult = this.logClaimEvent(claimId, "submitted", caller, amount);
    if (!logResult.ok) return { ok: false, value: logResult.value };
    return { ok: true, value: claimId };
  }

  processClaim(caller: string, claimId: number, verifierNotes: string): ClarityResponse<boolean> {
    const claim = this.state.claims.get(claimId);
    if (!claim) return { ok: false, value: this.ERR_INVALID_CLAIM_ID };
    const proof = this.state.claimProofs.get(claimId);
    if (!proof) return { ok: false, value: this.ERR_INVALID_PROOF };
    if (claim.status !== "pending") return { ok: false, value: this.ERR_ALREADY_CLAIMED };
    if (!this.isAdmin(caller)) return { ok: false, value: this.ERR_NOT_AUTHORIZED };
    if (!proof.verified) return { ok: false, value: this.ERR_INVALID_PROOF };
    const verifyEligibility = this.external.eligibilityVerifier.verifyEligibility(claim.farmerId, claim.period);
    if (!verifyEligibility.ok || !verifyEligibility.value) return { ok: false, value: this.ERR_VERIFICATION_FAILED };
    const poolBalance = this.external.subsidyPool.getPoolBalance();
    if (!poolBalance.ok || poolBalance.value < claim.amount) return { ok: false, value: this.ERR_INSUFFICIENT_FUNDS };
    const disburse = this.external.subsidyPool.disburse(claim.farmerId, claim.amount);
    if (!disburse.ok || !disburse.value) return { ok: false, value: this.ERR_VERIFICATION_FAILED };
    this.state.claims.set(claimId, { ...claim, status: "approved", verifierNotes });
    this.updateFarmerClaims(claim.farmerId, claim.period, claim.amount);
    this.state.totalClaimsProcessed += 1;
    this.state.totalSubsidiesDisbursed += claim.amount;
    const logResult = this.logClaimEvent(claimId, "approved", claim.farmerId, claim.amount);
    if (!logResult.ok) return { ok: false, value: logResult.value };
    return { ok: true, value: true };
  }

  rejectClaim(caller: string, claimId: number, reason: string): ClarityResponse<boolean> {
    const claim = this.state.claims.get(claimId);
    if (!claim) return { ok: false, value: this.ERR_INVALID_CLAIM_ID };
    if (claim.status !== "pending") return { ok: false, value: this.ERR_ALREADY_CLAIMED };
    if (!this.isAdmin(caller)) return { ok: false, value: this.ERR_NOT_AUTHORIZED };
    this.state.claims.set(claimId, { ...claim, status: "rejected", verifierNotes: reason });
    const logResult = this.logClaimEvent(claimId, "rejected", claim.farmerId, claim.amount);
    if (!logResult.ok) return { ok: false, value: logResult.value };
    return { ok: true, value: true };
  }

  verifyProof(caller: string, claimId: number, isValid: boolean): ClarityResponse<boolean> {
    const proof = this.state.claimProofs.get(claimId);
    if (!proof) return { ok: false, value: this.ERR_INVALID_CLAIM_ID };
    if (!this.isAdmin(caller)) return { ok: false, value: this.ERR_NOT_AUTHORIZED };
    this.state.claimProofs.set(claimId, { ...proof, verified: isValid });
    return { ok: true, value: true };
  }

  blacklistFarmer(caller: string, farmer: string, period: number): ClarityResponse<boolean> {
    if (!this.isAdmin(caller)) return { ok: false, value: this.ERR_NOT_AUTHORIZED };
    if (period < this.MIN_PERIOD || period > this.MAX_PERIOD) return { ok: false, value: this.ERR_CLAIM_PERIOD_EXPIRED };
    const key = `${farmer}-${period}`;
    const existing = this.state.farmerClaims.get(key);
    if (existing) {
      this.state.farmerClaims.set(key, { ...existing, blacklisted: true });
    } else {
      this.state.farmerClaims.set(key, {
        lastClaimBlock: 0,
        claimCount: 0,
        totalAmount: 0,
        blacklisted: true,
      });
    }
    return { ok: true, value: true };
  }

  pauseContract(caller: string): ClarityResponse<boolean> {
    if (!this.isAdmin(caller)) return { ok: false, value: this.ERR_NOT_AUTHORIZED };
    this.state.contractPaused = true;
    return { ok: true, value: true };
  }

  unpauseContract(caller: string): ClarityResponse<boolean> {
    if (!this.isAdmin(caller)) return { ok: false, value: this.ERR_NOT_AUTHORIZED };
    this.state.contractPaused = false;
    return { ok: true, value: true };
  }

  setAdmin(caller: string, newAdmin: string): ClarityResponse<boolean> {
    if (!this.isAdmin(caller)) return { ok: false, value: this.ERR_NOT_AUTHORIZED };
    if (newAdmin === "ST000000000000000000002AMW42H") return { ok: false, value: this.ERR_INVALID_ADMIN };
    this.state.admin = newAdmin;
    return { ok: true, value: true };
  }

  getClaimDetails(claimId: number): ClarityResponse<ClaimRecord | null> {
    return { ok: true, value: this.state.claims.get(claimId) ?? null };
  }

  getFarmerClaimHistory(farmer: string, period: number): ClarityResponse<FarmerClaimRecord | null> {
    const key = `${farmer}-${period}`;
    return { ok: true, value: this.state.farmerClaims.get(key) ?? null };
  }

  getClaimProof(claimId: number): ClarityResponse<ClaimProofRecord | null> {
    return { ok: true, value: this.state.claimProofs.get(claimId) ?? null };
  }

  getTotalClaims(): ClarityResponse<number> {
    return { ok: true, value: this.state.totalClaimsProcessed };
  }

  getTotalDisbursed(): ClarityResponse<number> {
    return { ok: true, value: this.state.totalSubsidiesDisbursed };
  }

  isContractPaused(): ClarityResponse<boolean> {
    return { ok: true, value: this.state.contractPaused };
  }

  getAdmin(): ClarityResponse<string> {
    return { ok: true, value: this.state.admin };
  }

  canClaim(farmer: string, period: number): ClarityResponse<boolean> {
    return { ok: true, value: this.checkCooldown(farmer, period) };
  }
}

// Test setup
const accounts = {
  deployer: "deployer",
  farmer1: "farmer_1",
  farmer2: "farmer_2",
  unauthorized: "unauthorized",
};

describe("ClaimProcessor Contract", () => {
  let contract: ClaimProcessorMock;
  let externalMocks: ExternalMocks;

  beforeEach(() => {
    externalMocks = {
      farmerRegistry: {
        isRegistered: vi.fn().mockImplementation((farmer: string) => ({
          ok: true,
          value: farmer !== "invalid",
        })),
        getFarmerData: vi.fn().mockImplementation((farmer: string) => ({
          ok: true,
          value: farmer !== "invalid" ? { landSize: 10, cropYield: 1000, location: "region1" } : 1,
        })),
      },
      eligibilityVerifier: {
        verifyEligibility: vi.fn().mockImplementation(() => ({ ok: true, value: true })),
      },
      subsidyPool: {
        getPoolBalance: vi.fn().mockImplementation(() => ({ ok: true, value: 10000000 })),
        disburse: vi.fn().mockImplementation(() => ({ ok: true, value: true })),
      },
      auditLogger: {
        logEvent: vi.fn().mockImplementation(() => ({ ok: true, value: true })),
      },
    };
    contract = new ClaimProcessorMock(externalMocks);
    vi.resetAllMocks();
  });

  it("should prevent submission if contract paused", () => {
    contract.pauseContract(accounts.deployer);
    const result = contract.submitClaim(accounts.farmer1, 500000, 202501, Buffer.from("data"), Buffer.alloc(32));
    expect(result).toEqual({ ok: false, value: 108 });
  });

  it("should blacklist a farmer", () => {
    contract.blacklistFarmer(accounts.deployer, accounts.farmer1, 202501);
    const result = contract.submitClaim(accounts.farmer1, 100, 202501, Buffer.from("data"), Buffer.alloc(32));
    expect(result).toEqual({ ok: false, value: 101 });
    const history = contract.getFarmerClaimHistory(accounts.farmer1, 202501);
    expect(history.value?.blacklisted).toBe(true);
  });

  it("should allow admin to pause and unpause", () => {
    let result = contract.pauseContract(accounts.deployer);
    expect(result).toEqual({ ok: true, value: true });
    expect(contract.isContractPaused()).toEqual({ ok: true, value: true });

    result = contract.unpauseContract(accounts.deployer);
    expect(result).toEqual({ ok: true, value: true });
    expect(contract.isContractPaused()).toEqual({ ok: true, value: false });
  });

  it("should prevent metadata exceeding max length", () => {
    const longMetadata = Buffer.alloc(501);
    const result = contract.submitClaim(accounts.farmer1, 100, 202501, longMetadata, Buffer.alloc(32));
    expect(result).toEqual({ ok: false, value: 109 });
  });
});