# 🌾 Decentralized Farm Subsidy Distribution System

Welcome to a transparent and corruption-resistant platform for distributing agricultural subsidies! This project uses the Stacks blockchain and Clarity smart contracts to verify farmer eligibility based on on-chain farm data, ensuring fair allocation of funds while minimizing fraud, bribery, and mismanagement in government or organizational subsidy programs.

## ✨ Features

🔍 On-chain verification of farm data (e.g., land size, crop yield, location) for eligibility checks  
💰 Automated subsidy distribution via smart contracts, triggered by verified claims  
📊 Immutable records of applications, approvals, and payouts to promote accountability  
🛡️ Anti-fraud mechanisms like unique farmer IDs and data hashing to prevent duplicates or tampering  
🤝 Integration with oracles for real-world data feeds (e.g., weather or satellite imagery for crop validation)  
📈 Reporting tools for auditors and stakeholders to query distribution history  
🚫 Blacklisting of fraudulent actors based on community or admin governance  

## 🛠 How It Works

**For Farmers**  
- Register your farm by submitting hashed data (e.g., land deeds, crop reports) to the system.  
- Apply for subsidies by calling the claim-subsidy function with your farmer ID and proof of eligibility.  
- The system automatically verifies your on-chain data against subsidy criteria (e.g., minimum land size or yield thresholds).  
- If eligible, subsidies are disbursed directly to your wallet— no middlemen involved!  

**For Administrators/Governments**  
- Fund the subsidy pool by depositing tokens into the main contract.  
- Define eligibility rules via governance proposals (e.g., update thresholds for different regions).  
- Monitor distributions through query functions to ensure compliance and generate reports.  

**For Verifiers/Auditors**  
- Use get-application-details to inspect any subsidy claim's history and verification proofs.  
- Call verify-eligibility to cross-check a farmer's data against on-chain records instantly.  

This setup reduces corruption by making all processes transparent and auditable on the blockchain, where data can't be altered retroactively.

## 📚 Smart Contracts Overview

The system is built with 8 Clarity smart contracts for modularity, security, and scalability. Each handles a specific aspect of the subsidy lifecycle:

1. **FarmerRegistry.clar** - Manages farmer registrations, storing unique IDs, hashed farm data (e.g., land size, GPS coordinates), and basic profiles. Prevents duplicate registrations with hash checks.  
2. **DataOracle.clar** - Interfaces with external oracles to fetch and store real-world farm data (e.g., crop yields from satellite APIs) on-chain for verification.  
3. **EligibilityVerifier.clar** - Contains logic to check farmer data against predefined subsidy criteria (e.g., if land_size >= 5 acres and yield > threshold).  
4. **SubsidyPool.clar** - Holds and manages the pool of subsidy funds (STX or tokens). Handles deposits from admins and automated withdrawals.  
5. **ClaimProcessor.clar** - Processes subsidy applications, calling the verifier and triggering payouts if approved. Includes anti-replay protections.  
6. **Governance.clar** - Allows admins or token holders to propose and vote on changes to rules (e.g., eligibility thresholds or blacklists).  
7. **AuditLogger.clar** - Logs all key events (registrations, claims, payouts) immutably for auditing and querying historical data.  
8. **FraudDetector.clar** - Monitors for suspicious patterns (e.g., multiple claims from same IP hash) and enables blacklisting of bad actors via governance.

These contracts interact securely: For example, ClaimProcessor calls EligibilityVerifier and DataOracle before approving a payout from SubsidyPool. All are written in Clarity for safety and predictability on Stacks.

## 🚀 Getting Started

1. Install the Stacks CLI and Clarity tools.  
2. Deploy the contracts in order (starting with FarmerRegistry).  
3. Test on the Stacks testnet: Register a sample farmer, fund the pool, and simulate a claim.  
4. Integrate with front-end apps for user-friendly interfaces.

This project tackles real-world corruption in agricultural subsidies (a problem affecting billions in aid globally) by leveraging blockchain's transparency—empowering small farmers while holding distributors accountable!